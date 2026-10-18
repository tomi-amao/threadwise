/**
 * ProductsPage
 *
 * What sells and what does not. Every product in the catalogue is listed, including the ones
 * that have never sold, and the tabs say where each stands: selling, slowing, never sold.
 * Revenue share is of the whole range, not of the current filter. Tab, sort, search and the
 * open product live in the URL.
 */

import { useMemo } from 'react';
import { MagnifyingGlass, Package, X } from 'phosphor-react';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { Input } from '~/components/ui/input';
import { JumpTo } from '~/components/ui/jump-to';
import { KpiTile } from '~/components/ui/kpi-tile';
import { Meter } from '~/components/ui/meter';
import { CompactHeader } from '~/components/ui/page-header';
import { Pager } from '~/components/ui/pager';
import { Segmented } from '~/components/ui/segmented';
import { Tabs, tabId } from '~/components/ui/tabs';
import type { ProductRow } from '~/lib/api/products.server';
import { useListUrlState } from '~/lib/use-list-url-state';
import { cn } from '~/lib/utils';
import { ProductDrawer } from './ProductDrawer';
import {
  SORTS,
  STAGE,
  TABS,
  ago,
  inTab,
  int,
  isSort,
  isTab,
  matchesSearch,
  money,
  sorter,
  stageOf,
  summarise,
  type Sort,
  type Tab,
} from './model';

const PAGE_SIZE = 50;

