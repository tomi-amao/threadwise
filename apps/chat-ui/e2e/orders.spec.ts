import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const o = readManifest().orders;
const gbp = (n: number, digits = 0) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
const num = (n: number) => n.toLocaleString('en-GB');

const table = (page: Page) => page.getByRole('region', { name: 'Orders' });
// A tile is the card whose mono label is exactly `label` (the page heading can repeat the word).
const tile = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('div.rounded-2xl')
    .filter({ has: page.locator('.eyebrow', { hasText: new RegExp(`^${label}$`) }) });
const openOrder = async (page: Page, number: string) => {
  await page.goto(`/orders?tab=all&q=${encodeURIComponent(number)}`);
  await table(page).locator('tr', { hasText: number }).first().getByRole('button').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('region', { name: 'Items' })).toBeVisible();
  return drawer;
};

test.describe('orders', () => {
  test('describes what is on screen: orders, sales after refunds, average, refunded', async ({
    page,
  }) => {
    await page.goto('/orders?tab=all');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(tile(page, 'Orders')).toContainText(num(o.total));
    await expect(tile(page, 'Sales')).toContainText(gbp(o.sales));
    await expect(tile(page, 'Average order')).toContainText(gbp(o.sales / o.total, 2));
    await expect(tile(page, 'Refunded')).toContainText(gbp(o.refunded));
    await expect(tile(page, 'Refunded')).toContainText(`${o.refundedCount} orders`);
  });

  // Regression: the old page showed the first 100 of "1,200 total orders".
  test('reaches every order, not just the first page or the first 1,000', async ({ page }) => {
    expect(o.total).toBeGreaterThan(1000);
    await page.goto('/orders?tab=all');
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText(
      `OF ${num(o.total)}`
    );
    await expect(page.getByRole('tab', { name: /^All/ })).toContainText(num(o.total));
  });

  test('the tabs are the stages an order moves through, and open on what needs sending', async ({
    page,
  }) => {
    await page.goto('/orders');
    const tabs = page.getByRole('tablist');
    await expect(tabs.getByRole('tab', { name: /^To fulfil/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(tabs.getByRole('tab', { name: /^To fulfil/ })).toContainText(num(o.toFulfil));
    await expect(tabs.getByRole('tab', { name: /^On the way/ })).toContainText(num(o.shipped));
    await expect(tabs.getByRole('tab', { name: /^Delivered/ })).toContainText(num(o.delivered));
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText(
      `OF ${num(o.toFulfil)}`
    );
  });

  test('search takes an order number with or without the #, or a customer', async ({ page }) => {
    await page.goto('/orders?tab=all');
    const box = page.getByRole('searchbox', { name: 'Search orders' });
    await box.fill('1100');
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    await expect(table(page).locator('tbody tr')).toContainText(o.sampleOrderNumber);
    await expect(page).toHaveURL(/q=1100/);

    await box.fill('okafor');
    await expect(table(page).locator('tbody tr').first()).toContainText('Amara Okafor');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/q=/);
  });

  test('a date range with nothing in it says so and offers a way out', async ({ page }) => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await page.goto(`/orders?tab=all&from=${tomorrow}`);
    await expect(page.getByText('Nothing matches.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(table(page)).toBeVisible();
  });

  test('a part-refunded order shows what was refunded', async ({ page }) => {
    await page.goto(`/orders?tab=all&q=${encodeURIComponent(o.refundedOrderNumber)}`);
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    await expect(table(page).locator('tbody tr')).toContainText('refunded');
  });

  test('an order opens to what was bought, what it came to, and how it was paid', async ({
    page,
  }) => {
    const drawer = await openOrder(page, o.sampleOrderNumber);
    await expect(drawer).toContainText(o.sampleOrderNumber);
    const items = drawer.getByRole('region', { name: 'Items' });
    expect(await items.getByRole('listitem').count()).toBeGreaterThan(0);
    await expect(items).toContainText('Subtotal');
    await expect(items).toContainText('Total');
    await expect(items).toContainText('VAT');
    await expect(drawer.getByRole('region', { name: 'Payment' })).toContainText('after fees');
    await expect(drawer.getByRole('link', { name: /View customer/ })).toHaveAttribute(
      'href',
      /\/customers\?customer=/
    );

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/order=/);
  });

  test('a refunded order shows the refund in its totals', async ({ page }) => {
    const drawer = await openOrder(page, o.refundedOrderNumber);
    await expect(drawer.getByRole('region', { name: 'Items' })).toContainText('Refunded');
    await expect(drawer).toContainText('Part refunded');
  });

  test('an order that does not exist says so', async ({ page }) => {
    await page.goto('/orders?order=00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not found');
  });

  test('has no horizontal overflow in any stage', async ({ page }) => {
    for (const tab of ['fulfil', 'shipped', 'delivered', 'closed', 'all']) {
      await page.goto(`/orders?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('has no accessibility violations: each stage and the drawer', async ({ page }) => {
    test.slow();
    for (const tab of ['fulfil', 'closed', 'all']) {
      await page.goto(`/orders?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations.map(v => v.id),
        tab
      ).toEqual([]);
    }
    await openOrder(page, o.sampleOrderNumber);
    const r = await new AxeBuilder({ page }).analyze();
    expect(
      r.violations.map(v => v.id),
      'drawer'
    ).toEqual([]);
  });
});
