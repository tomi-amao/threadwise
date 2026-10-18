/**
 * Row-level security, tested the way an attacker would: with the public key and a user's token,
 * straight at the API, and again through the pages. Two businesses are seeded (the second has
 * one of every kind of row the dashboard and Inventory read), so anything that leaks shows up as
 * extra numbers or rows.
 */

import { test, expect, readManifest } from './fixtures';
import { api, readItemIdBySku, rpc, signIn } from './helpers/db';

const seed = readManifest();
const rival = seed.rival;

// These talk to the API rather than render a page, so they run once (see playwright.config.ts).

let mine: string;
let theirs: string;
test.beforeAll(async () => {
  mine = await signIn(seed.email);
  theirs = await signIn(rival.email);
});

/** Every table the app reads as the user, with how many rows the first business owns. */
const TABLES: [table: string, owned: () => number][] = [
  ['orders', () => seed.orderCount],
  ['customers', () => seed.customerCount],
  ['financial_transactions', () => seed.transactionCount],
  ['bank_accounts', () => seed.bankAccountCount],
  ['inventory_movements', () => seed.inventory.movementCount],
  ['inventory_on_hand', () => seed.inventory.itemCount],
  ['invoices', () => seed.invoices.total],
  ['products', () => seed.productCount + 3],
  ['collections', () => seed.collections.count],
  ['collection_products', () => 5],
  ['collection_costs', () => seed.collections.autumn.costCount],
  ['collection_plans', () => 1],
  ['collection_plan_lines', () => seed.collections.plan.lineCount],
  ['collection_plan_costs', () => seed.collections.plan.costCount],
];

