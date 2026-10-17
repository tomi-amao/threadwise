/**
 * Inventory Route (Protected)
 *
 * Stock, items, movements and valuation. The loader reads the four datasets independently, so
 * one failing does not blank the others. The action edits an item (cost, type, product link);
 * recording a gift or write-off goes through /api/inventory.
 */

import type { ActionFunctionArgs, MetaFunction } from 'react-router';
import { useLoaderData } from 'react-router';
import { InventoryPage, type InventoryPageData } from '~/components/inventory';
import {
  getInventoryMovements,
  getInventoryProductList,
  getInventoryValuation,
  getStockLevels,
} from '~/lib/api/inventory.server';
import { getServerSupabaseClient } from '~/lib/supabase';

export const meta: MetaFunction = () => [
  { title: 'Inventory - ThreadWise' },
  {
    name: 'description',
    content: 'Manage inventory items, track movements, and monitor valuation',
  },
];

/** A settled promise's value, or an empty fallback plus a labelled error. */
function settledOr<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  errors: string[],
  label: string
): T {
  if (result.status === 'fulfilled') return result.value;
  const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
  errors.push(`${label}: ${message}`);
  return fallback;
}

export async function loader(): Promise<InventoryPageData> {
  const [itemsResult, movementsResult, valuationResult, stockResult] = await Promise.allSettled([
    getInventoryProductList(),
    getInventoryMovements(),
    getInventoryValuation(),
    getStockLevels(),
  ]);

  const errors: string[] = [];
  const list = settledOr(
    itemsResult,
    { products: [], unlinkedItems: [], allItems: [], totalProducts: 0, totalInventoryItems: 0 },
    errors,
    'Inventory items'
  );
  const movements = settledOr(
    movementsResult,
    { movements: [], totalMovements: 0, totalQuantityPurchased: 0, totalInvested: 0 },
    errors,
    'Inventory movements'
  );
  const valuation = settledOr(
    valuationResult,
    { items: [], totalInventoryValue: 0, totalUnitsPurchased: 0, uniqueProducts: 0 },
    errors,
    'Inventory valuation'
  );
  const stock = settledOr(
    stockResult,
    { items: [], totalOnHand: 0, totalStockValue: 0, lowStockCount: 0, sampleCount: 0 },
    errors,
    'Stock levels'
  );

  return {
    allItems: list.allItems,
    products: list.products.map(p => ({ id: p.id, name: p.name })),
    stock,
    movements,
    valuation,
    errors,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.formData();
  const intent = body.get('intent');
  if (intent !== 'update_item') return { ok: false, error: 'Unknown intent' };

  const inventoryItemId = String(body.get('inventoryItemId') ?? '');
  const unitCost = parseFloat(String(body.get('unitCost') ?? ''));
  const itemType = String(body.get('itemType') ?? '');
  const productId = String(body.get('productId') ?? '');

  if (!inventoryItemId || isNaN(unitCost) || unitCost < 0) {
    return { ok: false, error: 'Enter a unit cost of zero or more' };
  }
  // Mirrors the inventory_items_item_type_check constraint, so the message is readable.
  if (!['sellable', 'sample', 'material'].includes(itemType)) {
    return { ok: false, error: 'Invalid item type' };
  }

  // Samples and materials are standalone stock and must not stay attached to a product, or
  // they would be double-counted against that product's stock.
  const patch: Record<string, unknown> =
    itemType === 'sellable'
      ? { unit_cost: unitCost, item_type: itemType, product_id: productId || null }
      : { unit_cost: unitCost, item_type: itemType, product_id: null };

  const supabase = getServerSupabaseClient();
  const { error } = await supabase.from('inventory_items').update(patch).eq('id', inventoryItemId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export default function InventoryRoute() {
  const data = useLoaderData<typeof loader>();
  return <InventoryPage data={data} />;
}
