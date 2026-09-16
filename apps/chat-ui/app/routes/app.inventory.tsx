/**
 * Inventory Management (Protected)
 *
 * Unified inventory hub with three tabs:
 *  - Items: Full inventory list with inline detail sheet for cost editing & product linking
 *  - Movements: Purchase history timeline from inventory_movements
 *  - Valuation: Investment overview per SKU with total portfolio value
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';
import { useLoaderData, useRevalidator, useFetcher } from 'react-router';
import {
  Package,
  CheckCircle,
  Warning,
  ArrowClockwise,
  List,
  X,
  LinkSimple,
  MagnifyingGlass,
  ArrowSquareOut,
  Cube,
  Check,
  TrendUp,
  ArrowDown,
  Clock,
  CurrencyGbp,
  ChartBar,
  Receipt,
  StackSimple,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import {
  getInventoryProductList,
  getInventoryMovements,
  getInventoryValuation,
  getStockLevels,
} from '~/lib/api/inventory.server';
import { getServerSupabaseClient } from '~/lib/supabase';
import type {
  InventoryItemRow,
  InventoryMovementRow,
  InventoryValuationItem,
  StockLevelRow,
  StockData,
} from '~/lib/api/inventory.server';

export const meta: MetaFunction = () => [
  { title: 'Inventory - ThreadWise' },
  {
    name: 'description',
    content: 'Manage inventory items, track movements, and monitor valuation',
  },
];

// ─── Loader ───────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const [inventoryData, movementsData, valuationData, stockData] = await Promise.all([
    getInventoryProductList(),
    getInventoryMovements(),
    getInventoryValuation(),
    getStockLevels(),
  ]);
  return { inventoryData, movementsData, valuationData, stockData };
}

// ─── Action ───────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.formData();
  const intent = body.get('intent');

  if (intent === 'link_to_product') {
    const inventoryItemId = String(body.get('inventoryItemId') ?? '');
    const productId = String(body.get('productId') ?? '');

    if (!inventoryItemId || !productId) {
      return { ok: false, error: 'Missing inventoryItemId or productId' };
    }

    const supabase = getServerSupabaseClient();
    const { error } = await supabase
      .from('inventory_items')
      .update({ product_id: productId })
      .eq('id', inventoryItemId);

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  if (intent === 'update_item_cost') {
    const inventoryItemId = String(body.get('inventoryItemId') ?? '');
    const unitCost = parseFloat(String(body.get('unitCost') ?? ''));

    if (!inventoryItemId || isNaN(unitCost) || unitCost < 0) {
      return { ok: false, error: 'Invalid input' };
    }

    const supabase = getServerSupabaseClient();
    const { error } = await supabase
      .from('inventory_items')
      .update({ unit_cost: unitCost })
      .eq('id', inventoryItemId);

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  if (intent === 'update_item_type') {
    const inventoryItemId = String(body.get('inventoryItemId') ?? '');
    const itemType = String(body.get('itemType') ?? '');

    // Mirrors the inventory_items_item_type_check DB constraint — reject early
    // with a readable message rather than surfacing a Postgres constraint error.
    if (!inventoryItemId || !['sellable', 'sample', 'material'].includes(itemType)) {
      return { ok: false, error: 'Invalid item type' };
    }

    const supabase = getServerSupabaseClient();

    // Samples/materials are standalone stock and must not stay attached to a
    // product, otherwise they'd be double-counted against that product's stock.
    const patch: Record<string, unknown> =
      itemType === 'sellable' ? { item_type: itemType } : { item_type: itemType, product_id: null };

    const { error } = await supabase
      .from('inventory_items')
      .update(patch)
      .eq('id', inventoryItemId);

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  return { ok: false, error: 'Unknown intent' };
}

// ─── Helpers ──────────────────────────────────────────────────────────

const GBP = (v: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);

const marginColor = (pct: number) => {
  if (pct >= 60) return 'text-emerald-500';
  if (pct >= 40) return 'text-amber-500';
  return 'text-rose-500';
};

type TabId = 'items' | 'movements' | 'valuation' | 'stock';

// ─── Product Search Combobox ──────────────────────────────────────────

function ProductSearchCombobox({
  products,
  value,
  onChange,
}: {
  products: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const selected = value ? products.find(p => p.id === value) : null;

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return products.slice(0, 50);
    return products.filter(p => p.name.toLowerCase().includes(q)).slice(0, 50);
  }, [products, query]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      const inTrigger = ref.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inTrigger && !inDropdown) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 2,
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
        pointerEvents: 'auto',
      });
    }
  }, [open]);

  return (
    <div ref={ref} className="relative w-full">
      <div
        className={`flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2 cursor-pointer text-sm transition-colors ${
          open
            ? 'border-primary ring-1 ring-primary/30'
            : 'border-border hover:border-muted-foreground/40'
        }`}
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <MagnifyingGlass size={14} className="text-muted-foreground shrink-0" />
        {selected && !open ? (
          <>
            <span className="flex-1 truncate text-sm text-foreground font-medium">
              {selected.name}
            </span>
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                onChange('');
                setQuery('');
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X size={13} />
            </button>
          </>
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            placeholder={selected ? selected.name : 'Search products\u2026'}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground text-foreground min-w-0"
          />
        )}
      </div>
      {open &&
        filtered.length > 0 &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={dropdownRef}
            style={dropdownStyle}
            onPointerDown={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            className="rounded-lg border border-border bg-card shadow-xl max-h-52 overflow-y-auto"
          >
            {filtered.map(product => (
              <button
                key={product.id}
                type="button"
                onClick={() => {
                  onChange(product.id);
                  setQuery('');
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted transition-colors ${
                  product.id === value
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-foreground'
                }`}
              >
                <Package size={13} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{product.name}</span>
                {product.id === value && (
                  <Check size={13} className="ml-auto shrink-0 text-primary" />
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
      {open &&
        filtered.length === 0 &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={dropdownRef}
            style={dropdownStyle}
            onPointerDown={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            className="rounded-lg border border-border bg-card shadow-xl px-3 py-3 text-sm text-muted-foreground"
          >
            {query.trim() ? `No products match "${query}"` : 'No products found'}
          </div>,
          document.body
        )}
    </div>
  );
}

// ─── Inventory Detail Sheet ───────────────────────────────────────────

function InventoryDetailSheet({
  item,
  allProducts,
  onClose,
  onLinkItem,
  onUpdateCost,
  onUpdateItemType,
}: {
  item: InventoryItemRow | null;
  allProducts: { id: string; name: string }[];
  onClose: () => void;
  onLinkItem: (inventoryItemId: string, productId: string) => void;
  onUpdateCost: (inventoryItemId: string, unitCost: number) => void;
  onUpdateItemType: (inventoryItemId: string, itemType: InventoryItemRow['itemType']) => void;
}) {
  const [costStr, setCostStr] = useState('');
  const [showRelink, setShowRelink] = useState(false);
  const [linkProductId, setLinkProductId] = useState('');

  useEffect(() => {
    if (item) {
      setCostStr(String(item.unitCost));
      setShowRelink(false);
      setLinkProductId('');
    }
  }, [item?.id]);

  if (!item) return null;

  const marginPct =
    item.sellingPrice && item.unitCost > 0
      ? ((item.sellingPrice - item.unitCost) / item.sellingPrice) * 100
      : null;

  const providerBadge =
    item.provider === 'squarespace'
      ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
      : item.provider === 'invoice'
        ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
        : 'bg-muted text-muted-foreground border-border';

  const otherVariants = item.productVariants.filter(v => v.externalId !== item.variantExternalId);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full z-50 w-full max-w-md bg-card border-l border-border shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border bg-card/95">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${providerBadge}`}
              >
                {item.provider ?? 'unknown'}
              </span>
              {item.itemType === 'sample' ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium">
                  Sample
                </span>
              ) : item.productId ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                  Linked
                </span>
              ) : (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium flex items-center gap-1">
                  <Warning size={10} weight="fill" />
                  Unlinked
                </span>
              )}
            </div>
            <h2 className="mt-1.5 text-sm font-semibold text-foreground leading-snug">
              {item.sku ?? item.variantExternalId ?? 'Unknown Item'}
            </h2>
            {item.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {item.description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Cost + selling price */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Unit Cost
              </h3>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                  &pound;
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={costStr}
                  onChange={e => setCostStr(e.target.value)}
                  onBlur={() => {
                    const v = parseFloat(costStr);
                    if (!isNaN(v) && v >= 0 && v !== item.unitCost) onUpdateCost(item.id, v);
                  }}
                  className="w-full bg-muted border border-border rounded-lg pl-6 pr-2 py-2 text-sm text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div>
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Sell Price
              </h3>
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 rounded-lg h-[38px]">
                <span className="text-sm font-medium text-foreground tabular-nums">
                  {item.sellingPrice != null ? GBP(item.sellingPrice) : '\u2014'}
                </span>
                {marginPct !== null && (
                  <span
                    className={`ml-auto text-xs font-semibold tabular-nums ${marginColor(marginPct)}`}
                  >
                    {marginPct.toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Variant attributes */}
          {Object.keys(item.attributes).length > 0 && (
            <div>
              <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Variant
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(item.attributes).map(([k, v]) => (
                  <span key={k} className="text-xs px-2 py-1 bg-muted rounded-md font-medium">
                    <span className="text-muted-foreground">{k}: </span>
                    {v}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Item type selector */}
          <section>
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Item Type
            </h3>
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              {(
                [
                  { id: 'sellable', label: 'Sellable' },
                  { id: 'sample', label: 'Sample' },
                  { id: 'material', label: 'Material' },
                ] as const
              ).map(t => (
                <button
                  key={t.id}
                  onClick={() => {
                    if (t.id !== item.itemType) onUpdateItemType(item.id, t.id);
                  }}
                  className={`flex-1 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                    item.itemType === t.id
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              {item.itemType === 'sellable'
                ? 'Stock you sell. Counts toward stock value and needs a linked product.'
                : item.itemType === 'sample'
                  ? 'Development stock that was never sold. Tracked separately and never linked to a product.'
                  : 'Raw materials or components. Tracked separately from sellable stock.'}
            </p>
            {item.itemType === 'sellable' && item.productId && (
              <p className="text-[11px] text-amber-400/80 mt-1.5">
                Switching away from Sellable will unlink this item from its product.
              </p>
            )}
          </section>

          {/* Linked product section — samples are standalone stock by design,
              so they get an explainer instead of a link prompt. */}
          <section>
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Product
            </h3>
            {item.itemType !== 'sellable' ? (
              <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                <p className="text-xs text-violet-300 font-medium mb-1">
                  {item.itemType === 'sample' ? 'Sample item' : 'Material'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {item.itemType === 'sample'
                    ? 'Samples track development stock that was never sold through a storefront, so they’re intentionally not linked to a product.'
                    : 'Materials are components tracked on their own, so they’re not linked to a product.'}
                </p>
              </div>
            ) : item.productId && item.productName && !showRelink ? (
              <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <Package size={15} className="text-primary shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground leading-snug">
                        {item.productName}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {item.productVariants.length} variant
                        {item.productVariants.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowRelink(true)}
                    className="text-[11px] text-muted-foreground hover:text-foreground border border-border rounded px-2 py-0.5 hover:bg-muted transition-colors shrink-0"
                  >
                    Relink
                  </button>
                </div>
                {otherVariants.length > 0 && (
                  <div className="pt-2 border-t border-border/50">
                    <p className="text-[11px] text-muted-foreground mb-1.5">Other variants:</p>
                    <div className="space-y-1">
                      {otherVariants.slice(0, 5).map(v => (
                        <div
                          key={v.externalId}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-muted-foreground font-mono text-[11px]">
                            {Object.values(v.attributes).join('/') || v.sku || v.externalId}
                          </span>
                          <span className="text-foreground tabular-nums">
                            {v.price != null ? GBP(v.price) : '\u2014'}
                          </span>
                        </div>
                      ))}
                      {otherVariants.length > 5 && (
                        <p className="text-[11px] text-muted-foreground">
                          +{otherVariants.length - 5} more
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div
                className={`rounded-lg border p-3 ${showRelink ? 'border-primary/20 bg-primary/5' : 'border-dashed border-amber-500/30 bg-amber-500/5'}`}
              >
                {showRelink ? (
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-muted-foreground font-medium">
                      Select a product to link:
                    </p>
                    <button
                      onClick={() => {
                        setShowRelink(false);
                        setLinkProductId('');
                      }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 mb-3">
                    <Warning size={14} className="text-amber-500 shrink-0" weight="fill" />
                    <p className="text-xs text-amber-400 font-medium">Not linked to any product</p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mb-3">
                  {showRelink
                    ? 'Select a product to reassign this inventory item.'
                    : 'Link this item to a product to enable COGS tracking on orders.'}
                </p>
                <ProductSearchCombobox
                  products={allProducts}
                  value={linkProductId}
                  onChange={id => setLinkProductId(id)}
                />
                {linkProductId && (
                  <Button
                    size="sm"
                    className="mt-3 gap-1.5 h-8 text-xs w-full"
                    onClick={() => {
                      onLinkItem(item.id, linkProductId);
                      onClose();
                    }}
                  >
                    <LinkSimple size={13} />
                    {showRelink ? 'Reassign Product' : 'Link to Selected Product'}
                  </Button>
                )}
              </div>
            )}
          </section>

          {/* System details */}
          <section>
            <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Details
            </h3>
            <dl className="space-y-1.5 text-xs">
              {(
                [
                  ['Category', item.category ?? '\u2014'],
                  ['Unlimited Stock', item.isUnlimited ? 'Yes' : 'No'],
                  ['Variant ID', item.variantExternalId || '\u2014'],
                  ['Item ID', item.id],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="text-muted-foreground shrink-0">{label}</dt>
                  <dd className="text-foreground text-right font-mono truncate max-w-[220px]">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}

// ─── Items Tab ────────────────────────────────────────────────────────

function ItemsTab({
  allItems,
  onSelectItem,
}: {
  allItems: InventoryItemRow[];
  onSelectItem: (item: InventoryItemRow) => void;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterLinked, setFilterLinked] = useState<'all' | 'linked' | 'unlinked' | 'samples'>('all');

  // Samples are never linked to a product by design, so they're excluded from the
  // linked/unlinked split entirely — counting them as "unlinked" made the warning
  // banner permanently un-actionable.
  const sellableItems = useMemo(() => allItems.filter(i => i.itemType === 'sellable'), [allItems]);
  const sampleItems = useMemo(() => allItems.filter(i => i.itemType === 'sample'), [allItems]);
  const linkedCount = useMemo(
    () => sellableItems.filter(i => i.productId != null).length,
    [sellableItems]
  );
  const unlinkedCount = sellableItems.length - linkedCount;
  const costedCount = useMemo(() => allItems.filter(i => i.unitCost > 0).length, [allItems]);

  const filteredItems = useMemo(() => {
    let list = filterLinked === 'samples' ? sampleItems : sellableItems;
    if (filterLinked === 'linked') list = list.filter(i => i.productId != null);
    if (filterLinked === 'unlinked') list = list.filter(i => i.productId == null);
    const q = searchQuery.toLowerCase().trim();
    if (q) {
      list = list.filter(
        i =>
          i.sku?.toLowerCase().includes(q) ||
          i.description?.toLowerCase().includes(q) ||
          i.productName?.toLowerCase().includes(q) ||
          i.variantExternalId?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [sellableItems, sampleItems, filterLinked, searchQuery]);

  return (
    <div className="space-y-4">
      {/* Cost coverage bar */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-sm font-semibold text-foreground">Cost Coverage</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {costedCount} of {allItems.length} items have a unit cost set
            </p>
          </div>
          <p className="text-xl font-bold text-foreground tabular-nums">
            {allItems.length > 0 ? Math.round((costedCount / allItems.length) * 100) : 0}%
          </p>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-500"
            style={{ width: `${allItems.length > 0 ? (costedCount / allItems.length) * 100 : 0}%` }}
          />
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          {(['all', 'linked', 'unlinked', 'samples'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilterLinked(f)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${filterLinked === f ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {f === 'all'
                ? `All (${sellableItems.length})`
                : f === 'linked'
                  ? `Linked (${linkedCount})`
                  : f === 'unlinked'
                    ? `Unlinked (${unlinkedCount})`
                    : `Samples (${sampleItems.length})`}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <MagnifyingGlass
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search by SKU, product\u2026"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-card border border-border rounded-lg pl-7 pr-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-52"
          />
        </div>
      </div>

      {/* Unlinked warning — never shown for samples, which are unlinked by design */}
      {unlinkedCount > 0 && filterLinked !== 'linked' && filterLinked !== 'samples' && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2.5 flex items-center gap-2">
          <Warning size={14} className="text-amber-500 shrink-0" weight="fill" />
          <p className="text-xs text-amber-400">
            <strong>{unlinkedCount}</strong> item{unlinkedCount !== 1 ? 's' : ''} not linked to a
            product &mdash; click to assign one and enable COGS tracking.
          </p>
        </div>
      )}

      {/* Table */}
      {filteredItems.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Cube size={32} weight="thin" className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {searchQuery ? 'No items match your search.' : 'No inventory items found.'}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="grid grid-cols-[1fr_160px_88px_76px_72px_32px] items-center gap-2 px-4 py-2.5 bg-muted/30 border-b border-border text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            <span>Item / SKU</span>
            <span>Product</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Sell</span>
            <span className="text-right">Margin</span>
            <span />
          </div>
          <div className="divide-y divide-border/60">
            {filteredItems.map(item => {
              const marginVal =
                item.sellingPrice && item.unitCost > 0
                  ? ((item.sellingPrice - item.unitCost) / item.sellingPrice) * 100
                  : null;
              const attrStr =
                Object.entries(item.attributes)
                  .map(([, v]) => v)
                  .join('/') || null;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelectItem(item)}
                  className="w-full grid grid-cols-[1fr_160px_88px_76px_72px_32px] items-center gap-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors group"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {item.sku ?? item.variantExternalId ?? 'Unknown'}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {attrStr && (
                        <span className="text-[11px] text-muted-foreground bg-muted/60 px-1.5 rounded shrink-0">
                          {attrStr}
                        </span>
                      )}
                      {item.description && (
                        <span className="text-[11px] text-muted-foreground truncate">
                          {item.description}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="min-w-0">
                    {item.productName ? (
                      <span
                        className="text-xs text-foreground truncate block"
                        title={item.productName}
                      >
                        {item.productName}
                      </span>
                    ) : item.itemType === 'sample' ? (
                      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium">
                        Sample
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 font-medium">
                        <Warning size={10} weight="fill" />
                        Unlinked
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    {item.unitCost > 0 ? (
                      <span className="text-sm font-medium text-foreground tabular-nums">
                        {GBP(item.unitCost)}
                      </span>
                    ) : (
                      <span className="text-sm text-amber-400 font-medium">&mdash;</span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {item.sellingPrice != null ? GBP(item.sellingPrice) : '\u2014'}
                    </span>
                  </div>
                  <div className="text-right">
                    {marginVal !== null ? (
                      <span
                        className={`text-xs font-semibold tabular-nums ${marginColor(marginVal)}`}
                      >
                        {marginVal.toFixed(0)}%
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/40">&mdash;</span>
                    )}
                  </div>
                  <div className="flex justify-center">
                    <ArrowSquareOut
                      size={14}
                      className="text-muted-foreground/40 group-hover:text-primary transition-colors"
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Stock Tab ────────────────────────────────────────────────────────

function stockBadge(item: StockLevelRow) {
  if (item.isUnlimited)
    return { label: 'Unlimited', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/20' };
  if (item.onHand < 0)
    return { label: 'Oversold', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
  if (item.onHand === 0)
    return { label: 'Out of stock', cls: 'bg-muted text-muted-foreground border-border' };
  if (item.onHand < 10)
    return { label: 'Low stock', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' };
  return { label: 'In stock', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
}

/**
 * Click-to-edit control for recording a gift or write-off. Each save ADDS a
 * new, independently dated disposal movement — it does not set a running
 * total. There is no way to represent "reduce the total" as a single dated
 * event, so decreasing the number isn't offered here; correct the underlying
 * movement directly for that.
 */
function DisposalCell({
  inventoryItemId,
  total,
  disposalType,
  colorClass,
}: {
  inventoryItemId: string;
  total: number;
  disposalType: 'GIFT' | 'WRITE_OFF';
  colorClass: string;
}) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const isThisCellSubmitting =
    fetcher.state !== 'idle' &&
    fetcher.formData?.get('inventoryItemId') === inventoryItemId &&
    fetcher.formData?.get('disposalType') === disposalType;
  const pendingAdd = isThisCellSubmitting ? Number(fetcher.formData!.get('quantity') || 0) : 0;
  const optimisticTotal = total + pendingAdd;

  const startEdit = () => {
    setDraftValue('');
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const cancelEdit = () => setEditing(false);

  const commitEdit = () => {
    const val = Math.max(0, Math.floor(Number(draftValue) || 0));
    setEditing(false);
    if (val <= 0) return;
    const fd = new FormData();
    fd.append('intent', 'recordDisposal');
    fd.append('inventoryItemId', inventoryItemId);
    fd.append('disposalType', disposalType);
    fd.append('quantity', String(val));
    fetcher.submit(fd, { method: 'POST', action: '/api/inventory' });
  };

  const label = disposalType === 'GIFT' ? 'gift' : 'write-off';

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={0}
        placeholder="Qty"
        value={draftValue}
        onChange={e => setDraftValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={e => {
          if (e.key === 'Enter') commitEdit();
          if (e.key === 'Escape') cancelEdit();
        }}
        className="w-full text-right text-sm tabular-nums bg-input border border-primary rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
      />
    );
  }

  return (
    <button
      onClick={startEdit}
      title={`Click to record a new ${label} (adds to the total, dated today)`}
      className={`text-sm tabular-nums cursor-pointer hover:text-primary transition-colors ${
        optimisticTotal > 0 ? colorClass : 'text-muted-foreground'
      }`}
    >
      {optimisticTotal > 0 ? optimisticTotal.toLocaleString() : '—'}
    </button>
  );
}

function StockRow({ item }: { item: StockLevelRow }) {
  const badge = stockBadge(item);

  return (
    <div className="grid grid-cols-[1fr_110px_80px_80px_80px_80px_80px_80px_96px_100px] items-center gap-2 px-4 py-3 hover:bg-muted/20 transition-colors">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{item.productName}</p>
        {item.sku && (
          <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">{item.sku}</p>
        )}
      </div>
      <div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      <div className="text-right">
        <span className="text-sm text-foreground tabular-nums">
          {item.isUnlimited ? '\u221e' : item.unitsPurchased.toLocaleString()}
        </span>
      </div>
      <div className="text-right">
        <span className="text-sm text-foreground tabular-nums">
          {item.unitsSold.toLocaleString()}
        </span>
      </div>
      <div className="text-right">
        <span
          className={`text-sm tabular-nums ${item.unitsRefunded > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}
        >
          {item.unitsRefunded > 0 ? item.unitsRefunded.toLocaleString() : '\u2014'}
        </span>
      </div>
      <div className="text-right">
        <DisposalCell
          inventoryItemId={item.inventoryItemId}
          total={item.unitsGifted}
          disposalType="GIFT"
          colorClass="text-violet-400"
        />
      </div>
      <div className="text-right">
        <DisposalCell
          inventoryItemId={item.inventoryItemId}
          total={item.unitsWrittenOff}
          disposalType="WRITE_OFF"
          colorClass="text-orange-400"
        />
      </div>
      <div className="text-right">
        <span
          className={`text-sm font-semibold tabular-nums ${
            item.isUnlimited
              ? 'text-blue-400'
              : item.onHand < 0
                ? 'text-rose-500'
                : item.onHand < 10
                  ? 'text-amber-500'
                  : 'text-foreground'
          }`}
        >
          {item.isUnlimited ? '\u221e' : item.onHand.toLocaleString()}
        </span>
      </div>
      <div className="text-right">
        <span className="text-xs text-muted-foreground tabular-nums">
          {item.unitCost > 0 ? GBP(item.unitCost) : '\u2014'}
        </span>
      </div>
      <div className="text-right">
        <span className="text-sm font-medium text-foreground tabular-nums">
          {item.stockValue > 0 ? GBP(item.stockValue) : '\u2014'}
        </span>
      </div>
    </div>
  );
}

function StockTab({ data }: { data: StockData }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<
    'all' | 'in_stock' | 'low_stock' | 'out_of_stock' | 'oversold' | 'samples'
  >('all');

  // Every filter except "samples" shows sellable stock only, so development
  // samples never mix into the sellable stock picture.
  const sellable = useMemo(() => data.items.filter(i => i.itemType === 'sellable'), [data.items]);
  const samples = useMemo(() => data.items.filter(i => i.itemType === 'sample'), [data.items]);
  const oversoldCount = sellable.filter(i => i.onHand < 0).length;

  const filtered = useMemo(() => {
    let list = filter === 'samples' ? samples : sellable;
    if (filter === 'in_stock') list = list.filter(i => i.isUnlimited || i.onHand >= 10);
    if (filter === 'low_stock')
      list = list.filter(i => !i.isUnlimited && i.onHand > 0 && i.onHand < 10);
    if (filter === 'out_of_stock') list = list.filter(i => !i.isUnlimited && i.onHand === 0);
    if (filter === 'oversold') list = list.filter(i => i.onHand < 0);
    const q = searchQuery.toLowerCase().trim();
    if (q)
      list = list.filter(
        i => i.productName.toLowerCase().includes(q) || i.sku?.toLowerCase().includes(q)
      );
    return list;
  }, [sellable, samples, filter, searchQuery]);

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <StackSimple size={16} className="text-primary" />
            </div>
          </div>
          <p className="text-2xl font-bold text-foreground tabular-nums">
            {data.totalOnHand.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Units on Hand</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <CurrencyGbp size={16} className="text-emerald-500" />
            </div>
          </div>
          <p className="text-2xl font-bold text-foreground tabular-nums">
            {GBP(data.totalStockValue)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Stock Value</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Warning size={16} className="text-amber-500" />
            </div>
          </div>
          <p
            className={`text-2xl font-bold tabular-nums ${data.lowStockCount > 0 ? 'text-amber-500' : 'text-foreground'}`}
          >
            {data.lowStockCount}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Low Stock</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-rose-500/10 flex items-center justify-center">
              <ArrowDown size={16} className="text-rose-500" />
            </div>
          </div>
          <p
            className={`text-2xl font-bold tabular-nums ${oversoldCount > 0 ? 'text-rose-500' : 'text-foreground'}`}
          >
            {oversoldCount}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Oversold</p>
        </div>
      </div>

      {/* Filters + search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          {(['all', 'in_stock', 'low_stock', 'out_of_stock', 'oversold', 'samples'] as const).map(
            f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  filter === f
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f === 'all'
                  ? `All (${sellable.length})`
                  : f === 'in_stock'
                    ? 'In Stock'
                    : f === 'low_stock'
                      ? `Low (${data.lowStockCount})`
                      : f === 'out_of_stock'
                        ? 'Empty'
                        : f === 'oversold'
                          ? `Oversold (${oversoldCount})`
                          : `Samples (${samples.length})`}
              </button>
            )
          )}
        </div>
        <div className="relative ml-auto">
          <MagnifyingGlass
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search products\u2026"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-card border border-border rounded-lg pl-7 pr-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-52"
          />
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <StackSimple size={32} weight="thin" className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No items match your filter.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="grid grid-cols-[1fr_110px_80px_80px_80px_80px_80px_80px_96px_100px] items-center gap-2 px-4 py-2.5 bg-muted/30 border-b border-border text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            <span>Product</span>
            <span>Status</span>
            <span className="text-right">Purchased</span>
            <span className="text-right">Sold</span>
            <span className="text-right">Refunded</span>
            <span className="text-right">Gifted</span>
            <span className="text-right">Write-off</span>
            <span className="text-right">On Hand</span>
            <span className="text-right">Unit Cost</span>
            <span className="text-right">Stock Value</span>
          </div>
          <div className="divide-y divide-border/60 max-h-[600px] overflow-y-auto">
            {filtered.map(item => (
              <StockRow key={item.inventoryItemId} item={item} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Movements Tab ────────────────────────────────────────────────────

function MovementsTab({ movements }: { movements: InventoryMovementRow[] }) {
  const [searchQuery, setSearchQuery] = useState('');

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return movements;
    return movements.filter(
      m =>
        m.sku?.toLowerCase().includes(q) ||
        m.productName?.toLowerCase().includes(q) ||
        m.notes?.toLowerCase().includes(q)
    );
  }, [movements, searchQuery]);

  const typeBadge = (type: string) => {
    switch (type) {
      case 'PURCHASE':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'SALE':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      case 'ADJUSTMENT':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      default:
        return 'bg-muted text-muted-foreground border-border';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <MagnifyingGlass
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search movements\u2026"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-card border border-border rounded-lg pl-7 pr-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <span className="text-xs text-muted-foreground">{filtered.length} movements</span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Receipt size={32} weight="thin" className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No movements found.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="grid grid-cols-[1fr_100px_72px_88px_100px_130px] items-center gap-2 px-4 py-2.5 bg-muted/30 border-b border-border text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            <span>Item / Reference</span>
            <span>Type</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Unit Cost</span>
            <span className="text-right">Total</span>
            <span className="text-right">Date</span>
          </div>
          <div className="divide-y divide-border/60 max-h-[600px] overflow-y-auto">
            {filtered.map(m => {
              const isSale = m.transactionType === 'SALE';
              return (
                <div
                  key={m.id}
                  className="grid grid-cols-[1fr_100px_72px_88px_100px_130px] items-center gap-2 px-4 py-3 hover:bg-muted/20 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {m.sku ?? m.productName ?? 'Unknown'}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {m.reference ?? m.productName ?? m.notes ?? ''}
                    </p>
                  </div>
                  <div>
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${typeBadge(m.transactionType)}`}
                    >
                      {m.transactionType.toLowerCase()}
                    </span>
                  </div>
                  <div className="text-right">
                    <span
                      className={`text-sm tabular-nums font-medium ${isSale ? 'text-rose-400' : 'text-emerald-400'}`}
                    >
                      {isSale ? '-' : '+'}
                      {m.quantity.toLocaleString()}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {GBP(m.unitCost)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span
                      className={`text-sm font-medium tabular-nums ${isSale ? 'text-rose-400' : 'text-foreground'}`}
                    >
                      {isSale ? '-' : ''}
                      {GBP(m.totalCost)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-muted-foreground">
                      {new Date(m.createdAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: '2-digit',
                      })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Valuation Tab ────────────────────────────────────────────────────

function ValuationTab({ items }: { items: InventoryValuationItem[] }) {
  const maxInvested = items.length > 0 ? items[0].totalInvested : 1;
  const totalInvested = items.reduce((s, v) => s + v.totalInvested, 0);

  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <ChartBar size={32} weight="thin" className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No valuation data available.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="grid grid-cols-[1fr_140px_88px_88px_100px_60px] items-center gap-2 px-4 py-2.5 bg-muted/30 border-b border-border text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            <span>SKU / Product</span>
            <span>Investment Share</span>
            <span className="text-right">Purchased</span>
            <span className="text-right">Unit Cost</span>
            <span className="text-right">Invested</span>
            <span className="text-right">%</span>
          </div>
          <div className="divide-y divide-border/60 max-h-[600px] overflow-y-auto">
            {items
              .filter(i => i.totalInvested > 0)
              .map(item => {
                const pct = totalInvested > 0 ? (item.totalInvested / totalInvested) * 100 : 0;
                return (
                  <div
                    key={item.id}
                    className="grid grid-cols-[1fr_140px_88px_88px_100px_60px] items-center gap-2 px-4 py-3 hover:bg-muted/20 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {item.sku ?? 'Unknown'}
                      </p>
                      {item.productName && (
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {item.productName}
                        </p>
                      )}
                    </div>
                    <div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary/60 rounded-full transition-all"
                          style={{ width: `${(item.totalInvested / maxInvested) * 100}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-sm text-foreground tabular-nums">
                        {item.totalPurchased.toLocaleString()}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {item.unitCost > 0 ? GBP(item.unitCost) : '\u2014'}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-semibold text-foreground tabular-nums">
                        {GBP(item.totalInvested)}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { inventoryData, movementsData, valuationData, stockData } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<typeof action>();

  const [activeTab, setActiveTab] = useState<TabId>('items');
  const [selectedItem, setSelectedItem] = useState<InventoryItemRow | null>(null);

  const allProductOptions = useMemo(
    () => inventoryData.products.map(p => ({ id: p.id, name: p.name })),
    [inventoryData.products]
  );

  const handleLinkItem = useCallback(
    (inventoryItemId: string, productId: string) => {
      const fd = new FormData();
      fd.append('intent', 'link_to_product');
      fd.append('inventoryItemId', inventoryItemId);
      fd.append('productId', productId);
      fetcher.submit(fd, { method: 'POST' });
      setTimeout(() => revalidator.revalidate(), 500);
    },
    [fetcher, revalidator]
  );

  const handleUpdateItemCost = useCallback(
    (inventoryItemId: string, unitCost: number) => {
      const fd = new FormData();
      fd.append('intent', 'update_item_cost');
      fd.append('inventoryItemId', inventoryItemId);
      fd.append('unitCost', String(unitCost));
      fetcher.submit(fd, { method: 'POST' });
      setTimeout(() => revalidator.revalidate(), 500);
    },
    [fetcher, revalidator]
  );

  const handleUpdateItemType = useCallback(
    (inventoryItemId: string, itemType: InventoryItemRow['itemType']) => {
      const fd = new FormData();
      fd.append('intent', 'update_item_type');
      fd.append('inventoryItemId', inventoryItemId);
      fd.append('itemType', itemType);
      fetcher.submit(fd, { method: 'POST' });
      // Changing type moves the item between filters (and may unlink it), so close
      // the sheet rather than leaving it showing a now-stale row.
      setSelectedItem(null);
      setTimeout(() => revalidator.revalidate(), 500);
    },
    [fetcher, revalidator]
  );

  const tabs: { id: TabId; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: 'items', label: 'Items', icon: <List size={15} />, count: inventoryData.allItems.length },
    {
      id: 'movements',
      label: 'Movements',
      icon: <Clock size={15} />,
      count: movementsData.totalMovements,
    },
    { id: 'valuation', label: 'Valuation', icon: <TrendUp size={15} /> },
    { id: 'stock', label: 'Stock', icon: <StackSimple size={15} />, count: stockData.items.length },
  ];

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Sticky Header */}
      <header className="border-b border-border bg-card/95 backdrop-blur-sm sticky top-0 z-40">
        <div className="px-4 md:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-foreground">Inventory</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {inventoryData.totalInventoryItems} items &middot; {movementsData.totalMovements}{' '}
                movements &middot; {GBP(valuationData.totalInventoryValue)} invested
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => revalidator.revalidate()}
              disabled={revalidator.state === 'loading'}
              className="h-9 w-9"
            >
              <ArrowClockwise
                size={16}
                className={revalidator.state === 'loading' ? 'animate-spin' : ''}
              />
            </Button>
          </div>
        </div>
      </header>

      <main className="px-4 md:px-6 lg:px-8 py-6 space-y-5">
        {/* KPI Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Cube size={16} className="text-primary" />
              </div>
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {inventoryData.totalInventoryItems}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Inventory Items</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Package size={16} className="text-emerald-500" />
              </div>
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {valuationData.uniqueProducts}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Unique Products</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <ArrowDown size={16} className="text-blue-500" />
              </div>
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {valuationData.totalUnitsPurchased.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Units Purchased</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <CurrencyGbp size={16} className="text-amber-500" />
              </div>
            </div>
            <p className="text-2xl font-bold text-foreground tabular-nums">
              {GBP(valuationData.totalInventoryValue)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">Total Invested</p>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1 w-fit">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${activeTab === tab.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {tab.icon}
              {tab.label}
              {tab.count !== undefined && (
                <span className="text-[11px] text-muted-foreground ml-0.5">({tab.count})</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === 'items' && (
          <ItemsTab allItems={inventoryData.allItems} onSelectItem={setSelectedItem} />
        )}
        {activeTab === 'movements' && <MovementsTab movements={movementsData.movements} />}
        {activeTab === 'valuation' && <ValuationTab items={valuationData.items} />}
        {activeTab === 'stock' && <StockTab data={stockData} />}
      </main>

      {/* Detail panel */}
      {selectedItem && (
        <InventoryDetailSheet
          item={selectedItem}
          allProducts={allProductOptions}
          onClose={() => setSelectedItem(null)}
          onLinkItem={handleLinkItem}
          onUpdateCost={handleUpdateItemCost}
          onUpdateItemType={handleUpdateItemType}
        />
      )}
    </div>
  );
}
