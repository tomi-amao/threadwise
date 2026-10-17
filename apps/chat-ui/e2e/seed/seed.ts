/**
 * Seeds the LOCAL Supabase database with a test user and a small, deterministic
 * business (one entity, products, customers, orders, payments, bank accounts and
 * bank transactions).
 *
 * Usage:  pnpm e2e:seed          (after `supabase start` and `pnpm e2e:env`)
 *         pnpm db:fresh          (reset the database, then seed)
 *
 * The same random seed produces the same rows every run. Dates are relative to the
 * run time (server code computes "last N months" from the real clock), so tests
 * assert on counts and structure, not on dates.
 *
 * Refuses to run against anything but a local Supabase, and refuses to run twice:
 * if the test user already exists it stops and tells you to reset first.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { MANIFEST_FILE, assertLocalSupabase, loadTestEnv, requireEnv } from '../env';

loadTestEnv();
const url = assertLocalSupabase(process.env.SUPABASE_URL);
const email = requireEnv('E2E_USER_EMAIL');
const password = requireEnv('E2E_USER_PASSWORD');

const supabase = createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const ENTITY_NAME = 'Atelier North (E2E)';

// Snapshot balance of the main account. High enough that ~1,100 seeded transactions leave a
// believable positive balance.
const OPENING_BALANCE = 600_000;
const SIZES = ['S', 'M'] as const;
/** Extra purchase/sale movement pairs on one item, to prove movements are read past the 1,000-row cap. */
const BULK_MOVEMENT_PAIRS = 550;

// ─── Deterministic helpers ───────────────────────────────────────────────────

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261016);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const money = (n: number) => Math.round(n * 100) / 100;
const daysAgo = (d: number, hour = 12) => {
  const t = new Date();
  t.setUTCHours(hour, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() - d);
  return t.toISOString();
};

