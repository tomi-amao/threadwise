/**
 * Mock data for the Dashboard v2 preview. Shapes follow app/types/dashboard.ts,
 * but headline totals are derived from the monthly rows so the page ties.
 */

import type {
  BankAccountSummary,
  CustomerSummary,
  OrderStatusBreakdown,
  PaymentMethodBreakdown,
  ProductPerformance,
  RecentOrder,
} from '~/types/dashboard';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Spread a total across weights; the last bucket takes the rounding remainder. */
function split(total: number, weights: number[]) {
  const w = sum(weights);
  const out = weights.map(x => Math.round((x / w) * total));
  out[out.length - 1] += total - sum(out);
  return out;
}

export interface MonthPoint {
  month: string; // YYYY-MM
  label: string;
  revenue: number;
  orders: number;
}

const MONTH_REV = [
  11800, 26400, 34100, 9300, 8200, 12900, 55200, 18400, 11200, 9700, 14800, 51900, 15100,
];
export const MONTHLY: MonthPoint[] = MONTH_REV.map((revenue, i) => {
  const d = new Date(2025, 9 + i, 1);
  return {
    month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
    revenue,
    orders: Math.round(revenue / (68 + (i % 5) * 5)),
  };
});

const grossRevenue = sum(MONTHLY.map(m => m.revenue));
const totalOrders = sum(MONTHLY.map(m => m.orders));
const refunds = Math.round(grossRevenue * 0.046);
const processingFees = Math.round(grossRevenue * 0.031);

export const BANK_ACCOUNTS: BankAccountSummary[] = [
  { id: 'b1', name: 'Revolut Business', currency: 'GBP', balance: 41236.52, source: 'revolut' },
  { id: 'b2', name: 'Revolut Savings', currency: 'GBP', balance: 4580.0, source: 'revolut' },
  { id: 'b3', name: 'PayPal', currency: 'GBP', balance: 2503.48, source: 'paypal' },
];

export const KPIS = {
  grossRevenue,
  netRevenue: grossRevenue - refunds - processingFees,
  totalOrders,
  avgOrderValue: grossRevenue / totalOrders,
  totalCustomers: 1312,
  totalBankBalance: sum(BANK_ACCOUNTS.map(a => a.balance)),
  totalRefunds: refunds,
  processingFees,
};

export const CUSTOMER_STATS = {
  total: 1312,
  withOrders: 1118,
  repeat: 341,
  repeatRate: (341 / 1118) * 100,
};

const STATUS_ORDER: [string, number][] = [
  ['delivered', 0.58],
  ['paid', 0.1],
  ['shipped', 0.1],
  ['processing', 0.07],
  ['pending', 0.05],
  ['refunded', 0.04],
  ['partially_refunded', 0.03],
  ['cancelled', 0.03],
];
export const ORDER_STATUSES: OrderStatusBreakdown[] = split(
  totalOrders,
  STATUS_ORDER.map(s => s[1])
).map((count, i) => ({
  status: STATUS_ORDER[i][0],
  count,
}));

export const TOP_PRODUCTS: ProductPerformance[] = [
  ['Heavy Knit Cardigan', 219, 21480],
  ['Wool Overshirt', 140, 17360],
  ['Selvedge Work Trouser', 105, 14175],
  ['Linen Camp Shirt', 130, 9880],
  ['Merino Scarf', 130, 7540],
  ['Brushed Cotton Tee', 165, 6930],
  ['Canvas Tote', 148, 5328],
  ['Rib Beanie', 150, 4200],
].map(([name, qty, rev], i) => ({
  id: `p${i}`,
  name: name as string,
  totalQuantity: qty as number,
  totalRevenue: rev as number,
  orderCount: Math.round((qty as number) * 0.8),
}));

const captured = Math.round(grossRevenue * 0.953);
const PAY: [string, string, number][] = [
  ['shopify_payments', 'card', 0.58],
  ['paypal', 'paypal', 0.24],
  ['shopify_payments', 'apple_pay', 0.12],
  ['klarna', 'klarna', 0.06],
];
export const PAYMENTS: PaymentMethodBreakdown[] = split(
  captured,
  PAY.map(p => p[2])
).map((totalAmount, i) => ({
  gateway: PAY[i][0],
  method: PAY[i][1],
  totalAmount,
  count: Math.round(totalOrders * PAY[i][2]),
}));

export const TOP_CUSTOMERS: CustomerSummary[] = [
  ['Amara Okafor', 'amara.o@example.com', 14, 1862, '2026-10-02'],
  ['Jonas Weber', 'jonas.w@example.com', 11, 1544, '2026-09-28'],
  ['Priya Nair', 'priya.n@example.com', 9, 1297, '2026-10-08'],
  ['Tom Hartley', 'tom.h@example.com', 8, 1105, '2026-08-19'],
  ['Elena Rossi', 'elena.r@example.com', 7, 986, '2026-10-05'],
  ['Sam Whitfield', 'sam.w@example.com', 7, 941, '2026-09-30'],
].map(
  ([name, email, orderCount, totalSpent, lastOrderDate], i) =>
    ({ id: `c${i}`, name, email, orderCount, totalSpent, lastOrderDate }) as CustomerSummary
);

const ORD: [string, string, string, number, number][] = [
  ['4838', 'Mina Patel', 'processing', 142, 2],
  ['4837', 'Luca Bianchi', 'paid', 98, 1],
  ['4836', 'Chloe Martin', 'shipped', 213.5, 3],
  ['4835', 'Daniel Osei', 'delivered', 76, 1],
  ['4834', 'Amara Okafor', 'delivered', 249, 2],
  ['4833', 'Ines Duarte', 'pending', 58, 1],
  ['4832', 'Jonas Weber', 'shipped', 187, 2],
  ['4831', 'Hannah Cole', 'partially_refunded', 134, 2],
  ['4830', 'Kofi Mensah', 'delivered', 124, 1],
  ['4829', 'Priya Nair', 'refunded', 98, 1],
];
export const RECENT_ORDERS: RecentOrder[] = ORD.map(([n, name, status, total, items], i) => ({
  id: `o${n}`,
  orderNumber: `#${n}`,
  customerName: name,
  customerEmail: null,
  status,
  grandTotal: total,
  currency: 'GBP',
  createdAt: new Date(2026, 9, 11 - Math.floor(i / 2), 17 - i, 12).toISOString(),
  itemCount: items,
}));

export const ENTITY_NAME = 'Atelier North';
export { sum };
