/**
 * A stand-in for the FastAPI agent, covering the server-side calls the app makes while it is
 * under test:
 *
 *   POST   /accounting/inventory/disposal          record a gift or write-off (Inventory)
 *   POST   /accounting/invoices/process            "read" an uploaded invoice into a draft
 *   PATCH  /accounting/invoices/{id}/status        move an invoice through its lifecycle
 *   PATCH  /accounting/invoices/{id}               notes, direction, line accounts
 *   POST   /accounting/invoices/{id}/stock         record stock movements for purchase lines
 *   DELETE /accounting/invoices/{id}               remove a draft
 *
 * The real endpoints also post journals and enforce the lifecycle rules; those are tested in
 * the agent's own suite (tests/test_invoice_rules.py, tests/test_invoice_service.py). This
 * stand-in writes only the rows the pages read back, straight into the local test database,
 * and refuses to run unless Supabase is the local stack. It mimics two refusals so the pages'
 * error handling can be exercised: finalising an invoice dated before the 2026 accounting
 * cutoff, and deleting an invoice that is not a draft.
 *
 * Inventory: a quantity above 1,000 is refused with a 422.
 */

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
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

async function readJson<T>(req: import('node:http').IncomingMessage): Promise<T> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}') as T;
}

async function invoiceWithLines(id: string) {
  const { data } = await supabase
    .from('invoices')
    .select(
      'id, entity_id, invoice_number, invoice_type, status, invoice_date, invoice_line_items(id, description, quantity, unit_cost, sku)'
    )
    .eq('id', id)
    .maybeSingle();
  return data;
}

async function processInvoice(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
) {
  const request = new Request('http://stand-in.local/', {
    method: 'POST',
    headers: req.headers as Record<string, string>,
    body: Readable.toWeb(req) as unknown as ReadableStream,
    // @ts-expect-error Node needs this to stream a request body
    duplex: 'half',
  });
  const form = await request.formData();
  const file = form.get('file');
  const entityId = String(form.get('entity_id') ?? '');
  if (!(file instanceof File) || !entityId)
    return send(res, 400, { detail: 'file and entity_id are required' });
  if (file.name.includes('unreadable')) {
    return send(res, 422, { detail: 'Could not read any invoice data from this document' });
  }
  const type = form.get('invoice_type') === 'SALE' ? 'SALE' : 'PURCHASE';
  const name = type === 'SALE' ? 'Stand-in Customer Ltd' : 'Stand-in Supplier Ltd';

  const { data: existing } = await supabase
    .from('contacts')
    .select('id, name, company_name')
    .eq('entity_id', entityId)
    .eq('name', name)
    .maybeSingle();
  const contact =
    existing ??
    (
      await supabase
        .from('contacts')
        .insert({
          entity_id: entityId,
          name,
          company_name: name,
          contact_type: type === 'SALE' ? 'customer' : 'supplier',
        })
        .select('id, name, company_name')
        .single()
    ).data;

  const number = `E2E-UP-${Date.now() % 1_000_000}`;
  const { data: invoice, error } = await supabase
    .from('invoices')
    .insert({
      entity_id: entityId,
      invoice_number: number,
      invoice_type: type,
      status: 'DRAFT',
      counterparty_id: contact?.id,
      currency: 'GBP',
      net_amount: 50,
      tax_amount: 10,
      gross_amount: 60,
      invoice_date: new Date().toISOString(),
      due_date: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      source: 'manual',
      file_path: String(form.get('file_path') ?? '') || null,
    })
    .select('id, invoice_number, invoice_type')
    .single();
  if (error || !invoice) return send(res, 500, { detail: error?.message ?? 'insert failed' });
  await supabase.from('invoice_line_items').insert({
    invoice_id: invoice.id,
    description: 'Uploaded item',
    quantity: 2,
    unit_cost: 25,
    vat_rate: 0.2,
    tax_code: 'STANDARD',
  });
  send(res, 200, { invoice, contact, line_items: [], extraction: { confidence_score: 0.93 } });
}

