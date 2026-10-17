/** Journals view model: names for the accounting words, and the filters the ledger applies. */

import type { ChipTone } from '~/components/ui/chip';
import type { JournalRow, JournalStatus } from '~/lib/api/journals.server';

export const money = (value: number, digits = 2): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

export const int = (n: number): string => new Intl.NumberFormat('en-GB').format(n);

export function shortDate(day: string): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const TYPE_LABEL: Record<string, string> = {
  accrual: 'Sale accrued',
  settlement: 'Payout',
  adjustment: 'Adjustment',
  reversal: 'Reversal',
  purchase: 'Purchase',
  expense: 'Expense',
  payment: 'Payment',
  funding: 'Funding',
  sales_receipt: 'Sales receipt',
  refund: 'Refund',
  fx_conversion: 'Currency exchange',
  receipt: 'Receipt',
};
export const typeLabel = (type: string): string =>
  TYPE_LABEL[type] ?? type.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

const SOURCE_LABEL: Record<string, string> = {
  manual: 'By hand',
  invoice: 'Invoice',
  payment: 'Order payment',
  financial_transaction: 'Bank line',
  order: 'Order',
};
export const sourceLabel = (source: string | null): string =>
  source === null
    ? 'System'
    : (SOURCE_LABEL[source] ?? source.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));

/** Where the thing a journal came from lives in the app, when it has a page. */
export function sourceLink(source: string | null, id: string | null): string | null {
  if (!source || !id) return null;
  if (source === 'invoice') return `/invoices?invoice=${id}`;
  if (source === 'financial_transaction') return `/transactions?transactionId=${id}`;
  return null;
}

export const STATUS: Record<JournalStatus, { label: string; tone: ChipTone }> = {
  posted: { label: 'Posted', tone: 'done' },
  draft: { label: 'Needs review', tone: 'active' },
  reversed: { label: 'Reversed', tone: 'draft' },
};

export type Tab = 'ledger' | 'review';
export const isTab = (v: string | null): v is Tab => v === 'ledger' || v === 'review';

export type StatusFilter = 'all' | 'posted' | 'reversed';
export type SourceFilter = 'all' | 'manual' | 'auto';

export interface LedgerFilters {
  q: string;
  status: StatusFilter;
  source: SourceFilter;
  type: string;
  from: string;
  to: string;
}

export function applyFilters(rows: JournalRow[], f: LedgerFilters): JournalRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(r => {
    if (r.status === 'draft') return false;
    if (f.status !== 'all' && r.status !== f.status) return false;
    if (f.source === 'manual' && !r.manual) return false;
    if (f.source === 'auto' && r.manual) return false;
    if (f.type !== 'all' && r.type !== f.type) return false;
    if (f.from && r.date < f.from) return false;
    if (f.to && r.date > f.to) return false;
    if (q) {
      const hay = `${r.description} ${typeLabel(r.type)} ${r.accounts.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function summarise(rows: JournalRow[]) {
  const posted = rows.filter(r => r.status === 'posted');
  return {
    posted: posted.length,
    drafts: rows.filter(r => r.status === 'draft').length,
    manual: posted.filter(r => r.manual).length,
    reversed: rows.filter(r => r.status === 'reversed').length,
    latest: posted.reduce((m, r) => (r.date > m ? r.date : m), ''),
  };
}

/** The types a person can choose when writing a journal by hand. */
export const MANUAL_TYPES_UI = [
  { value: 'adjustment', label: 'Adjustment' },
  { value: 'accrual', label: 'Accrual' },
  { value: 'expense', label: 'Expense' },
  { value: 'payment', label: 'Payment' },
  { value: 'funding', label: 'Funding' },
] as const;
