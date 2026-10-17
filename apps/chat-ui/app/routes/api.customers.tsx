/**
 * GET /api/customers?id=<customer>: one customer with their orders and what they buy most, for
 * the drawer. Scoped to the signed-in user's own business.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getCustomerDetail } from '~/lib/api/customers.server';
import { getUserEntity } from '~/lib/api/entity.server';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function loader({ request }: LoaderFunctionArgs) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ ok: false, error: 'A customer id is required' }, 400);
  try {
    const entity = await getUserEntity(request);
    if (!entity) return json({ ok: false, error: 'Sign in to view customers' }, 401);
    const detail = await getCustomerDetail(entity.id, id);
    if (!detail) return json({ ok: false, error: 'Customer not found' }, 404);
    return json({ ok: true, detail });
  } catch (error) {
    console.error('Customer loader error:', error);
    return json({ ok: false, error: 'Could not load the customer' }, 500);
  }
}
