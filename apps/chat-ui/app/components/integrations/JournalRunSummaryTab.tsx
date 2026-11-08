/**
 * Summary tab of the Generate Journals modal: what the run that just finished
 * recorded. The figures come from the agent's own arithmetic over the run's
 * journals; only the short narrative at the top is written by a model, and the
 * tab still shows every figure when that narrative is unavailable.
 *
 * The result is held by the modal (`summary` / `onLoaded`), so switching tabs
 * does not ask the model again; it is fetched once per run, the first time the
 * tab is opened.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, CheckCircle, ClipboardText, Sparkle, WarningCircle } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { fetchJournalRunSummary, type JournalRunSummary } from '~/lib/api/accounting';
import { int, money, shortDate, typeLabel } from '~/components/journals/model';

interface JournalRunSummaryTabProps {
  entityId: string;
  /** The run's `started_at`, from the realtime status message. */
  since: string;
  summary: JournalRunSummary | null;
  onLoaded: (summary: JournalRunSummary) => void;
  onReview: () => void;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-base font-semibold tabular-nums truncate', tone ?? 'text-foreground')}>
        {value}
      </p>
    </div>
  );
}

export function JournalRunSummaryTab({
  entityId,
  since,
  summary,
  onLoaded,
  onReview,
}: JournalRunSummaryTabProps) {
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      onLoaded(await fetchJournalRunSummary(entityId, since));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  }, [entityId, since, onLoaded]);

  // Only when this run has no summary yet: once loaded, the modal holds it. An
  // error leaves `summary` null without changing the deps, so it waits for Retry.
  useEffect(() => {
    if (!summary) load();
  }, [summary, load]);

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

  if (!summary) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12" aria-live="polite">
        <Sparkle size={22} className="text-accent-text animate-pulse" />
        <p className="text-sm text-muted-foreground">Summarising this run…</p>
      </div>
    );
  }

  const { stats, narrative } = summary;

  if (stats.journals_total === 0) {
    return (
      <div className="rounded-xl border border-income/30 bg-income/10 px-4 py-4 text-center">
        <CheckCircle size={24} weight="fill" className="text-income mx-auto mb-2" />
        <p className="text-sm font-medium text-income">No new journals in this run</p>
        <p className="text-xs text-muted-foreground mt-1">
          Everything eligible had already been journaled.
        </p>
      </div>
    );
  }

  const range =
    stats.first_date && stats.last_date
      ? stats.first_date.slice(0, 10) === stats.last_date.slice(0, 10)
        ? shortDate(stats.first_date)
        : `${shortDate(stats.first_date)} – ${shortDate(stats.last_date)}`
      : null;

  return (
    <div className="space-y-4">
      {/* AI narrative */}
      {narrative ? (
        <section
          aria-label="AI summary"
          className="rounded-xl border border-ring/40 bg-accent-tint px-4 py-3"
        >
          <div className="flex items-start gap-2">
            <Sparkle size={16} weight="fill" className="text-accent-text shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-2">
              <p className="text-sm font-medium text-foreground">{narrative.headline}</p>
              {narrative.highlights.length > 0 && (
                <ul className="list-disc pl-4 space-y-1 text-sm text-muted-foreground">
                  {narrative.highlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              )}
              {narrative.attention.length > 0 && (
                <div className="pt-1 space-y-1">
                  {narrative.attention.map((a, i) => (
                    <p key={i} className="flex items-start gap-1.5 text-sm text-accent-text">
                      <WarningCircle size={14} className="shrink-0 mt-0.5" />
                      <span>{a}</span>
                    </p>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground/80">
                Written by AI from the figures below. Check them before relying on it.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkle size={12} />
          The AI summary is unavailable right now; the figures below are complete.
        </p>
      )}

      {/* Figures */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Journals" value={int(stats.journals_total)} />
        <Stat label="Total value" value={money(stats.total_amount)} />
        <Stat label="Posted" value={int(stats.posted)} tone="text-income" />
        <Stat
          label="Drafts"
          value={int(stats.draft)}
          tone={stats.draft > 0 ? 'text-accent-text' : undefined}
        />
      </div>
      {range && <p className="text-xs text-muted-foreground -mt-2">Dated {range}</p>}

      {stats.draft > 0 && (
        <button
          onClick={onReview}
          className="w-full flex items-center justify-between rounded-xl border border-ring/40 bg-accent-tint px-4 py-2.5 text-sm text-accent-text hover:bg-accent transition-colors"
        >
          <span className="flex items-center gap-2">
            <ClipboardText size={15} />
            {stats.draft} draft{stats.draft !== 1 ? 's' : ''} need an account before they post
          </span>
          <ArrowRight size={14} />
        </button>
      )}

      {/* By type */}
      <section aria-labelledby="run-by-type">
        <h3 id="run-by-type" className="text-xs font-medium text-muted-foreground mb-1.5">
          By type
        </h3>
        <div className="rounded-xl border border-border/60 divide-y divide-border/60">
          {stats.by_type.map(t => (
            <div
              key={t.journal_type}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <span className="text-foreground truncate">{typeLabel(t.journal_type)}</span>
              <span className="flex gap-3 shrink-0 tabular-nums">
                <span className="text-muted-foreground">{int(t.count)}</span>
                <span className="text-foreground w-24 text-right">{money(t.amount)}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Accounts that moved most */}
      {stats.top_accounts.length > 0 && (
        <section aria-labelledby="run-top-accounts">
          <h3 id="run-top-accounts" className="text-xs font-medium text-muted-foreground mb-1.5">
            Accounts that moved most
          </h3>
          <div className="rounded-xl border border-border/60 divide-y divide-border/60">
            {stats.top_accounts.map(a => (
              <div
                key={`${a.account_number}-${a.name}`}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="truncate min-w-0">
                  {a.account_number && (
                    <span className="font-mono text-xs text-muted-foreground mr-1.5">
                      {a.account_number}
                    </span>
                  )}
                  <span className="text-foreground">{a.name}</span>
                </span>
                <span className="flex gap-3 shrink-0 text-xs tabular-nums">
                  {a.debit > 0 && (
                    <span className="text-muted-foreground">
                      DR <span className="text-foreground">{money(a.debit)}</span>
                    </span>
                  )}
                  {a.credit > 0 && (
                    <span className="text-muted-foreground">
                      CR <span className="text-foreground">{money(a.credit)}</span>
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Largest journals */}
      {stats.largest_journals.length > 0 && (
        <section aria-labelledby="run-largest">
          <h3 id="run-largest" className="text-xs font-medium text-muted-foreground mb-1.5">
            Largest journals
          </h3>
          <div className="rounded-xl border border-border/60 divide-y divide-border/60">
            {stats.largest_journals.map(j => (
              <div key={j.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">
                    {j.description ?? typeLabel(j.journal_type)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {typeLabel(j.journal_type)}
                    {j.journal_date && ` · ${shortDate(j.journal_date)}`}
                    {j.status === 'draft' && <span className="text-accent-text"> · draft</span>}
                  </p>
                </div>
                <span className="text-sm text-foreground tabular-nums shrink-0">
                  {money(j.amount)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {stats.truncated && 'Showing the first 1,000 journals of this run. '}
          Amounts in {stats.currency}.
        </span>
        <Link
          to="/journals"
          className="flex items-center gap-1 text-accent-text hover:underline shrink-0"
        >
          Open journals <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  );
}
