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
