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

  test('has one h1 and one h2 per panel', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    const h2s = await page.getByRole('heading', { level: 2 }).allInnerTexts();
    expect(h2s.map(t => t.toLowerCase())).toEqual([
      'monthly gross revenue',
      'orders by status',
      'top products',
      'payment methods',
      'bank accounts',
      'latest orders',
      'top customers',
    ]);
  });

  test('shows the six headline numbers from the seed', async ({ page }) => {
    const main = page.getByRole('main');
    for (const label of [
      'Gross revenue',
      'Net revenue',
      'Orders',
      'Customers',
      'In the bank',
      'Processing fees',
    ]) {
      await expect(main.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(
      main.getByText(`${seed.orderCount.toLocaleString('en-GB')} orders`).first()
    ).toBeVisible();
    await expect(
      main.getByText(`${seed.bankAccountCount} accounts`, { exact: true })
    ).toBeVisible();
    await expect(main.getByText(String(seed.customerCount), { exact: true }).first()).toBeVisible();
  });

  test('the first screen holds the key numbers and the revenue chart', async ({ page }) => {
    // The point of the layout: no scrolling needed to see the KPIs and the trend.
    const viewport = page.viewportSize()!;
    test.skip(viewport.width < 1024, 'single column below 1024px; the chart sits below the tiles');
    const inView = async (locator: import('@playwright/test').Locator) => {
      const box = await locator.boundingBox();
      return !!box && box.y + 120 < viewport.height;
    };
    expect(await inView(page.getByText('Gross revenue', { exact: true }).first())).toBe(true);
    expect(await inView(page.getByTestId('panel-revenue'))).toBe(true);
    expect(await inView(page.getByTestId('panel-status'))).toBe(true);
  });

  test('uses the full width of the page', async ({ page }) => {
    test.skip(page.viewportSize()!.width < 1280, 'only meaningful where the grid is multi-column');
    const main = await page.getByRole('main').boundingBox();
    const panel = await page.getByTestId('panel-revenue').boundingBox();
    // Panels start within one gutter of the content edge, not centred in a narrow column.
    expect(panel!.x - main!.x).toBeLessThanOrEqual(40);
    const rightEdge = main!.x + main!.width;
    const status = await page.getByTestId('panel-status').boundingBox();
    expect(rightEdge - (status!.x + status!.width)).toBeLessThanOrEqual(40);
  });

  // Regression: the API caps every read at 1,000 rows (max_rows), and the dashboard's `.limit(10000)`
  // could not raise it, so a store with more than 1,000 orders or bank transactions silently
  // got wrong totals. The seed deliberately exceeds both.
  test('counts every order, not just the first 1,000', async ({ page }) => {
    expect(seed.orderCount).toBeGreaterThan(1000);
    await expect(
      page
        .getByRole('main')
        .getByText(`${seed.orderCount.toLocaleString('en-GB')} orders`)
        .first()
    ).toBeVisible();
  });

  test('bank balance includes every transaction, not just the first 1,000', async ({ page }) => {
    expect(seed.transactionCount).toBeGreaterThan(1000);
    const expected = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
      maximumFractionDigits: 0,
    }).format(seed.expectedBankBalance);
    await expect(page.getByRole('main').getByText(expected, { exact: true }).first()).toBeVisible();
  });

  test('order statuses add up to the total number of orders', async ({ page }) => {
    const card = page.getByTestId('panel-status');
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

    await group.getByRole('button', { name: '6m' }).click();
    await expect.poll(monthsInChart).toBe(6);

    await group.getByRole('button', { name: '12m' }).click();
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
    await expect(table('Most recent orders').locator('tbody tr')).toHaveCount(10);
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
      ['Reports', '/reports'],
      ['All products', '/products'],
      ['All customers', '/customers'],
      ['Cash flow', '/reports'],
    ] as const) {
      await expect(main.getByRole('link', { name, exact: true }).first()).toHaveAttribute(
        'href',
        href
      );
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
