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
const gbp = (n: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);

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
    await expect(next).toContainText('1 product line is not linked to a product (optional)');
    await expect(next.getByRole('button', { name: 'Finalise invoice' })).toBeEnabled();

    const amounts = drawer.getByRole('region', { name: 'Amounts' });
    await expect(amounts).toContainText('£1,000.00');
    await expect(amounts).toContainText('£200.00');
    await expect(amounts).toContainText('£1,200.00');
    await expect(drawer.getByRole('region', { name: 'Lines' }).getByRole('listitem')).toHaveCount(
      3
    );
    await expect(drawer.getByRole('region', { name: 'What this invoice bought' })).toBeVisible();
  });

  test('a purchase shows what it bought: products and samples, not freight', async ({ page }) => {
    const sale = await openInvoice(page, inv.draftSale, 'review');
    await expect(sale.getByRole('region', { name: 'What this invoice bought' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    const drawer = await openInvoice(page, inv.draftPurchase, 'review');
    const bought = drawer.getByRole('region', { name: 'What this invoice bought' });
    await expect(bought).toContainText('1 product, 40 units; 1 sample, 10 units');
    await expect(bought.getByRole('listitem')).toHaveCount(2);
    await expect(bought.locator('li', { hasText: 'Merino yarn 4-ply' })).toContainText(
      'Not linked to a product'
    );
    await expect(bought.locator('li', { hasText: 'Heavy knit swatches' })).toContainText('Sample');
    await expect(bought).not.toContainText('Delivery');
    await expect(bought).toContainText('does not change your products or stock');
  });

  test("a linked product opens that product's page", async ({ page }) => {
    const drawer = await openInvoice(page, inv.boughtInvoice, 'open');
    const bought = drawer.getByRole('region', { name: 'What this invoice bought' });
    const link = bought.getByRole('link', { name: inv.boughtProduct });
    await expect(link).toHaveAttribute('href', /^\/products\?product=/);
    await expect(bought).toContainText('Production run: cardigans');
    await link.click();
    await expect(page).toHaveURL(/\/products\?product=/);
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: inv.boughtProduct })
    ).toBeVisible();
  });

  test('changing what a line is offers a product only for a product line', async ({ page }) => {
    const drawer = await openInvoice(page, inv.draftPurchase, 'review');
    const bought = drawer.getByRole('region', { name: 'What this invoice bought' });
    await bought.getByRole('button', { name: 'Change' }).click();
    const save = bought.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled(); // nothing changed yet

    await expect(bought.getByLabel('Product for Merino yarn 4-ply')).toBeVisible();
    await expect(bought.getByLabel('Product for Heavy knit swatches')).toHaveCount(0);
    await bought.getByLabel('What Heavy knit swatches is').selectOption('product');
    await expect(bought.getByLabel('Product for Heavy knit swatches')).toBeVisible();
    await expect(save).toBeEnabled();

    await bought.getByRole('button', { name: 'Cancel' }).click();
    await expect(bought).toContainText('1 product, 40 units; 1 sample, 10 units');
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
    // It was matched on upload, because its number and amount agree with the payment.
    await expect(drawer.getByRole('region', { name: 'Payment match' })).toContainText(
      'Matched automatically: the invoice number and the amount agree.'
    );
    await expect(drawer.getByRole('link', { name: /View the transaction/ })).toHaveAttribute(
      'href',
      /\/transactions\?transactionId=/
    );
    await expect(drawer.getByRole('button', { name: 'Undo payment' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  });

  test("a matched purchase shows its payment's journal and the split its lines suggest", async ({
    page,
  }) => {
    const drawer = await openInvoice(page, inv.split.invoice, 'paid');
    const books = drawer.getByRole('region', { name: 'Payment journal' });
    await expect(books).toContainText('The payment is journaled to 1033');
    const split = books.getByRole('list', { name: 'Split' }).getByRole('listitem');
    await expect(split).toHaveCount(inv.split.lines.length);
    for (const line of inv.split.lines) {
      const shown = split.filter({ hasText: line.description });
      await expect(shown).toContainText(line.account);
      await expect(shown).toContainText(gbp(line.amount));
    }
    await expect(books).toContainText('keeps the payment’s date');
    await page.keyboard.press('Escape');

    // A sale has nothing to split: its payment is income, journaled from the bank feed.
    const sale = await openInvoice(page, inv.revolutRequest, 'paid');
    await expect(sale.getByRole('region', { name: 'Payment journal' })).toHaveCount(0);
  });

  test('a void invoice says it stays on record and can be deleted; a live one cannot', async ({
    page,
  }) => {
    const drawer = await openInvoice(page, inv.voided, 'all');
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText(
      'It stays on record'
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

  test('the register says where each invoice came from, and can show one source', async ({
    page,
  }) => {
    await page.goto('/invoices?tab=all');
    await expect(row(page, inv.revolutRequest)).toContainText('Revolut');
    await expect(row(page, inv.receiptInvoice)).toContainText('Receipt');
    await expect(row(page, inv.draftPurchase)).not.toContainText('Receipt');

    const from = page.getByRole('group', { name: 'From' });
    await from.getByRole('button', { name: 'Revolut' }).click();
    await expect(page).toHaveURL(/from=revolut_merchant/);
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    await expect(row(page, inv.revolutRequest)).toBeVisible();

    await from.getByRole('button', { name: 'Receipts' }).click();
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    await expect(row(page, inv.receiptInvoice)).toBeVisible();

    await from.getByRole('button', { name: 'Uploaded' }).click();
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText(
      `OF ${num(inv.uploadedCount)}`
    );
  });

  test('a Revolut invoice is not settled here, and prints from what was sent', async ({ page }) => {
    const drawer = await openInvoice(page, inv.revolutRequest, 'paid');
    await expect(drawer.getByRole('banner')).toContainText('Sent from Revolut');
    for (const name of ['Undo payment', 'Void invoice', /^Delete/, 'Not an invoice']) {
      await expect(drawer.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(drawer.getByRole('button', { name: 'Add the original' })).toBeVisible();

    const response = page.waitForResponse(r => r.url().includes('document=1'));
    await drawer.getByRole('button', { name: 'Print invoice' }).click();
    const { url } = (await (await response).json()) as { url: string };
    expect(url).toMatch(/^\/api\/invoices\/print\?id=/);

    // The printable copy asks for the request's amount, not what the lines add up to.
    await page.goto(`${url}&noprint=1`);
    const money = (n: number) =>
      new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
    await expect(page.locator('body')).toContainText(inv.revolutRequest);
    await expect(page.locator('body')).toContainText(inv.revolutRequestCounterparty);
    await expect(page.locator('tr', { hasText: 'Amount requested' })).toContainText(
      money(inv.revolutRequestGross)
    );
    await expect(page.locator('tr', { hasText: 'Lines total' })).toContainText(
      money(inv.revolutRequestLinesTotal)
    );
    await expect(page.getByText('Sent as a payment request through Revolut')).toBeVisible();
  });

  test('an invoice read from a receipt opens the receipt and can be dismissed', async ({
    page,
  }) => {
    const drawer = await openInvoice(page, inv.receiptInvoice, 'paid');
    await expect(drawer.getByRole('banner')).toContainText('Read from a Revolut receipt');
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText(
      'Paid by the payment this receipt is on'
    );
    await expect(drawer.getByRole('button', { name: 'Not an invoice' })).toBeVisible();
    for (const name of ['Undo payment', 'Void invoice', 'Add the original']) {
      await expect(drawer.getByRole('button', { name })).toHaveCount(0);
    }

    const response = page.waitForResponse(r => r.url().includes('document=1'));
    await drawer.getByRole('button', { name: 'View receipt' }).click();
    const { ok, url } = (await (await response).json()) as { ok: boolean; url: string };
    expect(ok).toBe(true);
    expect(url).toContain('/storage/v1/object/sign/transaction-attachments/');
  });

  test('the printable copy of an invoice that is not yours is not found', async ({ page }) => {
    const response = await page.request.get(
      '/api/invoices/print?id=00000000-0000-4000-8000-000000000000&noprint=1'
    );
    expect(response.status()).toBe(404);
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
    await drawer
      .getByRole('region', { name: 'What this invoice bought' })
      .getByRole('button', { name: 'Change' })
      .click();
    await scan('draft purchase drawer');
    await page.keyboard.press('Escape');

    const overdue = await openInvoice(page, inv.overduePurchase, 'open');
    await overdue.getByRole('button', { name: 'Paid without the bank' }).click();
    await scan('paid without the bank form');
    await page.keyboard.press('Escape');

    const split = await openInvoice(page, inv.split.invoice, 'paid');
    await expect(split.getByRole('button', { name: 'Split the journal' })).toBeVisible();
    await scan('journal split proposal');
    await page.keyboard.press('Escape');

    await openInvoice(page, inv.revolutRequest, 'paid');
    await scan('Revolut invoice drawer');
    await page.keyboard.press('Escape');

    await page.goto('/invoices');
    await page.getByRole('button', { name: 'Add invoice' }).click();
    // Let the dialog finish fading in: a scan mid-animation reads blended colours.
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await scan('add dialog');
  });
});
