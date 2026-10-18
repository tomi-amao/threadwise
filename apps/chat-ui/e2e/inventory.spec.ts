import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const inv = readManifest().inventory;
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);
const num = (n: number) => n.toLocaleString('en-GB');
const attention = inv.oversold + inv.outOfStock + inv.low + inv.unlinked + inv.uncosted;

test.describe('inventory', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/inventory');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  const tile = (page: import('@playwright/test').Page, label: string) =>
    page.getByRole('main').getByText(label, { exact: true }).first().locator('xpath=..');

  test('the headline numbers match the seed, to the penny', async ({ page }) => {
    await expect(tile(page, 'Stock value')).toContainText(gbp0(inv.stockValue));
    await expect(tile(page, 'Units on hand')).toContainText(num(inv.unitsOnHand));
    await expect(tile(page, 'Needs attention')).toContainText(String(attention));
    await expect(tile(page, 'Invested')).toContainText(gbp0(inv.invested));
    await expect(tile(page, 'Invested')).toContainText(`${num(inv.unitsPurchased)} units bought`);
  });

  test('jump-to flags count each kind of problem and open the right filtered view', async ({
    page,
  }) => {
    const jump = page.getByRole('button', { name: new RegExp(`^${inv.oversold} oversold`) });
    await expect(jump).toBeVisible();
    await expect(
      page.getByRole('button', { name: `${inv.outOfStock} out of stock` })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: `${inv.low} low` })).toBeVisible();
    await expect(page.getByRole('button', { name: `${inv.unlinked} not linked` })).toBeVisible();
    await expect(
      page.getByRole('button', { name: `${inv.uncosted} without a cost` })
    ).toBeVisible();

    await jump.click();
    await expect(page).toHaveURL(/tab=stock/);
    await expect(page).toHaveURL(/view=oversold/);
    const rows = page.getByRole('region', { name: 'Stock levels' }).locator('tbody tr');
    await expect(rows).toHaveCount(inv.oversold);
    await expect(rows.first()).toContainText(inv.oversoldSku);
    await expect(rows.first()).toContainText('Oversold');
  });

  test('stock tab shows every state, with the right label', async ({ page }) => {
    const table = page.getByRole('region', { name: 'Stock levels' });
    const row = (sku: string) => table.locator('tr', { hasText: sku });
    await expect(row(inv.oversoldSku)).toContainText('Oversold');
    await expect(row(inv.outSku)).toContainText('Out of stock');
    await expect(row(inv.lowSku)).toContainText('Low');
    await expect(row(inv.healthySku)).toContainText('In stock');
    await expect(row(inv.unlimitedSku)).toContainText('Unlimited');
    await expect(row(inv.sampleSku)).toContainText('Sample');
    // Oversold shows its negative figure, not a clamped zero.
    await expect(row(inv.oversoldSku).locator('td').nth(2)).toHaveText('-3');
    // An unlinked variant has no stock figure, so it is not in this tab.
    await expect(row(inv.unlinkedSku)).toHaveCount(0);
  });

  test('stock filters narrow the table', async ({ page }) => {
    const group = page.getByRole('group', { name: 'Filter' });
    const rows = page.getByRole('region', { name: 'Stock levels' }).locator('tbody tr');

    await group.getByRole('button', { name: 'Low' }).click();
    await expect(rows).toHaveCount(inv.low);
    await group.getByRole('button', { name: 'Out' }).click();
    await expect(rows).toHaveCount(inv.outOfStock);
    await group.getByRole('button', { name: 'Samples' }).click();
    await expect(rows).toHaveCount(2); // one sample, one material
    await group.getByRole('button', { name: 'All' }).click();
    await expect(page).not.toHaveURL(/view=/);
  });

  test('search matches name or SKU and can be cleared', async ({ page }) => {
    const rows = page.getByRole('region', { name: 'Stock levels' }).locator('tbody tr');
    await page.getByRole('searchbox', { name: 'Search inventory' }).fill(inv.healthySku);
    await expect(rows).toHaveCount(1);
    await expect(page).toHaveURL(/q=/);
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect.poll(() => rows.count()).toBeGreaterThan(5);
  });

  test('items tab flags unlinked and uncosted items', async ({ page }) => {
    await page.getByRole('tab', { name: /^Items/ }).click();
    const table = page.getByRole('region', { name: 'Inventory items' });
    await expect(table.locator('tbody tr')).toHaveCount(Math.min(50, inv.itemCount));
    await expect(table.locator('tr', { hasText: inv.unlinkedSku })).toContainText('Not linked');
    await expect(table.locator('tr', { hasText: inv.uncostedSku })).toContainText('No cost');

    await page
      .getByRole('group', { name: 'Filter' })
      .getByRole('button', { name: 'No cost' })
      .click();
    await expect(table.locator('tbody tr')).toHaveCount(inv.uncosted);
  });

  // Regression: movements used to be read with a plain select(), which the API caps at 1,000.
  test('movements tab counts every movement, not just the first 1,000', async ({ page }) => {
    expect(inv.movementCount).toBeGreaterThan(1000);
    await page.getByRole('tab', { name: /^Movements/ }).click();
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText(
      `OF ${num(inv.movementCount)}`
    );
    await expect(page.getByRole('tab', { name: /^Movements/ })).toContainText(
      num(inv.movementCount)
    );
  });

  test('movements filter by type and page through', async ({ page }) => {
    await page.goto('/inventory?tab=movements');
    const pager = page.getByRole('navigation', { name: 'Pagination' });
    await expect(pager).toContainText('1 / ');
    await pager.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(pager).toContainText('2 / ');

    await page
      .getByRole('group', { name: 'Filter' })
      .getByRole('button', { name: 'Gifts' })
      .click();
    await expect(page).not.toHaveURL(/page=/);
    const rows = page.getByRole('region', { name: 'Inventory movements' }).locator('tbody tr');
    await expect(rows).toHaveCount(1); // the seed gifts two units of one item, in one movement
    await expect(rows.first()).toContainText('Gift');
    await expect(rows.first()).toContainText('−2');
  });

  test('valuation totals what has been invested', async ({ page }) => {
    await page.getByRole('tab', { name: /^Valuation/ }).click();
    const table = page.getByRole('region', { name: 'Valuation by item' });
    await expect(table.locator('tfoot')).toContainText(gbp0(inv.invested));
    await expect(table.locator('tfoot')).toContainText(num(inv.unitsPurchased));
  });

  test('the tab lives in the URL and survives a reload', async ({ page }) => {
    await page.getByRole('tab', { name: /^Valuation/ }).click();
    await expect(page).toHaveURL(/tab=valuation/);
    await page.reload();
    await expect(page.getByRole('tab', { name: /^Valuation/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  test('opening an item shows where its stock figure comes from', async ({ page }) => {
    const row = page
      .getByRole('region', { name: 'Stock levels' })
      .locator('tr', { hasText: inv.oversoldSku });
    await row.getByRole('button').click();
    await expect(page).toHaveURL(/item=/);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Oversold');
    await expect(drawer.getByRole('region', { name: 'Stock' })).toContainText('-3');
    for (const label of ['Purchased', 'Sold', 'Returned', 'Gifted', 'Written off']) {
      await expect(drawer.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(drawer.getByRole('region', { name: 'Recent movements' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/item=/);
  });

  test('the drawer offers a disposal for tracked stock, but not for unlimited or unlinked', async ({
    page,
  }) => {
    const open = async (sku: string) => {
      await page.goto(`/inventory?tab=items&q=${sku}`);
      await page
        .getByRole('region', { name: 'Inventory items' })
        .locator('tbody tr button')
        .first()
        .click();
      return page.getByRole('dialog');
    };
    let drawer = await open(inv.healthySku);
    await expect(drawer.getByRole('region', { name: 'Record a disposal' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Record' })).toBeDisabled();
    await drawer.getByLabel('Units').fill('2');
    await expect(drawer.getByRole('button', { name: 'Record' })).toBeEnabled();

    drawer = await open(inv.unlimitedSku);
    await expect(drawer.getByRole('region', { name: 'Record a disposal' })).toHaveCount(0);

    drawer = await open(inv.unlinkedSku);
    await expect(drawer.getByText('not linked to a product')).toBeVisible();
    await expect(drawer.getByRole('region', { name: 'Record a disposal' })).toHaveCount(0);
  });

  test('the save button needs a change and a valid cost', async ({ page }) => {
    await page.goto(`/inventory?tab=items&q=${inv.healthySku}`);
    await page
      .getByRole('region', { name: 'Inventory items' })
      .locator('tbody tr button')
      .first()
      .click();
    const drawer = page.getByRole('dialog');
    const save = drawer.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeDisabled();
    const cost = drawer.getByLabel('Unit cost (GBP)');
    await cost.fill('-1');
    await expect(save).toBeDisabled();
    await cost.fill('');
    await expect(save).toBeDisabled();
    await cost.fill('19.5');
    await expect(save).toBeEnabled();
  });

  test('no horizontal overflow on any tab', async ({ page }) => {
    for (const tab of ['stock', 'items', 'movements', 'valuation']) {
      await page.goto(`/inventory?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('has no accessibility violations on any tab or with the drawer open', async ({ page }) => {
    test.slow(); // five page loads and five axe scans
    for (const tab of ['stock', 'items', 'movements', 'valuation']) {
      await page.goto(`/inventory?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations,
        `${tab}: ${JSON.stringify(results.violations.map(v => v.id))}`
      ).toEqual([]);
    }
    await page.goto('/inventory');
    await page
      .getByRole('region', { name: 'Stock levels' })
      .locator('tbody tr button')
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map(v => v.id)).toEqual([]);
  });
});
