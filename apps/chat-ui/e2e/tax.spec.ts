import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const seed = readManifest();
const L = seed.ledger;
const gbp = (n: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);

const tile = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('div.rounded-2xl.px-5.py-4')
    .filter({ has: page.locator('.eyebrow', { hasText: new RegExp(`^${label}$`) }) });
const panel = (page: Page, title: string) =>
  page
    .getByRole('main')
    .locator('div.rounded-2xl')
    .filter({ has: page.getByRole('heading', { level: 2, name: title }) });

test.describe('tax', () => {
  test('the tiles show the last completed period and the projection for this year', async ({
    page,
  }) => {
    await page.goto('/tax');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(tile(page, 'Last completed period')).toContainText(gbp0(L.tax.previousTax));
    await expect(tile(page, 'Last completed period')).toContainText(L.previousLabel);
    await expect(tile(page, 'This year so far')).toContainText('projection');
  });

  test('the computation for the completed period adds up', async ({ page }) => {
    await page.goto('/tax');
    const comp = panel(page, 'Tax computation');
    await expect(comp).toContainText('From posted journals');
    await expect(comp.getByRole('row', { name: /^Profit per the accounts/ })).toContainText(
      gbp0(L.tax.previousProfit)
    );
    await expect(comp.getByRole('row', { name: /^Corporation tax due/ })).toContainText(
      gbp0(L.tax.previousTax)
    );
  });

  test('an open period is labelled as a projection, never as a liability', async ({ page }) => {
    await page.goto('/tax');
    await page
      .getByRole('group', { name: 'Accounting period' })
      .getByRole('button', { name: /open/ })
      .click();
    const comp = panel(page, 'Tax computation');
    await expect(comp).toContainText('Every figure below is a projection');
    await expect(comp.getByRole('row', { name: /^Projected corporation tax/ })).toBeVisible();
    await expect(comp.getByRole('row', { name: /^Corporation tax due/ })).toHaveCount(0);
  });

  test('the profit behind a period opens account by account, linking to the journals', async ({
    page,
  }) => {
    await page.goto('/tax');
    await panel(page, 'Tax computation')
      .getByRole('button', { name: /Profit per the accounts/ })
      .click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Revenue');
    await expect(drawer.getByRole('link').first()).toHaveAttribute('href', /\/reports\?tab=pnl/);
    await expect(drawer).toContainText(gbp(L.tax.previousProfit));
  });

  test('spending that may not be allowable is raised for review, not guessed', async ({ page }) => {
    await page.goto('/tax?period=' + (await currentPeriodId(page)));
    const review = panel(page, 'Needs your judgement');
    await expect(review).toContainText('Travel');
    await expect(tile(page, 'Needs your judgement')).toContainText('1');
  });

  test('the working paper says what is still missing for the CT600', async ({ page }) => {
    await page.goto('/tax');
    const ct = panel(page, 'CT600 working paper');
    await expect(ct).toContainText('Still needed');
    await expect(ct).toContainText(/company registration number/i);
    await expect(ct).toContainText(/UTR|Unique Taxpayer/i);
  });

  test("the monitors show VAT headroom, the director's loan and the provision", async ({
    page,
  }) => {
    await page.goto('/tax');
    await expect(panel(page, 'VAT registration')).toContainText('threshold');
    await expect(panel(page, "Director's loan")).toBeVisible();
    await expect(panel(page, 'Tax provision')).toBeVisible();
  });

  test('definitions travel with the figures', async ({ page }) => {
    await page.goto('/tax');
    const term = panel(page, 'Tax computation').getByRole('button', { name: 'Taxable profit' });
    await term.focus();
    await expect(term).toHaveAccessibleDescription(/corporation tax is charged on/i);
  });

  test('has no horizontal overflow, with a drawer open or not', async ({ page }) => {
    await page.goto('/tax');
    await expectNoHorizontalOverflow(page);
    for (const drawer of ['company=1', 'adjust=1', 'breakdown=1']) {
      await page.goto(`/tax?${drawer}`);
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('has no accessibility violations', async ({ page }) => {
    for (const url of ['/tax', '/tax?breakdown=1', '/tax?company=1', '/tax?adjust=1']) {
      await page.goto(url);
      // With a drawer open the page behind it is hidden from assistive tech; wait for what shows.
      if (url === '/tax') await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      else await expect(page.getByRole('dialog')).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, url).toEqual([]);
    }
  });
});

async function currentPeriodId(page: Page): Promise<string> {
  await page.goto('/tax');
  await page
    .getByRole('group', { name: 'Accounting period' })
    .getByRole('button', { name: /open/ })
    .click();
  await expect(page).toHaveURL(/period=/);
  return new URL(page.url()).searchParams.get('period')!;
}
