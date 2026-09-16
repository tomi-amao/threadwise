/**
 * Customers Route (Protected)
 *
 * Customer analytics with lifetime value and purchase history.
 */

import { useState } from 'react';
import type { MetaFunction, LoaderFunctionArgs } from 'react-router';
import { useLoaderData, Link } from 'react-router';
import { CaretLeft, MagnifyingGlass, UserCircle, Crown } from 'phosphor-react';
import { getServerSupabaseClient } from '~/lib/supabase';

export const meta: MetaFunction = () => [
  { title: 'Customers - ThreadWise' },
  { name: 'description', content: 'Customer analytics and lifetime value' },
];

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  orderCount: number;
  totalSpent: number;
  lastOrderDate: string | null;
  isRepeat: boolean;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const supabase = getServerSupabaseClient();
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get('q') || '';
  const filter = url.searchParams.get('filter') || 'all';

  const { data: orders } = await supabase
    .from('orders')
    .select(
      'customer_id, grand_total_amount, created_at, customer_email, status, customers(id, first_name, last_name, email)'
    )
    .neq('status', 'cancelled');

  const customerMap = new Map<
    string,
    {
      id: string;
      name: string;
      email: string | null;
      orderCount: number;
      totalSpent: number;
      lastOrderDate: string | null;
    }
  >();

  for (const order of orders || []) {
    const custId = (order as any).customer_id;
    if (!custId) continue;
    const cust = (order as any).customers;
    const existing = customerMap.get(custId) || {
      id: custId,
      name: cust
        ? [cust.first_name, cust.last_name].filter(Boolean).join(' ')
        : (order as any).customer_email || 'Unknown',
      email: cust?.email || (order as any).customer_email || null,
      orderCount: 0,
      totalSpent: 0,
      lastOrderDate: null,
    };
    existing.orderCount += 1;
    existing.totalSpent += Number((order as any).grand_total_amount || 0);
    if (
      !existing.lastOrderDate ||
      ((order as any).created_at && (order as any).created_at > existing.lastOrderDate)
    ) {
      existing.lastOrderDate = (order as any).created_at;
    }
    customerMap.set(custId, existing);
  }

  let customers: CustomerRow[] = Array.from(customerMap.values())
    .map((c) => ({ ...c, isRepeat: c.orderCount > 1 }))
    .sort((a, b) => b.totalSpent - a.totalSpent);

  if (filter === 'repeat') {
    customers = customers.filter((c) => c.isRepeat);
  } else if (filter === 'one-time') {
    customers = customers.filter((c) => !c.isRepeat);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    customers = customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q))
    );
  }

  const totalCustomers = customerMap.size;
  const repeatCustomers = Array.from(customerMap.values()).filter(
    (c) => c.orderCount > 1
  ).length;
  const totalRevenue = Array.from(customerMap.values()).reduce(
    (s, c) => s + c.totalSpent,
    0
  );
  const avgLTV = totalCustomers > 0 ? totalRevenue / totalCustomers : 0;

  return {
    customers,
    stats: {
      total: totalCustomers,
      repeat: repeatCustomers,
      repeatRate: totalCustomers > 0 ? (repeatCustomers / totalCustomers) * 100 : 0,
      avgLTV,
    },
    currentFilter: filter,
    searchQuery,
  };
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

const formatDate = (dateStr: string | null) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

export default function CustomersPage() {
  const { customers, stats, currentFilter, searchQuery } =
    useLoaderData<typeof loader>();
  const [search, setSearch] = useState(searchQuery);

  const filters = [
    { key: 'all', label: 'All', count: stats.total },
    { key: 'repeat', label: 'Repeat', count: stats.repeat },
    { key: 'one-time', label: 'One-time', count: stats.total - stats.repeat },
  ];

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
              <h1 className="text-xl font-bold text-foreground">Customers</h1>
              <p className="text-xs text-muted-foreground">
                {stats.total.toLocaleString()} customers ·{' '}
                {stats.repeatRate.toFixed(1)}% repeat rate ·{' '}
                {formatCurrency(stats.avgLTV)} avg LTV
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 md:px-6 lg:px-8 py-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <form method="get" className="flex-1 relative">
            <input type="hidden" name="filter" value={currentFilter} />
            <MagnifyingGlass
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              name="q"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or email..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border border-border bg-card text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </form>
          <div className="flex gap-1.5">
            {filters.map((f) => (
              <Link
                key={f.key}
                to={`/customers?filter=${f.key}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  currentFilter === f.key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label} ({f.count})
              </Link>
            ))}
          </div>
        </div>

        {/* Customers Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left text-xs font-medium text-muted-foreground px-5 py-3 w-8">
                    #
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-3 py-3">
                    Customer
                  </th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-3 py-3">
                    Orders
                  </th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-3 py-3">
                    Total Spent
                  </th>
                  <th className="text-right text-xs font-medium text-muted-foreground px-5 py-3">
                    Last Order
                  </th>
                </tr>
              </thead>
              <tbody>
                {customers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-12 text-muted-foreground">
                      No customers found
                    </td>
                  </tr>
                ) : (
                  customers.map((customer, i) => (
                    <tr
                      key={customer.id}
                      className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-5 py-3 text-muted-foreground text-xs">{i + 1}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                            {customer.isRepeat ? (
                              <Crown size={14} className="text-amber-500" weight="duotone" />
                            ) : (
                              <UserCircle
                                size={14}
                                className="text-muted-foreground"
                                weight="duotone"
                              />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-foreground truncate max-w-[200px]">
                              {customer.name}
                            </p>
                            {customer.email && (
                              <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                {customer.email}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right text-foreground">
                        {customer.orderCount}
                        {customer.isRepeat && (
                          <span className="ml-1.5 text-[10px] text-amber-500 font-medium">
                            REPEAT
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-medium text-foreground">
                        {formatCurrency(customer.totalSpent)}
                      </td>
                      <td className="px-5 py-3 text-right text-muted-foreground text-xs">
                        {formatDate(customer.lastOrderDate)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
