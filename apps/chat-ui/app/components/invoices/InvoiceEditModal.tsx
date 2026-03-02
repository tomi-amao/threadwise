/**
 * Invoice Edit Modal
 *
 * Allows editing of specific invoice fields that may be incorrectly
 * categorized by the AI extraction: invoice_type, notes, description,
 * and gl_account_id. Financial amounts are read-only.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { PencilSimple, FloppyDisk } from 'phosphor-react';
import { SearchableSelect } from '~/components/ui/searchable-select';
import type { SelectOption } from '~/components/ui/searchable-select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '~/components/ui/dialog';
import type { Invoice, InvoiceType } from '~/types/invoice';

interface GLAccount {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
}

interface InvoiceEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice;
  glAccounts: GLAccount[];
  onSave: (updates: InvoiceEditPayload) => Promise<void>;
}

export interface InvoiceEditPayload {
  invoiceId: string;
  invoice_type?: InvoiceType;
  notes?: string | null;
  /** Per-line GL account overrides: { lineItemId: glAccountId } */
  lineItemGlAccounts?: Record<string, string | null>;
}

function formatCurrency(amount: number | null | undefined, currency: string = 'GBP'): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(amount);
}

function formatAccountType(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function InvoiceEditModal({
  open,
  onOpenChange,
  invoice,
  glAccounts,
  onSave,
}: InvoiceEditModalProps) {
  const [invoiceType, setInvoiceType] = useState<InvoiceType>(invoice.invoice_type);
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [lineGl, setLineGl] = useState<Record<string, string | null>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Build searchable options grouped by account type
  const glOptions = useMemo<SelectOption[]>(() => {
    return glAccounts.map(acct => ({
      value: acct.id,
      label: acct.name,
      meta: acct.account_number,
      group: formatAccountType(acct.account_type),
    }));
  }, [glAccounts]);

  // Reset form when invoice changes or modal opens
  useEffect(() => {
    if (open) {
      setInvoiceType(invoice.invoice_type);
      setNotes(invoice.notes ?? '');
      // Initialize line item GL accounts
      const glMap: Record<string, string | null> = {};
      for (const li of invoice.invoice_line_items ?? []) {
        glMap[li.id] = li.gl_account_id ?? null;
      }
      setLineGl(glMap);
    }
  }, [open, invoice]);

  const hasChanges =
    invoiceType !== invoice.invoice_type ||
    notes !== (invoice.notes ?? '') ||
    Object.entries(lineGl).some(([id, val]) => {
      const original = invoice.invoice_line_items?.find(li => li.id === id)?.gl_account_id ?? null;
      return val !== original;
    });

  const handleSave = async () => {
    if (!hasChanges) {
      onOpenChange(false);
      return;
    }
    setIsSaving(true);
    try {
      // Build payload with only changed fields
      const payload: InvoiceEditPayload = { invoiceId: invoice.id };

      if (invoiceType !== invoice.invoice_type) {
        payload.invoice_type = invoiceType;
      }
      if (notes !== (invoice.notes ?? '')) {
        payload.notes = notes || null;
      }

      // Collect changed GL accounts
      const changedGl: Record<string, string | null> = {};
      for (const [id, val] of Object.entries(lineGl)) {
        const original = invoice.invoice_line_items?.find(li => li.id === id)?.gl_account_id ?? null;
        if (val !== original) changedGl[id] = val;
      }
      if (Object.keys(changedGl).length > 0) {
        payload.lineItemGlAccounts = changedGl;
      }

      await onSave(payload);
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilSimple size={20} weight="duotone" className="text-primary" />
            Edit Invoice
          </DialogTitle>
          <DialogDescription>
            Correct AI-extracted fields. Financial amounts are calculated and cannot be edited directly.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-5 pr-1">
          {/* Invoice type */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Invoice Type
            </label>
            <div className="flex gap-2">
              {(['SALE', 'PURCHASE'] as InvoiceType[]).map(type => (
                <button
                  key={type}
                  onClick={() => setInvoiceType(type)}
                  className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold border-2 transition-all ${
                    invoiceType === type
                      ? type === 'SALE'
                        ? 'border-blue-500 bg-blue-500/15 text-blue-400'
                        : 'border-orange-500 bg-orange-500/15 text-orange-400'
                      : 'border-border text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/30'
                  }`}
                >
                  {type === 'SALE' ? 'Sale' : 'Purchase'}
                </button>
              ))}
            </div>
            {invoiceType !== invoice.invoice_type && (
              <p className="text-xs text-yellow-400">
                Changing the type will affect how this invoice is categorized
              </p>
            )}
          </div>

          {/* Read-only financial summary */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Financial Summary
              <span className="text-xs text-muted-foreground font-normal ml-2">(read-only)</span>
            </label>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-muted/20 border border-border p-3">
                <p className="text-xs text-muted-foreground">Net</p>
                <p className="text-sm font-semibold tabular-nums mt-0.5">
                  {formatCurrency(invoice.net_amount, invoice.currency)}
                </p>
              </div>
              <div className="rounded-lg bg-muted/20 border border-border p-3">
                <p className="text-xs text-muted-foreground">Tax</p>
                <p className="text-sm font-semibold tabular-nums mt-0.5">
                  {formatCurrency(invoice.tax_amount, invoice.currency)}
                </p>
              </div>
              <div className="rounded-lg bg-muted/20 border border-border p-3">
                <p className="text-xs text-muted-foreground">Gross</p>
                <p className="text-sm font-semibold tabular-nums mt-0.5">
                  {formatCurrency(invoice.gross_amount, invoice.currency)}
                </p>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <label htmlFor="invoice-notes" className="block text-sm font-medium text-foreground">
              Notes
            </label>
            <textarea
              id="invoice-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Add notes about this invoice…"
              rows={3}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none"
            />
          </div>

          {/* Line item GL accounts */}
          {invoice.invoice_line_items && invoice.invoice_line_items.length > 0 && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">
                Line Item GL Accounts
              </label>
              <div className="space-y-2">
                {invoice.invoice_line_items.map(li => (
                  <div
                    key={li.id}
                    className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/10 p-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{li.description}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatCurrency(li.line_net, invoice.currency)} net
                      </p>
                    </div>
                    <SearchableSelect
                      options={glOptions}
                      value={lineGl[li.id] ?? ''}
                      onChange={val =>
                        setLineGl(prev => ({
                          ...prev,
                          [li.id]: val || null,
                        }))
                      }
                      emptyOption="No account"
                      placeholder="No account"
                      className="w-52 px-2 py-1.5 text-xs"
                      renderValue={opt =>
                        opt && opt.value ? (
                          <span className="truncate">
                            <span className="font-mono text-muted-foreground">{glAccounts.find(a => a.id === opt.value)?.account_number}</span>
                            {' — '}{opt.label}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">No account</span>
                        )
                      }
                      renderOption={(opt, isSelected) =>
                        opt.value === '' ? (
                          <span className="text-muted-foreground italic">No account</span>
                        ) : (
                          <div className="flex-1 min-w-0">
                            <span className="truncate block">{opt.label}</span>
                            {opt.meta && (
                              <span className="text-[11px] font-mono text-muted-foreground">{opt.meta}</span>
                            )}
                          </div>
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 pt-4 border-t border-border">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isSaving ? (
              <>
                <span className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <FloppyDisk size={16} weight="bold" />
                Save Changes
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
