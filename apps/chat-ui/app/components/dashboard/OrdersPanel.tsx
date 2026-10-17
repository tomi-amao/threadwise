import { Chip, type ChipTone } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { Panel, PanelLink } from '~/components/ui/panel';
import type { RecentOrder } from '~/types/dashboard';
import { money, shortDate, titleCase } from './format';

// Amber (active) is for orders still in flight; delivered is quiet; refunds use plum; problems
// are never amber. Unknown statuses fall back to a plain chip.
const STATUS_TONE: Record<string, ChipTone> = {
  delivered: 'done',
  confirmed: 'active',
  paid: 'active',
  processing: 'active',
  shipped: 'active',
  pending: 'draft',
  cancelled: 'draft',
  refunded: 'planned',
  partially_refunded: 'planned',
};

export function OrdersPanel({ orders, currency }: { orders: RecentOrder[]; currency: string }) {
  return (
    <Panel
      testId="panel-orders"
      className="md:col-span-2 xl:col-span-8"
      flush
      title="Latest orders"
      note="The last ten, newest first."
      action={<PanelLink to="/orders">All orders</PanelLink>}
    >
      {orders.length === 0 ? (
        <p className="px-6 pb-6 pt-2 text-center text-sm text-muted-foreground">
          No recent orders.
        </p>
      ) : (
        <DataTable bare dense label="Most recent orders">
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Status</th>
              <th className="text-right">Amount</th>
              <th className="hidden text-right sm:table-cell">Date</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.id}>
                <td className="font-mono text-[13px]">{o.orderNumber || o.id.slice(0, 8)}</td>
                <td className="max-w-[200px] truncate">
                  {o.customerName || o.customerEmail || '—'}
                </td>
                <td>
                  <Chip tone={STATUS_TONE[o.status] ?? 'plain'} dot>
                    {titleCase(o.status)}
                  </Chip>
                </td>
                <td className="text-right tabular-nums">
                  {money(o.grandTotal, o.currency || currency, 2)}
                </td>
                <td className="hidden text-right font-mono text-[13px] text-text-2 sm:table-cell">
                  {shortDate(o.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Panel>
  );
}
