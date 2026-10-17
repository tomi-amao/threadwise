/**
 * PlanTab: the forecast for a collection, before launch. Product lines (quantity, cost, price,
 * sell-through, gifted units) and other planned costs roll up into projected revenue and profit;
 * for a collaboration the plan also says who pays whom. A scenario switch shows the same plan
 * under cautious and optimistic assumptions without changing anything stored.
 */

import { useMemo, useState } from 'react';
import {
  ChartBar,
  Coins,
  FilePdf,
  Handshake,
  PencilSimple,
  Plus,
  Trash,
  Wallet,
} from 'phosphor-react';
import { Button, buttonVariants } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { EmptyState } from '~/components/ui/empty-state';
import { Panel } from '~/components/ui/panel';
import { Segmented } from '~/components/ui/segmented';
import { Stat, StatStrip } from '~/components/ui/stat-strip';
import type { CollectionDetail } from '~/lib/api/collections.server';
import {
  PLAN_COST_CATEGORIES,
  SCENARIO_PRESETS,
  collaborationTypeLabel,
  computeScenarios,
  getCustomTerms,
} from '~/lib/collection-plans';
import { cn } from '~/lib/utils';
import { int, money, pct, shortDate } from './model';
import { ConfirmRemove, useCollectionAction } from './use-collection-action';

const safeMoney = (v: number, currency: string, digits = 0) => money(v, currency, digits);
const categoryLabel = (value: string) =>
  PLAN_COST_CATEGORIES.find(c => c.value === value)?.label ?? value.replace(/_/g, ' ');

/** The terms of the deal as label/value pairs, in the order a partner would read them. */
function termsOf(plan: NonNullable<CollectionDetail['plan']>['plan']): [string, string][] {
  const m = plan.metadata;
  const out: [string, string][] = [];
  const add = (label: string, value: unknown, suffix = '') => {
    if (value === undefined || value === null || value === '') return;
    out.push([label, `${value}${suffix}`]);
  };
  switch (plan.collaborationType) {
    case 'wholesale':
      add('Minimum order', m.minimum_order_quantity, ' units');
      add('Payment terms', m.payment_terms);
      add('Purchase order', m.purchase_order_reference);
      break;
    case 'co_branded':
      add('Your revenue split', m.revenue_split_pct, '%');
      add('Your cost split', m.cost_split_pct, '%');
      out.push([
        'Partner costs',
        m.costs_paid_upfront === false ? 'Taken from their revenue split' : 'Paid upfront',
      ]);
      add('Co-brand credit', m.co_brand_credit_notes);
      add('Marketing commitments', m.marketing_commitment_notes);
      break;
    case 'revenue_share':
      add('Partner revenue share', m.revenue_share_pct, '%');
      add('Minimum guarantee', m.minimum_guarantee_amount);
      add('Reporting', m.reporting_cadence);
      break;
    case 'pop_up':
      add('Venue cost', m.venue_cost_amount);
      add('Venue period', m.venue_cost_period);
      add('Duration', m.duration_days, ' days');
      add('Staffing', m.staffing_cost_amount);
      add('Fixtures', m.fixtures_cost_amount);
      add('Expected foot traffic', m.expected_foot_traffic);
      break;
  }
  for (const t of getCustomTerms(m)) out.push([t.label, t.value]);
  return out;
}

