import { ShareChart } from '~/components/charts';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { Eyebrow } from '~/components/ui/eyebrow';
import { Meter } from '~/components/ui/meter';
import type { PaymentMethodBreakdown, ProductPerformance } from '~/types/dashboard';
import { NumberedColumn, Section, SeeAll } from './Section';
import { int, money, paymentName, pct, share } from './format';

export function ProductsSection({
  products,
  payments,
  grossRevenue,
  currency,
}: {
  products: ProductPerformance[];
  payments: PaymentMethodBreakdown[];
  grossRevenue: number;
  currency: string;
}) {
  const top = products.slice(0, 8);
  const topRevenue = top[0]?.totalRevenue ?? 0;
  const top3Revenue = top.slice(0, 3).reduce((s, p) => s + p.totalRevenue, 0);
  const captured = payments.reduce((s, p) => s + p.totalAmount, 0);

  return (
    <Section
      band
      eyebrow="Products and payments"
      title={
        top.length >= 3 && grossRevenue > 0 ? (
          <>
            Three products carry <em>{pct(share(top3Revenue, grossRevenue))} of sales.</em>
          </>
        ) : (
          <>
            What sells, <em>and how it is paid for.</em>
          </>
        )
      }
      note="Ranked by revenue across every order. Payment methods show what was captured, not what was charged."
      action={<SeeAll to="/products">All products</SeeAll>}
    >
      {top.length === 0 ? (
        <div className="rounded-2xl border bg-card">
          <EmptyState
            title="No product sales yet."
            description="Top sellers appear here once orders include products."
          />
        </div>
      ) : (
        <>
          {top.length >= 3 && (
            <div className="mb-8 grid gap-6 md:grid-cols-3">
              {top.slice(0, 3).map((p, i) => (
                <NumberedColumn key={p.id ?? p.name} n={`0${i + 1}`} title={`${p.name}.`}>
                  {money(p.totalRevenue, currency)} from {int(p.totalQuantity)} units in{' '}
                  {int(p.orderCount)} orders.
                </NumberedColumn>
              ))}
            </div>
          )}

          <div className="grid items-start gap-5 lg:grid-cols-[1.6fr_1fr]">
            <DataTable label="Top products by revenue" className="min-w-0">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="hidden w-[30%] sm:table-cell">Share of top seller</th>
                  <th className="text-right">Units</th>
                  <th className="text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {top.map(p => (
                  <tr key={p.id ?? p.name}>
                    <td>{p.name}</td>
                    <td className="hidden sm:table-cell">
                      <Meter value={topRevenue > 0 ? p.totalRevenue / topRevenue : 0} />
                    </td>
                    <td className="text-right tabular-nums text-text-2">{int(p.totalQuantity)}</td>
                    <td className="text-right tabular-nums">{money(p.totalRevenue, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            <div className="min-w-0 rounded-2xl border bg-card p-6">
              <Eyebrow>Payment methods</Eyebrow>
              <div className="mt-2.5 font-serif text-4xl tabular-nums">
                {money(captured, currency)}
              </div>
              <div className="mb-5 text-[13px] text-muted-foreground">captured</div>
              <ShareChart
                ariaLabel="Payment methods"
                stacked
                format={v => money(v, currency)}
                data={payments.map(p => ({
                  id: `${p.gateway}|${p.method}`,
                  label: paymentName(p.gateway, p.method),
                  value: p.totalAmount,
                }))}
              />
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
