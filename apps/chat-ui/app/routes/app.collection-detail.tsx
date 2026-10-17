/**
 * Collection Route (Protected)
 *
 * One collection: overview, plan, products and costs. Reads and writes run as the signed-in
 * user, so row-level security keeps every row inside their own business; each change is looked
 * up under the collection in the URL.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { RouteErrorBoundary } from '~/components/RouteErrorBoundary';
import { CollectionPage } from '~/components/collections/CollectionPage';
import * as actions from '~/lib/api/collections-actions.server';
import { getCollectionDetail } from '~/lib/api/collections.server';
import { getUserEntity } from '~/lib/api/entity.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: `${data?.detail.collection.name ?? 'Collection'} - ThreadWise` },
];

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireUser(request);
  const detail = await getCollectionDetail(getRequestSupabaseClient(request), params.collectionId!);
  if (!detail) throw new Response('That collection was not found.', { status: 404 });
  return { detail };
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireUser(request);
  const supabase = getRequestSupabaseClient(request);
  const collectionId = params.collectionId!;
  const form = await request.formData();

  const needsEntity = new Set(['addCost', 'createPlan']);
  const intent = String(form.get('intent') ?? '');
  const entity = needsEntity.has(intent) ? await getUserEntity(request) : null;
  if (needsEntity.has(intent) && !entity) {
    return { ok: false, error: 'No business found for your account' };
  }

  switch (intent) {
    case 'updateCollection':
      return actions.updateCollection(supabase, collectionId, form);
    case 'addProducts':
      return actions.addProducts(supabase, collectionId, form);
    case 'updateProduct':
      return actions.updateProduct(supabase, collectionId, form);
    case 'removeProduct':
      return actions.removeProduct(supabase, collectionId, form);
    case 'addCost':
      return actions.addCost(supabase, entity!.id, collectionId, form);
    case 'updateCost':
      return actions.updateCost(supabase, collectionId, form);
    case 'removeCost':
      return actions.removeCost(supabase, collectionId, form);
    case 'createPlan':
      return actions.createPlan(supabase, entity!.id, collectionId);
    case 'updatePlan':
      return actions.updatePlan(supabase, collectionId, form);
    case 'addPlanLine':
      return actions.addPlanLine(supabase, collectionId, form);
    case 'updatePlanLine':
      return actions.updatePlanLine(supabase, collectionId, form);
    case 'removePlanLine':
      return actions.removePlanLine(supabase, collectionId, form);
    case 'addPlanCost':
      return actions.addPlanCost(supabase, collectionId, form);
    case 'updatePlanCost':
      return actions.updatePlanCost(supabase, collectionId, form);
    case 'removePlanCost':
      return actions.removePlanCost(supabase, collectionId, form);
    default:
      return { ok: false, error: 'Unknown action' };
  }
}

export default function CollectionRoute() {
  const { detail } = useLoaderData<typeof loader>();
  return <CollectionPage detail={detail} />;
}

export function ErrorBoundary() {
  return <RouteErrorBoundary what="collection" />;
}
