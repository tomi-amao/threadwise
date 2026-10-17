/**
 * Public Supabase connection settings (URL + publishable/anon key), for both the browser
 * and the server. Key lookup order matches lib/supabase.ts: the newer publishable key name
 * first, then the legacy anon key name.
 */

export function getPublicSupabaseConfig(): { url: string; key: string } {
  if (typeof window !== 'undefined') {
    // Vite replaces import.meta.env.VITE_* statically at build time, so each name is spelled out.
    const url: string = import.meta.env?.VITE_SUPABASE_URL || '';
    const publishable: string = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || '';
    const anon: string = import.meta.env?.VITE_SUPABASE_ANON_KEY || '';
    return { url: url || 'http://127.0.0.1:54321', key: publishable || anon };
  }

  return {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321',
    key:
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      '',
  };
}
