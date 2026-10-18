/**
 * Collections Route (Protected)
 *
 * The list of collections with what each has earned and cost. Reads run as the signed-in user
 * (row-level security); sales are totalled in the database. Creating a collection is the one
 * write here; everything else happens on a single collection's page.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { RouteErrorBoundary } from '~/components/RouteErrorBoundary';
import { CollectionsIndexPage } from '~/components/collections/CollectionsIndexPage';
import { createCollection } from '~/lib/api/collections-actions.server';
import { getCollectionsIndex } from '~/lib/api/collections.server';
import { getUserEntity } from '~/lib/api/entity.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

export const meta: MetaFunction = () => [
  { title: 'Collections - ThreadWise' },
  { name: 'description', content: 'What each collection earned and what it cost' },
];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  return { data: await getCollectionsIndex(getRequestSupabaseClient(request)) };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireUser(request);
  const form = await request.formData();
  if (form.get('intent') !== 'createCollection') return { ok: false, error: 'Unknown action' };
  const entity = await getUserEntity(request);
  if (!entity) return { ok: false, error: 'No business found for your account' };
  return createCollection(getRequestSupabaseClient(request), entity.id, form);
}

export default function CollectionsRoute() {
  const { data } = useLoaderData<typeof loader>();
  return <CollectionsIndexPage data={data} />;
}

export function ErrorBoundary() {
  return <RouteErrorBoundary what="collections" />;
}
