/**
 * Service-role access to the local test database, for reading and restoring state in tests
 * that change data. Refuses to connect to anything but the local stack.
 *
 * This talks to PostgREST with fetch rather than using supabase-js: importing supabase-js into
 * a Playwright test file trips a Node module-loader bug ("Unexpected module status 3").
 */

import { assertLocalSupabase, loadTestEnv, requireEnv } from '../env';

loadTestEnv();
const url = assertLocalSupabase(process.env.SUPABASE_URL);
const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

/** Notes on movements written by the stand-in agent, so tests can find and remove them. */
export const STAND_IN_NOTE = 'E2E stand-in disposal';

async function rest<T>(
  method: 'GET' | 'PATCH' | 'DELETE',
  table: string,
  query: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${method} ${table}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export interface ItemRow {
  id: string;
  sku: string;
  unit_cost: number;
  item_type: string;
  product_id: string | null;
}

export async function readItems(): Promise<ItemRow[]> {
  const rows = await rest<(ItemRow & { unit_cost: string | number })[]>(
    'GET',
    'inventory_items',
    'select=id,sku,unit_cost,item_type,product_id'
  );
  return rows.map(r => ({ ...r, unit_cost: Number(r.unit_cost) }));
}

export async function readItemBySku(sku: string): Promise<ItemRow> {
  const items = await readItems();
  const item = items.find(i => i.sku === sku);
  if (!item) throw new Error(`No inventory item with SKU ${sku}`);
  return item;
}

export async function restoreItem(row: ItemRow): Promise<void> {
  await rest('PATCH', 'inventory_items', `id=eq.${row.id}`, {
    unit_cost: row.unit_cost,
    item_type: row.item_type,
    product_id: row.product_id,
  });
}

export async function deleteStandInMovements(): Promise<void> {
  await rest('DELETE', 'inventory_movements', `notes=eq.${encodeURIComponent(STAND_IN_NOTE)}`);
}

// ─── Invoices ─────────────────────────────────────────────────────────

export interface InvoiceSnapshot {
  invoices: { id: string; status: string; notes: string | null; invoice_type: string }[];
  lines: { id: string; gl_account_id: string | null }[];
}

/** The seeded invoices a test may change (the 1,020 bulk ones are never touched). */
export async function snapshotInvoices(): Promise<InvoiceSnapshot> {
  const invoices = await rest<InvoiceSnapshot['invoices']>(
    'GET',
    'invoices',
    'select=id,status,notes,invoice_type&invoice_number=not.like.INV-BULK-*'
  );
  const ids = invoices.map(i => i.id).join(',');
  const lines = await rest<InvoiceSnapshot['lines']>(
    'GET',
    'invoice_line_items',
    `select=id,gl_account_id&invoice_id=in.(${ids})`
  );
  return { invoices, lines };
}

/** Put every changed invoice and line back, and remove what a test created. */
export async function restoreInvoices(before: InvoiceSnapshot): Promise<void> {
  const now = await snapshotInvoices();
  const was = new Map(before.invoices.map(i => [i.id, i]));
  for (const row of now.invoices) {
    const original = was.get(row.id);
    if (original && JSON.stringify(original) !== JSON.stringify(row)) {
      await rest('PATCH', 'invoices', `id=eq.${row.id}`, {
        status: original.status,
        notes: original.notes,
        invoice_type: original.invoice_type,
      });
    }
  }
  const lineWas = new Map(before.lines.map(l => [l.id, l.gl_account_id]));
  for (const line of now.lines) {
    if (lineWas.has(line.id) && lineWas.get(line.id) !== line.gl_account_id) {
      await rest('PATCH', 'invoice_line_items', `id=eq.${line.id}`, {
        gl_account_id: lineWas.get(line.id),
      });
    }
  }
  // Invoices made by the stand-in agent when a test uploads a file, and what it created for
  // them (stock items, movements, its two contacts).
  await rest('DELETE', 'invoices', 'invoice_number=like.E2E-UP-*');
  await deleteStandInMovements();
  await rest('DELETE', 'inventory_items', 'sku=like.e2e-*');
  await rest('DELETE', 'contacts', 'name=in.("Stand-in Supplier Ltd","Stand-in Customer Ltd")');
}

export async function readInvoice(
  number: string
): Promise<{ id: string; status: string; notes: string | null; invoice_type: string } | null> {
  const rows = await rest<
    { id: string; status: string; notes: string | null; invoice_type: string }[]
  >(
    'GET',
    'invoices',
    `select=id,status,notes,invoice_type&invoice_number=eq.${encodeURIComponent(number)}`
  );
  return rows[0] ?? null;
}

export async function readLineAccount(invoiceNumber: string, description: string) {
  const invoice = await readInvoice(invoiceNumber);
  if (!invoice) throw new Error(`No invoice ${invoiceNumber}`);
  const rows = await rest<{ gl_account_id: string | null }[]>(
    'GET',
    'invoice_line_items',
    `select=gl_account_id&invoice_id=eq.${invoice.id}&description=eq.${encodeURIComponent(description)}`
  );
  return rows[0]?.gl_account_id ?? null;
}

// ─── Acting as a user (or nobody) ─────────────────────────────────────────────────────────────

const anonKey = requireEnv('SUPABASE_ANON_KEY');

/** The password every seeded user shares (local test database only). */
export const TEST_PASSWORD = requireEnv('E2E_USER_PASSWORD');

/** Sign in through Supabase Auth and return the access token, as the browser would. */
export async function signIn(email: string, password = TEST_PASSWORD): Promise<string> {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign in ${email}: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

export interface Api {
  status: number;
  rows: Record<string, unknown>[];
  /** Exact row count the server reports for the query (what RLS lets this caller see). */
  count: number | null;
}

/**
 * Call the REST API with the public key and, optionally, a user's token: exactly what any
 * browser can do. `token` undefined means not signed in.
 */
export async function api(
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
  table: string,
  query = '',
  token?: string,
  body?: unknown
): Promise<Api> {
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token ?? anonKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,count=exact',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let rows: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    /* an error body is not a row */
  }
  const range = response.headers.get('content-range');
  const count = range && /\/(\d+)$/.test(range) ? Number(range.split('/')[1]) : null;
  return { status: response.status, rows, count };
}

/** An inventory item's id by SKU, read with the service role (for tests aiming at another business). */
export async function readItemIdBySku(sku: string): Promise<string> {
  const rows = await rest<{ id: string }[]>(
    'GET',
    'inventory_items',
    `select=id&sku=eq.${encodeURIComponent(sku)}`
  );
  if (!rows[0]) throw new Error(`No inventory item with SKU ${sku}`);
  return rows[0].id;
}

/** Call a database function over the REST API, as anyone with the public key could. */
export async function rpc(
  fn: string,
  args: Record<string, unknown>,
  token?: string
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token ?? anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: response.status, body };
}

