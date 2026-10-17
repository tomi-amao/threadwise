/**
 * The seeded business's books: accounting periods, corporation-tax rates, and journals.
 *
 * The journals are written out in full (rather than generated) so the figures the Reports, Tax
 * and Journals pages should show can be worked out here, by the same simple rules, and handed
 * to the tests in the manifest. Amounts are round so the arithmetic is checkable by eye:
 *
 *   previous year  revenue 11,400 (12,000 sales less 600 discounts), cost of sales 4,800,
 *                  expenses 1,600, so a profit of 5,000
 *   this year      revenue 28,500, cost of sales 12,000, expenses 5,600 + bank-feed journals
 *
 * plus a journal for each of the first 36 bank transactions (so cash-flow classification has
 * something to classify), three drafts that need a person to choose an account, a manual
 * adjustment, and a reversed journal that must not count.
 */

export interface LedgerLine {
  account: string; // account number
  debit?: number;
  credit?: number;
}

export type JournalStatus = 'posted' | 'draft' | 'reversed';

export interface LedgerJournal {
  key: string;
  /** Days after the financial year's start (negative: days before it). `previous` uses the year before. */
  period: 'previous' | 'current';
  offsetDays: number;
  type: string;
  status: JournalStatus;
  description: string;
  sourceType: string | null;
  /** Index into the seeded bank transactions, when the journal is a bank-feed one. */
  txnIndex?: number;
  lines: LedgerLine[];
}

export const ACCOUNTS: readonly [string, string, string, 'debit' | 'credit'][] = [
  ['1010', 'Bank: Revolut', 'asset', 'debit'],
  ['1012', 'Merchant services clearing', 'asset', 'debit'],
  ['1033', 'Inventory: finished goods', 'asset', 'debit'],
  ['1210', 'Equipment', 'asset', 'debit'],
  ['2010', 'Accounts payable', 'liability', 'credit'],
  ['2230', "Director's loan", 'liability', 'credit'],
  ['3010', 'Share capital', 'equity', 'credit'],
  ['3030', 'Retained earnings', 'equity', 'credit'],
  ['4000', 'Product sales', 'revenue', 'credit'],
  ['4100', 'Discounts and returns', 'revenue', 'debit'],
  ['5000', 'Product purchase cost', 'cogs', 'debit'],
  ['6100', 'Materials and supplies', 'expense', 'debit'],
  ['6300', 'Shipping and delivery', 'expense', 'debit'],
  ['6500', 'Marketing', 'expense', 'debit'],
  ['7100', 'Travel and entertainment', 'expense', 'debit'],
  ['8045', 'Corporation tax', 'expense', 'debit'],
  ['8090', 'Uncategorised', 'expense', 'debit'],
];

const dr = (account: string, debit: number): LedgerLine => ({ account, debit });
const cr = (account: string, credit: number): LedgerLine => ({ account, credit });

const j = (
  key: string,
  period: 'previous' | 'current',
  offsetDays: number,
  type: string,
  description: string,
  lines: LedgerLine[],
  status: JournalStatus = 'posted',
  sourceType: string | null = 'payment'
): LedgerJournal => ({ key, period, offsetDays, type, status, description, sourceType, lines });

export const FIXED_JOURNALS: LedgerJournal[] = [
  // Previous financial year
  j('p1', 'previous', 40, 'accrual', 'Sales accrued', [dr('1012', 12000), cr('4000', 12000)]),
  j('p2', 'previous', 60, 'accrual', 'Discounts given', [dr('4100', 600), cr('1012', 600)]),
  j('p3', 'previous', 100, 'purchase', 'Cost of goods sold', [dr('5000', 4800), cr('1033', 4800)]),
  j(
    'p4',
    'previous',
    120,
    'expense',
    'Shipping',
    [dr('6300', 700), cr('1010', 700)],
    'posted',
    null
  ),
  j(
    'p5',
    'previous',
    130,
    'expense',
    'Marketing',
    [dr('6500', 900), cr('1010', 900)],
    'posted',
    null
  ),
  j('p6', 'previous', 150, 'settlement', 'Payout received', [dr('1010', 11000), cr('1012', 11000)]),
  j(
    'p7',
    'previous',
    5,
    'funding',
    'Share capital paid in',
    [dr('1010', 5000), cr('3010', 5000)],
    'posted',
    'manual'
  ),
  j(
    'p8',
    'previous',
    30,
    'purchase',
    'Stock bought on account',
    [dr('1033', 20000), cr('2010', 20000)],
    'posted',
    'invoice'
  ),
  j(
    'p9',
    'previous',
    170,
    'payment',
    'Supplier paid',
    [dr('2010', 20000), cr('1010', 20000)],
    'posted',
    'invoice'
  ),
  // This financial year
  j('c1', 'current', 20, 'accrual', 'Sales accrued', [dr('1012', 30000), cr('4000', 30000)]),
  j('c2', 'current', 25, 'accrual', 'Discounts given', [dr('4100', 1500), cr('1012', 1500)]),
  j('c3', 'current', 30, 'purchase', 'Cost of goods sold', [dr('5000', 12000), cr('1033', 12000)]),
  j(
    'c4',
    'current',
    35,
    'expense',
    'Shipping',
    [dr('6300', 1800), cr('1010', 1800)],
    'posted',
    null
  ),
  j(
    'c5',
    'current',
    40,
    'expense',
    'Marketing',
    [dr('6500', 2500), cr('1010', 2500)],
    'posted',
    null
  ),
  j(
    'c6',
    'current',
    45,
    'purchase',
    'Materials on account',
    [dr('6100', 900), cr('2010', 900)],
    'posted',
    'invoice'
  ),
  j('c7', 'current', 50, 'settlement', 'Payout received', [dr('1010', 27000), cr('1012', 27000)]),
  j(
    'c8',
    'current',
    55,
    'funding',
    "Director's loan",
    [dr('1010', 3000), cr('2230', 3000)],
    'posted',
    'manual'
  ),
  j(
    'c9',
    'current',
    60,
    'expense',
    'Equipment bought',
    [dr('1210', 2000), cr('1010', 2000)],
    'posted',
    null
  ),
  j('c10', 'current', 65, 'expense', 'Travel', [dr('7100', 400), cr('1010', 400)], 'posted', null),
  j(
    'c11',
    'current',
    70,
    'adjustment',
    'Reclassify marketing to materials',
    [dr('6500', 250), cr('6100', 250)],
    'posted',
    'manual'
  ),
  j(
    'c12',
    'current',
    75,
    'expense',
    'Posted in error, reversed',
    [dr('6300', 999), cr('1010', 999)],
    'reversed',
    null
  ),
];

