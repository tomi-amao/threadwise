/**
 * OrdersPage
 *
 * What has been sold and where each order stands. The tabs are the stages an order moves
 * through (to fulfil, on the way, delivered) and the tiles describe whatever is on screen, so
 * "Sales" next to "Delivered" is the sales of delivered orders. Tab, dates, search and the open
 * order live in the URL.
 */

import { useMemo } from 'react';
import { MagnifyingGlass, X } from 'phosphor-react';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { DateRangePicker } from '~/components/ui/date-range-picker';
import { EmptyState } from '~/components/ui/empty-state';
import { Input } from '~/components/ui/input';
import { KpiTile } from '~/components/ui/kpi-tile';
import { CompactHeader } from '~/components/ui/page-header';
import { Pager } from '~/components/ui/pager';
import { Tabs, tabId } from '~/components/ui/tabs';
import type { OrderRow } from '~/lib/api/orders.server';
import { useListUrlState } from '~/lib/use-list-url-state';
import { cn } from '~/lib/utils';
import { OrderDrawer } from './OrderDrawer';
import {
  TABS,
  customerLabel,
  dayOf,
  inTab,
  int,
  isTab,
  matchesSearch,
  money,
  shortDate,
  statusOf,
  summarise,
  type Tab,
} from './model';

const PAGE_SIZE = 50;

export function OrdersPage({ orders, currency }: { orders: OrderRow[]; currency: string }) {
  const { sp, set, q, page, searchText, setSearchText } = useListUrlState();

  const rawTab = sp.get('tab');
  const tab: Tab = isTab(rawTab) ? rawTab : orders.some(o => inTab(o, 'fulfil')) ? 'fulfil' : 'all';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const openId = sp.get('order');

  const inRange = useMemo(
    () => (o: OrderRow) =>
      (!from || dayOf(o.created_at) >= from) && (!to || dayOf(o.created_at) <= to),
    [from, to]
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        TABS.map(t => [t.id, orders.filter(o => inTab(o, t.id) && inRange(o)).length])
      ),
    [orders, inRange]
  );
  const rows = useMemo(
    () => orders.filter(o => inTab(o, tab) && inRange(o) && matchesSearch(o, q)),
    [orders, tab, inRange, q]
  );
  const summary = useMemo(() => summarise(rows), [rows]);
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE)));
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const filtered = q !== '' || from !== '' || to !== '';

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Orders"
        title={
          <>
            Every order, <em>and where it stands.</em>
          </>
        }
        description="What was bought, what it came to, and what still needs sending."
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Orders"
            value={int(summary.count)}
            caption={filtered ? 'match your filters' : (TABS.find(t => t.id === tab)?.label ?? '')}
          />
          <KpiTile
            label="Sales"
            tone="income"
            value={money(summary.sales, currency, 0)}
            caption="after refunds, excluding cancelled"
          />
          <KpiTile
            label="Average order"
            value={money(summary.average, currency, 2)}
            caption="of orders not cancelled"
          />
          <KpiTile
            label="Refunded"
            tone={summary.refunded > 0 ? 'negative' : 'default'}
            value={money(summary.refunded, currency, 0)}
            caption={
              summary.refundedCount === 0
                ? 'no refunds'
                : `${int(summary.refundedCount)} ${summary.refundedCount === 1 ? 'order' : 'orders'}`
            }
          />
        </div>

        <Tabs
          tabs={TABS.map(t => ({ id: t.id, label: t.label, count: int(counts[t.id]) }))}
          value={tab}
          onChange={id => set({ tab: id })}
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
              placeholder="Search order or customer"
              aria-label="Search orders"
              className="rounded-full pl-10"
            />
          </div>
          <DateRangePicker
            from={from}
            to={to}
            onApply={(f, t) => set({ from: f || null, to: t || null })}
            className="h-10 rounded-full border-border-strong bg-card px-4 text-[15px] font-normal hover:bg-card hover:border-ring"
          />
          {filtered && (
            <button
              type="button"
              onClick={() => set({ q: null, from: null, to: null })}
              className="inline-flex items-center gap-1 rounded-sm text-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={12} aria-hidden /> Clear filters
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
              title={filtered ? 'Nothing matches.' : 'No orders here.'}
              description={
                filtered
                  ? 'No orders match these filters.'
                  : tab === 'fulfil'
                    ? 'Everything has been sent.'
                    : 'Orders appear here as your shop sync brings them in.'
              }
            />
          ) : (
            <DataTable label="Orders" bare surface="page">
              <thead>
                <tr>
                  <th>Order</th>
                  <th className="hidden md:table-cell">Date</th>
                  <th>Status</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(o => {
                  const status = statusOf(o.status);
                  return (
                    <tr
                      key={o.id}
                      onClick={() => set({ order: o.id })}
                      className={cn('cursor-pointer', o.id === openId && '[&_td]:bg-accent')}
                    >
                      <td>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            set({ order: o.id });
                          }}
                          className="block max-w-[300px] rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="block truncate">{customerLabel(o)}</span>
                          <span className="block truncate font-mono text-xs text-text-2">
                            {o.order_number}
                          </span>
                        </button>
                      </td>
                      <td className="hidden whitespace-nowrap text-text-2 md:table-cell">
                        {shortDate(o.created_at)}
                      </td>
                      <td>
                        <Chip tone={status.tone} dot>
                          {status.label}
                        </Chip>
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums">
                        {money(o.grand_total, o.currency)}
                        {o.refunded_total > 0 && (
                          <span className="block font-mono text-xs text-destructive">
                            −{money(o.refunded_total, o.currency)} refunded
                          </span>
                        )}
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

      <OrderDrawer orderId={openId} onClose={() => set({ order: null })} />
    </div>
  );
}
