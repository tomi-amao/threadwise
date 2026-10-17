/**
 * Collection cost search: GET ?collection=<id>&q=<text>
 *
 * Outbound bank transactions that could be linked to the collection as a cost, with the category
 * each would be filed under. Read as the signed-in user, so only their own transactions appear.
 */

import type { LoaderFunctionArgs } from 'react-router';
import { searchCostCandidates } from '~/lib/api/collections.server';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const collectionId = url.searchParams.get('collection');
  if (!collectionId)
    return Response.json({ error: 'A collection id is required' }, { status: 400 });
  try {
    const candidates = await searchCostCandidates(
      getRequestSupabaseClient(request),
      collectionId,
      url.searchParams.get('q') ?? ''
    );
    return Response.json({ candidates });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Search failed' },
      { status: 500 }
    );
  }
}
