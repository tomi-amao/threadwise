/**
 * The writes on the Journals page: a manual journal, reversing, and posting a draft. Runs in the
 * `mutations` project and puts the books back as it found them.
 */

import { test, expect, readManifest } from './fixtures';
import {
  readJournalByDescription,
  readJournalsByDescription,
  restoreJournals,
  snapshotJournals,
  type JournalSnapshot,
} from './helpers/db';

const seed = readManifest();
const L = seed.ledger;

let before: JournalSnapshot;
test.beforeEach(async () => {
  before = await snapshotJournals();
});
test.afterEach(async () => {
  await restoreJournals(before);
});

async function pickAccount(page: import('@playwright/test').Page, name: string, query: string) {
  await page.getByRole('button', { name }).click();
  await page
    .getByPlaceholder(/search/i)
    .last()
    .fill(query);
  await page
    .getByRole('option', { name: new RegExp(query) })
    .first()
    .click();
}

test('a manual journal is posted, shows in the ledger, and can be reversed', async ({ page }) => {
  await page.goto('/journals?tab=ledger');
  const posted = page.locator('div.rounded-2xl.px-5.py-4').filter({ hasText: 'Posted' }).first();
  await expect(posted).toContainText(String(L.posted));

  await page.getByRole('button', { name: 'New journal' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('What it is for').fill('E2E office kettle');
  await pickAccount(page, 'Account for line 1', '6100');
  await drawer.getByLabel('Debit for line 1').fill('25');
  await pickAccount(page, 'Account for line 2', '1010');
  await drawer.getByLabel('Credit for line 2').fill('25');
  await expect(drawer.getByRole('status', { name: 'Balance' })).toContainText('Balanced');
  await drawer.getByRole('button', { name: 'Post journal' }).click();
  await expect(drawer).toBeHidden();

  await expect(posted).toContainText(String(L.posted + 1));
  const row = page
    .getByRole('region', { name: 'Journals' })
    .getByRole('button', { name: /E2E office kettle/ });
  await expect(row).toBeVisible();
  const saved = await readJournalByDescription('E2E office kettle');
  expect(saved.status).toBe('posted');
  expect(saved.source_type).toBe('manual');

  await row.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reverse this journal' }).click();
  await page
    .getByRole('dialog')
    .filter({ hasText: 'Reverse this journal?' })
    .getByRole('button', { name: 'Reverse journal' })
    .click();
  await expect
    .poll(async () => (await readJournalByDescription('E2E office kettle')).status)
    .toBe('reversed');
});

test('a journal in a closed period cannot be reversed, and says why', async ({ page }) => {
  await page.goto('/journals?tab=ledger&q=Sales%20accrued');
  const table = page.getByRole('region', { name: 'Journals' });
  // The previous financial year is closed: the oldest journals are in it.
  await table.locator('tbody tr').last().getByRole('button').click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Reverse this journal' }).click();
  await page
    .getByRole('dialog')
    .filter({ hasText: 'Reverse this journal?' })
    .getByRole('button', { name: 'Reverse journal' })
    .click();
  await expect(page.getByRole('alert').first()).toContainText(/locked/i);
  const rows = await snapshotJournals();
  expect(rows.journals.filter(j => j.status === 'reversed')).toHaveLength(L.reversed);
});

test('a draft is posted once an account is chosen', async ({ page }) => {
  await page.goto('/journals');
  const table = page.getByRole('region', { name: 'Journals needing review' });
  const row = table.locator('tbody tr').filter({ hasText: 'Postage' });
  await row.getByRole('button', { name: /^Account for/ }).click();
  await page
    .getByPlaceholder(/search/i)
    .last()
    .fill('6300');
  await page.getByRole('option', { name: /6300/ }).first().click();
  await row.getByRole('button', { name: /^Post / }).click();
  await expect(table.locator('tbody tr').filter({ hasText: 'Postage' })).toHaveCount(0);
  await expect(table.locator('tbody tr')).toHaveCount(L.drafts - 1);
  expect(
    (await readJournalsByDescription('Postage')).filter(j => j.status === 'draft')
  ).toHaveLength(0);
});

test('suggestions fill in an account, but nothing posts until you do', async ({ page }) => {
  await page.goto('/journals');
  await page.getByRole('button', { name: 'Suggest accounts' }).click();
  await expect(page.getByText(/^Suggested:/).first()).toBeVisible();
  expect(
    (await readJournalsByDescription('Postage')).filter(j => j.status === 'draft')
  ).toHaveLength(1);
});
