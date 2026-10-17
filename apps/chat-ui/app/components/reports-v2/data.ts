/**
 * Mock data + derivations for the Reports v2 preview.
 * Frontend only. Every statement is derived from one set of monthly rows, so
 * the period switch changes all four tabs consistently and the numbers tie.
 */

export interface MonthRow {
  key: string;
  label: string;
  /** Current month, not yet complete — excluded from cash averages. */
  partial: boolean;
  grossSales: number;
  discounts: number;
  returns: number;
  shipping: number;
  taxes: number;
  fees: number;
  /** Total cost of goods sold, incl. inbound freight and gifted stock. */
  cogs: number;
  shippingCost: number;
  marketing: number;
  otherOpex: number;
  orders: number;
  directorFunding: number;
  taxPaid: number;
  capex: number;
  /** Share of the month inside the selected range, when prorated. */
  fraction?: number;
}

const LABELS = [
  'Nov 25',
  'Dec 25',
  'Jan 26',
  'Feb 26',
  'Mar 26',
  'Apr 26',
  'May 26',
  'Jun 26',
  'Jul 26',
  'Aug 26',
  'Sep 26',
  'Oct 26',
];
const GROSS = [21400, 34800, 12600, 9800, 15200, 58200, 17900, 12300, 10400, 16800, 47300, 14200];
const DISC = [0.06, 0.12, 0.2, 0.05, 0.06, 0.08, 0.06, 0.05, 0.05, 0.06, 0.09, 0.06];
const RET = [0.04, 0.06, 0.05, 0.04, 0.04, 0.05, 0.04, 0.04, 0.03, 0.04, 0.05, 0.03];
const COGS_PCT = [0.34, 0.36, 0.4, 0.33, 0.34, 0.3, 0.33, 0.34, 0.33, 0.33, 0.31, 0.33];
const MARKETING = [2400, 5200, 1500, 1400, 2200, 7800, 2000, 1400, 1300, 2100, 6900, 2300];
const OTHER = [3900, 4100, 3800, 3800, 3900, 4300, 3900, 3800, 3800, 3900, 4200, 3900];
const FUNDING = [0, 0, 5000, 3000, 0, 0, 0, 2000, 0, 0, 0, 0];
const TAX_PAID = [0, 0, 5400, 0, 0, 9100, 0, 0, 6300, 0, 0, 0];
const CAPEX = [0, 0, 0, 0, 1850, 0, 0, 0, 0, 0, 0, 0];

export const MONTHS: MonthRow[] = LABELS.map((label, i) => {
  const grossSales = GROSS[i];
  const discounts = Math.round(grossSales * DISC[i]);
  const returns = Math.round(grossSales * RET[i]);
  const net = grossSales - discounts - returns;
  const orders = Math.round(grossSales / (71 + (i % 4) * 4));
  const shipping = Math.round(orders * 3.1);
  const taxes = Math.round((net + shipping) * 0.2);
  const totalSales = net + shipping + taxes;
  return {
    key: label,
    label,
    partial: i === LABELS.length - 1,
    grossSales,
    discounts,
    returns,
    shipping,
    taxes,
    fees: Math.round(totalSales * 0.029 + orders * 0.2),
    cogs: Math.round(net * COGS_PCT[i]),
    shippingCost: Math.round(orders * 4.2),
    marketing: MARKETING[i],
    otherOpex: OTHER[i],
    orders,
    directorFunding: FUNDING[i],
    taxPaid: TAX_PAID[i],
    capex: CAPEX[i],
  };
});

export const BANK_BALANCE = 48320;
/** Supplier cash paid per £1 of COGS — above 1 because stock is being built ahead of releases. */
const STOCK_FACTOR = 1.8;

/* ── Date ranges ─────────────────────────────────────── */

/** The mock ledger runs from 1 Nov 2025 to "today"; the last month is to-date. */
export const DATA_START = new Date(2025, 10, 1);
export const DATA_END = new Date(2026, 9, 11);

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const by = (ms: MonthRow[], f: (m: MonthRow) => number) => sum(ms.map(f));

const DAY = 86_400_000;
const iso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY) + 1;

/** ISO range for "this year so far", used as the page default. */
export function defaultRange() {
  return { from: `${DATA_END.getFullYear()}-01-01`, to: '2026-10-11' };
}

const MONEY_KEYS = [
  'grossSales',
  'discounts',
  'returns',
  'shipping',
  'taxes',
  'fees',
  'cogs',
  'shippingCost',
  'marketing',
  'otherOpex',
  'orders',
  'directorFunding',
  'taxPaid',
  'capex',
] as const;

/**
 * Months overlapping [from, to], with partly covered months prorated by the
 * share of days inside the range. '' / '' means all time. Because every
 * statement derives from these rows, proration keeps all four tabs consistent.
 */
