/**
 * Customers: server-side reads.
 *
 * `customers` and `orders` have no row-level security, so these read with the service role and
 * filter every query on `entityId` (taken from getUserEntity(), never from the request).
 *
 * A customer's figures come from their orders: cancelled orders do not count and refunds are
 * taken off, the same rule the Orders page uses for "Sales".
 */

import { getServerSupabaseClient } from '~/lib/supabase';
import { fetchAllRows } from './paginate.server';

export interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  orders: number;
  /** Lifetime spend after refunds, excluding cancelled orders. */
  spent: number;
  first_order_at: string | null;
  last_order_at: string | null;
  created_at: string | null;
}

interface CustomerDbRow {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: string | null;
}

interface OrderAggRow {
  customer_id: string | null;
  status: string;
  grand_total_amount: number | string;
  refunded_total_amount: number | string | null;
  created_at: string;
}

export const displayName = (c: Pick<CustomerDbRow, 'first_name' | 'last_name' | 'email'>) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown customer';

/** Every customer, with what they have ordered. Read in full: see paginate.server. */
export async function getCustomers(entityId: string): Promise<CustomerRow[]> {
  const supabase = getServerSupabaseClient();
  const [customers, orders] = await Promise.all([
    fetchAllRows<CustomerDbRow>('customers', (from, to) =>
      supabase
        .from('customers')
        .select('id, email, first_name, last_name, created_at')
        .eq('entity_id', entityId)
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<OrderAggRow>('orders', (from, to) =>
      supabase
        .from('orders')
        .select('customer_id, status, grand_total_amount, refunded_total_amount, created_at')
        .eq('entity_id', entityId)
        .not('customer_id', 'is', null)
        .order('id')
        .range(from, to)
    ),
  ]);

  const byCustomer = new Map<string, { n: number; spent: number; first: string; last: string }>();
  for (const o of orders) {
    if (!o.customer_id || o.status === 'cancelled') continue;
    const kept = Math.max(0, Number(o.grand_total_amount) - Number(o.refunded_total_amount ?? 0));
    const entry = byCustomer.get(o.customer_id) ?? {
      n: 0,
      spent: 0,
      first: o.created_at,
      last: o.created_at,
    };
    entry.n += 1;
    entry.spent += kept;
    if (o.created_at < entry.first) entry.first = o.created_at;
    if (o.created_at > entry.last) entry.last = o.created_at;
    byCustomer.set(o.customer_id, entry);
  }

  return customers.map(c => {
    const agg = byCustomer.get(c.id);
    return {
      id: c.id,
      name: displayName(c),
      email: c.email,
      orders: agg?.n ?? 0,
      spent: Math.round((agg?.spent ?? 0) * 100) / 100,
      first_order_at: agg?.first ?? null,
      last_order_at: agg?.last ?? null,
      created_at: c.created_at,
    };
  });
}

export interface CustomerDetail {
  customer: CustomerRow & { phone: string | null };
  orders: {
    id: string;
    order_number: string;
    status: string;
    grand_total: number;
    refunded_total: number;
    currency: string;
    created_at: string;
  }[];
  /** What they buy most, by units across their orders. */
  top_products: { name: string; quantity: number; revenue: number }[];
}

export async function getCustomerDetail(
  entityId: string,
  customerId: string
): Promise<CustomerDetail | null> {
  const supabase = getServerSupabaseClient();
  const { data: c, error } = await supabase
    .from('customers')
    .select('id, email, first_name, last_name, phone, created_at')
    .eq('id', customerId)
    .eq('entity_id', entityId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load customer: ${error.message}`);
  if (!c) return null;

  const orders = await fetchAllRows<{
    id: string;
    order_number: string;
    status: string;
    grand_total_amount: number | string;
    refunded_total_amount: number | string | null;
    currency: string | null;
    created_at: string;
  }>('orders', (from, to) =>
    supabase
      .from('orders')
      .select(
        'id, order_number, status, grand_total_amount, refunded_total_amount, currency, created_at'
      )
      .eq('entity_id', entityId)
      .eq('customer_id', customerId)
      .order('id')
      .range(from, to)
  );
  orders.sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Line items for those orders, in chunks so the id list stays within a URL's length.
  const live = orders.filter(o => o.status !== 'cancelled').map(o => o.id);
  const products = new Map<string, { quantity: number; revenue: number }>();
  for (let i = 0; i < live.length; i += 100) {
    const { data, error: lineError } = await supabase
      .from('order_line_items')
      .select('product_name, quantity, total_price_amount')
      .in('order_id', live.slice(i, i + 100));
    if (lineError) throw new Error(`Failed to load order lines: ${lineError.message}`);
    for (const l of data ?? []) {
      const entry = products.get(l.product_name) ?? { quantity: 0, revenue: 0 };
      entry.quantity += Number(l.quantity);
      entry.revenue += Number(l.total_price_amount);
      products.set(l.product_name, entry);
    }
  }

  const stats = (await getCustomers(entityId)).find(r => r.id === customerId);
  return {
    customer: {
      ...(stats ?? {
        id: c.id,
        name: displayName(c),
        email: c.email,
        orders: 0,
        spent: 0,
        first_order_at: null,
        last_order_at: null,
        created_at: c.created_at,
      }),
      phone: c.phone,
    },
    orders: orders.map(o => ({
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      grand_total: Number(o.grand_total_amount),
      refunded_total: Number(o.refunded_total_amount ?? 0),
      currency: o.currency ?? 'GBP',
      created_at: o.created_at,
    })),
    top_products: [...products.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
      .slice(0, 5),
  };
}
