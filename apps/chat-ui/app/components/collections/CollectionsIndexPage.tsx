/**
 * CollectionsIndexPage
 *
 * What each drop earned and what it cost, one row per collection. The numbers across the top are
 * the whole portfolio; the list is the way in to a single collection. Search, status filter and
 * sort live in the URL, so a view can be shared or come back after a refresh.
 */

import { ArrowRight, MagnifyingGlass, Plus, X } from 'phosphor-react';
import { useNavigate } from 'react-router';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { Input } from '~/components/ui/input';
import { Meter } from '~/components/ui/meter';
import { Hero } from '~/components/ui/page-header';
import { Segmented } from '~/components/ui/segmented';
import { Sparkline } from '~/components/ui/sparkline';
import { Stat, StatStrip } from '~/components/ui/stat-strip';
import type { CollectionsIndex, CollectionStatus } from '~/lib/api/collections.server';
import { useListUrlState } from '~/lib/use-list-url-state';
import { cn } from '~/lib/utils';
import { CollectionDrawer } from './CollectionDrawer';
import { STATUS, int, money, pct, shortDate } from './model';

type Filter = 'all' | CollectionStatus;
type Sort = 'recent' | 'revenue' | 'margin';

const FILTERS: Filter[] = ['all', 'active', 'planned', 'completed', 'draft', 'archived'];

