/**
 * Server-side Supabase client that acts as the signed-in user.
 *
 * Reads the session from the request's `sb-<ref>-auth-token` cookie (written by the browser
 * client in supabase-browser.ts), or from an `Authorization: Bearer` header when a caller
 * sends one. Row-level security therefore applies as that user, unlike
 * `getServerSupabaseClient()` in lib/supabase.ts, which uses the service-role key and
 * bypasses RLS.
 *
 * Loaders cannot set cookies, so this never refreshes a token itself. If the access token has
 * expired the user resolves to null for that request; the browser client refreshes the cookie
 * on its own and the next request is authenticated.
 */

import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { getPublicSupabaseConfig } from './supabase-config';

export function getRequestSupabaseClient(request: Request): SupabaseClient {
  const { url, key } = getPublicSupabaseConfig();

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return createClient(url, key, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return createServerClient(url, key, {
    cookies: {
      getAll: () =>
        parseCookieHeader(request.headers.get('Cookie') ?? '').map(c => ({
          name: c.name,
          value: c.value ?? '',
        })),
      // Loaders cannot set cookies; see the note above.
      setAll: () => {},
    },
  });
}

/** The signed-in user for this request, validated with Supabase Auth, or null. */
export async function getRequestUser(request: Request): Promise<User | null> {
  const {
    data: { user },
    error,
  } = await getRequestSupabaseClient(request).auth.getUser();
  return error ? null : user;
}
