/**
 * RunDrawer: one journal generation run. What happened (each step, every problem) is the record
 * saved at the time; what is true now (drafts still open, journals reversed since) comes from
 * the journals themselves. The summary is the same one the Generate Journals modal shows.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle, WarningCircle } from 'phosphor-react';
import { JournalRunSummaryTab } from '~/components/integrations/JournalRunSummaryTab';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { Drawer } from '~/components/ui/drawer';
import type { JournalRunDetail } from '~/lib/api/journal-runs.server';
import type { JournalRunSummary } from '~/lib/api/accounting';
import { STATUS, int, money, sourceLink, typeLabel } from './model';
import {
  isStillGoing,
  problemsNotShown,
  runDuration,
  runHeadline,
  runNow,
  runProblems,
  runResult,
  runWhen,
  scopeLabel,
  stepName,
  type RunNow,
} from './runs';

/** Enough to see what a run did; the ledger link shows the rest. */
const JOURNALS_SHOWN = 8;

const heading = 'eyebrow mb-2';
const link =
  'rounded-sm text-[14px] text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function RunBody({
  run,
  now,
  live,
  onOpenJournal,
  onReview,
  onLedger,
}: {
  run: JournalRunDetail;
  now: number;
  live: RunNow;
  onOpenJournal: (id: string) => void;
  onReview: () => void;
  onLedger: () => void;
}) {
  const [summary, setSummary] = useState<(JournalRunSummary & { forRun: string }) | null>(null);
  // The state setter's identity is stable, so this does not refetch.
  const [onLoaded] = useState(
    () => (fresh: JournalRunSummary, forRun: string) => setSummary({ ...fresh, forRun })
  );

  const result = runResult(run, now);
  const duration = runDuration(run);
  const problems = runProblems(run);
  const hidden = problemsNotShown(run);
  const biggest = [...live.journals].sort((a, b) => b.amount - a.amount).slice(0, JOURNALS_SHOWN);
  const inLedger = live.journals.filter(j => j.status !== 'draft').length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={result.tone} dot>
          {result.label}
        </Chip>
        <Chip tone="plain">{scopeLabel(run.scope)}</Chip>
        {duration && <Chip tone="plain">Took {duration}</Chip>}
        {run.skipped > 0 && <Chip tone="plain">{int(run.skipped)} skipped</Chip>}
        {live.reversed > 0 && <Chip tone="plain">{int(live.reversed)} reversed since</Chip>}
      </div>

      {run.failureReason && (
        <p role="alert" className="text-[15px] text-destructive">
          {run.failureReason}
        </p>
      )}

      {problems.length > 0 && (
        <section aria-labelledby="run-problems">
          <h3 id="run-problems" className={heading}>
            Problems
          </h3>
          <ul className="divide-y rounded-xl border">
            {problems.map(p => {
              const to = sourceLink('financial_transaction', p.transactionId);
              return (
                <li key={p.key} className="space-y-1 px-3 py-2.5 text-[15px]">
                  <p className="break-words">{p.message}</p>
                  <p className="flex flex-wrap items-center gap-x-3 text-[13px] text-text-2">
                    <span>{p.step}</span>
                    {to && (
                      <Link to={to} className={link}>
                        See the bank line
                      </Link>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
          {hidden > 0 && (
            <p className="mt-2 text-[13px] text-text-2">
              And {int(hidden)} more that were not kept.
            </p>
          )}
        </section>
      )}

      {run.created > 0 && !isStillGoing(run, now) && (
        <section aria-label="Summary">
          <JournalRunSummaryTab
            entityId={run.entityId}
            runId={run.id}
            summary={summary}
            stale={false}
            onLoaded={onLoaded}
            onReview={onReview}
            inRunDrawer
          />
        </section>
      )}

      {run.steps.length > 0 && (
        <section aria-labelledby="run-steps">
          <h3 id="run-steps" className={heading}>
            Step by step
          </h3>
          <ul className="divide-y rounded-xl border">
            {run.steps.map(step => {
              const errors = step.errors_total ?? step.errors?.length ?? 0;
              const failed = step.status === 'error';
              const Icon = failed ? WarningCircle : CheckCircle;
              return (
                <li key={step.step} className="flex items-start gap-2 px-3 py-2.5 text-[15px]">
                  <Icon
                    size={16}
                    weight="fill"
                    aria-hidden
                    className={`mt-1 shrink-0 ${failed ? 'text-destructive' : 'text-text-2'}`}
                  />
                  <div className="min-w-0">
                    <p>{stepName(step.step, step.title)}</p>
                    <p className="text-[13px] text-text-2">
                      {failed
                        ? 'Could not finish'
                        : `${int(step.created ?? 0)} created, ${int(step.skipped ?? 0)} skipped${
                            errors > 0 ? `, ${int(errors)} failed` : ''
                          }`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {biggest.length > 0 && (
        <section aria-labelledby="run-journals">
          <h3 id="run-journals" className={heading}>
            Journals in this run
          </h3>
          <ul className="divide-y rounded-xl border">
            {biggest.map(j => (
              <li key={j.id}>
                <button
                  type="button"
                  onClick={() => onOpenJournal(j.id)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px]">
                      {j.description || typeLabel(j.type)}
                    </span>
                    <span className="block text-[13px] text-text-2">
                      {typeLabel(j.type)}, {STATUS[j.status].label.toLowerCase()}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{money(j.amount)}</span>
                </button>
              </li>
            ))}
          </ul>
          {inLedger > 0 && (
            <Button variant="outline" size="sm" className="mt-3" onClick={onLedger}>
              View {int(inLedger)} in the ledger
            </Button>
          )}
        </section>
      )}
    </>
  );
}

export function RunDrawer({
  run,
  now,
  byRun,
  open,
  onClose,
  onOpenJournal,
  onReview,
  onLedger,
}: {
  run: JournalRunDetail | null;
  now: number;
  byRun: Map<string, RunNow>;
  open: boolean;
  onClose: () => void;
  onOpenJournal: (id: string) => void;
  onReview: () => void;
  onLedger: (id: string) => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={o => !o && onClose()}
      eyebrow={run ? `Run, ${runWhen(run.createdAt)}` : 'Run'}
      title={run ? runHeadline(run, now) : 'Run not found'}
      description="What this journal generation run did"
      className="w-[min(640px,100vw)]"
    >
      {!run ? (
        <p className="text-[15px] text-text-2">
          This run does not exist, or belongs to another business.
        </p>
      ) : (
        <RunBody
          key={run.id}
          run={run}
          now={now}
          live={runNow(byRun, run.id)}
          onOpenJournal={onOpenJournal}
          onReview={onReview}
          onLedger={() => onLedger(run.id)}
        />
      )}
    </Drawer>
  );
}
