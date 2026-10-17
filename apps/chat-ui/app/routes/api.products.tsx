/**
 * GET /api/products?id=<product>: one product (images, variants) for the drawer. Scoped to the
 * signed-in user's own business.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getUserEntity } from '~/lib/api/entity.server';
import { getRequestSupabaseClient } from '~/lib/supabase-server';
import { getProductDetail } from '~/lib/api/products.server';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function loader({ request }: LoaderFunctionArgs) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ ok: false, error: 'A product id is required' }, 400);
  try {
    const entity = await getUserEntity(request);
    if (!entity) return json({ ok: false, error: 'Sign in to view products' }, 401);
    const detail = await getProductDetail(getRequestSupabaseClient(request), entity.id, id);
    if (!detail) return json({ ok: false, error: 'Product not found' }, 404);
    return json({ ok: true, detail });
  } catch (error) {
    console.error('Product loader error:', error);
    return json({ ok: false, error: 'Could not load the product' }, 500);
  }
}
