/** Journal generation runs: the words for how each one went, and what is true of it now. */

import type { ChipTone } from '~/components/ui/chip';
import type { JournalRun, JournalRunDetail } from '~/lib/api/journal-runs.server';
import type { JournalRow } from '~/lib/api/journals.server';

/** The agent closes an active run this old when the next one starts; say so before then. */
const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

const isActive = (run: JournalRun) => run.status === 'queued' || run.status === 'running';

export const isAbandoned = (run: JournalRun, now: number): boolean =>
  isActive(run) && now - new Date(run.createdAt).getTime() > ABANDONED_AFTER_MS;

export const isStillGoing = (run: JournalRun, now: number): boolean =>
  isActive(run) && !isAbandoned(run, now);

export function runResult(run: JournalRun, now: number): { label: string; tone: ChipTone } {
  if (isAbandoned(run, now)) return { label: 'Did not finish', tone: 'negative' };
  if (isActive(run)) return { label: 'Running', tone: 'active' };
  if (run.status === 'failed') return { label: 'Failed', tone: 'negative' };
  if (run.status === 'completed_with_errors' || run.errors > 0) {
    const problems = Math.max(run.errors, 1);
    return { label: `${problems} problem${problems === 1 ? '' : 's'}`, tone: 'negative' };
  }
  if (run.created === 0) return { label: 'Nothing new', tone: 'plain' };
  return { label: 'Complete', tone: 'done' };
}

export function runHeadline(run: JournalRun, now: number): string {
  if (isStillGoing(run, now)) return 'Still running';
  if (run.created > 0) return `${run.created} journal${run.created === 1 ? '' : 's'} created`;
  if (run.status === 'failed' || isAbandoned(run, now)) return 'The run did not finish';
  return 'Nothing new to journal';
}

const SCOPE: Record<string, string> = {
  all: 'All',
  payments: 'Payments',
  transactions: 'Transactions',
};
export const scopeLabel = (scope: string): string => SCOPE[scope] ?? scope;

// A fixed zone: the page is rendered on the server and again in the browser, and they must agree.
const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/London',
});
export const runWhen = (iso: string): string => WHEN.format(new Date(iso));

export function runDuration(run: JournalRun): string | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const seconds = Math.round(
    (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
  );
  if (seconds < 0) return null;
  return seconds < 60 ? `${seconds} sec` : `${Math.round(seconds / 60)} min`;
}

const STEP_NAME: Record<string, string> = {
  journal_payments: 'Accrue payments',
  journal_settlements: 'Settle payouts',
  journal_inbound: 'Journal inbound transactions',
  journal_expenses: 'Journal expenses',
};
export const stepName = (key: string, title: string): string => STEP_NAME[key] ?? title;

export interface RunNow {
  value: number;
  stillOpen: number;
  reversed: number;
  journals: JournalRow[];
}

const NOTHING: RunNow = { value: 0, stillOpen: 0, reversed: 0, journals: [] };

/** What is true of each run's journals now, read from the journals rather than stored. */
export function runsNow(journals: JournalRow[]): Map<string, RunNow> {
  const byRun = new Map<string, RunNow>();
  for (const j of journals) {
    if (!j.generationRunId) continue;
    const run = byRun.get(j.generationRunId) ?? { ...NOTHING, journals: [] };
    run.value = Math.round((run.value + j.amount) * 100) / 100;
    if (j.status === 'draft') run.stillOpen += 1;
    if (j.status === 'reversed') run.reversed += 1;
    run.journals.push(j);
    byRun.set(j.generationRunId, run);
  }
  return byRun;
}

export const runNow = (byRun: Map<string, RunNow>, id: string): RunNow => byRun.get(id) ?? NOTHING;

export interface RunProblem {
  key: string;
  step: string;
  message: string;
  transactionId: string | null;
}

/** Every recorded problem in a run: a step that failed outright, and items that did. */
export function runProblems(run: JournalRunDetail): RunProblem[] {
  return run.steps.flatMap(step => [
    ...(step.error
      ? [
          {
            key: `${step.step}-step`,
            step: stepName(step.step, step.title),
            message: step.error,
            transactionId: null,
          },
        ]
      : []),
    ...(step.errors ?? []).map((e, i) => ({
      key: `${step.step}-${i}`,
      step: stepName(step.step, step.title),
      message: e.error,
      transactionId: e.transaction_id ?? null,
    })),
  ]);
}

/** How many problems were recorded but not kept (a step keeps only its first 200). */
export const problemsNotShown = (run: JournalRunDetail): number =>
  run.steps.reduce((n, s) => n + Math.max(0, (s.errors_total ?? 0) - (s.errors?.length ?? 0)), 0);
