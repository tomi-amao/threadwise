/**
 * Supabase service client (server only).
 *
 * `getServerSupabaseClient` uses the secret/service-role key and BYPASSES row-level security.
 * Use it only for trusted server reads that are not user-scoped.
 *
 * Sessions live in cookies now: the browser client is in supabase-browser.ts and the
 * per-request, user-scoped server client is in supabase-server.ts.
 */

import { createClient } from '@supabase/supabase-js';

// Re-export types from auth types file
export type { UserProfile, Entity, UserWithProfile } from '~/types/auth';

// Server-side Supabase client factory (for API routes).
// Uses the service role key when available so RLS is bypassed — the
// standard pattern for SSR where the user session isn't in a cookie.
// Falls back to the anon key so development still works without it.
export function getServerSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
  // SUPABASE_SERVICE_ROLE_KEY is the legacy name, kept as a fallback.
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    '';
  const key = secretKey || publishableKey;

  return createClient(url, key, {
    auth: {
      // Prevent the server client from persisting sessions
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