export function sliceRange(from: string, to: string): MonthRow[] {
  const lo = from ? iso(from) : DATA_START;
  const hi = to ? iso(to) : DATA_END;
  const out: MonthRow[] = [];
  MONTHS.forEach((m, i) => {
    const start = new Date(2025, 10 + i, 1);
    const isLast = i === MONTHS.length - 1;
    const end = isLast ? DATA_END : new Date(2025, 10 + i + 1, 0);
    const from_ = lo > start ? lo : start;
    const to_ = hi < end ? hi : end;
    if (from_ > to_) return;
    const fraction = daysBetween(from_, to_) / daysBetween(start, end);
    if (fraction >= 1) {
      out.push(m);
      return;
    }
    const scaled = { ...m, fraction } as MonthRow;
    for (const k of MONEY_KEYS) scaled[k] = Math.round(m[k] * fraction);
    out.push(scaled);
  });
  return out;
}

/* ── Per-month derivations ───────────────────────────── */

export const netSalesOf = (m: MonthRow) => m.grossSales - m.discounts - m.returns;
export const totalSalesOf = (m: MonthRow) => netSalesOf(m) + m.shipping + m.taxes;
export const otherOutboundOf = (m: MonthRow) => m.marketing + m.otherOpex;
export const netIncomeOf = (m: MonthRow) =>
  netSalesOf(m) + m.shipping - m.cogs - m.shippingCost - m.fees - otherOutboundOf(m);
/** Operating cash: receipts net of fees, less everything paid out to trade. */
export const operatingCashOf = (m: MonthRow) =>
  totalSalesOf(m) -
  m.fees -
  Math.round(m.cogs * STOCK_FACTOR) -
  m.shippingCost -
  otherOutboundOf(m) -
  m.taxPaid;

/* ── Revenue ─────────────────────────────────────────── */

export function revenueFor(ms: MonthRow[]) {
  const grossSales = by(ms, m => m.grossSales);
  const discounts = by(ms, m => m.discounts);
  const returns = by(ms, m => m.returns);
  const netSales = grossSales - discounts - returns;
  const shipping = by(ms, m => m.shipping);
  const taxes = by(ms, m => m.taxes);
  const totalSales = netSales + shipping + taxes;
  const fees = by(ms, m => m.fees);
  const orders = by(ms, m => m.orders);
  const shippingCost = by(ms, m => m.shippingCost);
  return {
    grossSales,
    discounts,
    returns,
    netSales,
    shipping,
    taxes,
    totalSales,
    fees,
    netRevenue: totalSales - fees,
    orders,
    avgOrderValue: orders ? (netSales + shipping) / orders : 0,
    shippingCost,
    shippingMargin: shipping - shippingCost,
    giftedStock: Math.round(by(ms, m => m.cogs) * 0.03),
  };
}

/* ── Profit & loss ───────────────────────────────────── */

export interface Account {
  id: string;
  code: number;
  name: string;
  balance: number;
}

/** Split a total across weights, last bucket takes the rounding remainder. */
function split(total: number, weights: number[]) {
  const out = weights.map(w => Math.round(total * w));
  out[out.length - 1] += total - sum(out);
  return out;
}

export function pnlFor(ms: MonthRow[]) {
  const rev = revenueFor(ms);
  const [online, wholesale] = split(rev.netSales, [0.9, 0.1]);
  const cogsTotal = by(ms, m => m.cogs);
  const [product, freight, gifted] = split(cogsTotal, [0.9, 0.07, 0.03]);
  const other = by(ms, otherOutboundOf) - by(ms, m => m.marketing);
  const [software, studio, professional] = split(other, [0.35, 0.45, 0.2]);

  const acc = (code: number, name: string, balance: number): Account => ({
    id: `a${code}`,
    code,
    name,
    balance,
  });
  const revenue = [
    acc(4000, 'Online sales', online),
    acc(4010, 'Wholesale', wholesale),
    acc(4100, 'Shipping income', rev.shipping),
  ];
  const cogs = [
    acc(5000, 'Product cost', product),
    acc(5010, 'Inbound freight', freight),
    acc(5020, 'Gifted stock', gifted),
  ];
  const opex = [
    acc(6000, 'Shipping & fulfilment', rev.shippingCost),
    acc(6100, 'Payment processing', rev.fees),
    acc(
      6200,
      'Marketing',
      by(ms, m => m.marketing)
    ),
    acc(6300, 'Software & tools', software),
    acc(6400, 'Studio & rent', studio),
    acc(6500, 'Professional fees', professional),
  ];
  const totalRevenue = sum(revenue.map(a => a.balance));
  const totalCogs = sum(cogs.map(a => a.balance));
  const totalOpex = sum(opex.map(a => a.balance));
  const grossProfit = totalRevenue - totalCogs;
  return {
    revenue,
    cogs,
    opex,
    totalRevenue,
    totalCogs,
    totalOpex,
    grossProfit,
    netIncome: grossProfit - totalOpex,
  };
}

