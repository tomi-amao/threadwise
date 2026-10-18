/**
 * Products Route (Protected)
 *
 * Reads every product, with what it has sold, for the signed-in user's business.
 */

import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { ProductsPage } from '~/components/products';
import { getUserEntity } from '~/lib/api/entity.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';
import { getProducts } from '~/lib/api/products.server';

export const meta: MetaFunction = () => [
  { title: 'Products - ThreadWise' },
  { name: 'description', content: 'What sells, and what does not' },
];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const entity = await getUserEntity(request);
  // "Today" comes from the server so "slowing" is the same on the server render and in the browser.
  const today = new Date().toISOString().slice(0, 10);
  if (!entity) return { products: [], today, currency: 'GBP' };
  return {
    products: await getProducts(getRequestSupabaseClient(request), entity.id),
    today,
    currency: entity.currency,
  };
}

export default function ProductsRoute() {
  const { products, today, currency } = useLoaderData<typeof loader>();
  return <ProductsPage products={products} today={today} currency={currency} />;
}
