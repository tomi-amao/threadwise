/**
 * Orders: server-side reads.
 *
 * `orders`, `order_line_items` and `payments` have no row-level security, so these read with the
 * service role. Every query is filtered by `entityId`, which callers take from
 * getUserEntity() (the signed-in user's own business), never from the request.
 */

import { getServerSupabaseClient } from '~/lib/supabase';
import { fetchAllRows } from './paginate.server';

export interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  fulfillment_status: string;
  grand_total: number;
  refunded_total: number;
  currency: string;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
}

interface OrderDbRow {
  id: string;
  order_number: string;
  status: string;
  fulfillment_status: string;
  grand_total_amount: number | string;
  refunded_total_amount: number | string | null;
  currency: string | null;
  created_at: string;
  customer_id: string | null;
  customer_email: string | null;
  customers: { first_name: string | null; last_name: string | null } | null;
}

const name = (c: OrderDbRow['customers']): string | null =>
  c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || null : null;

/** Every order for the business, newest first. Read in full: see paginate.server. */
export async function getOrders(entityId: string): Promise<OrderRow[]> {
  const supabase = getServerSupabaseClient();
  const rows = await fetchAllRows<OrderDbRow>('orders', (from, to) =>
    supabase
      .from('orders')
      .select(
        'id, order_number, status, fulfillment_status, grand_total_amount, ' +
          'refunded_total_amount, currency, created_at, customer_id, customer_email, ' +
          'customers(first_name, last_name)'
      )
      .eq('entity_id', entityId)
      .order('id')
      .range(from, to)
  );
  return rows
    .map(r => ({
      id: r.id,
      order_number: r.order_number,
      status: r.status,
      fulfillment_status: r.fulfillment_status,
      grand_total: Number(r.grand_total_amount),
      refunded_total: Number(r.refunded_total_amount ?? 0),
      currency: r.currency ?? 'GBP',
      created_at: r.created_at,
      customer_id: r.customer_id,
      customer_name: name(r.customers),
      customer_email: r.customer_email,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export interface OrderLine {
  id: string;
  product_id: string | null;
  product_name: string;
  variant_name: string | null;
  sku: string | null;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface OrderPayment {
  id: string;
  gateway: string | null;
  payment_method: string | null;
  status: string;
  amount: number;
  net_amount: number;
  refunded_amount: number;
  paid_on: string | null;
}

export interface OrderDetail {
  order: OrderRow & {
    subtotal: number;
    discount: number;
    shipping: number;
    tax: number;
    shipping_address: Record<string, unknown> | null;
    provider: string;
  };
  lines: OrderLine[];
  payments: OrderPayment[];
}

/** One order with its lines and payments, or null if it is not this business's. */
export async function getOrderDetail(
  entityId: string,
  orderId: string
): Promise<OrderDetail | null> {
  const supabase = getServerSupabaseClient();
  const { data, error } = await supabase
    .from('orders')
    .select(
      'id, order_number, status, fulfillment_status, grand_total_amount, refunded_total_amount, ' +
        'subtotal_amount, discount_total_amount, shipping_total_amount, tax_total_amount, ' +
        'currency, created_at, customer_id, customer_email, shipping_address, provider, ' +
        'customers(first_name, last_name)'
    )
    .eq('id', orderId)
    .eq('entity_id', entityId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load order: ${error.message}`);
  if (!data) return null;
  const o = data as unknown as OrderDbRow & {
    subtotal_amount: number | string;
    discount_total_amount: number | string;
    shipping_total_amount: number | string;
    tax_total_amount: number | string;
    shipping_address: Record<string, unknown> | null;
    provider: string;
  };

  const [lines, payments] = await Promise.all([
    supabase
      .from('order_line_items')
      .select(
        'id, product_id, product_name, variant_name, sku, quantity, unit_price_amount, total_price_amount'
      )
      .eq('order_id', orderId)
      .order('id'),
    supabase
      .from('payments')
      .select('id, gateway, payment_method, status, amount, net_amount, refunded_amount, paid_on')
      .eq('entity_id', entityId)
      .eq('order_id', orderId)
      .order('id'),
  ]);
  if (lines.error) throw new Error(`Failed to load order lines: ${lines.error.message}`);
  if (payments.error) throw new Error(`Failed to load payments: ${payments.error.message}`);

  return {
    order: {
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      fulfillment_status: o.fulfillment_status,
      grand_total: Number(o.grand_total_amount),
      refunded_total: Number(o.refunded_total_amount ?? 0),
      currency: o.currency ?? 'GBP',
      created_at: o.created_at,
      customer_id: o.customer_id,
      customer_name: name(o.customers),
      customer_email: o.customer_email,
      subtotal: Number(o.subtotal_amount),
      discount: Number(o.discount_total_amount),
      shipping: Number(o.shipping_total_amount),
      tax: Number(o.tax_total_amount),
      shipping_address: o.shipping_address,
      provider: o.provider,
    },
    lines: (lines.data ?? []).map(l => ({
      id: l.id,
      product_id: l.product_id,
      product_name: l.product_name,
      variant_name: l.variant_name,
      sku: l.sku,
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price_amount),
      total_price: Number(l.total_price_amount),
    })),
    payments: (payments.data ?? []).map(p => ({
      id: p.id,
      gateway: p.gateway,
      payment_method: p.payment_method,
      status: p.status,
      amount: Number(p.amount),
      net_amount: Number(p.net_amount),
      refunded_amount: Number(p.refunded_amount),
      paid_on: p.paid_on,
    })),
  };
}