/* ── Balance sheet (point in time, independent of period) ── */

export function balanceSheet() {
  const a = (code: number, name: string, balance: number): Account => ({
    id: `a${code}`,
    code,
    name,
    balance,
  });
  const assets = [
    a(1000, 'Business current account', BANK_BALANCE),
    a(1100, 'Stripe & PayPal receivable', 3140),
    a(1200, 'Inventory', 61800),
    a(1300, 'Prepayments', 1250),
  ];
  const liabilities = [
    a(2000, 'Trade payables', 7450),
    a(2100, 'VAT liability', 6100),
    a(2200, "Director's loan", 28000),
    a(2300, 'Corporation tax', 4200),
  ];
  const equity = [
    a(3000, 'Share capital', 100),
    a(3100, 'Retained earnings', 62000),
    a(3200, 'Current year earnings', 6660),
  ];
  const totalAssets = sum(assets.map(x => x.balance));
  const totalLiabilities = sum(liabilities.map(x => x.balance));
  const totalEquity = sum(equity.map(x => x.balance));
  return { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity };
}

/* ── Cash flow ───────────────────────────────────────── */

export interface CashLine {
  label: string;
  amount: number;
}

export function cashFlowFor(ms: MonthRow[]) {
  const rev = revenueFor(ms);
  const operating: CashLine[] = [
    { label: 'Sales receipts (net of fees)', amount: rev.totalSales - rev.fees },
    { label: 'Supplier payments', amount: -Math.round(by(ms, m => m.cogs) * STOCK_FACTOR) },
    { label: 'Shipping & fulfilment', amount: -rev.shippingCost },
    { label: 'Marketing', amount: -by(ms, m => m.marketing) },
    {
      label: 'Studio, software & professional fees',
      amount: -(by(ms, otherOutboundOf) - by(ms, m => m.marketing)),
    },
    { label: 'VAT paid to HMRC', amount: -by(ms, m => m.taxPaid) },
  ].filter(l => l.amount !== 0);
  const investing: CashLine[] = by(ms, m => m.capex)
    ? [{ label: 'Equipment', amount: -by(ms, m => m.capex) }]
    : [];
  const financing: CashLine[] = by(ms, m => m.directorFunding)
    ? [{ label: "Director's loan introduced", amount: by(ms, m => m.directorFunding) }]
    : [];
  const unclassified: CashLine[] = [
    { label: 'Bank transactions awaiting a journal', amount: -212 },
  ];

  const totalOperating = sum(operating.map(l => l.amount));
  const totalInvesting = sum(investing.map(l => l.amount));
  const totalFinancing = sum(financing.map(l => l.amount));
  const totalUnclassified = sum(unclassified.map(l => l.amount));
  const netChange = totalOperating + totalInvesting + totalFinancing + totalUnclassified;
  return {
    operating,
    investing,
    financing,
    unclassified,
    totalOperating,
    totalInvesting,
    totalFinancing,
    totalUnclassified,
    netChange,
    closing: BANK_BALANCE,
    opening: BANK_BALANCE - netChange,
    coverage: { cashTxns: 318, unjournalled: 3 },
  };
}

/* ── Cash insights (trailing window, ignores the period) ── */

export function cashInsights() {
  const complete = MONTHS.filter(m => !m.partial);
  const series = MONTHS.map(m => ({
    label: m.label,
    operating: operatingCashOf(m),
    partial: m.partial,
  }));
  const ops = complete.map(operatingCashOf);
  const trailing12 = sum(ops);
  const trailing6 = sum(ops.slice(-6));
  const avg = trailing12 / ops.length;
  const best = complete.reduce((a, m) => (operatingCashOf(m) > operatingCashOf(a) ? m : a));
  const worst = complete.reduce((a, m) => (operatingCashOf(m) < operatingCashOf(a) ? m : a));
  const verdict: 'generating' | 'breakeven' | 'consuming' =
    trailing6 > 1000 ? 'generating' : trailing6 < -1000 ? 'consuming' : 'breakeven';
  const headline = {
    generating: 'Trading is generating cash.',
    breakeven: 'Trading is roughly breaking even.',
    consuming: 'Trading is consuming cash.',
  }[verdict];
  const director = sum(complete.map(m => m.directorFunding));
  const buffer = Math.abs(Math.min(0, operatingCashOf(worst)));
  const accruedTax = 6100;
  const unpaidBills = 7450;
  const safeToSpend = Math.max(0, BANK_BALANCE - accruedTax - unpaidBills - buffer);
  return {
    series,
    trailing6,
    trailing12,
    avg,
    best: { label: best.label, amount: operatingCashOf(best) },
    worst: { label: worst.label, amount: operatingCashOf(worst) },
    verdict,
    headline,
    detail: `Operating cash over the last 6 complete months came to ${trailing6 >= 0 ? '+' : '−'}£${Math.abs(Math.round(trailing6)).toLocaleString('en-GB')}, before any funding you put in.`,
    runwayMonths: avg < 0 ? Math.floor(BANK_BALANCE / Math.abs(avg)) : null,
    tradingPct: trailing12 > 0 ? Math.round((trailing12 / (trailing12 + director)) * 100) : 0,
    trading: trailing12,
    director,
    safeToSpend,
    lines: [
      {
        label: 'Cash in the bank',
        amount: BANK_BALANCE,
        detail: 'Closing balance across connected bank accounts.',
      },
      {
        label: 'Less: VAT already accrued',
        amount: -accruedTax,
        detail: 'Tax collected from customers that is owed to HMRC.',
      },
      {
        label: 'Less: unpaid supplier bills',
        amount: -unpaidBills,
        detail: 'Bills received and approved but not yet paid.',
      },
      {
        label: 'Less: worst-month buffer',
        amount: -buffer,
        detail: `Sized to the worst complete month in the last year (${worst.label}).`,
      },
    ],
  };
}

