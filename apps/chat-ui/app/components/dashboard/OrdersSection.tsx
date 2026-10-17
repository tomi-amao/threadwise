import { Chip, type ChipTone } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import type { RecentOrder } from '~/types/dashboard';
import { Section, SeeAll } from './Section';
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

export function OrdersSection({ orders, currency }: { orders: RecentOrder[]; currency: string }) {
  return (
    <Section
      eyebrow="Latest orders"
      title={
        <>
          The last ten, <em>newest first.</em>
        </>
      }
      action={<SeeAll to="/orders">All orders</SeeAll>}
    >
      {orders.length === 0 ? (
        <div className="rounded-2xl border bg-card">
          <EmptyState title="No recent orders." />
        </div>
      ) : (
        <DataTable label="Latest orders">
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Status</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Date</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.id}>
                <td className="font-mono text-[13px]">{o.orderNumber || o.id.slice(0, 8)}</td>
                <td>{o.customerName || o.customerEmail || '—'}</td>
                <td>
                  <Chip tone={STATUS_TONE[o.status] ?? 'plain'} dot>
                    {titleCase(o.status)}
                  </Chip>
                </td>
                <td className="text-right tabular-nums">
                  {money(o.grandTotal, o.currency || currency, 2)}
                </td>
                <td className="text-right font-mono text-[13px] text-text-2">
                  {shortDate(o.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}
