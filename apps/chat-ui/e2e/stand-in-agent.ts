/**
 * A stand-in for the FastAPI agent, for the one server-side call the Inventory page makes:
 * POST /accounting/inventory/disposal (recording a gift or write-off).
 *
 * The real endpoint writes the movement and its journal in one transaction. This stand-in
 * writes only the movement, straight into the local test database, which is all the page
 * reads back. It is started by Playwright (see playwright.config.ts) and refuses to run
 * unless Supabase is the local stack.
 *
 * A quantity above 1,000 is refused with a 422, so a test can exercise the error path.
 */

import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase, loadTestEnv, requireEnv } from './env';
import { STAND_IN_NOTE } from './helpers/db';

loadTestEnv();
const supabase = createClient(
  assertLocalSupabase(process.env.SUPABASE_URL),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const PORT = Number(process.env.STAND_IN_AGENT_PORT ?? 8099);

function send(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });

  if (req.method === 'POST' && req.url === '/accounting/inventory/disposal') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as {
      inventory_item_id?: string;
      disposal_type?: string;
      quantity?: number;
    };
    if (!body.inventory_item_id || !['GIFT', 'WRITE_OFF'].includes(body.disposal_type ?? '')) {
      return send(res, 400, { detail: 'Invalid disposal' });
    }
    const quantity = Number(body.quantity);
    if (!(quantity > 0) || quantity > 1000) {
      return send(res, 422, { detail: 'Quantity exceeds the stock that can be disposed of' });
    }
    const { data: item } = await supabase
      .from('inventory_items')
      .select('unit_cost')
      .eq('id', body.inventory_item_id)
      .single();
    const { error } = await supabase.from('inventory_movements').insert({
      inventory_item_id: body.inventory_item_id,
      transaction_type: body.disposal_type,
      quantity: -quantity,
      unit_cost: item?.unit_cost ?? 0,
      movement_date: new Date().toISOString(),
      movement_date_source: 'backdated',
      notes: STAND_IN_NOTE,
    });
    if (error) return send(res, 500, { detail: error.message });
    return send(res, 200, { success: true });
  }

  send(res, 404, { detail: 'Not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`Stand-in agent on :${PORT}`));
