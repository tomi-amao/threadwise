/**
 * BreakdownDrawer: how a period's profit per the accounts is made up, account by account. Each
 * account links to the Reports page with that account's journals open for the same dates.
 */

import { Link } from 'react-router';
import { ArrowSquareOut } from 'phosphor-react';
import { Drawer } from '~/components/ui/drawer';
import { Eyebrow } from '~/components/ui/eyebrow';
import type { ProfitBreakdownLine, TaxPeriod } from '~/lib/api/tax.server';
import { int, money } from './model';

const GROUPS: { type: ProfitBreakdownLine['accountType']; label: string }[] = [
  { type: 'revenue', label: 'Revenue' },
  { type: 'cogs', label: 'Cost of goods sold' },
  { type: 'expense', label: 'Operating expenses' },
];

export function BreakdownDrawer({
  period,
  lines,
  open,
  onClose,
}: {
  period: TaxPeriod | undefined;
  lines: ProfitBreakdownLine[];
  open: boolean;
  onClose: () => void;
}) {
  const total = (type: ProfitBreakdownLine['accountType']) =>
    lines.filter(l => l.accountType === type).reduce((s, l) => s + l.balance, 0);
  const profit = total('revenue') - total('cogs') - total('expense');

  return (
    <Drawer
      open={open && !!period}
      onOpenChange={o => !o && onClose()}
      eyebrow={period?.label ?? 'Period'}
      title="Profit per the accounts"
      description="The accounts that make up this period's profit"
      className="w-[min(560px,100vw)]"
    >
      {period && (
        <>
          <p className="text-[14px] text-text-2">
            Revenue less cost of goods sold less operating expenses, from posted journals dated
            within the period. Select an account to see its journals.
          </p>
          {GROUPS.map(group => {
            const rows = lines.filter(l => l.accountType === group.type);
            if (rows.length === 0) return null;
            return (
              <section key={group.type} aria-label={group.label} className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <Eyebrow>{group.label}</Eyebrow>
                  <span className="tabular-nums">{money(total(group.type))}</span>
                </div>
                <ul className="divide-y rounded-xl border">
                  {rows.map(line => (
                    <li key={line.accountId}>
                      <Link
                        to={`/reports?tab=pnl&from=${period.startDate}&to=${period.endDate}&account=${line.accountId}&statement=pnl&name=${encodeURIComponent(line.accountName)}&code=${line.accountNumber}`}
                        className="flex items-baseline justify-between gap-3 px-3.5 py-2.5 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="min-w-0 truncate text-[15px]">
                          <span className="font-mono text-xs text-text-2">
                            {line.accountNumber}
                          </span>{' '}
                          {line.accountName}
                          <span className="ml-2 text-[13px] text-text-2">
                            {int(line.lineCount)} {line.lineCount === 1 ? 'entry' : 'entries'}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                          {money(Math.abs(line.balance))}
                          <ArrowSquareOut size={13} aria-hidden className="text-text-2" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <div className="flex items-baseline justify-between border-t pt-4">
            <span className="text-[15px] font-medium">Profit per the accounts</span>
            <span className="font-serif text-[26px] tabular-nums">{money(profit)}</span>
          </div>
        </>
      )}
    </Drawer>
  );
}
