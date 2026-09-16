/**
 * TransactionDrawer
 *
 * Right-side slide-over panel that shows:
 * 1. Transaction details (amount, source, type, date, counterparty)
 * 2. Associated journal and line items
 * 3. Inline edit form (description, counterparty, account code, exclude)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  X,
  Receipt,
  BookOpen,
  PencilSimple,
  Check,
  ArrowCounterClockwise,
  Warning,
  CheckCircle,
  Prohibit,
  ArrowRight,
  ArrowLeft,
  CurrencyCircleDollar,
  ClockClockwise,
  Info,
  CaretDown,
  CaretUp,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { SearchableSelect } from '~/components/ui/searchable-select';
import { cn } from '~/lib/utils';
import {
  getTransaction,
  updateTransaction,
  type FinancialTransaction,
  type TransactionJournal,
  type JournalLineItemWithAccount,
  type UpdateTransactionPayload,
} from '~/lib/api/transactions';
import type { ChartOfAccountEntry } from '~/lib/api/accounting';
import { toast } from 'sonner';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMoney(amount: number, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Badges ──────────────────────────────────────────────────────────────────

function DirectionBadge({ direction }: { direction: string }) {
  const isIn = direction === 'in';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border',
        isIn
          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
          : 'bg-rose-500/15 text-rose-400 border-rose-500/30'
      )}
    >
      {isIn ? <ArrowLeft size={11} weight="bold" /> : <ArrowRight size={11} weight="bold" />}
      {isIn ? 'Inbound' : 'Outbound'}
    </span>
  );
}

function SourceBadge({ source }: { source: string }) {
  const isRevolut = source === 'revolut';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border',
        isRevolut
          ? 'bg-violet-500/15 text-violet-400 border-violet-500/30'
          : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
      )}
    >
      {isRevolut ? 'Revolut' : 'PayPal'}
    </span>
  );
}

function JournalStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
    posted: {
      label: 'Posted',
      className: 'bg-green-500/15 text-green-400 border-green-500/30',
      icon: <CheckCircle size={11} weight="fill" />,
    },
    draft: {
      label: 'Draft',
      className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      icon: <Warning size={11} weight="fill" />,
    },
    reversed: {
      label: 'Reversed',
      className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
      icon: <ArrowCounterClockwise size={11} weight="bold" />,
    },
  };
  const c = cfg[status] ?? cfg.draft;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border',
        c.className
      )}
    >
      {c.icon}
      {c.label}
    </span>
  );
}

function ExcludedBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-red-500/15 text-red-400 border-red-500/30">
      <Prohibit size={11} weight="fill" />
      Excluded
    </span>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  action,
  collapsible,
  collapsed,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between py-3 border-b border-white/8',
        collapsible && 'cursor-pointer select-none'
      )}
      onClick={collapsible ? onToggle : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-sm font-semibold text-foreground">{title}</span>
      </div>
      <div className="flex items-center gap-2">
        {action}
        {collapsible && (
          <span className="text-muted-foreground">
            {collapsed ? <CaretDown size={14} /> : <CaretUp size={14} />}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Detail Row ───────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm border-b border-white/5 last:border-0">
      <span className="text-muted-foreground shrink-0 w-36">{label}</span>
      <span className="text-foreground text-right">{children}</span>
    </div>
  );
}

// ─── Line Items Table ─────────────────────────────────────────────────────────

function LineItemsTable({ items }: { items: JournalLineItemWithAccount[] }) {
  const totalDebit = items.reduce((s, i) => s + Number(i.debit), 0);
  const totalCredit = items.reduce((s, i) => s + Number(i.credit), 0);
  const currency = items[0]?.currency ?? 'GBP';

  return (
    <div className="mt-3 rounded-lg border border-white/10 overflow-hidden text-xs">
      <table className="w-full">
        <thead>
          <tr className="bg-white/5 text-muted-foreground">
            <th className="text-left px-3 py-2 font-medium">Account</th>
            <th className="text-right px-3 py-2 font-medium">Debit</th>
            <th className="text-right px-3 py-2 font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id} className="border-t border-white/8 hover:bg-white/3">
              <td className="px-3 py-2">
                <div className="font-medium text-foreground">
                  {item.account_number} — {item.account_name ?? item.account_id.slice(0, 8)}
                </div>
                {item.description && (
                  <div className="text-muted-foreground mt-0.5 truncate max-w-[200px]">
                    {item.description}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono text-emerald-400">
                {Number(item.debit) > 0 ? formatMoney(Number(item.debit), item.currency) : '—'}
              </td>
              <td className="px-3 py-2 text-right font-mono text-rose-400">
                {Number(item.credit) > 0 ? formatMoney(Number(item.credit), item.currency) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-white/5 border-t border-white/10 font-semibold">
            <td className="px-3 py-2 text-muted-foreground">Total</td>
            <td className="px-3 py-2 text-right font-mono text-emerald-400">
              {formatMoney(totalDebit, currency)}
            </td>
            <td className="px-3 py-2 text-right font-mono text-rose-400">
              {formatMoney(totalCredit, currency)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Edit Form ────────────────────────────────────────────────────────────────

interface EditFormProps {
  txn: FinancialTransaction;
  chartOfAccounts: ChartOfAccountEntry[];
  onSave: (payload: UpdateTransactionPayload) => Promise<void>;
  isSaving: boolean;
}

function EditForm({ txn, chartOfAccounts, onSave, isSaving }: EditFormProps) {
  const [description, setDescription] = useState(txn.description ?? '');
  const [counterparty, setCounterparty] = useState(txn.counterparty_name ?? '');
  const [accountCode, setAccountCode] = useState((txn.metadata?.account_code as string) ?? '');
  const [expenseCategory, setExpenseCategory] = useState(
    (txn.metadata?.expense_category as string) ?? ''
  );
  const [isExcluded, setIsExcluded] = useState(!!txn.excluded_reason);
  const [excludeReason, setExcludeReason] = useState(txn.excluded_reason ?? '');

  // Sync if txn prop changes (e.g. after save)
  useEffect(() => {
    setDescription(txn.description ?? '');
    setCounterparty(txn.counterparty_name ?? '');
    setAccountCode((txn.metadata?.account_code as string) ?? '');
    setExpenseCategory((txn.metadata?.expense_category as string) ?? '');
    setIsExcluded(!!txn.excluded_reason);
    setExcludeReason(txn.excluded_reason ?? '');
  }, [txn.id]);

  const accountOptions = chartOfAccounts
    .filter(a => !a.is_header)
    .map(a => ({
      value: a.account_number,
      label: `${a.account_number} — ${a.name}`,
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload: UpdateTransactionPayload = {
      description,
      counterparty_name: counterparty,
      re_journal: true,
    };
    if (accountCode) payload.account_code = accountCode;
    if (expenseCategory) payload.expense_category = expenseCategory;
    // excluded_reason: '' means un-exclude
    payload.excluded_reason = isExcluded ? excludeReason || 'Manually excluded' : '';
    await onSave(payload);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 pt-2">
      {/* Description */}
      <div className="space-y-1.5">
        <Label htmlFor="edit-description" className="text-xs text-muted-foreground">
          Description
        </Label>
        <Input
          id="edit-description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="h-8 text-sm bg-white/5 border-white/15"
          placeholder="Transaction description"
        />
      </div>

      {/* Counterparty */}
      <div className="space-y-1.5">
        <Label htmlFor="edit-counterparty" className="text-xs text-muted-foreground">
          Counterparty / Merchant
        </Label>
        <Input
          id="edit-counterparty"
          value={counterparty}
          onChange={e => setCounterparty(e.target.value)}
          className="h-8 text-sm bg-white/5 border-white/15"
          placeholder="Vendor or counterparty name"
        />
      </div>

      {/* Account Code */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">GL Account</Label>
        <SearchableSelect
          options={accountOptions}
          value={accountCode}
          onChange={setAccountCode}
          placeholder="Select account..."
          className="h-8 text-sm bg-white/5 border-white/15"
        />
        {accountCode && (
          <p className="text-[11px] text-muted-foreground">
            Changing this will reverse and recreate the journal entry.
          </p>
        )}
      </div>

      {/* Exclude toggle */}
      <div className="rounded-lg border border-white/10 p-3 space-y-3">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-red-500"
            checked={isExcluded}
            onChange={e => setIsExcluded(e.target.checked)}
          />
          <div>
            <span className="text-sm font-medium text-foreground">Exclude transaction</span>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Excluded transactions won't be journalled. Existing journals will be reversed.
            </p>
          </div>
        </label>
        {isExcluded && (
          <Input
            value={excludeReason}
            onChange={e => setExcludeReason(e.target.value)}
            className="h-8 text-sm bg-white/5 border-white/15"
            placeholder="Reason for exclusion (e.g. 'Internal transfer')"
          />
        )}
      </div>

      <Button type="submit" disabled={isSaving} className="w-full h-9 text-sm">
        {isSaving ? (
          <>
            <ClockClockwise size={16} className="animate-spin" />
            Saving…
          </>
        ) : (
          <>
            <Check size={16} />
            Save Changes
          </>
        )}
      </Button>
    </form>
  );
}

