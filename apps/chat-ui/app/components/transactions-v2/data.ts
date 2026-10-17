/**
 * Mock data + helpers for the Transactions v2 preview.
 * Shapes follow app/lib/api/transactions.ts; the journal is derived from each
 * transaction (as the real one is, on the other side of the posting) so edits
 * made in the preview stay consistent.
 */

export type Source = 'revolut' | 'paypal';
export type Direction = 'in' | 'out';
export type TxnType =
  'payment' | 'transfer' | 'expense' | 'fee' | 'fx_conversion' | 'refund' | 'funding' | 'payout';
export type Filing = 'pending' | 'journalled' | 'excluded';

export interface Txn {
  id: string;
  source: Source;
  reference: string;
  /** In the transaction's own currency (always positive; direction carries the sign). */
  amount: number;
  currency: string;
  /** GBP equivalent. */
  baseAmount: number;
  fxRate: number | null;
  direction: Direction;
  type: TxnType;
  occurredAt: string;
  description: string;
  counterparty: string;
  accountCode: string;
  excludedReason: string | null;
  journalisedAt: string | null;
}

export const ACCOUNTS = [
  { code: '1000', name: 'Business current account' },
  { code: '1100', name: 'Stripe & PayPal receivable' },
  { code: '1900', name: 'Transfers clearing' },
  { code: '2100', name: 'VAT liability' },
  { code: '3300', name: "Director's loan" },
  { code: '4000', name: 'Online sales' },
  { code: '5000', name: 'Product cost' },
  { code: '5010', name: 'Inbound freight' },
  { code: '6000', name: 'Shipping & fulfilment' },
  { code: '6100', name: 'Payment processing' },
  { code: '6200', name: 'Marketing' },
  { code: '6300', name: 'Software & tools' },
  { code: '6400', name: 'Studio & rent' },
  { code: '6500', name: 'Professional fees' },
];
export const accountName = (code: string) => ACCOUNTS.find(a => a.code === code)?.name ?? code;

export const TYPE_LABEL: Record<TxnType, string> = {
  payment: 'Payment',
  transfer: 'Transfer',
  expense: 'Expense',
  fee: 'Fee',
  fx_conversion: 'FX conversion',
  refund: 'Refund',
  funding: 'Funding',
  payout: 'Payout',
};

export const filingOf = (t: Txn): Filing =>
  t.excludedReason ? 'excluded' : t.journalisedAt ? 'journalled' : 'pending';

/* ── Journal (derived) ───────────────────────────────── */

export interface JournalLine {
  account: string;
  debit: number;
  credit: number;
}

/** Double entry against the bank: money out debits the account, money in credits it. */
export function journalFor(t: Txn): JournalLine[] | null {
  if (!t.journalisedAt || t.excludedReason) return null;
  const bank = { account: `1000 · ${accountName('1000')}` };
  const other = `${t.accountCode} · ${accountName(t.accountCode)}`;
  return t.direction === 'out'
    ? [
        { account: other, debit: t.baseAmount, credit: 0 },
        { ...bank, debit: 0, credit: t.baseAmount },
      ]
    : [
        { ...bank, debit: t.baseAmount, credit: 0 },
        { account: other, debit: 0, credit: t.baseAmount },
      ];
}

