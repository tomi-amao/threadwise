import { UsersThree, ArrowsClockwise, UserPlus, ShoppingCart } from 'phosphor-react';
import type { CustomerStats, KPIData } from '~/types/dashboard';

interface CustomerInsightsProps {
  customerStats: CustomerStats;
  kpis: KPIData;
  currency?: string;
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

export function CustomerInsights({ customerStats, kpis, currency = 'GBP' }: CustomerInsightsProps) {
  const avgRevenuePerCustomer =
    customerStats.withOrders > 0 ? kpis.grossRevenue / customerStats.withOrders : 0;
  const avgOrdersPerCustomer =
    customerStats.withOrders > 0 ? kpis.totalOrders / customerStats.withOrders : 0;

  const metrics = [
    {
      icon: <UsersThree size={18} weight="duotone" />,
      iconColor: 'text-violet-500 bg-violet-500/10',
      label: 'Repeat Customers',
      value: customerStats.repeat.toLocaleString('en-GB'),
      detail: `${customerStats.repeatRate.toFixed(1)}% repeat rate`,
    },
    {
      icon: <UserPlus size={18} weight="duotone" />,
      iconColor: 'text-emerald-500 bg-emerald-500/10',
      label: 'Unique Buyers',
      value: customerStats.withOrders.toLocaleString('en-GB'),
      detail: `of ${customerStats.total.toLocaleString('en-GB')} total`,
    },
    {
      icon: <ShoppingCart size={18} weight="duotone" />,
      iconColor: 'text-blue-500 bg-blue-500/10',
      label: 'Avg Orders / Customer',
      value: avgOrdersPerCustomer.toFixed(1),
      detail: 'orders per buyer',
    },
    {
      icon: <ArrowsClockwise size={18} weight="duotone" />,
      iconColor: 'text-amber-500 bg-amber-500/10',
      label: 'Avg Revenue / Customer',
      value: formatCurrency(avgRevenuePerCustomer, currency),
      detail: 'lifetime value',
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-foreground">Customer Insights</h3>
        <p className="text-xs text-muted-foreground mt-0.5">Buyer behavior & retention</p>
      </div>

      <div className="space-y-3">
        {metrics.map((m) => (
          <div key={m.label} className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${m.iconColor}`}>
              {m.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground">{m.label}</p>
              <p className="text-xs text-muted-foreground">{m.detail}</p>
            </div>
            <span className="text-sm font-semibold text-foreground">{m.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
