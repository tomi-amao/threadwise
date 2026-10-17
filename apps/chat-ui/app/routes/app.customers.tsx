/**
 * Customers Route (Protected)
 *
 * Reads every customer, with what they have ordered, for the signed-in user's business.
 */

import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { CustomersPage } from '~/components/customers';
import { getCustomers } from '~/lib/api/customers.server';
import { getUserEntity } from '~/lib/api/entity.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

export const meta: MetaFunction = () => [
  { title: 'Customers - ThreadWise' },
  { name: 'description', content: 'Who buys from you, and how often' },
];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const entity = await getUserEntity(request);
  // "Today" comes from the server so "lapsed" is the same on the server render and in the browser.
  const today = new Date().toISOString().slice(0, 10);
  if (!entity) return { customers: [], today, currency: 'GBP' };
  return {
    customers: await getCustomers(getRequestSupabaseClient(request), entity.id),
    today,
    currency: entity.currency,
  };
}

export default function CustomersRoute() {
  const { customers, today, currency } = useLoaderData<typeof loader>();
  return <CustomersPage customers={customers} today={today} currency={currency} />;
}