// ─── Transactions (for tests that leave one out of the reports and put it back) ─────────────────

export interface TxnState {
  id: string;
  status: string;
  excluded_reason: string | null;
  metadata: Record<string, unknown>;
}

export async function readTxn(id: string): Promise<TxnState> {
  const rows = await rest<TxnState[]>(
    'GET',
    'financial_transactions',
    `select=id,status,excluded_reason,metadata&id=eq.${id}`
  );
  if (!rows[0]) throw new Error(`No transaction ${id}`);
  return rows[0];
}

export async function restoreTxn(state: TxnState): Promise<void> {
  await rest('PATCH', 'financial_transactions', `id=eq.${state.id}`, {
    status: state.status,
    excluded_reason: state.excluded_reason,
    metadata: state.metadata,
  });
}

/** Ids of transactions (newest first) whose description matches, read with the service role. */
export async function findTxnIds(description: string, limit = 5): Promise<string[]> {
  const rows = await rest<{ id: string }[]>(
    'GET',
    'financial_transactions',
    `select=id&description=eq.${encodeURIComponent(description)}&order=occurred_at.desc&limit=${limit}`
  );
  return rows.map(r => r.id);
}

// ─── Tax (periods, adjustments and company details a test may change) ───────────────────────────

export interface TaxSnapshot {
  periods: { id: string; status: string; filed_at: string | null }[];
  adjustmentIds: string[];
  entity: {
    id: string;
    company_number: string | null;
    tax_reference: string | null;
    vat_registered: boolean | null;
    vat_number: string | null;
  };
}

export async function snapshotTax(entityName: string): Promise<TaxSnapshot> {
  const [periods, adjustments, entities] = await Promise.all([
    rest<TaxSnapshot['periods']>('GET', 'accounting_periods', 'select=id,status,filed_at'),
    rest<{ id: string }[]>('GET', 'tax_adjustments', 'select=id'),
    rest<TaxSnapshot['entity'][]>(
      'GET',
      'entities',
      `select=id,company_number,tax_reference,vat_registered,vat_number&name=eq.${encodeURIComponent(entityName)}`
    ),
  ]);
  return { periods, adjustmentIds: adjustments.map(a => a.id), entity: entities[0] };
}

export async function restoreTax(before: TaxSnapshot): Promise<void> {
  const keep = new Set(before.adjustmentIds);
  const now = await rest<{ id: string }[]>('GET', 'tax_adjustments', 'select=id');
  for (const row of now) {
    if (!keep.has(row.id)) await rest('DELETE', 'tax_adjustments', `id=eq.${row.id}`);
  }
  for (const p of before.periods) {
    await rest('PATCH', 'accounting_periods', `id=eq.${p.id}`, {
      status: p.status,
      filed_at: p.filed_at,
    });
  }
  const { id, ...fields } = before.entity;
  await rest('PATCH', 'entities', `id=eq.${id}`, fields);
}

