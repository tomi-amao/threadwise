/**
 * TransactionDrawer
 *
 * Right-hand slide-over for one transaction: details, its journal (the double entry), and an
 * edit form. Behaviour is unchanged from the previous drawer: saving always asks the API to
 * re-journal, changing the ledger account on a posted journal reverses and recreates it, and
 * excluding a transaction reverses any journal.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowSquareOut,
  CaretDown,
  CaretUp,
  CircleNotch,
  FileImage,
  FilePdf,
  Paperclip,
} from 'phosphor-react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Chip, type ChipTone } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { Drawer } from '~/components/ui/drawer';
import { Eyebrow } from '~/components/ui/eyebrow';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { SearchableSelect } from '~/components/ui/searchable-select';
import type { ChartOfAccountEntry } from '~/lib/api/accounting';
import {
  attachmentUrl,
  getTransaction,
  updateTransaction,
  type FinancialTransaction,
  type TransactionAttachment,
  type JournalLineItemWithAccount,
  type TransactionJournal,
  type UpdateTransactionPayload,
} from '~/lib/api/transactions';
import { cn } from '~/lib/utils';
import {
  FILING,
  SOURCE_LABEL,
  baseAmount,
  dateTime,
  fileSize,
  filingOf,
  money,
  shortDate,
  typeLabel,
} from './format';

const JOURNAL_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  posted: { label: 'Posted', tone: 'done' },
  draft: { label: 'Draft', tone: 'active' },
  reversed: { label: 'Reversed', tone: 'plain' },
};

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <dt className="shrink-0 text-text-2">{label}</dt>
      <dd className="min-w-0 break-words text-right">{children}</dd>
    </div>
  );
}

function AttachmentList({ attachments }: { attachments: TransactionAttachment[] }) {
  return (
    <ul className="mt-3 divide-y rounded-xl border">
      {attachments.map(file => {
        const Icon = file.content_type.startsWith('image/')
          ? FileImage
          : file.content_type === 'application/pdf'
            ? FilePdf
            : Paperclip;
        return (
          <li key={file.id}>
            <a
              href={attachmentUrl(file.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon size={18} weight="light" className="shrink-0 text-text-2" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{file.file_name}</span>
                <span className="block text-[13px] text-muted-foreground">
                  {SOURCE_LABEL[file.source] ?? file.source} · {fileSize(file.size_bytes)}
                </span>
              </span>
              <ArrowSquareOut
                size={14}
                weight="light"
                className="shrink-0 text-text-2"
                aria-hidden
              />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function JournalTable({ items }: { items: JournalLineItemWithAccount[] }) {
  const debit = items.reduce((s, i) => s + Number(i.debit), 0);
  const credit = items.reduce((s, i) => s + Number(i.credit), 0);
  const currency = items[0]?.currency ?? 'GBP';
  return (
    <DataTable label="Journal lines" dense className="mt-3">
      <thead>
        <tr>
          <th>Account</th>
          <th className="text-right">Debit</th>
          <th className="text-right">Credit</th>
        </tr>
      </thead>
      <tbody>
        {items.map(item => (
          <tr key={item.id}>
            <td>
              <div>
                {item.account_number} — {item.account_name ?? item.account_id.slice(0, 8)}
              </div>
              {item.description && (
                <div className="max-w-[200px] truncate text-[13px] text-muted-foreground">
                  {item.description}
                </div>
              )}
            </td>
            <td className="text-right tabular-nums">
              {Number(item.debit) > 0 ? money(Number(item.debit), item.currency) : '—'}
            </td>
            <td className="text-right tabular-nums">
              {Number(item.credit) > 0 ? money(Number(item.credit), item.currency) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td className="text-right tabular-nums">{money(debit, currency)}</td>
          <td className="text-right tabular-nums">{money(credit, currency)}</td>
        </tr>
      </tfoot>
    </DataTable>
  );
}

function EditForm({
  txn,
  chartOfAccounts,
  onSave,
  isSaving,
}: {
  txn: FinancialTransaction;
  chartOfAccounts: ChartOfAccountEntry[];
  onSave: (payload: UpdateTransactionPayload) => Promise<void>;
  isSaving: boolean;
}) {
  const [description, setDescription] = useState(txn.description ?? '');
  const [counterparty, setCounterparty] = useState(txn.counterparty_name ?? '');
  const [accountCode, setAccountCode] = useState((txn.metadata?.account_code as string) ?? '');
  const [expenseCategory, setExpenseCategory] = useState(
    (txn.metadata?.expense_category as string) ?? ''
  );
  const [isExcluded, setIsExcluded] = useState(!!txn.excluded_reason);
  const [excludeReason, setExcludeReason] = useState(txn.excluded_reason ?? '');

  // Reset when a different transaction is shown.
  useEffect(() => {
    setDescription(txn.description ?? '');
    setCounterparty(txn.counterparty_name ?? '');
    setAccountCode((txn.metadata?.account_code as string) ?? '');
    setExpenseCategory((txn.metadata?.expense_category as string) ?? '');
    setIsExcluded(!!txn.excluded_reason);
    setExcludeReason(txn.excluded_reason ?? '');
    // Only the identity matters: re-syncing on every field would fight the user's typing.
  }, [txn.id]);

  const accountOptions = chartOfAccounts
    .filter(a => !a.is_header)
    .map(a => ({ value: a.account_number, label: `${a.account_number} — ${a.name}` }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload: UpdateTransactionPayload = {
      description,
      counterparty_name: counterparty,
      re_journal: true,
    };
    if (accountCode) payload.account_code = accountCode;
    if (expenseCategory) payload.expense_category = expenseCategory;
    // '' means "un-exclude" to the API.
    payload.excluded_reason = isExcluded ? excludeReason || 'Manually excluded' : '';
    await onSave(payload);
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 pt-4">
      <Field label="Description">
        <Input value={description} onChange={e => setDescription(e.target.value)} />
      </Field>
      <Field label="Counterparty">
        <Input value={counterparty} onChange={e => setCounterparty(e.target.value)} />
      </Field>

      <div className="grid gap-1.5">
        <span className="eyebrow" id="ledger-account-label">
          Ledger account
        </span>
        <SearchableSelect
          aria-label="Ledger account"
          options={accountOptions}
          value={accountCode}
          onChange={setAccountCode}
          placeholder="Select account…"
          className="h-10 w-full rounded-xl border-input bg-card px-3.5 text-[15px]"
        />
        {accountCode && (
          <p className="text-[13px] text-muted-foreground">
            Changing this reverses and recreates the journal entry.
          </p>
        )}
      </div>

      <div className="grid gap-3 rounded-xl border p-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={isExcluded}
            onChange={e => setIsExcluded(e.target.checked)}
            className="mt-1 size-4 accent-[var(--primary)]"
          />
          <span>
            Exclude from the ledger
            <span className="block text-[13px] text-muted-foreground">
              Excluded transactions are not journalled, and any existing journal is reversed.
            </span>
          </span>
        </label>
        {isExcluded && (
          <Input
            value={excludeReason}
            onChange={e => setExcludeReason(e.target.value)}
            placeholder="Reason, e.g. Internal transfer"
            aria-label="Reason for exclusion"
          />
        )}
      </div>

      <Button type="submit" disabled={isSaving} className="w-full">
        {isSaving ? (
          <>
            <CircleNotch size={16} weight="light" className="animate-spin" aria-hidden /> Saving…
          </>
        ) : (
          'Save changes'
        )}
      </Button>
    </form>
  );
}

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
  const [attachments, setAttachments] = useState<TransactionAttachment[]>([]);
  const [journal, setJournal] = useState<TransactionJournal | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    if (!transactionId) {
      setTxn(null);
      setJournal(null);
      setAttachments([]);
      return;
    }
    let current = true;
    setIsLoading(true);
    setEditOpen(false);
    getTransaction(transactionId)
      .then(data => {
        if (!current) return;
        setTxn(data.transaction);
        setJournal(data.journal);
        setAttachments(data.attachments ?? []);
      })
      .catch(err => toast.error(`Failed to load transaction: ${err.message}`))
      .finally(() => current && setIsLoading(false));
    return () => {
      current = false;
    };
  }, [transactionId]);

  const handleSave = useCallback(
    async (payload: UpdateTransactionPayload) => {
      if (!transactionId) return;
      setIsSaving(true);
      try {
        const result = await updateTransaction(entityId, transactionId, payload);
        setTxn(result.transaction);
        if (result.new_journal) {
          setJournal(result.new_journal);
        } else if (
          result.journal_action === 'reversed' ||
          result.journal_action === 'reversed_and_recreated'
        ) {
          // The journal changed state: refetch so the table shows what is now true.
          const fresh = await getTransaction(transactionId);
          setJournal(fresh.journal);
        }
        onTransactionUpdated?.(result.transaction);

        const messages: Record<string, string> = {
          reversed: 'Transaction updated — journal reversed.',
          reversed_and_recreated: 'Transaction updated — journal reversed and recreated.',
          reversed_only: 'Transaction updated — journal reversed (recreate failed, check logs).',
          none: 'Transaction updated.',
        };
        toast.success(messages[result.journal_action] ?? 'Transaction updated.');
        if (result.re_journal_needed) {
          toast.info('Transaction un-excluded. You can now generate a new journal for it.');
        }
        setEditOpen(false);
      } catch (err: unknown) {
        toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setIsSaving(false);
      }
    },
    [transactionId, entityId, onTransactionUpdated]
  );

  const filing = txn ? filingOf(txn) : null;
  const foreign = !!txn && !!txn.base_currency_code && txn.currency_code !== txn.base_currency_code;
  const title = txn ? txn.counterparty_name || txn.description || 'Transaction' : 'Transaction';

  return (
    <Drawer
      open={!!transactionId}
      onOpenChange={open => !open && onClose()}
      eyebrow={
        txn
          ? `${typeLabel(txn.transaction_type)} · ${SOURCE_LABEL[txn.source] ?? txn.source}`
          : 'Transaction'
      }
      title={title}
      description="Transaction details, journal and edit form"
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      {isLoading && (
        <div role="status" className="flex items-center gap-3 py-16 text-text-2">
          <CircleNotch size={20} weight="light" className="animate-spin" aria-hidden /> Loading…
        </div>
      )}

      {!isLoading && txn && filing && (
        <>
          <div>
            <div
              className={cn(
                'font-serif text-[52px] leading-[1.05] tabular-nums',
                txn.direction === 'in' && !txn.excluded_reason && 'text-income'
              )}
            >
              {txn.direction === 'in' ? '+' : '−'}
              {money(baseAmount(txn), txn.base_currency_code ?? 'GBP')}
            </div>
            {foreign && (
              <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                {money(txn.amount, txn.currency_code)}
                {txn.fx_rate ? ` · RATE ${Number(txn.fx_rate).toFixed(4)}` : ''}
              </div>
            )}
            <div className="mt-3.5 flex flex-wrap gap-2">
              <Chip tone={txn.direction === 'in' ? 'income' : 'plain'}>
                {txn.direction === 'in' ? 'Inbound' : 'Outbound'}
              </Chip>
              <Chip tone={FILING[filing].tone} dot>
                {filing === 'pending' ? 'Not journalled' : FILING[filing].label}
              </Chip>
            </div>
          </div>

          <dl className="divide-y border-y">
            <Detail label="Date">{dateTime(txn.occurred_at)}</Detail>
            <Detail label="Counterparty">{txn.counterparty_name || '—'}</Detail>
            <Detail label="Description">{txn.description || '—'}</Detail>
            <Detail label="Reference">
              <span className="font-mono text-[13px] text-text-2">
                {txn.external_transaction_id}
              </span>
            </Detail>
            {!!txn.metadata?.account_code && (
              <Detail label="Ledger account">
                <span className="font-mono">{String(txn.metadata.account_code)}</span>
              </Detail>
            )}
            {txn.excluded_reason && <Detail label="Excluded because">{txn.excluded_reason}</Detail>}
          </dl>

          {attachments.length > 0 && (
            <div>
              <Eyebrow>Attachments</Eyebrow>
              <AttachmentList attachments={attachments} />
            </div>
          )}

          <div>
            <Eyebrow>{journal ? 'Associated journal' : 'Journal'}</Eyebrow>
            {journal ? (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-text-2">
                  <Chip tone={(JOURNAL_STATUS[journal.status] ?? JOURNAL_STATUS.draft).tone} dot>
                    {(JOURNAL_STATUS[journal.status] ?? JOURNAL_STATUS.draft).label}
                  </Chip>
                  <span className="capitalize">
                    {journal.journal_type.replace('_', ' ')} journal
                  </span>
                  <span>· {shortDate(journal.journal_date)}</span>
                </div>
                {journal.description && <p className="mt-3 text-text-2">{journal.description}</p>}
                {journal.line_items && journal.line_items.length > 0 ? (
                  <JournalTable items={journal.line_items} />
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">No line items found.</p>
                )}
              </>
            ) : (
              <p className="mt-3 text-text-2">
                {filing === 'excluded'
                  ? 'Excluded transactions never reach the ledger.'
                  : 'No journal entry exists for this transaction yet.'}
              </p>
            )}
          </div>

          <div className="border-t pt-4">
            <button
              type="button"
              onClick={() => setEditOpen(v => !v)}
              aria-expanded={editOpen}
              className="flex w-full items-center justify-between rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Eyebrow>Edit transaction</Eyebrow>
              {editOpen ? (
                <CaretUp size={14} weight="light" aria-hidden />
              ) : (
                <CaretDown size={14} weight="light" aria-hidden />
              )}
            </button>
            {editOpen && (
              <>
                {journal?.status === 'posted' && (
                  <p className="mt-4 rounded-xl border bg-muted px-4 py-3 text-sm text-text-2">
                    This transaction has a posted journal. Changing the ledger account reverses it
                    and creates a corrected entry.
                  </p>
                )}
                <EditForm
                  txn={txn}
                  chartOfAccounts={chartOfAccounts}
                  onSave={handleSave}
                  isSaving={isSaving}
                />
              </>
            )}
          </div>
        </>
      )}
    </Drawer>
  );
}
