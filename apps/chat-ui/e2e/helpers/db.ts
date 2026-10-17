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
