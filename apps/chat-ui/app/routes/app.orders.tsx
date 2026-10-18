/**
 * Orders Route (Protected)
 *
 * Reads every order for the signed-in user's business; the page filters and pages them.
 */

import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { OrdersPage } from '~/components/orders';
import { getUserEntity } from '~/lib/api/entity.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';
import { getOrders } from '~/lib/api/orders.server';

export const meta: MetaFunction = () => [
  { title: 'Orders - ThreadWise' },
  { name: 'description', content: 'What was sold and where each order stands' },
];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const entity = await getUserEntity(request);
  if (!entity) return { orders: [], currency: 'GBP' };
  return {
    orders: await getOrders(getRequestSupabaseClient(request), entity.id),
    currency: entity.currency,
  };
}

export default function OrdersRoute() {
  const { orders, currency } = useLoaderData<typeof loader>();
  return <OrdersPage orders={orders} currency={currency} />;
}