test.describe('without signing in', () => {
  test('the public key reads nothing from any table or view', async () => {
    for (const table of [
      'orders',
      'customers',
      'payments',
      'journals',
      'inventory_on_hand',
      'inventory_movements',
      'invoices',
      'accounting_periods',
      '_backup_phase1_items',
      'tax_adjustments',
      'collections',
      'collection_costs',
    ]) {
      const result = await api('GET', table, 'limit=5');
      expect(result.rows, table).toEqual([]);
    }
  });

  test('and writes nothing', async () => {
    const result = await api('POST', 'customers', '', undefined, {
      entity_id: '00000000-0000-4000-8000-000000000000',
      provider: 'x',
      external_id: 'x',
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

test.describe('database functions', () => {
  const ZERO = '00000000-0000-4000-8000-000000000000';
  // SECURITY DEFINER functions ignore row-level security, so they are for the service role only.
  const PRIVILEGED: [string, Record<string, unknown>][] = [
    ['get_api_key_secure', { p_source_id: ZERO }],
    ['store_api_key_secure', { p_source_id: ZERO, p_api_key: 'x', p_provider: 'x' }],
    ['delete_api_key_secure', { p_source_id: ZERO }],
    ['get_sync_stats_by_source', { p_source_id: ZERO }],
    ['post_draft_journal', { p_entity_id: ZERO, p_journal_id: ZERO, p_account_id: ZERO }],
  ];

  test('the public key cannot call any privileged function', async () => {
    for (const [fn, args] of PRIVILEGED) {
      const result = await rpc(fn, args);
      expect([401, 403, 404], fn).toContain(result.status);
    }
  });

  test('neither can a signed-in user', async () => {
    for (const [fn, args] of PRIVILEGED) {
      const result = await rpc(fn, args, mine);
      expect([401, 403, 404], fn).toContain(result.status);
    }
  });

  test('what a collection sold is counted for the caller only', async () => {
    const own = await rpc('collection_sales_rollup', { p_collection_id: null }, mine);
    expect(own.status).toBe(200);
    const totals = (own.body as { level: string; revenue: number }[]).filter(
      r => r.level === 'total'
    );
    expect(totals.reduce((t, r) => t + Number(r.revenue), 0)).toBe(seed.collections.totalRevenue);
    // The other business's collection is invisible to this caller, even when asked for by id.
    const cross = await rpc(
      'collection_sales_rollup',
      { p_collection_id: seed.collections.rivalId },
      mine
    );
    expect(cross.body).toEqual([]);
    expect(
      (await rpc('collection_sales_rollup', { p_collection_id: null })).status
    ).toBeGreaterThanOrEqual(401);
  });

  test('a user can run the ordinary ones, but only over their own business', async () => {
    const own = await api('GET', 'entities', 'select=id', mine);
    const ownId = String(own.rows[0].id);
    const rivalId = String((await api('GET', 'entities', 'select=id', theirs)).rows[0].id);
    const ownRun = await rpc('compute_corporation_tax', { p_entity_id: ownId }, mine);
    expect(ownRun.status).toBe(200);
    const crossRun = await rpc('compute_corporation_tax', { p_entity_id: rivalId }, mine);
    expect(crossRun.status).toBe(200);
    expect(crossRun.body).toEqual([]); // runs as the caller: the other business is invisible
    expect(
      (await rpc('compute_corporation_tax', { p_entity_id: ownId })).status
    ).toBeGreaterThanOrEqual(401);
  });
});

test.describe('signed in as the first business', () => {
  for (const [table, owned] of TABLES) {
    test(`sees exactly its own ${table}`, async () => {
      const result = await api('GET', table, 'select=*&limit=1', mine);
      expect([200, 206]).toContain(result.status); // 206: a limited read that reports a total
      expect(result.count).toBe(owned());
    });
  }

  test("cannot see the other business's orders, customers or invoices by asking for them", async () => {
    const orders = await api(
      'GET',
      'orders',
      `order_number=in.(${rival.orderNumbers.join(',')})`,
      mine
    );
    expect(orders.rows).toEqual([]);
    const customers = await api('GET', 'customers', 'last_name=eq.Rival', mine);
    expect(customers.rows).toEqual([]);
    const invoices = await api('GET', 'invoices', `invoice_number=eq.${rival.invoiceNumber}`, mine);
    expect(invoices.rows).toEqual([]);
    const stock = await api('GET', 'inventory_on_hand', `sku=eq.${rival.inventorySku}`, mine);
    expect(stock.rows).toEqual([]);
  });

  test("cannot change the other business's inventory item", async () => {
    const id = await readItemIdBySku(rival.inventorySku);
    const patched = await api('PATCH', 'inventory_items', `id=eq.${id}`, mine, { unit_cost: 1 });
    expect(patched.rows).toEqual([]); // matched no rows: RLS hid it
    const after = await api('GET', 'inventory_items', `id=eq.${id}`, theirs);
    expect(Number(after.rows[0].unit_cost)).toBe(40);
  });

  test("cannot add a movement to the other business's item, or write orders at all", async () => {
    const id = await readItemIdBySku(rival.inventorySku);
    const movement = await api('POST', 'inventory_movements', '', mine, {
      inventory_item_id: id,
      transaction_type: 'PURCHASE',
      quantity: 999,
      unit_cost: 1,
    });
    expect(movement.status).toBeGreaterThanOrEqual(400);
    // An UPDATE with no policy matches no rows (it is not an error): nothing changes.
    const order = await api('PATCH', 'orders', 'order_number=eq.%231001', mine, {
      status: 'cancelled',
    });
    expect(order.rows).toEqual([]);
    const cancelled = await api('GET', 'orders', 'select=id&status=eq.cancelled', mine);
    expect(cancelled.count).toBe(0);
  });
});

test.describe('signed in as the other business', () => {
  test('sees only its own rows', async () => {
    expect((await api('GET', 'orders', 'select=id', theirs)).count).toBe(rival.orderNumbers.length);
    expect((await api('GET', 'customers', 'select=id', theirs)).count).toBe(
      rival.customerNames.length
    );
    expect((await api('GET', 'inventory_on_hand', 'select=sku', theirs)).count).toBe(1);
    expect((await api('GET', 'invoices', 'select=id', theirs)).count).toBe(1);
  });
});

test.describe('the pages', () => {
  test('the dashboard counts only the signed-in business', async ({ page }) => {
    await page.goto('/dashboard');
    const main = page.getByRole('main');
    await expect(
      main.getByText(`${seed.orderCount.toLocaleString('en-GB')} orders`).first()
    ).toBeVisible();
    // The other business's three orders would make this 1,203.
    await expect(
      main.getByText(`${(seed.orderCount + 3).toLocaleString('en-GB')} orders`)
    ).toHaveCount(0);
    await expect(main.getByText(rival.entityName)).toHaveCount(0);
    await expect(main.getByText(String(seed.customerCount), { exact: true }).first()).toBeVisible();
  });

  test('the dashboard bank balance leaves out the other business', async ({ page }) => {
    await page.goto('/dashboard');
    const expected = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'GBP',
      maximumFractionDigits: 0,
    }).format(seed.expectedBankBalance);
    await expect(page.getByRole('main').getByText(expected, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('main').getByText(rival.bankName)).toHaveCount(0);
  });

  test('Inventory lists only its own items and totals', async ({ page }) => {
    await page.goto('/inventory?tab=items');
    await expect(page.getByRole('tab', { name: /^Items/ })).toContainText(
      String(seed.inventory.itemCount)
    );
    await page.goto(`/inventory?tab=items&q=${rival.inventorySku}`);
    await expect(page.getByText('Nothing matches.')).toBeVisible();
    await page.goto('/inventory');
    await expect(page.getByRole('main')).not.toContainText(rival.productName);
  });

  test("recording a disposal against the other business's item is refused", async ({ page }) => {
    await page.goto('/inventory');
    const id = await readItemIdBySku(rival.inventorySku);
    const result = await page.evaluate(async itemId => {
      const body = new FormData();
      body.set('intent', 'recordDisposal');
      body.set('inventoryItemId', itemId);
      body.set('disposalType', 'GIFT');
      body.set('quantity', '1');
      const r = await fetch('/api/inventory', { method: 'POST', body });
      return { status: r.status, body: await r.json() };
    }, id);
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('Inventory item not found');
  });
});
