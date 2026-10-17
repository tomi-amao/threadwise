/**
 * Inventory — Server-side data layer
 *
 * Fetches all inventory items joined with product info, grouped by product,
 * enriched with variant selling price from the products.variants JSONB.
 * Also provides a flat inventory list view for the management section,
 * inventory movements history, and valuation data.
 */

import { getServerSupabaseClient } from '~/lib/supabase';
import { fetchAllRows } from './paginate.server';

// Row shapes returned by the queries below. The Supabase client is untyped here (no generated
// database types), so these document each select and keep the shaping code typed. PostgREST
// returns a to-one embed as an object and a to-many embed as an array.
type Num = number | string;
interface RawVariant {
  external_id?: string | null;
  sku?: string | null;
  price?: { amount?: Num | null } | null;
  attributes?: Record<string, string> | null;
}
interface ProductDbRow {
  id: string;
  entity_id: string;
  name: string | null;
  provider: string | null;
  status: string;
  product_type: string | null;
  variants: unknown;
  created_at: string;
}
interface ItemDbRow {
  id: string;
  entity_id: string;
  product_id: string | null;
  variant_external_id: string;
  sku: string | null;
  description: string | null;
  category: string | null;
  unit_cost: Num | null;
  is_unlimited: boolean | null;
  provider: string | null;
  item_type: string | null;
  created_at: string;
}
interface MovementDbRow {
  id: string;
  inventory_item_id: string;
  transaction_type: string;
  quantity: Num;
  unit_cost: Num;
  notes: string | null;
  created_at: string;
  movement_date: string | null;
  inventory_items: {
    sku: string | null;
    product_id: string | null;
    products: { name: string | null } | null;
  } | null;
}
interface SaleLineDbRow {
  id: string;
  quantity: Num;
  orders: { order_number: string | null; created_at: string; status: string } | null;
  products: {
    id: string;
    name: string | null;
    inventory_items: { id: string; sku: string | null; unit_cost: Num | null }[] | null;
  } | null;
}
interface PurchaseDbRow {
  inventory_item_id: string;
  quantity: Num;
  unit_cost: Num;
}
interface ValuationItemDbRow {
  id: string;
  sku: string | null;
  unit_cost: Num | null;
  product_id: string | null;
  products: { name: string | null } | null;
}
interface StockViewDbRow {
  inventory_item_id: string;
  product_id: string | null;
  sku: string | null;
  item_type: string | null;
  unit_cost: Num | null;
  is_unlimited: boolean | null;
  units_purchased: Num | null;
  units_sold: Num | null;
  units_refunded: Num | null;
  units_gifted: Num | null;
  units_written_off: Num | null;
  on_hand: Num | null;
  products: { id: string; name: string | null; status: string } | null;
}

// ─── Inventory List (for management panel) ───────────────────────────────────

export interface InventoryItemRow {
  id: string;
  entityId: string;
  productId: string | null;
  productName: string | null;
  variantExternalId: string;
  sku: string | null;
  description: string | null;
  category: string | null;
  unitCost: number;
  isUnlimited: boolean;
  provider: string | null;
  /** sellable | sample | material — samples are never linked to a product by design */
  itemType: 'sellable' | 'sample' | 'material';
  createdAt: string;
  /** Selling price from product variants JSONB */
  sellingPrice: number | null;
  /** Variant attributes (SIZE, COLOR, etc.) */
  attributes: Record<string, string>;
  /** All variants of the linked product */
  productVariants: ProductVariant[];
}

export interface ProductVariant {
  externalId: string;
  sku: string | null;
  price: number | null;
  attributes: Record<string, string>;
}

export interface InventoryProductRow {
  id: string;
  entityId: string;
  name: string;
  provider: string | null;
  status: string;
  productType: string | null;
  variantCount: number;
  variants: ProductVariant[];
  /** Inventory items linked to this product */
  inventoryItems: InventoryItemRow[];
  /** Whether all inventory items are costed */
  fullyCosted: boolean;
  uncostedCount: number;
  createdAt: string;
}

