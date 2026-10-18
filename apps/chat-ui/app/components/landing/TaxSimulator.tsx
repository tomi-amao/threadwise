/**
 * TaxSimulator: UK corporation tax and the VAT threshold, as two dials. Corporation tax is worked
 * out per accounting period with the small-profits rate (19%) below £50,000, the main rate (25%)
 * above £250,000 and marginal relief between; the VAT meter watches rolling twelve-month sales
 * against the £90,000 registration threshold. The rules are the ones the app uses.
 */

import { useState } from 'react';
import { cn } from '~/lib/utils';
import { gbp } from './use-landing';

const LOWER = 50_000;
const UPPER = 250_000;
const SMALL = 0.19;
const MAIN = 0.25;
const MARGINAL_FRACTION = 0.015; // 3/200
const VAT_THRESHOLD = 90_000;

/** Corporation tax on a stand-alone company's profit for a 12-month period. */
export function corporationTax(profit: number): number {
  if (profit <= 0) return 0;
  if (profit <= LOWER) return profit * SMALL;
  if (profit >= UPPER) return profit * MAIN;
  return profit * MAIN - MARGINAL_FRACTION * (UPPER - profit);
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  valueText,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  valueText: string;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="eyebrow">
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-[14px] tabular-nums">
          {valueText}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        onChange={e => onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${fill}%` }}
        className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[linear-gradient(to_right,var(--ramp-1)_var(--fill),var(--border-strong)_var(--fill))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-foreground [&::-moz-range-thumb]:bg-background [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-foreground [&::-webkit-slider-thumb]:bg-background"
      />
    </div>
  );
}

export function TaxSimulator() {
  const [profit, setProfit] = useState(72_000);
  const [sales, setSales] = useState(61_000);

  const tax = corporationTax(profit);
  const rate = profit > 0 ? (tax / profit) * 100 : 0;
  const band =
    profit <= 0
      ? 'No profit, no tax. The return is still due.'
      : profit <= LOWER
        ? 'Small profits rate: 19%.'
        : profit >= UPPER
          ? 'Main rate: 25%.'
          : 'In the marginal band: relief eases the rate from 19% towards 25%.';

  const headroom = VAT_THRESHOLD - sales;
  const over = headroom <= 0;
  const near = !over && sales / VAT_THRESHOLD >= 0.85;
  const vatPct = Math.min(100, (sales / VAT_THRESHOLD) * 100);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section
        aria-label="Corporation tax"
        className="rounded-2xl border border-border-strong bg-card p-6 sm:p-8"
      >
        <div className="eyebrow">Corporation tax, one accounting period</div>
        <Slider
          id="tax-profit"
          label="Profit before tax"
          value={profit}
          min={0}
          max={320_000}
          step={1000}
          onChange={setProfit}
          valueText={gbp(profit)}
        />

        {/* The three bands, with a marker where this profit sits. */}
        <div className="relative mt-7 h-3 rounded-full bg-border" aria-hidden>
          <span
            className="absolute inset-y-0 left-0 rounded-l-full bg-ramp-3"
            style={{ width: `${(LOWER / 320_000) * 100}%` }}
          />
          <span
            className="absolute inset-y-0 bg-ramp-4"
            style={{
              left: `${(LOWER / 320_000) * 100}%`,
              width: `${((UPPER - LOWER) / 320_000) * 100}%`,
            }}
          />
          <span
            className="absolute inset-y-0 right-0 rounded-r-full bg-ramp-5"
            style={{ left: `${(UPPER / 320_000) * 100}%` }}
          />
          <span
            className="absolute -top-1.5 h-6 w-0.5 rounded-full bg-foreground"
            style={{ left: `calc(${Math.min(100, (profit / 320_000) * 100)}% - 1px)` }}
          />
        </div>
        <div
          className="mt-2 flex justify-between font-mono text-[11px] text-muted-foreground"
          aria-hidden
        >
          <span>£0</span>
          <span>£50k</span>
          <span>£250k</span>
        </div>

        <div className="mt-6 flex items-end justify-between gap-4 border-t pt-5" aria-live="polite">
          <div>
            <div className="eyebrow">Tax due</div>
            <div className="font-serif text-[clamp(36px,4.4vw,52px)] leading-none tabular-nums tracking-[-0.03em]">
              {gbp(Math.round(tax))}
            </div>
          </div>
          <div className="text-right">
            <div className="eyebrow">Effective rate</div>
            <div className="font-mono text-[20px] tabular-nums">{rate.toFixed(1)}%</div>
          </div>
        </div>
        <p className="mt-3 text-[14px] text-text-2">{band}</p>
        <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          Paid 9 months and 1 day after the period ends. Return due 12 months after.
        </p>
      </section>

      <section
        aria-label="VAT registration"
        className="rounded-2xl border border-border-strong bg-card p-6 sm:p-8"
      >
        <div className="eyebrow">VAT registration, rolling twelve months</div>
        <Slider
          id="vat-sales"
          label="Sales in the last 12 months"
          value={sales}
          min={0}
          max={120_000}
          step={1000}
          onChange={setSales}
          valueText={gbp(sales)}
        />

        <div className="relative mt-7" aria-hidden>
          <div className="h-3 overflow-hidden rounded-full bg-border">
            <span
              className={cn(
                'block h-full rounded-full transition-[width]',
                over ? 'bg-destructive' : 'bg-ramp-1'
              )}
              style={{ width: `${vatPct}%` }}
            />
          </div>
          <div
            className="absolute -top-2 h-7 w-px bg-foreground"
            style={{ left: `${(VAT_THRESHOLD / 120_000) * 100}%` }}
          />
          <div
            className="absolute top-8 -translate-x-1/2 font-mono text-[11px] text-muted-foreground"
            style={{ left: `${(VAT_THRESHOLD / 120_000) * 100}%` }}
          >
            £90k
          </div>
        </div>

        <div className="mt-14 border-t pt-5" aria-live="polite">
          <div className="eyebrow">{over ? 'Over the threshold' : 'Headroom'}</div>
          <div
            className={cn(
              'font-serif text-[clamp(36px,4.4vw,52px)] leading-none tabular-nums tracking-[-0.03em]',
              over && 'text-destructive'
            )}
          >
            {gbp(Math.abs(headroom))}
          </div>
          <p className="mt-3 text-[14px] text-text-2">
            {over
              ? 'Registration is compulsory. It is checked every month, not once a year.'
              : near
                ? 'Close. Worth watching monthly: the window moves, so last year’s big month drops out as this year’s comes in.'
                : 'Before registration becomes compulsory. Checked against every rolling twelve months.'}
          </p>
        </div>
        <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          The rates and limits the app uses. Always check HMRC for changes.
        </p>
      </section>
    </div>
  );
}
