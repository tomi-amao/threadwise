/**
 * Shared GBP currency formatters.
 *
 * This exact formatter is currently also duplicated locally in several
 * route files (app.inventory.tsx, app.journals.tsx, app.products.tsx,
 * app.tax.tsx, api.tax.ct600-pack.tsx, api.reports.cash-flow-pack.tsx) —
 * consolidating all of those is a separate cleanup, out of scope here.
 * This file exists so extracting components out of app.reports.tsx
 * doesn't add a ninth copy of the same formatter.
 */

export const formatGbp = (value: number): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export const formatGbp0 = (value: number): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
