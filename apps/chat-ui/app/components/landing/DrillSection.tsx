/**
 * DrillSection: a profit and loss you can open. Pick a line and see what it is made of, entry by
 * entry, each with where it came from. The opposite direction to the sale tracer: that one goes
 * up from a single order, this one goes down from a total.
 */

import { useState } from 'react';
import { cn } from '~/lib/utils';
import { gbp } from './use-landing';

interface Entry {
  what: string;
  source: string;
  date: string;
  amount: number;
}
interface Line {
  id: string;
  label: string;
  amount: number;
  deduct?: boolean;
  count: string;
  entries: Entry[];
}

const LINES: Line[] = [
  {
    id: 'revenue',
    label: 'Revenue',
    amount: 48_120,
    count: '702 orders',
    entries: [
      { what: 'Order #1042 · Heavy Knit Cardigan', source: 'Shopify', date: '3 Oct', amount: 98 },
      { what: 'Order #1043 · Wool Overshirt', source: 'Shopify', date: '3 Oct', amount: 124 },
      { what: 'Order #1044 · Merino Scarf × 2', source: 'Squarespace', date: '4 Oct', amount: 116 },
      {
        what: 'Order #1045 · Selvedge Work Trouser',
        source: 'Shopify',
        date: '4 Oct',
        amount: 135,
      },
    ],
  },
  {
    id: 'cogs',
    label: 'Cost of goods sold',
    amount: 18_950,
    deduct: true,
    count: '54 purchases',
    entries: [
      {
        what: 'Production run · Porto Knitwear',
        source: 'Bank line',
        date: '28 Jul',
        amount: 6_200,
      },
      {
        what: 'Wool and cotton, first run · Mill & Loom',
        source: 'Invoice',
        date: '2 Jul',
        amount: 5_400,
      },
      { what: 'Pallet from Porto · DHL Freight', source: 'Bank line', date: '19 Aug', amount: 840 },
    ],
  },
  {
    id: 'expenses',
    label: 'Operating expenses',
    amount: 14_820,
    deduct: true,
    count: '311 entries',
    entries: [
      { what: 'Postage · Royal Mail', source: 'Bank line', date: '6 Oct', amount: 212.4 },
      { what: 'Ad spend · Meta', source: 'Bank line', date: '5 Oct', amount: 640 },
      { what: 'Monthly plan · Shopify', source: 'Bank line', date: '1 Oct', amount: 79 },
    ],
  },
];

const NET = 48_120 - 18_950 - 14_820;

export function DrillSection() {
  const [open, setOpen] = useState('revenue');
  const line = LINES.find(l => l.id === open)!;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_1.1fr] lg:gap-14">
      <div className="min-w-0 rounded-2xl border border-border-strong bg-card p-6 sm:p-8">
        <div className="eyebrow">Profit and loss · sample · year to 31 March</div>
        <table className="mt-5 w-full border-collapse text-[16px]">
          <tbody>
            {LINES.map(l => (
              <tr key={l.id} className="border-b">
                <td className="py-3">
                  <button
                    type="button"
                    onClick={() => setOpen(l.id)}
                    aria-pressed={open === l.id}
                    aria-label={`${l.label}, open what it is made of`}
                    className={cn(
                      'rounded-sm text-left underline decoration-dotted underline-offset-[6px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      open === l.id
                        ? 'text-accent-text decoration-accent-text'
                        : 'decoration-border-strong hover:text-accent-text'
                    )}
                  >
                    {l.label}
                  </button>
                  <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                    {l.count}
                  </div>
                </td>
                <td className="py-3 text-right tabular-nums">
                  {l.deduct ? `(${gbp(l.amount)})` : gbp(l.amount)}
                </td>
              </tr>
            ))}
            <tr>
              <td className="rule-double pb-3 pt-4 font-serif text-[26px]">Net income</td>
              <td className="rule-double pb-3 pt-4 text-right font-serif text-[26px] tabular-nums">
                {gbp(NET)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        className="min-w-0 rounded-2xl border border-dashed border-border-strong p-6 sm:p-8"
        aria-live="polite"
      >
        <div className="eyebrow">What {line.label.toLowerCase()} is made of</div>
        <div className="mt-2 font-serif text-[32px] leading-tight">
          {gbp(line.amount)}
          <span className="ml-3 font-sans text-[15px] text-text-2">across {line.count}</span>
        </div>
        <ul className="mt-5 divide-y rounded-xl border bg-card">
          {line.entries.map(e => (
            <li key={e.what} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-[15px]">{e.what}</div>
                <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
                  {e.source} · {e.date}
                </div>
              </div>
              <div className="shrink-0 tabular-nums text-[15px]">
                {gbp(e.amount, e.amount % 1 ? 2 : 0)}
              </div>
            </li>
          ))}
          <li className="px-4 py-3 text-[14px] text-text-2">
            …and the rest, each one openable the same way.
          </li>
        </ul>
        <p className="mt-4 text-[14px] text-text-2">
          Every line is an order, a bank transaction, an invoice, or a journal someone wrote and can
          see. A figure that cannot be traced to one of those does not get to be a figure.
        </p>
      </div>
    </div>
  );
}
