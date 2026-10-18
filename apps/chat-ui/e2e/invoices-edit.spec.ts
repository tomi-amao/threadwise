/**
 * Invoice tests that change data. They run in the `mutations` project, after every read-only
 * test, against the stand-in agent (see stand-in-agent.ts), and put the database back as they
 * found it. The lifecycle rules themselves are tested in the agent's own suite.
 */

import type { Page } from '@playwright/test';
import { test, expect, readManifest } from './fixtures';
import {
  borrowTransaction,
  readInvoice,
  readTxnInvoiceId,
  readLineAccount,
  restoreInvoices,
  snapshotInvoices,
  type InvoiceSnapshot,
} from './helpers/db';

const inv = readManifest().invoices;
const gbp0 = (n: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    maximumFractionDigits: 0,
  }).format(n);

let before: InvoiceSnapshot;
test.beforeEach(async () => {
  before = await snapshotInvoices();
});
test.afterEach(async () => {
  await restoreInvoices(before);
});

const table = (page: Page) => page.getByRole('region', { name: 'Invoices' });
const tile = (page: Page, label: string) =>
  page.getByRole('main').getByText(label, { exact: true }).first().locator('xpath=..');

async function openInvoice(page: Page, number: string, tab = 'all') {
  await page.goto(`/invoices?tab=${tab}&q=${number}`);
  await table(page).locator('tr', { hasText: number }).getByRole('button').first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('region', { name: 'Next step' })).toBeVisible();
  return drawer;
}

const pdf = (name: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.1\n%%EOF'),
});

