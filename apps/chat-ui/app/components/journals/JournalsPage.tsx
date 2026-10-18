/**
 * JournalsPage
 *
 * The books themselves: every journal, where it came from, and what is waiting for a person.
 * The ledger tab is the record (search it, filter it, open any entry to see its lines). The
 * Needs review tab is the work: journals the system could not finish. The tiles say how the
 * books stand; tab, filters and the open journal live in the URL.
 */

import { MagnifyingGlass, Plus, X } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { DateRangePicker } from '~/components/ui/date-range-picker';
import { EmptyState } from '~/components/ui/empty-state';
import { Input } from '~/components/ui/input';
import { JumpTo } from '~/components/ui/jump-to';
import { KpiTile } from '~/components/ui/kpi-tile';
import { NativeSelect } from '~/components/ui/native-select';
import { CompactHeader } from '~/components/ui/page-header';
import { Pager } from '~/components/ui/pager';
import { Segmented } from '~/components/ui/segmented';
import { Tabs, tabId } from '~/components/ui/tabs';
import type { JournalDetail, JournalsData } from '~/lib/api/journals.server';
import { useListUrlState } from '~/lib/use-list-url-state';
import { JournalDrawer } from './JournalDrawer';
import { NewJournalDrawer } from './NewJournalDrawer';
import { ReviewTab } from './ReviewTab';
import {
  STATUS,
  applyFilters,
  int,
  isTab,
  money,
  shortDate,
  sourceLabel,
  summarise,
  typeLabel,
  type SourceFilter,
  type StatusFilter,
  type Tab,
} from './model';

const PAGE_SIZE = 50;

