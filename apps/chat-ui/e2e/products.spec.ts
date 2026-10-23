import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const p = readManifest().products;
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);
const num = (n: number) => n.toLocaleString('en-GB');

const table = (page: Page) => page.getByRole('region', { name: 'Products' });
// A tile is the card whose mono label is exactly `label` (the page heading can repeat the word).
const tile = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('div.rounded-2xl')
    .filter({ has: page.locator('.eyebrow', { hasText: new RegExp(`^${label}$`) }) });
const openProduct = async (page: Page, name: string) => {
  await page.goto(`/products?q=${encodeURIComponent(name)}`);
  await table(page).locator('tr', { hasText: name }).getByRole('button').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('region', { name: 'Details' })).toBeVisible();
  return drawer;
};

test.describe('products', () => {
  test('headline numbers: products, units, revenue, best seller', async ({ page }) => {
    await page.goto('/products');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(tile(page, 'Products')).toContainText(num(p.total));
    await expect(tile(page, 'Products')).toContainText(`${p.selling} selling`);
    await expect(tile(page, 'Units sold')).toContainText(num(p.units));
    await expect(tile(page, 'Revenue')).toContainText(gbp0(p.revenue));
    await expect(tile(page, 'Best seller')).toContainText(p.topName);
    await expect(tile(page, 'Best seller')).toContainText(gbp0(p.topRevenue));
  });

  test('lists the products that never sold, which the old page hid', async ({ page }) => {
    await page.goto('/products');
    const tabs = page.getByRole('tablist');
    await expect(tabs.getByRole('tab', { name: /^All/ })).toContainText(num(p.total));
    await expect(tabs.getByRole('tab', { name: /^Selling/ })).toContainText(num(p.selling));
    await expect(tabs.getByRole('tab', { name: /^Slowing/ })).toContainText(num(p.slowing));
    await expect(tabs.getByRole('tab', { name: /^Never sold/ })).toContainText(num(p.never));

    await tabs.getByRole('tab', { name: /^Never sold/ }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(p.never);
    for (const name of p.neverNames) await expect(table(page)).toContainText(name);
    await expect(table(page).locator('tbody tr').first()).toContainText('Never sold');
  });

  test('a product that sold only long ago is slowing', async ({ page }) => {
    await page.goto('/products?tab=slowing');
    await expect(table(page).locator('tbody tr')).toHaveCount(p.slowing);
    await expect(table(page).locator('tbody tr')).toContainText(p.slowingName);
    await expect(table(page).locator('tbody tr')).toContainText('Slowing');
  });

  test('"slowing" and "never sold" are one click away', async ({ page }) => {
    await page.goto('/products');
    await page.getByRole('button', { name: new RegExp(`^${p.slowing} slowing`) }).click();
    await expect(page).toHaveURL(/tab=slowing/);
    await page.goto('/products');
    await page.getByRole('button', { name: new RegExp(`^${p.never} never sold`) }).click();
    await expect(page).toHaveURL(/tab=never/);
  });

  test('ranked by revenue by default; units and name re-rank it', async ({ page }) => {
    await page.goto('/products');
    const first = () => table(page).locator('tbody tr').first();
    await expect(first()).toContainText(p.topName);

    await page
      .getByRole('group', { name: 'Sort by' })
      .getByRole('button', { name: 'Name' })
      .click();
    await expect(first()).toContainText('Brushed Cotton Tee');
    await expect(page).toHaveURL(/sort=name/);
  });

  test('revenue share is of the whole range, so it does not move as the search narrows', async ({
    page,
  }) => {
    await page.goto('/products');
    const row = () => table(page).locator('tr', { hasText: p.topName });
    // Share is only on wide screens; read it from the row when present.
    const wide = (page.viewportSize()?.width ?? 0) >= 1024;
    const before = wide ? await row().locator('td').nth(5).innerText() : '';
    await page.getByRole('searchbox', { name: 'Search products' }).fill(p.topName);
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    if (wide) await expect(row().locator('td').nth(5)).toHaveText(before);
  });

  test('search narrows the list and can be cleared', async ({ page }) => {
    await page.goto('/products');
    await page.getByRole('searchbox', { name: 'Search products' }).fill('zzz-nothing');
    await expect(page.getByText('Nothing matches.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).first().click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(table(page).locator('tbody tr').first()).toBeVisible();
  });

  test('a product opens to how it sells and what its variants cost', async ({ page }) => {
    const drawer = await openProduct(page, p.topName);
    await expect(drawer).toContainText(p.topName);
    const sales = drawer.getByLabel('Sales');
    await expect(sales).toContainText(gbp0(p.topRevenue));
    await expect(sales).toContainText(num(p.topUnits));
    await expect(sales).toContainText(String(p.topOrders));
    await expect(
      drawer.getByRole('region', { name: 'Variants' }).getByRole('listitem')
    ).toHaveCount(2);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/product=/);
  });

  test('a product that has not sold says so, and one that sold long ago says when', async ({
    page,
  }) => {
    let drawer = await openProduct(page, p.neverNames[0]);
    await expect(drawer).toContainText('has not sold yet');
    await page.keyboard.press('Escape');
    drawer = await openProduct(page, p.slowingName);
    await expect(drawer).toContainText(/Last sold \d+ months ago/);
  });

  test('the assistant answers in place, and says so when it cannot', async ({ page }) => {
    // The agent is not part of these tests: stand in for its two endpoints. Like the real
    // server, it answers the browser's preflight and refuses a request with no user token.
    const cors = {
      'access-control-allow-origin': '*',
      // `*` does not cover Authorization, so it is named.
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': '*',
    };
    let runStatus = 200;
    const standIn = (route: Route, status: number, body: unknown) =>
      route.fulfill({
        status,
        headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const guarded = (answer: (route: Route) => Promise<void>) => async (route: Route) => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (!/^Bearer \S+/.test(request.headers()['authorization'] ?? ''))
        return standIn(route, 401, { detail: 'Missing bearer token' });
      return answer(route);
    };
    await page.route(
      '**/threads',
      guarded(route => standIn(route, 200, { thread_id: 't-1' }))
    );
    await page.route(
      '**/threads/t-1/runs/wait',
      guarded(route =>
        runStatus === 200
          ? standIn(route, 200, { messages: [{ type: 'ai', content: 'Raise the price by 5%.' }] })
          : standIn(route, runStatus, {})
      )
    );
    const drawer = await openProduct(page, p.topName);
    const pricing = drawer.getByRole('button', { name: /Pricing analysis/ });
    await pricing.click();
    await expect(drawer.getByText('Raise the price by 5%.')).toBeVisible();
    await pricing.click(); // a second press hides the answer
    await expect(drawer.getByText('Raise the price by 5%.')).toHaveCount(0);

    runStatus = 500;
    await drawer.getByRole('button', { name: /Demand forecast/ }).click();
    await expect(drawer.getByRole('alert')).toContainText('could not answer');
  });

  test('a product that does not exist says so', async ({ page }) => {
    await page.goto('/products?product=00000000-0000-4000-8000-000000000000');
    // Not in the list, so nothing opens: the page does not break.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('has no horizontal overflow in any stage', async ({ page }) => {
    for (const tab of ['all', 'selling', 'slowing', 'never']) {
      await page.goto(`/products?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('has no accessibility violations: the list and the drawer', async ({ page }) => {
    test.slow();
    for (const tab of ['all', 'never']) {
      await page.goto(`/products?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations.map(v => v.id),
        tab
      ).toEqual([]);
    }
    await openProduct(page, p.topName);
    const r = await new AxeBuilder({ page }).analyze();
    expect(
      r.violations.map(v => v.id),
      'drawer'
    ).toEqual([]);
  });
});
