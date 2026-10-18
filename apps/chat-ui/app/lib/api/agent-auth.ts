/**
 * Calling the AI agent from the browser as the signed-in user.
 *
 * The agent authenticates every request with the user's Supabase access token and takes the
 * business from it. `agentFetch` is `fetch` with that token added; the browser client keeps
 * the token fresh. (Server code uses `agent-auth.server.ts` instead.)
 */

import { getSupabaseBrowserClient } from '../supabase-browser';

export async function agentFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const {
    data: { session },
  } = await getSupabaseBrowserClient().auth.getSession();
  const headers = new Headers(init.headers);
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  return fetch(input, { ...init, headers });
}
