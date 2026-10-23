/**
 * In-memory stand-in for the FastAPI accounting endpoints the Transactions page calls from the
 * browser. It intercepts every request under /accounting/ with `page.route`, so tests are
 * deterministic and need no Python backend.
 *
 * It mirrors the real behaviour that the page depends on (see
 * apps/ai_agent/src/ai_agent/api/routes/accounting.py): the list's filter semantics and ordering,
 * and the journal outcome of an update (excluding reverses, changing the account on a journalised
 * transaction reverses and recreates, un-excluding asks for a new journal).
 */

import type { Page, Route } from '@playwright/test';
import type {
  FinancialTransaction,
  JournalLineItemWithAccount,
  TransactionJournal,
} from '../../app/lib/api/transactions';

export const ACCOUNTS = [
  {
    id: 'acc-1000',
    account_number: '1000',
    name: 'Business current account',
    account_type: 'asset',
    is_header: false,
  },
  {
    id: 'acc-1900',
    account_number: '1900',
    name: 'Transfers clearing',
    account_type: 'asset',
    is_header: false,
  },
  {
    id: 'acc-4000',
    account_number: '4000',
    name: 'Online sales',
    account_type: 'revenue',
    is_header: false,
  },
  {
    id: 'acc-5000',
    account_number: '5000',
    name: 'Product cost',
    account_type: 'expense',
    is_header: false,
  },
  {
    id: 'acc-6000',
    account_number: '6000',
    name: 'Shipping & fulfilment',
    account_type: 'expense',
    is_header: false,
  },
  {
    id: 'acc-6200',
    account_number: '6200',
    name: 'Marketing',
    account_type: 'expense',
    is_header: false,
  },
  {
    id: 'acc-6300',
    account_number: '6300',
    name: 'Software & tools',
    account_type: 'expense',
    is_header: false,
  },
  {
    id: 'acc-6999',
    account_number: '6999',
    name: 'Expenses (header)',
    account_type: 'expense',
    is_header: true,
  },
];
const accountByNumber = (n: string) => ACCOUNTS.find(a => a.account_number === n);

const ENTITY = 'stub-entity';

interface Template {
  dir: 'in' | 'out';
  src: 'revolut' | 'paypal';
  type: string;
  cp: string;
  desc: string;
  acct: string;
  amount: number;
  cur?: string;
  fx?: number;
}
const TEMPLATES: Template[] = [
  {
    dir: 'in',
    src: 'revolut',
    type: 'payout',
    cp: 'Shopify Payments',
    desc: 'Shopify payout',
    acct: '4000',
    amount: 840.5,
  },
  {
    dir: 'in',
    src: 'paypal',
    type: 'payment',
    cp: 'PayPal sale',
    desc: 'Customer payment',
    acct: '4000',
    amount: 96,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'Royal Mail',
    desc: 'Postage',
    acct: '6000',
    amount: 212.4,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'expense',
    cp: 'Meta Ads',
    desc: 'Ad spend',
    acct: '6200',
    amount: 530,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'fee',
    cp: 'Shopify',
    desc: 'Monthly plan',
    acct: '6300',
    amount: 79,
  },
  {
    dir: 'out',
    src: 'paypal',
    type: 'fee',
    cp: 'PayPal',
    desc: 'Transaction fees',
    acct: '6300',
    amount: 14.2,
  },
  {
    dir: 'out',
    src: 'revolut',
    type: 'payment',
    cp: 'Mill & Loom Ltd',
    desc: 'Fabric order',
    acct: '5000',
    amount: 2210,
  },
];

export function journalFor(t: FinancialTransaction, accountNumber: string): TransactionJournal {
  const other = accountByNumber(accountNumber) ?? ACCOUNTS[0];
  const bank = ACCOUNTS[0];
  const amount = Number(t.base_amount ?? t.amount);
  const line = (
    a: (typeof ACCOUNTS)[number],
    debit: number,
    credit: number
  ): JournalLineItemWithAccount => ({
    id: `${t.id}-${a.account_number}`,
    journal_id: `j-${t.id}`,
    account_id: a.id,
    account_number: a.account_number,
    account_name: a.name,
    account_type: a.account_type,
    debit,
    credit,
    currency: 'GBP',
    description: null,
    effective_date: t.occurred_at,
  });
  return {
    id: `j-${t.id}`,
    entity_id: ENTITY,
    journal_date: t.occurred_at,
    journal_type: 'transaction',
    description: `${t.counterparty_name ?? 'Transaction'}: ${t.description ?? ''}`.trim(),
    source_type: 'financial_transaction',
    source_id: t.id,
    status: 'posted',
    posted_at: t.occurred_at,
    reversed_by_id: null,
    metadata: null,
    created_at: t.occurred_at,
    line_items:
      t.direction === 'out'
        ? [line(other, amount, 0), line(bank, 0, amount)]
        : [line(bank, amount, 0), line(other, 0, amount)],
  };
}

