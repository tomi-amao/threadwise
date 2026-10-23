import type { Cell, Format } from './catalogue';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-18 -> 18 Oct 2026. Parsed by hand: a date-only string must not shift by timezone. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** 2026-10 -> Oct 2026 (a month label from the tools); anything else unchanged. */
export function formatMonth(label: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : label;
}

export function formatMoney(value: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCell(value: Cell | undefined, format: Format, currency = 'GBP'): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (format) {
    case 'money':
      return typeof value === 'number' ? formatMoney(value, currency) : String(value);
    case 'number':
      return typeof value === 'number' ? value.toLocaleString('en-GB') : String(value);
    case 'percent':
      return typeof value === 'number' ? `${value.toLocaleString('en-GB')}%` : String(value);
    case 'date':
      return formatDate(String(value));
    default:
      return String(value);
  }
}

export function isNumeric(format: Format): boolean {
  return format === 'money' || format === 'number' || format === 'percent';
}

/** The page a link opens, for its visible text: /reports?from=... -> Reports. */
export function pageName(link: string): string {
  const segment = link.split(/[?#]/)[0].split('/').filter(Boolean)[0] ?? '';
  return segment ? segment.charAt(0).toUpperCase() + segment.slice(1) : 'the app';
}
