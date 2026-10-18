/**
 * Revenue: how much was sold, what is kept after discounts, returns and fees, and what each
 * month looked like. Figures come from orders and payments (the shop's own numbers), not from the
 * ledger, which is why profit here can differ from the Profit and loss tab until journals catch up.
 */

import { LineChart } from '~/components/charts';
import { DataTable } from '~/components/ui/data-table';
import { Panel } from '~/components/ui/panel';
import { Statement, type StatementRow } from '~/components/ui/statement';
import { Term } from '~/components/ui/term';
import type { ReportsData } from '~/lib/api/reports.server';
import { cn } from '~/lib/utils';
import type { MonthDetailKind } from './MonthDetailDrawer';
import { int, money, monthLabel, monthlyTotals, otherOutboundOf } from './model';

function CostCell({ value, label, onOpen }: { value: number; label: string; onOpen?: () => void }) {
  if (value <= 0) return <>—</>;
  const text = `(${money(value)})`;
  if (!onOpen) return <>{text}</>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="rounded-sm px-1 py-0.5 underline decoration-dotted underline-offset-4 transition-colors hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {text}
    </button>
  );
}

export function RevenueTab({
  data,
  onOpenDetail,
}: {
  data: ReportsData;
  onOpenDetail: (kind: MonthDetailKind, month: string) => void;
}) {
  const { revenue, monthly } = data;
  const totals = monthlyTotals(monthly);

  const breakdown: StatementRow[] = [
    {
      kind: 'line',
      label: (
        <Term definition="Merchandise subtotal plus product discounts, excluding shipping and tax: the same measure as Shopify's gross sales.">
          Gross sales
        </Term>
      ),
      amount: revenue.grossSales,
    },
    {
      kind: 'line',
      label: (
        <Term definition="Product discounts only. Shipping-only discounts are left out so this matches Shopify's sales breakdown.">
          Discounts
        </Term>
      ),
      amount: revenue.discounts,
      deduct: true,
      indent: true,
    },
    {
      kind: 'line',
      label: (
        <Term definition="Successfully refunded payment amounts, net of shipping refunds: Shopify's Returns line.">
          Returns
        </Term>
      ),
      amount: revenue.returns,
      deduct: true,
      indent: true,
    },
    {
      kind: 'total',
      label: <Term definition="Gross sales less discounts and returns.">Net sales</Term>,
      amount: revenue.netSales,
    },
    {
      kind: 'line',
      label: (
        <Term definition="Shipping revenue after shipping discounts and shipping refunds.">
          Shipping charges
        </Term>
      ),
      amount: revenue.shippingCollected,
      indent: true,
    },
    {
      kind: 'line',
      label: <Term definition="Tax collected from customers.">Taxes</Term>,
      amount: revenue.taxCollected,
      indent: true,
    },
    {
      kind: 'total',
      label: (
        <Term definition="Net sales plus shipping charges and taxes, aligned to Shopify's total sales breakdown.">
          Total sales
        </Term>
      ),
      amount: revenue.totalSales,
    },
    {
      kind: 'line',
      label: (
        <Term definition="Payment gateway fees (Shopify Payments, PayPal) charged on captured payments: card processing and platform fees.">
          Processing fees
        </Term>
      ),
      amount: revenue.processingFees,
      deduct: true,
      indent: true,
    },
    {
      kind: 'grand',
      label: (
        <Term definition="Total sales less processing fees: what is kept after refunds, shipping adjustments and gateway fees.">
          Net revenue
        </Term>
      ),
      amount: revenue.netRevenue,
    },
  ];

  const keyFigures: { label: React.ReactNode; value: string }[] = [
    {
      label: <Term definition="Non-cancelled orders placed in the period.">Orders</Term>,
      value: int(revenue.orderCount),
    },
    {
      label: <Term definition="Gross revenue divided by the number of orders.">Average order</Term>,
      value: money(revenue.avgOrderValue),
    },
    {
      label: (
        <Term definition="Shipping charges collected less what shipping cost (carrier bank transactions). Negative means shipping was subsidised.">
          Shipping margin
        </Term>
      ),
      value: money(revenue.shippingMargin),
    },
    {
      label: (
        <Term definition="What carriers and fulfilment cost in the period, from bank transactions.">
          Shipping cost
        </Term>
      ),
      value: money(revenue.shippingCost),
    },
    {
      label: (
        <Term definition="Successful refunds in the period, including shipping refunds. The breakdown separates Returns from shipping refunds.">
          Refunds
        </Term>
      ),
      value: money(revenue.refunds),
    },
    {
      label: (
        <Term definition="Cost of stock recorded as gifted in the period. Shown apart so gifts do not distort cost of sales or margin.">
          Gifted stock
        </Term>
      ),
      value: money(revenue.giftedStockCost),
    },
  ];

  return (
    <div className="space-y-4">
      {monthly.length > 1 && (
        <Panel
          title="Sales and net income by month"
          note="Net income here is sales less cost of sales and spend, from the orders and bank transactions."
        >
          <LineChart
            ariaLabel="Total sales and net income by month"
            series={[
              {
                id: 'Total sales',
                data: monthly.map(m => ({ x: monthLabel(m.month), y: m.totalSales })),
              },
              {
                id: 'Net income',
                data: monthly.map(m => ({ x: monthLabel(m.month), y: m.netIncome })),
              },
            ]}
          />
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="From gross sales to net revenue">
          <Statement rows={breakdown} />
        </Panel>
        <Panel title="Key figures">
          <dl className="divide-y">
            {keyFigures.map((f, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 py-3">
                <dt className="text-[15px] text-text-2">{f.label}</dt>
                <dd className="tabular-nums">{f.value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      {monthly.length > 0 && (
        <Panel title="Month by month" note="Cost columns open the records behind them." flush>
          <DataTable label="Monthly breakdown" bare surface="page">
            <thead>
              <tr>
                <th>Month</th>
                <th className="text-right">Sales</th>
                <th className="text-right">Discounts</th>
                <th className="text-right">Returns</th>
                <th className="text-right">Fees</th>
                <th className="text-right">Cost of sales</th>
                <th className="text-right">Shipping</th>
                <th className="text-right">Other spend</th>
                <th className="text-right">Net income</th>
                <th className="text-right">Orders</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map(m => (
                <tr key={m.month}>
                  <td className="whitespace-nowrap">{monthLabel(m.month)}</td>
                  <td className="text-right tabular-nums">{money(m.totalSales)}</td>
                  <td className="text-right tabular-nums text-text-2">
                    <CostCell value={m.discounts} label={`${monthLabel(m.month)} discounts`} />
                  </td>
                  <td className="text-right tabular-nums text-text-2">
                    <CostCell value={m.returns} label={`${monthLabel(m.month)} returns`} />
                  </td>
                  <td className="text-right tabular-nums text-text-2">
                    <CostCell value={m.processingFees} label={`${monthLabel(m.month)} fees`} />
                  </td>
                  <td className="text-right tabular-nums text-text-2">
                    <CostCell
                      value={m.cogs}
                      label={`${monthLabel(m.month)} cost of sales detail`}
                      onOpen={() => onOpenDetail('cogs', m.month)}
                    />
                  </td>
                  <td className="text-right tabular-nums text-text-2">
                    <CostCell
                      value={m.shippingCost}
                      label={`${monthLabel(m.month)} shipping detail`}
                      onOpen={() => onOpenDetail('shipping', m.month)}
                    />
                  </td>
                  <td className="text-right tabular-nums text-text-2">
                    <CostCell
                      value={otherOutboundOf(m)}
                      label={`${monthLabel(m.month)} other spend detail`}
                      onOpen={() => onOpenDetail('other', m.month)}
                    />
                  </td>
                  <td
                    className={cn('text-right tabular-nums', m.netIncome < 0 && 'text-destructive')}
                  >
                    {money(m.netIncome)}
                  </td>
                  <td className="text-right tabular-nums text-text-2">{int(m.orders)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="text-right tabular-nums">{money(totals.totalSales)}</td>
                <td className="text-right tabular-nums">
                  {totals.discounts > 0 ? `(${money(totals.discounts)})` : '—'}
                </td>
                <td className="text-right tabular-nums">
                  {totals.returns > 0 ? `(${money(totals.returns)})` : '—'}
                </td>
                <td className="text-right tabular-nums">
                  {totals.processingFees > 0 ? `(${money(totals.processingFees)})` : '—'}
                </td>
                <td className="text-right tabular-nums">
                  {totals.cogs > 0 ? `(${money(totals.cogs)})` : '—'}
                </td>
                <td className="text-right tabular-nums">
                  {totals.shippingCost > 0 ? `(${money(totals.shippingCost)})` : '—'}
                </td>
                <td className="text-right tabular-nums">
                  {totals.otherOutbound > 0 ? `(${money(totals.otherOutbound)})` : '—'}
                </td>
                <td className="text-right tabular-nums">{money(totals.netIncome)}</td>
                <td className="text-right tabular-nums">{int(totals.orders)}</td>
              </tr>
            </tfoot>
          </DataTable>
        </Panel>
      )}
    </div>
  );
}
