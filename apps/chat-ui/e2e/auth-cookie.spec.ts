import { test, expect, readManifest } from './fixtures';
import { requireEnv } from './env';

const seed = readManifest();

/**
 * Sessions live in a cookie (not localStorage) so route loaders can tell who is signed in.
 * These tests pin that behaviour: the original symptom was the dashboard header showing
 * "Your Business" because loaders could never see the session.
 */
test.describe('cookie session', () => {
  test('signing in writes the session to an sb-*-auth-token cookie', async ({ page }) => {
    await page.goto('/dashboard');
    const cookies = await page.context().cookies();
    const session = cookies.filter(c => /^sb-.+-auth-token(\.\d+)?$/.test(c.name));
    expect(session.length, 'expected a Supabase auth cookie').toBeGreaterThan(0);
  });

  test('keeps nothing in localStorage that the server cannot see', async ({ page }) => {
    await page.goto('/dashboard');
    const legacy = await page.evaluate(() =>
      Object.keys(localStorage).filter(k => /^sb-.+-auth-token$/.test(k))
    );
    expect(legacy).toEqual([]);
  });

  test('the dashboard loader identifies the signed-in business from the cookie', async ({
    page,
  }) => {
    // Request the document directly with this context's cookies: the loader data React Router
    // serialises into the HTML must already contain the business, before any client code runs.
    const html = await (await page.request.get('/dashboard')).text();
    expect(html).toContain(seed.entityName);
  });

  test('without the cookie the loader sees nobody', async ({ playwright, baseURL }) => {
    // Playwright's request helper inherits the project's saved login unless told otherwise.
    const anonymous = await playwright.request.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    const html = await (await anonymous.get('/dashboard')).text();
    expect(html).not.toContain(seed.entityName);
    await anonymous.dispose();
  });

  test('a session left in localStorage by the old client is migrated, not lost', async ({
    browser,
    baseURL,
    request,
  }) => {
    // What the old client stored: the whole session object, under sb-<host>-auth-token.
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const res = await request.post(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      headers: { apikey: requireEnv('SUPABASE_ANON_KEY') },
      data: { email: requireEnv('E2E_USER_EMAIL'), password: requireEnv('E2E_USER_PASSWORD') },
    });
    expect(res.ok()).toBe(true);
    const legacySession = JSON.stringify(await res.json());
    const legacyKey = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;

    // A browser that has only the old localStorage session, and no cookie.
    const context = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    await context.addInitScript(
      ([key, value]) => {
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem(key, value);
          sessionStorage.setItem('seeded', '1');
        }
      },
      [legacyKey, legacySession]
    );
    const page = await context.newPage();
    await page.goto('/dashboard');

    // Still signed in (the app did not bounce us to /login), now via a cookie...
    await expect(page.getByRole('heading', { level: 1, name: /Where the business/ })).toBeVisible();
    await expect
      .poll(async () => (await context.cookies()).some(c => /^sb-.+-auth-token/.test(c.name)))
      .toBe(true);
    // ...and the old localStorage copy is gone so it cannot be replayed.
    expect(await page.evaluate(k => localStorage.getItem(k), legacyKey)).toBeNull();
    await context.close();
  });
});
