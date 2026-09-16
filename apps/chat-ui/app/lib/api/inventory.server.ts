/**
 * Inventory — Server-side data layer
 *
 * Fetches all inventory items joined with product info, grouped by product,
 * enriched with variant selling price from the products.variants JSONB.
 * Also provides a flat inventory list view for the management section,
 * inventory movements history, and valuation data.
 */

import { getServerSupabaseClient } from '~/lib/supabase';

export interface VariantCostItem {
  inventoryItemId: string;
  variantExternalId: string;
  sku: string | null;
  unitCost: number;
  /** Selling price from products.variants JSONB */
  sellingPrice: number | null;
  /** SIZE / COLOUR etc from variants.attributes */
  attributes: Record<string, string>;
}

export interface ProductCostGroup {
  productId: string;
  productName: string;
  /** Selling price of the first variant (for display reference only) */
  baseSellPrice: number | null;
  variants: VariantCostItem[];
  /** true if every variant has unit_cost > 0 */
  fullyCosted: boolean;
  /** Number of variants with unit_cost = 0 */
  uncostedCount: number;
}

export interface InventoryCostData {
  groups: ProductCostGroup[];
  totalItems: number;
  costedItems: number;
  uncostedItems: number;
}

export async function getInventoryCostData(): Promise<InventoryCostData> {
  const supabase = getServerSupabaseClient();

  const { data, error } = await supabase
    .from('inventory_items')
    .select(
      `
      id,
      variant_external_id,
      sku,
      unit_cost,
      is_unlimited,
      product_id,
      products!inner (
        id,
        name,
        variants
      )
      `
    )
    .order('product_id');

  if (error) throw new Error(`Failed to load inventory items: ${error.message}`);

  // Build a map of productId → group
  const groupMap = new Map<string, ProductCostGroup>();

  for (const row of data || []) {
    const product = (row as any).products;
    if (!product) continue;

    const productId: string = product.id;
    const variantArr: any[] = Array.isArray(product.variants) ? product.variants : [];

    // Find this variant's details in the product JSONB
    const variantDetail = variantArr.find((v: any) => v.external_id === row.variant_external_id);

    const sellingPrice = variantDetail?.price?.amount ? Number(variantDetail.price.amount) : null;

    const attributes: Record<string, string> = variantDetail?.attributes ?? {};

    const unitCost = Number(row.unit_cost ?? 0);

    const item: VariantCostItem = {
      inventoryItemId: row.id,
      variantExternalId: row.variant_external_id,
      sku: row.sku,
      unitCost,
      sellingPrice,
      attributes,
    };

    if (!groupMap.has(productId)) {
      groupMap.set(productId, {
        productId,
        productName: product.name || 'Unnamed Product',
        baseSellPrice: sellingPrice,
        variants: [],
        fullyCosted: true,
        uncostedCount: 0,
      });
    }

    const group = groupMap.get(productId)!;
    group.variants.push(item);

    if (unitCost <= 0) {
      group.uncostedCount += 1;
      group.fullyCosted = false;
    }

    // Use first non-null selling price as the base
    if (group.baseSellPrice === null && sellingPrice !== null) {
      group.baseSellPrice = sellingPrice;
    }
  }

  // Sort: uncosted first, then by product name
  const groups = Array.from(groupMap.values()).sort((a, b) => {
    if (a.fullyCosted !== b.fullyCosted) return a.fullyCosted ? 1 : -1;
    return a.productName.localeCompare(b.productName);
  });

  // Sort variants within each group by attributes (size order)
  const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', 'ONE SIZE'];
  for (const group of groups) {
    group.variants.sort((a, b) => {
      const sA = a.attributes['SIZE'] ?? a.attributes['size'] ?? '';
      const sB = b.attributes['SIZE'] ?? b.attributes['size'] ?? '';
      const iA = sizeOrder.indexOf(sA.toUpperCase());
      const iB = sizeOrder.indexOf(sB.toUpperCase());
      if (iA !== -1 && iB !== -1) return iA - iB;
      if (iA !== -1) return -1;
      if (iB !== -1) return 1;
      return (a.sku ?? '').localeCompare(b.sku ?? '');
    });
  }

  const totalItems = (data || []).length;
  const costedItems = (data || []).filter(r => Number(r.unit_cost ?? 0) > 0).length;

  return {
    groups,
    totalItems,
    costedItems,
    uncostedItems: totalItems - costedItems,
  };
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

  // Fetch products
  const { data: productsData, error: productsError } = await supabase
    .from('products')
    .select('id, entity_id, name, provider, status, product_type, variants, created_at')
    .neq('status', 'archived')
    .order('name', { ascending: true });

  if (productsError) throw new Error(`Failed to load products: ${productsError.message}`);

  // Fetch inventory items (may be empty)
  const { data: itemsData, error: itemsError } = await supabase
    .from('inventory_items')
    .select(
      'id, entity_id, product_id, variant_external_id, sku, description, category, unit_cost, is_unlimited, provider, item_type, created_at'
    )
    .order('created_at', { ascending: false });

  if (itemsError) throw new Error(`Failed to load inventory items: ${itemsError.message}`);

  const items = itemsData || [];

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

  function parseVariants(raw: any): ProductVariant[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((v: any) => ({
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

  const products: InventoryProductRow[] = (productsData || []).map(p => {
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
  quantity: number;
  unitCost: number;
  totalCost: number;
  notes: string | null;
  /** Order number for SALE records */
  reference: string | null;
  createdAt: string;
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

  // ── PURCHASE movements ──────────────────────────────────────────────
  const { data: purchaseData, error } = await supabase
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
      inventory_items!inner (
        sku,
        product_id,
        products (
          name
        )
      )
      `
    )
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to load inventory movements: ${error.message}`);

  const purchaseMovements: InventoryMovementRow[] = (purchaseData || []).map((row: any) => ({
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    transactionType: row.transaction_type,
    quantity: Number(row.quantity),
    unitCost: Number(row.unit_cost),
    totalCost: Number(row.quantity) * Number(row.unit_cost),
    notes: row.notes,
    reference: null,
    createdAt: row.created_at,
    sku: row.inventory_items?.sku ?? null,
    productName: row.inventory_items?.products?.name ?? null,
  }));

  // ── SALE movements from orders ───────────────────────────────────────
  // NOTE: PostgREST default limit is 1000; explicit limit avoids silent truncation.
  const { data: saleData } = await supabase
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
    .order('created_at', { ascending: false })
    .limit(10000);

  const saleMovements: InventoryMovementRow[] = [];
  for (const row of saleData || []) {
    const order = (row as any).orders;
    if (!order || order.status === 'cancelled') continue;
    const product = (row as any).products;
    const invItems: any[] = Array.isArray(product?.inventory_items) ? product.inventory_items : [];
    const invItem = invItems[0];
    if (!invItem || Number(invItem.unit_cost) <= 0) continue;

    saleMovements.push({
      id: row.id,
      inventoryItemId: invItem.id,
      transactionType: 'SALE',
      quantity: Number(row.quantity),
      unitCost: Number(invItem.unit_cost),
      totalCost: Number(row.quantity) * Number(invItem.unit_cost),
      notes: null,
      reference: order.order_number ? `Order #${order.order_number}` : null,
      createdAt: order.created_at,
      sku: invItem.sku,
      productName: product?.name ?? null,
    });
  }

  const allMovements = [...purchaseMovements, ...saleMovements].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const totalQuantityPurchased = purchaseMovements.reduce((s, m) => s + m.quantity, 0);
  const totalInvested = purchaseMovements.reduce((s, m) => s + m.totalCost, 0);

  return {
    movements: allMovements,
    totalMovements: allMovements.length,
    totalQuantityPurchased,
    totalInvested,
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

  const { data: items, error: itemsErr } = await supabase
    .from('inventory_items')
    .select('id, sku, unit_cost, product_id, products(name)');

  if (itemsErr) throw new Error(`Failed to load items: ${itemsErr.message}`);

  const { data: movements, error: movErr } = await supabase
    .from('inventory_movements')
    .select('inventory_item_id, quantity, unit_cost');

  if (movErr) throw new Error(`Failed to load movements: ${movErr.message}`);

  // Sum movements per item
  const movementsByItem = new Map<string, { qty: number; cost: number }>();
  for (const m of movements || []) {
    const key = m.inventory_item_id;
    const existing = movementsByItem.get(key) || { qty: 0, cost: 0 };
    existing.qty += Number(m.quantity);
    existing.cost += Number(m.quantity) * Number(m.unit_cost);
    movementsByItem.set(key, existing);
  }

  const valuationItems: InventoryValuationItem[] = (items || [])
    .map((item: any) => {
      const mov = movementsByItem.get(item.id) || { qty: 0, cost: 0 };
      return {
        id: item.id,
        sku: item.sku,
        productName: item.products?.name ?? null,
        unitCost: Number(item.unit_cost ?? 0),
        totalPurchased: mov.qty,
        totalInvested: mov.cost,
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
  const { data: rows, error } = await supabase
    .from('inventory_on_hand')
    .select(
      'inventory_item_id, product_id, sku, item_type, unit_cost, is_unlimited, ' +
        'units_purchased, units_sold, units_refunded, units_gifted, units_written_off, ' +
        'on_hand, products(id, name, status)'
    );

  if (error) throw new Error(`Failed to load stock levels: ${error.message}`);

  const items: StockLevelRow[] = (rows || [])
    .filter((row: any) => {
      // Samples/materials legitimately have no product — always keep them.
      // Note this is deliberately keyed on item_type, NOT on "product_id is null":
      // an unlinked *sellable* row is a data-quality problem, not stock to display.
      if (row.item_type === 'sample' || row.item_type === 'material') return true;
      if (!row.product_id) return false;
      const status = (row.products as any)?.status;
      return row.products && status !== 'archived' && status !== 'draft';
    })
    .map((row: any) => {
      const onHand = Number(row.on_hand ?? 0);
      const unitCost = Number(row.unit_cost || 0);
      return {
        inventoryItemId: row.inventory_item_id,
        productId: row.product_id ?? null,
        // Product-less rows (samples) fall back to their SKU for a display name
        productName: (row.products as any)?.name ?? row.sku ?? 'Untitled item',
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
  const lowStockCount = sellable.filter(i => !i.isUnlimited && i.onHand > 0 && i.onHand < 10).length;
  const sampleCount = items.filter(i => i.itemType === 'sample').length;

  return { items, totalOnHand, totalStockValue, lowStockCount, sampleCount };
}