/**
 * Deterministic transactions, newest first. The first four are fixed so tests can name them:
 *   [0] pending inbound PayPal sale       [1] journalled outbound EUR supplier payment (FX)
 *   [2] excluded internal transfer         [3] journalled outbound Royal Mail postage
 */
export function makeTransactions(count = 130): FinancialTransaction[] {
  const newest = Date.UTC(2026, 8, 30, 18, 0, 0);
  const STEP = 7 * 3_600_000;
  const out: FinancialTransaction[] = [];
  for (let i = 0; i < count; i++) {
    const t = TEMPLATES[i % TEMPLATES.length];
    const occurred = new Date(newest - i * STEP).toISOString();
    let base: FinancialTransaction = {
      id: `txn-${String(i).padStart(3, '0')}`,
      entity_id: ENTITY,
      source: t.src,
      external_transaction_id: `${t.src}_${1000 + i}`,
      amount: t.amount + (i % 5),
      currency_code: 'GBP',
      base_amount: t.amount + (i % 5),
      base_currency_code: 'GBP',
      fx_rate: null,
      direction: t.dir,
      transaction_type: t.type as FinancialTransaction['transaction_type'],
      occurred_at: occurred,
      description: t.desc,
      counterparty_name: t.cp,
      status: 'active',
      excluded_reason: null,
      journalised_at: occurred,
      metadata: { account_code: t.acct },
    };
    if (i === 0) {
      base = {
        ...base,
        source: 'paypal',
        direction: 'in',
        transaction_type: 'payment',
        counterparty_name: 'PayPal sale',
        description: 'Customer payment',
        journalised_at: null,
        metadata: { account_code: '4000' },
      };
    } else if (i === 1) {
      base = {
        ...base,
        source: 'revolut',
        direction: 'out',
        transaction_type: 'payment',
        counterparty_name: 'Porto Knitwear',
        description: 'Production run',
        amount: 3000,
        currency_code: 'EUR',
        base_amount: 2580,
        base_currency_code: 'GBP',
        fx_rate: 0.86,
        metadata: { account_code: '5000' },
      };
    } else if (i === 2) {
      base = {
        ...base,
        source: 'revolut',
        direction: 'out',
        transaction_type: 'transfer',
        counterparty_name: 'Revolut Savings',
        description: 'Internal transfer',
        excluded_reason: 'Internal transfer',
        journalised_at: null,
        metadata: { account_code: '1900' },
      };
    } else if (i === 3) {
      base = {
        ...base,
        counterparty_name: 'Royal Mail',
        description: 'Postage',
        direction: 'out',
        transaction_type: 'expense',
        amount: 212.4,
        base_amount: 212.4,
        metadata: { account_code: '6000' },
      };
    } else if (i % 17 === 0) {
      // Sprinkle in more pending rows so the "awaiting a journal" count is not just one.
      base = { ...base, journalised_at: null };
    }
    out.push(base);
  }
  return out;
}

export interface AccountingApiStub {
  /** Current in-memory transactions (mutated by PATCH). */
  transactions: FinancialTransaction[];
  /** Query strings of every list request, in order. */
  listRequests: URLSearchParams[];
  /** Bodies of every PATCH, in order. */
  patches: { id: string; body: Record<string, unknown> }[];
  /**
   * Make every list request fail with a 500 until switched off. (Not "the next one": in
   * development React runs effects twice, so a one-shot failure is swallowed by the retry.)
   */
  failLists(failing: boolean): void;
}

