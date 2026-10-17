/**
 * InvoiceDrawer
 *
 * One invoice, from upload to payment, in one place (replaces three modals). The top of the
 * drawer is always the next step: a draft is reviewed and finalised (which posts it to the
 * books), an open invoice is marked paid, and so on. Below are the facts, the lines with
 * their accounts, the stock decisions for a purchase, the document and the notes.
 *
 * The drawer loads its own data from /api/invoices?id= and reloads it after every change. The
 * page's list revalidates too, through `onChanged`.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, ArrowSquareOut, CircleNotch, FileText } from 'phosphor-react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Drawer } from '~/components/ui/drawer';
import { Eyebrow } from '~/components/ui/eyebrow';
import { FIELD_TRIGGER_CLASS, SearchableSelect } from '~/components/ui/searchable-select';
import { Textarea } from '~/components/ui/textarea';
import type { InvoiceDetail, InvoiceStatus, StockDecision } from '~/types/invoice';
import { cn } from '~/lib/utils';
import { StockSection, looksLikeStock } from './StockSection';
import {
  DIRECTION,
  STATUS,
  counterpartyName,
  dueText,
  int,
  money,
  shortDate,
  shownStatus,
} from './model';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; detail: InvoiceDetail };

interface Result {
  ok: boolean;
  error?: string;
  code?: string;
  warnings?: string[];
  voided?: number;
  recorded?: number;
  notRecorded?: string[];
  url?: string;
}

async function call(fields: Record<string, string>): Promise<Result> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  try {
    const response = await fetch('/api/invoices', { method: 'POST', body: form });
    return (await response.json()) as Result;
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
}

const STAGES: { id: 'review' | 'open' | 'paid'; label: string }[] = [
  { id: 'review', label: 'To review' },
  { id: 'open', label: 'Open' },
  { id: 'paid', label: 'Paid' },
];

const stageOf = (status: InvoiceStatus): 'review' | 'open' | 'paid' | null =>
  status === 'DRAFT'
    ? 'review'
    : status === 'PAID'
      ? 'paid'
      : status === 'CANCELLED' || status === 'VOID'
        ? null
        : 'open';

function StageRail({ status }: { status: InvoiceStatus }) {
  const current = stageOf(status);
  if (!current) {
    return <Chip tone="draft">{STATUS[status].label}: no effect on your books</Chip>;
  }
  return (
    <ol aria-label="Stage" className="flex flex-wrap items-center gap-2 text-[13px]">
      {STAGES.map((stage, i) => {
        const active = stage.id === current;
        return (
          <li
            key={stage.id}
            className="flex items-center gap-2"
            aria-current={active ? 'step' : undefined}
          >
            {i > 0 && <ArrowRight size={12} className="text-muted-foreground" aria-hidden />}
            <span
              className={cn(
                'rounded-full border px-3 py-1',
                active
                  ? 'border-transparent bg-foreground text-background'
                  : 'border-border text-text-2'
              )}
            >
              {stage.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Confirm({
  open,
  title,
  description,
  confirm,
  tone = 'default',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirm: string;
  tone?: 'default' | 'destructive';
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={next => !next && !busy && onCancel()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-[24px] font-light tracking-[-0.03em]">
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2.5">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Pending = 'unmatched-paid' | 'void' | 'delete' | 'unpay';

export function InvoiceDrawer({
  invoiceId,
  today,
  onClose,
  onChanged,
}: {
  invoiceId: string | null;
  today: string;
  onClose: () => void;
  /** The invoice changed or was removed: refresh the list behind the drawer. */
  onChanged: () => void;
}) {
  const [load, setLoad] = useState<Load & { id?: string }>({ state: 'loading' });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    if (!invoiceId) return;
    let live = true;
    fetch(`/api/invoices?id=${encodeURIComponent(invoiceId)}`)
      .then(r => r.json())
      .then((result: Result & { detail?: InvoiceDetail }) => {
        if (!live) return;
        if (result.ok && result.detail) {
          setLoad({ state: 'ready', detail: result.detail, id: invoiceId });
        } else {
          setLoad({
            state: 'error',
            message: result.error ?? 'Could not load this invoice',
            id: invoiceId,
          });
        }
      })
      .catch(
        () =>
          live && setLoad({ state: 'error', message: 'Could not load this invoice', id: invoiceId })
      );
    return () => {
      live = false;
    };
  }, [invoiceId, version]);

  // Data from the invoice that was open before is not shown while the next one loads.
  const ready = load.state === 'ready' && load.id === invoiceId ? load.detail : null;
  const failed = load.state === 'error' && load.id === invoiceId ? load.message : null;

  return (
    <Drawer
      open={!!invoiceId}
      onOpenChange={open => !open && onClose()}
      eyebrow={ready ? `Invoice ${ready.invoice.invoice_number}` : 'Invoice'}
      title={ready ? counterpartyName(ready.invoice) : failed ? 'Invoice' : 'Loading…'}
      description="Review, finalise and track this invoice"
      className="w-[min(640px,100vw)]"
    >
      {invoiceId && failed && (
        <div role="alert" className="space-y-3">
          <p className="text-destructive">{failed}</p>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
      {invoiceId && !failed && !ready && (
        <div role="status" className="flex items-center gap-2 text-text-2">
          <CircleNotch size={18} className="animate-spin" aria-hidden /> Loading invoice…
        </div>
      )}
      {invoiceId && ready && (
        <Body
          key={invoiceId}
          invoiceId={invoiceId}
          detail={ready}
          today={today}
          reload={reload}
          onClose={onClose}
          onChanged={onChanged}
        />
      )}
    </Drawer>
  );
}

function Body({
  invoiceId,
  detail,
  today,
  reload,
  onClose,
  onChanged,
}: {
  invoiceId: string;
  detail: InvoiceDetail;
  today: string;
  reload: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [coding, setCoding] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<string | null>(null);

  /** Run a change; refresh the drawer and the list when it works, show the reason when not. */
  const run = async (
    key: string,
    fields: Record<string, string>,
    success: (result: Result) => string | null
  ): Promise<Result> => {
    setBusy(key);
    const result = await call({ ...fields, invoiceId });
    setBusy(null);
    if (!result.ok) {
      toast.error(result.error ?? 'That did not work');
      return result;
    }
    const message = success(result);
    if (message) toast.success(message);
    for (const warning of result.warnings ?? []) toast.warning(warning);
    reload();
    onChanged();
    return result;
  };

  const { invoice, lines, journals, matched_transaction_id, stocked_line_ids } = detail;
  const { gl_accounts, products } = detail;
  const status = invoice.status;
  const shown = shownStatus(invoice, today);
  const due = dueText(invoice, today);
  const isSale = invoice.invoice_type === 'SALE';
  const isDraft = status === 'DRAFT';
  const finalised = ['OPEN', 'OVERDUE', 'PARTIALLY_PAID', 'PAID'].includes(status);
  const unpaid = ['OPEN', 'OVERDUE', 'PARTIALLY_PAID'].includes(status);
  const dead = status === 'CANCELLED' || status === 'VOID';

  const accountOf = (lineId: string, saved: string | null) => coding[lineId] ?? saved ?? '';
  const uncoded = lines.filter(l => !accountOf(l.id, l.gl_account_id)).length;
  const codingDirty = lines.some(l => accountOf(l.id, l.gl_account_id) !== (l.gl_account_id ?? ''));
  const stockLines = lines.filter(looksLikeStock);
  const stockOpen = stockLines.filter(l => !stocked_line_ids.includes(l.id)).length;

  const accountOptions = gl_accounts
    .filter(a =>
      isSale
        ? ['revenue', 'income', 'asset'].includes(a.account_type)
        : !['revenue', 'income'].includes(a.account_type)
    )
    .map(a => ({
      value: a.id,
      label: `${a.account_number} · ${a.name}`,
      group: a.account_type.replace(/_/g, ' '),
    }));

  const setStatus = (target: InvoiceStatus, label: string, extra: Record<string, string> = {}) =>
    run('status', { intent: 'setStatus', status: target, ...extra }, () => label);

  const finalise = () => setStatus('OPEN', 'Invoice finalised and posted to your books');

  const markPaid = async () => {
    const result = await setStatus('PAID', 'Marked as paid');
    if (!result.ok && result.code === 'no_matching_payment') setPending('unmatched-paid');
  };

  const saveCoding = () =>
    run(
      'coding',
      {
        intent: 'update',
        lineAccounts: JSON.stringify(
          Object.fromEntries(Object.entries(coding).map(([id, gl]) => [id, gl || null]))
        ),
      },
      () => 'Accounts saved'
    ).then(r => r.ok && setCoding({}));

  const applyStock = (decisions: StockDecision[]) =>
    run('stock', { intent: 'stock', decisions: JSON.stringify(decisions) }, r =>
      r.notRecorded?.length
        ? null
        : `Stock recorded for ${r.recorded ?? decisions.length} ${r.recorded === 1 ? 'line' : 'lines'}`
    ).then(r => {
      if (r.ok && r.notRecorded?.length) {
        toast.warning(
          `${r.notRecorded.length} ${r.notRecorded.length === 1 ? 'line' : 'lines'} could not be recorded as stock (they need a quantity and a unit cost).`
        );
      }
    });

  const openDocument = async () => {
    setBusy('document');
    try {
      const response = await fetch(`/api/invoices?id=${encodeURIComponent(invoiceId)}&document=1`);
      const result = (await response.json()) as Result;
      if (result.ok && result.url) window.open(result.url, '_blank', 'noopener,noreferrer');
      else toast.error(result.error ?? 'Could not open the document');
    } finally {
      setBusy(null);
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    if (pending === 'unmatched-paid') {
      const r = await setStatus('PAID', 'Marked as paid', { confirmUnmatched: '1' });
      if (r.ok) setPending(null);
    } else if (pending === 'void') {
      const r = await setStatus('VOID', 'Invoice voided and reversed in your books');
      if (r.ok) setPending(null);
    } else if (pending === 'unpay') {
      const r = await setStatus('OPEN', 'Payment undone');
      if (r.ok) setPending(null);
    } else {
      const r = await run('delete', { intent: 'delete' }, () => 'Invoice deleted');
      if (r.ok) {
        setPending(null);
        onClose();
      }
    }
  };

  const pendingCopy: Record<
    Pending,
    { title: string; description: string; confirm: string; tone?: 'destructive' }
  > = {
    'unmatched-paid': {
      title: 'Mark paid without a matched payment?',
      description:
        'No bank payment has been matched to this invoice. It will be marked paid, but the ledger cannot show which account the money left until a payment is matched.',
      confirm: 'Mark paid anyway',
    },
    void: {
      title: 'Void this invoice?',
      description:
        'The invoice stays on record, but every journal it posted is reversed so it no longer affects your books. This cannot be undone.',
      confirm: 'Void invoice',
      tone: 'destructive',
    },
    unpay: {
      title: 'Undo the payment?',
      description:
        'The invoice goes back to open and its payment journal is reversed. The invoice itself stays in your books.',
      confirm: 'Undo payment',
    },
    delete: {
      title: 'Delete this invoice?',
      description: 'The invoice, its lines and its document are removed. This cannot be undone.',
      confirm: 'Delete',
      tone: 'destructive',
    },
  };

  return (
    <>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={STATUS[shown].tone} dot>
            {STATUS[shown].label}
          </Chip>
          <Chip tone={isSale ? 'income' : 'plain'}>{DIRECTION[invoice.invoice_type].label}</Chip>
        </div>
      </header>

      <StageRail status={status} />

      <section aria-label="Next step" className="space-y-3 rounded-2xl border bg-card p-4">
        {isDraft && (
          <>
            <div>
              <Eyebrow>Next</Eyebrow>
              <p className="mt-1 text-[15px]">Check the lines, then finalise.</p>
              <p className="mt-1 text-[13px] text-text-2">
                {isSale
                  ? `Finalising records ${money(invoice.gross_amount, invoice.currency)} as owed to you.`
                  : `Finalising posts this to your books: each line is debited to its account and Accounts Payable is credited ${money(invoice.gross_amount, invoice.currency)}.`}
              </p>
            </div>
            <ul className="space-y-1 text-[13px]">
              <li className={uncoded > 0 ? 'text-accent-text' : 'text-text-2'}>
                {uncoded === 0
                  ? 'Every line has an account.'
                  : `${uncoded} ${uncoded === 1 ? 'line has' : 'lines have'} no account and will use the default.`}
              </li>
              {!isSale && stockLines.length > 0 && (
                <li className={stockOpen > 0 ? 'text-accent-text' : 'text-text-2'}>
                  {stockOpen === 0
                    ? 'Stock is tracked for the lines that need it.'
                    : `${stockOpen} ${stockOpen === 1 ? 'line looks' : 'lines look'} like stock and ${stockOpen === 1 ? "isn't" : "aren't"} tracked yet.`}
                </li>
              )}
            </ul>
            <Button onClick={finalise} disabled={busy !== null}>
              {busy === 'status' ? 'Finalising…' : 'Finalise invoice'}
            </Button>
          </>
        )}

        {unpaid && (
          <>
            <div>
              <Eyebrow>Next</Eyebrow>
              <p className={cn('mt-1 text-[15px]', due?.overdue && 'text-destructive')}>
                {due?.text ?? 'Waiting for payment'}
                {invoice.due_date && ` · ${shortDate(invoice.due_date)}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={markPaid} disabled={busy !== null}>
                {busy === 'status' ? 'Saving…' : isSale ? 'Mark as received' : 'Mark as paid'}
              </Button>
              {status !== 'PARTIALLY_PAID' && (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setStatus('PARTIALLY_PAID', 'Marked part paid')}
                >
                  Part paid
                </Button>
              )}
            </div>
          </>
        )}

        {status === 'PAID' && (
          <div className="space-y-2">
            <Eyebrow>Settled</Eyebrow>
            <p className="text-[15px]">
              {matched_transaction_id
                ? 'Paid, and matched to a bank transaction.'
                : 'Paid. No bank transaction is matched to it yet.'}
            </p>
            {matched_transaction_id && (
              <Link
                to={`/transactions?transactionId=${matched_transaction_id}`}
                className="inline-flex items-center gap-1 rounded-sm text-[14px] text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                View the transaction <ArrowSquareOut size={14} aria-hidden />
              </Link>
            )}
          </div>
        )}

        {dead && (
          <p className="text-[15px]">
            This invoice is {STATUS[status].label.toLowerCase()}. It stays on record but has no
            effect on your books.
          </p>
        )}
      </section>

      <section aria-label="Amounts" className="space-y-3">
        <dl className="grid grid-cols-3 gap-3">
          {[
            ['Net', money(invoice.net_amount, invoice.currency)],
            ['VAT', money(invoice.tax_amount, invoice.currency)],
            ['Total', money(invoice.gross_amount, invoice.currency)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="eyebrow">{label}</dt>
              <dd
                className={cn('mt-1 tabular-nums', label === 'Total' && 'font-serif text-[24px]')}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <dl className="grid grid-cols-3 gap-3 text-[14px]">
          <div>
            <dt className="eyebrow">Issued</dt>
            <dd className="mt-1">{shortDate(invoice.invoice_date)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Due</dt>
            <dd className="mt-1">{shortDate(invoice.due_date)}</dd>
          </div>
          <div>
            <dt className="eyebrow">Source</dt>
            <dd className="mt-1 capitalize">{invoice.source ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section aria-label="Lines" className="space-y-3 border-t pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <Eyebrow>Lines</Eyebrow>
          <span className="font-mono text-xs text-text-2">
            {lines.length} {lines.length === 1 ? 'LINE' : 'LINES'}
          </span>
        </div>
        <ul className="divide-y rounded-xl border">
          {lines.map(line => (
            <li key={line.id} className="space-y-2 px-3.5 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[15px]">{line.description}</div>
                  <div className="font-mono text-xs text-text-2">
                    {int(line.quantity)} × {money(line.unit_cost, invoice.currency)}
                    {line.vat_rate > 0 && ` · VAT ${Math.round(line.vat_rate * 100)}%`}
                  </div>
                </div>
                <div className="shrink-0 tabular-nums">
                  {money(line.line_net ?? line.quantity * line.unit_cost, invoice.currency)}
                </div>
              </div>
              <SearchableSelect
                aria-label={`Account for ${line.description}`}
                options={accountOptions}
                value={accountOf(line.id, line.gl_account_id)}
                onChange={value => setCoding(prev => ({ ...prev, [line.id]: value }))}
                placeholder="Choose an account"
                emptyOption="No account"
                className={FIELD_TRIGGER_CLASS}
                disabled={dead}
              />
            </li>
          ))}
        </ul>
        {codingDirty && (
          <Button variant="outline" onClick={saveCoding} disabled={busy !== null}>
            {busy === 'coding' ? 'Saving…' : 'Save accounts'}
          </Button>
        )}
        {finalised && codingDirty && (
          <p className="text-[13px] text-muted-foreground">
            Saving re-posts this invoice&rsquo;s journal with the new accounts.
          </p>
        )}
      </section>

      {!isSale && !dead && lines.length > 0 && (
        <StockSection
          key={`${stocked_line_ids.length}-${lines.length}`}
          lines={lines}
          stockedIds={stocked_line_ids}
          currency={invoice.currency}
          products={products}
          accounts={gl_accounts}
          busy={busy === 'stock'}
          onApply={applyStock}
        />
      )}

      <section aria-label="Notes" className="space-y-2 border-t pt-5">
        <label htmlFor="invoice-notes" className="eyebrow">
          Notes
        </label>
        <Textarea
          id="invoice-notes"
          value={notes ?? invoice.notes ?? ''}
          onChange={e => setNotes(e.target.value)}
          rows={3}
          placeholder="Anything worth remembering about this invoice"
        />
        {notes !== null && notes !== (invoice.notes ?? '') && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              run('notes', { intent: 'update', notes }, () => 'Notes saved').then(
                r => r.ok && setNotes(null)
              )
            }
          >
            {busy === 'notes' ? 'Saving…' : 'Save notes'}
          </Button>
        )}
      </section>

      <section aria-label="Record" className="space-y-3 border-t pt-5">
        <Eyebrow>Record</Eyebrow>
        <ul className="space-y-1 text-[14px] text-text-2">
          <li>
            {journals.length === 0
              ? 'Nothing is posted to your books for this invoice.'
              : `${journals.length} ${journals.length === 1 ? 'journal' : 'journals'} posted, latest ${shortDate(journals[journals.length - 1].journal_date)}.`}
          </li>
          <li>Added {shortDate(invoice.created_at)}</li>
        </ul>
        <div className="flex flex-wrap gap-2">
          {invoice.has_document && (
            <Button
              variant="outline"
              size="sm"
              onClick={openDocument}
              disabled={busy === 'document'}
            >
              <FileText size={14} weight="light" aria-hidden /> View document
            </Button>
          )}
          {finalised && status !== 'PAID' && (
            <Button variant="outline" size="sm" onClick={() => setPending('void')}>
              Void invoice
            </Button>
          )}
          {status === 'PAID' && (
            <>
              <Button variant="outline" size="sm" onClick={() => setPending('unpay')}>
                Undo payment
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPending('void')}>
                Void invoice
              </Button>
            </>
          )}
          {(isDraft || dead) && (
            <Button variant="outline" size="sm" onClick={() => setPending('delete')}>
              Delete {isDraft ? 'draft' : 'invoice'}
            </Button>
          )}
        </div>
      </section>

      <Confirm
        open={!!pending}
        busy={busy !== null}
        {...(pending ? pendingCopy[pending] : pendingCopy.delete)}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
