/**
 * Reclassification API Route (Temporary Tool)
 *
 * Handles unit cost mutations for the reclassification tools page.
 * - upsertUnitCost: creates or updates an inventory_item's unit_cost for a product
 */

import type { ActionFunctionArgs } from 'react-router';
import { getServerSupabaseClient } from '~/lib/supabase';

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const supabase = getServerSupabaseClient();
  let body: Record<string, string>;

  try {
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      body = await request.json();
    } else {
      const fd = await request.formData();
      body = Object.fromEntries(fd.entries()) as Record<string, string>;
    }
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { intent, productId, inventoryItemId, entityId, unitCost } = body;

  if (intent === 'linkInvoice') {
    const { transactionId, invoiceId, invoiceNumber } = body;
    if (!transactionId || !invoiceId) {
      return json({ error: 'transactionId and invoiceId are required' }, { status: 400 });
    }
    // Read the current metadata so we only update the invoice_id key
    const { data: ft, error: fetchErr } = await supabase
      .from('financial_transactions')
      .select('metadata')
      .eq('id', transactionId)
      .single();
    if (fetchErr || !ft) return json({ error: fetchErr?.message ?? 'Transaction not found' }, { status: 404 });

    const updatedMetadata = { ...(ft.metadata ?? {}), invoice_id: invoiceNumber ?? invoiceId };
    const { error: updateErr } = await supabase
      .from('financial_transactions')
      .update({ metadata: updatedMetadata })
      .eq('id', transactionId);

    if (updateErr) return json({ error: updateErr.message }, { status: 500 });
    return json({ ok: true, action: 'linked', transactionId, invoiceNumber });
  }

  if (intent !== 'upsertUnitCost') {
    return json({ error: `Unknown intent: ${intent}` }, { status: 400 });
  }

  const parsed = parseFloat(unitCost);
  if (isNaN(parsed) || parsed < 0) {
    return json({ error: 'unitCost must be a non-negative number' }, { status: 400 });
  }

  if (!productId || !entityId) {
    return json({ error: 'productId and entityId are required' }, { status: 400 });
  }

  // Update existing inventory_item if id is provided
  if (inventoryItemId) {
    const { error } = await supabase
      .from('inventory_items')
      .update({ unit_cost: parsed, updated_at: new Date().toISOString() })
      .eq('id', inventoryItemId)
      .eq('entity_id', entityId);

    if (error) return json({ error: error.message }, { status: 500 });
    return json({ ok: true, action: 'updated', inventoryItemId });
  }

  // Check if an inventory_item already exists for this product + entity
  const { data: existing } = await supabase
    .from('inventory_items')
    .select('id')
    .eq('product_id', productId)
    .eq('entity_id', entityId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('inventory_items')
      .update({ unit_cost: parsed, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) return json({ error: error.message }, { status: 500 });
    return json({ ok: true, action: 'updated', inventoryItemId: existing.id });
  }

  // Insert a new inventory_item
  const { data: inserted, error: insertError } = await supabase
    .from('inventory_items')
    .insert({
      entity_id: entityId,
      product_id: productId,
      provider: 'manual',
      variant_external_id: productId,
      unit_cost: parsed,
      is_unlimited: false,
    })
    .select('id')
    .single();

  if (insertError) return json({ error: insertError.message }, { status: 500 });
  return json({ ok: true, action: 'inserted', inventoryItemId: inserted.id });
}
