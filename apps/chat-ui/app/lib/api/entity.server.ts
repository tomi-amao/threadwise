/**
 * Which business is the signed-in user looking at?
 *
 * Several tables (orders, customers, payments, ...) have no row-level security, so their pages
 * read with the service role. That key sees every business, so the entity always comes from
 * here (a row the user's own session can read), never from the request, and every such query
 * filters on it.
 */

import { getRequestSupabaseClient } from '~/lib/supabase-server';

export interface UserEntity {
  id: string;
  currency: string;
}

/** The business the signed-in user owns (its id and trading currency), or null. */
export async function getUserEntity(request: Request): Promise<UserEntity | null> {
  const { data, error } = await getRequestSupabaseClient(request)
    .from('entities')
    .select('id, currency')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load your business: ${error.message}`);
  return data ? { id: data.id, currency: data.currency ?? 'GBP' } : null;
}
