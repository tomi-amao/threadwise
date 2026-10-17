/**
 * The writes on the Tax page: recording an adjustment, marking a period filed, and saving company
 * details. Runs in the `mutations` project and restores everything it changes.
 */

import { test, expect, readManifest } from './fixtures';
import {
  readAdjustments,
  readEntityTax,
  readPeriod,
  restoreTax,
  snapshotTax,
  type TaxSnapshot,
} from './helpers/db';

const seed = readManifest();
const L = seed.ledger;

let before: TaxSnapshot;
test.beforeEach(async () => {
  before = await snapshotTax(seed.entityName);
});
test.afterEach(async () => {
  await restoreTax(before);
});

const computation = (page: import('@playwright/test').Page) => page.getByTestId('tax-computation');

test('an adjustment changes the tax, and can be removed again', async ({ page }) => {
  await page.goto('/tax');
  const comp = computation(page);
  const due = comp.getByRole('row', { name: /^Corporation tax due/ });
  await expect(due).toContainText('£950');

  await comp.getByRole('button', { name: 'Add adjustment' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('Amount (GBP)').fill('1000');
  await drawer.getByLabel('What it is for').fill('Client entertaining');
  await drawer.getByRole('button', { name: 'Record adjustment' }).click();
  await expect(drawer).toBeHidden();

  // £1,000 more taxable profit at 19% is £190 more tax.
  await expect(due).toContainText('£1,140');
  await expect(comp).toContainText('Client entertaining');
  expect((await readAdjustments()).map(a => a.description)).toContain('Client entertaining');

  await comp.getByRole('button', { name: 'Remove adjustment: Client entertaining' }).click();
  await expect(comp).not.toContainText('Client entertaining');
  await expect(due).toContainText('£950');
  expect(await readAdjustments()).toHaveLength(0);
});

test('an adjustment needs an amount and a reason', async ({ page }) => {
  await page.goto('/tax?adjust=1');
  const drawer = page.getByRole('dialog');
  const save = drawer.getByRole('button', { name: 'Record adjustment' });
  await expect(save).toBeDisabled();
  await drawer.getByLabel('Amount (GBP)').fill('50');
  await expect(save).toBeDisabled();
  await drawer.getByLabel('What it is for').fill('Gift');
  await expect(save).toBeEnabled();
});

test('a period can be marked as filed, which locks it, and put back', async ({ page }) => {
  await page.goto('/tax');
  const comp = computation(page);
  await comp.getByRole('button', { name: 'Mark as filed' }).click();
  await expect(comp.getByText('Marked as filed')).toBeVisible();
  expect((await readPeriod(L.previousLabel)).status).toBe('filed');
  // Locked: no adjustments while it is marked filed.
  await expect(comp.getByRole('button', { name: 'Add adjustment' })).toHaveCount(0);

  await comp.getByRole('button', { name: 'Put back to open for edits' }).click();
  await expect(comp.getByRole('button', { name: 'Mark as filed' })).toBeVisible();
  expect((await readPeriod(L.previousLabel)).status).toBe('closed');
});

test('company details are checked, then saved and remove the "still needed" list', async ({
  page,
}) => {
  await page.goto('/tax?company=1');
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('Company number').fill('123');
  await drawer.getByRole('button', { name: 'Save details' }).click();
  await expect(drawer.getByRole('alert')).toContainText(/company number/i);

  await drawer.getByLabel('Company number').fill('12345678');
  await drawer.getByLabel('Unique Taxpayer Reference (UTR)').fill('1234567890');
  // The seeded business is VAT registered, so a VAT number is required too.
  await drawer.getByLabel('VAT number').fill('GB123456789');
  await drawer.getByRole('button', { name: 'Save details' }).click();
  await expect(drawer).toBeHidden();
  const saved = await readEntityTax(before.entity.id);
  expect(saved.company_number).toBe('12345678');
  expect(saved.tax_reference).toBe('1234567890');
  await expect(page.getByTestId('tax-ct600')).not.toContainText('Still needed');
});