// ─── Main Drawer ─────────────────────────────────────────────────────────────

export interface TransactionDrawerProps {
  entityId: string;
  transactionId: string | null;
  onClose: () => void;
  chartOfAccounts: ChartOfAccountEntry[];
  onTransactionUpdated?: (txn: FinancialTransaction) => void;
}

export function TransactionDrawer({
  entityId,
  transactionId,
  onClose,
  chartOfAccounts,
  onTransactionUpdated,
}: TransactionDrawerProps) {
  const [txn, setTxn] = useState<FinancialTransaction | null>(null);
  const [journal, setJournal] = useState<TransactionJournal | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [journalCollapsed, setJournalCollapsed] = useState(false);

  // Load transaction + journal whenever ID changes
  useEffect(() => {
    if (!transactionId) {
      setTxn(null);
      setJournal(null);
      return;
    }
    setIsLoading(true);
    setEditOpen(false);
    setJournalCollapsed(false);
    getTransaction(entityId, transactionId)
      .then(data => {
        setTxn(data.transaction);
        setJournal(data.journal);
      })
      .catch(err => {
        toast.error(`Failed to load transaction: ${err.message}`);
      })
      .finally(() => setIsLoading(false));
  }, [transactionId, entityId]);

  const handleSave = useCallback(
    async (payload: UpdateTransactionPayload) => {
      if (!transactionId) return;
      setIsSaving(true);
      try {
        const result = await updateTransaction(entityId, transactionId, payload);
        setTxn(result.transaction);
        if (result.new_journal) {
          setJournal(result.new_journal);
        } else if (result.journal_action === 'reversed') {
          // Journal was reversed — refetch to show updated state
          const fresh = await getTransaction(entityId, transactionId);
          setJournal(fresh.journal);
        } else if (result.journal_action === 'reversed_and_recreated') {
          const fresh = await getTransaction(entityId, transactionId);
          setJournal(fresh.journal);
        }
        onTransactionUpdated?.(result.transaction);

        const actionMessages: Record<string, string> = {
          reversed: 'Transaction updated — journal reversed.',
          reversed_and_recreated: 'Transaction updated — journal reversed and recreated.',
          reversed_only: 'Transaction updated — journal reversed (recreate failed, check logs).',
          none: 'Transaction updated.',
        };
        toast.success(actionMessages[result.journal_action] ?? 'Transaction updated.');

        if (result.re_journal_needed) {
          toast.info('Transaction un-excluded. You can now generate a new journal for it.');
        }

        setEditOpen(false);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Failed to save: ${msg}`);
      } finally {
        setIsSaving(false);
      }
    },
    [transactionId, entityId, onTransactionUpdated]
  );

  const isOpen = !!transactionId;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 bg-black/40 backdrop-blur-sm z-40 transition-opacity duration-300',
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        className={cn(
          'fixed top-0 right-0 h-full w-full sm:w-[520px] z-50 flex flex-col',
          'bg-card border-l border-white/10 shadow-2xl',
          'transition-transform duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <CurrencyCircleDollar size={20} weight="duotone" className="text-primary" />
            <span className="font-semibold text-foreground">Transaction Detail</span>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 -mr-1">
            <X size={18} />
          </Button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-0">
          {isLoading && (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <ClockClockwise size={24} className="animate-spin mr-3" />
              Loading…
            </div>
          )}

          {!isLoading && txn && (
            <>
              {/* ── Amount Hero ── */}
              <div className="text-center py-5">
                <div
                  className={cn(
                    'text-3xl font-bold font-mono',
                    txn.direction === 'in' ? 'text-emerald-400' : 'text-rose-400'
                  )}
                >
                  {txn.direction === 'in' ? '+' : '−'}
                  {formatMoney(txn.amount, txn.currency_code)}
                </div>
                <div className="flex items-center justify-center gap-2 mt-2 flex-wrap">
                  <DirectionBadge direction={txn.direction} />
                  <SourceBadge source={txn.source} />
                  {txn.excluded_reason && <ExcludedBadge />}
                  {txn.journalised_at && !txn.excluded_reason && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-green-500/15 text-green-400 border-green-500/30">
                      <CheckCircle size={11} weight="fill" />
                      Journalled
                    </span>
                  )}
                  {!txn.journalised_at && !txn.excluded_reason && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-amber-500/15 text-amber-400 border-amber-500/30">
                      <Warning size={11} weight="fill" />
                      Not journalled
                    </span>
                  )}
                </div>
              </div>

              {/* ── Transaction Details ── */}
              <div>
                <SectionHeader icon={<Info size={16} />} title="Transaction Details" />
                <div className="pt-1">
                  <DetailRow label="Date">{formatDate(txn.occurred_at)}</DetailRow>
                  <DetailRow label="Source">
                    <span className="capitalize">{txn.source}</span>
                  </DetailRow>
                  <DetailRow label="Type">
                    <span className="capitalize">{txn.transaction_type?.replace('_', ' ')}</span>
                  </DetailRow>
                  <DetailRow label="Counterparty">
                    {txn.counterparty_name || (
                      <span className="text-muted-foreground italic">—</span>
                    )}
                  </DetailRow>
                  <DetailRow label="Description">
                    {txn.description || <span className="text-muted-foreground italic">—</span>}
                  </DetailRow>
                  <DetailRow label="Reference">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {txn.external_transaction_id}
                    </span>
                  </DetailRow>
                  {!!txn.metadata?.account_code && (
                    <DetailRow label="GL Account">
                      <span className="font-mono">{String(txn.metadata.account_code)}</span>
                    </DetailRow>
                  )}
                  {txn.excluded_reason && (
                    <DetailRow label="Excluded reason">
                      <span className="text-red-400">{txn.excluded_reason}</span>
                    </DetailRow>
                  )}
                </div>
              </div>

              {/* ── Journal ── */}
              <div className="mt-4">
                <SectionHeader
                  icon={<BookOpen size={16} />}
                  title={journal ? 'Associated Journal' : 'Journal'}
                  collapsible={!!journal}
                  collapsed={journalCollapsed}
                  onToggle={() => setJournalCollapsed(v => !v)}
                />

                {!journalCollapsed && (
                  <div className="pt-2">
                    {journal ? (
                      <>
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                          <JournalStatusBadge status={journal.status} />
                          <span className="text-xs text-muted-foreground capitalize">
                            {journal.journal_type.replace('_', ' ')} journal
                          </span>
                          <span className="text-xs text-muted-foreground">
                            · {formatDate(journal.journal_date)}
                          </span>
                        </div>
                        {journal.description && (
                          <p className="text-sm text-foreground/80 mb-3">{journal.description}</p>
                        )}
                        {journal.line_items && journal.line_items.length > 0 ? (
                          <LineItemsTable items={journal.line_items} />
                        ) : (
                          <p className="text-xs text-muted-foreground italic">
                            No line items found.
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                        <Warning size={16} className="text-amber-400" />
                        No journal entry exists for this transaction yet.
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Edit Section ── */}
              <div className="mt-4 rounded-lg border border-white/10 overflow-hidden">
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-foreground hover:bg-white/5 transition-colors"
                  onClick={() => setEditOpen(v => !v)}
                >
                  <div className="flex items-center gap-2">
                    <PencilSimple size={16} weight="duotone" className="text-primary" />
                    Edit Transaction
                  </div>
                  {editOpen ? <CaretUp size={14} /> : <CaretDown size={14} />}
                </button>

                {editOpen && (
                  <div className="px-4 pb-4 border-t border-white/10">
                    {journal && journal.status === 'posted' && (
                      <div className="flex items-start gap-2 my-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
                        <Warning size={14} className="shrink-0 mt-0.5" />
                        <span>
                          This transaction has a posted journal. Changing the GL account will
                          reverse it and create a corrected entry.
                        </span>
                      </div>
                    )}
                    <EditForm
                      txn={txn}
                      chartOfAccounts={chartOfAccounts}
                      onSave={handleSave}
                      isSaving={isSaving}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