test.describe('adding invoices', () => {
  test('a file is read into a draft, and the draft opens for review', async ({ page }) => {
    await page.goto('/invoices');
    await page.getByRole('button', { name: 'Add invoice' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Choose invoice files').setInputFiles(pdf('supplier-bill.pdf'));
    await dialog.getByRole('button', { name: 'Add 1 invoice' }).click();

    // The dialog gets out of the way and the new draft is open, ready to check.
    await expect(page).toHaveURL(/invoice=/);
    await expect(page).toHaveURL(/tab=review/);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Stand-in Supplier Ltd');
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText(
      'Check the lines, then finalise'
    );
    await expect(drawer).toContainText('You owe');
    await expect(drawer.getByRole('region', { name: 'Lines' })).toContainText('Uploaded item');
  });

  test('the direction can be set when the document is ambiguous', async ({ page }) => {
    await page.goto('/invoices');
    await page.getByRole('button', { name: 'Add invoice' }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('group', { name: 'Direction' })
      .getByRole('button', { name: 'Owed to you' })
      .click();
    await dialog.getByLabel('Choose invoice files').setInputFiles(pdf('our-invoice.pdf'));
    await dialog.getByRole('button', { name: 'Add 1 invoice' }).click();
    await expect(page.getByRole('dialog')).toContainText('Stand-in Customer Ltd');
    await expect(page.getByRole('dialog')).toContainText('Owed to you');
  });

  test('a file that cannot be read says so and can be removed, without losing the dialog', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await page.getByRole('button', { name: 'Add invoice' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Choose invoice files').setInputFiles(pdf('unreadable.pdf'));
    await dialog.getByRole('button', { name: 'Add 1 invoice' }).click();

    await expect(dialog.getByRole('list', { name: 'Files' })).toContainText(
      'Could not read any invoice data'
    );
    await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove unreadable.pdf' }).click();
    await expect(dialog.getByRole('list', { name: 'Files' })).toHaveCount(0);
  });

  test('a draft that was just added can be deleted', async ({ page }) => {
    await page.goto('/invoices');
    const countOf = async () =>
      Number((await page.getByRole('tab', { name: /^All/ }).innerText()).replace(/\D/g, ''));
    const total = await countOf();

    await page.getByRole('button', { name: 'Add invoice' }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Choose invoice files')
      .setInputFiles(pdf('oops.pdf'));
    await page.getByRole('dialog').getByRole('button', { name: 'Add 1 invoice' }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('button', { name: 'Delete draft' })).toBeVisible();

    await drawer.getByRole('button', { name: 'Delete draft' }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: 'Delete this invoice?' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(page.getByText('Invoice deleted')).toBeVisible();
    await expect(page).not.toHaveURL(/invoice=/);
    await expect.poll(countOf).toBe(total);
  });
});

test.describe('the list follows what is added', () => {
  test('a new draft appears in To review and in the All count', async ({ page }) => {
    await page.goto('/invoices');
    const countOf = async () =>
      Number((await page.getByRole('tab', { name: /^All/ }).innerText()).replace(/\D/g, ''));
    const total = await countOf();
    await page.getByRole('button', { name: 'Add invoice' }).click();
    await page.getByRole('dialog').getByLabel('Choose invoice files').setInputFiles(pdf('new.pdf'));
    await page.getByRole('dialog').getByRole('button', { name: 'Add 1 invoice' }).click();
    await expect(page).toHaveURL(/invoice=/);
    await page.keyboard.press('Escape');
    await expect.poll(countOf).toBe(total + 1);
    await expect(table(page).locator('tr', { hasText: 'Stand-in Supplier Ltd' })).toBeVisible();
  });
});

test.describe('moving an invoice through its lifecycle', () => {
  test('finalising a draft opens it, and the owed-to-you total follows', async ({ page }) => {
    const drawer = await openInvoice(page, inv.draftSale, 'review');
    await drawer.getByRole('button', { name: 'Finalise invoice' }).click();
    await expect(page.getByText('Invoice finalised and posted to your books')).toBeVisible();

    // Now open, due in the future: the next step is payment.
    await expect(drawer.getByRole('button', { name: 'Mark as received' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Finalise invoice' })).toHaveCount(0);
    expect((await readInvoice(inv.draftSale))?.status).toBe('OPEN');

    await page.keyboard.press('Escape');
    await expect(tile(page, 'Owed to you')).toContainText(gbp0(inv.owedToYou + 480));
    await expect(tile(page, 'To review')).toContainText(String(inv.toReview - 1));
  });

  test('an invoice the agent refuses to finalise stays a draft and says why', async ({ page }) => {
    const drawer = await openInvoice(page, inv.priorPeriodDraft, 'review');
    await drawer.getByRole('button', { name: 'Finalise invoice' }).click();
    await expect(page.getByText(/before the 2026-01-01 accounting cutoff/)).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Finalise invoice' })).toBeVisible();
    expect((await readInvoice(inv.priorPeriodDraft))?.status).toBe('DRAFT');
  });

  test('marking paid without a matched bank payment asks first', async ({ page }) => {
    const drawer = await openInvoice(page, inv.overduePurchase, 'open');
    await drawer.getByRole('button', { name: 'Mark as paid' }).click();

    const confirm = page.getByRole('dialog').filter({ hasText: 'without a matched payment' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect((await readInvoice(inv.overduePurchase))?.status).toBe('OPEN');

    await drawer.getByRole('button', { name: 'Mark as paid' }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: 'without a matched payment' })
      .getByRole('button', { name: 'Mark paid anyway' })
      .click();
    await expect(page.getByText('Marked as paid')).toBeVisible();
    expect((await readInvoice(inv.overduePurchase))?.status).toBe('PAID');

    // Wait for the confirmation to be gone, then close the drawer with its own button: Escape goes
    // to the topmost layer, which can still be the confirmation while it animates out.
    await expect(
      page.getByRole('dialog').filter({ hasText: 'without a matched payment' })
    ).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(tile(page, 'Overdue')).toContainText(String(inv.overdueCount - 1));
    await expect(tile(page, 'You owe')).toContainText(`${inv.youOweCount - 1} unpaid`);
  });

  test('an invoice with a matched bank payment is marked paid without asking', async ({ page }) => {
    const drawer = await openInvoice(page, inv.matchedPurchase, 'open');
    await drawer.getByRole('button', { name: 'Mark as paid' }).click();
    await expect(page.getByText('Marked as paid')).toBeVisible();
    await expect(
      page.getByRole('dialog').filter({ hasText: 'without a matched payment' })
    ).toHaveCount(0);
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText(
      'matched to a bank transaction'
    );
    expect((await readInvoice(inv.matchedPurchase))?.status).toBe('PAID');
  });

  test('a bank payment can be matched to an invoice from the drawer, and unmatched again', async ({
    page,
  }) => {
    // INV-PP-3001 is £180 with no payment matched: make one transaction look like its payment.
    const borrowed = await borrowTransaction('out', 180, 'ParcelPost Ltd');
    try {
      const drawer = await openInvoice(page, inv.overduePurchase, 'open');
      const match = drawer.getByRole('region', { name: 'Payment match' });
      await expect(match).toContainText('Not matched yet');
      await match.getByRole('button', { name: 'Match a payment' }).click();
      await match.getByRole('button', { name: /^Match ParcelPost Ltd for £180/ }).click();
      await expect(match).toContainText('Matched to a bank transaction');
      expect(await readTxnInvoiceId(borrowed.id)).toBe(inv.overduePurchase);

      // With a payment matched, marking paid no longer asks first.
      await drawer.getByRole('button', { name: 'Mark as paid' }).click();
      await expect(page.getByText('Marked as paid')).toBeVisible();
      expect((await readInvoice(inv.overduePurchase))?.status).toBe('PAID');

      await match.getByRole('button', { name: 'Remove match' }).click();
      await expect(match).not.toContainText('Matched to a bank transaction');
      expect(await readTxnInvoiceId(borrowed.id)).toBeUndefined();
    } finally {
      await borrowed.restore();
    }
  });

  test('part paid is a step on the way', async ({ page }) => {
    const drawer = await openInvoice(page, inv.openSale, 'open');
    await drawer.getByRole('button', { name: 'Part paid' }).click();
    await expect(page.getByText('Marked part paid')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Part paid' })).toHaveCount(0);
    expect((await readInvoice(inv.openSale))?.status).toBe('PARTIALLY_PAID');
  });

  test('voiding asks for confirmation, then takes the invoice out of the totals', async ({
    page,
  }) => {
    const drawer = await openInvoice(page, inv.openSale, 'open');
    await drawer.getByRole('button', { name: 'Void invoice' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Void this invoice?' });
    await confirm.getByRole('button', { name: 'Void invoice' }).click();
    await expect(page.getByText('Invoice voided and reversed in your books')).toBeVisible();
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText('no effect');
    expect((await readInvoice(inv.openSale))?.status).toBe('VOID');

    await page.keyboard.press('Escape');
    await expect(tile(page, 'Owed to you')).toContainText(gbp0(inv.owedToYou - 2400));
  });

  test('a paid invoice can be undone back to open', async ({ page }) => {
    const drawer = await openInvoice(page, inv.paidMatched, 'paid');
    await drawer.getByRole('button', { name: 'Undo payment' }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: 'Undo the payment?' })
      .getByRole('button', { name: 'Undo payment' })
      .click();
    await expect(page.getByText('Payment undone')).toBeVisible();
    expect((await readInvoice(inv.paidMatched))?.status).toBe('OPEN');
  });

  test('an invoice that is not a draft cannot be deleted, even if asked directly', async ({
    page,
  }) => {
    await page.goto('/invoices');
    const open = await readInvoice(inv.openSale);
    const form = new FormData();
    form.set('intent', 'delete');
    form.set('invoiceId', open!.id);
    const result = await page.evaluate(
      async ([id]) => {
        const body = new FormData();
        body.set('intent', 'delete');
        body.set('invoiceId', id);
        const r = await fetch('/api/invoices', { method: 'POST', body });
        return { status: r.status, body: await r.json() };
      },
      [open!.id]
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/cannot be deleted/);
    expect(await readInvoice(inv.openSale)).not.toBeNull();
  });
});

test.describe('editing an invoice', () => {
  test('notes are saved', async ({ page }) => {
    const drawer = await openInvoice(page, inv.openSale, 'open');
    await drawer.getByRole('textbox', { name: 'Notes' }).fill('Chased by email on Friday');
    await drawer.getByRole('button', { name: 'Save notes' }).click();
    await expect(page.getByText('Notes saved')).toBeVisible();
    expect((await readInvoice(inv.openSale))?.notes).toBe('Chased by email on Friday');
    await expect(drawer.getByRole('button', { name: 'Save notes' })).toHaveCount(0);
  });

  test('the account on a line can be changed and saved', async ({ page }) => {
    const drawer = await openInvoice(page, inv.draftPurchase, 'review');
    const before = await readLineAccount(inv.draftPurchase, 'Delivery');
    expect(before).toBeNull();

    await drawer.getByRole('button', { name: /Account for Delivery/ }).click();
    await page.getByRole('option', { name: /6300 · Shipping and delivery/ }).click();
    await drawer.getByRole('button', { name: 'Save accounts' }).click();
    await expect(page.getByText('Accounts saved')).toBeVisible();

    expect(await readLineAccount(inv.draftPurchase, 'Delivery')).not.toBeNull();
    await expect(drawer.getByRole('region', { name: 'Next step' })).toContainText(
      'Every line has an account'
    );
  });
});

test.describe('stock from a purchase invoice', () => {
  test('a line can be tracked as stock, and then shows as recorded', async ({ page }) => {
    const drawer = await openInvoice(page, inv.draftPurchase, 'review');
    await drawer.getByLabel('Stock handling for Merino yarn 4-ply').selectOption('track');
    await drawer.getByRole('button', { name: 'Apply 1 decision' }).click();

    await expect(page.getByText('Stock recorded for 1 line')).toBeVisible();
    const stock = drawer.getByRole('region', { name: 'Stock' });
    await expect(stock.locator('li', { hasText: 'Merino yarn 4-ply' })).toContainText(
      'Stock recorded'
    );
    // The other lines are still open to decide on.
    await expect(drawer.getByLabel('Stock handling for Heavy knit swatches')).toBeVisible();
    await expect(drawer.getByLabel('Stock handling for Merino yarn 4-ply')).toHaveCount(0);
  });
});
