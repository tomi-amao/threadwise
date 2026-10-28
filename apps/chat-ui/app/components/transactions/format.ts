import type { ChipTone } from '~/components/ui/chip';
import type { FinancialTransaction } from '~/lib/api/transactions';

/** Absolute amount in a currency; the sign is shown separately so colour is never the only cue. */
export function money(amount: number, currency = 'GBP', digits = 2): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(amount));
}

export const int = (n: number): string => new Intl.NumberFormat('en-GB').format(n);

/** A file size for people: 820 B, 14 KB, 2.3 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The transaction's amount in the trading currency (GBP), falling back to its own currency. */
export const baseAmount = (t: FinancialTransaction): number => Number(t.base_amount ?? t.amount);

export const TYPE_LABEL: Record<string, string> = {
  payment: 'Payment',
  transfer: 'Transfer',
  expense: 'Expense',
  fee: 'Fee',
  fx_conversion: 'FX conversion',
  refund: 'Refund',
  funding: 'Funding',
  payout: 'Payout',
  interest: 'Interest',
  reserve_hold: 'Reserve hold',
  reserve_release: 'Reserve release',
  other: 'Other',
};

export const typeLabel = (type: string): string =>
  TYPE_LABEL[type] ?? type.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

export const SOURCE_LABEL: Record<string, string> = { revolut: 'Revolut', paypal: 'PayPal' };

export type Filing = 'excluded' | 'journalled' | 'pending';

export function filingOf(t: FinancialTransaction): Filing {
  if (t.excluded_reason) return 'excluded';
  return t.journalised_at ? 'journalled' : 'pending';
}

/** Amber is for "needs attention", so a transaction still waiting for a journal is the amber one. */
export const FILING: Record<Filing, { label: string; tone: ChipTone }> = {
  journalled: { label: 'Journalled', tone: 'done' },
  pending: { label: 'Pending', tone: 'active' },
  excluded: { label: 'Excluded', tone: 'draft' },
};

/** Local calendar day, 'YYYY-MM-DD', used to group rows. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
