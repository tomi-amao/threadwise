/**
 * GL Account Review Modal
 *
 * Second step in the invoice upload workflow — shown after ProductSelectionModal.
 * Lets the user verify and correct the GL account assigned to each invoice line item
 * before the invoice is finalised. Mirrors the line-item GL editing in InvoiceEditModal.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { BookBookmark, Check } from 'phosphor-react';
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
import type { Invoice } from '~/types/invoice';

interface GLAccount {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
}

interface GlAccountReviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice | null;
  glAccounts: GLAccount[];
  onConfirm: (lineItemGlAccounts: Record<string, string | null>) => Promise<void>;
}

function formatCurrency(amount: number | null | undefined, currency = 'GBP'): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(amount);
}

function formatAccountType(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function GlAccountReviewModal({
  open,
  onOpenChange,
  invoice,
  glAccounts,
  onConfirm,
}: GlAccountReviewModalProps) {
  const [lineGl, setLineGl] = useState<Record<string, string | null>>({});
  const [isConfirming, setIsConfirming] = useState(false);

  // Build searchable options grouped by account type
  const glOptions = useMemo<SelectOption[]>(() => {
    return glAccounts.map(acct => ({
      value: acct.id,
      label: acct.name,
      meta: acct.account_number,
      group: formatAccountType(acct.account_type),
    }));
  }, [glAccounts]);

  // Initialise line item GL map when modal opens or invoice changes
  useEffect(() => {
    if (open && invoice) {
      const glMap: Record<string, string | null> = {};
      for (const li of invoice.invoice_line_items ?? []) {
        glMap[li.id] = li.gl_account_id ?? null;
      }
      setLineGl(glMap);
    }
  }, [open, invoice]);

  const lineItems = invoice?.invoice_line_items ?? [];

  const assignedCount = Object.values(lineGl).filter(Boolean).length;

  const handleConfirm = async () => {
    setIsConfirming(true);
    try {
      await onConfirm(lineGl);
      onOpenChange(false);
    } finally {
      setIsConfirming(false);
    }
  };

  if (!invoice) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookBookmark size={20} weight="duotone" className="text-primary" />
            Review GL Accounts
          </DialogTitle>
          <DialogDescription>
            Verify the account assigned to each line item. The AI has attempted to suggest accounts
            based on the invoice content — correct any that look wrong before confirming.
          </DialogDescription>
        </DialogHeader>

        {/* Assignment progress banner */}
        <div
          className={`flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm border ${
            assignedCount === lineItems.length && lineItems.length > 0
              ? 'bg-green-500/10 border-green-500/20 text-green-300'
              : 'bg-yellow-500/10 border-yellow-500/20 text-yellow-300'
          }`}
        >
          <Check size={15} weight="bold" className="shrink-0" />
          <span>
            {assignedCount} of {lineItems.length} line item
            {lineItems.length !== 1 ? 's' : ''} assigned to an account
          </span>
        </div>

        {/* Line item list */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-2 pr-1">
          {lineItems.map(li => (
            <div
              key={li.id}
              className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/10 p-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{li.description}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatCurrency(li.line_net, invoice.currency)} net
                  {li.quantity != null && ` · Qty ${li.quantity}`}
                </p>
              </div>
              <SearchableSelect
                options={glOptions}
                value={lineGl[li.id] ?? ''}
                onChange={val => setLineGl(prev => ({ ...prev, [li.id]: val || null }))}
                emptyOption="No account"
                placeholder="No account"
                className="w-52 px-2 py-1.5 text-xs"
                renderValue={opt =>
                  opt && opt.value ? (
                    <span className="truncate">
                      <span className="font-mono text-muted-foreground">
                        {glAccounts.find(a => a.id === opt.value)?.account_number}
                      </span>
                      {' — '}
                      {opt.label}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No account</span>
                  )
                }
                renderOption={(opt, _isSelected) =>
                  opt.value === '' ? (
                    <span className="text-muted-foreground italic">No account</span>
                  ) : (
                    <div className="flex-1 min-w-0">
                      <span className="truncate block">{opt.label}</span>
                      {opt.meta && (
                        <span className="text-[11px] font-mono text-muted-foreground">
                          {opt.meta}
                        </span>
                      )}
                    </div>
                  )
                }
              />
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2 pt-4 border-t border-border">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted transition-colors"
            title="Skip — GL accounts can be updated later via the Edit action"
          >
            Skip
          </button>
          <button
            onClick={handleConfirm}
            disabled={isConfirming}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isConfirming ? (
              <>
                <span className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Check size={16} weight="bold" />
                Confirm Accounts
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
