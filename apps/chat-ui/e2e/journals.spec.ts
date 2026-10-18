import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const seed = readManifest();
const L = seed.ledger;

const tile = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('div.rounded-2xl.px-5.py-4')
    .filter({ has: page.locator('.eyebrow', { hasText: new RegExp(`^${label}$`) }) });

test.describe('journals', () => {
  test('the tiles say how the books stand', async ({ page }) => {
    await page.goto('/journals');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(tile(page, 'Posted')).toContainText(String(L.posted));
    await expect(tile(page, 'Needs review')).toContainText(String(L.drafts));
    await expect(tile(page, 'Reversed')).toContainText(String(L.reversed));
  });

  test('drafts waiting for a person open first, and cannot be posted without an account', async ({
    page,
  }) => {
    await page.goto('/journals');
    const table = page.getByRole('region', { name: 'Journals needing review' });
    for (const description of L.draftDescriptions) {
      await expect(table).toContainText(description);
    }
    await expect(table.getByRole('button', { name: /^Post / })).toHaveCount(L.drafts);
    for (const button of await table.getByRole('button', { name: /^Post / }).all()) {
      await expect(button).toBeDisabled();
    }
  });

  test('the ledger can be searched, and an entry opens to its lines', async ({ page }) => {
    await page.goto('/journals?tab=ledger');
    await page.getByRole('searchbox', { name: 'Search journals' }).fill('Reclassify marketing');
    const table = page.getByRole('region', { name: 'Journals' });
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await table.getByRole('button', { name: /Reclassify marketing/ }).click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Reclassify marketing to materials');
    const lines = drawer.getByRole('table', { name: 'Journal lines' });
    await expect(lines).toContainText('6100');
    await expect(lines).toContainText('6500');
    await expect(drawer.getByRole('alert')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Reverse this journal' })).toBeVisible();
  });

  test('a reversed journal is kept but marked, and cannot be reversed again', async ({ page }) => {
    await page.goto('/journals?tab=ledger&status=reversed');
    const table = page.getByRole('region', { name: 'Journals' });
    await expect(table.locator('tbody tr')).toHaveCount(L.reversed);
    await table.getByRole('button', { name: /Posted in error/ }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('no longer counts in any total');
    await expect(drawer.getByRole('button', { name: 'Reverse this journal' })).toHaveCount(0);
  });

  test('filters by source and type narrow the ledger, and clear again', async ({ page }) => {
    await page.goto('/journals?tab=ledger');
    const rows = page.getByRole('region', { name: 'Journals' }).locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const all = await rows.count();
    await page
      .getByRole('group', { name: 'Source' })
      .getByRole('button', { name: 'By hand' })
      .click();
    await expect.poll(() => rows.count()).toBeLessThan(all);
    await expect(rows.first()).toContainText('By hand');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect.poll(() => rows.count()).toBe(all);
  });

  test('a new journal cannot be posted until it balances', async ({ page }) => {
    await page.goto('/journals?new=1');
    const drawer = page.getByRole('dialog');
    const post = drawer.getByRole('button', { name: 'Post journal' });
    await expect(post).toBeDisabled();
    await drawer.getByLabel('What it is for').fill('Balance check');
    await drawer.getByLabel('Debit for line 1').fill('50');
    await drawer.getByLabel('Credit for line 2').fill('40');
    await expect(drawer.getByRole('status', { name: 'Balance' })).toContainText('Difference');
    await expect(post).toBeDisabled();
  });

  test('has no horizontal overflow, with a drawer open or not', async ({ page }) => {
    for (const url of ['/journals', '/journals?tab=ledger', '/journals?new=1']) {
      await page.goto(url);
      if (url.includes('new=1')) await expect(page.getByRole('dialog')).toBeVisible();
      else await expect(page.getByRole('main')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(url).toBeTruthy();
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    for (const url of ['/journals', '/journals?tab=ledger', '/journals?new=1']) {
      await page.goto(url);
      if (url.includes('new=1')) await expect(page.getByRole('dialog')).toBeVisible();
      else await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, url).toEqual([]);
    }
    // An entry's drawer.
    await page.goto('/journals?tab=ledger');
    await page.getByRole('region', { name: 'Journals' }).locator('tbody button').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations, 'journal drawer').toEqual([]);
  });
});