/** How a bank transaction is journalled, by what it was (the seed's transaction templates). */
export function bankFeedJournal(
  index: number,
  txn: { amount: number; direction: string; description: string; transaction_type: string }
): LedgerJournal {
  const amount = txn.amount;
  let lines: LedgerLine[];
  if (txn.direction === 'in') lines = [dr('1010', amount), cr('1012', amount)];
  else if (txn.description === 'Production run') lines = [dr('1033', amount), cr('1010', amount)];
  else if (txn.description === 'Postage') lines = [dr('6300', amount), cr('1010', amount)];
  else if (txn.description === 'Ad spend') lines = [dr('6500', amount), cr('1010', amount)];
  else lines = [dr('6100', amount), cr('1010', amount)];
  return {
    key: `t${index}`,
    period: 'current',
    offsetDays: 0, // dated from the transaction itself
    type: txn.direction === 'in' ? 'settlement' : 'expense',
    status: 'posted',
    description: `${txn.description}`,
    sourceType: 'financial_transaction',
    txnIndex: index,
    lines,
  };
}

export const BANK_FEED_JOURNAL_COUNT = 36;
export const DRAFT_COUNT = 3;

// ─── Expected figures ─────────────────────────────────────────────────────────

export interface Journalled {
  journal: LedgerJournal;
  /** ISO date the journal is posted on. */
  date: string;
}

type Types = Record<string, string>;

export function expectedFigures(
  journals: Journalled[],
  accountType: Types,
  range: { from?: string; to?: string }
) {
  const inRange = (d: string) => (!range.from || d >= range.from) && (!range.to || d <= range.to);
  let revenue = 0;
  let cogs = 0;
  let expenses = 0;
  for (const { journal, date } of journals) {
    if (journal.status !== 'posted' || !inRange(date)) continue;
    for (const l of journal.lines) {
      const type = accountType[l.account];
      const net = (l.debit ?? 0) - (l.credit ?? 0);
      if (type === 'revenue') revenue -= net;
      if (type === 'cogs') cogs += net;
      if (type === 'expense') expenses += net;
    }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    revenue: r(revenue),
    cogs: r(cogs),
    expenses: r(expenses),
    profit: r(revenue - cogs - expenses),
  };
}

/** Balance sheet: everything posted up to `to`, with all-time profit as retained earnings. */
export function expectedBalanceSheet(journals: Journalled[], accountType: Types, to?: string) {
  const net: Record<string, number> = {};
  for (const { journal, date } of journals) {
    if (journal.status !== 'posted' || (to && date > to)) continue;
    for (const l of journal.lines)
      net[l.account] = (net[l.account] ?? 0) + (l.debit ?? 0) - (l.credit ?? 0);
  }
  let assets = 0;
  let liabilities = 0;
  let equity = 0;
  let profit = 0;
  for (const [account, n] of Object.entries(net)) {
    const type = accountType[account];
    if (type === 'asset') assets += n;
    else if (type === 'liability') liabilities -= n;
    else if (type === 'equity') equity -= n;
    else profit -= n; // revenue (credit) up, cogs and expenses (debit) down
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    assets: r(assets),
    liabilities: r(liabilities),
    equity: r(equity + profit),
    retainedEarnings: r(profit),
    balance: r(assets - liabilities - (equity + profit)),
  };
}
