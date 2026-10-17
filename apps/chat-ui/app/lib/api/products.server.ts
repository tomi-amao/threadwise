/**
 * Products: server-side reads.
 *
 * What sells comes from order line items, so a product that has never been ordered is still a
 * product (the old page only listed products that had sold, which hid the ones that had not).
 * `order_line_items` and `orders` have no row-level security, so these read with the service
 * role and filter on `entityId` (from getUserEntity(), never from the request).
 *
 * Revenue is line-item revenue for orders that were not cancelled, before any refunds (refunds
 * are recorded against the order, not the line).
 */

import { getServerSupabaseClient } from '~/lib/supabase';
import { fetchAllRows } from './paginate.server';

export interface ProductRow {
  /** Null for something that has sold but is not in the catalogue. */
  id: string | null;
  name: string;
  status: string | null;
  provider: string | null;
  thumbnail_url: string | null;
  variant_count: number;
  units: number;
  revenue: number;
  orders: number;
  /** Average selling price per unit. */
  average_price: number;
  last_sold_at: string | null;
}

interface ProductDbRow {
  id: string;
  name: string | null;
  provider: string | null;
  status: string;
  metadata: { images?: unknown[] } | null;
  variants: unknown;
}

interface LineDbRow {
  product_id: string | null;
  product_name: string | null;
  quantity: number | string;
  total_price_amount: number | string;
  order_id: string;
}

/** Image URLs in product metadata: strings, or objects with a url or src. */
export function imageUrls(metadata: { images?: unknown[] } | null): string[] {
  const images = Array.isArray(metadata?.images) ? metadata.images : [];
  return images
    .map(img => {
      if (typeof img === 'string') return img.trim();
      const o = img as { url?: unknown; src?: unknown } | null;
      return typeof o?.url === 'string'
        ? o.url.trim()
        : typeof o?.src === 'string'
          ? o.src.trim()
          : '';
    })
    .filter(url => url.length > 0);
}

/** Every product and what it has sold. Read in full: see paginate.server. */
export async function getProducts(entityId: string): Promise<ProductRow[]> {
  const supabase = getServerSupabaseClient();
  const [products, orders, lines] = await Promise.all([
    fetchAllRows<ProductDbRow>('products', (from, to) =>
      supabase
        .from('products')
        .select('id, name, provider, status, metadata, variants')
        .eq('entity_id', entityId)
        .neq('status', 'archived')
        .order('id')
        .range(from, to)
    ),
    fetchAllRows<{ id: string; status: string; created_at: string }>('orders', (from, to) =>
      supabase
        .from('orders')
        .select('id, status, created_at')
        .eq('entity_id', entityId)
        .order('id')
        .range(from, to)
    ),
    // Line items carry no entity of their own: they belong to orders, which are filtered above.
    fetchAllRows<LineDbRow>('order line items', (from, to) =>
      supabase
        .from('order_line_items')
        .select(
          'product_id, product_name, quantity, total_price_amount, order_id, orders!inner(entity_id)'
        )
        .eq('orders.entity_id', entityId)
        .order('id')
        .range(from, to)
    ),
  ]);

  const orderById = new Map(orders.map(o => [o.id, o]));
  interface Sales {
    units: number;
    revenue: number;
    orders: Set<string>;
    last: string | null;
    name: string;
  }
  const byKey = new Map<string, Sales>();
  for (const l of lines) {
    const order = orderById.get(l.order_id);
    if (!order || order.status === 'cancelled') continue;
    const key = l.product_id ?? `name:${l.product_name ?? 'Unknown'}`;
    const entry = byKey.get(key) ?? {
      units: 0,
      revenue: 0,
      orders: new Set<string>(),
      last: null,
      name: l.product_name ?? 'Unknown',
    };
    entry.units += Number(l.quantity);
    entry.revenue += Number(l.total_price_amount);
    entry.orders.add(l.order_id);
    if (!entry.last || order.created_at > entry.last) entry.last = order.created_at;
    byKey.set(key, entry);
  }

  const row = (
    base: Pick<
      ProductRow,
      'id' | 'name' | 'status' | 'provider' | 'thumbnail_url' | 'variant_count'
    >,
    sales: Sales | undefined
  ): ProductRow => ({
    ...base,
    units: sales?.units ?? 0,
    revenue: Math.round((sales?.revenue ?? 0) * 100) / 100,
    orders: sales?.orders.size ?? 0,
    average_price: sales && sales.units > 0 ? sales.revenue / sales.units : 0,
    last_sold_at: sales?.last ?? null,
  });

  const catalogue = products.map(p =>
    row(
      {
        id: p.id,
        name: p.name || 'Unnamed product',
        status: p.status,
        provider: p.provider,
        thumbnail_url: imageUrls(p.metadata)[0] ?? null,
        variant_count: Array.isArray(p.variants) ? p.variants.length : 0,
      },
      byKey.get(p.id)
    )
  );
  const known = new Set(products.map(p => p.id));
  const uncatalogued = [...byKey.entries()]
    .filter(([key]) => !known.has(key))
    .map(([, s]) =>
      row(
        {
          id: null,
          name: s.name,
          status: null,
          provider: null,
          thumbnail_url: null,
          variant_count: 0,
        },
        s
      )
    );
  return [...catalogue, ...uncatalogued];
}

export interface ProductVariant {
  external_id: string;
  sku: string | null;
  price: number | null;
  stock: number | null;
  attributes: Record<string, string>;
}

export interface ProductDetail {
  id: string;
  name: string;
  provider: string | null;
  status: string;
  product_type: string | null;
  description: string | null;
  url_slug: string | null;
  images: string[];
  variants: ProductVariant[];
  created_at: string;
}

export async function getProductDetail(
  entityId: string,
  productId: string
): Promise<ProductDetail | null> {
  const { data, error } = await getServerSupabaseClient()
    .from('products')
    .select('id, name, provider, status, product_type, metadata, variants, created_at')
    .eq('id', productId)
    .eq('entity_id', entityId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load product: ${error.message}`);
  if (!data) return null;

  const meta = (data.metadata ?? {}) as {
    images?: unknown[];
    description?: string;
    seo?: { description?: string };
    url_slug?: string;
  };
  const variants = Array.isArray(data.variants) ? data.variants : [];
  return {
    id: data.id,
    name: data.name || 'Unnamed product',
    provider: data.provider ?? null,
    status: data.status,
    product_type: data.product_type ?? null,
    description: meta.description ?? meta.seo?.description ?? null,
    url_slug: meta.url_slug ?? null,
    images: imageUrls(meta),
    variants: variants.map((v: Record<string, unknown>) => {
      const price = v.price as { amount?: unknown } | null | undefined;
      return {
        external_id: String(v.external_id ?? ''),
        sku: (v.sku as string | null) ?? null,
        price: price?.amount != null ? Number(price.amount) : null,
        stock: v.stock != null ? Number(v.stock) : null,
        attributes: (v.attributes as Record<string, string>) ?? {},
      };
    }),
    created_at: data.created_at,
  };
}