export function CollectionsIndexPage({ data }: { data: CollectionsIndex }) {
  const navigate = useNavigate();
  const { sp, set, q, searchText, setSearchText } = useListUrlState();
  const { summaries, totals } = data;

  const rawFilter = sp.get('status');
  const filter: Filter = FILTERS.includes(rawFilter as Filter) ? (rawFilter as Filter) : 'all';
  const rawSort = sp.get('sort');
  const sort: Sort = rawSort === 'revenue' || rawSort === 'margin' ? rawSort : 'recent';
  const creating = sp.get('new') === '1';

  const countOf = (s: CollectionStatus) => summaries.filter(x => x.collection.status === s).length;
  const needle = q.trim().toLowerCase();
  const rows = summaries
    .filter(s => filter === 'all' || s.collection.status === filter)
    .filter(
      s =>
        !needle ||
        [s.collection.name, s.collection.type, s.collection.externalRef, s.collection.status]
          .join(' ')
          .toLowerCase()
          .includes(needle)
    );
  if (sort === 'revenue') rows.sort((a, b) => b.revenue - a.revenue);
  if (sort === 'margin') rows.sort((a, b) => (b.margin ?? -999) - (a.margin ?? -999));

  const filtered = needle !== '' || filter !== 'all';
  const open = (id: string) => navigate(`/collections/${id}`);
  // Statuses with nothing in them are left out of the filter, except the one in use.
  const visibleFilters = FILTERS.filter(
    f => f === 'all' || f === filter || countOf(f as CollectionStatus) > 0
  );

  return (
    <div className="pb-10">
      <Hero
        className="px-4 sm:px-6 lg:px-8"
        eyebrow={`Collections · ${int(summaries.length)} in total`}
        title={
          <>
            What each drop earned, <em>and what it cost.</em>
          </>
        }
        lead="Plan a collection, attach its products and spend, and see profit the moment sales land."
        actions={
          <Button onClick={() => set({ new: '1' })}>
            <Plus size={16} weight="bold" aria-hidden /> New collection
          </Button>
        }
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <StatStrip>
          <Stat
            label="Revenue"
            value={money(totals.revenue)}
            title="Across all collections"
            caption={`${int(totals.units)} units sold`}
          />
          <Stat
            label="Linked costs"
            value={money(totals.cost)}
            title="Attributed spend"
            caption={`${int(totals.costs)} transactions`}
          />
          <Stat
            label="Gross profit"
            tone={totals.profit < 0 ? 'negative' : 'default'}
            value={money(totals.profit)}
            title="Revenue less costs"
            caption={`${pct(totals.margin)} blended margin`}
          />
          <Stat
            label="Live now"
            value={int(totals.active)}
            title="Active collections"
            caption={`${int(totals.products)} products in range`}
          />
        </StatStrip>

        <div className="flex flex-wrap items-center gap-3 pt-2">
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
              placeholder="Search by name, type or reference"
              aria-label="Search collections"
              className="rounded-full pl-10"
            />
          </div>
          <Segmented<Filter>
            label="Status"
            value={filter}
            onChange={v => set({ status: v === 'all' ? null : v })}
            options={visibleFilters.map(f => ({
              value: f,
              label:
                f === 'all'
                  ? `All ${summaries.length}`
                  : `${STATUS[f as CollectionStatus].label} ${countOf(f as CollectionStatus)}`,
            }))}
          />
          <Segmented<Sort>
            label="Sort"
            value={sort}
            onChange={v => set({ sort: v === 'recent' ? null : v })}
            options={[
              { value: 'recent', label: 'Recent' },
              { value: 'revenue', label: 'Revenue' },
              { value: 'margin', label: 'Margin' },
            ]}
          />
          {filtered && (
            <button
              type="button"
              onClick={() => set({ q: null, status: null })}
              className="inline-flex items-center gap-1 rounded-sm text-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={12} aria-hidden /> Clear filters
            </button>
          )}
        </div>

        <div className="overflow-hidden rounded-2xl border bg-row">
          {rows.length === 0 ? (
            <EmptyState
              title={filtered ? 'Nothing matches.' : 'No collections yet.'}
              description={
                filtered
                  ? 'Try a different search, or clear the status filter.'
                  : 'Start one to plan it, attach its products and spend, and see what it earns.'
              }
              action={
                filtered ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => set({ q: null, status: null })}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => set({ new: '1' })}>
                    <Plus size={14} weight="bold" aria-hidden /> New collection
                  </Button>
                )
              }
            />
          ) : (
            <DataTable label="Collections" bare surface="page">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th>Status</th>
                  <th className="hidden text-right md:table-cell">Products</th>
                  <th className="text-right">Revenue</th>
                  <th className="hidden text-right md:table-cell">Costs</th>
                  <th className="hidden md:table-cell">Trend</th>
                  <th>Margin</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(s => (
                  <tr
                    key={s.collection.id}
                    onClick={() => open(s.collection.id)}
                    className="cursor-pointer"
                  >
                    <td>
                      <a
                        href={`/collections/${s.collection.id}`}
                        onClick={e => {
                          e.preventDefault();
                          e.stopPropagation();
                          open(s.collection.id);
                        }}
                        className="block max-w-[320px] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="block truncate font-medium">{s.collection.name}</span>
                        <span className="block truncate font-mono text-xs uppercase tracking-[0.04em] text-text-2">
                          {s.collection.type || 'Collection'} ·{' '}
                          {s.collection.launchDate
                            ? `Launch ${shortDate(s.collection.launchDate)}`
                            : 'No launch date'}
                        </span>
                      </a>
                    </td>
                    <td>
                      <Chip tone={STATUS[s.collection.status].tone} dot>
                        {STATUS[s.collection.status].label}
                      </Chip>
                    </td>
                    <td className="hidden text-right tabular-nums text-text-2 md:table-cell">
                      {s.productCount || '–'}
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {s.revenue ? (
                        money(s.revenue)
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap text-right tabular-nums text-text-2 md:table-cell">
                      {s.cost ? money(s.cost) : <span className="text-muted-foreground">–</span>}
                    </td>
                    <td className="hidden md:table-cell">
                      <Sparkline data={s.trend} />
                    </td>
                    <td className="min-w-[96px]">
                      {s.margin == null ? (
                        <span className="text-muted-foreground">–</span>
                      ) : (
                        <div className="grid gap-1.5">
                          <span
                            className={cn(
                              'font-mono text-[14px] tabular-nums',
                              s.margin < 0 && 'text-destructive'
                            )}
                          >
                            {pct(s.margin)}
                          </span>
                          <Meter value={Math.max(s.margin, 0) / 100} over={s.margin < 0} />
                        </div>
                      )}
                    </td>
                    <td className="w-8 text-text-2">
                      <ArrowRight size={16} weight="light" aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </div>
      </div>

      <CollectionDrawer open={creating} onClose={() => set({ new: null })} />
    </div>
  );
}
