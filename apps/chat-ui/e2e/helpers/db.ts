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
