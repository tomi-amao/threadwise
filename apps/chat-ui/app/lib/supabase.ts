/**
 * Supabase Client Configuration
 *
 * Provides browser and server-side Supabase clients for authentication and data access.
 * Client is lazily initialized to avoid SSR issues.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Re-export types from auth types file
export type { UserProfile, Entity, UserWithProfile } from '~/types/auth';

// Singleton instance for browser-side client
let browserClient: SupabaseClient | null = null;

/**
 * Get environment variables safely
 * Works in both browser (import.meta.env) and server (process.env) contexts
 */
function getSupabaseConfig() {
  // Check for browser environment first
  if (typeof window !== 'undefined') {
    // @ts-ignore - import.meta.env is available in Vite
    const url = import.meta.env?.VITE_SUPABASE_URL || '';
    // @ts-ignore
    const anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY || '';

    console.log(`Supabase URL: ${url}`);

    return {
      url: url || 'http://127.0.0.1:54321',
      anonKey: anonKey,
    };
  }

  // Server-side environment
  return {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321',
    anonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '',
  };
}

/**
 * Get or create the browser-side Supabase client
 * Uses singleton pattern to avoid creating multiple clients
 * Should only be called on the client side
 */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (typeof window === 'undefined') {
    throw new Error('getSupabaseBrowserClient should only be called on the client side');
  }

  if (browserClient) {
    return browserClient;
  }

  const config = getSupabaseConfig();

  browserClient = createClient(config.url, config.anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });

  return browserClient;
}

// Server-side Supabase client factory (for API routes).
// Uses the service role key when available so RLS is bypassed — the
// standard pattern for SSR where the user session isn't in a cookie.
// Falls back to the anon key so development still works without it.
export function getServerSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  const key = serviceRoleKey || anonKey;

  return createClient(url, key, {
    auth: {
      // Prevent the server client from persisting sessions
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Create a server-side Supabase client authenticated with the user's session.
 *
 * Tries, in order:
 *  1. `Authorization: Bearer <token>` request header
 *  2. `sb-*-auth-token` cookie (set when @supabase/ssr is configured)
 *
 * Falls back to the anonymous client when no token is found.
 */
export function getAuthenticatedServerClient(request?: Request) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

  let accessToken: string | null = null;

  if (request) {
    // 1. Check Authorization header
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      accessToken = authHeader.slice(7);
    }

    // 2. Check Supabase auth cookie (sb-<projectRef>-auth-token)
    if (!accessToken) {
      const cookieHeader = request.headers.get('Cookie') || '';
      const match = cookieHeader.match(/sb-[^=]+-auth-token=([^;]+)/);
      if (match) {
        try {
          const parsed = JSON.parse(decodeURIComponent(match[1]));
          accessToken = parsed?.access_token ?? null;
        } catch {
          // malformed cookie — ignore
        }
      }
    }
  }

  return createClient(url, key, {
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}
