import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, readManifest } from './fixtures';

const inv = readManifest().invoices;
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);
const num = (n: number) => n.toLocaleString('en-GB');

const table = (page: Page) => page.getByRole('region', { name: 'Invoices' });
const row = (page: Page, number: string) => table(page).locator('tr', { hasText: number });
const tile = (page: Page, label: string) =>
  page.getByRole('main').getByText(label, { exact: true }).first().locator('xpath=..');
const openInvoice = async (page: Page, number: string, tab = 'all') => {
  await page.goto(`/invoices?tab=${tab}&q=${number}`);
  await row(page, number).getByRole('button').first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('region', { name: 'Next step' })).toBeVisible();
  return drawer;
};

test.describe('invoices', () => {
  test('says where the money stands: owed to you, you owe, overdue, to review', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await expect(tile(page, 'Owed to you')).toContainText(gbp0(inv.owedToYou));
    await expect(tile(page, 'Owed to you')).toContainText(`${inv.owedToYouCount} unpaid`);
    await expect(tile(page, 'You owe')).toContainText(gbp0(inv.youOwe));
    await expect(tile(page, 'You owe')).toContainText(`${inv.youOweCount} unpaid`);
    await expect(tile(page, 'Overdue')).toContainText(String(inv.overdueCount));
    await expect(tile(page, 'Overdue')).toContainText(
      `${gbp0(inv.overdueOwedToYou)} to collect · ${gbp0(inv.overdueYouOwe)} to pay`
    );
    await expect(tile(page, 'To review')).toContainText(String(inv.toReview));
  });

  test('does not add up invoices in another currency, and says so', async ({ page }) => {
    await page.goto('/invoices');
    await expect(
      page.getByText(`${inv.otherCurrency} in other currencies not counted`)
    ).toBeVisible();
    await page.goto(`/invoices?tab=open&q=${inv.foreign}`);
    await expect(row(page, inv.foreign)).toContainText('€2,000.00');
  });

  // Regression: reads used to stop at the API's 1,000-row cap.
  test('counts every invoice in each stage, past the 1,000-row cap', async ({ page }) => {
    expect(inv.total).toBeGreaterThan(1000);
    await page.goto('/invoices');
    const tabs = page.getByRole('tablist');
    await expect(tabs.getByRole('tab', { name: /^To review/ })).toContainText(num(inv.toReview));
    await expect(tabs.getByRole('tab', { name: /^Open/ })).toContainText(num(inv.openCount));
    await expect(tabs.getByRole('tab', { name: /^Paid/ })).toContainText(num(inv.paidCount));
    await expect(tabs.getByRole('tab', { name: /^All/ })).toContainText(num(inv.total));

    await page.goto('/invoices?tab=all');
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText(
      `OF ${num(inv.total)}`
    );
  });

  test('opens on the invoices waiting for review', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.getByRole('tab', { name: /^To review/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(table(page).locator('tbody tr')).toHaveCount(inv.toReview);
    await expect(row(page, inv.draftPurchase)).toContainText('To review');
  });

  test('open invoices are worked soonest-due first, and past-due ones read as overdue', async ({
    page,
  }) => {
    await page.goto('/invoices?tab=open');
    await expect(table(page).locator('tbody tr')).toHaveCount(inv.openCount);
    const numbers = await table(page).locator('tbody tr td:first-child').allInnerTexts();
    const order = numbers.map(t => t.split('\n').pop()!.trim());
    expect(order).toEqual([
      inv.overdueSale,
      inv.overduePurchase,
      'INV-OUT-2004',
      inv.matchedPurchase,
      inv.foreign,
      inv.openSale,
    ]);

    // Stored as OPEN, shown as overdue: nothing in the database sets OVERDUE by itself.
    await expect(row(page, inv.overdueSale)).toContainText('Overdue');
    await expect(row(page, inv.overdueSale)).toContainText(/\d+ days overdue/);
    await expect(row(page, inv.openSale)).toContainText(/Due in \d+ days/);
    await expect(row(page, inv.openSale)).toContainText('Open');
  });

  test('"Jump to overdue" opens just the late invoices, and the filter can be cleared', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await page.getByRole('button', { name: new RegExp(`^${inv.overdueCount} overdue`) }).click();
    await expect(page).toHaveURL(/tab=open/);
    await expect(page).toHaveURL(/view=overdue/);
    await expect(table(page).locator('tbody tr')).toHaveCount(inv.overdueCount);
    await expect(page.getByText('Overdue only')).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(inv.openCount);
  });

  test('direction and search narrow the list', async ({ page }) => {
    await page.goto('/invoices?tab=open');
    const group = page.getByRole('group', { name: 'Direction' });
    await group.getByRole('button', { name: 'You owe' }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(3);
    await expect(table(page).getByText('Owed to you')).toHaveCount(0);

    await group.getByRole('button', { name: 'Owed to you' }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(3);

    await group.getByRole('button', { name: 'All' }).click();
    await page.getByRole('searchbox', { name: 'Search invoices' }).fill('Oakley');
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    await expect(page).toHaveURL(/q=Oakley/);
  });

  test('amounts carry their direction: plus when owed to you, minus when you owe', async ({
    page,
  }) => {
    await page.goto('/invoices?tab=open');
    await expect(row(page, inv.openSale)).toContainText('+£2,400.00');
    await expect(row(page, inv.matchedPurchase)).toContainText('−£3,600.00');
  });

  test('a draft purchase opens on its next step, with the checks that matter', async ({ page }) => {
    const drawer = await openInvoice(page, inv.draftPurchase, 'review');
    await expect(drawer).toContainText(inv.counterparty);
    await expect(drawer.getByRole('list', { name: 'Stage' })).toContainText('To review');
    const next = drawer.getByRole('region', { name: 'Next step' });
    await expect(next).toContainText('Check the lines, then finalise');
    await expect(next).toContainText('1 line has no account');
    await expect(next).toContainText('2 lines look like stock');
    await expect(next.getByRole('button', { name: 'Finalise invoice' })).toBeEnabled();

    const amounts = drawer.getByRole('region', { name: 'Amounts' });
    await expect(amounts).toContainText('£1,000.00');
    await expect(amounts).toContainText('£200.00');
    await expect(amounts).toContainText('£1,200.00');
    await expect(drawer.getByRole('region', { name: 'Lines' }).getByRole('listitem')).toHaveCount(
      3
    );
    await expect(drawer.getByRole('region', { name: 'Stock' })).toBeVisible();
  });

  test('a sale has no stock section, and a fee line starts as an expense', async ({ page }) => {
    const sale = await openInvoice(page, inv.draftSale, 'review');
    await expect(sale.getByRole('region', { name: 'Stock' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    const purchase = await openInvoice(page, inv.draftPurchase, 'review');
    await expect(purchase.getByLabel('Stock handling for Delivery')).toHaveValue('expense');
    await expect(purchase.getByLabel('Stock handling for Merino yarn 4-ply')).toHaveValue(
      'undecided'
    );
  });

  test('stock choices reveal the fields they need, and apply needs a complete choice', async ({
    page,
  }) => {
    const drawer = await openInvoice(page, inv.draftPurchase, 'review');
    const apply = drawer.getByRole('button', { name: /Apply/ });
    await expect(apply).toBeDisabled();

    const yarn = drawer.getByLabel('Stock handling for Merino yarn 4-ply');
    await yarn.selectOption('link');
    await expect(drawer.getByLabel('Product for Merino yarn 4-ply')).toBeVisible();
    await expect(apply).toBeDisabled(); // no product chosen yet

    await yarn.selectOption('new');
    await expect(drawer.getByLabel('Product name for Merino yarn 4-ply')).toHaveValue(
      'Merino yarn 4-ply'
    );
    await expect(apply).toBeEnabled();
    await expect(apply).toHaveText('Apply 1 decision');

    await yarn.selectOption('track');
    await expect(drawer.getByLabel('SKU for Merino yarn 4-ply')).toBeVisible();
    await yarn.selectOption('expense');
    await expect(apply).toBeDisabled(); // "not stock" needs no record
  });

  test('an open invoice offers payment; a paid one links to its bank transaction', async ({
    page,
  }) => {
    let drawer = await openInvoice(page, inv.overdueSale, 'open');
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText('days overdue');
    await expect(drawer.getByRole('button', { name: 'Mark as received' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Part paid' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Finalise invoice' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    drawer = await openInvoice(page, inv.paidMatched, 'paid');
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText(
      'matched to a bank transaction'
    );
    await expect(drawer.getByRole('link', { name: /View the transaction/ })).toHaveAttribute(
      'href',
      /\/transactions\?transactionId=/
    );
    await expect(drawer.getByRole('button', { name: 'Undo payment' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  });

  test('a void invoice says it has no effect and can be deleted; a live one cannot', async ({
    page,
  }) => {
    const drawer = await openInvoice(page, inv.voided, 'all');
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText(
      'no effect on your books'
    );
    await expect(drawer.getByRole('button', { name: 'Delete invoice' })).toBeVisible();
    await page.keyboard.press('Escape');

    const live = await openInvoice(page, inv.openSale, 'open');
    await expect(live.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
    await expect(live.getByRole('button', { name: 'Void invoice' })).toBeVisible();
  });

  test('the document opens from a signed link', async ({ page }) => {
    const drawer = await openInvoice(page, inv.draftPurchase, 'review');
    // The browser opens the file in a new tab, which is a download for a PDF; what matters is
    // that the signed link was issued, and that it points at the invoices bucket.
    const response = page.waitForResponse(r => r.url().includes('document=1'));
    await drawer.getByRole('button', { name: 'View document' }).click();
    const { ok, url } = (await (await response).json()) as { ok: boolean; url: string };
    expect(ok).toBe(true);
    expect(url).toContain('/storage/v1/object/sign/invoices/');
  });

  test('closing the drawer clears it from the URL, and a link opens it directly', async ({
    page,
  }) => {
    const drawer = await openInvoice(page, inv.draftSale, 'review');
    await expect(page).toHaveURL(/invoice=/);
    const url = page.url();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page).not.toHaveURL(/invoice=/);

    await page.goto(url);
    await expect(page.getByRole('dialog')).toContainText(inv.draftSale);
  });

  test('an invoice that does not exist says so instead of hanging', async ({ page }) => {
    await page.goto('/invoices?invoice=00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not found');
  });

  test('adding invoices: the dialog takes PDFs and images and refuses anything else', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await page.getByRole('button', { name: 'Add invoice' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /^Add/ })).toBeDisabled();

    await dialog.getByLabel('Choose invoice files').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an invoice'),
    });
    await expect(dialog.getByRole('list', { name: 'Files' })).toContainText(
      'Only PDFs and images can be added'
    );
    await expect(dialog.getByRole('button', { name: /^Add/ })).toBeDisabled();

    await dialog.getByLabel('Choose invoice files').setInputFiles({
      name: 'bill.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.1'),
    });
    await expect(dialog.getByRole('button', { name: 'Add 1 invoice' })).toBeEnabled();
  });

  test('has no horizontal overflow in any stage', async ({ page }) => {
    for (const tab of ['review', 'open', 'paid', 'all']) {
      await page.goto(`/invoices?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test('has no accessibility violations: each stage, the drawer and the add dialog', async ({
    page,
  }) => {
    test.slow();
    const scan = async (label: string) => {
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.map(v => v.id),
        label
      ).toEqual([]);
    };
    for (const tab of ['review', 'open', 'paid', 'all']) {
      await page.goto(`/invoices?tab=${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await scan(tab);
    }
    const drawer = await openInvoice(page, inv.draftPurchase, 'review');
    await expect(drawer.getByRole('region', { name: 'Stock' })).toBeVisible();
    await scan('draft purchase drawer');
    await page.keyboard.press('Escape');

    await page.goto('/invoices');
    await page.getByRole('button', { name: 'Add invoice' }).click();
    // Let the dialog finish fading in: a scan mid-animation reads blended colours.
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await scan('add dialog');
  });
});