/** Fetches all products with their linked inventory items. */
export async function getInventoryProductList(): Promise<{
  products: InventoryProductRow[];
  unlinkedItems: InventoryItemRow[];
  allItems: InventoryItemRow[];
  totalProducts: number;
  totalInventoryItems: number;
}> {
  const supabase = getServerSupabaseClient();

  // Both lists are read in full (paged): a plain select() stops at the API's 1,000-row cap.
  // Paging needs a unique order, so these order by id and are sorted below.
  const productsData = (
    await fetchAllRows<ProductDbRow>('products', (from, to) =>
      supabase
        .from('products')
        .select('id, entity_id, name, provider, status, product_type, variants, created_at')
        .neq('status', 'archived')
        .order('id')
        .range(from, to)
    )
  ).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));

  const items = await fetchAllRows<ItemDbRow>('inventory items', (from, to) =>
    supabase
      .from('inventory_items')
      .select(
        'id, entity_id, product_id, variant_external_id, sku, description, category, unit_cost, is_unlimited, provider, item_type, created_at'
      )
      .order('id')
      .range(from, to)
  );

  // Build a map of productId → inventory items
  const itemsByProduct = new Map<string, typeof items>();
  const unlinkedRaw: typeof items = [];

  for (const item of items) {
    if (item.product_id) {
      if (!itemsByProduct.has(item.product_id)) {
        itemsByProduct.set(item.product_id, []);
      }
      itemsByProduct.get(item.product_id)!.push(item);
    } else {
      unlinkedRaw.push(item);
    }
  }

  function parseVariants(raw: unknown): ProductVariant[] {
    if (!Array.isArray(raw)) return [];
    return (raw as RawVariant[]).map(v => ({
      externalId: v.external_id ?? '',
      sku: v.sku ?? null,
      price: v.price?.amount != null ? Number(v.price.amount) : null,
      attributes: v.attributes ?? {},
    }));
  }

  function rawItemToRow(
    item: (typeof items)[number],
    productVariants: ProductVariant[]
  ): InventoryItemRow {
    const variant = productVariants.find(v => v.externalId === item.variant_external_id);
    return {
      id: item.id,
      entityId: item.entity_id,
      productId: item.product_id ?? null,
      productName: null, // filled by caller
      variantExternalId: item.variant_external_id,
      sku: item.sku ?? null,
      description: item.description ?? null,
      category: item.category ?? null,
      unitCost: Number(item.unit_cost ?? 0),
      isUnlimited: item.is_unlimited ?? false,
      provider: item.provider ?? null,
      itemType: (item.item_type ?? 'sellable') as InventoryItemRow['itemType'],
      createdAt: item.created_at,
      sellingPrice: variant?.price ?? null,
      attributes: variant?.attributes ?? {},
      productVariants,
    };
  }

  const products: InventoryProductRow[] = productsData.map(p => {
    const variants = parseVariants(p.variants);
    const linkedItems = (itemsByProduct.get(p.id) ?? []).map(item => {
      const row = rawItemToRow(item, variants);
      row.productName = p.name;
      return row;
    });
    const uncostedCount = linkedItems.filter(i => i.unitCost <= 0).length;
    return {
      id: p.id,
      entityId: p.entity_id,
      name: p.name || 'Unnamed Product',
      provider: p.provider ?? null,
      status: p.status,
      productType: p.product_type ?? null,
      variantCount: variants.length,
      variants,
      inventoryItems: linkedItems,
      fullyCosted: linkedItems.length > 0 && uncostedCount === 0,
      uncostedCount,
      createdAt: p.created_at,
    };
  });

  const unlinkedItems: InventoryItemRow[] = unlinkedRaw.map(item => rawItemToRow(item, []));

  // Flat list of all inventory items (linked + unlinked), newest first
  const allItems: InventoryItemRow[] = [
    ...products.flatMap(p => p.inventoryItems),
    ...unlinkedItems,
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return {
    products,
    unlinkedItems,
    allItems,
    totalProducts: products.length,
    totalInventoryItems: items.length,
  };
}

// ─── Inventory Movements ─────────────────────────────────────────────────────

export interface InventoryMovementRow {
  id: string;
  inventoryItemId: string;
  transactionType: string;
  /** Signed, as stored: purchases are positive; sales, gifts and write-offs are negative. */
  quantity: number;
  unitCost: number;
  totalCost: number;
  notes: string | null;
  /** Order number for sales derived from order lines */
  reference: string | null;
  /** When the movement happened (movement_date), not when the row was written */
  occurredAt: string;
  sku: string | null;
  productName: string | null;
}

export interface InventoryMovementsData {
  movements: InventoryMovementRow[];
  totalMovements: number;
  totalQuantityPurchased: number;
  totalInvested: number;
}

