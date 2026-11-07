/**
 * Integrations talks to the agent from the browser, so these tests stand in for the agent at the
 * network edge: each request the page makes to it is answered here, and the ones that change
 * something are recorded so the tests can check what was asked.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures';

interface Source {
  id: string;
  provider: string;
  display_name: string | null;
  external_account_id: string;
  entity_id: string | null;
  sync_status: 'idle' | 'syncing' | 'error' | 'completed';
  sync_error: string | null;
  last_synced_at: string | null;
  entity_name: string | null;
  stats: Record<string, number> | null;
  api_key_status: 'pending' | 'valid' | 'invalid' | 'expired';
  api_key_last_validated_at: string | null;
  hidden_at?: string | null;
  auth_method?: 'key' | 'oauth';
  api_key_error: string | null;
  failed_events_count: number;
  uncategorized_transactions_count: number;
  endpoint_sync_state: Record<
    string,
    {
      last_synced_at: string | null;
      last_run_status: 'completed' | 'error' | null;
      last_run_error: string | null;
    }
  > | null;
  merchant?: {
    source_id: string;
    api_key_status: 'pending' | 'valid' | 'invalid' | 'expired';
    api_key_last_validated_at: string | null;
    api_key_error: string | null;
  } | null;
}

const base = (over: Partial<Source>): Source => ({
  id: 'src-x',
  provider: 'shopify',
  display_name: null,
  external_account_id: 'x',
  entity_id: null,
  sync_status: 'completed',
  sync_error: null,
  last_synced_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  entity_name: null,
  stats: null,
  api_key_status: 'valid',
  api_key_last_validated_at: null,
  api_key_error: null,
  failed_events_count: 0,
  uncategorized_transactions_count: 0,
  endpoint_sync_state: null,
  ...over,
});

const SOURCES: Source[] = [
  base({
    id: 'src-shop',
    provider: 'shopify',
    display_name: 'Atelier Shop',
    external_account_id: 'atelier.myshopify.com',
    stats: { orders: 1200, products: 11, customers: 18 },
    endpoint_sync_state: {
      orders: {
        last_synced_at: new Date().toISOString(),
        last_run_status: 'completed',
        last_run_error: null,
      },
      customers: { last_synced_at: null, last_run_status: 'error', last_run_error: 'Rate limited' },
    },
  }),
  base({
    id: 'src-bank',
    provider: 'revolut',
    display_name: 'Revolut Business',
    external_account_id: 'biz-1',
    stats: { transactions: 1100 },
    api_key_status: 'invalid',
    api_key_error: 'The key was rejected by Revolut',
    failed_events_count: 3,
    uncategorized_transactions_count: 5,
  }),
  base({
    id: 'src-pp',
    provider: 'paypal',
    display_name: 'PayPal',
    external_account_id: 'pay@example.test',
    sync_status: 'syncing',
    stats: { transactions: 40 },
  }),
];

const REVOLUT_REDIRECT_URI = 'http://localhost:5180/api/integrations/revolut/callback';

const CORS = {
  'access-control-allow-origin': '*',
  // `*` does not cover Authorization, so it is named.
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': '*',
};

/** Answer the agent's endpoints. Returns what was asked of it, and lets a test change the list. */
async function mockAgent(
  page: Page,
  initial: Source[] = SOURCES,
  { revolutSignIn = false }: { revolutSignIn?: boolean } = {}
) {
  let sources = [...initial];
  const calls: { method: string; path: string; body: unknown }[] = [];
  // Only the agent's address: the app's own modules live under /app/components/integrations/ too.
  await page.route(
    url =>
      url.port !== '5180' &&
      /^\/(integrations|normalization|oauth|accounting)\//.test(url.pathname),
    async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      // The agent refuses anyone who is not signed in: so does this stand-in.
      if (!/^Bearer \S+/.test(request.headers()['authorization'] ?? ''))
        return json({ detail: 'Missing bearer token' }, 401);
      if (url.pathname === '/integrations/summary') return json(sources);
      if (url.pathname === '/oauth/revolut/setup')
        return json(
          revolutSignIn
            ? { configured: true, redirect_uri: REVOLUT_REDIRECT_URI }
            : { configured: false, redirect_uri: null }
        );
      let body: unknown = null;
      try {
        body = request.postDataJSON();
      } catch {
        /* no body */
      }
      calls.push({ method: request.method(), path: url.pathname, body });
      // Revolut's Merchant key: saved and checked in one call, kept on the Revolut card.
      const merchantKey = /^\/integrations\/sources\/([^/]+)\/merchant-key$/.exec(url.pathname);
      if (merchantKey) {
        const [, id] = merchantKey;
        const merchant =
          request.method() === 'PUT'
            ? {
                source_id: 'src-merchant',
                api_key_status: 'valid' as const,
                api_key_last_validated_at: new Date().toISOString(),
                api_key_error: null,
              }
            : null;
        sources = sources.map(s => (s.id === id ? { ...s, merchant } : s));
        return json(
          merchant
            ? {
                source_id: 'src-merchant',
                status: 'valid',
                message: 'Merchant key saved and working',
              }
            : { source_id: id, removed: true }
        );
      }
      const hide = /^\/integrations\/sources\/([^/]+)\/hidden$/.exec(url.pathname);
      if (hide) {
        const [, id] = hide;
        const hiddenAt = (body as { hidden: boolean }).hidden ? new Date().toISOString() : null;
        sources = sources.map(s => (s.id === id ? { ...s, hidden_at: hiddenAt } : s));
        return json({ source_id: id, hidden_at: hiddenAt });
      }
      if (request.method() === 'DELETE') {
        const id = url.pathname.split('/').pop();
        sources = sources.filter(s => s.id !== id);
        return json({ source_id: id, status: 'deleted', events_deleted: 12 });
      }
      if (url.pathname.endsWith('/sync'))
        return json({ source_id: 'x', status: 'triggered', message: 'ok', event_ids: [] });
      if (url.pathname.endsWith('/validate'))
        return json({ source_id: 'x', status: 'valid', message: 'ok', provider: 'x' });
      if (url.pathname === '/integrations/sources' && request.method() === 'POST') {
        return json({ id: 'new', provider: (body as { provider: string }).provider });
      }
      return json({ status: 'queued', message: 'ok' });
    }
  );
  return { calls, setSources: (s: Source[]) => (sources = s) };
}

