/**
 * Invoice view model: what the page shows, derived from the rows.
 *
 * Direction. A SALE invoice is money owed to the business, a PURCHASE invoice is money the
 * business owes. The page says "Owed to you" and "You owe" rather than Sale and Purchase,
 * which are accounting words for the same thing.
 *
 * Stage. An invoice moves To review (a draft: uploaded and extracted, not yet posted) to Open
 * (finalised, awaiting payment) to Paid. Overdue is not a stage but a state of Open: the
 * database only has OVERDUE if a person sets it, so an unpaid invoice past its due date is
 * shown as overdue here (the same rule as ai_agent's invoice_rules.effective_status).
 *
 * Totals only add invoices in the business's own currency. The invoice rows carry a
 * currency and an fx_rate, but the agent does not convert them when it journals, so a
 * converted headline would disagree with the ledger.
 */

import type { ChipTone } from '~/components/ui/chip';
import type { InvoiceRow, InvoiceStatus, InvoiceType } from '~/types/invoice';

export const DIRECTION: Record<InvoiceType, { label: string; short: string }> = {
  SALE: { label: 'Owed to you', short: 'In' },
  PURCHASE: { label: 'You owe', short: 'Out' },
};

export type Tab = 'review' | 'open' | 'paid' | 'all';

export const TABS: { id: Tab; label: string }[] = [
  { id: 'review', label: 'To review' },
  { id: 'open', label: 'Open' },
  { id: 'paid', label: 'Paid' },
  { id: 'all', label: 'All' },
];

export const isTab = (v: string | null): v is Tab => TABS.some(t => t.id === v);

const UNPAID: readonly InvoiceStatus[] = ['OPEN', 'OVERDUE', 'PARTIALLY_PAID'];

/** 'YYYY-MM-DD' from any ISO timestamp: the calendar day it was written for. */
export const dayOf = (iso: string): string => iso.slice(0, 10);

const dayNumber = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** The status to show: an unpaid, finalised invoice past its due date is overdue. */
export function shownStatus(inv: InvoiceRow, today: string): InvoiceStatus {
  if ((inv.status === 'OPEN' || inv.status === 'PARTIALLY_PAID') && inv.due_date) {
    return dayOf(inv.due_date) < today ? 'OVERDUE' : inv.status;
  }
  return inv.status;
}

export const STATUS: Record<InvoiceStatus, { label: string; tone: ChipTone }> = {
  DRAFT: { label: 'To review', tone: 'active' },
  OPEN: { label: 'Open', tone: 'plain' },
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  PARTIALLY_PAID: { label: 'Part paid', tone: 'planned' },
  PAID: { label: 'Paid', tone: 'done' },
  CANCELLED: { label: 'Cancelled', tone: 'draft' },
  VOID: { label: 'Void', tone: 'draft' },
};

export function inTab(inv: InvoiceRow, tab: Tab): boolean {
  switch (tab) {
    case 'review':
      return inv.status === 'DRAFT';
    case 'open':
      return UNPAID.includes(inv.status);
    case 'paid':
      return inv.status === 'PAID';
    default:
      return true;
  }
}

/** Open invoices are worked soonest-due first; everything else newest first. */
export function sortFor(tab: Tab): (a: InvoiceRow, b: InvoiceRow) => number {
  if (tab === 'open') {
    return (a, b) =>
      (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
      a.invoice_number.localeCompare(b.invoice_number);
  }
  return (a, b) =>
    b.invoice_date.localeCompare(a.invoice_date) || b.created_at.localeCompare(a.created_at);
}

export interface DueText {
  text: string;
  overdue: boolean;
}

/** "Due in 12 days", "Due today", "5 days overdue". Only meaningful for unpaid invoices. */
export function dueText(inv: InvoiceRow, today: string): DueText | null {
  if (!inv.due_date) return null;
  const days = daysBetween(today, dayOf(inv.due_date));
  const unit = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  if (days < 0) return { text: `${unit(-days)} overdue`, overdue: true };
  if (days === 0) return { text: 'Due today', overdue: false };
  return { text: `Due in ${unit(days)}`, overdue: false };
}

export interface Side {
  amount: number;
  count: number;
  overdueAmount: number;
  overdueCount: number;
}

export interface Summary {
  owedToYou: Side;
  youOwe: Side;
  overdueCount: number;
  toReview: number;
  /** Unpaid invoices in another currency, left out of the amounts above. */
  otherCurrency: number;
}

const emptySide = (): Side => ({ amount: 0, count: 0, overdueAmount: 0, overdueCount: 0 });

export function summarise(invoices: InvoiceRow[], today: string, base: string): Summary {
  const summary: Summary = {
    owedToYou: emptySide(),
    youOwe: emptySide(),
    overdueCount: 0,
    toReview: 0,
    otherCurrency: 0,
  };
  for (const inv of invoices) {
    if (inv.status === 'DRAFT') summary.toReview += 1;
    if (!UNPAID.includes(inv.status)) continue;
    if (inv.currency !== base) {
      summary.otherCurrency += 1;
      continue;
    }
    const side = inv.invoice_type === 'SALE' ? summary.owedToYou : summary.youOwe;
    side.amount += inv.gross_amount;
    side.count += 1;
    if (shownStatus(inv, today) === 'OVERDUE') {
      side.overdueAmount += inv.gross_amount;
      side.overdueCount += 1;
      summary.overdueCount += 1;
    }
  }
  return summary;
}

export function money(amount: number, currency = 'GBP', digits = 2): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

export const int = (n: number): string => new Intl.NumberFormat('en-GB').format(n);

export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = dayOf(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Counterparty as people know them: the company if there is one, else the contact name. */
export const counterpartyName = (inv: Pick<InvoiceRow, 'contacts'>): string =>
  inv.contacts?.company_name || inv.contacts?.name || 'Unknown counterparty';

export function matchesSearch(inv: InvoiceRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    inv.invoice_number.toLowerCase().includes(needle) ||
    counterpartyName(inv).toLowerCase().includes(needle) ||
    (inv.contacts?.name ?? '').toLowerCase().includes(needle)
  );
}
