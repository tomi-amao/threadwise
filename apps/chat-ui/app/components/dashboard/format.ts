/** Formatting helpers for the dashboard. Money keeps the entity's currency; all copy is en-GB. */

export function money(value: number, currency = 'GBP', digits = 0): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export const int = (value: number): string =>
  new Intl.NumberFormat('en-GB').format(Math.round(value));

export const pct = (value: number, digits = 0): string => `${value.toFixed(digits)}%`;

/** Percentage that never divides by zero. */
export const share = (part: number, whole: number): number =>
  whole > 0 ? (part / whole) * 100 : 0;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * '2026-04' -> 'Apr 26'. Always three letters: en-GB's own short form gives 'Sept', which makes
 * one axis label wider than the rest.
 */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  return `${MONTHS[Number(m) - 1]} ${year.slice(2)}`;
}

export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** 'partially_refunded' -> 'Partially Refunded'. */
export const titleCase = (value: string): string =>
  value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Gateway and method as one readable name: 'Shopify Payments · Card'. */
export function paymentName(gateway: string, method: string): string {
  const g = titleCase(gateway);
  return method === 'Unknown' || method === gateway ? g : `${g} · ${titleCase(method)}`;
}
