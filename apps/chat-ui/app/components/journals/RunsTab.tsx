/** RunsTab: every journal generation run, newest first. Opening one shows what it did. */

import { Link } from 'react-router';
import { buttonVariants } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { Pager } from '~/components/ui/pager';
import type { JournalRun } from '~/lib/api/journal-runs.server';
import { int, money } from './model';
import { runNow, runResult, runWhen, scopeLabel, type RunNow } from './runs';

const PAGE_SIZE = 25;

export function RunsTab({
  runs,
  now,
  byRun,
  openId,
  page,
  onOpen,
  onPage,
}: {
  runs: JournalRun[];
  now: number;
  byRun: Map<string, RunNow>;
  openId: string | null;
  page: number;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
}) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs yet."
        description="Each time journals are generated, the run is recorded here: what it created, what it skipped and what went wrong. Runs from before this was added are not listed."
        action={
          <Link
            to="/journals?tab=runs&generate=1"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Generate journals
          </Link>
        }
      />
    );
  }

  const pages = Math.max(1, Math.ceil(runs.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = runs.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <>
      <DataTable label="Journal generation runs" bare surface="page">
        <thead>
          <tr>
            <th>When</th>
            <th className="hidden sm:table-cell">Scope</th>
            <th>Result</th>
            <th className="text-right">Created</th>
            <th className="hidden text-right md:table-cell">Value</th>
            <th className="hidden text-right sm:table-cell">Still open</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(run => {
            const result = runResult(run, now);
            const live = runNow(byRun, run.id);
            return (
              <tr
                key={run.id}
                onClick={() => onOpen(run.id)}
                className={`cursor-pointer ${run.id === openId ? '[&_td]:bg-accent' : ''}`}
              >
                <td className="whitespace-nowrap">
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      onOpen(run.id);
                    }}
                    className="rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {runWhen(run.createdAt)}
                  </button>
                </td>
                <td className="hidden text-[14px] text-text-2 sm:table-cell">
                  {scopeLabel(run.scope)}
                </td>
                <td>
                  <Chip tone={result.tone} dot>
                    {result.label}
                  </Chip>
                </td>
                <td className="text-right tabular-nums">{int(run.created)}</td>
                <td className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
                  {live.journals.length > 0 ? money(live.value) : '–'}
                </td>
                <td className="hidden text-right tabular-nums text-text-2 sm:table-cell">
                  {live.stillOpen > 0
                    ? `${int(live.stillOpen)} draft${live.stillOpen === 1 ? '' : 's'}`
                    : '–'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
      <Pager page={current} pageSize={PAGE_SIZE} total={runs.length} onPage={onPage} />
    </>
  );
}
