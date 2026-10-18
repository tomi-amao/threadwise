/**
 * The signed-in user's access token, for calls from this server to the AI agent.
 *
 * The agent authenticates every request with the user's Supabase token and takes the business
 * from it, so a server route forwards the token it already has (from the session cookie, or an
 * `Authorization: Bearer` header when a caller sent one).
 */

import { data } from 'react-router';
import { getRequestSupabaseClient } from '../supabase-server';

export async function requestAccessToken(request: Request): Promise<string> {
  const header = request.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);

  const {
    data: { session },
  } = await getRequestSupabaseClient(request).auth.getSession();
  if (!session?.access_token)
    throw data('Your session has expired. Sign in again.', { status: 401 });
  return session.access_token;
}