/* ── Drilldown generators (deterministic fake ledger rows) ── */

export interface Entry {
  id: string;
  date: string;
  source: string;
  reference: string;
  amount: number;
}

const SOURCES: Record<string, string[]> = {
  '1': [
    'Bank transaction',
    'Stripe payout',
    'PayPal transfer',
    'Bank transaction',
    'Stripe payout',
  ],
  '2': ['Supplier bill', 'HMRC accrual', 'Supplier bill', 'Manual journal', 'Supplier bill'],
  '3': ['Manual journal', 'Year-end close', 'Manual journal'],
  '4': [
    'Shopify payout',
    'Shopify payout',
    'Shopify payout',
    'Wholesale invoice',
    'Shopify payout',
  ],
  '5': [
    'Supplier invoice',
    'Supplier invoice',
    'Freight invoice',
    'Stock adjustment',
    'Supplier invoice',
  ],
  '6': ['Bank transaction', 'Card payment', 'Bank transaction', 'Direct debit', 'Card payment'],
};
const WEIGHTS = [0.31, 0.24, 0.19, 0.14, 0.12];

export function entriesFor(acc: Account, endLabel: string): Entry[] {
  const names = SOURCES[String(acc.code)[0]] ?? SOURCES['6'];
  const [mon, yy] = endLabel.split(' ');
  const monthIdx = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ].indexOf(mon);
  const year = 2000 + Number(yy);
  const n = Math.min(names.length, WEIGHTS.length);
  const w = WEIGHTS.slice(0, n);
  const total = sum(w);
  const amounts = split(
    acc.balance,
    w.map(x => x / total)
  );
  return amounts.map((amount, i) => ({
    id: `${acc.code}-${i}`,
    date: new Date(year, monthIdx, Math.max(1, 26 - i * 5)).toISOString(),
    source: names[i],
    reference: `J-${acc.code}${String(i + 1).padStart(2, '0')}${(acc.balance % 97) + 10}`,
    amount,
  }));
}

export interface DetailItem {
  label: string;
  note: string;
  amount: number;
}

const DETAIL_SETS = {
  cogs: [
    ['Heavy Knit Cardigan', 'Stock sold'],
    ['Wool Overshirt', 'Stock sold'],
    ['Rib Beanie', 'Stock sold'],
    ['Merino Scarf', 'Stock sold'],
    ['Inbound freight', 'Allocated'],
  ],
  shipping: [
    ['Royal Mail', 'Tracked 48'],
    ['DHL Express', 'International'],
    ['Evri', 'Standard'],
    ['Sendcloud', 'Platform fee'],
  ],
  other: [
    ['Meta Ads', 'Marketing'],
    ['Studio rent', 'Monthly'],
    ['Shopify & apps', 'Software'],
    ['Accountant', 'Professional fees'],
    ['Google Ads', 'Marketing'],
  ],
} as const;
export type DetailKind = keyof typeof DETAIL_SETS;

export function detailFor(m: MonthRow, kind: DetailKind): DetailItem[] {
  const set = DETAIL_SETS[kind];
  const total =
    kind === 'cogs' ? m.cogs : kind === 'shipping' ? m.shippingCost : otherOutboundOf(m);
  const weights = set.map((_, i) => 1 / (i + 1.4));
  const t = sum(weights);
  return split(
    total,
    weights.map(x => x / t)
  ).map((amount, i) => ({ label: set[i][0], note: set[i][1], amount }));
}
