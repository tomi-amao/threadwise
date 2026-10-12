/**
 * Inventory API Route
 * Handles server-side inventory mutations:
 * - POST recordDisposal: record a gift or write-off of stock (dated, journaled)
 */

import type { ActionFunctionArgs } from 'react-router';
import { getServerSupabaseClient } from '~/lib/supabase';

const AI_AGENT_URL = process.env.AI_AGENT_URL || 'http://localhost:8000';

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get('intent') as string;

  if (intent === 'recordDisposal') {
    const inventoryItemId = formData.get('inventoryItemId') as string;
    const disposalType = formData.get('disposalType') as string;
    const quantity = Number(formData.get('quantity'));

    if (!inventoryItemId || !['GIFT', 'WRITE_OFF'].includes(disposalType)) {
      return json({ error: 'Invalid input' }, { status: 400 });
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return json({ error: 'Quantity must be a positive number' }, { status: 400 });
    }

    const supabase = getServerSupabaseClient();
    const { data: item, error: itemError } = await supabase
      .from('inventory_items')
      .select('entity_id')
      .eq('id', inventoryItemId)
      .single();

    if (itemError || !item?.entity_id) {
      return json({ error: itemError?.message ?? 'Inventory item not found' }, { status: 404 });
    }

    // Recording a disposal writes both the subledger movement and its ledger
    // journal in one atomic step, so this goes through the agent rather than
    // Postgres directly — the same reasoning as invoice status changes.
    const response = await fetch(`${AI_AGENT_URL}/accounting/inventory/disposal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_id: item.entity_id,
        inventory_item_id: inventoryItemId,
        disposal_type: disposalType,
        quantity,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return json({ error: `Failed to record disposal: ${detail}` }, { status: response.status });
    }

    const result = await response.json();
    return json({ success: true, ...result });
  }

  return json({ error: 'Unknown intent' }, { status: 400 });
}
