/**
 * GET /api/orders?id=<order>: one order with its lines and payments, for the drawer.
 * Scoped to the signed-in user's own business.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getUserEntity } from '~/lib/api/entity.server';
import { getOrderDetail } from '~/lib/api/orders.server';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function loader({ request }: LoaderFunctionArgs) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ ok: false, error: 'An order id is required' }, 400);
  try {
    const entity = await getUserEntity(request);
    if (!entity) return json({ ok: false, error: 'Sign in to view orders' }, 401);
    const detail = await getOrderDetail(entity.id, id);
    if (!detail) return json({ ok: false, error: 'Order not found' }, 404);
    return json({ ok: true, detail });
  } catch (error) {
    console.error('Order loader error:', error);
    return json({ ok: false, error: 'Could not load the order' }, 500);
  }
}
