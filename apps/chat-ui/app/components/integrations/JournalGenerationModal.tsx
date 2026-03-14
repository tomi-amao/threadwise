/**
 * Journal Generation Modal
 *
 * Full-pipeline journal generation UI with scope selection.
 * Runs journal-generating steps in dependency order:
 *
 * 1. Cross-provider duplicate detection — identify PayPal mirrors
 * 2. Invoice matching — auto-match open invoices to transactions
 * 3. Accrue Payments — revenue recognition for captured payments
 * 4. Settle Payouts — cash recognition for inbound gateway transfers
 * 5. Journal Expenses — expense recording for categorised bank outflows
 * 6. Journal Invoices — purchase / sale / payment journals from invoices
 *
 * Users can select a scope (payments, transactions, invoices, or all)
 * before running the pipeline. A Review tab surfaces draft journals
 * that need human attention.
 */

import React, { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
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
  GitMerge,
  CaretDown,
  CaretRight,
  Info,
  ClipboardText,
  Eye,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import {
  generateAllJournals,
  fetchReviewSummary,
  type GenerateAllResult,
  type PipelineStepResult,
  type PipelineError,
  type ReviewSummary,
  type Journal,
  type JournalScope,
} from '~/lib/api/accounting';

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
    key: 'duplicate_detection',
    title: 'Duplicate Detection',
    description: 'Identify cross-provider mirrors (Revolut ↔ PayPal)',
    icon: GitMerge,
    iconColor: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
  },
  {
    key: 'invoice_matching',
    title: 'Invoice Matching',
    description: 'Auto-match open invoices to financial transactions',
    icon: Receipt,
    iconColor: 'text-teal-400',
    bgColor: 'bg-teal-500/10',
  },
  {
    key: 'journal_payments',
    title: 'Accrue Payments',
    description: 'Revenue recognition for captured payments → Clearing',
    icon: ShoppingCart,
    iconColor: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
  },
  {
    key: 'journal_settlements',
    title: 'Settle Payouts',
    description: 'Cash recognition from inbound gateway transfers',
    icon: Bank,
    iconColor: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
  },
  {
    key: 'journal_inbound',
    title: 'Journal Inbound',
    description: 'Funding, sales receipts, refunds, FX conversions, merchant payments',
    icon: ArrowRight,
    iconColor: 'text-cyan-400',
    bgColor: 'bg-cyan-500/10',
  },
  {
    key: 'journal_expenses',
    title: 'Journal Expenses',
    description: 'Record categorised bank outflows as expenses',
    icon: Receipt,
    iconColor: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
  },
  {
    key: 'journal_invoices',
    title: 'Journal Invoices',
    description: 'Create purchase, sale and payment journals from invoices',
    icon: ClipboardText,
    iconColor: 'text-orange-400',
    bgColor: 'bg-orange-500/10',
  },
];

// =============================================================================
// HELPER: Format step result into readable summary
// =============================================================================