export function ProductsPage({
  products,
  today,
  currency,
}: {
  products: ProductRow[];
  today: string;
  currency: string;
}) {
  const { sp, set, q, page, searchText, setSearchText } = useListUrlState();

  const rawTab = sp.get('tab');
  const tab: Tab = isTab(rawTab) ? rawTab : 'all';
  const rawSort = sp.get('sort');
  const sort: Sort = isSort(rawSort) ? rawSort : 'revenue';
  const openId = sp.get('product');

  const summary = useMemo(() => summarise(products), [products]);
  const counts = useMemo(
    () =>
      Object.fromEntries(TABS.map(t => [t.id, products.filter(p => inTab(p, t.id, today)).length])),
    [products, today]
  );
  const rows = useMemo(
    () => products.filter(p => inTab(p, tab, today) && matchesSearch(p, q)).sort(sorter(sort)),
    [products, tab, today, q, sort]
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE)));
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const open = products.find(p => p.id !== null && p.id === openId) ?? null;
  const topRevenue = summary.top?.revenue ?? 0;
  const filtered = q !== '';

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Products"
        title={
          <>
            What sells, <em>and what doesn&rsquo;t.</em>
          </>
        }
        description="Revenue and units for every product, including the ones that have never sold."
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Products"
            value={int(summary.count)}
            caption={`${int(counts.selling)} selling`}
          />
          <KpiTile label="Units sold" value={int(summary.units)} caption="across all products" />
          <KpiTile
            label="Revenue"
            tone="income"
            value={money(summary.revenue, currency)}
            caption="before refunds, excluding cancelled"
          />
          <KpiTile
            label="Best seller"
            value={summary.top?.name ?? '—'}
            caption={
              summary.top
                ? `${money(summary.top.revenue, currency)} · ${Math.round((summary.top.revenue / summary.revenue) * 100)}% of revenue`
                : 'nothing sold yet'
            }
          />
        </div>

        <JumpTo
          items={[
            {
              key: 'slowing',
              count: counts.slowing,
              label: 'slowing',
              onSelect: () => set({ tab: 'slowing', q: null }),
            },
            {
              key: 'never',
              count: counts.never,
              label: 'never sold',
              onSelect: () => set({ tab: 'never', q: null }),
            },
          ]}
        />

        <Tabs
          tabs={TABS.map(t => ({ id: t.id, label: t.label, count: int(counts[t.id]) }))}
          value={tab}
          onChange={id => set({ tab: id === 'all' ? null : id })}
        />

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
              placeholder="Search products"
              aria-label="Search products"
              className="rounded-full pl-10"
            />
          </div>
          <Segmented<Sort>
            label="Sort by"
            value={sort}
            onChange={v => set({ sort: v === 'revenue' ? null : v })}
            options={SORTS}
          />
          {filtered && (
            <button
              type="button"
              onClick={() => set({ q: null })}
              className="inline-flex items-center gap-1 rounded-sm text-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={12} aria-hidden /> Clear search
            </button>
          )}
        </div>

        <div
          role="tabpanel"
          aria-labelledby={tabId(tab)}
          className="overflow-hidden rounded-2xl border bg-row"
        >
          {rows.length === 0 ? (
            <EmptyState
              title={filtered ? 'Nothing matches.' : 'No products here.'}
              description={
                filtered
                  ? 'No products match this search.'
                  : tab === 'never'
                    ? 'Everything in your catalogue has sold at least once.'
                    : 'Products appear here as your shop sync brings them in.'
              }
            />
          ) : (
            <DataTable label="Products" bare surface="page">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Units</th>
                  <th className="hidden text-right md:table-cell">Orders</th>
                  <th className="hidden text-right lg:table-cell">Avg price</th>
                  <th className="text-right">Revenue</th>
                  <th className="hidden w-40 lg:table-cell">Share</th>
                  <th className="hidden md:table-cell">Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(p => {
                  const stage = STAGE[stageOf(p, today)];
                  const clickable = p.id !== null;
                  return (
                    <tr
                      key={p.id ?? p.name}
                      onClick={clickable ? () => set({ product: p.id }) : undefined}
                      className={cn(
                        clickable && 'cursor-pointer',
                        p.id === openId && '[&_td]:bg-accent'
                      )}
                    >
                      <td>
                        <div className="flex items-center gap-3">
                          {p.thumbnail_url ? (
                            <img
                              src={p.thumbnail_url}
                              alt=""
                              className="size-9 shrink-0 rounded-lg object-cover"
                              onError={e => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-text-2">
                              <Package size={16} weight="light" aria-hidden />
                            </span>
                          )}
                          {clickable ? (
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                set({ product: p.id });
                              }}
                              className="block max-w-[260px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <span className="block truncate">{p.name}</span>
                              <span className="block truncate font-mono text-xs text-text-2">
                                {p.variant_count} {p.variant_count === 1 ? 'variant' : 'variants'}
                              </span>
                            </button>
                          ) : (
                            <span className="block max-w-[260px]">
                              <span className="block truncate">{p.name}</span>
                              <span className="block truncate font-mono text-xs text-text-2">
                                Not in your catalogue
                              </span>
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="text-right tabular-nums">{int(p.units)}</td>
                      <td className="hidden text-right tabular-nums text-text-2 md:table-cell">
                        {int(p.orders)}
                      </td>
                      <td className="hidden whitespace-nowrap text-right tabular-nums text-text-2 lg:table-cell">
                        {p.units > 0 ? money(p.average_price, currency, 2) : '—'}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums">
                        {money(p.revenue, currency)}
                      </td>
                      <td className="hidden lg:table-cell">
                        <div className="flex items-center gap-2">
                          <Meter
                            value={topRevenue > 0 ? p.revenue / topRevenue : 0}
                            className="flex-1"
                          />
                          <span className="w-10 text-right font-mono text-xs text-text-2">
                            {summary.revenue > 0
                              ? `${((p.revenue / summary.revenue) * 100).toFixed(1)}%`
                              : '—'}
                          </span>
                        </div>
                      </td>
                      <td className="hidden md:table-cell">
                        <Chip
                          tone={stage.tone}
                          dot
                          title={
                            p.last_sold_at ? `Last sold ${ago(p.last_sold_at, today)}` : undefined
                          }
                        >
                          {stage.label}
                        </Chip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
          <Pager
            page={current}
            pageSize={PAGE_SIZE}
            total={rows.length}
            onPage={n => set({ page: n <= 1 ? null : String(n) })}
          />
        </div>
      </div>

      <ProductDrawer row={open} today={today} onClose={() => set({ product: null })} />
    </div>
  );
}
