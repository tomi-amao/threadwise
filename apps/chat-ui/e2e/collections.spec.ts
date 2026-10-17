import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const seed = readManifest();
const C = seed.collections;
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);
const num = (n: number) => n.toLocaleString('en-GB');

const stat = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('div.bg-card')
    .filter({ has: page.locator('.eyebrow', { hasText: new RegExp(`^${label}$`) }) })
    .first();
const panel = (page: Page, testId: string) => page.getByTestId(testId);
const detail = (id: string, query = '') => `/collections/${id}${query}`;

test.describe('collections list', () => {
  test('the numbers across the top add up the whole portfolio', async ({ page }) => {
    await page.goto('/collections');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(stat(page, 'Revenue')).toContainText(gbp0(C.totalRevenue));
    await expect(stat(page, 'Linked costs')).toContainText(gbp0(C.totalCost));
    await expect(stat(page, 'Gross profit')).toContainText(gbp0(C.totalRevenue - C.totalCost));
    await expect(stat(page, 'Live now')).toContainText(String(C.active));
  });

  test('every collection is a row, with its own revenue and margin', async ({ page }) => {
    await page.goto('/collections');
    const table = page.getByRole('region', { name: 'Collections' });
    await expect(table.locator('tbody tr')).toHaveCount(C.count);
    const autumn = table.locator('tr', { hasText: C.autumn.name });
    await expect(autumn).toContainText(gbp0(C.autumn.revenue));
    await expect(autumn).toContainText(gbp0(C.autumn.cost));
    await expect(autumn).toContainText('Active');
    await expect(table.locator('tr', { hasText: C.winter.name })).toContainText('Planned');
  });

  test("another business's collection is never listed", async ({ page }) => {
    await page.goto('/collections');
    await expect(page.getByRole('region', { name: 'Collections' })).toBeVisible();
    await expect(page.getByText(C.rivalName)).toHaveCount(0);
  });

  test('search and the status filter narrow the list, and clear again', async ({ page }) => {
    await page.goto('/collections');
    const rows = page.getByRole('region', { name: 'Collections' }).locator('tbody tr');
    await expect(rows).toHaveCount(C.count);
    await page
      .getByRole('group', { name: 'Status' })
      .getByRole('button', { name: /^Active/ })
      .click();
    await expect(rows).toHaveCount(C.active);
    await expect(rows.first()).toContainText(C.autumn.name);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows).toHaveCount(C.count);
    await page.getByRole('searchbox', { name: 'Search collections' }).fill('linens');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(C.summer.name);
  });

  test('sorting by revenue puts the biggest first', async ({ page }) => {
    await page.goto('/collections');
    await page
      .getByRole('group', { name: 'Sort' })
      .getByRole('button', { name: 'Revenue' })
      .click();
    await expect(
      page.getByRole('region', { name: 'Collections' }).locator('tbody tr').first()
    ).toContainText(C.autumn.name);
  });

  test('a row opens the collection', async ({ page }) => {
    await page.goto('/collections');
    await page.getByRole('link', { name: new RegExp(C.autumn.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/collections/${C.autumn.id}`));
    await expect(page.getByRole('heading', { level: 1, name: C.autumn.name })).toBeVisible();
  });
});

test.describe('one collection', () => {
  test('the overview works profit out from sales and linked costs', async ({ page }) => {
    await page.goto(detail(C.autumn.id));
    await expect(page.getByRole('heading', { level: 1, name: C.autumn.name })).toBeVisible();
    await expect(stat(page, 'Revenue')).toContainText(gbp0(C.autumn.revenue));
    await expect(stat(page, 'Revenue')).toContainText(`${num(C.autumn.units)} units`);
    await expect(stat(page, 'Revenue')).toContainText(`${num(C.autumn.orders)} orders`);
    await expect(stat(page, 'Costs')).toContainText(gbp0(C.autumn.cost));
    await expect(stat(page, 'Gross profit')).toContainText(gbp0(C.autumn.revenue - C.autumn.cost));
    await expect(panel(page, 'collection-budget')).toContainText('remaining');
    await expect(
      page.getByRole('region', { name: 'Best sellers' }).getByRole('heading', { level: 3 })
    ).toHaveCount(3);
  });

  test('a collection with no sales or spend says so rather than showing zeros as results', async ({
    page,
  }) => {
    await page.goto(detail(C.winter.id));
    await expect(stat(page, 'Margin')).toContainText('–');
    await expect(panel(page, 'collection-weekly')).toContainText('No sales yet');
    await expect(panel(page, 'collection-budget')).toContainText('No budget set');
  });

  test('the plan projects revenue and says who pays what', async ({ page }) => {
    await page.goto(detail(C.autumn.id, '?tab=plan'));
    await expect(stat(page, 'Projected revenue')).toContainText(gbp0(C.plan.revenue));
    await expect(stat(page, 'Net profit')).toContainText(gbp0(C.plan.netProfit));
    await expect(stat(page, 'Other costs')).toContainText(
      `${C.plan.pending} still to be determined`
    );
    await expect(stat(page, 'Other costs')).toContainText(`${C.plan.estimated} estimated`);
    await expect(panel(page, 'plan-partner-due')).toContainText(gbp0(C.plan.partnerDue));
    await expect(panel(page, 'plan-terms')).toContainText('Maison Test');
    await expect(panel(page, 'plan-terms')).toContainText('Exclusivity');
    await expect(panel(page, 'plan-terms')).toContainText('UK only');
    await expect(panel(page, 'plan-payouts')).toContainText('Maison Test');
  });

  test('costs not yet decided are marked, and estimates are flagged', async ({ page }) => {
    await page.goto(detail(C.autumn.id, '?tab=plan'));
    const costs = panel(page, 'plan-costs');
    await expect(costs.getByText('To be determined')).toHaveCount(C.plan.pending);
    await expect(costs.getByText('Estimate', { exact: true })).toHaveCount(C.plan.estimated);
  });

  test('the scenario switch changes the projection without changing the plan', async ({ page }) => {
    await page.goto(detail(C.autumn.id, '?tab=plan'));
    const group = page.getByRole('group', { name: 'Scenario' });
    const revenue = stat(page, 'Projected revenue');
    await expect(revenue).toContainText(gbp0(C.plan.revenue));
    await group.getByRole('button', { name: 'Conservative' }).click();
    await expect(revenue).not.toContainText(gbp0(C.plan.revenue));
    await group.getByRole('button', { name: 'Optimistic' }).click();
    await expect(revenue).not.toContainText(gbp0(C.plan.revenue));
    await group.getByRole('button', { name: 'Base case' }).click();
    await expect(revenue).toContainText(gbp0(C.plan.revenue));
  });

  test('a collection without a plan offers to start one', async ({ page }) => {
    await page.goto(detail(C.winter.id, '?tab=plan'));
    await expect(page.getByRole('button', { name: 'Start a plan' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export pack' })).toHaveCount(0);
  });

  test('the print pack is offered for a plan', async ({ page }) => {
    await page.goto(detail(C.autumn.id, '?tab=plan'));
    await expect(page.getByRole('link', { name: 'Print plan' })).toHaveAttribute(
      'href',
      new RegExp(`plan-pack\\?collection=${C.autumn.id}$`)
    );
    await expect(page.getByRole('link', { name: 'Compare scenarios' })).toHaveAttribute(
      'href',
      /scenarios=1/
    );
  });

  test('products show what each sold and their share', async ({ page }) => {
    await page.goto(detail(C.autumn.id, '?tab=products'));
    const table = page.getByRole('region', { name: 'Products in this collection' });
    await expect(table.locator('tbody tr')).toHaveCount(C.autumn.productNames.length);
    for (const name of C.autumn.productNames) await expect(table).toContainText(name);
    await expect(page.getByRole('tab', { name: /Products/ })).toContainText(
      String(C.autumn.productNames.length)
    );
  });

  test('costs are real transactions, grouped by category, linked to their source', async ({
    page,
  }) => {
    await page.goto(detail(C.autumn.id, '?tab=costs'));
    const table = page.getByRole('region', { name: 'Linked costs' });
    await expect(table.locator('tbody tr')).toHaveCount(C.autumn.costCount);
    await expect(table.getByRole('link').first()).toHaveAttribute(
      'href',
      /\/transactions\?transactionId=/
    );
    await expect(page.getByRole('main')).toContainText(gbp0(C.autumn.cost));
  });

  test('the print pack shows the plan, and only for your own collection', async ({ page }) => {
    const pack = await page.request.get(
      `/api/collections/plan-pack?collection=${C.autumn.id}&scenarios=1`
    );
    expect(pack.status()).toBe(200);
    const html = await pack.text();
    expect(html).toContain(C.autumn.name);
    expect(html).toContain(C.plan.partner);
    expect(html).toContain('Conservative');
    const theirs = await page.request.get(`/api/collections/plan-pack?collection=${C.rivalId}`);
    expect(theirs.status()).toBe(404);
  });

  test("another business's collection cannot be opened by its address", async ({ page }) => {
    await page.goto(detail(C.rivalId));
    await expect(page.getByText(/Couldn.t load the collection/)).toBeVisible();
    await expect(page.getByText(C.rivalName)).toHaveCount(0);
  });

  test('an address that is not a collection says so', async ({ page }) => {
    await page.goto(detail('00000000-0000-4000-8000-000000000000'));
    await expect(page.getByText(/Couldn.t load the collection/)).toBeVisible();
  });
});

test.describe('layout and accessibility', () => {
  const pages = (): [string, string][] => [
    ['list', '/collections'],
    ['overview', detail(C.autumn.id)],
    ['plan', detail(C.autumn.id, '?tab=plan')],
    ['products', detail(C.autumn.id, '?tab=products')],
    ['costs', detail(C.autumn.id, '?tab=costs')],
  ];
  const drawers = (): [string, string][] => [
    ['new', '/collections?new=1'],
    ['edit', detail(C.autumn.id, '?drawer=edit')],
    ['add products', detail(C.autumn.id, '?tab=products&drawer=product')],
    ['add cost', detail(C.autumn.id, '?tab=costs&drawer=cost')],
    ['terms', detail(C.autumn.id, '?tab=plan&drawer=terms')],
    ['line', detail(C.autumn.id, '?tab=plan&drawer=line')],
    ['plan cost', detail(C.autumn.id, '?tab=plan&drawer=plancost')],
  ];

  test('has no horizontal overflow, with a drawer open or not', async ({ page }) => {
    for (const [name, url] of pages()) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(name).toBeTruthy();
    }
    for (const [, url] of drawers()) {
      await page.goto(url);
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    for (const [name, url] of pages()) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, name).toEqual([]);
    }
    for (const [name, url] of drawers()) {
      await page.goto(url);
      await expect(page.getByRole('dialog')).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, `${name} drawer`).toEqual([]);
    }
  });
});
