/**
 * SaleTracer: one sale, followed from the shop to the profit figure. This is the page's argument
 * in a single object: nothing in the numbers is a black box, because each one is the end of a
 * chain you can walk back along. It steps itself through the chain until the visitor takes over.
 *
 * The figures are invented (and labelled so), but the shapes are the real ones: the order, the
 * card fee, a balanced journal on real account numbers, and the line it moves on the P&L.
 */

import { useEffect, useState } from 'react';
import { cn } from '~/lib/utils';
import { gbp, usePrefersReducedMotion } from './use-landing';

const STEPS = [
  { id: 'order', label: 'Order lands' },
  { id: 'payment', label: 'Payment clears' },
  { id: 'journal', label: 'Becomes a journal' },
  { id: 'numbers', label: 'Moves your numbers' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const SALE = 98;
const FEE = 3.04; // 2.9% + 20p, rounded: what the card processor keeps
const BEFORE = 11402;

export function SaleTracer() {
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(0);
  const [taken, setTaken] = useState(false); // the visitor has taken over: stop stepping
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (reduced || taken || hover) return;
    const timer = setInterval(() => setStep(s => (s + 1) % STEPS.length), 4200);
    return () => clearInterval(timer);
  }, [reduced, taken, hover]);

  const id: StepId = STEPS[step].id;

  return (
    <figure
      aria-label="A sample sale, followed from the order to the profit and loss"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative w-full max-w-[520px]"
    >
      {/* The slip: a paper ticket with a torn top edge. */}
      <div className="relative rounded-2xl border border-border-strong bg-card shadow-[0_30px_60px_-30px_color-mix(in_srgb,var(--foreground)_30%,transparent)]">
        <div
          aria-hidden
          className="absolute inset-x-0 -top-[7px] h-[14px] [background:radial-gradient(circle_at_7px_7px,var(--background)_5px,transparent_5.5px)_0_0/14px_14px_repeat-x]"
        />

        <div className="flex items-center justify-between border-b border-dashed border-border-strong px-6 pb-4 pt-6">
          <span className="eyebrow">Sample · Order #1042 · Shopify</span>
          <span className="eyebrow">3 Oct</span>
        </div>

        <div className="flex items-baseline justify-between px-6 py-4">
          <div>
            <div className="font-serif text-[22px] leading-tight">Heavy Knit Cardigan</div>
            <div className="text-[13px] text-text-2">1 × £98.00 · to Ada L.</div>
          </div>
          <div className="font-serif text-[32px] tabular-nums">{gbp(SALE, 2)}</div>
        </div>

        <ol className="grid grid-cols-4 gap-1 px-4" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                aria-current={i === step ? 'step' : undefined}
                onClick={() => {
                  setStep(i);
                  setTaken(true);
                }}
                className={cn(
                  'w-full rounded-b-lg border-t-2 px-1.5 pb-2 pt-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  i === step
                    ? 'border-ramp-1 text-foreground'
                    : i < step
                      ? 'border-ramp-3 text-text-2 hover:text-foreground'
                      : 'border-border text-text-2 hover:text-foreground'
                )}
              >
                <span className="block font-mono text-[11px] tracking-[0.08em] text-muted-foreground">
                  0{i + 1}
                </span>
                <span className="block text-[13px] leading-snug">{s.label}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="min-h-[258px] px-6 pb-6 pt-5" aria-live="polite">
          {id === 'order' && <OrderStep />}
          {id === 'payment' && <PaymentStep />}
          {id === 'journal' && <JournalStep />}
          {id === 'numbers' && <NumbersStep />}
        </div>
      </div>
      <figcaption className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        Sample figures. Real shape.
      </figcaption>
    </figure>
  );
}

const Row = ({
  label,
  value,
  muted,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  muted?: boolean;
}) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5 text-[15px]">
    <span className={muted ? 'text-text-2' : undefined}>{label}</span>
    <span className="tabular-nums">{value}</span>
  </div>
);

