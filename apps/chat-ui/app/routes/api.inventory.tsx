/**
 * Inventory API Route
 * Handles server-side inventory mutations:
 * - POST recordDisposal: record a gift or write-off of stock (dated, journaled)
 */

import { requestAccessToken } from '~/lib/api/agent-auth.server';
import type { ActionFunctionArgs } from 'react-router';
import { getRequestSupabaseClient, requireUser } from '~/lib/supabase-server';

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

    // The item is read as the signed-in user, so one that belongs to another business is simply
    // not found, and the entity sent to the agent is always one the user owns.
    await requireUser(request);
    const { data: item, error: itemError } = await getRequestSupabaseClient(request)
      .from('inventory_items')
      .select('entity_id')
      .eq('id', inventoryItemId)
      .maybeSingle();

    if (itemError) return json({ error: itemError.message }, { status: 500 });
    if (!item?.entity_id) return json({ error: 'Inventory item not found' }, { status: 404 });

    // Recording a disposal writes both the subledger movement and its ledger
    // journal in one atomic step, so this goes through the agent rather than
    // Postgres directly — the same reasoning as invoice status changes.
    const response = await fetch(`${AI_AGENT_URL}/accounting/inventory/disposal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await requestAccessToken(request)}`,
      },
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