export async function getInventoryMovements(): Promise<InventoryMovementsData> {
  const supabase = getServerSupabaseClient();

  // Recorded movements, in full (paged: a plain select stops at the API's 1,000-row cap).
  // Superseded rows were replaced by a later movement and are left out of on-hand by the
  // inventory_on_hand view, so they are left out of the history too.
  const recorded = await fetchAllRows<MovementDbRow>('inventory movements', (from, to) =>
    supabase
      .from('inventory_movements')
      .select(
        `
        id,
        inventory_item_id,
        transaction_type,
        quantity,
        unit_cost,
        notes,
        created_at,
        movement_date,
        inventory_items!inner (
          sku,
          product_id,
          products (
            name
          )
        )
        `
      )
      .is('superseded_at', null)
      .order('id')
      .range(from, to)
  );

  const movements: InventoryMovementRow[] = recorded.map(row => ({
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    transactionType: row.transaction_type,
    quantity: Number(row.quantity),
    unitCost: Number(row.unit_cost),
    totalCost: Math.abs(Number(row.quantity)) * Number(row.unit_cost),
    notes: row.notes,
    reference: null,
    occurredAt: row.movement_date ?? row.created_at,
    sku: row.inventory_items?.sku ?? null,
    productName: row.inventory_items?.products?.name ?? null,
  }));

  // Sales for items that have no recorded SALE movements. The inventory_on_hand view falls back
  // to order lines for those items, so the history does too. Items that DO have recorded sales
  // are skipped, otherwise each sale would be listed twice (once recorded, once derived).
  const itemsWithRecordedSales = new Set(
    recorded.filter(r => r.transaction_type === 'SALE').map(r => r.inventory_item_id)
  );
  const saleLines = await fetchAllRows<SaleLineDbRow>('order line items', (from, to) =>
    supabase
      .from('order_line_items')
      .select(
        `
        id,
        quantity,
        orders!inner (
          order_number,
          created_at,
          status
        ),
        products!inner (
          id,
          name,
          inventory_items ( id, sku, unit_cost )
        )
        `
      )
      .order('id')
      .range(from, to)
  );

  for (const row of saleLines) {
    const order = row.orders;
    if (!order || order.status === 'cancelled') continue;
    const product = row.products;
    const invItems = Array.isArray(product?.inventory_items) ? product.inventory_items : [];
    const invItem = invItems[0];
    if (!invItem || Number(invItem.unit_cost) <= 0 || itemsWithRecordedSales.has(invItem.id)) {
      continue;
    }
    movements.push({
      id: row.id,
      inventoryItemId: invItem.id,
      transactionType: 'SALE',
      quantity: -Number(row.quantity),
      unitCost: Number(invItem.unit_cost),
      totalCost: Number(row.quantity) * Number(invItem.unit_cost),
      notes: null,
      reference: order.order_number ? `Order #${order.order_number}` : null,
      occurredAt: order.created_at,
      sku: invItem.sku,
      productName: product?.name ?? null,
    });
  }

  movements.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

  // Totals describe purchases only. (They used to sum every movement, so once sales were
  // recorded "units purchased" became net stock and "invested" became net cost.)
  const purchases = movements.filter(m => m.transactionType === 'PURCHASE');
  return {
    movements,
    totalMovements: movements.length,
    totalQuantityPurchased: purchases.reduce((sum, m) => sum + m.quantity, 0),
    totalInvested: purchases.reduce((sum, m) => sum + m.totalCost, 0),
  };
}

// ─── Inventory Valuation ─────────────────────────────────────────────────────

export interface InventoryValuationItem {
  id: string;
  sku: string | null;
  productName: string | null;
  unitCost: number;
  totalPurchased: number;
  totalInvested: number;
}

export async function getInventoryValuation(): Promise<{
  items: InventoryValuationItem[];
  totalInventoryValue: number;
  totalUnitsPurchased: number;
  uniqueProducts: number;
}> {
  const supabase = getServerSupabaseClient();

  const items = await fetchAllRows<ValuationItemDbRow>('inventory items', (from, to) =>
    supabase
      .from('inventory_items')
      .select('id, sku, unit_cost, product_id, products(name)')
      .order('id')
      .range(from, to)
  );

  // Money spent on stock = purchases only. Sales, gifts and write-offs are movements too, but
  // they take stock out; they are not investment. Superseded purchases were replaced, so skipped.
  const purchases = await fetchAllRows<PurchaseDbRow>('inventory purchases', (from, to) =>
    supabase
      .from('inventory_movements')
      .select('inventory_item_id, quantity, unit_cost')
      .eq('transaction_type', 'PURCHASE')
      .is('superseded_at', null)
      .order('id')
      .range(from, to)
  );

  const purchasesByItem = new Map<string, { qty: number; cost: number }>();
  for (const m of purchases) {
    const existing = purchasesByItem.get(m.inventory_item_id) || { qty: 0, cost: 0 };
    existing.qty += Number(m.quantity);
    existing.cost += Number(m.quantity) * Number(m.unit_cost);
    purchasesByItem.set(m.inventory_item_id, existing);
  }

  const valuationItems: InventoryValuationItem[] = items
    .map(item => {
      const bought = purchasesByItem.get(item.id) || { qty: 0, cost: 0 };
      return {
        id: item.id,
        sku: item.sku,
        productName: item.products?.name ?? null,
        unitCost: Number(item.unit_cost ?? 0),
        totalPurchased: bought.qty,
        totalInvested: bought.cost,
      };
    })
    .sort(
      (a: InventoryValuationItem, b: InventoryValuationItem) => b.totalInvested - a.totalInvested
    );

  const totalInventoryValue = valuationItems.reduce((s, v) => s + v.totalInvested, 0);
  const totalUnitsPurchased = valuationItems.reduce((s, v) => s + v.totalPurchased, 0);
  const uniqueProducts = new Set(valuationItems.filter(v => v.productName).map(v => v.productName))
    .size;

  return {
    items: valuationItems,
    totalInventoryValue,
    totalUnitsPurchased,
    uniqueProducts,
  };
}

