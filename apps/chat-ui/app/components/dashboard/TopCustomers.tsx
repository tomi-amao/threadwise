import { Link } from 'react-router';
import { ArrowSquareOut, UserCircle } from 'phosphor-react';
import type { CustomerSummary } from '~/types/dashboard';

interface TopCustomersProps {
  customers: CustomerSummary[];
  currency?: string;
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

export function TopCustomers({ customers, currency = 'GBP' }: TopCustomersProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Top Customers</h3>
          <p className="text-xs text-muted-foreground mt-0.5">By lifetime value</p>
        </div>
        <Link
          to="/customers"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        >
          View all <ArrowSquareOut size={12} />
        </Link>
      </div>

      {customers.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">No customer data</div>
      ) : (
        <div className="space-y-3">
          {customers.slice(0, 8).map((customer, i) => (
            <div key={customer.id} className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-5 text-right font-medium">
                {i + 1}
              </span>
              <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                <UserCircle size={14} className="text-amber-500" weight="duotone" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground truncate">{customer.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {customer.orderCount} order{customer.orderCount !== 1 ? 's' : ''}
                  {customer.email ? ` · ${customer.email}` : ''}
                </p>
              </div>
              <span className="text-sm font-semibold text-foreground whitespace-nowrap">
                {formatCurrency(customer.totalSpent, currency)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
