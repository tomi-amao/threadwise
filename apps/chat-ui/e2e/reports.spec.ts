import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const seed = readManifest();
const L = seed.ledger;
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);
const num = (n: number) => n.toLocaleString('en-GB');

// A tile is the card whose mono label is exactly `label`.
const tile = (page: Page, label: string) =>
  page
    .getByRole('main')
    .locator('div.rounded-2xl')
    .filter({ has: page.locator('.eyebrow', { hasText: new RegExp(`^${label}$`) }) });
const panel = (page: Page, title: string) =>
  page
    .getByRole('main')
    .locator('div.rounded-2xl')
    .filter({ has: page.getByRole('heading', { level: 2, name: title }) });
// A statement row, found by the start of its accessible name (its label, then its amount). Matching
// on text would also catch a definition that mentions the same words.
const row = (page: Page, label: string) =>
  page.getByRole('row', { name: new RegExp(`^${label}(\\s|$)`) });

test.describe('reports', () => {
  test('the tiles say where things stand, and that the books balance', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(tile(page, 'Net income')).toContainText(gbp0(L.all.profit));
    await expect(tile(page, 'Books balance')).toContainText('Balanced');
    await expect(tile(page, 'Total sales')).toContainText(`${num(seed.orderCount)} orders`);
    await expect(tile(page, 'Cash in the bank')).toContainText(gbp0(seed.expectedBankBalance));
  });

  test('profit and loss adds up to the ledger, for all time', async ({ page }) => {
    await page.goto('/reports?tab=pnl');
    await expect(row(page, 'Total revenue')).toContainText(gbp0(L.all.revenue));
    await expect(row(page, 'Total cost of goods sold')).toContainText(gbp0(L.all.cogs));
    await expect(row(page, 'Gross profit')).toContainText(gbp0(L.all.revenue - L.all.cogs));
    await expect(row(page, 'Total operating expenses')).toContainText(gbp0(L.all.expenses));
    await expect(row(page, 'Net income')).toContainText(gbp0(L.all.profit));
  });

  test('the date range narrows it to one financial year, and leaves out what was reversed', async ({
    page,
  }) => {
    await page.goto(`/reports?tab=pnl&from=${L.previousFrom}&to=${L.previousTo}`);
    await expect(row(page, 'Total revenue')).toContainText(gbp0(L.previous.revenue));
    await expect(row(page, 'Net income')).toContainText(gbp0(L.previous.profit));

    await page.goto(`/reports?tab=pnl&from=${L.currentFrom}&to=${L.currentTo}`);
    await expect(row(page, 'Total revenue')).toContainText(gbp0(L.current.revenue));
    await expect(row(page, 'Net income')).toContainText(gbp0(L.current.profit));
    // The journal posted in error and reversed is £999 of shipping; it must not be in the total.
    await expect(row(page, 'Total operating expenses')).toContainText(gbp0(L.current.expenses));
  });

  test('the balance sheet balances, with profit kept as retained earnings', async ({ page }) => {
    await page.goto('/reports?tab=balance');
    const b = L.balanceSheet;
    await expect(row(page, 'Total assets')).toContainText(gbp0(b.assets));
    await expect(row(page, 'Total liabilities')).toContainText(gbp0(b.liabilities));
    await expect(row(page, 'Total equity')).toContainText(gbp0(b.equity));
    await expect(row(page, 'Liabilities and equity')).toContainText(gbp0(b.liabilities + b.equity));
    await expect(row(page, '9999 · Retained Earnings')).toContainText(gbp0(b.retainedEarnings));
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a line opens the journals behind it', async ({ page }) => {
    await page.goto('/reports?tab=pnl');
    await page.getByRole('button', { name: /Product sales, view journals/ }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Product sales');
    await expect(drawer).toContainText(/\d+ posted journals?/);
    await expect(drawer).toContainText('Sales accrued');
    await expect(page).toHaveURL(/account=/);

    // Open the entry: its lines show debit and credit.
    await drawer
      .getByRole('button', { name: /Sales accrued/ })
      .first()
      .click();
    await expect(drawer.getByRole('columnheader', { name: 'Debit' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/account=/);
  });

  test('revenue: the breakdown and the monthly table are there, and costs open their records', async ({
    page,
  }) => {
    await page.goto('/reports?tab=revenue');
    await expect(row(page, 'Net revenue')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Monthly breakdown' })).toBeVisible();
    const monthly = page.getByRole('region', { name: 'Monthly breakdown' });
    expect(await monthly.locator('tbody tr').count()).toBeGreaterThan(3);
    await expect(monthly.locator('tfoot')).toContainText('Total');

    await monthly
      .getByRole('button', { name: /other spend detail/ })
      .first()
      .click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Other outbound and expenses');
    await expect(drawer.getByRole('region', { name: 'Transactions' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Leave out' }).first()).toBeVisible();
    await expect(drawer.getByRole('link').first()).toHaveAttribute(
      'href',
      /\/transactions\?transactionId=/
    );
  });

  test('cash: the statement ties to the bank and says how much is not yet journalled', async ({
    page,
  }) => {
    await page.goto('/reports?tab=cash');
    const check = panel(page, 'Does it tie to the bank?');
    await expect(check).toContainText('The statement ties to the bank');
    await expect(row(page, 'Unexplained difference')).toContainText('£0');
    const unjournalled = seed.transactionCount - L.bankFeedJournals;
    await expect(check).toContainText(
      `${num(unjournalled)} of ${num(seed.transactionCount)} bank transactions are not in a category yet`
    );
    await expect(check).toContainText(`${L.drafts} have draft journals waiting for review`);
    await expect(panel(page, 'Cash flow statement')).toContainText('Net cash from operations');
    await expect(panel(page, 'Cash flow statement')).toContainText('Not yet journalled');
  });

  test('cash: safe to spend shows its working', async ({ page }) => {
    await page.goto('/reports?tab=cash');
    await page.getByRole('button', { name: 'See the full calculation' }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('How safe to spend is worked out');
    await expect(drawer).toContainText('A caveat');
    await expect(page).toHaveURL(/safe=1/);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  test('definitions travel with the numbers: focus a term and its meaning appears', async ({
    page,
  }) => {
    await page.goto('/reports?tab=revenue');
    const term = page.getByRole('button', { name: 'Net revenue', exact: true });
    await term.focus();
    await expect(
      page.getByRole('tooltip').filter({ hasText: 'Total sales less processing fees' })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('tooltip').filter({ hasText: 'Total sales less processing fees' })
    ).toBeHidden();
  });

  test('the tab and dates survive a reload', async ({ page }) => {
    await page.goto(`/reports?tab=balance&from=${L.currentFrom}&to=${L.currentTo}`);
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Balance sheet' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByText('As at', { exact: false })).toBeVisible();
  });

  test('switching tabs uses what is already loaded, without asking the server again', async ({
    page,
  }) => {
    await page.goto('/reports');
    await expect(page.getByRole('tabpanel')).toBeVisible();
    // Any loader request (a `.data` fetch) here means a tab click reloads the whole ledger.
    const loaderRequests: string[] = [];
    page.on('request', req => {
      if (new URL(req.url()).pathname.endsWith('.data')) loaderRequests.push(req.url());
    });
    for (const name of ['Profit and loss', 'Balance sheet', 'Cash', 'Revenue']) {
      await page.getByRole('tab', { name }).click();
      await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    }
    await page.waitForLoadState('networkidle');
    expect(loaderRequests).toEqual([]);
  });

  test('has no horizontal overflow on any tab', async ({ page }) => {
    for (const tab of ['revenue', 'pnl', 'balance', 'cash']) {
      await page.goto(`/reports?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('has no accessibility violations on any tab, or with a drawer open', async ({ page }) => {
    test.slow();
    for (const tab of ['revenue', 'pnl', 'balance', 'cash']) {
      await page.goto(`/reports?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations.map(v => v.id),
        tab
      ).toEqual([]);
    }
    await page.goto('/reports?tab=pnl');
    await page.getByRole('button', { name: /Product sales, view journals/ }).click();
    await expect(page.getByRole('dialog')).toContainText('posted journal');
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    const r = await new AxeBuilder({ page }).analyze();
    expect(
      r.violations.map(v => v.id),
      'drawer'
    ).toEqual([]);
  });
});
