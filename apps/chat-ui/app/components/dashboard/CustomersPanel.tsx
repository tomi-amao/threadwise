import { DataTable } from '~/components/ui/data-table';
import { Panel, PanelLink } from '~/components/ui/panel';
import type { CustomerStats, CustomerSummary, KPIData } from '~/types/dashboard';
import { int, money, pct } from './format';

export function CustomersPanel({
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
  const lifetime = buyers > 0 ? kpis.grossRevenue / buyers : 0;
  const top = customers.slice(0, 6);

  return (
    <Panel
      testId="panel-customers"
      className="md:col-span-2 xl:col-span-4"
      flush
      title="Top customers"
      note={
        buyers > 0
          ? `${pct(stats.repeatRate)} of buyers come back · ${money(lifetime, currency)} lifetime each`
          : 'Buyer behaviour appears here once customers order.'
      }
      action={<PanelLink to="/customers">All customers</PanelLink>}
    >
      {top.length === 0 ? (
        <p className="px-6 pb-6 pt-2 text-center text-sm text-muted-foreground">
          No customer orders yet.
        </p>
      ) : (
        <DataTable bare dense label="Top customers by lifetime value">
          <thead>
            <tr>
              <th>Customer</th>
              <th className="text-right">Orders</th>
              <th className="text-right">Spend</th>
            </tr>
          </thead>
          <tbody>
            {top.map(c => (
              <tr key={c.id}>
                <td className="max-w-[220px]">
                  <div className="truncate">{c.name}</div>
                  {c.email && (
                    <div className="hidden truncate text-[13px] text-muted-foreground 2xl:block">
                      {c.email}
                    </div>
                  )}
                </td>
                <td className="text-right tabular-nums text-text-2">{int(c.orderCount)}</td>
                <td className="text-right tabular-nums">{money(c.totalSpent, currency)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Panel>
  );
}
