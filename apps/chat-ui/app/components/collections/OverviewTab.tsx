/**
 * OverviewTab: how the collection is doing. Sales come from its products' orders, costs from the
 * bank transactions linked to it, so profit is simply the difference. If a plan exists, its
 * projection sits beside the actuals, which is the point of planning.
 */

import { BarChart, ShareChart } from '~/components/charts';
import { Meter } from '~/components/ui/meter';
import { Panel } from '~/components/ui/panel';
import { Stat, StatStrip } from '~/components/ui/stat-strip';
import type { CollectionDetail } from '~/lib/api/collections.server';
import { cn } from '~/lib/utils';
import { int, money, pct, prettyType, shortDate } from './model';

export function OverviewTab({ detail }: { detail: CollectionDetail }) {
  const { collection, sales, costs, memberships, plan } = detail;
  const currency = collection.budgetCurrency;
  const cost = costs.reduce((t, c) => t + c.amount, 0);
  const profit = sales.revenue - cost;
  const margin = sales.revenue > 0 ? (profit / sales.revenue) * 100 : null;

  const budget = collection.budget;
  const used = budget ? cost / budget : null;
  const over = used != null && used > 1;

  const byType = new Map<string, number>();
  for (const c of costs) byType.set(c.costType, (byType.get(c.costType) ?? 0) + c.amount);
  const share = [...byType.entries()]
    .map(([type, value]) => ({ id: type, label: prettyType(type), value }))
    .sort((a, b) => b.value - a.value);

  const weeks = sales.weekly
    .slice(-12)
    .map(w => ({ label: shortDate(w.weekStart).replace(/ \d{4}$/, ''), value: w.revenue }));
  const best = memberships
    .filter(m => m.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 3);

  return (
    <div className="space-y-4">
      <StatStrip>
        <Stat
          label="Revenue"
          value={money(sales.revenue, 'GBP')}
          title="From linked products"
          caption={`${int(sales.units)} units · ${int(sales.orders)} orders`}
        />
        <Stat
          label="Costs"
          value={money(cost, 'GBP')}
          title="Linked transactions"
          caption={`${int(costs.length)} on record`}
        />
        <Stat
          label="Gross profit"
          tone={profit < 0 ? 'negative' : 'default'}
          value={money(profit, 'GBP')}
          title="Revenue less costs"
          caption={
            sales.units ? `${money(profit / sales.units, 'GBP', 2)} per unit` : 'No units sold'
          }
        />
        <Stat
          label="Margin"
          tone={margin != null && margin < 0 ? 'negative' : 'default'}
          value={pct(margin)}
          title="Gross margin"
          caption={
            margin == null
              ? 'Needs revenue'
              : margin < 0
                ? 'Spend exceeded sales'
                : 'After linked costs'
          }
        />
      </StatStrip>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel
          title="Weekly revenue"
          testId="collection-weekly"
          note={weeks.length ? `${weeks.length} weeks with sales.` : 'Waiting on the first sale.'}
        >
          {weeks.length === 0 ? (
            <p className="py-10 text-center text-[15px] text-text-2">
              No sales yet. Bars appear here once the collection&apos;s products start selling.
            </p>
          ) : (
            <BarChart data={weeks} ariaLabel="Weekly revenue" height={240} />
          )}
        </Panel>

        <Panel title="Budget" testId="collection-budget">
          {budget ? (
            <div>
              <div className="font-serif text-[36px] tabular-nums leading-tight">
                {money(Math.abs(budget - cost), currency)}
                <span className="ml-2.5 font-sans text-[15px] text-text-2">
                  {over ? 'over budget' : 'remaining'}
                </span>
              </div>
              <Meter
                className="my-4"
                value={used ?? 0}
                over={over}
                label={`${Math.round((used ?? 0) * 100)}% of the budget used`}
              />
              <p className="font-mono text-xs uppercase tracking-[0.04em] text-muted-foreground">
                {money(cost, currency)} of {money(budget, currency)} ·{' '}
                {Math.round((used ?? 0) * 100)}% used
              </p>
            </div>
          ) : (
            <p className="text-[15px] text-text-2">No budget set. Costs are still tracked.</p>
          )}
          <h3 className="eyebrow mt-6">Where the money went</h3>
          <div className="mt-3">
            {share.length === 0 ? (
              <p className="text-[15px] text-text-2">No costs linked yet.</p>
            ) : (
              <ShareChart
                data={share}
                ariaLabel="Linked costs by category"
                height={160}
                stacked
                format={v => money(v, 'GBP')}
              />
            )}
          </div>
        </Panel>
      </div>

      {plan && (
        <Panel
          title="Plan against actual"
          testId="collection-plan-vs-actual"
          note="What the plan projected, and what has happened so far."
        >
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr className="eyebrow text-left">
                <th className="pb-2 font-normal">
                  <span className="sr-only">Measure</span>
                </th>
                <th className="pb-2 text-right font-normal">Planned</th>
                <th className="pb-2 text-right font-normal">So far</th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  label: 'Revenue',
                  planned: plan.projections.projectedRevenue,
                  actual: sales.revenue,
                },
                { label: 'Cost', planned: plan.projections.projectedTotalCost, actual: cost },
                { label: 'Profit', planned: plan.projections.projectedNetProfit, actual: profit },
              ].map(r => (
                <tr key={r.label} className="border-t">
                  <th scope="row" className="py-2.5 text-left font-normal text-text-2">
                    {r.label}
                  </th>
                  <td className="py-2.5 text-right tabular-nums">
                    {money(r.planned, plan.plan.currency)}
                  </td>
                  <td
                    className={cn(
                      'py-2.5 text-right tabular-nums',
                      r.label === 'Profit' && r.actual < 0 && 'text-destructive'
                    )}
                  >
                    {money(r.actual, 'GBP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.plan.currency !== 'GBP' && (
            <p className="mt-2 text-[13px] text-text-2">
              The plan is in {plan.plan.currency}; actuals are in GBP.
            </p>
          )}
        </Panel>
      )}

      <section aria-label="Best sellers" className="pt-2">
        <h2 className="eyebrow">Best sellers</h2>
        {best.length === 0 ? (
          <p className="mt-3 text-[15px] text-text-2">
            Link products to see what is carrying the collection.
          </p>
        ) : (
          <div className="mt-4 grid gap-6 md:grid-cols-3">
            {best.map((m, i) => (
              <div key={m.id} className="border-t border-border-strong pt-4">
                <div className="font-mono text-xs text-text-2">0{i + 1}</div>
                <h3 className="mt-2 font-serif text-[24px]">
                  {m.product?.name ?? 'Unmapped product'}.
                </h3>
                <p className="mt-1 text-[15px] text-text-2">
                  {money(m.revenue, 'GBP')} from {int(m.units)} units,{' '}
                  {pct(sales.revenue > 0 ? (m.revenue / sales.revenue) * 100 : null, 0)} of
                  collection revenue.
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
