/**
 * Orders view model.
 *
 * An order moves To fulfil (pending, confirmed, processing) to On the way (shipped) to
 * Delivered, or ends Cancelled or Refunded. The tabs are those stages. "Sales" counts what was
 * actually kept: cancelled orders are excluded and refunds are taken off.
 */

import type { ChipTone } from '~/components/ui/chip';
import type { OrderRow } from '~/lib/api/orders.server';

export type Tab = 'fulfil' | 'shipped' | 'delivered' | 'closed' | 'all';

export const TABS: { id: Tab; label: string }[] = [
  { id: 'fulfil', label: 'To fulfil' },
  { id: 'shipped', label: 'On the way' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'closed', label: 'Cancelled or refunded' },
  { id: 'all', label: 'All' },
];

export const isTab = (v: string | null): v is Tab => TABS.some(t => t.id === v);

const TO_FULFIL = ['pending', 'confirmed', 'processing'];
const CLOSED = ['cancelled', 'refunded'];

export function inTab(order: OrderRow, tab: Tab): boolean {
  switch (tab) {
    case 'fulfil':
      return TO_FULFIL.includes(order.status);
    case 'shipped':
      return order.status === 'shipped';
    case 'delivered':
      return order.status === 'delivered';
    case 'closed':
      return CLOSED.includes(order.status);
    default:
      return true;
  }
}

export const STATUS: Record<string, { label: string; tone: ChipTone }> = {
  pending: { label: 'Pending', tone: 'active' },
  confirmed: { label: 'Confirmed', tone: 'plain' },
  processing: { label: 'Processing', tone: 'plain' },
  shipped: { label: 'Shipped', tone: 'planned' },
  delivered: { label: 'Delivered', tone: 'done' },
  cancelled: { label: 'Cancelled', tone: 'draft' },
  refunded: { label: 'Refunded', tone: 'negative' },
};

export const statusOf = (status: string) =>
  STATUS[status] ?? { label: status.replace(/_/g, ' '), tone: 'plain' as ChipTone };

/** What the business kept from an order: nothing if cancelled, otherwise the total less refunds. */
export const keptOf = (o: OrderRow): number =>
  o.status === 'cancelled' ? 0 : Math.max(0, o.grand_total - o.refunded_total);

export interface Summary {
  count: number;
  sales: number;
  refunded: number;
  refundedCount: number;
  average: number;
}

export function summarise(orders: OrderRow[]): Summary {
  const live = orders.filter(o => o.status !== 'cancelled');
  const sales = orders.reduce((s, o) => s + keptOf(o), 0);
  const refundedOrders = orders.filter(o => o.refunded_total > 0);
  return {
    count: orders.length,
    sales,
    refunded: refundedOrders.reduce((s, o) => s + o.refunded_total, 0),
    refundedCount: refundedOrders.length,
    average: live.length > 0 ? sales / live.length : 0,
  };
}

export const customerLabel = (o: Pick<OrderRow, 'customer_name' | 'customer_email'>): string =>
  o.customer_name || o.customer_email || 'Guest';

export function matchesSearch(o: OrderRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase().replace(/^#/, '');
  return (
    o.order_number.toLowerCase().replace(/^#/, '').includes(needle) ||
    (o.customer_name ?? '').toLowerCase().includes(needle) ||
    (o.customer_email ?? '').toLowerCase().includes(needle)
  );
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

export const dayOf = (iso: string): string => iso.slice(0, 10);

export function shortDate(iso: string): string {
  const [y, m, d] = dayOf(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
