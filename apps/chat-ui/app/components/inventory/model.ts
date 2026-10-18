/**
 * Inventory view model: joins the stock-level rows (from the inventory_on_hand view) to the
 * inventory item rows, so every tab and the drawer work from one record per item.
 *
 * Stock states, in the order they are worth looking at:
 *  - oversold  on hand is below zero (more sold than bought: a data or purchasing problem)
 *  - out       nothing left
 *  - low       fewer than LOW_STOCK_BELOW units
 *  - in        healthy
 *  - unlimited stock is not tracked (print-on-demand)
 * Samples and materials are tracked but sit outside the sellable stock picture.
 */

import type { ChipTone } from '~/components/ui/chip';
import type { InventoryItemRow, StockLevelRow } from '~/lib/api/inventory.server';

export const LOW_STOCK_BELOW = 10;

export type StockState = 'oversold' | 'out' | 'low' | 'in' | 'unlimited';

export const STATE_LABEL: Record<StockState, string> = {
  oversold: 'Oversold',
  out: 'Out of stock',
  low: 'Low',
  in: 'In stock',
  unlimited: 'Unlimited',
};

/** Amber is for "needs attention", brick for a real problem. */
export const STATE_TONE: Record<StockState, ChipTone> = {
  oversold: 'negative',
  out: 'active',
  low: 'active',
  in: 'done',
  unlimited: 'plain',
};

export interface InventoryEntry {
  id: string;
  sku: string | null;
  /** Product name, or a readable fallback for samples and unlinked variants. */
  name: string;
  productId: string | null;
  itemType: 'sellable' | 'sample' | 'material';
  provider: string | null;
  attributes: Record<string, string>;
  sellingPrice: number | null;
  unitCost: number;
  isUnlimited: boolean;
  /** Null when the item is not in the stock view (an unlinked sellable variant). */
  stock: StockLevelRow | null;
  onHand: number;
  stockValue: number;
  state: StockState | null;
  linked: boolean;
  costed: boolean;
}

export function stateOf(stock: StockLevelRow): StockState {
  if (stock.isUnlimited) return 'unlimited';
  if (stock.onHand < 0) return 'oversold';
  if (stock.onHand === 0) return 'out';
  if (stock.onHand < LOW_STOCK_BELOW) return 'low';
  return 'in';
}

export function buildEntries(items: InventoryItemRow[], stock: StockLevelRow[]): InventoryEntry[] {
  const stockById = new Map(stock.map(s => [s.inventoryItemId, s]));
  return items
    .map(item => {
      const s = stockById.get(item.id) ?? null;
      const itemType = item.itemType;
      const fallback =
        itemType === 'sample'
          ? 'Development sample'
          : itemType === 'material'
            ? 'Material'
            : 'Unlinked variant';
      return {
        id: item.id,
        sku: item.sku,
        name: item.productName ?? fallback,
        productId: item.productId,
        itemType,
        provider: item.provider,
        attributes: item.attributes,
        sellingPrice: item.sellingPrice,
        unitCost: item.unitCost,
        isUnlimited: item.isUnlimited,
        stock: s,
        onHand: s?.onHand ?? 0,
        stockValue: s?.stockValue ?? 0,
        state: s ? stateOf(s) : null,
        // Samples and materials are never linked by design, so they are never "unlinked".
        linked: itemType !== 'sellable' || !!item.productId,
        costed: item.unitCost > 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.sku ?? '').localeCompare(b.sku ?? ''));
}

/** Margin on one unit at the given cost, or null with no price or cost to compare. */
export function marginOf(price: number | null, cost: number): number | null {
  if (!price || price <= 0 || cost <= 0) return null;
  return ((price - cost) / price) * 100;
}

export const money = (value: number, digits = 0): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

export const int = (value: number): string => new Intl.NumberFormat('en-GB').format(value);

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const MOVEMENT_LABEL: Record<string, string> = {
  PURCHASE: 'Purchase',
  SALE: 'Sale',
  GIFT: 'Gift',
  WRITE_OFF: 'Write-off',
  ADJUSTMENT: 'Adjustment',
};

export const MOVEMENT_TONE: Record<string, ChipTone> = {
  PURCHASE: 'income',
  SALE: 'plain',
  GIFT: 'planned',
  WRITE_OFF: 'negative',
  ADJUSTMENT: 'draft',
};

export interface Summary {
  stockValue: number;
  unitsOnHand: number;
  oversold: number;
  out: number;
  low: number;
  unlinked: number;
  uncosted: number;
  needsAttention: number;
}

/** Headline numbers describe sellable stock only; samples and materials are excluded. */
export function summarise(entries: InventoryEntry[]): Summary {
  const sellable = entries.filter(e => e.itemType === 'sellable');
  const count = (state: StockState) => sellable.filter(e => e.state === state).length;
  const unlinked = sellable.filter(e => !e.linked).length;
  const uncosted = sellable.filter(e => !e.costed && !e.isUnlimited).length;
  const oversold = count('oversold');
  const low = count('low');
  const out = count('out');
  return {
    stockValue: sellable.reduce((s, e) => s + e.stockValue, 0),
    unitsOnHand: sellable.reduce((s, e) => s + Math.max(0, e.onHand), 0),
    oversold,
    out,
    low,
    unlinked,
    uncosted,
    needsAttention: oversold + low + out + unlinked + uncosted,
  };
}
