/**
 * Transaction tests that change data. They run in the `mutations` project, after every
 * read-only test, and remove what they add.
 *
 * An internal move (money moved between the business's own accounts, such as a merchant
 * payment's payout to the main account) is stored excluded by the sync, but it is shown as its
 * own thing: a neutral chip and a ⇄ amount, not the struck-through look of an excluded row.
 */

import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { addInternalMove, addMerchantPayment, removeInternalMove } from './helpers/db';

const AMOUNT = 1393.61;

test.describe('internal moves', () => {
  test.beforeEach(async () => {
    await addInternalMove(AMOUNT);
  });
  test.afterEach(async () => {
    await removeInternalMove();
  });

  test('a row shows an internal move, not an excluded transaction', async ({ page }) => {
    await page.goto('/transactions');
    const row = page.getByRole('list').locator('li > button').first();
    await expect(row).toContainText('Merchant payout to an internal account');
    await expect(row).toContainText('Internal move');
    await expect(row).not.toContainText('Excluded');
    await expect(row.getByRole('img', { name: 'Moved' })).toBeVisible();
    // Neither in nor out, and not struck through.
    const amount = row.getByText('£1,393.61');
    await expect(amount).not.toHaveClass(/line-through/);
    await expect(row).not.toContainText('−£1,393.61');
  });

  test('the status filter finds internal moves, and Excluded leaves them out', async ({ page }) => {
    await page.goto('/transactions?status=internal');
    const rows = page.getByRole('list').locator('li > button');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Internal move');

    // The list the Excluded filter asks for (the first page comes with the page itself).
    const excluded = page.waitForResponse(r => {
      const url = new URL(r.url());
      return (
        url.pathname === '/api/transactions' && url.searchParams.get('txn_status') === 'excluded'
      );
    });
    await page
      .getByRole('group', { name: 'Status' })
      .getByRole('button', { name: 'Excluded' })
      .click();
    const { transactions } = await (await excluded).json();
    expect(transactions.map((t: { description: string }) => t.description)).not.toContain(
      'Merchant payout to an internal account'
    );
    await expect(page.getByText('Merchant payout to an internal account')).toHaveCount(0);
  });

  test('the drawer says where the money moved and why there is no journal', async ({ page }) => {
    await page.goto('/transactions?status=internal');
    await page.getByRole('list').locator('li > button').first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Internal move');
    await expect(drawer).toContainText('From Revolut Savings (GBP)');
    await expect(drawer).toContainText('To Revolut Business (GBP)');
    await expect(drawer).toContainText('Nothing to journal');
    await expect(drawer).not.toContainText('Excluded because');
    await expect(drawer).not.toContainText('Outbound');

    // It cannot be un-excluded by hand: the sync would only mark it again.
    await drawer.getByRole('button', { name: 'Edit transaction' }).click();
    await expect(drawer.getByRole('checkbox')).toHaveCount(0);
    await expect(drawer).toContainText('stays out of the ledger');

    const scan = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(scan.violations.map(v => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

test.describe('fees', () => {
  test.afterEach(async () => {
    await removeInternalMove();
  });

  test('a merchant payment shows the fee Revolut kept and what reached the account', async ({
    page,
  }) => {
    await addMerchantPayment(1407.89, 14.28);
    await page.goto('/transactions');
    const row = page.getByRole('list').locator('li > button').first();
    await expect(row).toContainText('Merchant payment');
    await expect(row).toContainText('+£1,407.89');
    await expect(row).toContainText('£14.28 fee');

    await row.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Fee');
    await expect(drawer).toContainText('Kept by Revolut: £1,393.61 reached the account');
  });

  test('a transaction without a fee shows none', async ({ page }) => {
    await page.goto('/transactions');
    const row = page.getByRole('list').locator('li > button').first();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('fee');
  });
});
