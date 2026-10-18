/**
 * Journal Generation Modal
 *
 * Payments & transactions journal generation UI with scope selection.
 * Runs journal-generating steps in dependency order:
 *
 * 1. Accrue Payments — revenue recognition for captured payments
 * 2. Settle Payouts — cash recognition for inbound gateway transfers
 * 3. Journal Inbound — funding, sales receipts, refunds, FX conversions
 * 4. Journal Expenses — expense recording for categorised bank outflows
 *
 * Users can select a scope (payments, transactions, or all) before running
 * the pipeline. A Review tab surfaces draft journals that need human
 * attention.
 *
 * The pipeline itself runs as a background Inngest job
 * (generate_all_journals_job) rather than inline in the trigger request —
 * this component subscribes to its live progress over Inngest Realtime
 * (channel `journals:{entityId}`) using the same useRealtime/subscription-
 * token pattern as SyncProgressToast, instead of waiting for one big
 * response and rendering it after the fact.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useRealtime } from 'inngest/react';
import {
  X,
  BookOpen,
  ShoppingCart,
  Bank,
  Receipt,
  ArrowsClockwise,
  CheckCircle,
  WarningCircle,
  XCircle,
  Lightning,
  ArrowRight,
  CaretDown,
  CaretRight,
  Info,
  ClipboardText,
  Eye,
  Sparkle,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { SearchableSelect, type SelectOption } from '~/components/ui/searchable-select';
import { cn } from '~/lib/utils';
import { getApiBaseUrl } from '~/lib/api/base-url';
import { agentFetch } from '~/lib/api/agent-auth';
import {
  generateAllJournals,
  fetchReviewSummary,
  fetchChartOfAccounts,
  postDraftJournal,
  suggestDraftAccounts,
  type ReviewSummary,
  type Journal,
  type JournalScope,
  type ChartOfAccountEntry,
  type DraftAccountSuggestion,
} from '~/lib/api/accounting';

// =============================================================================
// REALTIME PAYLOAD TYPES (mirror channels.py's JournalStepProgressData /
// JournalPipelineStatusData)
// =============================================================================

interface JournalStepProgressData {
  step: string;
  title: string;
  status: 'starting' | 'completed' | 'error';
  created: number;
  skipped: number;
  errors: Array<{ payment_id?: string; transaction_id?: string; error: string }>;
  total_items: number | null;
  step_error: string | null;
  by_type: Record<
    string,
    {
      total: number;
      created: number;
      skipped: number;
      errors: Array<{ transaction_id: string; error: string }>;
    }
  > | null;
  passthrough: {
    classified: number;
    skipped: number;
    already_classified?: number;
    total_pairs?: number;
    total_pairs_examined?: number;
  } | null;
  timestamp: string;
}

interface JournalPipelineStatusData {
  status: 'running' | 'completed' | 'completed_with_errors' | 'error';
  scope: string;
  steps_completed: number;
  steps_total: number;
  total_created: number;
  total_skipped: number;
  total_errors: number;
  error: string | null;
  timestamp: string;
}

// Status priority for preventing regressions from Inngest step replays
// (see SyncProgressToast's identical guard for why this is necessary).
const STATUS_PRIORITY: Record<string, number> = {
  starting: 0,
  running: 1,
  completed: 2,
  completed_with_errors: 2,
  error: 2,
};

// =============================================================================
// TYPES
// =============================================================================

interface JournalGenerationModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityId: string;
}

type PipelineState = 'idle' | 'running' | 'completed' | 'error';
type ActiveTab = 'pipeline' | 'review';

// =============================================================================
// STEP CONFIGURATION
// =============================================================================

const PIPELINE_STEPS: Array<{
  key: string;
  title: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  bgColor: string;
}> = [
  {
    key: 'journal_payments',
    title: 'Accrue Payments',
    description: 'Revenue recognition for captured payments → Clearing',
    icon: ShoppingCart,
    iconColor: 'text-accent-text',
    bgColor: 'bg-accent-tint',
  },
  {
    key: 'journal_settlements',
    title: 'Settle Payouts',
    description: 'Cash recognition from inbound gateway transfers',
    icon: Bank,
    iconColor: 'text-income',
    bgColor: 'bg-income/10',
  },
  {
    key: 'journal_inbound',
    title: 'Journal Inbound',
    description: 'Funding, sales receipts, refunds, FX conversions, merchant payments',
    icon: ArrowRight,
    iconColor: 'text-income',
    bgColor: 'bg-income/10',
  },
  {
    key: 'journal_expenses',
    title: 'Journal Expenses',
    description: 'Record categorised bank outflows as expenses',
    icon: Receipt,
    iconColor: 'text-accent-text',
    bgColor: 'bg-accent-tint',
  },
];

// =============================================================================
// HELPER: Format step progress into readable summary
// =============================================================================

function getStepSummary(step: JournalStepProgressData): string[] {
  const lines: string[] = [];
  const created = step.created ?? 0;
  const skipped = step.skipped ?? 0;
  const errorCount = step.errors?.length ?? 0;

  if (created > 0) lines.push(`${created} journal${created !== 1 ? 's' : ''} created`);
  if (skipped > 0) lines.push(`${skipped} skipped`);
  if (errorCount > 0) lines.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);

  if (step.step === 'journal_inbound') {
    if (step.by_type) {
      const typeLabels: Record<string, string> = {
        funding: 'funding',
        sales_receipt: 'sales',
        refund: 'refunds',
        fx_conversion: 'FX',
        merchant: 'merchant',
      };
      const typeParts = Object.entries(step.by_type)
        .filter(([, v]) => v.created > 0)
        .map(([k, v]) => `${v.created} ${typeLabels[k] ?? k}`);
      if (typeParts.length > 0) lines.push(typeParts.join(', '));
    }
    const pt = step.passthrough;
    if (pt) {
      if (pt.classified > 0) {
        lines.push(`${pt.classified} passthrough${pt.classified !== 1 ? 's' : ''} classified`);
      } else if ((pt.total_pairs_examined ?? 0) > 0) {
        lines.push(
          `${pt.total_pairs_examined} pair${pt.total_pairs_examined !== 1 ? 's' : ''} examined, 0 new`
        );
      }
      if ((pt.already_classified ?? 0) > 0) {
        lines.push(`${pt.already_classified} already done`);
      }
    }
    if (created === 0 && skipped === 0 && errorCount === 0) {
      lines.push('No eligible inbound transactions');
    }
  } else if (created === 0 && skipped === 0 && errorCount === 0) {
    lines.push('No eligible records');
  }

  return lines;
}

// =============================================================================
// STEP STATUS ICON
// =============================================================================

function StepStatusIcon({
  status,
  isActive,
}: {
  status: 'pending' | 'running' | 'completed' | 'error';
  isActive: boolean;
}) {
  switch (status) {
    case 'running':
      return <ArrowsClockwise size={18} className="text-accent-text animate-spin" />;
    case 'completed':
      return <CheckCircle size={18} weight="fill" className="text-income" />;
    case 'error':
      return <XCircle size={18} weight="fill" className="text-destructive" />;
    default:
      return (
        <div
          className={cn(
            'h-[18px] w-[18px] rounded-full border-2',
            isActive ? 'border-ring/40' : 'border-border'
          )}
        />
      );
  }
}

// =============================================================================
// REVIEW: Draft Journal Row
// =============================================================================

function formatAccountType(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function DraftJournalRow({
  journal,
  entityId,
  accounts,
  suggestion,
  suggestionLoading,
  onPosted,
}: {
  journal: Journal;
  entityId: string;
  accounts: ChartOfAccountEntry[];
  suggestion?: DraftAccountSuggestion;
  suggestionLoading?: boolean;
  onPosted: (journalId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [posting, setPosting] = useState(false);
  const lineItems = journal.line_items ?? [];

  // Pre-fill from the AI suggestion, but only into an untouched picker —
  // never overwrite an account the user already picked themselves. Since
  // this component doesn't offer an "unset" option, an empty selection
  // reliably means "nothing chosen yet" for the lifetime of this row.
  useEffect(() => {
    if (suggestion?.account_id && !selectedAccountId) {
      setSelectedAccountId(suggestion.account_id);
    }
  }, [suggestion, selectedAccountId]);

  // Every draft journal has exactly one line still pointed at the
  // uncategorised fallback account (8090) — that's the one a human needs to
  // repoint before the journal can be posted.
  const misclassifiedLine = lineItems.find(li => {
    const acct = accounts.find(a => a.id === li.account_id);
    return acct?.account_number === '8090';
  });

  const accountOptions = useMemo<SelectOption[]>(() => {
    return accounts
      .filter(a => !a.is_header && a.account_number !== '8090')
      .map(a => ({
        value: a.id,
        label: a.name,
        meta: a.account_number,
        group: formatAccountType(a.account_type),
      }));
  }, [accounts]);

  const suggestedAccount = suggestion?.account_id
    ? accounts.find(a => a.id === suggestion.account_id)
    : undefined;

  const handlePost = async () => {
    if (!selectedAccountId) return;
    setPosting(true);
    try {
      await postDraftJournal(entityId, journal.id, selectedAccountId);
      toast.success('Journal posted');
      onPosted(journal.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to post journal');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="rounded-lg border border-ring/40 bg-accent-tint">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-accent-tint transition-colors rounded-lg"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ClipboardText size={16} className="text-accent-text shrink-0" />
          <span className="text-sm text-foreground truncate">
            {journal.description ?? `${journal.journal_type} journal`}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            {new Date(journal.journal_date).toLocaleDateString()}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent-tint text-accent-text font-medium">
            draft
          </span>
          {expanded ? (
            <CaretDown size={14} className="text-muted-foreground" />
          ) : (
            <CaretRight size={14} className="text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && lineItems.length > 0 && (
        <div className="px-3 pb-3 space-y-1 border-t border-ring/40 pt-2">
          <p className="text-xs text-muted-foreground mb-1.5">Journal line items:</p>
          {lineItems.map((li, i) => (
            <div key={i} className="flex items-center justify-between text-xs font-mono gap-2">
              <span className="text-muted-foreground truncate flex-1">{li.description || '—'}</span>
              <div className="flex gap-3 shrink-0">
                {li.debit > 0 && (
                  <span className="text-muted-foreground">
                    DR <span className="text-income">{li.debit.toFixed(2)}</span>
                  </span>
                )}
                {li.credit > 0 && (
                  <span className="text-muted-foreground">
                    CR <span className="text-accent-text">{li.credit.toFixed(2)}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
          {misclassifiedLine ? (
            <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
              <label className="text-xs text-muted-foreground block">
                Correct GL account for the uncategorised line:
              </label>
              {suggestedAccount ? (
                <div className="flex items-start gap-1.5 text-xs bg-income/10 border border-income/30 rounded-lg px-2.5 py-2">
                  <Sparkle size={13} weight="fill" className="text-income shrink-0 mt-0.5" />
                  <span className="text-income">
                    <span className="font-medium">Suggested: </span>
                    <span className="font-mono">{suggestedAccount.account_number}</span>
                    {' — '}
                    {suggestedAccount.name} · {Math.round((suggestion?.confidence ?? 0) * 100)}%
                    confident
                    <span className="block text-income mt-0.5">{suggestion?.reasoning}</span>
                  </span>
                </div>
              ) : (
                suggestionLoading && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Sparkle size={12} className="animate-pulse" />
                    Suggesting an account…
                  </div>
                )
              )}
              <SearchableSelect
                options={accountOptions}
                value={selectedAccountId}
                onChange={setSelectedAccountId}
                placeholder="— Select account —"
                disabled={posting}
                className="w-full px-2 py-1.5 text-xs"
                renderValue={opt =>
                  opt ? (
                    <span className="truncate">
                      <span className="font-mono text-muted-foreground">{opt.meta}</span>
                      {' — '}
                      {opt.label}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">— Select account —</span>
                  )
                }
              />
              <Button
                size="sm"
                onClick={handlePost}
                disabled={!selectedAccountId || posting}
                className="w-full gap-1.5"
              >
                {posting ? (
                  <>
                    <ArrowsClockwise size={12} className="animate-spin" />
                    Posting…
                  </>
                ) : (
                  'Post journal'
                )}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-accent-text mt-2 pt-2 border-t border-border/60">
              No uncategorised line found on this journal — nothing to fix here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// REVIEW TAB
// =============================================================================

function ReviewTab({ entityId }: { entityId: string }) {
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [accounts, setAccounts] = useState<ChartOfAccountEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draftExpanded, setDraftExpanded] = useState(true);
  const [suggestions, setSuggestions] = useState<Record<string, DraftAccountSuggestion>>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reviewData, accountsData] = await Promise.all([
        fetchReviewSummary(entityId),
        fetchChartOfAccounts(entityId),
      ]);
      setReview(reviewData);
      setAccounts(accountsData);

      // Advisory-only and slower than the rest of this load (an LLM call) —
      // fire it without awaiting so draft rows render immediately with
      // empty pickers, then fill in as suggestions arrive.
      setSuggestions({});
      if (reviewData.draft_journals.length > 0) {
        setSuggestionsLoading(true);
        suggestDraftAccounts(
          entityId,
          reviewData.draft_journals.map(j => j.id)
        )
          .then(setSuggestions)
          .catch(() => {
            // Leave pickers unprefilled on failure — nothing to recover.
          })
          .finally(() => setSuggestionsLoading(false));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  // Auto-load on mount
  useEffect(() => {
    load();
  }, [load]);

  const handlePosted = useCallback((journalId: string) => {
    setReview(prev => {
      if (!prev) return prev;
      const postedJournal = prev.draft_journals.find(j => j.id === journalId);
      const draft_journals = prev.draft_journals.filter(j => j.id !== journalId);
      const draft_journals_by_type = { ...prev.draft_journals_by_type };
      if (postedJournal) {
        const t = postedJournal.journal_type;
        if (draft_journals_by_type[t] > 1) {
          draft_journals_by_type[t] -= 1;
        } else {
          delete draft_journals_by_type[t];
        }
      }
      return {
        ...prev,
        draft_journals,
        draft_journals_by_type,
        summary: {
          ...prev.summary,
          draft_journals_total: prev.summary.draft_journals_total - 1,
          needs_review: draft_journals.length > 0,
        },
      };
    });
  }, []);

  if (loading && !review) {
    return (
      <div className="flex items-center justify-center py-12">
        <ArrowsClockwise size={24} className="text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
        <p className="text-sm text-destructive">{error}</p>
        <button
          onClick={load}
          className="mt-2 text-xs text-muted-foreground hover:text-foreground underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!review) return null;

  const totalDraft = review.summary.draft_journals_total;
  const nothingToReview = totalDraft === 0;

  return (
    <div className="space-y-4">
      {/* Summary chips */}
      <div className="flex items-center gap-2 flex-wrap">
        <div
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium',
            totalDraft > 0 ? 'bg-accent-tint text-accent-text' : 'bg-muted text-muted-foreground'
          )}
        >
          <ClipboardText size={13} />
          {totalDraft} draft journal{totalDraft !== 1 ? 's' : ''}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto text-xs text-muted-foreground hover:text-muted-foreground flex items-center gap-1 transition-colors"
        >
          <ArrowsClockwise size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {nothingToReview && (
        <div className="rounded-xl border border-income/30 bg-income/10 px-4 py-4 text-center">
          <CheckCircle size={24} weight="fill" className="text-income mx-auto mb-2" />
          <p className="text-sm font-medium text-income">Everything looks good</p>
          <p className="text-xs text-muted-foreground mt-1">No draft journals require attention.</p>
        </div>
      )}

      {/* Draft Journals Section */}
      {totalDraft > 0 && (
        <div>
          <button
            onClick={() => setDraftExpanded(e => !e)}
            className="w-full flex items-center justify-between mb-2 group"
          >
            <div className="flex items-center gap-2">
              <ClipboardText size={16} className="text-accent-text" />
              <span className="text-sm font-medium text-foreground">Draft Journals</span>
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent-tint text-accent-text">
                {totalDraft}
              </span>
            </div>
            {draftExpanded ? (
              <CaretDown size={14} className="text-muted-foreground" />
            ) : (
              <CaretRight size={14} className="text-muted-foreground" />
            )}
          </button>

          {draftExpanded && (
            <>
              <p className="text-xs text-muted-foreground mb-2 ml-6">
                These journals were created as drafts because the expense account could not be
                automatically determined. Review and post each one with the correct GL account.
              </p>
              {Object.keys(review.draft_journals_by_type).length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2 ml-6">
                  {Object.entries(review.draft_journals_by_type).map(([type, count]) => (
                    <span
                      key={type}
                      className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full"
                    >
                      {type}: {count}
                    </span>
                  ))}
                </div>
              )}
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {review.draft_journals.map(j => (
                  <DraftJournalRow
                    key={j.id}
                    journal={j}
                    entityId={entityId}
                    accounts={accounts}
                    suggestion={suggestions[j.id]}
                    suggestionLoading={suggestionsLoading && !suggestions[j.id]}
                    onPosted={handlePosted}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function JournalGenerationModal({ isOpen, onClose, entityId }: JournalGenerationModalProps) {
  const baseUrl = getApiBaseUrl();
  const [hasTriggered, setHasTriggered] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [overallStatus, setOverallStatus] = useState<JournalPipelineStatusData | null>(null);
  const [stepProgress, setStepProgress] = useState<Map<string, JournalStepProgressData>>(new Map());
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<ActiveTab>('pipeline');
  const [scope, setScope] = useState<JournalScope>('all');
  const hasToastedCompletion = useRef(false);

  // Fetch subscription token — same pattern as SyncProgressToast, scoped to
  // the entity's journals channel instead of a source's sync channel.
  const refreshToken = async () => {
    const response = await agentFetch(`${baseUrl}/realtime/subscription-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: entityId,
        channel_type: 'journals',
        topics: ['progress', 'status'],
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get subscription token: ${response.statusText}`);
    }
    const data = await response.json();
    return {
      channel: data.channel,
      topics: data.topics,
      key: data.token,
      apiBaseUrl: data.api_base_url,
    };
  };

  const {
    error: realtimeError,
    messages: { delta: freshData },
  } = useRealtime({
    token: refreshToken,
    bufferInterval: 100,
  });

  // Process fresh realtime data
  useEffect(() => {
    if (!freshData || freshData.length === 0) return;

    freshData.forEach(message => {
      if (message.topic === 'status') {
        setOverallStatus(prev => {
          const incoming = message.data as JournalPipelineStatusData;
          if (!prev) return incoming;

          // Guard against Inngest step replays re-publishing an earlier
          // status with a fresher timestamp (see SyncProgressToast).
          const incomingPriority = STATUS_PRIORITY[incoming.status] ?? 0;
          const prevPriority = STATUS_PRIORITY[prev.status] ?? 0;
          if (incomingPriority < prevPriority) return prev;
          if (
            incomingPriority === prevPriority &&
            incoming.steps_completed < prev.steps_completed
          ) {
            return prev;
          }
          return incoming;
        });
      } else if (message.topic === 'progress') {
        const progressData = message.data as JournalStepProgressData;
        setStepProgress(prev => {
          const existing = prev.get(progressData.step);
          if (existing) {
            const existingPriority = STATUS_PRIORITY[existing.status] ?? 0;
            const incomingPriority = STATUS_PRIORITY[progressData.status] ?? 0;
            if (incomingPriority < existingPriority) return prev;
          }
          const next = new Map(prev);
          next.set(progressData.step, progressData);
          return next;
        });
      }
    });
  }, [freshData]);

  const pipelineState: PipelineState = !hasTriggered
    ? 'idle'
    : overallStatus?.status === 'completed'
      ? 'completed'
      : overallStatus?.status === 'completed_with_errors' || overallStatus?.status === 'error'
        ? 'error'
        : 'running';

  const isRunning = pipelineState === 'running';
  const isDone = pipelineState === 'completed' || pipelineState === 'error';

  // Toast once, when the run finishes
  useEffect(() => {
    if (!isDone || hasToastedCompletion.current || !overallStatus) return;
    hasToastedCompletion.current = true;

    const totalCreated = overallStatus.total_created;
    if (totalCreated > 0) {
      toast.success(
        `Generated ${totalCreated} journal${totalCreated !== 1 ? 's' : ''}` +
          (overallStatus.total_errors > 0
            ? ` with ${overallStatus.total_errors} error${overallStatus.total_errors !== 1 ? 's' : ''}`
            : '')
      );
    } else if (overallStatus.total_errors > 0) {
      toast.error(
        `Pipeline completed with ${overallStatus.total_errors} error${overallStatus.total_errors !== 1 ? 's' : ''}`
      );
    } else {
      toast.info('No new journals to generate — everything is up to date');
    }
  }, [isDone, overallStatus]);

  const toggleErrorExpand = useCallback((stepKey: string) => {
    setExpandedErrors(prev => {
      const next = new Set(prev);
      if (next.has(stepKey)) {
        next.delete(stepKey);
      } else {
        next.add(stepKey);
      }
      return next;
    });
  }, []);

  const handleGenerate = useCallback(async () => {
    setTriggerError(null);
    setOverallStatus(null);
    setStepProgress(new Map());
    hasToastedCompletion.current = false;

    try {
      await generateAllJournals(entityId, scope);
      setHasTriggered(true);
      toast.info('Journal generation started…');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setTriggerError(message);
      toast.error(`Failed to start journal generation: ${message}`);
    }
  }, [entityId, scope]);

  const handleReset = useCallback(() => {
    setHasTriggered(false);
    setTriggerError(null);
    setOverallStatus(null);
    setStepProgress(new Map());
    setExpandedErrors(new Set());
    setActiveTab('pipeline');
    setScope('all');
    hasToastedCompletion.current = false;
  }, []);

  const getStepStatus = (stepKey: string): 'pending' | 'running' | 'completed' | 'error' => {
    if (!hasTriggered) return 'pending';
    const progress = stepProgress.get(stepKey);
    if (!progress) return 'pending';
    if (progress.status === 'starting') return 'running';
    return progress.status;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isRunning ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card/95 backdrop-blur-sm px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-income/10">
              <BookOpen size={22} weight="duotone" className="text-income" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Generate Journals</h2>
              <p className="text-sm text-muted-foreground">
                Payments &amp; transactions journal pipeline
              </p>
            </div>
          </div>
          <button
            onClick={isRunning ? undefined : onClose}
            disabled={isRunning}
            className={cn(
              'rounded-lg p-2 text-muted-foreground transition-colors',
              isRunning ? 'cursor-not-allowed opacity-40' : 'hover:bg-accent hover:text-foreground'
            )}
          >
            <X size={20} weight="bold" />
          </button>
        </div>

        {/* Tabs — always visible */}
        <div className="flex border-b border-border px-6">
          <button
            onClick={() => setActiveTab('pipeline')}
            className={cn(
              'flex items-center gap-1.5 px-1 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === 'pipeline'
                ? 'border-income/30 text-income'
                : 'border-transparent text-muted-foreground hover:text-muted-foreground'
            )}
          >
            <Lightning size={15} weight={activeTab === 'pipeline' ? 'fill' : 'regular'} />
            Pipeline
          </button>
          <button
            onClick={() => setActiveTab('review')}
            className={cn(
              'flex items-center gap-1.5 px-1 py-3 ml-4 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === 'review'
                ? 'border-ring/40 text-accent-text'
                : 'border-transparent text-muted-foreground hover:text-muted-foreground'
            )}
          >
            <Eye size={15} weight={activeTab === 'review' ? 'fill' : 'regular'} />
            Review
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-3">
          {activeTab === 'review' ? (
            <ReviewTab entityId={entityId} />
          ) : (
            <>
              {/* Info banner (idle state) */}
              {pipelineState === 'idle' && (
                <>
                  <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 mb-2">
                    <div className="flex items-start gap-3">
                      <Info size={18} className="text-muted-foreground mt-0.5 shrink-0" />
                      <div className="text-sm text-muted-foreground">
                        <p>
                          This will generate all pending payment and transaction journals (accruals,
                          settlements, inbound transfers, expenses) in a single pass. Existing
                          journals are never duplicated. Runs in the background — you can watch
                          progress here or close this and check back later.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Scope selector */}
                  <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 mb-2">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Journal scope</p>
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          { value: 'all', label: 'All' },
                          { value: 'payments', label: 'Payments' },
                          { value: 'transactions', label: 'Transactions' },
                        ] as const
                      ).map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setScope(opt.value)}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                            scope === opt.value
                              ? 'border-income/30 bg-income/10 text-income'
                              : 'border-border/60 bg-muted/50 text-muted-foreground hover:text-foreground hover:border-border'
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {scope === 'all' && 'Run all journal-generating steps.'}
                      {scope === 'payments' && 'Accrue captured payments as revenue.'}
                      {scope === 'transactions' &&
                        'Settle gateway payouts, journal inbound transfers (funding, refunds, FX, sales) and record expenses.'}
                    </p>
                  </div>
                </>
              )}

              {/* Summary banner (after completion) */}
              {isDone && overallStatus && (
                <div
                  className={cn(
                    'rounded-xl border px-4 py-3 mb-2',
                    overallStatus.total_errors > 0
                      ? 'border-ring/40 bg-accent-tint'
                      : 'border-income/30 bg-income/10'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {overallStatus.total_errors > 0 ? (
                        <WarningCircle size={20} weight="fill" className="text-accent-text" />
                      ) : (
                        <CheckCircle size={20} weight="fill" className="text-income" />
                      )}
                      <div className="text-sm">
                        <span className="font-semibold text-foreground">
                          {overallStatus.total_created}
                        </span>{' '}
                        <span className="text-muted-foreground">
                          journal{overallStatus.total_created !== 1 ? 's' : ''} created
                        </span>
                        {overallStatus.total_skipped > 0 && (
                          <>
                            {' · '}
                            <span className="font-semibold text-foreground">
                              {overallStatus.total_skipped}
                            </span>{' '}
                            <span className="text-muted-foreground">skipped</span>
                          </>
                        )}
                        {overallStatus.total_errors > 0 && (
                          <>
                            {' · '}
                            <span className="font-semibold text-destructive">
                              {overallStatus.total_errors}
                            </span>{' '}
                            <span className="text-muted-foreground">
                              error{overallStatus.total_errors !== 1 ? 's' : ''}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {/* Review prompt */}
                    <button
                      onClick={() => setActiveTab('review')}
                      className="flex items-center gap-1 text-xs text-accent-text hover:text-accent-text transition-colors"
                    >
                      <Eye size={13} />
                      Review items
                      <ArrowRight size={12} />
                    </button>
                  </div>
                </div>
              )}

              {/* Trigger / connection errors */}
              {(triggerError || realtimeError) && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 mb-2">
                  <div className="flex items-start gap-2">
                    <XCircle size={18} weight="fill" className="text-destructive mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-destructive">
                        {triggerError ? 'Could not start pipeline' : 'Realtime connection error'}
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {triggerError || realtimeError?.message}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Pipeline Steps */}
              <div className="space-y-1">
                {PIPELINE_STEPS.map((step, index) => {
                  const status = getStepStatus(step.key);
                  const progress = stepProgress.get(step.key);
                  const stepErrors = progress?.errors ?? [];
                  const isErrorExpanded = expandedErrors.has(step.key);
                  const Icon = step.icon;

                  return (
                    <div key={step.key}>
                      <div
                        className={cn(
                          'rounded-xl border px-4 py-3 transition-all',
                          status === 'error'
                            ? 'border-destructive/30 bg-destructive/10'
                            : status === 'completed'
                              ? 'border-border/60 bg-muted/30'
                              : status === 'running'
                                ? 'border-ring/40 bg-accent-tint'
                                : 'border-border/40 bg-muted/20'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          {/* Status indicator */}
                          <div className="shrink-0">
                            <StepStatusIcon status={status} isActive={isRunning} />
                          </div>

                          {/* Step icon */}
                          <div
                            className={cn(
                              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                              step.bgColor,
                              status === 'pending' && hasTriggered && 'opacity-40'
                            )}
                          >
                            <Icon size={18} weight="duotone" className={step.iconColor} />
                          </div>

                          {/* Step info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3
                                className={cn(
                                  'text-sm font-medium',
                                  status === 'pending' && hasTriggered
                                    ? 'text-muted-foreground'
                                    : 'text-foreground'
                                )}
                              >
                                {step.title}
                              </h3>
                              {status === 'running' && (
                                <span className="text-xs text-accent-text animate-pulse">
                                  Running...
                                </span>
                              )}
                            </div>
                            {(!hasTriggered || status === 'pending') && (
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {step.description}
                              </p>
                            )}
                            {/* Step results */}
                            {progress && status !== 'pending' && (
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                                {getStepSummary(progress).map((line, i) => (
                                  <span key={i} className="text-xs text-muted-foreground">
                                    {i > 0 && (
                                      <span className="text-muted-foreground/60 mr-2">·</span>
                                    )}
                                    {line}
                                  </span>
                                ))}
                              </div>
                            )}
                            {progress?.step_error && (
                              <p className="text-xs text-destructive mt-1">{progress.step_error}</p>
                            )}
                          </div>

                          {/* Error expand toggle */}
                          {stepErrors.length > 0 && (
                            <button
                              onClick={() => toggleErrorExpand(step.key)}
                              className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                              title={isErrorExpanded ? 'Hide errors' : 'Show errors'}
                            >
                              {isErrorExpanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
                            </button>
                          )}
                        </div>

                        {/* Expandable error details */}
                        {isErrorExpanded && stepErrors.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-border/60 space-y-2">
                            <p className="text-xs font-medium text-muted-foreground">
                              {stepErrors.length} error{stepErrors.length !== 1 ? 's' : ''}:
                            </p>
                            <div className="space-y-1.5 max-h-40 overflow-y-auto">
                              {stepErrors.map((err, i) => {
                                const sourceId = err.payment_id || err.transaction_id;
                                return (
                                  <div
                                    key={i}
                                    className="rounded-lg bg-background/50 px-3 py-2 text-xs"
                                  >
                                    <p className="text-destructive">{err.error}</p>
                                    {sourceId && (
                                      <p className="text-muted-foreground/60 mt-0.5 font-mono">
                                        ID: {sourceId.slice(0, 8)}...
                                      </p>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Connector line between steps */}
                      {index < PIPELINE_STEPS.length - 1 && (
                        <div className="flex justify-start ml-[21px] my-0">
                          <div
                            className={cn(
                              'w-px h-2',
                              status === 'completed'
                                ? 'bg-border'
                                : status === 'running'
                                  ? 'bg-accent-tint'
                                  : 'bg-muted/30'
                            )}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 border-t border-border bg-card/95 backdrop-blur-sm px-6 py-4 flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {isRunning && overallStatus && (
              <>
                Step {overallStatus.steps_completed}/{overallStatus.steps_total}
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isDone && activeTab === 'pipeline' && (
              <Button
                onClick={handleReset}
                variant="outline"
                size="sm"
                className="gap-1.5 border-border text-muted-foreground hover:bg-accent"
              >
                <ArrowsClockwise size={14} />
                Run Again
              </Button>
            )}
            {pipelineState === 'idle' || isDone ? (
              <Button
                onClick={isDone ? onClose : handleGenerate}
                variant={isDone ? 'secondary' : 'default'}
                className="gap-2 text-sm font-medium"
              >
                {isDone ? (
                  <>Done</>
                ) : (
                  <>
                    <Lightning size={16} weight="fill" />
                    Generate Journals
                  </>
                )}
              </Button>
            ) : (
              <Button disabled className="gap-2 text-sm font-medium opacity-70">
                <ArrowsClockwise size={16} className="animate-spin" />
                Generating...
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
