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

// Server-side Supabase client factory (for API routes)
export function getServerSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

  return createClient(url, key);
}