/** Read the live tax data the way the app does, for checking what a test wrote. */
export async function readAdjustments(): Promise<
  { id: string; direction: string; amount: number; source: string; description: string }[]
> {
  return rest(
    'GET',
    'tax_adjustments',
    'select=id,direction,amount,source,description&source=eq.manual'
  );
}

export async function readPeriod(label: string) {
  const rows = await rest<{ id: string; status: string }[]>(
    'GET',
    'accounting_periods',
    `select=id,status&label=eq.${encodeURIComponent(label)}`
  );
  return rows[0];
}

export async function readEntityTax(id: string) {
  const rows = await rest<TaxSnapshot['entity'][]>(
    'GET',
    'entities',
    `select=id,company_number,tax_reference,vat_registered,vat_number&id=eq.${id}`
  );
  return rows[0];
}

// ─── Journals (for tests that write, post and reverse journals) ────────────────────────────────

export interface JournalSnapshot {
  journals: { id: string; status: string; posted_at: string | null }[];
  lines: { id: string; account_id: string }[];
}

export async function snapshotJournals(): Promise<JournalSnapshot> {
  const [journals, lines] = await Promise.all([
    rest<JournalSnapshot['journals']>('GET', 'journals', 'select=id,status,posted_at&limit=5000'),
    rest<JournalSnapshot['lines']>('GET', 'journal_line_items', 'select=id,account_id&limit=20000'),
  ]);
  return { journals, lines };
}

/** Put every changed journal and line back, and remove journals a test wrote. */
export async function restoreJournals(before: JournalSnapshot): Promise<void> {
  const now = await snapshotJournals();
  const was = new Map(before.journals.map(j => [j.id, j]));
  for (const j of now.journals) {
    const original = was.get(j.id);
    if (!original) {
      await rest('DELETE', 'journal_line_items', `journal_id=eq.${j.id}`);
      await rest('DELETE', 'journals', `id=eq.${j.id}`);
    } else if (original.status !== j.status || original.posted_at !== j.posted_at) {
      await rest('PATCH', 'journals', `id=eq.${j.id}`, {
        status: original.status,
        posted_at: original.posted_at,
      });
    }
  }
  const lineWas = new Map(before.lines.map(l => [l.id, l.account_id]));
  for (const l of now.lines) {
    if (lineWas.has(l.id) && lineWas.get(l.id) !== l.account_id) {
      await rest('PATCH', 'journal_line_items', `id=eq.${l.id}`, { account_id: lineWas.get(l.id) });
    }
  }
}

export async function readJournalsByDescription(description: string) {
  return rest<{ id: string; status: string; source_type: string | null }[]>(
    'GET',
    'journals',
    `select=id,status,source_type&description=eq.${encodeURIComponent(description)}`
  );
}

export async function readJournalByDescription(description: string) {
  return (await readJournalsByDescription(description))[0];
}

// ─── Payment matching (an invoice's bank payment) ──────────────────────────────────────────────

export interface BorrowedTxn {
  id: string;
  restore: () => Promise<void>;
}

/**
 * Make an unmatched bank transaction of the given direction look like the payment for an invoice
 * (its amount and counterparty), and hand back how to put it back as it was.
 */
export async function borrowTransaction(
  direction: 'in' | 'out',
  amount: number,
  counterparty: string
): Promise<BorrowedTxn> {
  const rows = await rest<
    {
      id: string;
      amount: number;
      base_amount: number;
      counterparty_name: string | null;
      metadata: Record<string, unknown> | null;
    }[]
  >(
    'GET',
    'financial_transactions',
    `select=id,amount,base_amount,counterparty_name,metadata&direction=eq.${direction}&excluded_reason=is.null&external_transaction_id=like.e2e-txn-*&order=external_transaction_id.desc&limit=40`
  );
  const row = rows.find(r => !r.metadata?.invoice_id);
  if (!row) throw new Error('No unmatched transaction to borrow');
  await rest('PATCH', 'financial_transactions', `id=eq.${row.id}`, {
    amount,
    base_amount: amount,
    counterparty_name: counterparty,
  });
  return {
    id: row.id,
    restore: async () => {
      await rest('PATCH', 'financial_transactions', `id=eq.${row.id}`, {
        amount: row.amount,
        base_amount: row.base_amount,
        counterparty_name: row.counterparty_name,
        metadata: row.metadata ?? {},
      });
    },
  };
}

export async function readTxnInvoiceId(id: string): Promise<unknown> {
  const rows = await rest<{ metadata: Record<string, unknown> | null }[]>(
    'GET',
    'financial_transactions',
    `select=metadata&id=eq.${id}`
  );
  return rows[0]?.metadata?.invoice_id;
}
