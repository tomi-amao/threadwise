/**
 * Product Selection Modal
 *
 * Shown after an invoice is processed. Allows the user to:
 *  - Select which line items become catalog products
 *  - Edit the product name and SKU before creation (AI names can be inaccurate)
 * Fees, shipping, and non-product lines are pre-filtered out.
 */

import React, { useState, useMemo } from 'react';
import { Package, Check, Info, PencilSimple } from 'phosphor-react';
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
  'fee',
  'fees',
  'charge',
  'charges',
  'shipping',
  'postage',
  'delivery',
  'handling',
  'discount',
  'credit',
  'adjustment',
  'service charge',
  'surcharge',
  'commission',
  'tax',
  'vat',
  'duty',
  'tariff',
  'insurance',
  'refund',
  'packing',
  'packaging',
];

const FEE_PATTERN = new RegExp(
  `\\b(?:${FEE_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i'
);

function isLikelyProduct(description: string): boolean {
  return !FEE_PATTERN.test(description);
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface ProductCandidate {
  lineItemId: string;
  /** Original description from AI (read-only, shown as hint) */
  description: string;
  /** User-editable product name — defaults to description, can be refined */
  name: string;
  /** User-editable SKU */
  sku: string;
  quantity: number | null;
  unitCost: number | null;
  selected: boolean;
}

interface ProductSelectionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lineItems: InvoiceLineItem[];
  invoiceId: string;
  invoiceType: InvoiceType;
  entityId: string;
  currency?: string;
  onConfirm: (selected: ProductCandidate[]) => Promise<void>;
}

function formatCurrency(amount: number | null | undefined, currency: string = 'GBP'): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(amount);
}

// ─── Individual candidate row ─────────────────────────────────────────────────
interface CandidateRowProps {
  candidate: ProductCandidate;
  currency: string;
  onToggle: (id: string) => void;
  onFieldChange: (id: string, field: 'name' | 'sku', value: string) => void;
}

function CandidateRow({ candidate, currency, onToggle, onFieldChange }: CandidateRowProps) {
  return (
    <div
      className={`rounded-lg border transition-all ${
        candidate.selected
          ? 'border-primary/40 bg-primary/5'
          : 'border-border/50 bg-muted/10 opacity-50'
      }`}
    >
      {/* Click header to toggle selection */}
      <div
        className="flex items-start gap-3 p-3 cursor-pointer select-none"
        onClick={() => onToggle(candidate.lineItemId)}
      >
        <div
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
            candidate.selected
              ? 'bg-primary border-primary text-primary-foreground'
              : 'border-muted-foreground/40'
          }`}
        >
          {candidate.selected && <Check size={14} weight="bold" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground truncate" title={candidate.description}>
            {candidate.description}
          </p>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
            {candidate.quantity != null && <span>Qty: {candidate.quantity}</span>}
            {candidate.unitCost != null && (
              <span>Cost: {formatCurrency(candidate.unitCost, currency)}</span>
            )}
          </div>
        </div>
      </div>

      {/* Inline name + SKU fields — visible only when selected */}
      {candidate.selected && (
        <div className="grid grid-cols-2 gap-2 px-3 pb-3" onClick={e => e.stopPropagation()}>
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
  onConfirm,
}: ProductSelectionModalProps) {
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
      }));
  }, [lineItems]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [candidates, setCandidates] = useState<ProductCandidate[]>(initialCandidates);

  // If there are no product candidates, close the modal immediately so the
  // next step in the workflow (GL account review) can open.
  React.useEffect(() => {
    if (open && initialCandidates.length === 0) {
      onOpenChange(false);
    }
  }, [open, initialCandidates.length, onOpenChange]);

  React.useEffect(() => {
    if (open) setCandidates(initialCandidates);
  }, [open, initialCandidates]);

  const selectedCount = candidates.filter(c => c.selected).length;

  const toggleItem = (lineItemId: string) => {
    setCandidates(prev =>
      prev.map(c => (c.lineItemId === lineItemId ? { ...c, selected: !c.selected } : c))
    );
  };

  const updateField = (lineItemId: string, field: 'name' | 'sku', value: string) => {
    setCandidates(prev =>
      prev.map(c => (c.lineItemId === lineItemId ? { ...c, [field]: value } : c))
    );
  };

  const toggleAll = () => {
    const allSelected = candidates.every(c => c.selected);
    setCandidates(prev => prev.map(c => ({ ...c, selected: !allSelected })));
  };

  const handleConfirm = async () => {
    const selected = candidates.filter(c => c.selected);
    if (selected.length === 0) {
      onOpenChange(false);
      return;
    }
    setIsSubmitting(true);
    try {
      await onConfirm(selected);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (initialCandidates.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package size={20} weight="duotone" className="text-primary" />
            Create Products from Invoice
          </DialogTitle>
          <DialogDescription>
            Select which line items are products intended for resale. Only selected items will be
            added to your product catalog and inventory. Non-selected items remain as expenses (e.g.
            R&amp;D, marketing, giveaways) with no stock record.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-lg bg-blue-500/10 border border-blue-500/20 p-3 text-sm">
          <Info size={16} className="text-blue-400 mt-0.5 shrink-0" />
          <p className="text-blue-300/90">
            Only items you select will be created as products and added to inventory. Non-selected
            items are treated as expenses (R&amp;D, marketing, etc.). Products start in{' '}
            <strong>draft</strong> status — edit names and SKUs before saving.
          </p>
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <button
            onClick={toggleAll}
            className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {candidates.every(c => c.selected) ? 'Deselect all' : 'Select all'}
          </button>
          <span className="text-xs text-muted-foreground">
            {selectedCount} of {candidates.length} selected
          </span>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-2 pr-1">
          {candidates.map(candidate => (
            <CandidateRow
              key={candidate.lineItemId}
              candidate={candidate}
              currency={currency}
              onToggle={toggleItem}
              onFieldChange={updateField}
            />
          ))}
        </div>

        <DialogFooter className="gap-2 pt-4 border-t border-border">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted transition-colors"
            title="Skip — no products or inventory items will be created"
          >
            Skip (no inventory)
          </button>
          <button
            onClick={handleConfirm}
            disabled={isSubmitting || selectedCount === 0}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isSubmitting ? (
              <>
                <span className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Package size={16} weight="bold" />
                Create {selectedCount} Product{selectedCount !== 1 ? 's' : ''}
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
