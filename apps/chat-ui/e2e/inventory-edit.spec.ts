/**
 * Inventory tests that change data. They run in the `mutations` project, after every
 * read-only test, and put the database back as they found it.
 */

import { test, expect, readManifest } from './fixtures';
import {
  deleteStandInMovements,
  readItemBySku,
  readItems,
  restoreItem,
  type ItemRow,
} from './helpers/db';

const inv = readManifest().inventory;
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);

let snapshot: ItemRow[] = [];

test.beforeEach(async () => {
  snapshot = await readItems();
});

test.afterEach(async () => {
  await deleteStandInMovements();
  for (const row of snapshot) await restoreItem(row);
});

async function openItem(page: import('@playwright/test').Page, sku: string) {
  await page.goto(`/inventory?tab=items&q=${sku}`);
  await page
    .getByRole('region', { name: 'Inventory items' })
    .locator('tbody tr button')
    .first()
    .click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  return drawer;
}

const tile = (page: import('@playwright/test').Page, label: string) =>
  page.getByRole('main').getByText(label, { exact: true }).first().locator('xpath=..');

test.describe('inventory edits', () => {
  test('recording a gift lowers on-hand and shows in the breakdown and the ledger', async ({
    page,
  }) => {
    const drawer = await openItem(page, inv.healthySku);
    const stock = drawer.getByRole('region', { name: 'Stock' });
    await expect(stock).toContainText('120');

    await drawer.getByLabel('Units').fill('5');
    await drawer.getByRole('button', { name: 'Record' }).click();

    await expect(page.getByText('Gift recorded')).toBeVisible();
    await expect(stock).toContainText('115');
    await expect(drawer.getByRole('region', { name: 'Recent movements' })).toContainText('Gift');
    await expect(drawer.getByLabel('Units')).toHaveValue('');

    // The headline tiles follow: 5 fewer units on hand.
    await page.keyboard.press('Escape');
    await expect(tile(page, 'Units on hand')).toContainText(
      (inv.unitsOnHand - 5).toLocaleString('en-GB')
    );
  });

  test('a write-off is recorded as a write-off', async ({ page }) => {
    const drawer = await openItem(page, inv.healthySku);
    await drawer.getByRole('button', { name: 'Write-off' }).click();
    await drawer.getByLabel('Units').fill('3');
    await drawer.getByRole('button', { name: 'Record' }).click();
    await expect(page.getByText('Write-off recorded')).toBeVisible();
    await expect(drawer.getByRole('region', { name: 'Recent movements' })).toContainText(
      'Write-off'
    );
  });

  test('a refused disposal says so and changes nothing', async ({ page }) => {
    const drawer = await openItem(page, inv.healthySku);
    await drawer.getByLabel('Units').fill('5000');
    await drawer.getByRole('button', { name: 'Record' }).click();
    await expect(page.getByText(/Failed to record disposal/)).toBeVisible();
    await expect(drawer.getByRole('region', { name: 'Stock' })).toContainText('120');
  });

  test('changing the unit cost updates stock value', async ({ page }) => {
    const drawer = await openItem(page, inv.healthySku);
    // 120 units on hand, so +£10 each is +£1,200 of stock value.
    const before = (await readItemBySku(inv.healthySku)).unit_cost;
    const next = Number(before) + 10;
    await drawer.getByLabel('Unit cost (GBP)').fill(String(next));
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Item saved')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(tile(page, 'Stock value')).toContainText(gbp0(inv.stockValue + 1200));
  });

  test('giving an uncosted item a cost clears its flag', async ({ page }) => {
    await page.goto('/inventory');
    await expect(
      page.getByRole('button', { name: `${inv.uncosted} without a cost` })
    ).toBeVisible();

    const drawer = await openItem(page, inv.uncostedSku);
    await drawer.getByLabel('Unit cost (GBP)').fill('15');
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Item saved')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /without a cost/ })).toHaveCount(0);
  });

  test('linking an unlinked variant to a product brings it into stock', async ({ page }) => {
    const drawer = await openItem(page, inv.unlinkedSku);
    await drawer.getByLabel('Linked product').selectOption({ label: 'Merino Scarf' });
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Item saved')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /not linked/ })).toHaveCount(0);
    await page.goto(`/inventory?q=${inv.unlinkedSku}`);
    await expect(
      page.getByRole('region', { name: 'Stock levels' }).locator('tr', { hasText: inv.unlinkedSku })
    ).toBeVisible();
  });

  test('turning an item into a sample unlinks it and takes it out of the headline numbers', async ({
    page,
  }) => {
    const drawer = await openItem(page, inv.healthySku);
    await drawer.getByRole('button', { name: 'Sample' }).click();
    await expect(drawer.getByLabel('Linked product')).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Item saved')).toBeVisible();

    const changed = await readItemBySku(inv.healthySku);
    expect({ item_type: changed.item_type, product_id: changed.product_id }).toEqual({
      item_type: 'sample',
      product_id: null,
    });

    await page.keyboard.press('Escape');
    // Its 120 units leave the sellable total.
    await expect(tile(page, 'Units on hand')).toContainText(
      (inv.unitsOnHand - 120).toLocaleString('en-GB')
    );
  });
});
