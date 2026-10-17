/**
 * Browser-side Supabase client with the session stored in COOKIES.
 *
 * The previous client kept the session in localStorage, which the server can never read, so
 * route loaders could not tell who was signed in (the dashboard header showed "Your Business"
 * for that reason). `@supabase/ssr`'s browser client writes the same session to an
 * `sb-<ref>-auth-token` cookie, which the browser sends with every request, so loaders can
 * identify the user via `getRequestSupabaseClient` (supabase-server.ts).
 *
 * Security notes: the cookie is readable by page JavaScript (the client has to refresh it), so
 * its exposure to XSS is the same as localStorage had. It is SameSite=Lax, so it is not sent on
 * cross-site POSTs, and loaders only read it.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPublicSupabaseConfig } from './supabase-config';

let client: SupabaseClient | null = null;

/** Singleton. Client-side only. Name kept from lib/supabase.ts so callers only change their import. */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (typeof window === 'undefined') {
    throw new Error('getSupabaseBrowserClient should only be called on the client side');
  }
  if (client) return client;
  const { url, key } = getPublicSupabaseConfig();
  client = createBrowserClient(url, key);
  return client;
}

const LEGACY_KEY = /^sb-.+-auth-token$/;

/**
 * One-time move of an existing localStorage session into the cookie, so people who were
 * signed in before this change are not signed out. Safe to call on every load: it does nothing
 * once the cookie session exists or there is no legacy session, and it always removes the
 * legacy entry so it cannot be replayed.
 */
export async function migrateLegacySession(supabase: SupabaseClient): Promise<void> {
  let legacyKey: string | null = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && LEGACY_KEY.test(k)) {
        legacyKey = k;
        break;
      }
    }
  } catch {
    return; // storage unavailable (private mode, blocked): nothing to migrate
  }
  if (!legacyKey) return;

  try {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const stored = JSON.parse(localStorage.getItem(legacyKey) ?? 'null');
      if (stored?.access_token && stored?.refresh_token) {
        await supabase.auth.setSession({
          access_token: stored.access_token,
          refresh_token: stored.refresh_token,
        });
      }
    }
  } catch {
    // malformed or expired legacy session: the user simply signs in again
  } finally {
    try {
      localStorage.removeItem(legacyKey);
    } catch {
      /* ignore */
    }
  }
}