const tile = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('div.bg-card')
    .filter({ has: page.locator('.eyebrow', { hasText: new RegExp(`^${label}$`) }) })
    .first();

/** The tile of a connected app, by the start of its name ("Shopify", "Revolut"). */
const appTile = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}\\b`) });

/** Open a connected app from its tile; returns its detail, in the drawer. */
async function openApp(page: Page, name: string) {
  await appTile(page, name).click();
  const detail = page.getByRole('dialog').getByRole('article');
  await expect(detail).toBeVisible();
  return detail;
}

test.describe('integrations', () => {
  test('the numbers across the top say how many sources, and how many need you', async ({
    page,
  }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(tile(page, 'Connected')).toContainText('3');
    await expect(tile(page, 'Items')).toContainText('2,369'); // 1,229 + 1,100 + 40
    await expect(tile(page, 'Needs you')).toContainText('1');
  });

  test('each app is a tile that says how it stands', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    const apps = page.getByRole('region', { name: 'Your apps' });
    await expect(apps.getByRole('listitem')).toHaveCount(3);
    await expect(appTile(page, 'Shopify')).toHaveAccessibleName(/^Shopify Atelier Shop Up to date/);
    await expect(appTile(page, 'Revolut')).toHaveAccessibleName(
      /^Revolut Revolut Business Key rejected/
    );
    await expect(appTile(page, 'PayPal')).toContainText('Syncing');
  });

  test('opening an app shows what needs a person, with the action beside it', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    const shop = await openApp(page, 'Shopify');
    await expect(page.getByRole('dialog')).toContainText('Atelier Shop');
    await expect(shop).toContainText('Up to date');
    await expect(shop).toContainText('Key works');
    await expect(shop.getByRole('button', { name: /^orders/i })).toContainText('1,200');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const bank = await openApp(page, 'Revolut');
    await expect(bank).toContainText('Key rejected');
    await expect(bank).toContainText('API key issue');
    await expect(bank).toContainText('The key was rejected by Revolut');
    await expect(bank).toContainText('3 failed events');
    await expect(bank).toContainText('5 uncategorised transactions');
    await expect(bank.getByRole('button', { name: 'Update API key' })).toBeVisible();
  });

  test('the open app is in the URL, so a link lands on it', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    await openApp(page, 'PayPal');
    await expect(page).toHaveURL(/[?&]app=src-pp/);
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/app=/);

    await page.goto('/integrations?app=src-shop');
    await expect(page.getByRole('dialog')).toContainText('Atelier Shop');
  });

  test('a link with ?journals=1 opens Generate journals, and closing it leaves the URL', async ({
    page,
  }) => {
    // The "payments need journals" notification links here.
    await mockAgent(page);
    await page.goto('/integrations?journals=1');
    const heading = page.getByRole('heading', { name: 'Generate Journals' });
    await expect(heading).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(heading).toBeHidden();
    await expect(page).not.toHaveURL(/journals=/);
  });

  test('a source that has not synced for two weeks is out of date, and needs you', async ({
    page,
  }) => {
    await mockAgent(page, [
      base({
        id: 'src-old',
        provider: 'squarespace',
        display_name: 'Old Site',
        last_synced_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      }),
      base({ id: 'src-fresh', provider: 'paypal', display_name: 'PayPal' }),
    ]);
    await page.goto('/integrations');
    await expect(appTile(page, 'Squarespace')).toContainText('Out of date');
    await expect(appTile(page, 'Squarespace')).toContainText('Last synced 2 weeks ago');
    await expect(appTile(page, 'PayPal')).toContainText('Up to date');
    await expect(tile(page, 'Needs you')).toContainText('1');
    const old = await openApp(page, 'Squarespace');
    await expect(old).toContainText('Last synced 2 weeks ago: sync to bring it up to date');
  });

  test('a key that works gets no toast; one that is refused says so', async ({ page }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    const toasts = page.locator('[data-sonner-toast]');
    const shop = await openApp(page, 'Shopify');
    const check = shop.getByRole('button', { name: 'Check the Shopify connection' });

    await check.click();
    await expect.poll(() => agent.calls.filter(c => c.path.endsWith('/validate')).length).toBe(1);
    await expect(check).toHaveText(/Check$/);
    await expect(toasts.filter({ hasText: /validated|works/i })).toHaveCount(0);

    // Later routes win: from here on the agent refuses the key.
    await page.route(
      url => url.port !== '5180' && url.pathname.endsWith('/validate'),
      route =>
        route.request().method() === 'OPTIONS'
          ? route.fulfill({ status: 204, headers: CORS })
          : route.fulfill({
              headers: { ...CORS, 'content-type': 'application/json' },
              body: JSON.stringify({
                source_id: 'src-shop',
                status: 'invalid',
                message: 'Shopify said 401',
                provider: 'shopify',
              }),
            })
    );
    await check.click();
    await expect(
      toasts.filter({ hasText: 'The key was not accepted: Shopify said 401' })
    ).toBeVisible();
  });

  test('a sync can be run, with a full resync one menu away', async ({ page }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    const shop = await openApp(page, 'Shopify');
    await shop.getByRole('button', { name: 'More ways to sync all data' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toContainText('Fetches only what changed');
    await menu.getByRole('menuitem', { name: /Full resync/ }).click();
    await expect
      .poll(() => agent.calls.find(c => c.path === '/integrations/sources/src-shop/sync')?.body)
      .toMatchObject({ force_full: true });

    await shop.getByRole('button', { name: /^orders/i }).click();
    await expect
      .poll(() => agent.calls.filter(c => c.path.endsWith('/sync')).length)
      .toBeGreaterThanOrEqual(2);
  });

  test('the menu closes with Escape, and the app stays open', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    const shop = await openApp(page, 'Shopify');
    await shop.getByRole('button', { name: 'More ways to sync all data' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(shop).toBeVisible();
  });

  test('hiding moves an app to Hidden, still connected, and Show brings it back', async ({
    page,
  }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    const pp = await openApp(page, 'PayPal');
    await pp.getByRole('button', { name: 'Hide' }).click();
    await expect
      .poll(() => agent.calls.find(c => c.path === '/integrations/sources/src-pp/hidden')?.body)
      .toEqual({ hidden: true });
    await page.keyboard.press('Escape');

    const apps = page.getByRole('region', { name: 'Your apps' });
    await expect(apps.getByRole('listitem')).toHaveCount(2);
    const hidden = page.locator('details', { hasText: 'Hidden' });
    await expect(hidden).toContainText('1 app, still connected and syncing');
    // Still connected: it counts, and it is not offered as an app to connect.
    await expect(tile(page, 'Connected')).toContainText('3');
    await expect(page.getByRole('button', { name: /^Connect PayPal/ })).toHaveCount(0);

    await hidden.locator('summary').click();
    const again = await openApp(page, 'PayPal');
    await again.getByRole('button', { name: 'Show' }).click();
    await page.keyboard.press('Escape');
    await expect(apps.getByRole('listitem')).toHaveCount(3);
    await expect(page.locator('details', { hasText: 'Hidden' })).toHaveCount(0);
  });

  test('removing asks first, says what it does, and then removes', async ({ page }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    const pp = await openApp(page, 'PayPal');
    await pp.getByRole('button', { name: /Remove/ }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Remove PayPal?' });
    await expect(confirm).toContainText('cannot be undone');
    await confirm.getByRole('button', { name: 'Keep it' }).click();
    expect(agent.calls.some(c => c.method === 'DELETE')).toBe(false);

    await pp.getByRole('button', { name: /Remove/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove integration' }).click();
    await expect
      .poll(() => agent.calls.some(c => c.method === 'DELETE' && c.path.endsWith('/src-pp')))
      .toBe(true);
    await expect(appTile(page, 'PayPal')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Connect PayPal/ })).toBeVisible();
  });

  test('an app not connected yet is a tile that starts connecting it', async ({ page }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    const add = page.getByRole('region', { name: 'Add an app' });
    await expect(add.getByRole('button')).toHaveText([/Squarespace/, /Zoho Calendar/]);

    await page.getByRole('button', { name: /^Connect Squarespace/ }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByRole('radio', { name: /Squarespace/ })).toBeChecked();
    await expect(d.getByRole('button', { name: 'Connect' })).toBeDisabled();
    await d.getByLabel(/Site ID/).fill('site-123');
    await d.getByLabel(/API key/).fill('secret-key');
    await d.getByRole('button', { name: 'Connect' }).click();
    await expect(d).toBeHidden();
    await expect
      .poll(
        () => agent.calls.find(c => c.path === '/integrations/sources' && c.method === 'POST')?.body
      )
      .toMatchObject({
        provider: 'squarespace',
        external_account_id: 'site-123',
        api_key: 'secret-key',
      });
  });

  test('Revolut takes a Merchant key in its detail, for the invoices sent from Revolut', async ({
    page,
  }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    const bank = await openApp(page, 'Revolut');
    const invoices = bank.getByRole('region', { name: 'Invoices from Revolut' });
    await expect(invoices).toContainText('No Merchant key');
    // Without the key, the invoices cannot be synced on their own.
    await expect(bank.getByRole('button', { name: /^payment requests/i })).toBeDisabled();

    await invoices.getByRole('button', { name: 'Add Merchant key' }).click();
    await invoices.getByLabel('Merchant secret key').fill('sk_merchant');
    await invoices.getByRole('button', { name: 'Save and check' }).click();
    await expect(invoices).toContainText('Key works');
    await expect(bank.getByRole('button', { name: /^payment requests/i })).toBeEnabled();
    expect(
      agent.calls.find(c => c.path === '/integrations/sources/src-bank/merchant-key')
    ).toMatchObject({ method: 'PUT', body: { api_key: 'sk_merchant' } });

    // Checking it again asks the agent about the Merchant key's own row.
    await invoices.getByRole('button', { name: 'Check the Merchant key' }).click();
    await expect
      .poll(() => agent.calls.some(c => c.path === '/integrations/sources/src-merchant/validate'))
      .toBe(true);
  });

  test('the Merchant key can be removed, after confirming, and the app stays', async ({ page }) => {
    const agent = await mockAgent(
      page,
      SOURCES.map(s =>
        s.id === 'src-bank'
          ? {
              ...s,
              merchant: {
                source_id: 'src-merchant',
                api_key_status: 'valid',
                api_key_last_validated_at: null,
                api_key_error: null,
              },
            }
          : s
      )
    );
    await page.goto('/integrations');
    const bank = await openApp(page, 'Revolut');
    const invoices = bank.getByRole('region', { name: 'Invoices from Revolut' });
    await expect(invoices).toContainText('Key works');
    await invoices.getByRole('button', { name: 'Remove key' }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: 'Remove the Merchant key?' })
      .getByRole('button', { name: 'Remove key' })
      .click();
    await expect(invoices).toContainText('No Merchant key');
    await expect(bank).toBeVisible();
    expect(
      agent.calls.find(c => c.path === '/integrations/sources/src-bank/merchant-key')?.method
    ).toBe('DELETE');
  });

  test('connecting Revolut can take the Merchant key at the same time', async ({ page }) => {
    const agent = await mockAgent(
      page,
      SOURCES.filter(s => s.provider !== 'revolut')
    );
    await page.goto('/integrations');
    await page.getByRole('button', { name: /^Connect Revolut/ }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByRole('radio', { name: /Revolut/ })).toBeChecked();
    await d.getByLabel(/Business ID/).fill('biz-2');
    await d.getByLabel(/^API key/).fill('business-token');
    await d.getByLabel(/Merchant secret key/).fill('sk_merchant');
    await d.getByRole('button', { name: 'Connect' }).click();
    await expect(d).toBeHidden();
    await expect
      .poll(() => agent.calls.find(c => c.path === '/integrations/sources/new/merchant-key'))
      .toMatchObject({ method: 'PUT', body: { api_key: 'sk_merchant' } });
    expect(
      agent.calls.find(c => c.path === '/integrations/sources' && c.method === 'POST')?.body
    ).toMatchObject({ provider: 'revolut', api_key: 'business-token' });
  });

  test('no other provider asks for a Merchant key', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    const shop = await openApp(page, 'Shopify');
    await expect(shop.getByRole('region', { name: 'Invoices from Revolut' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Connect Squarespace/ }).click();
    await expect(page.getByRole('dialog').getByLabel(/Merchant secret key/)).toHaveCount(0);
  });

  test('Zoho signs in through Zoho instead of asking for a key', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    await page.getByRole('button', { name: /^Connect Zoho Calendar/ }).click();
    const d = page.getByRole('dialog');
    // A plain link to the app's own route, which signs the request and redirects to Zoho.
    await expect(d.getByRole('link', { name: /Connect with Zoho/ })).toHaveAttribute(
      'href',
      '/api/integrations/zoho/connect'
    );
    await expect(d.getByLabel(/API key/)).toHaveCount(0);
  });

  test('the Zoho link asks the agent as the signed-in user, then follows its redirect', async ({
    page,
  }) => {
    // The stand-in agent only answers a live user token, so reaching its redirect proves the
    // app sent one. (The link itself cannot carry a header, which is why it goes through the app.)
    await mockAgent(page);
    await page.goto('/api/integrations/zoho/connect');
    await expect(page.getByText('Zoho Calendar connected').first()).toBeVisible();
  });

  test('Revolut signs in through Revolut when this server offers it', async ({ page }) => {
    await mockAgent(
      page,
      SOURCES.filter(s => s.provider !== 'revolut'),
      { revolutSignIn: true }
    );
    let consent: URL | null = null;
    // Nothing reaches the real Revolut. Playwright does not route the target of a redirect, so
    // the app's connect route is answered with its own response, minus the redirect: the
    // consent URL is kept for the test, and a stand-in Revolut page is shown instead.
    await page.route(
      url => url.hostname.endsWith('revolut.com'),
      route => route.abort()
    );
    await page.route('**/api/integrations/revolut/connect?*', async route => {
      const response = await route.fetch({ maxRedirects: 0 });
      consent = new URL(response.headers()['location']);
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': response.headers()['set-cookie'] ?? '',
        },
        body: '<h1>Revolut consent</h1>',
      });
    });
    await page.goto('/integrations');
    await page.getByRole('button', { name: /^Connect Revolut/ }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByRole('link', { name: /Download certificate/ })).toHaveAttribute(
      'href',
      '/api/integrations/revolut/certificate'
    );
    await expect(d.getByText(REVOLUT_REDIRECT_URI)).toBeVisible();
    await expect(d.getByLabel(/API key/)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const connect = d.getByRole('button', { name: /Connect with Revolut/ });
    await expect(connect).toBeDisabled();
    await d.getByLabel(/Business ID/).fill('biz-9');
    await d.getByLabel(/Client ID/).fill('client-123');
    await connect.click();

    // The app asked the agent as the user and sent the browser to Revolut, read-only scope and
    // all decided by the agent; the state is kept in an HttpOnly cookie for the callback.
    await expect(page.getByRole('heading', { name: 'Revolut consent' })).toBeVisible();
    expect(consent!.searchParams.get('client_id')).toBe('client-123');
    const cookie = (await page.context().cookies()).find(c => c.name === 'tw_revolut_sign_in');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

    // Revolut sends the browser back with a one-time code.
    await page.goto(
      `/api/integrations/revolut/callback?code=e2e-code&state=${consent!.searchParams.get('state')}`
    );
    await expect(page).toHaveURL(/\/integrations$/);
    await expect(page.getByText('Revolut connected').first()).toBeVisible();
    expect(
      (await page.context().cookies()).find(c => c.name === 'tw_revolut_sign_in')
    ).toBeUndefined();
  });

  test('a Revolut sign-in Revolut sends back to another browser is refused', async ({ page }) => {
    await mockAgent(page);
    // No cookie: this browser never started a sign-in, so the code is not used.
    await page.goto('/api/integrations/revolut/callback?code=e2e-code&state=e2e-revolut-state');
    await expect(page.getByText(/started in another browser/).first()).toBeVisible();
  });

  test('a Revolut integration with a pasted token can switch to the sign-in in place', async ({
    page,
  }) => {
    await mockAgent(page, SOURCES, { revolutSignIn: true });
    await page.goto('/integrations');
    const bank = await openApp(page, 'Revolut');
    const signIn = bank.getByRole('region', { name: 'Revolut sign-in' });
    await expect(signIn).toContainText('Pasted token');
    await signIn.getByRole('button', { name: 'Set up Revolut sign-in' }).click();
    await expect(signIn.getByText(REVOLUT_REDIRECT_URI)).toBeVisible();
    // The form names this integration, so the sign-in replaces its token and keeps its data.
    await expect(signIn.locator('input[type=hidden][name=source_id]')).toHaveValue('src-bank');
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await expect(signIn.getByRole('button', { name: /Connect with Revolut/ })).toBeDisabled();
  });

  test('a signed-in Revolut integration says so and can reconnect', async ({ page }) => {
    await mockAgent(
      page,
      SOURCES.map(s =>
        s.provider === 'revolut'
          ? { ...s, auth_method: 'oauth', api_key_status: 'valid', api_key_error: null }
          : s
      ),
      { revolutSignIn: true }
    );
    await page.goto('/integrations');
    const bank = await openApp(page, 'Revolut');
    const signIn = bank.getByRole('region', { name: 'Revolut sign-in' });
    await expect(signIn).toContainText('Signed in with Revolut');
    await expect(signIn.getByRole('link', { name: 'Reconnect with Revolut' })).toHaveAttribute(
      'href',
      '/api/integrations/revolut/connect?source_id=src-bank'
    );
  });

  test('with nothing connected it says where to start', async ({ page }) => {
    await mockAgent(page, []);
    await page.goto('/integrations');
    const first = page.getByRole('region', { name: 'Connect your first app' });
    await expect(first.getByRole('button')).toHaveCount(5);
    await expect(page.locator('.eyebrow', { hasText: /^Needs you$/ })).toHaveCount(0);
  });

  test('has no horizontal overflow, and no accessibility violations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockAgent(page);
    await page.goto('/integrations');
    await expect(appTile(page, 'Shopify')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await openApp(page, 'Revolut');
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /^Connect Squarespace/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