function getStepSummary(step: PipelineStepResult): string[] {
  const lines: string[] = [];

  switch (step.step) {
    case 'duplicate_detection':
      if (step.duplicates_found !== undefined) {
        lines.push(
          `${step.duplicates_found} duplicate${step.duplicates_found !== 1 ? 's' : ''} found`
        );
      }
      if (step.excluded_transactions) {
        lines.push(`${step.excluded_transactions} excluded`);
      }
      if (step.enriched) lines.push(`${step.enriched} enriched`);
      if (step.invoices_updated)
        lines.push(
          `${step.invoices_updated} invoice${step.invoices_updated !== 1 ? 's' : ''} updated`
        );
      if (step.internal_pairs_cancelled)
        lines.push(
          `${step.internal_pairs_cancelled} internal pair${step.internal_pairs_cancelled !== 1 ? 's' : ''} cancelled`
        );
      break;

    case 'invoice_matching':
      if (step.invoices_checked !== undefined) {
        lines.push(
          `${step.invoices_checked} invoice${step.invoices_checked !== 1 ? 's' : ''} checked`
        );
      }
      if (step.invoices_matched !== undefined) {
        lines.push(
          `${step.invoices_matched} invoice${step.invoices_matched !== 1 ? 's' : ''} matched`
        );
      }
      break;

    case 'journal_payments':
    case 'journal_settlements':
    case 'journal_expenses':
    case 'journal_invoices': {
      const created = step.created ?? 0;
      const skipped = step.skipped ?? 0;
      const errorCount = step.errors?.length ?? 0;
      if (created > 0) lines.push(`${created} journal${created !== 1 ? 's' : ''} created`);
      if (skipped > 0) lines.push(`${skipped} skipped`);
      if (errorCount > 0) lines.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);
      if (created === 0 && skipped === 0 && errorCount === 0) {
        lines.push('No eligible records');
      }
      break;
    }

    case 'journal_inbound': {
      const created = step.created ?? 0;
      const skipped = step.skipped ?? 0;
      const errorCount = step.errors?.length ?? 0;
      if (created > 0) lines.push(`${created} journal${created !== 1 ? 's' : ''} created`);
      if (skipped > 0) lines.push(`${skipped} skipped`);
      if (errorCount > 0) lines.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);
      // breakdown by type
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
      break;
    }
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
      return <ArrowsClockwise size={18} className="text-blue-400 animate-spin" />;
    case 'completed':
      return <CheckCircle size={18} weight="fill" className="text-emerald-400" />;
    case 'error':
      return <XCircle size={18} weight="fill" className="text-red-400" />;
    default:
      return (
        <div
          className={cn(
            'h-[18px] w-[18px] rounded-full border-2',
            isActive ? 'border-blue-400' : 'border-zinc-600'
          )}
        />
      );
  }
}

// =============================================================================
// REVIEW: Draft Journal Row
// =============================================================================

