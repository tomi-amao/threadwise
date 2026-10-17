/**
 * Reclassification API Route (Temporary Tool)
 *
 * Handles unit cost mutations for the reclassification tools page.
 * - upsertUnitCost: creates or updates an inventory_item's unit_cost for a product
 */

import type { ActionFunctionArgs } from 'react-router';
import { getUserEntity } from '~/lib/api/entity.server';
import { getServerSupabaseClient } from '~/lib/supabase';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  await requireUser(request);
  // The business comes from the signed-in user's session, never from the request body. Reads and
  // the inventory writes run as the user (row-level security limits them to their business);
  // only the transaction write below is service-role, because users have no write policy on
  // financial transactions, and it happens only after the user's session could read the row.
  const entity = await getUserEntity(request);
  if (!entity) return json({ error: 'No business found for the current user' }, { status: 403 });
  const entityId = entity.id;
  const supabase = getRequestSupabaseClient(request);
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

  const { intent, productId, inventoryItemId, unitCost } = body;

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
    if (fetchErr || !ft)
      return json({ error: fetchErr?.message ?? 'Transaction not found' }, { status: 404 });

    // The invoice has to be this user's too: a number written onto a transaction is how an
    // invoice is later found to be paid.
    const { data: invoice } = await supabase
      .from('invoices')
      .select('id')
      .eq('id', invoiceId)
      .maybeSingle();
    if (!invoice) return json({ error: 'Invoice not found' }, { status: 404 });

    const updatedMetadata = { ...(ft.metadata ?? {}), invoice_id: invoiceNumber ?? invoiceId };
    const { error: updateErr } = await getServerSupabaseClient()
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

  if (!productId) {
    return json({ error: 'productId is required' }, { status: 400 });
  }
  const { data: product } = await supabase
    .from('products')
    .select('id')
    .eq('id', productId)
    .maybeSingle();
  if (!product) return json({ error: 'Product not found' }, { status: 404 });

  // Update existing inventory_item if id is provided
  if (inventoryItemId) {
    const { data: updated, error } = await supabase
      .from('inventory_items')
      .update({ unit_cost: parsed, updated_at: new Date().toISOString() })
      .eq('id', inventoryItemId)
      .eq('entity_id', entityId)
      .select('id');

    if (error) return json({ error: error.message }, { status: 500 });
    if (!updated || updated.length === 0) {
      return json({ error: 'Inventory item not found' }, { status: 404 });
    }
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
