import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const c = readManifest().customerStats;
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);
const num = (n: number) => n.toLocaleString('en-GB');

const table = (page: Page) => page.getByRole('region', { name: 'Customers' });
// A tile is the card whose mono label is exactly `label` (the page heading can repeat the word).
const tile = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('div.rounded-2xl')
    .filter({ has: page.locator('.eyebrow', { hasText: new RegExp(`^${label}$`) }) });
test.describe('customers', () => {
  test('headline numbers: customers, repeat rate, lifetime value, top customer', async ({
    page,
  }) => {
    await page.goto('/customers');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const buyers = c.total - c.never;
    await expect(tile(page, 'Customers')).toContainText(num(c.total));
    await expect(tile(page, 'Customers')).toContainText(`${buyers} have ordered`);
    await expect(tile(page, 'Repeat rate')).toContainText(
      `${Math.round((c.repeat / buyers) * 100)}%`
    );
    await expect(tile(page, 'Average lifetime value')).toContainText(gbp0(c.spentTotal / buyers));
    await expect(tile(page, 'Top customer')).toContainText(c.topSpender);
    await expect(tile(page, 'Top customer')).toContainText(gbp0(c.topSpenderSpent));
  });

  test('each segment has the right people in it', async ({ page }) => {
    await page.goto('/customers');
    const tabs = page.getByRole('tablist');
    await expect(tabs.getByRole('tab', { name: /^All/ })).toContainText(num(c.total));
    await expect(tabs.getByRole('tab', { name: /^Repeat buyers/ })).toContainText(num(c.repeat));
    await expect(tabs.getByRole('tab', { name: /^One-time/ })).toContainText(num(c.oneTime));
    await expect(tabs.getByRole('tab', { name: /^Lapsed/ })).toContainText(num(c.lapsed));
    await expect(tabs.getByRole('tab', { name: /^Never ordered/ })).toContainText(num(c.never));

    await tabs.getByRole('tab', { name: /^One-time/ }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(c.oneTime);
    await expect(table(page).locator('tbody tr')).toContainText(c.oneTimeName);
    await tabs.getByRole('tab', { name: /^Never ordered/ }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(c.never);
  });

  test('a row labels the customer by what matters most', async ({ page }) => {
    await page.goto('/customers');
    const row = (name: string) => table(page).locator('tr', { hasText: name });
    await expect(row(c.oneTimeName)).toContainText('One-time');
    // Two orders, but both months ago: lapsed is the one to act on, not "repeat".
    await expect(row(c.lapsedName)).toContainText('Lapsed');
    await expect(row(c.neverName)).toContainText('Never ordered');
    await expect(row(c.topSpender)).toContainText('Repeat');
  });

  test('sorted by spend by default, and the sort can be changed', async ({ page }) => {
    await page.goto('/customers');
    const first = () => table(page).locator('tbody tr').first();
    await expect(first()).toContainText(c.topSpender);

    await page
      .getByRole('group', { name: 'Sort by' })
      .getByRole('button', { name: 'Name' })
      .click();
    await expect(first()).toContainText('Amara Okafor');
    await expect(page).toHaveURL(/sort=name/);
  });

  test('"gone quiet" jumps to the lapsed customers', async ({ page }) => {
    await page.goto('/customers');
    await page.getByRole('button', { name: new RegExp(`^${c.lapsed} gone quiet`) }).click();
    await expect(page).toHaveURL(/tab=lapsed/);
    await expect(table(page).locator('tbody tr')).toHaveCount(c.lapsed);
    await expect(table(page).locator('tbody tr')).toContainText(c.lapsedName);
  });

  test('search finds by name or email and can be cleared', async ({ page }) => {
    await page.goto('/customers');
    await page.getByRole('searchbox', { name: 'Search customers' }).fill('zed.onetime@');
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page).not.toHaveURL(/q=/);
  });

  test('a customer opens to their spend, what they buy and their orders', async ({ page }) => {
    await page.goto(`/customers?q=${encodeURIComponent(c.topSpender)}`);
    await table(page).locator('tr', { hasText: c.topSpender }).getByRole('button').click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('region', { name: 'Orders' })).toBeVisible();
    await expect(drawer.getByLabel('Summary')).toContainText(gbp0(c.topSpenderSpent));
    await expect(drawer.getByLabel('Summary')).toContainText(num(c.topSpenderOrders));
    await expect(drawer.getByRole('region', { name: 'Favourite products' })).toBeVisible();
    await expect(
      drawer.getByRole('region', { name: 'Orders' }).getByRole('link').first()
    ).toHaveAttribute('href', /\/orders\?order=/);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/customer=/);
  });

  test('a customer who never ordered says so', async ({ page }) => {
    await page.goto(`/customers?q=${encodeURIComponent(c.neverName)}`);
    await table(page).locator('tr', { hasText: c.neverName }).getByRole('button').click();
    await expect(page.getByRole('dialog')).toContainText('has not ordered yet');
    await expect(
      page.getByRole('dialog').getByRole('region', { name: 'Favourite products' })
    ).toHaveCount(0);
  });

  test('a customer that does not exist says so', async ({ page }) => {
    await page.goto('/customers?customer=00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not found');
  });

  test('has no horizontal overflow in any segment', async ({ page }) => {
    for (const tab of ['all', 'repeat', 'one-time', 'lapsed', 'never']) {
      await page.goto(`/customers?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('has no accessibility violations: the list and the drawer', async ({ page }) => {
    test.slow();
    for (const tab of ['all', 'never']) {
      await page.goto(`/customers?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations.map(v => v.id),
        tab
      ).toEqual([]);
    }
    await page.goto(`/customers?q=${encodeURIComponent(c.topSpender)}`);
    await table(page).locator('tr', { hasText: c.topSpender }).getByRole('button').click();
    await expect(page.getByRole('dialog').getByRole('region', { name: 'Orders' })).toBeVisible();
    const r = await new AxeBuilder({ page }).analyze();
    expect(
      r.violations.map(v => v.id),
      'drawer'
    ).toEqual([]);
  });
});
