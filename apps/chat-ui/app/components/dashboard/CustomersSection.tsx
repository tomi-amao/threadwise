import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import type { CustomerStats, CustomerSummary, KPIData } from '~/types/dashboard';
import { NumberedColumn, Section, SeeAll } from './Section';
import { int, money, pct, shortDate } from './format';

export function CustomersSection({
  customers,
  stats,
  kpis,
  currency,
}: {
  customers: CustomerSummary[];
  stats: CustomerStats;
  kpis: KPIData;
  currency: string;
}) {
  const buyers = stats.withOrders;
  const ordersPerBuyer = buyers > 0 ? kpis.totalOrders / buyers : 0;
  const lifetime = buyers > 0 ? kpis.grossRevenue / buyers : 0;
  const top = customers.slice(0, 8);

  return (
    <Section
      eyebrow="Customers"
      title={
        buyers > 0 ? (
          <>
            {pct(stats.repeatRate)} of buyers <em>come back.</em>
          </>
        ) : (
          <>
            Who buys, <em>and who returns.</em>
          </>
        )
      }
      note={
        buyers > 0
          ? `${int(stats.repeat)} of ${int(buyers)} buyers have ordered more than once.`
          : 'Buyer behaviour appears here once customers place orders.'
      }
      action={<SeeAll to="/customers">All customers</SeeAll>}
    >
      <div className="mb-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <NumberedColumn n="01" title="Repeat." value={`${int(stats.repeat)} customers`}>
          {pct(stats.repeatRate, 1)} repeat rate
        </NumberedColumn>
        <NumberedColumn n="02" title="Buyers." value={int(buyers)}>
          of {int(stats.total)} on file
        </NumberedColumn>
        <NumberedColumn n="03" title="Frequency." value={ordersPerBuyer.toFixed(1)}>
          orders per buyer
        </NumberedColumn>
        <NumberedColumn n="04" title="Lifetime." value={money(lifetime, currency)}>
          average revenue per buyer
        </NumberedColumn>
      </div>

      {top.length === 0 ? (
        <div className="rounded-2xl border bg-card">
          <EmptyState title="No customer orders yet." />
        </div>
      ) : (
        <DataTable label="Top customers by lifetime value">
          <thead>
            <tr>
              <th>Customer</th>
              <th className="text-right">Orders</th>
              <th className="hidden sm:table-cell">Last order</th>
              <th className="text-right">Lifetime spend</th>
            </tr>
          </thead>
          <tbody>
            {top.map(c => (
              <tr key={c.id}>
                <td>
                  <div>{c.name}</div>
                  {c.email && <div className="text-[13px] text-muted-foreground">{c.email}</div>}
                </td>
                <td className="text-right tabular-nums text-text-2">{int(c.orderCount)}</td>
                <td className="hidden font-mono text-[13px] text-text-2 sm:table-cell">
                  {shortDate(c.lastOrderDate)}
                </td>
                <td className="text-right tabular-nums">{money(c.totalSpent, currency)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}
