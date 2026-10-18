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
import { data } from 'react-router';
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

/**
 * The signed-in user, or a 401 the route's error boundary shows.
 *
 * Loaders that read with the user's session must call this first. Without a valid session every
 * row-level-security read quietly returns nothing, which a page would render as a business with
 * no data: an empty dashboard is a worse answer than "your session has expired". (A token that
 * has just expired is refreshed by the browser client on its own, so reloading works.)
 */
export async function requireUser(request: Request): Promise<User> {
  const user = await getRequestUser(request);
  if (!user) {
    throw data(
      { message: 'Your session has expired. Reload the page to sign back in.' },
      { status: 401 }
    );
  }
  return user;
}
