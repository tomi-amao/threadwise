/**
 * Shared Nivo theme. Colours are CSS variables, so charts follow the light/dark theme
 * with no per-chart colour props (SVG attributes accept var(); Nivo passes strings through).
 */

export const CHART_COLORS = [
  'var(--ramp-1)',
  'var(--plum)',
  'var(--ramp-2)',
  'var(--ramp-3)',
  'var(--ramp-4)',
  'var(--ramp-5)',
] as const;

export const nivoTheme = {
  background: 'transparent',
  text: { fill: 'var(--muted-foreground)', fontSize: 11, fontFamily: 'var(--font-mono)' },
  axis: {
    domain: { line: { stroke: 'var(--border)', strokeWidth: 1 } },
    ticks: {
      line: { stroke: 'transparent' },
      text: { fill: 'var(--muted-foreground)', fontSize: 11, fontFamily: 'var(--font-mono)' },
    },
    legend: { text: { fill: 'var(--muted-foreground)', fontSize: 11 } },
  },
  grid: { line: { stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '2 4' } },
  legends: { text: { fill: 'var(--text-2)', fontSize: 12 } },
  crosshair: { line: { stroke: 'var(--border-strong)', strokeWidth: 1 } },
  tooltip: { container: { background: 'transparent', padding: 0, boxShadow: 'none' } },
} as const;

/** £12k, £1.2m, £850. For axes, where space is tight. */
export function compactMoney(value: number, currency = 'GBP'): string {
  const symbol = currency === 'GBP' ? '£' : '';
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1_000_000)
    return `${sign}${symbol}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
  if (abs >= 1_000) return `${sign}${symbol}${Math.round(abs / 1_000)}k`;
  return `${sign}${symbol}${Math.round(abs)}`;
}

export function fullMoney(value: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}
