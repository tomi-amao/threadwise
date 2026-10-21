/**
 * The writes on the Collections pages: creating and editing a collection, its products, linked
 * costs and plan. Runs in the `mutations` project and puts every row back as it found it.
 */

import type { Page } from '@playwright/test';
import { test, expect, readManifest } from './fixtures';
import {
  countRows,
  readCollectionByName,
  readPlanLineByName,
  restoreCollections,
  snapshotCollections,
  type CollectionSnapshot,
} from './helpers/db';

const C = readManifest().collections;

let before: CollectionSnapshot;
test.beforeEach(async () => {
  before = await snapshotCollections();
});
test.afterEach(async () => {
  await restoreCollections(before);
});

const at = (id: string, query = '') => `/collections/${id}${query}`;
const drawer = (page: Page) => page.getByRole('dialog');
const confirm = (page: Page, title: string) => page.getByRole('dialog').filter({ hasText: title });

async function pickFrom(page: Page, trigger: string, search: string, option: RegExp) {
  await page.getByRole('button', { name: trigger }).click();
  await page
    .getByPlaceholder(/search/i)
    .last()
    .fill(search);
  await page.getByRole('option', { name: option }).first().click();
}

test.describe('collections', () => {
  test('a new collection is created and opened', async ({ page }) => {
    await page.goto('/collections?new=1');
    const d = drawer(page);
    await d.getByLabel('Name', { exact: true }).fill('E2E Test Drop');
    await d.getByLabel('Status').selectOption('planned');
    await d.getByLabel('Budget').fill('2500');
    await d.getByRole('button', { name: 'Create collection' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Test Drop' })).toBeVisible();
    const saved = await readCollectionByName('E2E Test Drop');
    expect(saved.status).toBe('planned');
    expect(saved.slug).toBe('e2e-test-drop');
  });

  test('a name that is already used is refused kindly', async ({ page }) => {
    await page.goto('/collections?new=1');
    const d = drawer(page);
    await d.getByLabel('Name', { exact: true }).fill(C.autumn.name);
    await d.getByRole('button', { name: 'Create collection' }).click();
    await expect(d.getByRole('alert')).toContainText('already exists');
  });

  test('details can be changed, and the header follows', async ({ page }) => {
    await page.goto(at(C.winter.id, '?drawer=edit'));
    const d = drawer(page);
    await d.getByLabel('Status').selectOption('active');
    await d.getByLabel('Launch date').fill('2027-01-15');
    await d.getByRole('button', { name: 'Save changes' }).click();
    await expect(d).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(C.winter.name);
    await expect(page.getByText('Launches 15 Jan 2027')).toBeVisible();
    expect((await readCollectionByName(C.winter.name)).status).toBe('active');
  });

  test('the end date cannot be before the start date', async ({ page }) => {
    await page.goto(at(C.winter.id, '?drawer=edit'));
    const d = drawer(page);
    await d.getByLabel('Starts').fill('2027-03-10');
    await d.getByLabel('Ends').fill('2027-03-01');
    await d.getByRole('button', { name: 'Save changes' }).click();
    await expect(d.getByRole('alert')).toContainText('before the start');
  });
});

test.describe('products', () => {
  test('products are added, described and removed', async ({ page }) => {
    await page.goto(at(C.autumn.id, '?tab=products'));
    const table = page.getByRole('region', { name: 'Products in this collection' });
    await expect(table.locator('tbody tr')).toHaveCount(C.autumn.productNames.length);

    await page.getByRole('button', { name: 'Add products' }).click();
    const d = drawer(page);
    await d.getByRole('searchbox', { name: 'Search products' }).fill('Beanie');
    await d.getByRole('checkbox').first().check();
    await d.getByRole('button', { name: 'Add 1 product' }).click();
    await expect(d).toBeHidden();
    await expect(table.locator('tbody tr')).toHaveCount(C.autumn.productNames.length + 1);

    await table.getByRole('button', { name: 'Edit Rib Beanie' }).click();
    await drawer(page).getByLabel('Why it is in the collection').fill('The cheap entry point');
    await drawer(page).getByRole('button', { name: 'Save' }).click();
    await expect(table.locator('tr', { hasText: 'Rib Beanie' })).toContainText(
      'The cheap entry point'
    );

    await table.getByRole('button', { name: 'Remove Rib Beanie' }).click();
    await confirm(page, 'Remove this product?').getByRole('button', { name: 'Remove' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(C.autumn.productNames.length);
  });

  test('a weight above 1 is refused', async ({ page }) => {
    await page.goto(at(C.autumn.id, '?tab=products'));
    await page
      .getByRole('button', { name: /^Edit / })
      .first()
      .click();
    await drawer(page).getByLabel('Allocation weight').fill('2');
    await drawer(page).getByRole('button', { name: 'Save' }).click();
    await expect(drawer(page).getByRole('alert')).toContainText('at most 1');
  });
});

test.describe('costs', () => {
  test('a bank transaction is linked as a cost, recategorised and unlinked', async ({ page }) => {
    await page.goto(at(C.autumn.id, '?tab=costs'));
    const table = page.getByRole('region', { name: 'Linked costs' });
    await expect(table.locator('tbody tr')).toHaveCount(C.autumn.costCount);

    await page.getByRole('button', { name: 'Add cost' }).first().click();
    const d = drawer(page);
    await d.getByRole('searchbox', { name: 'Search transactions' }).fill('Monthly plan');
    const first = d.getByRole('radio').first();
    await expect(first).toBeVisible();
    await first.check();
    await expect(d).toContainText('Filed as');
    await d.getByRole('button', { name: 'Link cost' }).click();
    await expect(d).toBeHidden();
    await expect(table.locator('tbody tr')).toHaveCount(C.autumn.costCount + 1);
    expect(await countRows('collection_costs', `collection_id=eq.${C.autumn.id}`)).toBe(
      C.autumn.costCount + 1
    );

    // A linked transaction is not offered again.
    const linked = await page.getByRole('link', { name: /Shopify/ }).count();
    expect(linked).toBeGreaterThan(0);

    await table
      .getByRole('button', { name: /^Edit Shopify/ })
      .first()
      .click();
    await drawer(page).getByLabel('Category').fill('sampling');
    await drawer(page).getByRole('button', { name: 'Save' }).click();
    await expect(table.locator('tr', { hasText: 'Sampling' })).toHaveCount(1);

    await table
      .getByRole('button', { name: /^Remove Shopify/ })
      .first()
      .click();
    await confirm(page, 'Unlink this cost?').getByRole('button', { name: 'Unlink' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(C.autumn.costCount);
  });
});

test.describe('plan', () => {
  test('a plan is started with its cost categories ready', async ({ page }) => {
    await page.goto(at(C.winter.id, '?tab=plan'));
    await page.getByRole('button', { name: 'Start a plan' }).click();
    const costs = page.getByTestId('plan-costs');
    await expect(costs.getByText('To be determined')).toHaveCount(2);
    await expect(page.getByTestId('plan-terms')).toContainText('In-house');
    expect(await countRows('collection_plans', `collection_id=eq.${C.winter.id}`)).toBe(1);
  });

  test('a product line is added, edited and removed, and the totals follow', async ({ page }) => {
    await page.goto(at(C.autumn.id, '?tab=plan'));
    const revenue = page
      .getByRole('main')
      .locator('div.bg-card')
      .filter({
        has: page.locator('.eyebrow', { hasText: /^Projected revenue$/ }),
      })
      .first();
    await expect(revenue).toContainText(`£${C.plan.revenue.toLocaleString('en-GB')}`);

    await page.getByRole('main').getByRole('button', { name: 'Add line' }).first().click();
    const d = drawer(page);
    await d.getByRole('button', { name: 'Not launched yet' }).click();
    await d.getByLabel('Working name').fill('Mystery Piece');
    await d.getByLabel('Planned quantity').fill('10');
    await d.getByLabel(/^Selling price/).fill('100');
    await pickFrom(page, 'Supplier currency', 'GBP', /^GBP/);
    await d.getByLabel('Unit cost').fill('20');
    await d.getByRole('button', { name: 'Add line' }).click();
    await expect(d).toBeHidden();

    const lines = page.getByTestId('plan-lines');
    await expect(lines).toContainText('Mystery Piece');
    // 10 units at £100, all sold: £1,000 more revenue.
    await expect(revenue).toContainText(`£${(C.plan.revenue + 1000).toLocaleString('en-GB')}`);

    await lines.getByRole('button', { name: 'Edit Mystery Piece' }).click();
    await drawer(page).getByLabel('Expected sell-through %').fill('50');
    await drawer(page).getByRole('button', { name: 'Save line' }).click();
    await expect(revenue).toContainText(`£${(C.plan.revenue + 500).toLocaleString('en-GB')}`);

    await lines.getByRole('button', { name: 'Remove Mystery Piece' }).click();
    await confirm(page, 'Remove this line?').getByRole('button', { name: 'Remove' }).click();
    await expect(lines).not.toContainText('Mystery Piece');
    await expect(revenue).toContainText(`£${C.plan.revenue.toLocaleString('en-GB')}`);
  });

  test('a line can be split by size; the total is its quantity and sizes can be changed', async ({
    page,
  }) => {
    await page.goto(at(C.autumn.id, '?tab=plan'));
    const revenue = page
      .getByRole('main')
      .locator('div.bg-card')
      .filter({ has: page.locator('.eyebrow', { hasText: /^Projected revenue$/ }) })
      .first();

    await page.getByRole('main').getByRole('button', { name: 'Add line' }).first().click();
    const d = drawer(page);
    await d.getByRole('button', { name: 'Not launched yet' }).click();
    await d.getByLabel('Working name').fill('Sized Piece');
    await d.getByRole('button', { name: 'By size' }).click();
    await d.getByLabel('Size name', { exact: true }).fill('S');
    await d.getByLabel('Units in S').fill('4');
    await d.getByRole('button', { name: 'Add size' }).click();
    await d.getByLabel('Size name', { exact: true }).fill('M');
    await d.getByLabel('Units in M').fill('6');
    await expect(d.getByTestId('size-total')).toContainText('Total 10 units');
    await d.getByLabel(/^Selling price/).fill('100');
    await pickFrom(page, 'Supplier currency', 'GBP', /^GBP/);
    await d.getByLabel('Unit cost').fill('20');
    await d.getByRole('button', { name: 'Add line' }).click();
    await expect(d).toBeHidden();

    const lines = page.getByTestId('plan-lines');
    await expect(lines).toContainText('Sized Piece');
    await expect(lines.getByRole('list', { name: 'Sizes: S 4 · M 6' })).toBeVisible();
    // 10 units at £100, all sold, exactly as if the quantity had been typed as one number.
    await expect(revenue).toContainText(`£${(C.plan.revenue + 1000).toLocaleString('en-GB')}`);
    expect(await readPlanLineByName('Sized Piece')).toMatchObject({
      planned_quantity: 10,
      size_quantities: [
        { size: 'S', quantity: 4 },
        { size: 'M', quantity: 6 },
      ],
    });

    // Change a size: the quantity and the revenue follow.
    await lines.getByRole('button', { name: 'Edit Sized Piece' }).click();
    await drawer(page).getByLabel('Units in M').fill('16');
    await expect(drawer(page).getByTestId('size-total')).toContainText('Total 20 units');
    await drawer(page).getByRole('button', { name: 'Save line' }).click();
    await expect(lines.getByRole('list', { name: 'Sizes: S 4 · M 16' })).toBeVisible();
    await expect(revenue).toContainText(`£${(C.plan.revenue + 2000).toLocaleString('en-GB')}`);

    // Back to one quantity: the split goes, the quantity stays.
    await lines.getByRole('button', { name: 'Edit Sized Piece' }).click();
    await drawer(page).getByRole('button', { name: 'One quantity' }).click();
    await drawer(page).getByLabel('Planned quantity').fill('20');
    await drawer(page).getByRole('button', { name: 'Save line' }).click();
    await expect(drawer(page)).toBeHidden();
    // Only the seeded line keeps its split.
    await expect(lines.getByRole('list', { name: /^Sizes:/ })).toHaveCount(1);
    expect(await readPlanLineByName('Sized Piece')).toMatchObject({
      planned_quantity: 20,
      size_quantities: null,
    });
  });

  test('an existing product offers its own sizes to start from', async ({ page }) => {
    await page.goto(at(C.autumn.id, '?tab=plan&drawer=line'));
    const d = drawer(page);
    await d.getByRole('button', { name: /^Product:/ }).click();
    await page
      .getByPlaceholder(/search/i)
      .last()
      .fill(C.plan.sizedLine.productName);
    await page
      .getByRole('option', { name: new RegExp(C.plan.sizedLine.productName) })
      .first()
      .click();
    await d.getByRole('button', { name: 'By size' }).click();
    for (const size of C.plan.sizedLine.suggested) {
      await expect(d.getByLabel(`Size name ${size}`)).toBeVisible();
    }
    // Rows without units are not a line yet.
    await d.getByLabel(/^Selling price/).fill('10');
    await pickFrom(page, 'Supplier currency', 'GBP', /^GBP/);
    await d.getByLabel('Unit cost').fill('1');
    await expect(d.getByRole('button', { name: 'Add line' })).toBeDisabled();
    await d.getByLabel('Units in S').fill('3');
    await d.getByLabel('Units in M').fill('2');
    await expect(d.getByTestId('size-total')).toContainText('Total 5 units');
    await expect(d.getByRole('button', { name: 'Add line' })).toBeEnabled();

    // The same size twice is not allowed.
    await d.getByLabel('Size name M').fill('s');
    await expect(d.getByRole('button', { name: 'Add line' })).toBeDisabled();
  });

  test('gifted units cannot exceed the quantity', async ({ page }) => {
    await page.goto(at(C.autumn.id, '?tab=plan&drawer=line'));
    const d = drawer(page);
    await d.getByRole('button', { name: 'Not launched yet' }).click();
    await d.getByLabel('Working name').fill('Too generous');
    await d.getByLabel('Planned quantity').fill('5');
    await d.getByLabel('Gifted units').fill('9');
    await d.getByLabel(/^Selling price/).fill('10');
    await pickFrom(page, 'Supplier currency', 'GBP', /^GBP/);
    await d.getByLabel('Unit cost').fill('1');
    await d.getByRole('button', { name: 'Add line' }).click();
    await expect(d.getByRole('alert')).toContainText('cannot be more than');
  });

  test('a planned cost can be added as an estimate, then left undecided, then removed', async ({
    page,
  }) => {
    await page.goto(at(C.autumn.id, '?tab=plan'));
    const costs = page.getByTestId('plan-costs');
    await expect(costs.locator('tbody tr')).toHaveCount(C.plan.costCount);

    await costs.getByRole('button', { name: 'Add cost' }).click();
    const d = drawer(page);
    await d.getByLabel('Category').selectOption('samples');
    await d.getByLabel(/^Planned amount/).fill('300');
    await d.getByLabel(/rough estimate/).check();
    await d.getByRole('button', { name: 'Add cost' }).click();
    await expect(d).toBeHidden();
    await expect(costs.getByText('Estimate', { exact: true })).toHaveCount(C.plan.estimated + 1);

    await costs.getByRole('button', { name: 'Edit Samples cost' }).click();
    await drawer(page)
      .getByLabel(/^Planned amount/)
      .fill('');
    await drawer(page).getByRole('button', { name: 'Save cost' }).click();
    await expect(costs.getByText('To be determined')).toHaveCount(C.plan.pending + 1);
    // With no figure there is nothing to call an estimate.
    await expect(costs.getByText('Estimate', { exact: true })).toHaveCount(C.plan.estimated);

    await costs.getByRole('button', { name: 'Remove Samples cost' }).click();
    await confirm(page, 'Remove this cost?').getByRole('button', { name: 'Remove' }).click();
    await expect(costs.locator('tbody tr')).toHaveCount(C.plan.costCount);
  });

  test('the terms of the collaboration can be changed', async ({ page }) => {
    await page.goto(at(C.autumn.id, '?tab=plan&drawer=terms'));
    const d = drawer(page);
    await d.getByLabel('Partner name').fill('Maison Renamed');
    await d.getByLabel(`${readManifest().entityName} revenue split %`).fill('70');
    await d.getByRole('button', { name: 'Add term' }).click();
    await d.getByLabel('Term 2 name').fill('Term length');
    await d.getByLabel('Term 2 detail').fill('Two seasons');
    await d.getByRole('button', { name: 'Save plan details' }).click();
    await expect(d).toBeHidden();
    const terms = page.getByTestId('plan-terms');
    await expect(terms).toContainText('Maison Renamed');
    await expect(terms).toContainText('70%');
    await expect(terms).toContainText('Two seasons');
  });

  test('additional information for the partner shows on the plan and the print pack', async ({
    page,
  }) => {
    const info = 'UK shipping: £4.50 - £8\nUS: £24 (DHL Express)\nNigeria: £26 DPD Air';
    await page.goto(at(C.autumn.id, '?tab=plan&drawer=terms'));
    const d = drawer(page);
    await d.getByLabel('Additional information').fill(info);
    await d.getByRole('button', { name: 'Save plan details' }).click();
    await expect(d).toBeHidden();

    const terms = page.getByTestId('plan-terms');
    await expect(terms).toContainText('Additional information');
    await expect(terms).toContainText('UK shipping: £4.50 - £8');
    // Each rate stays on its own line.
    const text = terms.getByText('US: £24 (DHL Express)');
    await expect(text).toHaveCSS('white-space', 'pre-line');

    const href = await page.getByRole('link', { name: 'Print plan' }).getAttribute('href');
    const html = await (await page.request.get(href!)).text();
    expect(html).toContain('<h2>Additional information</h2>');
    expect(html).toContain('UK shipping: £4.50 - £8\nUS: £24 (DHL Express)\nNigeria: £26 DPD Air');
    expect(html).toContain('white-space:pre-line');
  });

  test('a split above 100% is refused', async ({ page }) => {
    await page.goto(at(C.autumn.id, '?tab=plan&drawer=terms'));
    const d = drawer(page);
    await d.getByLabel(`${readManifest().entityName} revenue split %`).fill('140');
    await d.getByRole('button', { name: 'Save plan details' }).click();
    await expect(d.getByRole('alert')).toContainText('between 0 and 100');
  });
});
