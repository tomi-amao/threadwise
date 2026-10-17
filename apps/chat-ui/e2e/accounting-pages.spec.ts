/**
 * The accounting pages (Reports, Tax, Journals, Reclassification) read as the signed-in user.
 * They are due their own redesign (Phase 3), so these only prove what matters now: each one
 * loads for a seeded business and shows nothing from the other business (Reclassification used
 * to read one fixed business whoever was signed in).
 */

import { test, expect, readManifest } from './fixtures';

const seed = readManifest();
const rival = seed.rival;

const PAGES = ['/reports', '/tax', '/journals', '/reclassification'];

test.describe('accounting pages', () => {
  for (const path of PAGES) {
    test(`${path} loads, and shows nothing from another business`, async ({ page }) => {
      const failures: string[] = [];
      page.on('pageerror', e => failures.push(String(e)));
      await page.goto(path);
      await expect(page.getByRole('main').first()).toBeVisible();
      // The shared error boundary says "Couldn't load the ...".
      await expect(page.getByText(/Couldn.t load the/)).toHaveCount(0);
      await expect(page.getByText(rival.productName)).toHaveCount(0);
      await expect(page.getByText(rival.entityName)).toHaveCount(0);
      await expect(page.getByText('Rival Buyer Ltd')).toHaveCount(0);
      expect(failures).toEqual([]);
    });
  }
});
