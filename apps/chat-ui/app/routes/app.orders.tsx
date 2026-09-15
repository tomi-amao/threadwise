/**
 * Orders Route (Protected)
 *
 * Full orders list with filtering, search, and status breakdown.
 */

import { useState } from 'react';
import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, Link } from 'react-router';
import { CaretLeft, MagnifyingGlass, Funnel } from 'phosphor-react';
import { getServerSupabaseClient } from '~/lib/supabase';

export const meta: MetaFunction = () => [
  { title: 'Orders - ThreadWise' },
  { name: 'description', content: 'Browse and manage orders' },
];

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  grand_total_amount: number;
  refunded_total_amount: number;
  currency: string;
  created_at: string;
  customer_email: string | null;
  customers: { first_name: string | null; last_name: string | null }[] | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const supabase = getServerSupabaseClient();
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status') || 'all';
  const searchQuery = url.searchParams.get('q') || '';

  let query = supabase
    .from('orders')
    .select(
      'id, order_number, status, grand_total_amount, refunded_total_amount, currency, created_at, customer_email, customers(first_name, last_name)'
    )
    .order('created_at', { ascending: false })
    .limit(100);

  if (statusFilter !== 'all') {
    query = query.eq('status', statusFilter);
  }
  if (searchQuery) {
    query = query.or(
      `order_number.ilike.%${searchQuery}%,customer_email.ilike.%${searchQuery}%`
    );
  }

  const [ordersRes, statusCountsRes] = await Promise.all([
    query,
    supabase.from('orders').select('status'),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const o of statusCountsRes.data || []) {
    const s = (o as any).status || 'unknown';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  return {
    orders: (ordersRes.data || []) as OrderRow[],
    statusCounts,
    totalCount: (statusCountsRes.data || []).length,
    currentStatus: statusFilter,
    searchQuery,
  };
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value);

const formatDate = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

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

export default function OrdersPage() {
  const { orders, statusCounts, totalCount, currentStatus, searchQuery } =
    useLoaderData<typeof loader>();
  const [search, setSearch] = useState(searchQuery);

  const statuses = ['all', ...Object.keys(statusCounts).sort()];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/95 backdrop-blur-sm sticky top-0 z-40">
        <div className="px-4 md:px-6 lg:px-8 py-4">
          <div className="flex items-center gap-3">
            <Link
              to="/dashboard"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <CaretLeft size={20} />
            </Link>
            <div>
              <h1 className="text-xl font-bold text-foreground">Orders</h1>
              <p className="text-xs text-muted-foreground">
                {totalCount.toLocaleString()} total orders
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 md:px-6 lg:px-8 py-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <form method="get" className="flex-1 relative">
            <input type="hidden" name="status" value={currentStatus} />
            <MagnifyingGlass
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              name="q"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by order # or email..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border border-border bg-card text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </form>
          <div className="flex gap-1.5 overflow-x-auto">
            {statuses.map((s) => {
              const count = s === 'all' ? totalCount : statusCounts[s] || 0;
              const label = s === 'all' ? 'All' : s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
              return (
                <Link
                  key={s}
                  to={`/orders?status=${s}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    currentStatus === s
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label} ({count})
                </Link>
              );
            })}
          </div>
        </div>

        {/* Orders Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left text-xs font-medium text-muted-foreground px-5 py-3">
                    Order
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">
                    Customer
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">
                    Status
                  </th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-3 py-3">
                    Amount
                  </th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-3 py-3">
                    Refunded
                  </th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-5 py-3">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-12 text-muted-foreground">
                      No orders found
                    </td>
                  </tr>
                ) : (
                  orders.map((order) => {
                    const custName = order.customers && order.customers.length > 0
                      ? [order.customers[0].first_name, order.customers[0].last_name]
                          .filter(Boolean)
                          .join(' ')
                      : null;
                    const colorClass = statusColors[order.status] || 'bg-muted text-muted-foreground';
                    const statusLabel = order.status
                      .replace(/_/g, ' ')
                      .replace(/\b\w/g, (c) => c.toUpperCase());

                    return (
                      <tr
                        key={order.id}
                        className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-5 py-3">
                          <span className="font-mono text-xs text-foreground">
                            {order.order_number || order.id.slice(0, 8)}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <p className="text-foreground truncate max-w-[200px]">
                            {custName || order.customer_email || '—'}
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ${colorClass}`}
                          >
                            {statusLabel}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right font-medium text-foreground whitespace-nowrap">
                          {formatCurrency(order.grand_total_amount, order.currency || 'GBP')}
                        </td>
                        <td className="px-3 py-3 text-right text-muted-foreground whitespace-nowrap">
                          {order.refunded_total_amount > 0
                            ? formatCurrency(
                                order.refunded_total_amount,
                                order.currency || 'GBP'
                              )
                            : '—'}
                        </td>
                        <td className="px-5 py-3 text-right text-muted-foreground text-xs whitespace-nowrap">
                          {formatDate(order.created_at)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
