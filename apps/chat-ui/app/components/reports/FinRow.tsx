import type React from 'react';
import { CaretRight } from 'phosphor-react';
import { InfoTooltip } from '~/components/ui/InfoTooltip';
import { formatGbp } from '~/lib/format-currency';

/** A single row in a financial statement table */
export function FinRow({
  label,
  amount,
  isSection,
  isTotal,
  isGrandTotal,
  indent,
  tooltip,
  negative,
  onClick,
  interactiveLabel,
}: {
  label: string;
  amount?: number;
  isSection?: boolean;
  isTotal?: boolean;
  isGrandTotal?: boolean;
  indent?: number;
  tooltip?: string;
  negative?: boolean;
  onClick?: () => void;
  interactiveLabel?: string;
}) {
  const pl = (indent || 0) * 1.25;
  const isInteractive = typeof onClick === 'function';

  if (isSection) {
    return (
      <tr>
        <td
          className="py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
          style={{ paddingLeft: `${pl}rem` }}
          colSpan={2}
        >
          <span className="flex items-center">
            {label}
            {tooltip && <InfoTooltip text={tooltip} />}
          </span>
        </td>
      </tr>
    );
  }

  const formatted =
    amount !== undefined ? (negative ? `(${formatGbp(Math.abs(amount))})` : formatGbp(amount)) : '';

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (!isInteractive) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };

  return (
    <tr
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={isInteractive ? 0 : undefined}
      role={isInteractive ? 'button' : undefined}
      aria-label={interactiveLabel}
      className={`${
        isGrandTotal ? 'border-t-2 border-foreground/20' : isTotal ? 'border-t border-border' : ''
      } ${isInteractive ? 'cursor-pointer hover:bg-muted/30 focus:outline-none focus:bg-muted/30' : ''}`}
    >
      <td
        className={`py-2 ${
          isGrandTotal
            ? 'font-bold text-foreground text-sm'
            : isTotal
              ? 'font-semibold text-foreground text-sm'
              : 'text-muted-foreground text-sm'
        }`}
        style={{ paddingLeft: `${pl}rem` }}
      >
        <span className="flex items-center gap-2">
          {label}
          {tooltip && <InfoTooltip text={tooltip} />}
          {isInteractive && !isTotal && !isGrandTotal && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              View details
              <CaretRight size={12} />
            </span>
          )}
        </span>
      </td>
      <td
        className={`py-2 text-right tabular-nums ${
          isGrandTotal
            ? 'font-bold text-foreground text-sm'
            : isTotal
              ? 'font-semibold text-foreground text-sm'
              : 'text-foreground text-sm'
        } ${amount !== undefined && amount < 0 && !negative ? 'text-rose-500' : ''}`}
      >
        {formatted}
      </td>
    </tr>
  );
}
