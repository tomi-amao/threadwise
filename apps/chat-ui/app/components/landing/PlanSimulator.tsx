/**
 * PlanSimulator: the collection planner, live. Four dials and a partner switch drive the same
 * projection the app runs (`computePlanProjections`), so what a visitor sees move here is what
 * they would see on a real plan, not an illustration of one.
 */

import { useMemo, useState } from 'react';
import { Segmented } from '~/components/ui/segmented';
import { computePlanProjections } from '~/lib/collection-plans';
import { cn } from '~/lib/utils';
import { gbp } from './use-landing';

const SCENARIOS = [
  { label: 'Cautious', sellThrough: 55 },
  { label: 'Expected', sellThrough: 75 },
  { label: 'Strong', sellThrough: 92 },
];

function Dial({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const id = `dial-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="eyebrow">
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-[14px] tabular-nums">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        onChange={e => onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${fill}%` }}
        className="dial mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[linear-gradient(to_right,var(--ramp-1)_var(--fill),var(--border-strong)_var(--fill))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-foreground [&::-moz-range-thumb]:bg-background [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-foreground [&::-webkit-slider-thumb]:bg-background"
      />
    </div>
  );
}

export function PlanSimulator() {
  const [units, setUnits] = useState(120);
  const [cost, setCost] = useState(34);
  const [price, setPrice] = useState(98);
  const [sell, setSell] = useState(75);
  const [other, setOther] = useState(1800);
  const [partner, setPartner] = useState<'solo' | 'share'>('solo');

  const p = useMemo(
    () =>
      computePlanProjections(
        partner === 'share' ? 'revenue_share' : 'in_house',
        'You',
        'Partner',
        partner === 'share' ? { revenue_share_pct: 30 } : {},
        [
          {
            id: 'l',
            planId: 'p',
            productId: null,
            productName: 'Sample piece',
            linkedProductName: null,
            plannedQuantity: units,
            giftedUnits: 0,
            unitCost: cost,
            unitSellingPrice: price,
            expectedSellThroughPct: sell,
            notes: null,
            displayOrder: 1,
            unitCostCurrency: null,
            unitCostOriginal: null,
          },
        ],
        [
          {
            id: 'c',
            planId: 'p',
            costCategory: 'marketing',
            description: null,
            plannedAmount: other,
            isEstimated: false,
            notes: null,
          },
        ]
      ),
    [units, cost, price, sell, other, partner]
  );

  const youKeep = partner === 'share' ? (p.estimatedShareProfit ?? 0) : p.projectedNetProfit;
  const partnerGets = partner === 'share' ? (p.payouts.find(x => x.isPartner)?.amount ?? 0) : 0;
  const loss = youKeep < 0;

  // Where each pound of revenue goes, as widths. A loss shows as spending past 100%.
  const revenue = Math.max(p.projectedRevenue, 1);
  const parts = [
    { key: 'Goods', value: p.projectedProductCost, tone: 'bg-ramp-3' },
    { key: 'Other costs', value: p.projectedOtherCost, tone: 'bg-ramp-4' },
    { key: 'Partner', value: partnerGets, tone: 'bg-plum' },
  ].filter(x => x.value > 0);
  const spent = parts.reduce((t, x) => t + x.value, 0);

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
      <div className="space-y-7">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Scenario"
            value={SCENARIOS.find(s => s.sellThrough === sell)?.label ?? 'Custom'}
            onChange={label => setSell(SCENARIOS.find(s => s.label === label)!.sellThrough)}
            options={SCENARIOS.map(s => ({ value: s.label, label: s.label }))}
          />
          <Segmented
            label="Collaboration"
            value={partner}
            onChange={setPartner}
            options={[
              { value: 'solo', label: 'Just you' },
              { value: 'share', label: '30% to a partner' },
            ]}
          />
        </div>
        <Dial
          label="Pieces made"
          value={units}
          min={20}
          max={400}
          step={10}
          format={n => `${n}`}
          onChange={setUnits}
        />
        <Dial
          label="Sell-through"
          value={sell}
          min={10}
          max={100}
          step={1}
          format={n => `${n}%`}
          onChange={setSell}
        />
        <Dial
          label="Cost per piece"
          value={cost}
          min={5}
          max={80}
          step={1}
          format={n => gbp(n)}
          onChange={setCost}
        />
        <Dial
          label="Selling price"
          value={price}
          min={20}
          max={200}
          step={1}
          format={n => gbp(n)}
          onChange={setPrice}
        />
        <Dial
          label="Marketing and packaging"
          value={other}
          min={0}
          max={8000}
          step={100}
          format={n => gbp(n)}
          onChange={setOther}
        />
      </div>

      <div
        className="self-start rounded-2xl border border-border-strong bg-card p-6 sm:p-8"
        aria-live="polite"
      >
        <div className="eyebrow">What you would keep</div>
        <div
          className={cn(
            'mt-2 font-serif text-[clamp(44px,6vw,72px)] leading-none tabular-nums tracking-[-0.03em]',
            loss && 'text-destructive'
          )}
        >
          {gbp(youKeep)}
        </div>
        <p className="mt-3 text-[15px] text-text-2">
          {loss
            ? 'A loss. Better to find that out before the fabric is bought.'
            : `${p.projectedRevenue > 0 ? ((youKeep / p.projectedRevenue) * 100).toFixed(0) : 0}p of every pound you take.`}
        </p>

        <div
          role="img"
          aria-label={`Of ${gbp(p.projectedRevenue)} revenue: goods ${gbp(p.projectedProductCost)}, other costs ${gbp(p.projectedOtherCost)}${partnerGets ? `, partner ${gbp(partnerGets)}` : ''}, you keep ${gbp(youKeep)}`}
          className="mt-6 flex h-3 overflow-hidden rounded-full bg-border"
        >
          {parts.map(x => (
            <span
              key={x.key}
              className={x.tone}
              style={{ width: `${Math.min(100, (x.value / Math.max(revenue, spent)) * 100)}%` }}
            />
          ))}
          {!loss && (
            <span
              className="bg-ramp-1"
              style={{ width: `${(youKeep / Math.max(revenue, spent)) * 100}%` }}
            />
          )}
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-[14px]">
          {[
            ['Revenue', gbp(p.projectedRevenue), 'bg-transparent'],
            ['Goods', gbp(p.projectedProductCost), 'bg-ramp-3'],
            ['Other costs', gbp(p.projectedOtherCost), 'bg-ramp-4'],
            partner === 'share'
              ? ['Partner', gbp(partnerGets), 'bg-plum']
              : ['Margin', `${p.projectedNetMarginPct.toFixed(1)}%`, 'bg-transparent'],
          ].map(([k, v, tone]) => (
            <div key={k} className="flex items-baseline justify-between border-b pb-2">
              <dt className="flex items-center gap-2 text-text-2">
                <i className={cn('inline-block size-2 rounded-full', tone)} aria-hidden />
                {k}
              </dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          The same projection the app runs, not an illustration of it.
        </p>
      </div>
    </div>
  );
}
