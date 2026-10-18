/**
 * The one write on the Reports page: leaving a bank transaction out of the spend figures, and
 * putting it back. Runs in the `mutations` project and restores the transaction afterwards.
 */

import { test, expect } from './fixtures';
import { findTxnIds, readTxn, restoreTxn, type TxnState } from './helpers/db';

let saved: TxnState[] = [];
test.afterEach(async () => {
  for (const s of saved) await restoreTxn(s);
  saved = [];
});

test('a transaction can be left out of the spend figures, and put back', async ({ page }) => {
  await page.goto('/reports?tab=revenue');
  const monthly = page.getByRole('region', { name: 'Monthly breakdown' });
  await monthly
    .getByRole('button', { name: /other spend detail/ })
    .first()
    .click();
  const drawer = page.getByRole('dialog');
  const total = drawer.locator('dd').first();
  const before = await total.innerText();

  // The first transaction listed: remember its state so the test can put it back.
  const firstRow = drawer.getByRole('region', { name: 'Transactions' }).locator('tbody tr').first();
  const link = await firstRow.getByRole('link').getAttribute('href');
  const id = new URL(link!, 'http://x').searchParams.get('transactionId')!;
  saved.push(await readTxn(id));

  await firstRow.getByRole('button', { name: 'Leave out' }).click();
  await expect(firstRow.getByText('Left out')).toBeVisible();
  await expect(total).not.toHaveText(before);
  expect((await readTxn(id)).status).toBe('excluded');

  await firstRow.getByRole('button', { name: 'Put back' }).click();
  await expect(firstRow.getByText('Left out')).toHaveCount(0);
  await expect(total).toHaveText(before);
});

test('only the signed-in business can leave a transaction out', async ({ page }) => {
  await page.goto('/reports');
  const [mine] = await findTxnIds('Postage', 1);
  saved.push(await readTxn(mine));
  // Someone else's transaction id (it does not exist for this user) is refused, not applied.
  const result = await page.evaluate(async () => {
    const body = new FormData();
    body.set('intent', 'toggleExpenseExclusion');
    body.set('transactionId', '00000000-0000-4000-8000-000000000000');
    body.set('excluded', 'true');
    const r = await fetch('/reports', { method: 'POST', body });
    return { status: r.status, text: await r.text() };
  });
  expect(result.status).toBe(404);
});
