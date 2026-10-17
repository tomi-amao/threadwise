import * as React from 'react';
import { CaretRight } from 'phosphor-react';
import { cn } from '~/lib/utils';

/** Accounting style: negatives and deductions in brackets, e.g. (£1,200). */
export function formatAccounting(amount: number, currency = 'GBP', digits = 0): string {
  const f = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return amount < 0 ? `(${f.format(-amount)})` : f.format(amount);
}

export type StatementRow =
  | { kind: 'section'; label: React.ReactNode }
  | {
      kind: 'line' | 'total' | 'grand';
      label: React.ReactNode;
      amount: number;
      /** Show as a deduction, in brackets, whatever the sign of `amount`. */
      deduct?: boolean;
      indent?: boolean;
      /** Makes the label a button (e.g. open the entries behind an account). */
      onSelect?: () => void;
      /** Accessible name for the button, e.g. "View Online sales entries". */
      selectLabel?: string;
    };

/** Label-left, amount-right statement (P&L, balance sheet, cash flow). */
export function Statement({
  rows,
  currency = 'GBP',
  className,
}: {
  rows: StatementRow[];
  currency?: string;
  className?: string;
}) {
  return (
    <table className={cn('w-full border-collapse text-[15px]', className)}>
      <tbody>
        {rows.map((row, i) => {
          if (row.kind === 'section') {
            return (
              <tr key={i}>
                <td colSpan={2} className={cn('eyebrow border-b pb-1.5 pt-7', i === 0 && 'pt-1')}>
                  {row.label}
                </td>
              </tr>
            );
          }
          // `+ 0` turns -0 into 0, so a zero deduction reads £0 rather than -£0.
          const shown = (row.deduct ? -Math.abs(row.amount) : row.amount) + 0;
          return (
            <tr
              key={i}
              className={cn(
                row.kind === 'total' && 'border-t font-medium',
                row.kind === 'grand' && 'border-t border-t-foreground font-serif text-2xl'
              )}
            >
              <td
                className={cn(
                  row.kind === 'grand' ? 'py-4' : 'py-2.5',
                  row.kind === 'line' && 'text-text-2',
                  row.indent && 'pl-4'
                )}
              >
                {row.onSelect ? (
                  <button
                    type="button"
                    onClick={row.onSelect}
                    aria-label={row.selectLabel}
                    className="group inline-flex items-center gap-2 text-left underline decoration-transparent decoration-dotted underline-offset-4 transition-colors hover:text-accent-text hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {row.label}
                    <CaretRight
                      size={12}
                      weight="light"
                      className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </button>
                ) : (
                  row.label
                )}
              </td>
              <td
                className={cn(
                  'whitespace-nowrap pl-4 text-right tabular-nums',
                  row.kind === 'grand' ? 'py-4' : 'py-2.5'
                )}
              >
                {formatAccounting(shown, currency)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
