/**
 * Product Selection Modal
 *
 * Shown after a PURCHASE invoice is processed. For each extracted line item
 * the user can choose one of three actions:
 *
 *  A) Skip         — treat as an expense, no inventory record
 *  B) Create New   — create a new product + inventory entry (existing flow)
 *  C) Link to Existing — match to an already-catalogued product and backfill
 *                        its unit_cost from this invoice (new backfill flow)
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Package,
  Check,
  Info,
  PencilSimple,
  LinkSimple,
  Plus,
  X,
  MagnifyingGlass,
  ArrowRight,
} from 'phosphor-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '~/components/ui/dialog';
import type { InvoiceLineItem, InvoiceType } from '~/types/invoice';

// ─── Fee / non-product heuristic ──────────────────────────────────────────────
const FEE_KEYWORDS = [
  'fee', 'fees', 'charge', 'charges', 'shipping', 'postage', 'delivery',
  'handling', 'discount', 'credit', 'adjustment', 'service charge', 'surcharge',
  'commission', 'tax', 'vat', 'duty', 'tariff', 'insurance', 'refund',
  'packing', 'packaging',
];
const FEE_PATTERN = new RegExp(
  `\\b(?:${FEE_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);
function isLikelyProduct(description: string): boolean {
  return !FEE_PATTERN.test(description);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type CandidateMode = 'skip' | 'new' | 'link';

export interface ProductCandidate {
  lineItemId: string;
  description: string;
  /** User-editable product name (only used in 'new' mode) */
  name: string;
  /** User-editable SKU (only used in 'new' mode) */
  sku: string;
  quantity: number | null;
  unitCost: number | null;
  /** Kept for backward-compat; true when mode !== 'skip' */
  selected: boolean;
  mode: CandidateMode;
  /** ID of the existing product to link to (only in 'link' mode) */
  linkedProductId: string | null;
  linkedProductName: string | null;
  /** GL account used as the inventory asset account for this item */
  assetAccountId: string | null;
  /** GL account to debit when this item is sold (COGS) */
  cogsAccountId: string | null;
  /** When mode is 'skip', still create an inventory item + PURCHASE movement */
  createInventoryRecord: boolean;
}

export interface ExistingProduct {
  id: string;
  name: string;
}

export interface GLAccount {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
}

interface ProductSelectionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lineItems: InvoiceLineItem[];
  invoiceId: string;
  invoiceType: InvoiceType;
  entityId: string;
  currency?: string;
  /** Existing catalog products for the entity — used in "link" mode */
  existingProducts?: ExistingProduct[];
  /** Chart of accounts for selecting inventory asset + COGS accounts */
  glAccounts?: GLAccount[];
  onConfirm: (selected: ProductCandidate[]) => Promise<void>;
}

function formatCurrency(amount: number | null | undefined, currency = 'GBP'): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
}

// ─── Inline product search combobox ──────────────────────────────────────────

