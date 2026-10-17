/**
 * Customers view model.
 *
 * Segments describe where a customer is in their relationship with the business:
 *  - Repeat: two or more orders
 *  - One-time: a single order
 *  - Lapsed: has ordered, but not in the last LAPSED_AFTER_DAYS days
 *  - Never ordered: on the books (a sign-up, an import) with no order
 * Repeat and Lapsed overlap (a regular who has gone quiet is both), so a customer can be in
 * more than one tab; the chip shows the most useful label.
 */

import type { ChipTone } from '~/components/ui/chip';
import type { CustomerRow } from '~/lib/api/customers.server';

export const LAPSED_AFTER_DAYS = 90;

export type Tab = 'all' | 'repeat' | 'one-time' | 'lapsed' | 'never';
export type Sort = 'spent' | 'orders' | 'recent' | 'name';

export const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'repeat', label: 'Repeat buyers' },
  { id: 'one-time', label: 'One-time' },
  { id: 'lapsed', label: 'Lapsed' },
  { id: 'never', label: 'Never ordered' },
];
export const isTab = (v: string | null): v is Tab => TABS.some(t => t.id === v);

export const SORTS: { value: Sort; label: string }[] = [
  { value: 'spent', label: 'Top spend' },
  { value: 'orders', label: 'Most orders' },
  { value: 'recent', label: 'Latest order' },
  { value: 'name', label: 'Name' },
];
export const isSort = (v: string | null): v is Sort => SORTS.some(s => s.value === v);

export const dayOf = (iso: string): string => iso.slice(0, 10);
const dayNumber = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};
export const daysSince = (iso: string, today: string): number =>
  dayNumber(today) - dayNumber(dayOf(iso));

export const isLapsed = (c: CustomerRow, today: string): boolean =>
  !!c.last_order_at && daysSince(c.last_order_at, today) > LAPSED_AFTER_DAYS;

export function inTab(c: CustomerRow, tab: Tab, today: string): boolean {
  switch (tab) {
    case 'repeat':
      return c.orders >= 2;
    case 'one-time':
      return c.orders === 1;
    case 'lapsed':
      return isLapsed(c, today);
    case 'never':
      return c.orders === 0;
    default:
      return true;
  }
}

export interface SegmentLabel {
  label: string;
  tone: ChipTone;
}

/** The one label to show on a row. Lapsed outranks repeat: it is the one to act on. */
export function segmentOf(c: CustomerRow, today: string): SegmentLabel {
  if (c.orders === 0) return { label: 'Never ordered', tone: 'draft' };
  if (isLapsed(c, today)) return { label: 'Lapsed', tone: 'active' };
  if (c.orders >= 2) return { label: 'Repeat', tone: 'income' };
  return { label: 'One-time', tone: 'plain' };
}

export function sorter(sort: Sort): (a: CustomerRow, b: CustomerRow) => number {
  switch (sort) {
    case 'orders':
      return (a, b) => b.orders - a.orders || b.spent - a.spent || a.name.localeCompare(b.name);
    case 'recent':
      return (a, b) =>
        (b.last_order_at ?? '').localeCompare(a.last_order_at ?? '') ||
        a.name.localeCompare(b.name);
    case 'name':
      return (a, b) => a.name.localeCompare(b.name);
    default:
      return (a, b) => b.spent - a.spent || b.orders - a.orders || a.name.localeCompare(b.name);
  }
}

export interface Summary {
  total: number;
  withOrders: number;
  repeat: number;
  /** Share of customers who have ordered that ordered again, 0 to 1. */
  repeatRate: number;
  spent: number;
  averageValue: number;
  top: CustomerRow | null;
}

export function summarise(customers: CustomerRow[]): Summary {
  const buyers = customers.filter(c => c.orders > 0);
  const spent = buyers.reduce((s, c) => s + c.spent, 0);
  const repeat = buyers.filter(c => c.orders >= 2).length;
  const top = [...buyers].sort((a, b) => b.spent - a.spent)[0] ?? null;
  return {
    total: customers.length,
    withOrders: buyers.length,
    repeat,
    repeatRate: buyers.length > 0 ? repeat / buyers.length : 0,
    spent,
    averageValue: buyers.length > 0 ? spent / buyers.length : 0,
    top,
  };
}

export function matchesSearch(c: CustomerRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return c.name.toLowerCase().includes(needle) || (c.email ?? '').toLowerCase().includes(needle);
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

export function shortDate(iso: string): string {
  const [y, m, d] = dayOf(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "Today", "Yesterday", "12 days ago", "5 months ago". */
export function ago(iso: string | null, today: string): string {
  if (!iso) return '—';
  const days = daysSince(iso, today);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}
