/**
 * Reports view helpers: formatting, and the few derived numbers the page shows that the server
 * does not already compute.
 */

import type { MonthlyRow, ReportsData } from '~/lib/api/reports.server';

export const money = (value: number, digits = 2): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

export const int = (value: number): string => new Intl.NumberFormat('en-GB').format(value);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-04' to 'Apr 26'. */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  return `${MONTHS[Number(m) - 1]} ${year.slice(2)}`;
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const titleCase = (value: string | null | undefined): string =>
  value
    ? value
        .replace(/[_-]+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase())
    : 'Unknown';

/** Spend the monthly table calls "Other outbound & expenses": opex beyond shipping, plus other outbound cash. */
export const otherOutboundOf = (m: MonthlyRow): number =>
  Math.max(m.operatingExpenses - m.shippingCost, 0) + m.otherOutbound;

export interface MonthlyTotals {
  totalSales: number;
  discounts: number;
  returns: number;
  processingFees: number;
  cogs: number;
  shippingCost: number;
  otherOutbound: number;
  netIncome: number;
  orders: number;
}

export function monthlyTotals(monthly: MonthlyRow[]): MonthlyTotals {
  return monthly.reduce<MonthlyTotals>(
    (t, m) => ({
      totalSales: t.totalSales + m.totalSales,
      discounts: t.discounts + m.discounts,
      returns: t.returns + m.returns,
      processingFees: t.processingFees + m.processingFees,
      cogs: t.cogs + m.cogs,
      shippingCost: t.shippingCost + m.shippingCost,
      otherOutbound: t.otherOutbound + otherOutboundOf(m),
      netIncome: t.netIncome + m.netIncome,
      orders: t.orders + m.orders,
    }),
    {
      totalSales: 0,
      discounts: 0,
      returns: 0,
      processingFees: 0,
      cogs: 0,
      shippingCost: 0,
      otherOutbound: 0,
      netIncome: 0,
      orders: 0,
    }
  );
}

/** Does the ledger (profit and loss) have anything in this period? */
export const hasProfitAndLoss = (data: ReportsData): boolean =>
  data.accountingPnL.sections.some(s => s.accounts.length > 0) ||
  data.accountingPnL.netIncome !== 0;

export const hasBalanceSheet = (data: ReportsData): boolean =>
  data.balanceSheet.assets.length > 0 ||
  data.balanceSheet.liabilities.length > 0 ||
  data.balanceSheet.equity.length > 0;

/** Whether the balance sheet balances, to the penny. */
export const isBalanced = (data: ReportsData): boolean =>
  Math.abs(data.balanceSheet.balanceCheck) < 0.01;

export type DrilldownTarget = {
  accountId: string;
  accountName: string;
  accountCode: number;
  statement: 'pnl' | 'balance';
};