export function JournalsPage({
  data,
  detail,
  fiscalYearEnd,
}: {
  data: JournalsData;
  detail: JournalDetail | null;
  fiscalYearEnd: { day: number; month: number };
}) {
  const { sp, set, q, page, searchText, setSearchText } = useListUrlState();
  const summary = summarise(data.journals);

  const rawTab = sp.get('tab');
  const tab: Tab = isTab(rawTab) ? rawTab : summary.drafts > 0 ? 'review' : 'ledger';
  const status = (
    ['posted', 'reversed'].includes(sp.get('status') ?? '') ? sp.get('status') : 'all'
  ) as StatusFilter;
  const source = (
    ['manual', 'auto'].includes(sp.get('source') ?? '') ? sp.get('source') : 'all'
  ) as SourceFilter;
  const type = sp.get('type') ?? 'all';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const openId = sp.get('journal');
  const creating = sp.get('new') === '1';

  const rows = applyFilters(data.journals, { q, status, source, type, from, to });
  const drafts = data.journals.filter(j => j.status === 'draft');
  const types = [...new Set(data.journals.map(j => j.type))].sort();
  const filtered =
    q !== '' || status !== 'all' || source !== 'all' || type !== 'all' || !!from || !!to;
  const clear = () =>
    set({ q: null, status: null, source: null, type: null, from: null, to: null });

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const ledgerCount = data.journals.length - drafts.length;

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Journals"
        title={
          <>
            Every entry, <em>and where it came from.</em>
          </>
        }
        description="The double-entry record behind every report. Open any entry to see its lines."
        actions={
          <Button onClick={() => set({ new: '1' })}>
            <Plus size={16} weight="bold" aria-hidden /> New journal
          </Button>
        }
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Posted"
            value={int(summary.posted)}
            caption={summary.latest ? `latest ${shortDate(summary.latest)}` : 'nothing posted yet'}
          />
          <KpiTile
            label="Needs review"
            tone={summary.drafts > 0 ? 'negative' : 'default'}
            value={int(summary.drafts)}
            caption={summary.drafts === 0 ? 'all accounted for' : 'drafts in no total yet'}
          />
          <KpiTile
            label="Entered by hand"
            value={int(summary.manual)}
            caption="manual journals, posted"
          />
          <KpiTile
            label="Reversed"
            value={int(summary.reversed)}
            caption="kept for the record, not counted"
          />
        </div>

        <JumpTo
          items={[
            {
              key: 'review',
              count: summary.drafts,
              label: 'to review',
              severe: true,
              onSelect: () => set({ tab: 'review' }),
            },
          ]}
        />

        <Tabs
          tabs={[
            { id: 'ledger', label: 'Ledger', count: int(ledgerCount) },
            { id: 'review', label: 'Needs review', count: int(drafts.length) },
          ]}
          value={tab}
          onChange={id => set({ tab: id })}
        />

        {tab === 'ledger' && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-[280px]">
              <MagnifyingGlass
                size={16}
                weight="light"
                aria-hidden
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                placeholder="Search description or account"
                aria-label="Search journals"
                className="rounded-full pl-10"
              />
            </div>
            <DateRangePicker
              from={from}
              to={to}
              onApply={(f, t) => set({ from: f || null, to: t || null })}
              fiscalYearEnd={fiscalYearEnd}
              className="h-10 rounded-full border-border-strong bg-card px-4 text-[15px] font-normal hover:bg-card hover:border-ring"
            />
            <Segmented<StatusFilter>
              label="Status"
              value={status}
              onChange={v => set({ status: v === 'all' ? null : v })}
              options={[
                { value: 'all', label: 'All' },
                { value: 'posted', label: 'Posted' },
                { value: 'reversed', label: 'Reversed' },
              ]}
            />
            <Segmented<SourceFilter>
              label="Source"
              value={source}
              onChange={v => set({ source: v === 'all' ? null : v })}
              options={[
                { value: 'all', label: 'Any source' },
                { value: 'manual', label: 'By hand' },
                { value: 'auto', label: 'Automatic' },
              ]}
            />
            <NativeSelect
              aria-label="Type"
              value={type}
              onChange={e => set({ type: e.target.value === 'all' ? null : e.target.value })}
            >
              <option value="all">All types</option>
              {types.map(t => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </NativeSelect>
            {filtered && (
              <button
                type="button"
                onClick={clear}
                className="inline-flex items-center gap-1 rounded-sm text-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={12} aria-hidden /> Clear filters
              </button>
            )}
          </div>
        )}

        <div
          role="tabpanel"
          aria-labelledby={tabId(tab)}
          className="overflow-hidden rounded-2xl border bg-row"
        >
          {tab === 'review' ? (
            <ReviewTab
              drafts={drafts}
              accounts={data.accounts}
              fallbackAccountId={data.fallbackAccountId}
              onOpen={id => set({ journal: id })}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title={filtered ? 'Nothing matches.' : 'No journals yet.'}
              description={
                filtered
                  ? 'No journals match these filters.'
                  : 'Journals appear here as orders, payments and bank lines are recorded.'
              }
              action={
                filtered && (
                  <Button variant="outline" size="sm" onClick={clear}>
                    Clear filters
                  </Button>
                )
              }
            />
          ) : (
            <>
              <DataTable label="Journals" bare surface="page">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="hidden md:table-cell">Source</th>
                    <th>Status</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(j => (
                    <tr
                      key={j.id}
                      onClick={() => set({ journal: j.id })}
                      className={`cursor-pointer ${j.id === openId ? '[&_td]:bg-accent' : ''}`}
                    >
                      <td className="whitespace-nowrap text-text-2">{shortDate(j.date)}</td>
                      <td>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            set({ journal: j.id });
                          }}
                          className="block max-w-[380px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="block truncate">
                            {j.description || typeLabel(j.type)}
                          </span>
                          <span className="block truncate text-[13px] text-text-2">
                            {typeLabel(j.type)}, {j.lineCount}{' '}
                            {j.lineCount === 1 ? 'line' : 'lines'}
                          </span>
                        </button>
                      </td>
                      <td className="hidden text-[14px] text-text-2 md:table-cell">
                        {sourceLabel(j.sourceType)}
                      </td>
                      <td>
                        <Chip tone={STATUS[j.status].tone} dot>
                          {STATUS[j.status].label}
                        </Chip>
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums">
                        {money(j.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              <Pager
                page={current}
                pageSize={PAGE_SIZE}
                total={rows.length}
                onPage={n => set({ page: n <= 1 ? null : String(n) })}
              />
            </>
          )}
        </div>
      </div>

      <JournalDrawer detail={detail} open={!!openId} onClose={() => set({ journal: null })} />
      <NewJournalDrawer
        accounts={data.accounts}
        open={creating}
        onClose={() => set({ new: null })}
      />
    </div>
  );
}
