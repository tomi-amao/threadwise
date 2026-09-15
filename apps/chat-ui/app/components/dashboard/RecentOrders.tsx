import { Link } from 'react-router';
import { ArrowSquareOut } from 'phosphor-react';
import type { RecentOrder } from '~/types/dashboard';

interface RecentOrdersProps {
  orders: RecentOrder[];
  currency?: string;
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

const formatDate = (dateStr: string) => {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const statusColors: Record<string, string> = {
  delivered: 'bg-emerald-500/10 text-emerald-500',
  paid: 'bg-emerald-500/10 text-emerald-500',
  pending: 'bg-amber-500/10 text-amber-500',
  processing: 'bg-blue-500/10 text-blue-500',
  shipped: 'bg-blue-500/10 text-blue-500',
  cancelled: 'bg-neutral-500/10 text-neutral-400',
  refunded: 'bg-rose-500/10 text-rose-500',
  partially_refunded: 'bg-orange-500/10 text-orange-500',
};

function StatusBadge({ status }: { status: string }) {
  const colorClass = statusColors[status] || 'bg-muted text-muted-foreground';
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ${colorClass}`}>
      {label}
    </span>
  );
}

export function RecentOrders({ orders, currency = 'GBP' }: RecentOrdersProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Recent Orders</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Latest 10 orders</p>
        </div>
        <Link
          to="/orders"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        >
          View all <ArrowSquareOut size={12} />
        </Link>
      </div>

      {orders.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">No recent orders</div>
      ) : (
        <div className="overflow-x-auto -mx-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground px-5 py-2">Order</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Customer</th>
                <th className="text-left text-xs font-medium text-muted-foreground px-3 py-2">Status</th>
                <th className="text-right text-xs font-medium text-muted-foreground px-3 py-2">Amount</th>
                <th className="text-right text-xs font-medium text-muted-foreground px-5 py-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr
                  key={order.id}
                  className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <td className="px-5 py-2.5">
                    <span className="font-mono text-xs text-foreground">
                      {order.orderNumber || order.id.slice(0, 8)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-foreground truncate max-w-[180px]">
                        {order.customerName || order.customerEmail || '—'}
                      </p>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium text-foreground whitespace-nowrap">
                    {formatCurrency(order.grandTotal, order.currency || currency)}
                  </td>
                  <td className="px-5 py-2.5 text-right text-muted-foreground text-xs whitespace-nowrap">
                    {formatDate(order.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