// ─── Stock Levels ─────────────────────────────────────────────────────────────

export interface StockLevelRow {
  inventoryItemId: string;
  /** Null for samples/materials — a valid state, not a data-quality problem */
  productId: string | null;
  productName: string;
  sku: string | null;
  itemType: 'sellable' | 'sample' | 'material';
  unitCost: number;
  isUnlimited: boolean;
  unitsPurchased: number;
  unitsSold: number;
  unitsRefunded: number;
  unitsGifted: number;
  unitsWrittenOff: number;
  onHand: number;
  stockValue: number;
}

export interface StockData {
  items: StockLevelRow[];
  totalOnHand: number;
  totalStockValue: number;
  lowStockCount: number;
  sampleCount: number;
}

export async function getStockLevels(): Promise<StockData> {
  const supabase = getServerSupabaseClient();

  // On-hand comes from the `inventory_on_hand` view — the single canonical
  // definition, shared with the dashboard, reports and the chat agent. Do not
  // re-derive it here from available_quantity or inventory_movements.
  const rows = await fetchAllRows<StockViewDbRow>('stock levels', (from, to) =>
    supabase
      .from('inventory_on_hand')
      .select(
        'inventory_item_id, product_id, sku, item_type, unit_cost, is_unlimited, ' +
          'units_purchased, units_sold, units_refunded, units_gifted, units_written_off, ' +
          'on_hand, products(id, name, status)'
      )
      .order('inventory_item_id')
      .range(from, to)
  );

  const items: StockLevelRow[] = rows
    .filter(row => {
      // Samples/materials legitimately have no product — always keep them.
      // Note this is deliberately keyed on item_type, NOT on "product_id is null":
      // an unlinked *sellable* row is a data-quality problem, not stock to display.
      if (row.item_type === 'sample' || row.item_type === 'material') return true;
      if (!row.product_id) return false;
      const status = row.products?.status;
      return row.products && status !== 'archived' && status !== 'draft';
    })
    .map(row => {
      const onHand = Number(row.on_hand ?? 0);
      const unitCost = Number(row.unit_cost || 0);
      return {
        inventoryItemId: row.inventory_item_id,
        productId: row.product_id ?? null,
        // Product-less rows (samples) fall back to their SKU for a display name
        productName: row.products?.name ?? row.sku ?? 'Untitled item',
        sku: row.sku,
        itemType: (row.item_type ?? 'sellable') as StockLevelRow['itemType'],
        unitCost,
        isUnlimited: row.is_unlimited ?? false,
        unitsPurchased: Number(row.units_purchased ?? 0),
        unitsSold: Number(row.units_sold ?? 0),
        unitsRefunded: Number(row.units_refunded ?? 0),
        unitsGifted: Number(row.units_gifted ?? 0),
        unitsWrittenOff: Number(row.units_written_off ?? 0),
        onHand,
        stockValue: Math.max(0, onHand) * unitCost,
      };
    })
    .sort((a: StockLevelRow, b: StockLevelRow) => a.productName.localeCompare(b.productName));

  // Totals describe sellable stock; samples are tracked but excluded so they
  // don't inflate headline stock value.
  const sellable = items.filter(i => i.itemType === 'sellable');
  const totalOnHand = sellable.reduce((s, i) => s + Math.max(0, i.onHand), 0);
  const totalStockValue = sellable.reduce((s, i) => s + i.stockValue, 0);
  const lowStockCount = sellable.filter(
    i => !i.isUnlimited && i.onHand > 0 && i.onHand < 10
  ).length;
  const sampleCount = items.filter(i => i.itemType === 'sample').length;

  return { items, totalOnHand, totalStockValue, lowStockCount, sampleCount };
}
