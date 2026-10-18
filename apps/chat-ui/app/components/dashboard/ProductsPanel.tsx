import { DataTable } from '~/components/ui/data-table';
import { Meter } from '~/components/ui/meter';
import { Panel, PanelLink } from '~/components/ui/panel';
import type { ProductPerformance } from '~/types/dashboard';
import { int, money, pct, share } from './format';

export function ProductsPanel({
  products,
  grossRevenue,
  currency,
}: {
  products: ProductPerformance[];
  grossRevenue: number;
  currency: string;
}) {
  const top = products.slice(0, 7);
  const topRevenue = top[0]?.totalRevenue ?? 0;
  const top3 = top.slice(0, 3).reduce((s, p) => s + p.totalRevenue, 0);

  return (
    <Panel
      testId="panel-products"
      className="md:col-span-2 xl:col-span-5"
      flush
      title="Top products"
      note={
        top.length >= 3 && grossRevenue > 0
          ? `Three products carry ${pct(share(top3, grossRevenue))} of sales.`
          : 'Ranked by revenue.'
      }
      action={<PanelLink to="/products">All products</PanelLink>}
    >
      {top.length === 0 ? (
        <p className="px-6 pb-6 pt-2 text-center text-sm text-muted-foreground">
          No product sales yet.
        </p>
      ) : (
        <DataTable bare dense label="Top products by revenue">
          <thead>
            <tr>
              <th>Product</th>
              <th className="hidden w-[28%] 2xl:table-cell">Share of top</th>
              <th className="text-right">Units</th>
              <th className="text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {top.map(p => (
              <tr key={p.id ?? p.name}>
                <td className="max-w-[220px] truncate">{p.name}</td>
                <td className="hidden 2xl:table-cell">
                  <Meter value={topRevenue > 0 ? p.totalRevenue / topRevenue : 0} />
                </td>
                <td className="text-right tabular-nums text-text-2">{int(p.totalQuantity)}</td>
                <td className="text-right tabular-nums">{money(p.totalRevenue, currency)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Panel>
  );
}
