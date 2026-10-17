/**
 * CustomersPage
 *
 * Who buys from you, and how often. The tabs are segments (repeat buyers, one-time, lapsed,
 * never ordered) and the sort answers the question being asked: who spends most, who orders most,
 * who ordered last. Tab, sort, search and the open customer live in the URL.
 */

import { useMemo } from 'react';
import { MagnifyingGlass, X } from 'phosphor-react';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { Input } from '~/components/ui/input';
import { JumpTo } from '~/components/ui/jump-to';
import { KpiTile } from '~/components/ui/kpi-tile';
import { CompactHeader } from '~/components/ui/page-header';
import { Pager } from '~/components/ui/pager';
import { Segmented } from '~/components/ui/segmented';
import { Tabs, tabId } from '~/components/ui/tabs';
import type { CustomerRow } from '~/lib/api/customers.server';
import { useListUrlState } from '~/lib/use-list-url-state';
import { cn } from '~/lib/utils';
import { CustomerDrawer } from './CustomerDrawer';
import {
  SORTS,
  TABS,
  ago,
  inTab,
  int,
  isSort,
  isTab,
  matchesSearch,
  money,
  segmentOf,
  sorter,
  summarise,
  type Sort,
  type Tab,
} from './model';

const PAGE_SIZE = 50;

export function CustomersPage({
  customers,
  today,
  currency,
}: {
  customers: CustomerRow[];
  today: string;
  currency: string;
}) {
  const { sp, set, q, page, searchText, setSearchText } = useListUrlState();

  const rawTab = sp.get('tab');
  const tab: Tab = isTab(rawTab) ? rawTab : 'all';
  const rawSort = sp.get('sort');
  const sort: Sort = isSort(rawSort) ? rawSort : 'spent';
  const openId = sp.get('customer');

  const summary = useMemo(() => summarise(customers), [customers]);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        TABS.map(t => [t.id, customers.filter(c => inTab(c, t.id, today)).length])
      ),
    [customers, today]
  );
  const rows = useMemo(
    () => customers.filter(c => inTab(c, tab, today) && matchesSearch(c, q)).sort(sorter(sort)),
    [customers, tab, today, q, sort]
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE)));
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const filtered = q !== '';

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Customers"
        title={
          <>
            Who buys from you, <em>and how often.</em>
          </>
        }
        description="Your best customers, who keeps coming back, and who has gone quiet."
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Customers"
            value={int(summary.total)}
            caption={`${int(summary.withOrders)} have ordered`}
          />
          <KpiTile
            label="Repeat rate"
            value={`${Math.round(summary.repeatRate * 100)}%`}
            caption={`${int(summary.repeat)} of ${int(summary.withOrders)} ordered more than once`}
          />
          <KpiTile
            label="Average lifetime value"
            tone="income"
            value={money(summary.averageValue, currency, 0)}
            caption="spend per customer who has ordered"
          />
          <KpiTile
            label="Top customer"
            value={summary.top?.name ?? '—'}
            caption={
              summary.top
                ? `${money(summary.top.spent, currency, 0)} · ${Math.round((summary.top.spent / summary.spent) * 100)}% of sales`
                : 'no orders yet'
            }
          />
        </div>

        <JumpTo
          items={[
            {
              key: 'lapsed',
              count: counts.lapsed,
              label: 'gone quiet',
              onSelect: () => set({ tab: 'lapsed', sort: 'spent', q: null }),
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
              placeholder="Search name or email"
              aria-label="Search customers"
              className="rounded-full pl-10"
            />
          </div>
          <Segmented<Sort>
            label="Sort by"
            value={sort}
            onChange={v => set({ sort: v === 'spent' ? null : v })}
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
              title={filtered ? 'Nothing matches.' : 'No customers here.'}
              description={
                filtered
                  ? 'No customers match this search.'
                  : 'Customers appear here as your shop sync brings them in.'
              }
            />
          ) : (
            <DataTable label="Customers" bare surface="page">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="text-right">Orders</th>
                  <th className="text-right">Spent</th>
                  <th className="hidden text-right md:table-cell">Average</th>
                  <th className="hidden lg:table-cell">Latest order</th>
                  <th>Segment</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(c => {
                  const segment = segmentOf(c, today);
                  return (
                    <tr
                      key={c.id}
                      onClick={() => set({ customer: c.id })}
                      className={cn('cursor-pointer', c.id === openId && '[&_td]:bg-accent')}
                    >
                      <td>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            set({ customer: c.id });
                          }}
                          className="block max-w-[300px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="block truncate">{c.name}</span>
                          <span className="block truncate font-mono text-xs text-text-2">
                            {c.email ?? 'No email'}
                          </span>
                        </button>
                      </td>
                      <td className="text-right tabular-nums">{int(c.orders)}</td>
                      <td className="whitespace-nowrap text-right tabular-nums">
                        {money(c.spent, currency, 0)}
                      </td>
                      <td className="hidden whitespace-nowrap text-right tabular-nums text-text-2 md:table-cell">
                        {c.orders > 0 ? money(c.spent / c.orders, currency, 0) : '—'}
                      </td>
                      <td className="hidden whitespace-nowrap text-text-2 lg:table-cell">
                        {ago(c.last_order_at, today)}
                      </td>
                      <td>
                        <Chip tone={segment.tone} dot>
                          {segment.label}
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

      <CustomerDrawer
        customerId={openId}
        today={today}
        currency={currency}
        onClose={() => set({ customer: null })}
      />
    </div>
  );
}