/* ── Seeded generation ───────────────────────────────── */

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Template {
  dir: Direction;
  src: Source;
  type: TxnType;
  cp: string;
  desc: string;
  acct: string;
  min: number;
  max: number;
  w: number;
  cur?: string;
  fx?: number;
  excluded?: string;
}
const T: Template[] = [
  {
    dir: 'in',
    src: 'revolut',
    type: 'payout',
    cp: 'Shopify Payments',
    desc: 'Shopify payout',
    acct: '4000',
    min: 120,
    max: 2400,
    w: 14,
  },
  {
    dir: 'in',
    src: 'paypal',
    type: 'payment',
    cp: 'PayPal sale',
    desc: 'Customer payment',
    acct: '4000',
    min: 28,
    max: 260,
    w: 22,
  },
  {
    dir: 'in',
    src: 'revolut',
    type: 'payout',
    cp: 'Klarna',
    desc: 'Klarna settlement',
    acct: '4000',
    min: 90,
    max: 900,
    w: 4,
  },
  {
    dir: 'in',
    src: 'revolut',
    type: 'payout',
    cp: 'PayPal',
    desc: 'PayPal withdrawal',
    acct: '1100',
    min: 200,
    max: 1400,
    w: 3,
  },
  {
    dir: 'in',
    src: 'revolut',
    type: 'funding',
    cp: 'Director',
    desc: 'Director loan top-up',
    acct: '3300',
    min: 1000,
    max: 5000,
    w: 1,
  },
  {
    dir: 'in',
    src: 'revolut',
    type: 'refund',
    cp: 'Porto Knitwear',
    desc: 'Supplier credit note',
    acct: '5000',
    min: 80,
    max: 400,
    w: 1,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'payment',
    cp: 'Porto Knitwear',
    desc: 'Production run',
    acct: '5000',
    min: 1800,
    max: 7800,
    w: 2,
    cur: 'EUR',
    fx: 0.86,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'payment',
    cp: 'Mill & Loom Ltd',
    desc: 'Fabric order',
    acct: '5000',
    min: 900,
    max: 4400,
    w: 2,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'DHL Express',
    desc: 'Freight in',
    acct: '5010',
    min: 180,
    max: 900,
    w: 3,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'Royal Mail',
    desc: 'Postage',
    acct: '6000',
    min: 60,
    max: 420,
    w: 8,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'Meta Ads',
    desc: 'Ad spend',
    acct: '6200',
    min: 150,
    max: 1800,
    w: 6,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'Google Ads',
    desc: 'Ad spend',
    acct: '6200',
    min: 90,
    max: 700,
    w: 3,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'fee',
    cp: 'Shopify',
    desc: 'Monthly plan',
    acct: '6300',
    min: 79,
    max: 79,
    w: 1,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'Adobe',
    desc: 'Creative Cloud',
    acct: '6300',
    min: 69,
    max: 69,
    w: 1,
    cur: 'USD',
    fx: 0.78,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'Studio rent',
    desc: 'Monthly rent',
    acct: '6400',
    min: 1450,
    max: 1450,
    w: 1,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'Hartley & Co',
    desc: 'Accountancy',
    acct: '6500',
    min: 300,
    max: 600,
    w: 1,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'payment',
    cp: 'HMRC',
    desc: 'VAT payment',
    acct: '2100',
    min: 2000,
    max: 9000,
    w: 1,
  },
  {
    dir: 'out',
    src: 'paypal',
    type: 'fee',
    cp: 'PayPal',
    desc: 'Transaction fees',
    acct: '6100',
    min: 6,
    max: 40,
    w: 8,
  },
  {
    dir: 'out',
    src: 'paypal',
    type: 'refund',
    cp: 'Customer refund',
    desc: 'Refund for order',
    acct: '4000',
    min: 28,
    max: 180,
    w: 4,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'transfer',
    cp: 'Revolut Savings',
    desc: 'Internal transfer',
    acct: '1900',
    min: 500,
    max: 3000,
    w: 2,
    excluded: 'Internal transfer',
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'fx_conversion',
    cp: 'Revolut FX',
    desc: 'GBP to EUR',
    acct: '1900',
    min: 1000,
    max: 4000,
    w: 1,
  },
];

const NOW = new Date(2026, 9, 11, 18, 0);
const SPAN_DAYS = 190;

function build(): Txn[] {
  const r = rng(20261011);
  const total = T.reduce((a, t) => a + t.w, 0);
  const out: Txn[] = [];
  for (let i = 0; i < 150; i++) {
    let pick = r() * total;
    const t = T.find(x => (pick -= x.w) < 0) ?? T[0];
    const days = Math.floor(Math.pow(r(), 1.15) * SPAN_DAYS);
    const date = new Date(NOW.getTime() - days * 86_400_000 - Math.floor(r() * 12) * 3_600_000);
    const amount = Math.round((t.min + r() * (t.max - t.min)) * 100) / 100;
    const fx = t.fx ?? null;
    const recent = days < 21;
    const pending = !t.excluded && ((recent && r() < 0.55) || r() < 0.03);
    const desc =
      t.type === 'refund' && t.cp === 'Customer refund'
        ? `Refund for order #${4600 + Math.floor(r() * 240)}`
        : t.desc;
    out.push({
      id: `tx${String(i).padStart(3, '0')}`,
      source: t.src,
      reference: `${t.src === 'revolut' ? 'rvt' : 'pp'}_${Math.floor(r() * 1e9).toString(36)}${i}`,
      amount,
      currency: t.cur ?? 'GBP',
      baseAmount: Math.round(amount * (fx ?? 1) * 100) / 100,
      fxRate: fx,
      direction: t.dir,
      type: t.type,
      occurredAt: date.toISOString(),
      description: desc,
      counterparty: t.cp,
      accountCode: t.acct,
      excludedReason: t.excluded ?? null,
      journalisedAt:
        t.excluded || pending ? null : new Date(date.getTime() + 86_400_000).toISOString(),
    });
  }
  return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export const SEED_TXNS: Txn[] = build();

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const signed = (t: Txn) => (t.direction === 'in' ? t.baseAmount : -t.baseAmount);
