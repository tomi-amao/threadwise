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

const CORS = {
  'access-control-allow-origin': '*',
  // `*` does not cover Authorization, so it is named.
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': '*',
};

/** Answer the agent's endpoints. Returns what was asked of it, and lets a test change the list. */
async function mockAgent(page: Page, initial: Source[] = SOURCES) {
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
      let body: unknown = null;
      try {
        body = request.postDataJSON();
      } catch {
        /* no body */
      }
      calls.push({ method: request.method(), path: url.pathname, body });
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

  test('each source shows its state, and what needs a person is called out', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    const shop = page.getByRole('article', { name: 'Atelier Shop' });
    await expect(shop).toContainText('Up to date');
    await expect(shop).toContainText('Key works');
    await expect(shop.getByRole('button', { name: /^orders/i })).toContainText('1,200');

    const bank = page.getByRole('article', { name: 'Revolut Business' });
    await expect(bank).toContainText('Key rejected');
    await expect(bank).toContainText('API key issue');
    await expect(bank).toContainText('The key was rejected by Revolut');
    await expect(bank).toContainText('3 failed events');
    await expect(bank).toContainText('5 uncategorised transactions');
    await expect(bank.getByRole('button', { name: 'Update API key' })).toBeVisible();

    await expect(page.getByRole('article', { name: 'PayPal' })).toContainText('Syncing');
  });

  test('a sync can be run, with a full resync one menu away', async ({ page }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    const shop = page.getByRole('article', { name: 'Atelier Shop' });
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

  test('the menu closes with Escape', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations');
    await page
      .getByRole('article', { name: 'Atelier Shop' })
      .getByRole('button', { name: 'More ways to sync all data' })
      .click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('removing asks first, says what it does, and then removes', async ({ page }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    const pp = page.getByRole('article', { name: 'PayPal' });
    await pp.getByRole('button', { name: /Remove/ }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Remove PayPal?' });
    await expect(dialog).toContainText('cannot be undone');
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    expect(agent.calls.some(c => c.method === 'DELETE')).toBe(false);

    await pp.getByRole('button', { name: /Remove/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove integration' }).click();
    await expect
      .poll(() => agent.calls.some(c => c.method === 'DELETE' && c.path.endsWith('/src-pp')))
      .toBe(true);
    await expect(page.getByRole('article', { name: 'PayPal' })).toHaveCount(0);
  });

  test('a source is connected from a drawer, and the provider decides the fields', async ({
    page,
  }) => {
    const agent = await mockAgent(page);
    await page.goto('/integrations');
    await page.getByRole('button', { name: 'Add integration' }).first().click();
    const d = page.getByRole('dialog');
    await expect(d.getByRole('button', { name: 'Connect' })).toBeDisabled();

    await d.getByRole('radio', { name: /Squarespace/ }).click();
    await expect(d.getByLabel(/Site ID/)).toBeVisible();
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

  test('Zoho signs in through Zoho instead of asking for a key', async ({ page }) => {
    await mockAgent(page);
    await page.goto('/integrations?add=1');
    await page.getByRole('button', { name: 'Add integration' }).first().click();
    const d = page.getByRole('dialog');
    await d.getByRole('radio', { name: /Zoho Calendar/ }).click();
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

  test('with nothing connected it says where to start', async ({ page }) => {
    await mockAgent(page, []);
    await page.goto('/integrations');
    await expect(page.getByText('Connect your first source.')).toBeVisible();
    await expect(page.locator('.eyebrow', { hasText: /^Needs you$/ })).toHaveCount(0);
  });

  test('has no horizontal overflow, and no accessibility violations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockAgent(page);
    await page.goto('/integrations');
    await expect(page.getByRole('article', { name: 'Atelier Shop' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.getByRole('button', { name: 'Add integration' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