function OrderStep() {
  return (
    <div className="rise space-y-3">
      <p className="text-[15px] text-text-2">
        Shopify tells us a customer paid. We record exactly what it said, and nothing else yet.
      </p>
      <div className="rounded-xl border bg-background px-4 py-2">
        <Row label="Items" value={gbp(SALE, 2)} />
        <Row label="Shipping" value={gbp(0, 2)} muted />
        <Row
          label="Status"
          value={<span className="font-mono text-[13px]">PAID · UNFULFILLED</span>}
          muted
        />
      </div>
      <p className="font-mono text-[12px] uppercase tracking-[0.06em] text-muted-foreground">
        Kept exactly as Shopify sent it.
      </p>
    </div>
  );
}

function PaymentStep() {
  return (
    <div className="rise space-y-3">
      <p className="text-[15px] text-text-2">
        The card clears. The processor keeps its fee, and the rest reaches your bank in a payout
        with other sales.
      </p>
      <div className="rounded-xl border bg-background px-4 py-2">
        <Row label="Card payment captured" value={gbp(SALE, 2)} />
        <Row label="Processor fee (2.9% + 20p)" value={`− ${gbp(FEE, 2)}`} muted />
        <div className="rule-double mt-1" />
        <Row label="Arrives in your bank" value={gbp(SALE - FEE, 2)} />
      </div>
      <p className="font-mono text-[12px] uppercase tracking-[0.06em] text-muted-foreground">
        The payout is recorded when it lands in the bank.
      </p>
    </div>
  );
}

function JournalStep() {
  return (
    <div className="space-y-3">
      <div className="relative">
        <p className="rise pr-28 text-[15px] text-text-2">
          Every sale becomes an entry that has to balance: what came in, and where it belongs.
        </p>
        <span
          aria-label="Posted"
          className="stamp absolute -top-1 right-0 rounded-md border-2 border-income px-2 py-0.5 font-mono text-[12px] font-medium uppercase tracking-[0.12em] text-income"
        >
          Posted
        </span>
      </div>
      <table className="rise w-full border-collapse text-[14px]" aria-label="Journal entry">
        <thead>
          <tr className="eyebrow text-left">
            <th className="pb-1.5 font-normal">Account</th>
            <th className="pb-1.5 text-right font-normal">Debit</th>
            <th className="pb-1.5 text-right font-normal">Credit</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t">
            <td className="py-2">
              <span className="font-mono text-xs text-text-2">1012</span> Merchant clearing
            </td>
            <td className="py-2 text-right tabular-nums">{gbp(SALE, 2)}</td>
            <td />
          </tr>
          <tr className="border-t">
            <td className="py-2 pl-5">
              <span className="font-mono text-xs text-text-2">4000</span> Product sales
            </td>
            <td />
            <td className="py-2 text-right tabular-nums">{gbp(SALE, 2)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <td className="rule-double pb-1.5 pt-1.5">Debits equal credits</td>
            <td className="rule-double pb-1.5 pt-1.5 text-right tabular-nums">{gbp(SALE, 2)}</td>
            <td className="rule-double pb-1.5 pt-1.5 text-right tabular-nums">{gbp(SALE, 2)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function NumbersStep() {
  return (
    <div className="rise space-y-3">
      <p className="text-[15px] text-text-2">
        Revenue goes up by exactly that line. Open the figure and the sale is the first thing in it.
      </p>
      <div className="rounded-xl border bg-background px-4 py-2">
        <Row label="Revenue, this month" value={gbp(BEFORE, 0)} muted />
        <div className="flex items-baseline justify-between gap-4 py-1.5 text-[15px]">
          <span>+ Order #1042</span>
          <span className="tabular-nums text-income">+ {gbp(SALE, 2)}</span>
        </div>
        <div className="rule-double mt-1" />
        <Row
          label="Revenue, now"
          value={<strong className="font-medium">{gbp(BEFORE + SALE, 2)}</strong>}
        />
      </div>
      <p className="font-mono text-[12px] uppercase tracking-[0.06em] text-muted-foreground">
        4000 Product sales › 1 journal › Order #1042
      </p>
    </div>
  );
}