async function must<T>(
  label: string,
  p: PromiseLike<{ data: T; error: { message: string } | null }>
) {
  const { data, error } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

/** Insert in chunks so a large seed stays within request-size limits. Returns every returned row. */
async function insertChunked<T>(
  label: string,
  table: string,
  rows: Record<string, unknown>[],
  columns: string,
  size = 400
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += size) {
    const data = await must(
      `${label} [${i}..${i + size}]`,
      supabase
        .from(table)
        .insert(rows.slice(i, i + size))
        .select(columns)
    );
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

// ─── Seed ────────────────────────────────────────────────────────────────────

async function main() {
  // Refuse to double-seed.
  const { data: existing } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (existing?.users.some(u => u.email === email)) {
    console.error(`Test user ${email} already exists. Run \`pnpm db:fresh\` to reset and re-seed.`);
    process.exit(1);
  }

  // 1. Auth user (confirmed, so it can sign in immediately).
  const { data: created, error: userError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'E2E Tester' },
  });
  if (userError || !created.user) throw new Error(`createUser: ${userError?.message}`);
  const userId = created.user.id;

  // 2. Entity owned by that user. onboarding_completed=true so the onboarding modal
  //    doesn't cover the page under test.
  const entity = await must(
    'entity',
    supabase
      .from('entities')
      .insert({
        name: ENTITY_NAME,
        legal_name: 'Atelier North Ltd',
        country: 'GB',
        currency: 'GBP',
        industry: 'Fashion',
        onboarding_completed: true,
        owner_user_id: userId,
        year_end_day: 31,
        year_end_month: 3,
        vat_registered: true,
      })
      .select('id')
      .single()
  );
  const entityId = (entity as { id: string }).id;

  // 3. Products, each with two size variants.
  const productNames = [
    'Heavy Knit Cardigan',
    'Wool Overshirt',
    'Selvedge Work Trouser',
    'Linen Camp Shirt',
    'Merino Scarf',
    'Brushed Cotton Tee',
    'Canvas Tote',
    'Rib Beanie',
  ];
  const prices = [98, 124, 135, 76, 58, 42, 36, 28];
  const products = (await must(
    'products',
    supabase
      .from('products')
      .insert(
        productNames.map((name, i) => ({
          entity_id: entityId,
          provider: 'shopify',
          external_id: `e2e-prod-${i + 1}`,
          name,
          product_type: 'apparel',
          status: 'active',
          created_at: daysAgo(330),
          // Two sizes each, so every product has variants for inventory items to point at.
          variants: SIZES.map(size => ({
            external_id: `e2e-var-${i + 1}-${size}`,
            sku: `E2E-${i + 1}-${size}`,
            price: { amount: prices[i], currency: 'GBP' },
            attributes: { SIZE: size },
          })),
        }))
      )
      .select('id, name')
  )) as { id: string; name: string }[];

  // 4. Customers.
  const first = [
    'Amara',
    'Jonas',
    'Priya',
    'Tom',
    'Elena',
    'Sam',
    'Mina',
    'Luca',
    'Chloe',
    'Daniel',
    'Ines',
    'Hannah',
    'Kofi',
    'Noor',
  ];
  const last = [
    'Okafor',
    'Weber',
    'Nair',
    'Hartley',
    'Rossi',
    'Whitfield',
    'Patel',
    'Bianchi',
    'Martin',
    'Osei',
    'Duarte',
    'Cole',
    'Mensah',
    'Aziz',
  ];
  const customers = (await must(
    'customers',
    supabase
      .from('customers')
      .insert(
        first.map((f, i) => ({
          entity_id: entityId,
          provider: 'shopify',
          external_id: `e2e-cust-${i + 1}`,
          email: `${f}.${last[i]}@example.test`.toLowerCase(),
          first_name: f,
          last_name: last[i],
          created_at: daysAgo(320),
        }))
      )
      .select('id, email')
  )) as { id: string; email: string }[];

  // 5. Orders spread over ~10 months, each with 1-3 line items, a payment and a fee.
  const statuses = [
    'delivered',
    'delivered',
    'delivered',
    'delivered',
    'shipped',
    'processing',
    'confirmed',
    'pending',
  ] as const;
  // Deliberately above the API's 1,000-row max_rows: an unpaginated read silently loses rows,
  // and the dashboard tests compare against these totals.
  const ORDER_COUNT = 1200;
  type Line = { productIdx: number; qty: number };
  const plan = Array.from({ length: ORDER_COUNT }, (_, i) => {
    const lines: Line[] = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({
      productIdx: Math.floor(rand() * products.length),
      qty: 1 + Math.floor(rand() * 2),
    }));
    return {
      n: 1001 + i,
      customer: pick(customers),
      status: pick(statuses),
      age: Math.floor(((ORDER_COUNT - i) / ORDER_COUNT) * 300) + Math.floor(between(0, 4)),
      lines,
    };
  });

  const orderRows = plan.map(o => {
    const subtotal = money(o.lines.reduce((s, l) => s + prices[l.productIdx] * l.qty, 0));
    const discount = rand() < 0.2 ? money(subtotal * 0.1) : 0;
    const shipping = subtotal > 100 ? 0 : 4.5;
    const grand = money(subtotal - discount + shipping);
    return {
      entity_id: entityId,
      customer_id: o.customer.id,
      provider: 'shopify',
      external_id: `e2e-order-${o.n}`,
      order_number: `#${o.n}`,
      status: o.status,
      fulfillment_status:
        o.status === 'delivered' || o.status === 'shipped' ? 'fulfilled' : 'unfulfilled',
      customer_email: o.customer.email,
      subtotal_amount: subtotal,
      discount_total_amount: discount,
      shipping_total_amount: shipping,
      // UK prices are VAT-inclusive: the VAT is inside the gross total.
      tax_total_amount: money(grand / 6),
      grand_total_amount: grand,
      refunded_total_amount: 0,
      currency: 'GBP',
      created_at: daysAgo(o.age),
    };
  });
  const orders = await insertChunked<{
    id: string;
    external_id: string;
    grand_total_amount: number;
    created_at: string;
  }>('orders', 'orders', orderRows, 'id, external_id, grand_total_amount, created_at');
  const orderByExternal = new Map(orders.map(o => [o.external_id, o]));

  const lineRows = plan.flatMap(o => {
    const order = orderByExternal.get(`e2e-order-${o.n}`)!;
    return o.lines.map((l, i) => ({
      order_id: order.id,
      external_id: `e2e-line-${o.n}-${i + 1}`,
      product_id: products[l.productIdx].id,
      product_name: products[l.productIdx].name,
      quantity: l.qty,
      unit_price_amount: prices[l.productIdx],
      total_price_amount: money(prices[l.productIdx] * l.qty),
      created_at: order.created_at,
    }));
  });
  await insertChunked('order_line_items', 'order_line_items', lineRows, 'id');

  const feeFor = (amount: number) => money(amount * 0.029 + 0.2);
  const paymentRows = orders.map((o, i) => {
    const amount = Number(o.grand_total_amount);
    const fee = feeFor(amount);
    const viaPaypal = i % 4 === 0;
    return {
      entity_id: entityId,
      order_id: o.id,
      provider: 'shopify',
      external_id: `e2e-pay-${i + 1}`,
      gateway: viaPaypal ? 'paypal' : 'shopify_payments',
      payment_method: viaPaypal ? 'paypal' : 'card',
      amount,
      base_amount: amount,
      net_amount: money(amount - fee),
      currency: 'GBP',
      status: 'captured',
      paid_on: o.created_at,
      created_at: o.created_at,
    };
  });
  const payments = await insertChunked<{ id: string; external_id: string }>(
    'payments',
    'payments',
    paymentRows,
    'id, external_id'
  );
  const feeByExternal = new Map(paymentRows.map(p => [p.external_id, feeFor(p.amount)]));
  await insertChunked(
    'payment_fees',
    'payment_fees',
    payments.map(p => ({
      payment_id: p.id,
      gross_fee: feeByExternal.get(p.external_id),
      net_fee: feeByExternal.get(p.external_id),
      base_fee_amount: feeByExternal.get(p.external_id),
      currency: 'GBP',
    })),
    'id'
  );

  // 6. Bank accounts and a few bank transactions.
  const banks = (await must(
    'bank_accounts',
    supabase
      .from('bank_accounts')
      .insert([
        {
          entity_id: entityId,
          source: 'revolut',
          external_account_id: 'e2e-bank-1',
          name: 'Revolut Business',
          currency: 'GBP',
          balance: OPENING_BALANCE,
          state: 'active',
          updated_at: daysAgo(400),
        },
        {
          entity_id: entityId,
          source: 'revolut',
          external_account_id: 'e2e-bank-2',
          name: 'Revolut Savings',
          currency: 'GBP',
          balance: 4580,
          state: 'active',
          updated_at: daysAgo(400),
        },
      ])
      .select('id, name')
  )) as { id: string; name: string }[];

  const txnTemplates = [
    {
      cp: 'Shopify Payments',
      desc: 'Shopify payout',
      type: 'payment',
      dir: 'in',
      lo: 300,
      hi: 2400,
    },
    { cp: 'PayPal', desc: 'PayPal withdrawal', type: 'payment', dir: 'in', lo: 200, hi: 900 },
    {
      cp: 'Porto Knitwear',
      desc: 'Production run',
      type: 'payment',
      dir: 'out',
      lo: 1500,
      hi: 6000,
    },
    { cp: 'Royal Mail', desc: 'Postage', type: 'payment', dir: 'out', lo: 60, hi: 400 },
    { cp: 'Meta Ads', desc: 'Ad spend', type: 'payment', dir: 'out', lo: 150, hi: 1500 },
    { cp: 'Shopify', desc: 'Monthly plan', type: 'fee', dir: 'out', lo: 79, hi: 79 },
  ] as const;
  const TXN_COUNT = 1100;
  const txnRows = Array.from({ length: TXN_COUNT }, (_, i) => {
    const t = txnTemplates[i % txnTemplates.length];
    const amount = money(between(t.lo, t.hi));
    return {
      entity_id: entityId,
      bank_account_id: banks[0].id,
      external_transaction_id: `e2e-txn-${i + 1}`,
      amount,
      base_amount: amount,
      currency_code: 'GBP',
      base_currency_code: 'GBP',
      occurred_at: daysAgo(Math.floor((i / TXN_COUNT) * 200) + 1, 14),
      description: t.desc,
      counterparty_name: t.cp,
      status: 'pending',
      transaction_type: t.type,
      source: 'revolut',
      direction: t.dir,
    };
  });
  await insertChunked('financial_transactions', 'financial_transactions', txnRows, 'id');

  // The dashboard derives each account's balance as its stored balance plus every transaction
  // after the snapshot. All seeded transactions are newer than the snapshot, so the expected
  // total is knowable here and tests can compare against it exactly.
  const snapshotTotal = OPENING_BALANCE + 4580;
  const expectedBankBalance = money(
    snapshotTotal +
      txnRows.reduce((sum, t) => sum + (t.direction === 'in' ? t.base_amount : -t.base_amount), 0)
  );

  // 6b. Inventory: 16 linked variants (2 per product) in every stock state, one unlinked
  //     sellable variant, one sample and one material. Every item has recorded sales, so the
  //     on_hand view is simply the sum of its movements (no product-level fallback).
  //
  //   index  on hand   note
  //     0      -3      oversold
  //     1       0      out of stock
  //     2       4      low
  //     3       9      low
  //    4-13    20-120  in stock (4 carries the bulk movements)
  //    14      70      in stock but no unit cost
  //    15       0      unlimited (not tracked); still has recorded purchases and sales
  const onHandTargets = [-3, 0, 4, 9, 40, 55, 80, 120, 30, 45, 64, 22, 90, 35, 70, 0];
  const giftedBy: Record<number, number> = { 7: 2 };
  const writtenOffBy: Record<number, number> = { 9: 3 };
  const itemSpecs = onHandTargets.map((onHand, i) => {
    const productIdx = Math.floor(i / SIZES.length);
    const size = SIZES[i % SIZES.length];
    const cost = i === 14 ? 0 : money(prices[productIdx] * 0.4);
    const sold = 5 + Math.floor(rand() * 35);
    const gifted = giftedBy[i] ?? 0;
    const writtenOff = writtenOffBy[i] ?? 0;
    const purchased = Math.max(0, onHand + sold + gifted + writtenOff);
    return { i, productIdx, size, cost, sold, gifted, writtenOff, purchased, onHand };
  });

  const itemRows: Record<string, unknown>[] = itemSpecs.map(spec => ({
    entity_id: entityId,
    product_id: products[spec.productIdx].id,
    provider: 'manual',
    quantity_source: 'ledger',
    variant_external_id: `e2e-var-${spec.productIdx + 1}-${spec.size}`,
    sku: `E2E-${spec.productIdx + 1}-${spec.size}`,
    unit_cost: spec.cost,
    is_unlimited: spec.i === 15,
    item_type: 'sellable',
    created_at: daysAgo(320),
  }));
  itemRows.push(
    {
      entity_id: entityId,
      product_id: null,
      provider: 'manual',
      quantity_source: 'ledger',
      variant_external_id: 'e2e-var-unlinked',
      sku: 'E2E-UNLINKED',
      unit_cost: 12,
      item_type: 'sellable',
      created_at: daysAgo(100),
    },
    {
      entity_id: entityId,
      product_id: null,
      provider: 'manual',
      quantity_source: 'ledger',
      variant_external_id: 'e2e-var-sample',
      sku: 'E2E-SAMPLE',
      unit_cost: 18,
      item_type: 'sample',
      created_at: daysAgo(100),
    },
    {
      entity_id: entityId,
      product_id: null,
      provider: 'manual',
      quantity_source: 'ledger',
      variant_external_id: 'e2e-var-material',
      sku: 'E2E-MATERIAL',
      unit_cost: 6,
      item_type: 'material',
      created_at: daysAgo(100),
    }
  );
  const inventoryItems = await insertChunked<{ id: string; sku: string }>(
    'inventory_items',
    'inventory_items',
    itemRows,
    'id, sku'
  );
  const itemIdBySku = new Map(inventoryItems.map(r => [r.sku, r.id]));

  const movementRows: Record<string, unknown>[] = [];
  const addMovement = (
    sku: string,
    type: 'PURCHASE' | 'SALE' | 'GIFT' | 'WRITE_OFF',
    quantity: number,
    unitCost: number,
    daysBack: number
  ) =>
    movementRows.push({
      inventory_item_id: itemIdBySku.get(sku),
      transaction_type: type,
      quantity,
      unit_cost: unitCost,
      movement_date: daysAgo(daysBack),
      movement_date_source: 'backdated',
      notes: `E2E ${type.toLowerCase()}`,
    });
  let investedTotal = 0;
  let unitsPurchasedTotal = 0;
  for (const spec of itemSpecs) {
    const sku = `E2E-${spec.productIdx + 1}-${spec.size}`;
    if (spec.purchased > 0) {
      const first = Math.ceil(spec.purchased / 2);
      addMovement(sku, 'PURCHASE', first, spec.cost, 300);
      if (spec.purchased - first > 0) {
        addMovement(sku, 'PURCHASE', spec.purchased - first, spec.cost, 150);
      }
      investedTotal += spec.purchased * spec.cost;
      unitsPurchasedTotal += spec.purchased;
    }
    if (spec.sold > 0) {
      const first = Math.ceil(spec.sold / 2);
      addMovement(sku, 'SALE', -first, spec.cost, 120);
      if (spec.sold - first > 0) addMovement(sku, 'SALE', -(spec.sold - first), spec.cost, 40);
    }
    if (spec.gifted > 0) addMovement(sku, 'GIFT', -spec.gifted, spec.cost, 30);
    if (spec.writtenOff > 0) addMovement(sku, 'WRITE_OFF', -spec.writtenOff, spec.cost, 20);
  }
  // Bulk: pairs of +1 / -1 on item 4 (net zero, so its on-hand is unchanged), spread over a year.
  const bulk = itemSpecs[4];
  const bulkSku = `E2E-${bulk.productIdx + 1}-${bulk.size}`;
  for (let n = 0; n < BULK_MOVEMENT_PAIRS; n++) {
    addMovement(bulkSku, 'PURCHASE', 1, bulk.cost, 200 + (n % 120));
    addMovement(bulkSku, 'SALE', -1, bulk.cost, 60 + (n % 120));
  }
  investedTotal += BULK_MOVEMENT_PAIRS * bulk.cost;
  unitsPurchasedTotal += BULK_MOVEMENT_PAIRS;
  // The sample and the material each have one purchase (outside the sellable headline numbers).
  addMovement('E2E-SAMPLE', 'PURCHASE', 3, 18, 90);
  addMovement('E2E-MATERIAL', 'PURCHASE', 40, 6, 90);
  investedTotal += 3 * 18 + 40 * 6;
  unitsPurchasedTotal += 43;
  await insertChunked('inventory_movements', 'inventory_movements', movementRows, 'id', 500);

  const sellableLinked = itemSpecs;
  const stockValue = money(
    sellableLinked.reduce((sum, s) => sum + Math.max(0, s.onHand) * s.cost, 0)
  );
  const inventory = {
    itemCount: itemRows.length,
    linkedSellableCount: sellableLinked.length,
    movementCount: movementRows.length,
    bulkItemSku: bulkSku,
    stockValue,
    unitsOnHand: sellableLinked.reduce((sum, s) => sum + Math.max(0, s.onHand), 0),
    oversold: onHandTargets.filter(n => n < 0).length,
    outOfStock: onHandTargets.filter((n, i) => n === 0 && i !== 15).length,
    low: onHandTargets.filter(n => n > 0 && n < 10).length,
    unlinked: 1,
    uncosted: 1,
    invested: money(investedTotal),
    unitsPurchased: unitsPurchasedTotal,
    oversoldSku: 'E2E-1-S',
    outSku: 'E2E-1-M',
    lowSku: 'E2E-2-S',
    healthySku: 'E2E-4-M',
    uncostedSku: 'E2E-8-S',
    unlimitedSku: 'E2E-8-M',
    unlinkedSku: 'E2E-UNLINKED',
    sampleSku: 'E2E-SAMPLE',
  };

  // 7. Manifest: what the tests may assert on.
  const manifest = {
    entityName: ENTITY_NAME,
    email,
    orderCount: ORDER_COUNT,
    customerCount: customers.length,
    productCount: products.length,
    bankAccountCount: banks.length,
    transactionCount: TXN_COUNT,
    expectedBankBalance,
    inventory,
    seededAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `Seeded ${ENTITY_NAME}: ${ORDER_COUNT} orders, ${customers.length} customers, ${TXN_COUNT} transactions.`
  );
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
