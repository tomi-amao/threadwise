/**
 * Products view model.
 *
 * A product is Selling if it sold in the last SLOWING_AFTER_DAYS days, Slowing if it has sold but
 * not recently, and Never sold if it has no sales at all. Revenue share is of the revenue of
 * everything on the list, not of the current filter, so a product's share does not change as the
 * search narrows.
 */

import type { ChipTone } from '~/components/ui/chip';
import type { ProductRow } from '~/lib/api/products.server';

export const SLOWING_AFTER_DAYS = 90;

export type Tab = 'all' | 'selling' | 'slowing' | 'never';
export type Sort = 'revenue' | 'units' | 'price' | 'name';

export const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'selling', label: 'Selling' },
  { id: 'slowing', label: 'Slowing' },
  { id: 'never', label: 'Never sold' },
];
export const isTab = (v: string | null): v is Tab => TABS.some(t => t.id === v);

export const SORTS: { value: Sort; label: string }[] = [
  { value: 'revenue', label: 'Revenue' },
  { value: 'units', label: 'Units sold' },
  { value: 'price', label: 'Price' },
  { value: 'name', label: 'Name' },
];
export const isSort = (v: string | null): v is Sort => SORTS.some(s => s.value === v);

const dayOf = (iso: string): string => iso.slice(0, 10);
const dayNumber = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};
export const daysSince = (iso: string, today: string): number =>
  dayNumber(today) - dayNumber(dayOf(iso));

export type Stage = 'selling' | 'slowing' | 'never';

export function stageOf(p: ProductRow, today: string): Stage {
  if (!p.last_sold_at) return 'never';
  return daysSince(p.last_sold_at, today) > SLOWING_AFTER_DAYS ? 'slowing' : 'selling';
}

export const STAGE: Record<Stage, { label: string; tone: ChipTone }> = {
  selling: { label: 'Selling', tone: 'done' },
  slowing: { label: 'Slowing', tone: 'active' },
  never: { label: 'Never sold', tone: 'draft' },
};

export const inTab = (p: ProductRow, tab: Tab, today: string): boolean =>
  tab === 'all' || stageOf(p, today) === tab;

export function sorter(sort: Sort): (a: ProductRow, b: ProductRow) => number {
  switch (sort) {
    case 'units':
      return (a, b) => b.units - a.units || b.revenue - a.revenue || a.name.localeCompare(b.name);
    case 'price':
      return (a, b) => b.average_price - a.average_price || a.name.localeCompare(b.name);
    case 'name':
      return (a, b) => a.name.localeCompare(b.name);
    default:
      return (a, b) => b.revenue - a.revenue || b.units - a.units || a.name.localeCompare(b.name);
  }
}

export interface Summary {
  count: number;
  units: number;
  revenue: number;
  top: ProductRow | null;
}

export function summarise(products: ProductRow[]): Summary {
  const top = [...products].sort(sorter('revenue'))[0] ?? null;
  return {
    count: products.length,
    units: products.reduce((s, p) => s + p.units, 0),
    revenue: products.reduce((s, p) => s + p.revenue, 0),
    top: top && top.revenue > 0 ? top : null,
  };
}

export const matchesSearch = (p: ProductRow, q: string): boolean =>
  !q || p.name.toLowerCase().includes(q.toLowerCase());

export function money(amount: number, currency = 'GBP', digits = 0): string {
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

export function ago(iso: string | null, today: string): string {
  if (!iso) return 'Never';
  const days = daysSince(iso, today);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}
