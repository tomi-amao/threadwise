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

  // 3. Products. Variants stay empty here; the Inventory page work will extend this.
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
  const ORDER_COUNT = 60;
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
  const orders = (await must(
    'orders',
    supabase
      .from('orders')
      .insert(orderRows)
      .select('id, external_id, grand_total_amount, created_at')
  )) as { id: string; external_id: string; grand_total_amount: number; created_at: string }[];
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
  await must('order_line_items', supabase.from('order_line_items').insert(lineRows).select('id'));

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
  const payments = (await must(
    'payments',
    supabase.from('payments').insert(paymentRows).select('id, external_id')
  )) as { id: string; external_id: string }[];
  const feeByExternal = new Map(paymentRows.map(p => [p.external_id, feeFor(p.amount)]));
  await must(
    'payment_fees',
    supabase
      .from('payment_fees')
      .insert(
        payments.map(p => ({
          payment_id: p.id,
          gross_fee: feeByExternal.get(p.external_id),
          net_fee: feeByExternal.get(p.external_id),
          base_fee_amount: feeByExternal.get(p.external_id),
          currency: 'GBP',
        }))
      )
      .select('id')
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
          balance: 41236.52,
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
  const TXN_COUNT = 36;
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
  await must(
    'financial_transactions',
    supabase.from('financial_transactions').insert(txnRows).select('id')
  );

  // 7. Manifest: what the tests may assert on.
  const manifest = {
    entityName: ENTITY_NAME,
    email,
    orderCount: ORDER_COUNT,
    customerCount: customers.length,
    productCount: products.length,
    bankAccountCount: banks.length,
    transactionCount: TXN_COUNT,
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