async function setStatus(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string
) {
  const { status } = await readJson<{ entity_id: string; status: string }>(req);
  const invoice = await invoiceWithLines(id);
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  const leavingDraft =
    invoice.status === 'DRAFT' && ['OPEN', 'PAID', 'PARTIALLY_PAID'].includes(status);
  if (leavingDraft && String(invoice.invoice_date).slice(0, 10) < '2026-01-01') {
    return send(res, 400, {
      detail: `Invoice ${invoice.invoice_number} is dated ${String(invoice.invoice_date).slice(0, 10)}, before the 2026-01-01 accounting cutoff.`,
    });
  }
  const { error } = await supabase.from('invoices').update({ status }).eq('id', id);
  if (error) return send(res, 500, { detail: error.message });
  send(res, 200, {
    invoice: { id, status },
    previous_status: invoice.status,
    purchase_journal: leavingDraft ? { id: 'stand-in' } : null,
    payment_journal: null,
    voided_journals: [],
    warnings: [],
  });
}

async function updateInvoice(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string
) {
  const body = await readJson<{
    notes?: string;
    invoice_type?: string;
    line_item_gl_accounts?: Record<string, string | null>;
  }>(req);
  const patch: Record<string, unknown> = {};
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.invoice_type) patch.invoice_type = body.invoice_type;
  if (Object.keys(patch).length) await supabase.from('invoices').update(patch).eq('id', id);
  for (const [lineId, gl] of Object.entries(body.line_item_gl_accounts ?? {})) {
    await supabase
      .from('invoice_line_items')
      .update({ gl_account_id: gl })
      .eq('id', lineId)
      .eq('invoice_id', id);
  }
  send(res, 200, { id });
}

async function applyStock(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  id: string
) {
  const { decisions } = await readJson<{
    entity_id: string;
    decisions: { line_item_id: string; action: string; sku?: string }[];
  }>(req);
  const invoice = await invoiceWithLines(id);
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  const lines = new Map(
    (
      invoice.invoice_line_items as {
        id: string;
        description: string;
        quantity: number;
        unit_cost: number;
      }[]
    ).map(l => [l.id, l])
  );
  const results = [];
  for (const d of decisions) {
    const line = lines.get(d.line_item_id);
    let recorded = false;
    if (line && d.action !== 'expense' && line.quantity > 0) {
      const sku = d.sku || `e2e-${d.line_item_id.slice(0, 8)}`;
      const { data: item } = await supabase
        .from('inventory_items')
        .upsert(
          {
            entity_id: invoice.entity_id,
            provider: 'manual',
            quantity_source: 'ledger',
            variant_external_id: sku,
            sku,
            description: line.description,
            unit_cost: line.unit_cost,
          },
          { onConflict: 'entity_id,provider,variant_external_id' }
        )
        .select('id')
        .single();
      if (item) {
        await supabase.from('inventory_movements').insert({
          inventory_item_id: item.id,
          transaction_type: 'PURCHASE',
          quantity: line.quantity,
          unit_cost: line.unit_cost,
          reference_id: d.line_item_id,
          reference_table: 'invoice_line_items',
          notes: STAND_IN_NOTE,
        });
        recorded = true;
      }
    }
    results.push({ line_item_id: d.line_item_id, action: d.action, recorded });
  }
  send(res, 200, {
    results,
    recorded: results.filter(r => r.recorded).length,
    not_recorded: results
      .filter(r => r.action !== 'expense' && !r.recorded)
      .map(r => r.line_item_id),
  });
}

async function deleteInvoice(res: import('node:http').ServerResponse, id: string) {
  const invoice = await invoiceWithLines(id);
  if (!invoice) return send(res, 404, { detail: `Invoice not found: ${id}` });
  if (!['DRAFT', 'CANCELLED', 'VOID'].includes(invoice.status)) {
    return send(res, 409, {
      detail: `A ${invoice.status.toLowerCase()} invoice cannot be deleted. Void it instead.`,
    });
  }
  await supabase.from('invoices').delete().eq('id', id);
  send(res, 200, { success: true, deleted: true });
}

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

  const invoiceRoute = /^\/accounting\/invoices\/([0-9a-f-]{36})(\/status|\/stock)?(\?.*)?$/.exec(
    req.url ?? ''
  );
  if (req.method === 'POST' && req.url === '/accounting/invoices/process') {
    return processInvoice(req, res);
  }
  if (invoiceRoute) {
    const [, id, suffix] = invoiceRoute;
    if (req.method === 'PATCH' && suffix === '/status') return setStatus(req, res, id);
    if (req.method === 'POST' && suffix === '/stock') return applyStock(req, res, id);
    if (req.method === 'PATCH' && !suffix) return updateInvoice(req, res, id);
    if (req.method === 'DELETE' && !suffix) return deleteInvoice(res, id);
  }

  send(res, 404, { detail: 'Not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`Stand-in agent on :${PORT}`));
