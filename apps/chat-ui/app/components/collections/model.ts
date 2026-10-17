/** Collections view helpers: money and date formatting, status names, and small derivations. */

import type { ChipTone } from '~/components/ui/chip';
import type { CollectionStatus } from '~/lib/api/collections.server';

export const int = (n: number): string => new Intl.NumberFormat('en-GB').format(n);

export function money(value: number, currency = 'GBP', digits = 0): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    // A currency code Intl does not know: show the code rather than crash the page.
    return `${currency} ${int(Math.round(value))}`;
  }
}

export const pct = (value: number | null, digits = 1): string =>
  value == null ? '–' : `${value.toFixed(digits)}%`;

export function shortDate(value: string | null): string {
  if (!value) return '–';
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const STATUS: Record<CollectionStatus, { label: string; tone: ChipTone }> = {
  active: { label: 'Active', tone: 'active' },
  planned: { label: 'Planned', tone: 'planned' },
  completed: { label: 'Completed', tone: 'done' },
  draft: { label: 'Draft', tone: 'draft' },
  archived: { label: 'Archived', tone: 'plain' },
};

/** "fabric_and_trim_6100" or "freight_in" as a readable label. */
export function prettyType(value: string): string {
  const text = value
    .replace(/_\d{3,5}$/, '')
    .replace(/_/g, ' ')
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Other';
}

export type TabId = 'overview' | 'plan' | 'products' | 'costs';
export const TAB_IDS: TabId[] = ['overview', 'plan', 'products', 'costs'];
export const isTab = (v: string | null): v is TabId => TAB_IDS.includes(v as TabId);

export const COLLECTION_TYPES = ['Seasonal', 'Capsule', 'Collaboration', 'Core range', 'Clearance'];