function ProductCombobox({
  products,
  value,
  onChange,
}: {
  products: ExistingProduct[];
  value: string | null;
  onChange: (id: string, name: string) => void;
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

  // Use fixed positioning so the dropdown isn't clipped by overflow:auto ancestors
  useEffect(() => {
    if (open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 2,
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
        pointerEvents: 'auto', // Radix DismissableLayer sets body pointer-events:none for modal; override for portal
      });
    }
  }, [open]);

  const handleSelect = (product: ExistingProduct) => {
    onChange(product.id, product.name);
    setQuery('');
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('', '');
    setQuery('');
  };

  return (
    <div ref={ref} className="relative w-full">
      <div
        className={`flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 cursor-pointer text-sm transition-colors ${
          open ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-muted-foreground/40'
        }`}
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
      >
        <MagnifyingGlass size={14} className="text-muted-foreground shrink-0" />
        {selected && !open ? (
          <>
            <span className="flex-1 truncate text-foreground font-medium text-xs">
              {selected.name}
            </span>
            <button
              type="button"
              onClick={handleClear}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            placeholder={selected ? selected.name : 'Search existing products…'}
            className="flex-1 bg-transparent outline-none text-xs placeholder:text-muted-foreground text-foreground min-w-0"
          />
        )}
      </div>

      {open && filtered.length > 0 && typeof document !== 'undefined' && createPortal(
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
              onClick={() => handleSelect(product)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted transition-colors ${
                product.id === value ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'
              }`}
            >
              <Package size={12} className="shrink-0 text-muted-foreground" />
              <span className="truncate">{product.name}</span>
              {product.id === value && <Check size={12} className="ml-auto shrink-0 text-primary" />}
            </button>
          ))}
        </div>,
        document.body
      )}

      {open && filtered.length === 0 && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          style={dropdownStyle}
          onPointerDown={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          className="rounded-lg border border-border bg-card shadow-xl px-3 py-3 text-xs text-muted-foreground"
        >
          {query.trim() ? `No products match "${query}"` : 'No products available'}
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Mode toggle button ───────────────────────────────────────────────────────

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

// ─── GL account select ────────────────────────────────────────────────────────

function GlAccountSelect({
  accounts,
  value,
  placeholder,
  onChange,
}: {
  accounts: GLAccount[];
  value: string | null;
  placeholder: string;
  onChange: (id: string | null) => void;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/60 text-foreground"
    >
      <option value="">{placeholder}</option>
      {accounts.map(acct => (
        <option key={acct.id} value={acct.id}>
          {acct.account_number} — {acct.name}
        </option>
      ))}
    </select>
  );
}

// ─── Individual candidate row ─────────────────────────────────────────────────

interface CandidateRowProps {
  candidate: ProductCandidate;
  currency: string;
  existingProducts: ExistingProduct[];
  assetAccounts: GLAccount[];
  cogsAccounts: GLAccount[];
  onModeChange: (id: string, mode: CandidateMode) => void;
  onFieldChange: (id: string, field: 'name' | 'sku', value: string) => void;
  onLinkProduct: (id: string, productId: string, productName: string) => void;
  onAccountChange: (id: string, field: 'assetAccountId' | 'cogsAccountId', value: string | null) => void;
  onInventoryToggle: (id: string, value: boolean) => void;
}

function CandidateRow({
  candidate,
  currency,
  existingProducts,
  assetAccounts,
  cogsAccounts,
  onModeChange,
  onFieldChange,
  onLinkProduct,
  onAccountChange,
  onInventoryToggle,
}: CandidateRowProps) {
  // Fully dimmed only when skipped AND no inventory record requested
  const isFullySkipped = candidate.mode === 'skip' && !candidate.createInventoryRecord;

  return (
    <div
      className={`rounded-lg border transition-all ${
        isFullySkipped
          ? 'border-border/30 bg-muted/5 opacity-40'
          : candidate.mode === 'skip'
            ? 'border-emerald-500/30 bg-emerald-500/5'
            : candidate.mode === 'link'
              ? 'border-violet-500/30 bg-violet-500/5'
              : 'border-primary/30 bg-primary/5'
      }`}
    >
      {/* Top row: description + cost + mode buttons */}
      <div className="flex items-start gap-3 p-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-foreground font-medium truncate" title={candidate.description}>
            {candidate.description}
          </p>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
            {candidate.quantity != null && <span>Qty: {candidate.quantity}</span>}
            {candidate.unitCost != null && (
              <span className="font-medium">
                {formatCurrency(candidate.unitCost, currency)} / unit
              </span>
            )}
            {candidate.sku && (
              <span className="font-mono opacity-70">{candidate.sku}</span>
            )}
          </div>
        </div>

        {/* Mode buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <ModeButton
            active={candidate.mode === 'skip'}
            onClick={() => onModeChange(candidate.lineItemId, 'skip')}
          >
            Skip
          </ModeButton>
          <ModeButton
            active={candidate.mode === 'new'}
            onClick={() => onModeChange(candidate.lineItemId, 'new')}
          >
            <Plus size={10} />
            New
          </ModeButton>
          <ModeButton
            active={candidate.mode === 'link'}
            onClick={() => onModeChange(candidate.lineItemId, 'link')}
          >
            <LinkSimple size={10} />
            Link
          </ModeButton>
        </div>
      </div>

      {/* Expanded: New product fields */}
      {candidate.mode === 'new' && (
        <div className="grid grid-cols-2 gap-2 px-3 pb-3 border-t border-primary/10 pt-2">
          <div className="col-span-2 sm:col-span-1">
            <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
              <PencilSimple size={11} />
              Product name
            </label>
            <input
              type="text"
              value={candidate.name}
              onChange={e => onFieldChange(candidate.lineItemId, 'name', e.target.value)}
              placeholder="Enter product name…"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
              <PencilSimple size={11} />
              SKU
            </label>
            <input
              type="text"
              value={candidate.sku}
              onChange={e => onFieldChange(candidate.lineItemId, 'sku', e.target.value)}
              placeholder="e.g. CAP-RED-L"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </div>
          {(assetAccounts.length > 0 || cogsAccounts.length > 0) && (
            <>
              <div className="col-span-2 sm:col-span-1">
                <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
                  Inventory Asset Account
                </label>
                <GlAccountSelect
                  accounts={assetAccounts}
                  value={candidate.assetAccountId}
                  placeholder="Select asset account…"
                  onChange={v => onAccountChange(candidate.lineItemId, 'assetAccountId', v)}
                />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
                  COGS Account
                </label>
                <GlAccountSelect
                  accounts={cogsAccounts}
                  value={candidate.cogsAccountId}
                  placeholder="Select COGS account…"
                  onChange={v => onAccountChange(candidate.lineItemId, 'cogsAccountId', v)}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Expanded: Skip — optional inventory movement toggle */}
      {candidate.mode === 'skip' && (
        <div className="px-3 pb-3 border-t border-border/20 pt-2">
          <label className="flex items-center gap-2 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={candidate.createInventoryRecord}
              onChange={e => onInventoryToggle(candidate.lineItemId, e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-emerald-500 cursor-pointer"
            />
            <Package size={11} className="text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
              Record stock movement
            </span>
          </label>
          {candidate.createInventoryRecord && (
            <div className="mt-2 space-y-2">
              <div>
                <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
                  <PencilSimple size={11} />
                  SKU <span className="font-normal opacity-60">(optional — auto-derived if blank)</span>
                </label>
                <input
                  type="text"
                  value={candidate.sku}
                  onChange={e => onFieldChange(candidate.lineItemId, 'sku', e.target.value)}
                  placeholder="e.g. CAP-RED-L"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500/60"
                />
              </div>
              {(assetAccounts.length > 0 || cogsAccounts.length > 0) && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
                      Inventory Asset Account
                    </label>
                    <GlAccountSelect
                      accounts={assetAccounts}
                      value={candidate.assetAccountId}
                      placeholder="Select asset account…"
                      onChange={v => onAccountChange(candidate.lineItemId, 'assetAccountId', v)}
                    />
                  </div>
                  <div>
                    <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
                      COGS Account
                    </label>
                    <GlAccountSelect
                      accounts={cogsAccounts}
                      value={candidate.cogsAccountId}
                      placeholder="Select COGS account…"
                      onChange={v => onAccountChange(candidate.lineItemId, 'cogsAccountId', v)}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Expanded: Link to existing product */}
      {candidate.mode === 'link' && (
        <div className="px-3 pb-3 border-t border-violet-500/10 pt-2 space-y-2">
          <div>
            <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1.5">
              <LinkSimple size={11} />
              Match to existing product
            </label>
            {existingProducts.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No products found. Add products via sync first, then try again.
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <ProductCombobox
                    products={existingProducts}
                    value={candidate.linkedProductId}
                    onChange={(id, name) => onLinkProduct(candidate.lineItemId, id, name)}
                  />
                </div>
                {candidate.linkedProductId && candidate.unitCost != null && (
                  <div className="flex items-center gap-1 text-[11px] text-violet-400 shrink-0 whitespace-nowrap">
                    <ArrowRight size={10} />
                    <span>sets cost to {formatCurrency(candidate.unitCost, currency)}</span>
                  </div>
                )}
              </div>
            )}
            {candidate.linkedProductId && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                All variants of this product will have their unit cost updated.
                Adjust individual variants on the Inventory Costs page.
              </p>
            )}
          </div>
          {(assetAccounts.length > 0 || cogsAccounts.length > 0) && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
                  Inventory Asset Account
                </label>
                <GlAccountSelect
                  accounts={assetAccounts}
                  value={candidate.assetAccountId}
                  placeholder="Select asset account…"
                  onChange={v => onAccountChange(candidate.lineItemId, 'assetAccountId', v)}
                />
              </div>
              <div>
                <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground mb-1">
                  COGS Account
                </label>
                <GlAccountSelect
                  accounts={cogsAccounts}
                  value={candidate.cogsAccountId}
                  placeholder="Select COGS account…"
                  onChange={v => onAccountChange(candidate.lineItemId, 'cogsAccountId', v)}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export function ProductSelectionModal({
  open,
  onOpenChange,
  lineItems,
  invoiceId: _invoiceId,
  invoiceType: _invoiceType,
  entityId: _entityId,
  currency = 'GBP',
  existingProducts = [],
  glAccounts = [],
  onConfirm,
}: ProductSelectionModalProps) {
  const assetAccounts = useMemo(
    () => glAccounts.filter(a => a.account_type === 'asset'),
    [glAccounts]
  );
  const cogsAccounts = useMemo(
    () => glAccounts.filter(a => a.account_type === 'cogs'),
    [glAccounts]
  );

  const initialCandidates = useMemo<ProductCandidate[]>(() => {
    return lineItems
      .filter(li => isLikelyProduct(li.description))
      .map(li => ({
        lineItemId: li.id,
        description: li.description,
        name: li.description.trim(),
        sku: li.sku ?? '',
        quantity: li.quantity,
        unitCost: li.unit_cost,
        selected: true,
        // Default to 'link' mode since this is the primary use case
        mode: 'link' as CandidateMode,
        linkedProductId: null,
        linkedProductName: null,
        assetAccountId: null,
        cogsAccountId: null,
        createInventoryRecord: false,
      }));
  }, [lineItems]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [candidates, setCandidates] = useState<ProductCandidate[]>(initialCandidates);

  React.useEffect(() => {
    if (open && initialCandidates.length === 0) onOpenChange(false);
  }, [open, initialCandidates.length, onOpenChange]);

  React.useEffect(() => {
    if (open) setCandidates(initialCandidates);
  }, [open, initialCandidates]);

  const handleModeChange = (lineItemId: string, mode: CandidateMode) => {
    setCandidates(prev =>
      prev.map(c =>
        c.lineItemId === lineItemId
          ? {
              ...c,
              mode,
              selected: mode !== 'skip',
              linkedProductId: mode !== 'link' ? null : c.linkedProductId,
              linkedProductName: mode !== 'link' ? null : c.linkedProductName,
            }
          : c
      )
    );
  };

  const handleFieldChange = (lineItemId: string, field: 'name' | 'sku', value: string) => {
    setCandidates(prev =>
      prev.map(c => (c.lineItemId === lineItemId ? { ...c, [field]: value } : c))
    );
  };

  const handleLinkProduct = (lineItemId: string, productId: string, productName: string) => {
    setCandidates(prev =>
      prev.map(c =>
        c.lineItemId === lineItemId
          ? { ...c, linkedProductId: productId || null, linkedProductName: productName || null }
          : c
      )
    );
  };

  const handleInventoryToggle = (lineItemId: string, value: boolean) => {
    setCandidates(prev =>
      prev.map(c => (c.lineItemId === lineItemId ? { ...c, createInventoryRecord: value } : c))
    );
  };

  const handleAccountChange = (
    lineItemId: string,
    field: 'assetAccountId' | 'cogsAccountId',
    value: string | null
  ) => {
    setCandidates(prev =>
      prev.map(c => (c.lineItemId === lineItemId ? { ...c, [field]: value } : c))
    );
  };

  const handleConfirm = async () => {
    const active = candidates.filter(c => c.mode !== 'skip' || c.createInventoryRecord);
    if (active.length === 0) {
      onOpenChange(false);
      return;
    }
    setIsSubmitting(true);
    try {
      await onConfirm(active);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const newCount = candidates.filter(c => c.mode === 'new').length;
  const linkCount = candidates.filter(c => c.mode === 'link' && c.linkedProductId).length;
  const linkPendingCount = candidates.filter(c => c.mode === 'link' && !c.linkedProductId).length;
  const inventoryOnlyCount = candidates.filter(c => c.mode === 'skip' && c.createInventoryRecord).length;
  const activeCount = candidates.filter(c => c.mode !== 'skip' || c.createInventoryRecord).length;

  const submitLabel = (() => {
    const parts: string[] = [];
    if (newCount > 0) parts.push(`Create ${newCount} new`);
    if (linkCount > 0) parts.push(`Link ${linkCount}`);
    if (inventoryOnlyCount > 0) parts.push(`Record ${inventoryOnlyCount} movement${inventoryOnlyCount !== 1 ? 's' : ''}`);
    return parts.length > 0 ? parts.join(' · ') : 'Continue';
  })();

  if (initialCandidates.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package size={20} weight="duotone" className="text-primary" />
            Match Invoice Items to Products
          </DialogTitle>
          <DialogDescription>
            For each line item, choose how to handle it: link it to an existing product to backfill
            its unit cost, create a new product, or skip it to treat it as an expense.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-lg bg-violet-500/10 border border-violet-500/20 p-3 text-sm">
          <Info size={16} className="text-violet-400 mt-0.5 shrink-0" />
          <div className="text-violet-300/90 space-y-0.5 text-xs">
            <p>
              <strong>Link</strong> — matches to an existing product and updates its unit cost on all
              variants. Best for backfilling costs on products already synced from your store.
            </p>
            <p>
              <strong>New</strong> — creates a new draft product and inventory entry.
            </p>
            <p>
              <strong>Skip</strong> — expense only; no inventory record created.
            </p>
          </div>
        </div>

        {/* Summary chips */}
{(newCount > 0 || linkCount > 0 || linkPendingCount > 0 || inventoryOnlyCount > 0) && (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              {linkCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium">
                  {linkCount} ready to link
                </span>
              )}
              {linkPendingCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                  {linkPendingCount} awaiting product selection
                </span>
              )}
              {newCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-medium">
                  {newCount} new product{newCount !== 1 ? 's' : ''}
                </span>
              )}
              {inventoryOnlyCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                  {inventoryOnlyCount} stock movement{inventoryOnlyCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 space-y-2 pr-1">
          {candidates.map(candidate => (
            <CandidateRow
              key={candidate.lineItemId}
              candidate={candidate}
              currency={currency}
              existingProducts={existingProducts}
              assetAccounts={assetAccounts}
              cogsAccounts={cogsAccounts}
              onModeChange={handleModeChange}
              onFieldChange={handleFieldChange}
              onLinkProduct={handleLinkProduct}
              onAccountChange={handleAccountChange}
              onInventoryToggle={handleInventoryToggle}
            />
          ))}
        </div>

        <DialogFooter className="gap-2 pt-4 border-t border-border">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted transition-colors"
          >
            Skip all
          </button>
          <button
            onClick={handleConfirm}
            disabled={isSubmitting || (newCount === 0 && linkCount === 0 && inventoryOnlyCount === 0)}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isSubmitting ? (
              <>
                <span className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Check size={16} weight="bold" />
                {submitLabel}
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
