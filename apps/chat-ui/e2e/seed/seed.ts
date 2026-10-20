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
import { computePlanProjections } from '../../app/lib/collection-plans';
import { MANIFEST_FILE, assertLocalSupabase, loadTestEnv, requireEnv } from '../env';
import {
  ACCOUNTS,
  BANK_FEED_JOURNAL_COUNT,
  DRAFT_COUNT,
  FIXED_JOURNALS,
  bankFeedJournal,
  expectedBalanceSheet,
  expectedFigures,
  type Journalled,
  type LedgerJournal,
} from './ledger';

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
export const RIVAL_ENTITY_NAME = 'Rival Co (E2E)';
const SIZES = ['S', 'M'] as const;
/** [name, price, external id]: the first has one old sale, the other two never sold. */
const EXTRA_PRODUCTS = [
  ['Heritage Gilet', 150, 'e2e-prod-gilet'],
  ['Linen Apron', 48, 'e2e-prod-apron'],
  ['Waxed Cap', 34, 'e2e-prod-cap'],
] as const;
/**
 * Customers who are not ordinary regulars, so every customer segment has someone in it:
 * one order only, orders but none for 90+ days, and two who never ordered.
 */
const EXTRA_CUSTOMERS = [
  ['Zed', 'Onetime'],
  ['Nina', 'Lapsed'],
  ['Ola', 'Neverordered'],
  ['Pat', 'Neverordered'],
] as const;
/** Order number -> share of its total refunded. */
const REFUNDS: Record<number, number> = { 1010: 0.5, 1020: 0.5, 1030: 0.5 };
/** Transaction index -> the invoice number it pays. */
const MATCHED_PAYMENTS: Record<number, string> = { 2: 'INV-ML-0900', 8: 'INV-ML-1004' };
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

  // Three more products so every stage of "what sells" has one: one that sold only long ago
  // (a line on the oldest order, below) and two that never sold.
  const extraProducts = (await must(
    'extra products',
    supabase
      .from('products')
      .insert(
        EXTRA_PRODUCTS.map(([name, , external]) => ({
          entity_id: entityId,
          provider: 'shopify',
          external_id: external,
          name,
          product_type: 'apparel',
          status: 'active',
          created_at: daysAgo(330),
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
        [...first, ...EXTRA_CUSTOMERS.map(c => c[0])].map((f, i) => {
          const l = i < first.length ? last[i] : EXTRA_CUSTOMERS[i - first.length][1];
          return {
            entity_id: entityId,
            provider: 'shopify',
            external_id: `e2e-cust-${i + 1}`,
            email: `${f}.${l}@example.test`.toLowerCase(),
            first_name: f,
            last_name: l,
            created_at: daysAgo(320),
          };
        })
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
      customer: pick(customers.slice(0, first.length)),
      status: pick(statuses),
      age: Math.floor(((ORDER_COUNT - i) / ORDER_COUNT) * 300) + Math.floor(between(0, 4)),
      lines,
    };
  });
  // The one-time customer ordered once, recently; the lapsed one twice, months ago.
  const [zed, nina] = [customers[first.length], customers[first.length + 1]];
  Object.assign(plan[4], { customer: zed, status: 'delivered', age: 20 });
  Object.assign(plan[5], { customer: nina, status: 'delivered', age: 230 });
  Object.assign(plan[6], { customer: nina, status: 'delivered', age: 250 });

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
      refunded_total_amount: REFUNDS[o.n] ? money(grand * REFUNDS[o.n]) : 0,
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
  const oldestOrder = orderByExternal.get('e2e-order-1001')!;
  const gilet = extraProducts.find(p => p.name === 'Heritage Gilet')!;
  const giletLine = {
    order_id: oldestOrder.id,
    external_id: 'e2e-line-1001-gilet',
    product_id: gilet.id,
    product_name: gilet.name,
    quantity: 1,
    unit_price_amount: 150,
    total_price_amount: 150,
    created_at: oldestOrder.created_at,
  };
  await insertChunked('order_line_items', 'order_line_items', [...lineRows, giletLine], 'id');

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
      // Two payments already matched to invoices (the PayPal enrichment writes the invoice
      // number here). Both are outbound, so they pair with purchase invoices below.
      metadata: MATCHED_PAYMENTS[i] ? { invoice_id: MATCHED_PAYMENTS[i] } : {},
    };
  });
  const txnInserted = await insertChunked<{ id: string }>(
    'financial_transactions',
    'financial_transactions',
    txnRows,
    'id'
  );

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

  // 6c. Invoices: a chart of accounts, contacts, and invoices at every stage. Due dates are
  //     relative to the seed run, so "overdue" is true for as long as the data is fresh.
  //     Amounts are chosen so the headline numbers are easy to check by hand:
  //       owed to you  = 2,400 + 960 + 1,500 (part paid)   = 4,860 across 3 invoices
  //       you owe      = 180 + 3,600                       = 3,780 across 2 invoices
  //       overdue      = 960 + 1,500 (owed) and 180 (owe)  = 3 invoices
  //       to review    = 2 drafts; 1 open invoice is in EUR and left out of the sums
  const accounts = ACCOUNTS;
  const glRows = (await must(
    'chart_of_accounts',
    supabase
      .from('chart_of_accounts')
      .insert(
        accounts.map(([account_number, name, account_type, normal_balance]) => ({
          account_number,
          name,
          account_type,
          normal_balance,
          is_header: false,
          status: 'active',
        }))
      )
      .select('id, account_number')
  )) as { id: string; account_number: string }[];
  const gl = Object.fromEntries(glRows.map(r => [r.account_number, r.id]));

  const contactSpecs = [
    ['customer', 'Harbour & Co'],
    ['customer', 'Northgate Boutique'],
    ['customer', 'Oakley Studio'],
    ['supplier', 'Porto Knitwear'],
    ['supplier', 'Mill Lane Textiles'],
    ['supplier', 'ParcelPost Ltd'],
  ] as const;
  const contactRows = (await must(
    'contacts',
    supabase
      .from('contacts')
      .insert(
        contactSpecs.map(([contact_type, name]) => ({
          entity_id: entityId,
          contact_type,
          name,
          company_name: name,
          email: `accounts@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
        }))
      )
      .select('id, name')
  )) as { id: string; name: string }[];
  const contactId = Object.fromEntries(contactRows.map(c => [c.name, c.id]));

  // A real (tiny) PDF for the one invoice with a document, so "View document" has something to open.
  const { error: bucketError } = await supabase.storage.createBucket('invoices', { public: false });
  if (bucketError && !/already exists/i.test(bucketError.message)) {
    throw new Error(`createBucket: ${bucketError.message}`);
  }
  const pdf = new TextEncoder().encode(
    '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'
  );
  const documentPath = `${entityId}/e2e-invoice-ML-1001.pdf`;
  const { error: uploadError } = await supabase.storage
    .from('invoices')
    .upload(documentPath, pdf, { contentType: 'application/pdf', upsert: true });
  if (uploadError) throw new Error(`invoice document: ${uploadError.message}`);

  type InvLine = [description: string, qty: number, unit: number, vat: number, account?: string];
  interface SeedInvoice {
    number: string;
    type: 'SALE' | 'PURCHASE';
    status: string;
    contact: string;
    currency?: string;
    issued: number; // days ago
    due: number | null; // days from now (negative = in the past)
    lines: InvLine[];
    document?: boolean;
    notes?: string;
  }
  const invoiceSpecs: SeedInvoice[] = [
    {
      number: 'INV-ML-1001',
      type: 'PURCHASE',
      status: 'DRAFT',
      contact: 'Mill Lane Textiles',
      issued: 3,
      due: 27,
      document: true,
      lines: [
        ['Merino yarn 4-ply', 40, 20, 0.2, '1033'],
        ['Heavy knit swatches', 10, 15, 0.2, '1033'],
        ['Delivery', 1, 50, 0.2], // left uncoded on purpose
      ],
    },
    {
      number: 'INV-ML-0800',
      type: 'PURCHASE',
      status: 'DRAFT',
      contact: 'Mill Lane Textiles',
      issued: 480,
      due: -450,
      lines: [['Legacy cotton order', 10, 30, 0, '1033']],
    },
    {
      number: 'INV-OUT-2001',
      type: 'SALE',
      status: 'DRAFT',
      contact: 'Harbour & Co',
      issued: 2,
      due: 28,
      lines: [['Wholesale order: knitwear', 4, 100, 0.2, '4000']],
    },
    {
      number: 'INV-OUT-2002',
      type: 'SALE',
      status: 'OPEN',
      contact: 'Northgate Boutique',
      issued: 15,
      due: 45,
      lines: [['Wholesale order: autumn range', 20, 100, 0.2, '4000']],
    },
    {
      number: 'INV-OUT-2003',
      type: 'SALE',
      status: 'OPEN',
      contact: 'Harbour & Co',
      issued: 80,
      due: -40,
      lines: [['Wholesale order: summer range', 8, 100, 0.2, '4000']],
    },
    {
      number: 'INV-OUT-2004',
      type: 'SALE',
      status: 'PARTIALLY_PAID',
      contact: 'Oakley Studio',
      issued: 60,
      due: -5,
      lines: [['Custom commission', 1, 1250, 0.2, '4000']],
    },
    {
      number: 'INV-PP-3001',
      type: 'PURCHASE',
      status: 'OPEN',
      contact: 'ParcelPost Ltd',
      issued: 45,
      due: -15,
      lines: [['Courier charges: September', 1, 150, 0.2, '6300']],
    },
    {
      number: 'INV-ML-1004',
      type: 'PURCHASE',
      status: 'OPEN',
      contact: 'Mill Lane Textiles',
      issued: 10,
      due: 20,
      lines: [['Wool blend yarn', 150, 20, 0.2, '1033']],
    },
    {
      number: 'INV-PK-5001',
      type: 'PURCHASE',
      status: 'OPEN',
      contact: 'Porto Knitwear',
      currency: 'EUR',
      issued: 12,
      due: 30,
      lines: [['Production run: cardigans', 40, 50, 0, '1033']],
    },
    {
      number: 'INV-OUT-2000',
      type: 'SALE',
      status: 'PAID',
      contact: 'Northgate Boutique',
      issued: 120,
      due: -90,
      lines: [['Wholesale order: spring range', 8, 100, 0, '4000']],
    },
    {
      number: 'INV-ML-0900',
      type: 'PURCHASE',
      status: 'PAID',
      contact: 'Mill Lane Textiles',
      issued: 100,
      due: -70,
      lines: [['Cotton jersey', 50, 22, 0, '1033']],
    },
    {
      number: 'INV-PP-2999',
      type: 'PURCHASE',
      status: 'VOID',
      contact: 'ParcelPost Ltd',
      issued: 90,
      due: -60,
      lines: [['Duplicate courier charge', 1, 90, 0, '6300']],
    },
  ];
  // Enough small paid invoices to push the total past the API's 1,000-row cap.
  const BULK_INVOICES = 1020;
  for (let i = 1; i <= BULK_INVOICES; i++) {
    invoiceSpecs.push({
      number: `INV-BULK-${String(i).padStart(4, '0')}`,
      type: 'SALE',
      status: 'PAID',
      contact: 'Northgate Boutique',
      issued: 150 + (i % 100),
      due: -(120 + (i % 100)),
      lines: [['Small wholesale order', 1, 10, 0, '4000']],
    });
  }

  const totalsOf = (spec: SeedInvoice) => {
    const net = money(spec.lines.reduce((s, [, q, u]) => s + q * u, 0));
    const tax = money(spec.lines.reduce((s, [, q, u, v]) => s + q * u * v, 0));
    return { net, tax, gross: money(net + tax) };
  };
  const invoiceRows = invoiceSpecs.map(spec => {
    const t = totalsOf(spec);
    return {
      entity_id: entityId,
      invoice_number: spec.number,
      invoice_type: spec.type,
      status: spec.status,
      counterparty_id: contactId[spec.contact],
      currency: spec.currency ?? 'GBP',
      net_amount: t.net,
      tax_amount: t.tax,
      gross_amount: t.gross,
      fx_rate: 1,
      invoice_date: daysAgo(spec.issued),
      due_date: spec.due === null ? null : daysAgo(-spec.due),
      source: 'manual',
      file_path: spec.document ? documentPath : null,
      notes: spec.notes ?? null,
    };
  });
  const insertedInvoices = await insertChunked<{ id: string; invoice_number: string }>(
    'invoices',
    'invoices',
    invoiceRows,
    'id, invoice_number'
  );
  const invoiceId = new Map(insertedInvoices.map(r => [r.invoice_number, r.id]));
  const invoiceLineRows = invoiceSpecs.flatMap(spec =>
    spec.lines.map(([description, quantity, unit_cost, vat_rate, account]) => ({
      invoice_id: invoiceId.get(spec.number),
      description,
      quantity,
      unit_cost,
      vat_rate,
      tax_code: vat_rate > 0 ? 'STANDARD' : 'ZERO',
      gl_account_id: account ? gl[account] : null,
    }))
  );
  await insertChunked('invoice_line_items', 'invoice_line_items', invoiceLineRows, 'id');

  const base = invoiceSpecs.filter(s => !s.number.startsWith('INV-BULK'));
  const unpaid = (s: SeedInvoice) => ['OPEN', 'PARTIALLY_PAID'].includes(s.status);
  const late = (s: SeedInvoice) => unpaid(s) && s.due !== null && s.due < 0;
  const gbpUnpaid = base.filter(s => unpaid(s) && (s.currency ?? 'GBP') === 'GBP');
  const sum = (xs: SeedInvoice[]) => money(xs.reduce((n, s) => n + totalsOf(s).gross, 0));
  const invoices = {
    total: invoiceSpecs.length,
    owedToYou: sum(gbpUnpaid.filter(s => s.type === 'SALE')),
    owedToYouCount: gbpUnpaid.filter(s => s.type === 'SALE').length,
    youOwe: sum(gbpUnpaid.filter(s => s.type === 'PURCHASE')),
    youOweCount: gbpUnpaid.filter(s => s.type === 'PURCHASE').length,
    overdueOwedToYou: sum(gbpUnpaid.filter(s => s.type === 'SALE' && late(s))),
    overdueYouOwe: sum(gbpUnpaid.filter(s => s.type === 'PURCHASE' && late(s))),
    overdueCount: gbpUnpaid.filter(late).length,
    toReview: base.filter(s => s.status === 'DRAFT').length,
    otherCurrency: base.filter(s => unpaid(s) && (s.currency ?? 'GBP') !== 'GBP').length,
    openCount: base.filter(unpaid).length,
    paidCount: invoiceSpecs.filter(s => s.status === 'PAID').length,
    // Numbers of particular invoices, for tests that open them.
    draftPurchase: 'INV-ML-1001',
    draftSale: 'INV-OUT-2001',
    priorPeriodDraft: 'INV-ML-0800', // dated before the 2026 accounting cutoff
    openSale: 'INV-OUT-2002',
    overdueSale: 'INV-OUT-2003',
    overduePurchase: 'INV-PP-3001', // no matched payment
    matchedPurchase: 'INV-ML-1004', // a bank payment is matched to it
    paidMatched: 'INV-ML-0900',
    foreign: 'INV-PK-5001',
    voided: 'INV-PP-2999',
    bulkPrefix: 'INV-BULK-',
    counterparty: 'Mill Lane Textiles',
  };

  // 6d. What the Orders and Customers pages should show, by the same rules they use.
  const kept = (r: (typeof orderRows)[number]) =>
    (r.status as string) === 'cancelled'
      ? 0
      : money(r.grand_total_amount - Number(r.refunded_total_amount));
  const ordersByStatus: Record<string, number> = {};
  for (const r of orderRows) ordersByStatus[r.status] = (ordersByStatus[r.status] ?? 0) + 1;
  const refundedRows = orderRows.filter(r => Number(r.refunded_total_amount) > 0);
  const orderSummary = {
    total: orderRows.length,
    byStatus: ordersByStatus,
    toFulfil: orderRows.filter(r => ['pending', 'confirmed', 'processing'].includes(r.status))
      .length,
    shipped: ordersByStatus.shipped ?? 0,
    delivered: ordersByStatus.delivered ?? 0,
    sales: money(orderRows.reduce((sum, r) => sum + kept(r), 0)),
    refundedCount: refundedRows.length,
    refunded: money(refundedRows.reduce((sum, r) => sum + Number(r.refunded_total_amount), 0)),
    // An order that is refunded in part, and one with a known customer, for tests that open them.
    refundedOrderNumber: `#${Number(Object.keys(REFUNDS)[0])}`,
    sampleOrderNumber: '#1100',
  };
  const perCustomer = new Map<string, { orders: number; spent: number; last: number }>();
  plan.forEach((o, i) => {
    const row = orderRows[i];
    const entry = perCustomer.get(o.customer.id) ?? { orders: 0, spent: 0, last: Infinity };
    entry.orders += 1;
    entry.spent = money(entry.spent + kept(row));
    entry.last = Math.min(entry.last, o.age);
    perCustomer.set(o.customer.id, entry);
  });
  const nameOf = (c: (typeof customers)[number]) => {
    const i = customers.indexOf(c);
    return i < first.length
      ? `${first[i]} ${last[i]}`
      : `${EXTRA_CUSTOMERS[i - first.length][0]} ${EXTRA_CUSTOMERS[i - first.length][1]}`;
  };
  const stats = customers.map(c => ({
    name: nameOf(c),
    ...(perCustomer.get(c.id) ?? { orders: 0, spent: 0, last: Infinity }),
  }));
  const topSpender = [...stats].sort((a, b) => b.spent - a.spent)[0];
  const customerSummary = {
    total: customers.length,
    repeat: stats.filter(c => c.orders >= 2).length,
    oneTime: stats.filter(c => c.orders === 1).length,
    lapsed: stats.filter(c => c.orders > 0 && c.last > 90).length,
    never: stats.filter(c => c.orders === 0).length,
    spentTotal: money(stats.reduce((sum, c) => sum + c.spent, 0)),
    topSpender: topSpender.name,
    topSpenderOrders: topSpender.orders,
    topSpenderSpent: topSpender.spent,
    oneTimeName: 'Zed Onetime',
    lapsedName: 'Nina Lapsed',
    neverName: 'Ola Neverordered',
  };

  // 6e. What the Products page should show: line-item revenue for orders that were not cancelled.
  const productStats = new Map<
    string,
    { units: number; revenue: number; orders: Set<number>; youngest: number }
  >();
  const addSale = (name: string, units: number, revenue: number, order: number, age: number) => {
    const e = productStats.get(name) ?? {
      units: 0,
      revenue: 0,
      orders: new Set<number>(),
      youngest: Infinity,
    };
    e.units += units;
    e.revenue = money(e.revenue + revenue);
    e.orders.add(order);
    e.youngest = Math.min(e.youngest, age);
    productStats.set(name, e);
  };
  for (const o of plan) {
    if ((o.status as string) === 'cancelled') continue;
    for (const l of o.lines) {
      addSale(products[l.productIdx].name, l.qty, prices[l.productIdx] * l.qty, o.n, o.age);
    }
  }
  addSale('Heritage Gilet', 1, 150, plan[0].n, plan[0].age);
  const ranked = [...productStats.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  const productSummary = {
    total: products.length + extraProducts.length,
    selling: [...productStats.values()].filter(e => e.youngest <= 90).length,
    slowing: [...productStats.values()].filter(e => e.youngest > 90).length,
    never: EXTRA_PRODUCTS.length - 1,
    units: [...productStats.values()].reduce((sum, e) => sum + e.units, 0),
    revenue: money([...productStats.values()].reduce((sum, e) => sum + e.revenue, 0)),
    topName: ranked[0][0],
    topRevenue: ranked[0][1].revenue,
    topUnits: ranked[0][1].units,
    topOrders: ranked[0][1].orders.size,
    slowingName: 'Heritage Gilet',
    neverNames: ['Linen Apron', 'Waxed Cap'],
  };

  // 6f. A second business with a user of its own, to prove the first cannot see it. Every kind of
  //     row the dashboard and Inventory read exists for it, so a query that forgets to filter by
  //     business (or a table without a row-level policy) shows up as extra numbers in the first
  //     business's pages.
  const rivalEmail = `rival.${email}`;
  const { data: rivalUser, error: rivalUserError } = await supabase.auth.admin.createUser({
    email: rivalEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Rival Tester' },
  });
  if (rivalUserError || !rivalUser.user) throw new Error(`rival user: ${rivalUserError?.message}`);
  const rivalEntity = (await must(
    'rival entity',
    supabase
      .from('entities')
      .insert({
        name: RIVAL_ENTITY_NAME,
        legal_name: 'Rival Co Ltd',
        country: 'GB',
        currency: 'GBP',
        industry: 'Fashion',
        onboarding_completed: true,
        owner_user_id: rivalUser.user.id,
        year_end_day: 31,
        year_end_month: 3,
      })
      .select('id')
      .single()
  )) as { id: string };
  const rid = rivalEntity.id;
  const rivalCustomers = (await must(
    'rival customers',
    supabase
      .from('customers')
      .insert(
        ['Rhea', 'Rory'].map((f, i) => ({
          entity_id: rid,
          provider: 'shopify',
          external_id: `rival-cust-${i + 1}`,
          email: `${f}.rival@example.test`.toLowerCase(),
          first_name: f,
          last_name: 'Rival',
          created_at: daysAgo(100),
        }))
      )
      .select('id')
  )) as { id: string }[];
  const rivalProduct = (await must(
    'rival product',
    supabase
      .from('products')
      .insert({
        entity_id: rid,
        provider: 'shopify',
        external_id: 'rival-prod-1',
        name: 'Rival Parka',
        product_type: 'apparel',
        status: 'active',
        created_at: daysAgo(100),
      })
      .select('id')
      .single()
  )) as { id: string };
  const rivalOrders = (await must(
    'rival orders',
    supabase
      .from('orders')
      .insert(
        [100, 200, 300].map((total, i) => ({
          entity_id: rid,
          customer_id: rivalCustomers[i % 2].id,
          provider: 'shopify',
          external_id: `rival-order-${i + 1}`,
          order_number: `#R${i + 1}`,
          status: 'delivered',
          fulfillment_status: 'fulfilled',
          customer_email: 'rhea.rival@example.test',
          subtotal_amount: total,
          grand_total_amount: total,
          refunded_total_amount: 0,
          currency: 'GBP',
          created_at: daysAgo(10 + i),
        }))
      )
      .select('id, grand_total_amount')
  )) as { id: string; grand_total_amount: number }[];
  await must(
    'rival order lines',
    supabase.from('order_line_items').insert(
      rivalOrders.map((o, i) => ({
        order_id: o.id,
        external_id: `rival-line-${i + 1}`,
        product_id: rivalProduct.id,
        product_name: 'Rival Parka',
        quantity: 1,
        unit_price_amount: o.grand_total_amount,
        total_price_amount: o.grand_total_amount,
        created_at: daysAgo(10 + i),
      }))
    )
  );
  const rivalBank = (await must(
    'rival bank',
    supabase
      .from('bank_accounts')
      .insert({
        entity_id: rid,
        source: 'revolut',
        external_account_id: 'rival-bank-1',
        name: 'Rival Current',
        currency: 'GBP',
        balance: 9_000,
        state: 'active',
        updated_at: daysAgo(400),
      })
      .select('id')
      .single()
  )) as { id: string };
  await must(
    'rival transactions',
    supabase.from('financial_transactions').insert(
      [250, 125].map((amount, i) => ({
        entity_id: rid,
        bank_account_id: rivalBank.id,
        external_transaction_id: `rival-txn-${i + 1}`,
        amount,
        base_amount: amount,
        currency_code: 'GBP',
        base_currency_code: 'GBP',
        occurred_at: daysAgo(5 + i),
        description: 'Rival income',
        counterparty_name: 'Rival customer',
        status: 'pending',
        transaction_type: 'payment',
        source: 'revolut',
        direction: 'in',
      }))
    )
  );
  const rivalItem = (await must(
    'rival inventory item',
    supabase
      .from('inventory_items')
      .insert({
        entity_id: rid,
        product_id: rivalProduct.id,
        provider: 'manual',
        quantity_source: 'ledger',
        variant_external_id: 'rival-var-1',
        sku: 'RIVAL-SKU-1',
        unit_cost: 40,
        item_type: 'sellable',
        created_at: daysAgo(100),
      })
      .select('id')
      .single()
  )) as { id: string };
  await must(
    'rival movements',
    supabase.from('inventory_movements').insert([
      {
        inventory_item_id: rivalItem.id,
        transaction_type: 'PURCHASE',
        quantity: 10,
        unit_cost: 40,
        movement_date: daysAgo(90),
        movement_date_source: 'backdated',
      },
      {
        inventory_item_id: rivalItem.id,
        transaction_type: 'SALE',
        quantity: -2,
        unit_cost: 40,
        movement_date: daysAgo(30),
        movement_date_source: 'backdated',
      },
    ])
  );
  const rivalContact = (await must(
    'rival contact',
    supabase
      .from('contacts')
      .insert({
        entity_id: rid,
        contact_type: 'customer',
        name: 'Rival Buyer Ltd',
        company_name: 'Rival Buyer Ltd',
      })
      .select('id')
      .single()
  )) as { id: string };
  await must(
    'rival invoice',
    supabase.from('invoices').insert({
      entity_id: rid,
      invoice_number: 'RIVAL-INV-1',
      invoice_type: 'SALE',
      status: 'OPEN',
      counterparty_id: rivalContact.id,
      currency: 'GBP',
      net_amount: 500,
      tax_amount: 100,
      gross_amount: 600,
      invoice_date: daysAgo(20),
      due_date: daysAgo(-10),
      source: 'manual',
    })
  );
  const rival = {
    email: rivalEmail,
    entityName: RIVAL_ENTITY_NAME,
    orderNumbers: ['#R1', '#R2', '#R3'],
    orderTotal: 600,
    customerNames: ['Rhea Rival', 'Rory Rival'],
    productName: 'Rival Parka',
    inventorySku: 'RIVAL-SKU-1',
    invoiceNumber: 'RIVAL-INV-1',
    bankName: 'Rival Current',
    bankBalance: 9_375,
  };

  // 6g. The books: accounting periods, tax rates and journals (see ledger.ts for the figures).
  const now = new Date();
  const fyYear = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const periodDates = {
    previous: { start: Date.UTC(fyYear - 1, 3, 1), end: Date.UTC(fyYear, 2, 31) },
    current: { start: Date.UTC(fyYear, 3, 1), end: Date.UTC(fyYear + 1, 2, 31) },
  };
  const yesterday = now.getTime() - 86_400_000;
  const periodLabel = (end: number) => `Year to 31 March ${new Date(end).getUTCFullYear()}`;
  await must(
    'accounting_periods',
    supabase.from('accounting_periods').insert(
      (['previous', 'current'] as const).map(which => ({
        entity_id: entityId,
        start_date: iso(periodDates[which].start),
        end_date: iso(periodDates[which].end),
        label: periodLabel(periodDates[which].end),
        status: which === 'previous' ? 'closed' : 'open',
        ledger_basis: true,
      }))
    )
  );
  await must(
    'corporation_tax_rates',
    supabase.from('corporation_tax_rates').insert(
      [fyYear - 1, fyYear].map(year => ({
        financial_year: year,
        starts_on: iso(Date.UTC(year, 3, 1)),
        ends_on: iso(Date.UTC(year + 1, 2, 31)),
        small_profits_rate: 0.19,
        main_rate: 0.25,
        lower_limit: 50000,
        upper_limit: 250000,
        marginal_relief_fraction: 0.015,
      }))
    )
  );

  const journals: LedgerJournal[] = [
    ...FIXED_JOURNALS,
    ...Array.from({ length: BANK_FEED_JOURNAL_COUNT }, (_, i) =>
      bankFeedJournal(i, txnRows[i] as never)
    ),
    // Drafts the automation could not categorise: one line on 8090 (uncategorised), one on cash.
    ...Array.from({ length: DRAFT_COUNT }, (_, i): LedgerJournal => {
      const index = BANK_FEED_JOURNAL_COUNT + 2 + i;
      const amount = Number(txnRows[index].amount);
      return {
        key: `d${i + 1}`,
        period: 'current',
        offsetDays: 0,
        type: 'expense',
        status: 'draft',
        description: String(txnRows[index].description),
        sourceType: 'financial_transaction',
        txnIndex: index,
        lines: [
          { account: '8090', debit: amount },
          { account: '1010', credit: amount },
        ],
      };
    }),
  ];
  const dated: Journalled[] = journals.map(journal => {
    let ms: number;
    if (journal.txnIndex !== undefined) {
      ms = new Date(String(txnRows[journal.txnIndex].occurred_at)).getTime();
    } else {
      ms = Math.min(periodDates[journal.period].start + journal.offsetDays * 86_400_000, yesterday);
    }
    return { journal, date: iso(ms) };
  });
  const journalRows = dated.map(({ journal, date }) => ({
    entity_id: entityId,
    journal_date: `${date}T12:00:00Z`,
    journal_type: journal.type,
    description: journal.description,
    source_type: journal.sourceType,
    source_id: journal.txnIndex !== undefined ? txnInserted[journal.txnIndex].id : null,
    status: journal.status,
    posted_at: journal.status === 'draft' ? null : `${date}T12:00:00Z`,
    metadata: journal.status === 'draft' ? { reason: 'uncategorised' } : {},
  }));
  const insertedJournals = await insertChunked<{ id: string }>(
    'journals',
    'journals',
    journalRows,
    'id'
  );
  await insertChunked(
    'journal_line_items',
    'journal_line_items',
    dated.flatMap(({ journal, date }, i) =>
      journal.lines.map(l => ({
        journal_id: insertedJournals[i].id,
        account_id: gl[l.account],
        debit: l.debit ?? 0,
        credit: l.credit ?? 0,
        currency: 'GBP',
        description: journal.description,
        effective_date: `${date}T12:00:00Z`,
      }))
    ),
    'id'
  );

  const accountType = Object.fromEntries(ACCOUNTS.map(a => [a[0], a[2]]));
  const range = (which: 'previous' | 'current') => ({
    from: iso(periodDates[which].start),
    to: iso(periodDates[which].end),
  });
  const countOf = (pred: (j: LedgerJournal) => boolean) => journals.filter(pred).length;
  const ledger = {
    currentLabel: periodLabel(periodDates.current.end),
    previousLabel: periodLabel(periodDates.previous.end),
    currentFrom: range('current').from,
    currentTo: range('current').to,
    previousFrom: range('previous').from,
    previousTo: range('previous').to,
    current: expectedFigures(dated, accountType, range('current')),
    previous: expectedFigures(dated, accountType, range('previous')),
    all: expectedFigures(dated, accountType, {}),
    balanceSheet: expectedBalanceSheet(dated, accountType),
    journalCount: journals.length,
    posted: countOf(j => j.status === 'posted'),
    drafts: countOf(j => j.status === 'draft'),
    reversed: countOf(j => j.status === 'reversed'),
    manual: countOf(j => j.sourceType === 'manual'),
    bankFeedJournals: BANK_FEED_JOURNAL_COUNT,
    draftDescriptions: journals.filter(j => j.status === 'draft').map(j => j.description),
    reversedDescription: 'Posted in error, reversed',
    manualDescription: 'Reclassify marketing to materials',
    tax: {
      // Profit of the closed year, taxed at the small-profits rate (it is under the lower limit).
      previousProfit: expectedFigures(dated, accountType, range('previous')).profit,
      previousTax: money(expectedFigures(dated, accountType, range('previous')).profit * 0.19),
    },
  };

  // 6h. Collections: three for the business (one with sales, linked costs and a co-branded
  // plan; one planned and empty; one finished) and one for the rival, which must stay unseen.
  const day = (n: number) => daysAgo(n).slice(0, 10);
  const collectionRows = (await must(
    'collections',
    supabase
      .from('collections')
      .insert([
        {
          entity_id: entityId,
          name: 'Autumn Layers',
          slug: 'autumn-layers',
          status: 'active',
          collection_type: 'Seasonal',
          launch_date: day(120),
          planned_budget_amount: 8000,
          budget_currency: 'GBP',
          external_ref: 'AL-26',
        },
        {
          entity_id: entityId,
          name: 'Winter Capsule',
          slug: 'winter-capsule',
          status: 'planned',
          collection_type: 'Capsule',
          budget_currency: 'GBP',
        },
        {
          entity_id: entityId,
          name: 'Summer Linens',
          slug: 'summer-linens',
          status: 'completed',
          collection_type: 'Seasonal',
          launch_date: day(260),
          budget_currency: 'GBP',
        },
        {
          entity_id: rid,
          name: 'Rival Drop',
          slug: 'rival-drop',
          status: 'active',
          collection_type: 'Seasonal',
          budget_currency: 'GBP',
        },
      ])
      .select('id, name')
  )) as { id: string; name: string }[];
  const colId = (name: string) => collectionRows.find(c => c.name === name)!.id;
  const AUTUMN = [0, 1, 4]; // Cardigan, Overshirt, Merino Scarf
  const SUMMER = [3, 6]; // Linen Camp Shirt, Canvas Tote
  await must(
    'collection_products',
    supabase.from('collection_products').insert([
      ...AUTUMN.map((idx, i) => ({
        collection_id: colId('Autumn Layers'),
        product_id: products[idx].id,
        display_order: i + 1,
        inclusion_reason: i === 0 ? 'The hero piece' : null,
      })),
      ...SUMMER.map(idx => ({
        collection_id: colId('Summer Linens'),
        product_id: products[idx].id,
      })),
      { collection_id: colId('Rival Drop'), product_id: rivalProduct.id },
    ])
  );
  // Costs: the production run, postage and ad spend among the first transactions.
  const costTxns = [2, 3, 4];
  const costTypes = ['manufacturing', 'shipping', 'marketing'];
  await must(
    'collection_costs',
    supabase.from('collection_costs').insert(
      costTxns.map((t, i) => ({
        entity_id: entityId,
        collection_id: colId('Autumn Layers'),
        financial_transaction_id: txnInserted[t].id,
        cost_type: costTypes[i],
        notes: `Linked for the seed: ${txnTemplates[t % txnTemplates.length].desc}`,
      }))
    )
  );
  const autumnCost = money(costTxns.reduce((s, t) => s + Number(txnRows[t].base_amount), 0));

  // What the sales rule (a product's own lines; cancelled orders excluded) gives, worked out here.
  const salesOf = (idxs: number[]) => {
    const set = new Set(idxs);
    let units = 0;
    let revenue = 0;
    let orderCount = 0;
    for (const o of plan) {
      const hit = o.lines.filter(l => set.has(l.productIdx));
      if (hit.length === 0) continue;
      orderCount += 1;
      for (const l of hit) {
        units += l.qty;
        revenue += prices[l.productIdx] * l.qty;
      }
    }
    return { units, revenue: money(revenue), orders: orderCount };
  };
  const autumnSales = salesOf(AUTUMN);
  const summerSales = salesOf(SUMMER);

  // A co-branded plan with two lines, a firm and an estimated cost, and two still to be decided.
  const planMetadata = {
    revenue_split_pct: 60,
    cost_split_pct: 60,
    costs_paid_upfront: true,
    custom_terms: [{ label: 'Exclusivity', value: 'UK only' }],
  };
  const planRow = (await must(
    'collection_plans',
    supabase
      .from('collection_plans')
      .insert({
        collection_id: colId('Autumn Layers'),
        entity_id: entityId,
        collaboration_type: 'co_branded',
        partner_name: 'Maison Test',
        currency: 'GBP',
        notes: 'Seeded plan',
        metadata: planMetadata,
      })
      .select('id')
      .single()
  )) as { id: string };
  const planLines = [
    {
      product: 0,
      qty: 100,
      gifted: 10,
      cost: 40,
      price: 98,
      sell: 80,
      sizes: [
        { size: 'S', quantity: 30 },
        { size: 'M', quantity: 40 },
        { size: 'L', quantity: 30 },
      ],
    },
    { product: 1, qty: 60, gifted: 0, cost: 55, price: 124, sell: 70, sizes: null },
  ];
  await must(
    'collection_plan_lines',
    supabase.from('collection_plan_lines').insert(
      planLines.map((l, i) => ({
        plan_id: planRow.id,
        product_id: products[l.product].id,
        planned_quantity: l.qty,
        size_quantities: l.sizes,
        gifted_units: l.gifted,
        unit_cost: l.cost,
        unit_selling_price: l.price,
        expected_sell_through_pct: l.sell,
        display_order: i + 1,
      }))
    )
  );
  const planCosts = [
    { category: 'freight_in', amount: null, estimated: false },
    { category: 'outbound_shipping', amount: null, estimated: false },
    { category: 'marketing', amount: 1500, estimated: true },
    { category: 'packaging', amount: 600, estimated: false },
  ];
  await must(
    'collection_plan_costs',
    supabase.from('collection_plan_costs').insert(
      planCosts.map(c => ({
        plan_id: planRow.id,
        cost_category: c.category,
        planned_amount: c.amount,
        is_estimated: c.estimated,
      }))
    )
  );
  const projections = computePlanProjections(
    'co_branded',
    ENTITY_NAME,
    'Maison Test',
    planMetadata,
    planLines.map((l, i) => ({
      id: String(i),
      planId: planRow.id,
      productId: products[l.product].id,
      productName: null,
      linkedProductName: null,
      plannedQuantity: l.qty,
      sizeQuantities: l.sizes ?? [],
      giftedUnits: l.gifted,
      unitCost: l.cost,
      unitSellingPrice: l.price,
      expectedSellThroughPct: l.sell,
      notes: null,
      displayOrder: i + 1,
      unitCostCurrency: null,
      unitCostOriginal: null,
    })),
    planCosts.map((c, i) => ({
      id: String(i),
      planId: planRow.id,
      costCategory: c.category,
      description: null,
      plannedAmount: c.amount,
      isEstimated: c.estimated,
      notes: null,
    }))
  );
  const collections = {
    count: 3,
    active: 1,
    autumn: {
      name: 'Autumn Layers',
      id: colId('Autumn Layers'),
      productNames: AUTUMN.map(i => productNames[i]),
      ...autumnSales,
      cost: autumnCost,
      costCount: costTxns.length,
    },
    winter: { name: 'Winter Capsule', id: colId('Winter Capsule') },
    summer: { name: 'Summer Linens', id: colId('Summer Linens'), ...summerSales },
    totalRevenue: money(autumnSales.revenue + summerSales.revenue),
    totalCost: autumnCost,
    plan: {
      partner: 'Maison Test',
      revenue: Math.round(projections.projectedRevenue),
      netProfit: Math.round(projections.projectedNetProfit),
      partnerDue: Math.round(projections.partnerPaymentDue?.amount ?? 0),
      pending: projections.costsPendingCount,
      estimated: projections.costsEstimatedCount,
      lineCount: planLines.length,
      costCount: planCosts.length,
      // The one line the seed splits by size, as the plan shows it.
      sizedLine: {
        productName: products[0].name,
        quantity: planLines[0].qty,
        sizes: ['S 30', 'M 40', 'L 30'],
        suggested: ['S', 'M'],
      },
    },
    rivalName: 'Rival Drop',
    rivalId: colId('Rival Drop'),
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
    invoices,
    orders: orderSummary,
    customerStats: customerSummary,
    products: productSummary,
    rival,
    ledger,
    collections,
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