export function PlanTab({
  detail,
  onTerms,
  onLine,
  onCost,
}: {
  detail: CollectionDetail;
  onTerms: () => void;
  onLine: (id: string | null) => void;
  onCost: (id: string | null) => void;
}) {
  const { plan, fxRate, entityName } = detail;
  const [scenario, setScenario] = useState('Base case');
  const [removingLine, setRemovingLine] = useState<string | null>(null);
  const [removingCost, setRemovingCost] = useState<string | null>(null);
  const removeLine = useCollectionAction(() => setRemovingLine(null));
  const removeCost = useCollectionAction(() => setRemovingCost(null));
  const start = useCollectionAction();

  const scenarios = useMemo(
    () =>
      plan
        ? computeScenarios(
            plan.plan.collaborationType,
            entityName,
            plan.plan.partnerName,
            plan.plan.metadata,
            plan.lines,
            plan.costs
          )
        : [],
    [plan, entityName]
  );

  if (!plan) {
    return (
      <div className="overflow-hidden rounded-2xl border bg-row">
        <EmptyState
          eyebrow="No plan yet"
          title="Model it before you make it."
          description="Lay out quantities, unit costs and sell-through to see projected profit, including the terms of a brand collaboration if there is one."
          action={
            <Button
              size="sm"
              disabled={start.busy}
              onClick={() => start.submit({ intent: 'createPlan' })}
            >
              {start.busy ? 'Starting…' : 'Start a plan'}
            </Button>
          }
        />
        {start.error && (
          <p role="alert" className="pb-6 text-center text-[14px] text-destructive">
            {start.error}
          </p>
        )}
      </div>
    );
  }

  const { plan: record, lines, costs } = plan;
  const currency = record.currency;
  const chosen = scenarios.find(s => s.preset.label === scenario) ?? scenarios[1];
  const p = chosen?.projections ?? plan.projections;
  const preset = SCENARIO_PRESETS.find(s => s.label === scenario) ?? SCENARIO_PRESETS[1];
  const terms = termsOf(record);
  const isCollab = record.collaborationType !== 'in_house';
  const line = (id: string | null) => lines.find(l => l.id === id);
  const cost = (id: string | null) => costs.find(c => c.id === id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Scenario"
            value={scenario}
            onChange={setScenario}
            options={SCENARIO_PRESETS.map(s => ({ value: s.label, label: s.label }))}
          />
          <span className="text-[13px] text-text-2">{preset.description}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/collections/plan-pack?collection=${detail.collection.id}&scenarios=1`}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <ChartBar size={14} weight="light" aria-hidden /> Compare scenarios
          </a>
          <a
            href={`/api/collections/plan-pack?collection=${detail.collection.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <FilePdf size={14} weight="light" aria-hidden /> Print plan
          </a>
        </div>
      </div>

      <StatStrip>
        <Stat
          label="Projected revenue"
          value={safeMoney(p.projectedRevenue, currency)}
          title={scenario}
          caption="after gifted units and sell-through"
        />
        <Stat
          label="Goods cost"
          value={safeMoney(p.projectedProductCost, currency)}
          title="Every unit made"
          caption={`${int(lines.reduce((t, l) => t + l.plannedQuantity, 0))} units`}
        />
        <Stat
          label="Other costs"
          value={safeMoney(p.projectedOtherCost, currency)}
          title={
            p.costsPendingCount > 0
              ? `${p.costsPendingCount} still to be determined`
              : 'All amounts known'
          }
          caption={
            p.costsEstimatedCount > 0 ? `${p.costsEstimatedCount} estimated, not firm` : undefined
          }
        />
        <Stat
          label="Net profit"
          tone={p.projectedNetProfit < 0 ? 'negative' : 'default'}
          value={safeMoney(p.projectedNetProfit, currency)}
          title={`${pct(p.projectedNetMarginPct)} net margin`}
          caption={`Gross margin ${pct(p.projectedGrossMarginPct)}`}
        />
      </StatStrip>

      <Panel
        title="Collaboration and terms"
        testId="plan-terms"
        action={
          <Button variant="outline" size="sm" onClick={onTerms}>
            <PencilSimple size={14} weight="light" aria-hidden /> Edit terms
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="plain">{collaborationTypeLabel(record.collaborationType)}</Chip>
          {record.partnerName && <span className="text-[15px]">with {record.partnerName}</span>}
          <span className="text-[13px] text-text-2">Planned in {currency}</span>
          {record.partnerCurrency && (
            <span className="text-[13px] text-text-2">
              · partner works in {record.partnerCurrency}
            </span>
          )}
        </div>
        {terms.length > 0 && (
          <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {terms.map(([label, value]) => (
              <div key={label}>
                <dt className="eyebrow">{label}</dt>
                <dd className="mt-1 text-[15px]">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {record.notes && <p className="mt-4 text-[14px] text-text-2">{record.notes}</p>}
      </Panel>

      {isCollab && (p.partnerPaymentDue || p.entityUpfrontCost != null || p.payouts.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {p.partnerPaymentDue && (
            <Panel
              title={`${record.partnerName || 'Partner'} needs to pay`}
              testId="plan-partner-due"
            >
              <div className="flex items-start gap-3">
                <Coins size={20} weight="light" aria-hidden className="mt-1 shrink-0 text-text-2" />
                <div>
                  {p.partnerPaymentDue.amount != null ? (
                    <div className="font-serif text-[30px] tabular-nums leading-tight">
                      {safeMoney(p.partnerPaymentDue.amount, currency)}
                      {fxRate && (
                        <span className="ml-2 font-sans text-[14px] text-text-2">
                          (≈{' '}
                          {safeMoney(
                            p.partnerPaymentDue.amount * fxRate.rate,
                            fxRate.targetCurrency
                          )}
                          )
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-[15px]">Nothing, right now</p>
                  )}
                  <p className="mt-1 text-[13px] text-text-2">{p.partnerPaymentDue.basis}</p>
                </div>
              </div>
            </Panel>
          )}
          {p.entityUpfrontCost != null && (
            <Panel title="Your upfront cash outlay" testId="plan-upfront">
              <div className="flex items-start gap-3">
                <Wallet
                  size={20}
                  weight="light"
                  aria-hidden
                  className="mt-1 shrink-0 text-text-2"
                />
                <div>
                  <div className="font-serif text-[30px] tabular-nums leading-tight">
                    {safeMoney(p.entityUpfrontCost, currency)}
                  </div>
                  <p className="mt-1 text-[13px] text-text-2">
                    {p.entityUpfrontCost === p.projectedTotalCost
                      ? "The full planned cost: their share isn't paid in upfront, so you front all of it until revenue settles."
                      : 'Your own cost-split share. The partner is covering theirs separately, upfront.'}
                  </p>
                </div>
              </div>
            </Panel>
          )}
          {p.payouts.length > 0 && (
            <Panel
              title={`Who gets paid what (${collaborationTypeLabel(record.collaborationType)})`}
              testId="plan-payouts"
              className="lg:col-span-2"
            >
              <div className="flex items-start gap-3">
                <Handshake
                  size={20}
                  weight="light"
                  aria-hidden
                  className="mt-1 shrink-0 text-text-2"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  {p.payouts.map((payout, i) => (
                    <div
                      key={`${payout.party}-${i}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5"
                    >
                      <span className="text-[15px] font-medium">{payout.party}</span>
                      <span className="flex-1 basis-56 text-[13px] text-text-2">
                        {payout.basis}
                      </span>
                      <span className="tabular-nums text-[15px]">
                        {safeMoney(payout.amount, currency)}
                        {payout.isPartner && fxRate && (
                          <span className="ml-1.5 text-text-2">
                            (≈ {safeMoney(payout.amount * fxRate.rate, fxRate.targetCurrency)})
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                  {fxRate && (
                    <p className="pt-1 text-[13px] text-text-2">
                      Live rate 1 {fxRate.baseCurrency} = {fxRate.rate.toFixed(4)}{' '}
                      {fxRate.targetCurrency}, as of {shortDate(fxRate.asOf)}. Indicative, not a
                      settlement rate.
                    </p>
                  )}
                  <p className="text-[13px] text-text-2">
                    Estimates from the split and terms above, not a full settlement calculation.
                  </p>
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}

      <Panel
        title="Planned range"
        testId="plan-lines"
        note="Quantity, cost and price per product. The figures below are as entered; the scenario changes the totals above."
        flush
        action={
          <Button variant="outline" size="sm" onClick={() => onLine(null)}>
            <Plus size={14} weight="bold" aria-hidden /> Add line
          </Button>
        }
      >
        {lines.length === 0 ? (
          <EmptyState title="No lines yet." description="Add a product to start modelling." />
        ) : (
          <DataTable label="Planned product lines" bare surface="page">
            <thead>
              <tr>
                <th>Product</th>
                <th className="text-right">Qty</th>
                <th className="hidden text-right md:table-cell">Gifted</th>
                <th className="hidden text-right md:table-cell">Unit cost</th>
                <th className="hidden text-right md:table-cell">Price</th>
                <th className="hidden text-right lg:table-cell">Sell-through</th>
                <th className="text-right">Revenue</th>
                <th className="hidden text-right lg:table-cell">COGS</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const sellable = l.plannedQuantity - Math.min(l.plannedQuantity, l.giftedUnits);
                const revenue =
                  sellable *
                  (Math.max(0, Math.min(100, l.expectedSellThroughPct)) / 100) *
                  l.unitSellingPrice;
                const name = l.linkedProductName || l.productName || 'Unnamed product';
                return (
                  <tr key={l.id}>
                    <td>
                      <span className="block max-w-[240px] truncate">{name}</span>
                      {!l.productId && (
                        <span className="text-[12px] text-text-2">Not launched yet</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{int(l.plannedQuantity)}</td>
                    <td className="hidden text-right tabular-nums text-text-2 md:table-cell">
                      {l.giftedUnits > 0 ? int(l.giftedUnits) : '–'}
                    </td>
                    <td className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
                      {safeMoney(l.unitCost, currency, 2)}
                      {l.unitCostCurrency && l.unitCostOriginal != null && (
                        <span className="block text-[12px] text-text-2">
                          (≈ {safeMoney(l.unitCostOriginal, l.unitCostCurrency, 2)})
                        </span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap text-right tabular-nums md:table-cell">
                      {safeMoney(l.unitSellingPrice, currency, 2)}
                    </td>
                    <td className="hidden text-right tabular-nums text-text-2 lg:table-cell">
                      {int(l.expectedSellThroughPct)}%
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {safeMoney(revenue, currency)}
                    </td>
                    <td className="hidden whitespace-nowrap text-right tabular-nums text-text-2 lg:table-cell">
                      {safeMoney(l.plannedQuantity * l.unitCost, currency)}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <button
                        type="button"
                        onClick={() => onLine(l.id)}
                        aria-label={`Edit ${name}`}
                        className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <PencilSimple size={16} weight="light" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemovingLine(l.id)}
                        aria-label={`Remove ${name}`}
                        className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash size={16} weight="light" aria-hidden />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <Panel
        title="Other planned costs"
        testId="plan-costs"
        note="Disclosed upfront, priced when known."
        flush
        action={
          <Button variant="outline" size="sm" onClick={() => onCost(null)}>
            <Plus size={14} weight="bold" aria-hidden /> Add cost
          </Button>
        }
      >
        {costs.length === 0 ? (
          <EmptyState
            title="No other costs planned."
            description="Marketing, packaging, freight and so on."
          />
        ) : (
          <DataTable label="Other planned costs" bare surface="page">
            <thead>
              <tr>
                <th>Category</th>
                <th className="hidden md:table-cell">Description</th>
                <th className="text-right">Amount</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {costs.map(c => (
                <tr key={c.id}>
                  <td>
                    <Chip tone="plain">{categoryLabel(c.costCategory)}</Chip>
                  </td>
                  <td className="hidden max-w-[320px] truncate text-[14px] text-text-2 md:table-cell">
                    {c.description || '–'}
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {c.plannedAmount != null ? (
                      <>
                        {safeMoney(c.plannedAmount, currency)}
                        {c.isEstimated && (
                          <Chip tone="active" className="ml-2">
                            Estimate
                          </Chip>
                        )}
                      </>
                    ) : (
                      <Chip tone="draft">To be determined</Chip>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <button
                      type="button"
                      onClick={() => onCost(c.id)}
                      aria-label={`Edit ${categoryLabel(c.costCategory)} cost`}
                      className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <PencilSimple size={16} weight="light" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemovingCost(c.id)}
                      aria-label={`Remove ${categoryLabel(c.costCategory)} cost`}
                      className={cn(
                        'inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                      )}
                    >
                      <Trash size={16} weight="light" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <ConfirmRemove
        open={!!removingLine}
        title="Remove this line?"
        description={`${line(removingLine)?.linkedProductName || line(removingLine)?.productName || 'This line'} comes out of the plan and its totals.`}
        busy={removeLine.busy}
        error={removeLine.error}
        onCancel={() => setRemovingLine(null)}
        onConfirm={() =>
          removingLine && removeLine.submit({ intent: 'removePlanLine', lineId: removingLine })
        }
      />
      <ConfirmRemove
        open={!!removingCost}
        title="Remove this cost?"
        description={`${categoryLabel(cost(removingCost)?.costCategory ?? 'other')} comes out of the plan's other costs.`}
        busy={removeCost.busy}
        error={removeCost.error}
        onCancel={() => setRemovingCost(null)}
        onConfirm={() =>
          removingCost && removeCost.submit({ intent: 'removePlanCost', costId: removingCost })
        }
      />
    </div>
  );
}