function DraftJournalRow({ journal }: { journal: Journal }) {
  const [expanded, setExpanded] = useState(false);
  const lineItems = journal.line_items ?? [];

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-amber-500/5 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ClipboardText size={16} className="text-amber-400 shrink-0" />
          <span className="text-sm text-zinc-200 truncate">
            {journal.description ?? `${journal.journal_type} journal`}
          </span>
          <span className="text-xs text-zinc-500 shrink-0">
            {new Date(journal.journal_date).toLocaleDateString()}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">
            draft
          </span>
          {expanded ? (
            <CaretDown size={14} className="text-zinc-500" />
          ) : (
            <CaretRight size={14} className="text-zinc-500" />
          )}
        </div>
      </button>

      {expanded && lineItems.length > 0 && (
        <div className="px-3 pb-3 space-y-1 border-t border-amber-500/10 pt-2">
          <p className="text-xs text-zinc-500 mb-1.5">Journal line items:</p>
          {lineItems.map((li, i) => (
            <div key={i} className="flex items-center justify-between text-xs font-mono gap-2">
              <span className="text-zinc-400 truncate flex-1">{li.description || '—'}</span>
              <div className="flex gap-3 shrink-0">
                {li.debit > 0 && (
                  <span className="text-zinc-300">
                    DR <span className="text-emerald-400">{li.debit.toFixed(2)}</span>
                  </span>
                )}
                {li.credit > 0 && (
                  <span className="text-zinc-300">
                    CR <span className="text-blue-400">{li.credit.toFixed(2)}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
          <p className="text-xs text-amber-400/70 mt-2 pt-2 border-t border-zinc-700/30">
            Review and post manually once the correct account is confirmed.
          </p>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// REVIEW TAB
// =============================================================================

function ReviewTab({ entityId, onRefresh }: { entityId: string; onRefresh?: () => void }) {
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftExpanded, setDraftExpanded] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchReviewSummary(entityId);
      setReview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  // Auto-load on mount
  React.useEffect(() => {
    load();
  }, [load]);

  if (loading && !review) {
    return (
      <div className="flex items-center justify-center py-12">
        <ArrowsClockwise size={24} className="text-zinc-500 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
        <p className="text-sm text-red-400">{error}</p>
        <button onClick={load} className="mt-2 text-xs text-zinc-400 hover:text-zinc-200 underline">
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
            totalDraft > 0 ? 'bg-amber-500/15 text-amber-400' : 'bg-zinc-800 text-zinc-500'
          )}
        >
          <ClipboardText size={13} />
          {totalDraft} draft journal{totalDraft !== 1 ? 's' : ''}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition-colors"
        >
          <ArrowsClockwise size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {nothingToReview && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-4 text-center">
          <CheckCircle size={24} weight="fill" className="text-emerald-400 mx-auto mb-2" />
          <p className="text-sm font-medium text-emerald-300">Everything looks good</p>
          <p className="text-xs text-zinc-400 mt-1">No draft journals require attention.</p>
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
              <ClipboardText size={16} className="text-amber-400" />
              <span className="text-sm font-medium text-zinc-200">Draft Journals</span>
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400">
                {totalDraft}
              </span>
            </div>
            {draftExpanded ? (
              <CaretDown size={14} className="text-zinc-500" />
            ) : (
              <CaretRight size={14} className="text-zinc-500" />
            )}
          </button>

          {draftExpanded && (
            <>
              <p className="text-xs text-zinc-500 mb-2 ml-6">
                These journals were created as drafts because the expense account could not be
                automatically determined. Review and post each one with the correct GL account.
              </p>
              {Object.keys(review.draft_journals_by_type).length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2 ml-6">
                  {Object.entries(review.draft_journals_by_type).map(([type, count]) => (
                    <span
                      key={type}
                      className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full"
                    >
                      {type}: {count}
                    </span>
                  ))}
                </div>
              )}
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {review.draft_journals.map(j => (
                  <DraftJournalRow key={j.id} journal={j} />
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
  const [pipelineState, setPipelineState] = useState<PipelineState>('idle');
  const [result, setResult] = useState<GenerateAllResult | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<ActiveTab>('pipeline');
  const [scope, setScope] = useState<JournalScope>('all');
  const abortRef = useRef(false);

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
    setPipelineState('running');
    setResult(null);
    setGlobalError(null);
    abortRef.current = false;

    try {
      const res = await generateAllJournals(entityId, scope);
      setResult(res);
      setPipelineState(res.status === 'completed' ? 'completed' : 'error');

      const totalCreated = res.summary.total_journals_created;
      if (totalCreated > 0) {
        toast.success(
          `Generated ${totalCreated} journal${totalCreated !== 1 ? 's' : ''}` +
            (res.summary.total_errors > 0
              ? ` with ${res.summary.total_errors} error${res.summary.total_errors !== 1 ? 's' : ''}`
              : '')
        );
      } else if (res.summary.total_errors > 0) {
        toast.error(
          `Pipeline completed with ${res.summary.total_errors} error${res.summary.total_errors !== 1 ? 's' : ''}`
        );
      } else {
        toast.info('No new journals to generate — everything is up to date');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setGlobalError(message);
      setPipelineState('error');
      toast.error(`Journal generation failed: ${message}`);
    }
  }, [entityId]);

  const handleReset = useCallback(() => {
    setPipelineState('idle');
    setResult(null);
    setGlobalError(null);
    setExpandedErrors(new Set());
    setActiveTab('pipeline');
    setScope('all');
  }, []);

  // Determine step status from result data
  const getStepStatus = (stepKey: string): 'pending' | 'running' | 'completed' | 'error' => {
    if (pipelineState === 'idle') return 'pending';
    if (pipelineState === 'running' && !result) return 'running';
    if (!result) return 'pending';

    const stepResult = result.steps.find(s => s.step === stepKey);
    if (!stepResult) return 'pending';
    if (stepResult.status === 'completed') return 'completed';
    if (stepResult.status === 'error') return 'error';
    return 'running';
  };

  const getStepResult = (stepKey: string): PipelineStepResult | undefined => {
    return result?.steps.find(s => s.step === stepKey);
  };

  const getStepErrors = (stepKey: string): PipelineError[] => {
    return (result?.errors ?? []).filter(e => e.step === stepKey);
  };

  if (!isOpen) return null;

  const isRunning = pipelineState === 'running';
  const isDone = pipelineState === 'completed' || pipelineState === 'error';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={isRunning ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-700/50 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-700/50 bg-zinc-900/95 backdrop-blur-sm px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
              <BookOpen size={22} weight="duotone" className="text-violet-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Generate Journals</h2>
              <p className="text-sm text-zinc-400">Full double-entry journal pipeline</p>
            </div>
          </div>
          <button
            onClick={isRunning ? undefined : onClose}
            disabled={isRunning}
            className={cn(
              'rounded-lg p-2 text-zinc-400 transition-colors',
              isRunning ? 'cursor-not-allowed opacity-40' : 'hover:bg-zinc-800 hover:text-zinc-200'
            )}
          >
            <X size={20} weight="bold" />
          </button>
        </div>

        {/* Tabs — always visible */}
        <div className="flex border-b border-zinc-700/50 px-6">
          <button
            onClick={() => setActiveTab('pipeline')}
            className={cn(
              'flex items-center gap-1.5 px-1 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === 'pipeline'
                ? 'border-violet-500 text-violet-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
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
                ? 'border-amber-500 text-amber-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
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
                  <div className="rounded-xl border border-zinc-700/30 bg-zinc-800/30 px-4 py-3 mb-2">
                    <div className="flex items-start gap-3">
                      <Info size={18} className="text-zinc-400 mt-0.5 shrink-0" />
                      <div className="text-sm text-zinc-400">
                        <p>
                          This will detect cross-provider duplicates, match invoices, and generate
                          all pending journals (accruals, settlements, expenses, invoices) in a
                          single pass. Existing journals are never duplicated.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Scope selector */}
                  <div className="rounded-xl border border-zinc-700/30 bg-zinc-800/30 px-4 py-3 mb-2">
                    <p className="text-xs font-medium text-zinc-300 mb-2">Journal scope</p>
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          { value: 'all', label: 'All' },
                          { value: 'payments', label: 'Payments' },
                          { value: 'transactions', label: 'Transactions' },
                          { value: 'invoices', label: 'Invoices' },
                        ] as const
                      ).map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setScope(opt.value)}
                          className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                            scope === opt.value
                              ? 'border-violet-500/50 bg-violet-500/15 text-violet-300'
                              : 'border-zinc-700/30 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                          )}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-zinc-500 mt-1.5">
                      {scope === 'all' && 'Run all journal-generating steps.'}
                      {scope === 'payments' && 'Accrue captured payments as revenue.'}
                      {scope === 'transactions' &&
                        'Settle gateway payouts, journal inbound transfers (funding, refunds, FX, sales) and record expenses.'}
                      {scope === 'invoices' &&
                        'Create purchase, sale and payment journals from invoices.'}
                    </p>
                  </div>
                </>
              )}

              {/* Summary banner (after completion) */}
              {isDone && result && (
                <div
                  className={cn(
                    'rounded-xl border px-4 py-3 mb-2',
                    result.summary.total_errors > 0
                      ? 'border-amber-500/30 bg-amber-500/5'
                      : 'border-emerald-500/30 bg-emerald-500/5'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {result.summary.total_errors > 0 ? (
                        <WarningCircle size={20} weight="fill" className="text-amber-400" />
                      ) : (
                        <CheckCircle size={20} weight="fill" className="text-emerald-400" />
                      )}
                      <div className="text-sm">
                        <span className="font-semibold text-zinc-100">
                          {result.summary.total_journals_created}
                        </span>{' '}
                        <span className="text-zinc-300">
                          journal{result.summary.total_journals_created !== 1 ? 's' : ''} created
                        </span>
                        {result.summary.total_skipped > 0 && (
                          <>
                            {' · '}
                            <span className="font-semibold text-zinc-100">
                              {result.summary.total_skipped}
                            </span>{' '}
                            <span className="text-zinc-400">skipped</span>
                          </>
                        )}
                        {result.summary.total_errors > 0 && (
                          <>
                            {' · '}
                            <span className="font-semibold text-red-400">
                              {result.summary.total_errors}
                            </span>{' '}
                            <span className="text-zinc-400">
                              error{result.summary.total_errors !== 1 ? 's' : ''}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {/* Review prompt */}
                    <button
                      onClick={() => setActiveTab('review')}
                      className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      <Eye size={13} />
                      Review items
                      <ArrowRight size={12} />
                    </button>
                  </div>
                </div>
              )}

              {/* Global error */}
              {globalError && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 mb-2">
                  <div className="flex items-start gap-2">
                    <XCircle size={18} weight="fill" className="text-red-400 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-red-400">Pipeline failed</p>
                      <p className="text-sm text-zinc-400 mt-1">{globalError}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Pipeline Steps */}
              <div className="space-y-1">
                {PIPELINE_STEPS.map((step, index) => {
                  const status = getStepStatus(step.key);
                  const stepResult = getStepResult(step.key);
                  const stepErrors = getStepErrors(step.key);
                  const isErrorExpanded = expandedErrors.has(step.key);
                  const Icon = step.icon;
                  const isActive = pipelineState === 'running' && !result;

                  return (
                    <div key={step.key}>
                      <div
                        className={cn(
                          'rounded-xl border px-4 py-3 transition-all',
                          status === 'error'
                            ? 'border-red-500/20 bg-red-500/5'
                            : status === 'completed'
                              ? 'border-zinc-700/30 bg-zinc-800/30'
                              : status === 'running'
                                ? 'border-blue-500/30 bg-blue-500/5'
                                : 'border-zinc-700/20 bg-zinc-800/20'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          {/* Status indicator */}
                          <div className="shrink-0">
                            <StepStatusIcon status={status} isActive={isActive} />
                          </div>

                          {/* Step icon */}
                          <div
                            className={cn(
                              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                              step.bgColor,
                              status === 'pending' && pipelineState !== 'idle' && 'opacity-40'
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
                                  status === 'pending' && pipelineState !== 'idle'
                                    ? 'text-zinc-500'
                                    : 'text-zinc-200'
                                )}
                              >
                                {step.title}
                              </h3>
                              {status === 'running' && (
                                <span className="text-xs text-blue-400 animate-pulse">
                                  Running...
                                </span>
                              )}
                            </div>
                            {(pipelineState === 'idle' || status === 'pending') && (
                              <p className="text-xs text-zinc-500 mt-0.5">{step.description}</p>
                            )}
                            {/* Step results */}
                            {stepResult && status !== 'pending' && (
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                                {getStepSummary(stepResult).map((line, i) => (
                                  <span key={i} className="text-xs text-zinc-400">
                                    {i > 0 && <span className="text-zinc-600 mr-2">·</span>}
                                    {line}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Error expand toggle */}
                          {stepErrors.length > 0 && (
                            <button
                              onClick={() => toggleErrorExpand(step.key)}
                              className="shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                              title={isErrorExpanded ? 'Hide errors' : 'Show errors'}
                            >
                              {isErrorExpanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
                            </button>
                          )}
                        </div>

                        {/* Expandable error details */}
                        {isErrorExpanded && stepErrors.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-zinc-700/30 space-y-2">
                            <p className="text-xs font-medium text-zinc-400">
                              {stepErrors.length} error{stepErrors.length !== 1 ? 's' : ''}:
                            </p>
                            <div className="space-y-1.5 max-h-40 overflow-y-auto">
                              {stepErrors.map((err, i) => (
                                <div
                                  key={i}
                                  className="rounded-lg bg-zinc-900/50 px-3 py-2 text-xs"
                                >
                                  <p className="text-red-400">{err.error}</p>
                                  {err.source_id && (
                                    <p className="text-zinc-600 mt-0.5 font-mono">
                                      ID: {err.source_id.slice(0, 8)}...
                                    </p>
                                  )}
                                </div>
                              ))}
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
                                ? 'bg-zinc-600'
                                : status === 'running'
                                  ? 'bg-blue-500/50'
                                  : 'bg-zinc-700/30'
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
        <div className="sticky bottom-0 border-t border-zinc-700/50 bg-zinc-900/95 backdrop-blur-sm px-6 py-4 flex items-center justify-between">
          <div className="text-xs text-zinc-500">
            {isDone && result && activeTab === 'pipeline' && (
              <>
                Completed in{' '}
                {Math.round(
                  (new Date(result.completed_at).getTime() -
                    new Date(result.started_at).getTime()) /
                    1000
                )}
                s
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isDone && activeTab === 'pipeline' && (
              <Button
                onClick={handleReset}
                variant="outline"
                size="sm"
                className="gap-1.5 border-zinc-600 text-zinc-300 hover:bg-zinc-800"
              >
                <ArrowsClockwise size={14} />
                Run Again
              </Button>
            )}
            {pipelineState === 'idle' || isDone ? (
              <Button
                onClick={isDone ? onClose : handleGenerate}
                className={cn(
                  'gap-2 text-sm font-medium',
                  isDone
                    ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
                    : 'bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-500/20'
                )}
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
