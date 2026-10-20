import { defineConfig, devices } from '@playwright/test';
import type { ThemeOption } from './e2e/fixtures';
import { AUTH_FILE, assertLocalSupabase, loadTestEnv, requireEnv } from './e2e/env';

// Refuse to start at all unless Supabase is the local stack (see e2e/env.ts).
loadTestEnv();
const supabaseUrl = assertLocalSupabase(process.env.SUPABASE_URL);
const anonKey = requireEnv('SUPABASE_ANON_KEY');
const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const PORT = 5180; // not 5174, so a normal dev server (which may point at the hosted DB) is never reused
const BASE_URL = `http://localhost:${PORT}`;
const STAND_IN_PORT = 8099;
const STAND_IN_URL = `http://127.0.0.1:${STAND_IN_PORT}`;

/** Setup runs once; tests that change data run last, in their own project. */
const PAGE_TEST_IGNORE = /auth\.setup\.ts|-edit\.spec\.ts/;
/** The API-level security checks do not depend on width or theme: run them in one project. */
const ONCE_ONLY = /rls\.spec\.ts/;

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } };

export default defineConfig<{ theme: ThemeOption }>({
  testDir: './e2e',
  testMatch: /.*\.(spec|setup)\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // CI runners have 2 to 4 cores; one worker would leave them idle (CI also shards, see e2e.yml).
  workers: process.env.CI ? Number(process.env.E2E_WORKERS ?? 2) : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // Every page test runs at three widths in both themes (design plan: full dark parity).
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: desktop },
    ...(['light', 'dark'] as const).flatMap(theme => [
      {
        name: `desktop-${theme}`,
        testIgnore: theme === 'light' ? PAGE_TEST_IGNORE : [PAGE_TEST_IGNORE, ONCE_ONLY],
        dependencies: ['setup'],
        use: { ...desktop, theme, storageState: AUTH_FILE },
      },
      {
        name: `tablet-${theme}`,
        testIgnore: [PAGE_TEST_IGNORE, ONCE_ONLY],
        dependencies: ['setup'],
        use: { ...desktop, viewport: { width: 768, height: 1024 }, theme, storageState: AUTH_FILE },
      },
      {
        name: `mobile-${theme}`,
        testIgnore: [PAGE_TEST_IGNORE, ONCE_ONLY],
        dependencies: ['setup'],
        use: {
          ...desktop,
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          theme,
          storageState: AUTH_FILE,
        },
      },
    ]),
    {
      // Tests that change data (and restore it). They run after every read-only test, so a
      // changed cost or an extra movement can never skew a total another test is checking.
      name: 'mutations',
      testMatch: /-edit\.spec\.ts/,
      // E2E_MUTATIONS_ONLY (CI's separate mutations job, which has its own database) skips the
      // read-only projects and only logs in first.
      dependencies: process.env.E2E_MUTATIONS_ONLY
        ? ['setup']
        : [
            'desktop-light',
            'desktop-dark',
            'tablet-light',
            'tablet-dark',
            'mobile-light',
            'mobile-dark',
          ],
      fullyParallel: false,
      workers: 1,
      use: { ...desktop, theme: 'light', storageState: AUTH_FILE },
    },
  ],

  webServer: [
    {
      command: `pnpm exec react-router dev --port ${PORT} --strictPort`,
      url: `${BASE_URL}/login`,
      // Never attach to an already-running server: it could be configured for another database.
      reuseExistingServer: false,
      timeout: 120_000,
      // Explicit env wins over any .env / .env.local file, so the hosted keys in
      // .env.local can never leak into a test run.
      env: {
        SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        SUPABASE_SECRET_KEY: serviceKey,
        SUPABASE_PUBLISHABLE_KEY: anonKey,
        VITE_SUPABASE_URL: supabaseUrl,
        VITE_SUPABASE_ANON_KEY: anonKey,
        VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
        // Server-side calls to the agent go to the stand-in below, never a real agent.
        AI_AGENT_URL: STAND_IN_URL,
        // The browser's own calls to the agent default to :2024, where a developer may have their
        // real dev server running (it can hang the page's network). Point them at the stand-in too:
        // specs that exercise those calls mock them, the rest fail fast.
        VITE_AI_AGENT_URL: STAND_IN_URL,
      },
    },
    {
      command: 'pnpm exec tsx e2e/stand-in-agent.ts',
      url: `${STAND_IN_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        STAND_IN_AGENT_PORT: String(STAND_IN_PORT),
      },
    },
  ],
});
