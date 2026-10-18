import AxeBuilder from '@axe-core/playwright';
import { test, expect, expectNoHorizontalOverflow } from './fixtures';
import { makeTransactions, mockAccountingApi } from './helpers/accounting-api';

const TXNS = makeTransactions(130);
const PAGE_SIZE = 50;

test.describe('transactions', () => {
  test('lists the first page, grouped by day, with the true total', async ({ page }) => {
    await mockAccountingApi(page, TXNS);
    await page.goto('/transactions');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('main').getByText('130', { exact: true }).first()).toBeVisible();
    // 50 rows on page one, under day headings (h2).
    await expect(page.getByRole('list').locator('li > button')).toHaveCount(PAGE_SIZE);
    expect(await page.getByRole('heading', { level: 2 }).count()).toBeGreaterThan(5);
  });

  test('a row shows who, what, how it is filed, and the amount', async ({ page }) => {
    await mockAccountingApi(page, TXNS);
    await page.goto('/transactions');
    const rows = page.getByRole('list').locator('li > button');

    // [0] pending inbound PayPal sale
    await expect(rows.nth(0)).toContainText('PayPal sale');
    await expect(rows.nth(0)).toContainText('Pending');
    await expect(rows.nth(0)).toContainText('+£');
    // [1] journalled outbound EUR payment: GBP primary, original currency underneath
    await expect(rows.nth(1)).toContainText('Porto Knitwear');
    await expect(rows.nth(1)).toContainText('Journalled');
    await expect(rows.nth(1)).toContainText('−£2,580.00');
    await expect(rows.nth(1)).toContainText('€3,000.00');
    // [2] excluded transfer
    await expect(rows.nth(2)).toContainText('Excluded');
  });

  test('summary labels the money figures as "this page" and counts awaiting journals', async ({
    page,
  }) => {
    await mockAccountingApi(page, TXNS);
    await page.goto('/transactions');
    const main = page.getByRole('main');
    const onPage = (label: string) => main.getByText(label, { exact: true }).locator('xpath=..');
    await expect(onPage('Money in')).toContainText('on this page');
    await expect(onPage('Money out')).toContainText('on this page');

    const firstPage = TXNS.slice(0, PAGE_SIZE);
    const awaiting = firstPage.filter(t => !t.excluded_reason && !t.journalised_at).length;
    const tile = main.getByText('Awaiting a journal', { exact: true }).locator('xpath=..');
    await expect(tile).toContainText(String(awaiting));
  });

  test('search filters on the server, lives in the URL, and can be cleared', async ({ page }) => {
    const api = await mockAccountingApi(page, TXNS);
    await page.goto('/transactions');
    await page.getByRole('searchbox', { name: 'Search transactions' }).fill('Porto');

    const expected = TXNS.filter(
      t =>
        (t.description ?? '').toLowerCase().includes('porto') ||
        (t.counterparty_name ?? '').toLowerCase().includes('porto')
    ).length;
    await expect(page).toHaveURL(/q=Porto/);
    await expect(page.getByRole('list').locator('li > button')).toHaveCount(
      Math.min(expected, PAGE_SIZE)
    );
    await expect.poll(() => api.listRequests.at(-1)?.get('search')).toBe('Porto');

    await page.getByRole('button', { name: /Clear 1/ }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.getByRole('list').locator('li > button')).toHaveCount(PAGE_SIZE);
  });

  test('direction, status, type and source filters narrow the list', async ({ page }) => {
    const api = await mockAccountingApi(page, TXNS);
    await page.goto('/transactions');

    await page
      .getByRole('group', { name: 'Direction' })
      .getByRole('button', { name: 'In' })
      .click();
    await expect(page).toHaveURL(/direction=in/);
    const inbound = TXNS.filter(t => t.direction === 'in').length;
    await expect(
      page.getByRole('main').getByText(String(inbound), { exact: true }).first()
    ).toBeVisible();
    await expect.poll(() => api.listRequests.at(-1)?.get('direction')).toBe('in');

    await page
      .getByRole('group', { name: 'Status' })
      .getByRole('button', { name: 'Excluded' })
      .click();
    await expect(page).toHaveURL(/status=excluded/);
    await expect.poll(() => api.listRequests.at(-1)?.get('txn_status')).toBe('excluded');

    await page.getByRole('button', { name: /Clear 2/ }).click();
    await page.getByLabel('Source').selectOption('paypal');
    await expect(page).toHaveURL(/source=paypal/);
    await page.getByLabel('Type').selectOption('fee');
    await expect(page).toHaveURL(/type=fee/);
    const both = TXNS.filter(t => t.source === 'paypal' && t.transaction_type === 'fee').length;
    await expect(page.getByRole('list').locator('li > button')).toHaveCount(
      Math.min(both, PAGE_SIZE)
    );
  });

  test('filters survive a reload (they are in the URL)', async ({ page }) => {
    await mockAccountingApi(page, TXNS);
    await page.goto('/transactions?direction=out&source=revolut');
    await expect(page.getByLabel('Source')).toHaveValue('revolut');
    await expect(
      page.getByRole('group', { name: 'Direction' }).getByRole('button', { name: 'Out' })
    ).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByLabel('Source')).toHaveValue('revolut');
  });

  test('the date range is sent with its whole last day included', async ({ page }) => {
    const api = await mockAccountingApi(page, TXNS);
    await page.goto('/transactions?from=2026-09-20&to=2026-09-22');
    await expect(page.getByRole('list').locator('li > button').first()).toBeVisible();
    const q = api.listRequests.at(-1)!;
    expect(q.get('date_from')).toBe('2026-09-20');
    // A bare date would exclude everything that happened during the 22nd.
    expect(q.get('date_to')).toBe('2026-09-22T23:59:59.999Z');
  });

  test('pages forward and back, 50 at a time', async ({ page }) => {
    const api = await mockAccountingApi(page, TXNS);
    await page.goto('/transactions');
    const nav = page.getByRole('navigation', { name: 'Pagination' });
    await expect(nav).toContainText('1–50 OF 130');

    await nav.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(nav).toContainText('51–100 OF 130');
    await expect.poll(() => api.listRequests.at(-1)?.get('page')).toBe('2');

    await nav.getByRole('button', { name: 'Next' }).click();
    await expect(nav).toContainText('101–130 OF 130');
    await expect(nav.getByRole('button', { name: 'Next' })).toBeDisabled();

    await nav.getByRole('button', { name: 'Previous' }).click();
    await expect(nav).toContainText('51–100 OF 130');
  });

  test('shows an empty state with a way out when nothing matches', async ({ page }) => {
    await mockAccountingApi(page, TXNS);
    await page.goto('/transactions?q=zzzz-no-such-thing');
    await expect(page.getByText('No transactions found.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('list').locator('li > button')).toHaveCount(PAGE_SIZE);
  });

  test('shows an error with a retry when the API fails, then recovers', async ({ page }) => {
    const api = await mockAccountingApi(page, TXNS);
    api.failLists(true);
    await page.goto('/transactions');
    await expect(page.getByText('Transactions did not load.')).toBeVisible();
    api.failLists(false);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('list').locator('li > button')).toHaveCount(PAGE_SIZE);
  });

  test.describe('drawer', () => {
    test('opens from a row, shows the journal, and closes back to the row', async ({ page }) => {
      await mockAccountingApi(page, TXNS);
      await page.goto('/transactions');
      const row = page.getByRole('list').locator('li > button').nth(1);
      await row.click();

      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();
      await expect(page).toHaveURL(/transactionId=txn-001/);
      await expect(drawer.getByRole('heading', { name: 'Porto Knitwear' })).toBeVisible();
      await expect(drawer).toContainText('−£2,580.00');
      await expect(drawer).toContainText('€3,000.00 · RATE 0.8600');

      // The double entry balances.
      const journal = drawer.getByRole('region', { name: 'Journal lines' });
      await expect(drawer).toContainText('Posted');
      const total = journal.locator('tfoot td');
      await expect(total.nth(1)).toHaveText(await total.nth(2).innerText());

      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(page).not.toHaveURL(/transactionId/);
      await expect(row).toBeFocused();
    });

    test('a pending transaction says it has no journal; an excluded one says why', async ({
      page,
    }) => {
      await mockAccountingApi(page, TXNS);
      await page.goto('/transactions?transactionId=txn-000');
      await expect(page.getByRole('dialog')).toContainText('No journal entry exists');
      await expect(page.getByRole('dialog')).toContainText('Not journalled');

      await page.goto('/transactions?transactionId=txn-002');
      await expect(page.getByRole('dialog')).toContainText(
        'Excluded transactions never reach the ledger.'
      );
      await expect(page.getByRole('dialog')).toContainText('Excluded because');
    });

    test('editing the description saves, asks the API to re-journal, and updates the list', async ({
      page,
    }) => {
      const api = await mockAccountingApi(page, TXNS);
      await page.goto('/transactions?transactionId=txn-003');
      const drawer = page.getByRole('dialog');
      await drawer.getByRole('button', { name: 'Edit transaction' }).click();
      await drawer.getByLabel('Description').fill('Postage (September)');
      await drawer.getByRole('button', { name: 'Save changes' }).click();

      await expect(page.getByText('Transaction updated.', { exact: true })).toBeVisible();
      expect(api.patches).toHaveLength(1);
      expect(api.patches[0].body).toMatchObject({
        description: 'Postage (September)',
        re_journal: true,
        excluded_reason: '',
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('list').locator('li > button').nth(3)).toContainText(
        'Postage (September)'
      );
    });

    test('changing the ledger account on a journalised transaction reverses and recreates it', async ({
      page,
    }) => {
      const api = await mockAccountingApi(page, TXNS);
      await page.goto('/transactions?transactionId=txn-003');
      const drawer = page.getByRole('dialog');
      await drawer.getByRole('button', { name: 'Edit transaction' }).click();
      await expect(drawer).toContainText('This transaction has a posted journal');

      await drawer.getByRole('button', { name: 'Ledger account' }).click();
      await page.getByRole('option', { name: /6200 — Marketing/ }).click();
      await expect(drawer).toContainText('Changing this reverses and recreates the journal entry.');
      await drawer.getByRole('button', { name: 'Save changes' }).click();

      await expect(
        page.getByText('Transaction updated — journal reversed and recreated.')
      ).toBeVisible();
      expect(api.patches[0].body).toMatchObject({ account_code: '6200' });
      // The journal now shows the new account.
      await expect(drawer.getByRole('region', { name: 'Journal lines' })).toContainText(
        '6200 — Marketing'
      );
    });

    test('excluding reverses the journal; un-excluding asks for a new one', async ({ page }) => {
      const api = await mockAccountingApi(page, TXNS);
      await page.goto('/transactions?transactionId=txn-003');
      const drawer = page.getByRole('dialog');
      await drawer.getByRole('button', { name: 'Edit transaction' }).click();
      await drawer.getByRole('checkbox', { name: /Exclude from the ledger/ }).check();
      await drawer.getByLabel('Reason for exclusion').fill('Duplicate');
      await drawer.getByRole('button', { name: 'Save changes' }).click();

      await expect(page.getByText('Transaction updated — journal reversed.')).toBeVisible();
      expect(api.patches[0].body).toMatchObject({ excluded_reason: 'Duplicate' });
      await expect(drawer).toContainText('Excluded transactions never reach the ledger.');

      await drawer.getByRole('button', { name: 'Edit transaction' }).click();
      await drawer.getByRole('checkbox', { name: /Exclude from the ledger/ }).uncheck();
      await drawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(
        page.getByText('Transaction un-excluded. You can now generate a new journal for it.')
      ).toBeVisible();
      expect(api.patches[1].body).toMatchObject({ excluded_reason: '' });
    });
  });

  test('has no horizontal overflow', async ({ page }) => {
    await mockAccountingApi(page, TXNS);
    await page.goto('/transactions');
    await expect(page.getByRole('list').locator('li > button').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('passes an automated accessibility scan, with the drawer open too', async ({ page }) => {
    await mockAccountingApi(page, TXNS);
    await page.goto('/transactions');
    await expect(page.getByRole('list').locator('li > button').first()).toBeVisible();
    const scan = async (include: string) =>
      (
        await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa']).analyze()
      ).violations.map(
        v => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`
      );
    expect(await scan('main')).toEqual([]);

    await page.getByRole('list').locator('li > button').nth(1).click();
    await expect(
      page.getByRole('dialog').getByRole('region', { name: 'Journal lines' })
    ).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Edit transaction' }).click();
    expect(await scan('[role="dialog"]')).toEqual([]);
  });
});