export async function mockAccountingApi(
  page: Page,
  initial: FinancialTransaction[] = makeTransactions()
): Promise<AccountingApiStub> {
  const stub: AccountingApiStub = {
    transactions: structuredClone(initial),
    listRequests: [],
    patches: [],
    failLists(failing: boolean) {
      failing_ = failing;
    },
  };
  let failing_ = false;

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PATCH,POST,OPTIONS',
    // `*` does not cover Authorization, so it is named.
    'access-control-allow-headers': 'authorization, content-type',
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  await page.route('**/accounting/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

    const url = new URL(request.url());
    const path = url.pathname;
    // The agent refuses anyone who is not signed in: so does this stand-in.
    if (!/^Bearer \S+/.test(request.headers()['authorization'] ?? ''))
      return json(route, { detail: 'Missing bearer token' }, 401);

    if (path.endsWith('/accounting/chart-of-accounts')) {
      return json(route, { entity_id: ENTITY, accounts: ACCOUNTS });
    }

    const detail = path.match(/\/accounting\/transactions\/([^/]+)$/);
    if (detail) {
      const txn = stub.transactions.find(t => t.id === detail[1]);
      if (!txn) return json(route, { detail: 'not found' }, 404);

      if (request.method() === 'PATCH') {
        const body = request.postDataJSON() as Record<string, unknown>;
        stub.patches.push({ id: txn.id, body });
        const wasJournalled = !!txn.journalised_at;
        const wasExcluded = !!txn.excluded_reason;
        const previousAccount = String(txn.metadata?.account_code ?? '');

        if (typeof body.description === 'string') txn.description = body.description;
        if (typeof body.counterparty_name === 'string')
          txn.counterparty_name = body.counterparty_name;
        txn.metadata = { ...(txn.metadata ?? {}) };
        if (typeof body.account_code === 'string') txn.metadata.account_code = body.account_code;
        if (typeof body.expense_category === 'string')
          txn.metadata.expense_category = body.expense_category;
        if (typeof body.excluded_reason === 'string')
          txn.excluded_reason = body.excluded_reason || null;

        let action: 'none' | 'reversed' | 'reversed_and_recreated' | 'reversed_only' = 'none';
        let reJournalNeeded = false;
        let newJournal: TransactionJournal | null = null;
        if (txn.excluded_reason) {
          if (wasJournalled) action = 'reversed';
          txn.journalised_at = null;
        } else if (wasExcluded) {
          reJournalNeeded = true;
        } else if (wasJournalled && String(txn.metadata.account_code) !== previousAccount) {
          action = 'reversed_and_recreated';
          newJournal = journalFor(txn, String(txn.metadata.account_code));
        }
        return json(route, {
          transaction: txn,
          journal_action: action,
          new_journal: newJournal,
          re_journal_needed: reJournalNeeded,
        });
      }

      const journal =
        txn.journalised_at && !txn.excluded_reason
          ? journalFor(txn, String(txn.metadata?.account_code ?? '6000'))
          : null;
      return json(route, { transaction: txn, journal });
    }

    if (path.endsWith('/accounting/transactions')) {
      const q = url.searchParams;
      stub.listRequests.push(q);
      if (failing_) return json(route, { detail: 'boom' }, 500);
      const search = q.get('search')?.toLowerCase();
      const from = q.get('date_from');
      const to = q.get('date_to');
      const rows = stub.transactions
        .filter(t => !q.get('source') || t.source === q.get('source'))
        .filter(t => !q.get('direction') || t.direction === q.get('direction'))
        .filter(t => !q.get('transaction_type') || t.transaction_type === q.get('transaction_type'))
        .filter(t => q.get('txn_status') !== 'excluded' || !!t.excluded_reason)
        .filter(t => q.get('txn_status') !== 'active' || !t.excluded_reason)
        .filter(t => !from || Date.parse(t.occurred_at) >= Date.parse(from))
        .filter(t => !to || Date.parse(t.occurred_at) <= Date.parse(to))
        .filter(
          t =>
            !search ||
            (t.description ?? '').toLowerCase().includes(search) ||
            (t.counterparty_name ?? '').toLowerCase().includes(search)
        )
        .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
      const pageNo = Number(q.get('page') ?? 1);
      const size = Number(q.get('page_size') ?? 50);
      return json(route, {
        entity_id: ENTITY,
        transactions: rows.slice((pageNo - 1) * size, pageNo * size),
        total_count: rows.length,
        page: pageNo,
        page_size: size,
        total_pages: Math.max(1, Math.ceil(rows.length / size)),
      });
    }

    return json(route, { detail: `unstubbed: ${path}` }, 404);
  });

  return stub;
}
