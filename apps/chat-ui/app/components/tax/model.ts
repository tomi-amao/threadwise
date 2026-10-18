/** Tax view helpers: formatting, and the few derived figures the page shows. */

import type { TaxData, TaxDeadline, TaxPeriod } from '~/lib/api/tax.server';

export const money = (value: number, digits = 2): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

export const int = (n: number): string => new Intl.NumberFormat('en-GB').format(n);

export function longDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function shortDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "in 12 days", "3 days past", "today". */
export function whenText(daysRemaining: number): string {
  const unit = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  if (daysRemaining === 0) return 'today';
  return daysRemaining < 0 ? `${unit(-daysRemaining)} past` : `in ${unit(daysRemaining)}`;
}

export const deadlineTitle = (d: Pick<TaxDeadline, 'kind' | 'label'>): string =>
  `${d.kind === 'payment' ? 'Pay corporation tax' : 'File the CT600'}: ${d.label}`;

/** The next obligation that is not met: overdue first, then the soonest. */
export function nextDeadline(deadlines: TaxDeadline[]): TaxDeadline | null {
  const open = deadlines.filter(d => d.status !== 'satisfied');
  open.sort(
    (a, b) =>
      Number(b.status === 'overdue') - Number(a.status === 'overdue') ||
      a.dueDate.localeCompare(b.dueDate)
  );
  return open[0] ?? null;
}

/** Review items nobody has resolved yet, across the periods the ledger can compute. */
export function unresolvedItems(data: TaxData) {
  const computable = new Set(data.periods.filter(p => p.ledgerBasis).map(p => p.periodId));
  return data.reviewItems.filter(r => !r.resolved && computable.has(r.periodId));
}

export const defaultPeriod = (data: TaxData): TaxPeriod | undefined =>
  data.lastClosedPeriod ?? data.currentPeriod ?? data.periods[0];

export const CATEGORY_LABEL: Record<string, string> = {
  entertainment: 'Entertainment',
  depreciation: 'Depreciation',
  donations: 'Donations',
  fines_and_penalties: 'Fines and penalties',
  capital_allowances: 'Capital allowances',
  other: 'Other',
};
