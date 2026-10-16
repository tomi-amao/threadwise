/**
 * Environment loading and the production-safety guard for the e2e tooling.
 *
 * Several app loaders use the Supabase service-role key (which bypasses RLS) and the
 * seed script deletes and inserts rows, so pointing any of this at the hosted project
 * would write to production. Every entry point (seed, env writer, Playwright config)
 * calls `assertLocalSupabase` first and refuses to continue otherwise.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

// All e2e commands (pnpm scripts and Playwright) run with apps/chat-ui as the working
// directory. Resolved from cwd rather than import.meta so the app's tsconfig (which has
// no explicit `module`) stays untouched.
export const APP_DIR = process.cwd();
if (!existsSync(path.join(APP_DIR, 'playwright.config.ts'))) {
  throw new Error(`Run e2e commands from apps/chat-ui (cwd is ${APP_DIR}).`);
}
export const REPO_ROOT = path.resolve(APP_DIR, '..', '..');
export const ENV_FILE = path.join(APP_DIR, '.env.test');
export const MANIFEST_FILE = path.join(APP_DIR, 'e2e', '.seed-manifest.json');
export const AUTH_FILE = path.join(APP_DIR, 'e2e', '.auth', 'user.json');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Loads apps/chat-ui/.env.test into process.env. Variables already set win. */
export function loadTestEnv() {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run \`pnpm e2e:env\` (needs \`supabase start\` first).`);
  }
  return value;
}

export function assertLocalSupabase(url: string | undefined): string {
  if (!url) {
    throw new Error('SUPABASE_URL is not set. Run `pnpm e2e:env` after `supabase start`.');
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL: ${url}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run: SUPABASE_URL host is "${host}", not local. ` +
        'The e2e suite and seed only run against `supabase start` (127.0.0.1).'
    );
  }
  return url;
}
