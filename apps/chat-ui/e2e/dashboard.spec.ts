import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const seed = readManifest();
const MONTH = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}\b/g;

test.describe('dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('names the signed-in business in the page itself, not just the sidebar', async ({
    page,
  }) => {
    // Was the known issue "header shows Your Business": loaders could not see the session.
    // The business now comes from the loader via the auth cookie.
    await expect(page.getByRole('main').getByText(`${seed.entityName} · All time`)).toBeVisible();
    await expect(page.getByRole('main').getByText('Your business · All time')).toHaveCount(0);
  });

  test('has one h1 and a heading for each section', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(5);
  });

  test('stat strip shows the four headline numbers from the seed', async ({ page }) => {
    const main = page.getByRole('main');
    for (const label of ['Gross revenue', 'Net revenue', 'In the bank', 'Customers']) {
      // 'Customers' is both a stat label and a section eyebrow; the stat strip comes first.
      await expect(main.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(main.getByText(`${seed.orderCount} orders ·`)).toBeVisible();
    await expect(
      main.getByText(`${seed.bankAccountCount} accounts`, { exact: true })
    ).toBeVisible();
    await expect(main.getByText(String(seed.customerCount), { exact: true }).first()).toBeVisible();
  });

  test('order statuses add up to the total number of orders', async ({ page }) => {
    const card = page
      .getByText('Orders by status', { exact: true })
      .locator('xpath=ancestor::div[1]');
    // Each <dd> is "<count><span>NN%</span>": read the count text node only.
    const counts = await card
      .locator('dd')
      .evaluateAll(els => els.map(e => e.firstChild?.textContent ?? ''));
    const total = counts.map(t => Number(t.replace(/,/g, ''))).reduce((a, b) => a + b, 0);
    expect(total).toBe(seed.orderCount);
  });

  test('chart window switches between 6 months, 12 months and all', async ({ page }) => {
    const monthsInChart = async () => {
      const summary = await page
        .getByText(/^Monthly gross revenue: /)
        .first()
        .textContent();
      return new Set(summary?.match(MONTH)).size;
    };
    const group = page.getByRole('group', { name: 'Chart window' });

    await group.getByRole('button', { name: '6 months' }).click();
    await expect.poll(monthsInChart).toBe(6);

    await group.getByRole('button', { name: '12 months' }).click();
    await expect.poll(monthsInChart).toBeGreaterThan(6);

    await group.getByRole('button', { name: 'All' }).click();
    const all = await monthsInChart();
    expect(all).toBeGreaterThanOrEqual(10);
    await expect(group.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('lists the top products, payment methods, customers, banks and recent orders', async ({
    page,
  }) => {
    const table = (name: string) => page.getByRole('region', { name });
    expect(
      await table('Top products by revenue').locator('tbody tr').count()
    ).toBeGreaterThanOrEqual(3);
    expect(
      await table('Top customers by lifetime value').locator('tbody tr').count()
    ).toBeGreaterThanOrEqual(3);
    await expect(table('Latest orders').locator('tbody tr')).toHaveCount(10);
    await expect(page.getByRole('main').getByText('Revolut Business')).toBeVisible();
    await expect(page.getByRole('main').getByText('Revolut Savings')).toBeVisible();
    await expect(
      page
        .getByRole('term')
        .filter({ hasText: /Shopify Payments/ })
        .first()
    ).toBeVisible();
  });

  test('section links go where they say', async ({ page }) => {
    const main = page.getByRole('main');
    for (const [name, href] of [
      ['Open reports', '/reports'],
      ['All products', '/products'],
      ['All customers', '/customers'],
      ['Cash flow', '/reports'],
    ] as const) {
      await expect(main.getByRole('link', { name }).first()).toHaveAttribute('href', href);
    }
    await expect(main.getByRole('link', { name: 'All orders' }).first()).toHaveAttribute(
      'href',
      '/orders'
    );
  });

  test('refresh revalidates without leaving the page', async ({ page }) => {
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('main').getByText(/^UPDATED \d{2}:\d{2}$/)).toBeVisible();
  });

  test('has no horizontal overflow', async ({ page }) => {
    await expectNoHorizontalOverflow(page);
  });

  test('passes an automated accessibility scan', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .include('main')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      results.violations.map(
        v => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`
      )
    ).toEqual([]);
  });
});
