/**
 * SplitSection: how a purchase's matched payment is in the books, and the split its lines
 * suggest. A payment is journaled on its own, usually before the invoice arrives, to one
 * account (or as a draft when it could not be categorised). Once the invoice is matched, its
 * lines say what the money was for, so the payment's journal can be split across their
 * accounts (services/invoice_split.py works it out; nothing is stored until it is approved).
 *
 * Approving replaces the payment's journal with the split in one step, and Undo puts the
 * previous journal back as it was. The invoice itself still posts nothing: this is the
 * payment's journal, re-cut, so it keeps the payment's date and its cash side.
 */

import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { Eyebrow } from '~/components/ui/eyebrow';
import type { InvoiceLineItem, SplitJournalLine, SplitProposal } from '~/types/invoice';
import { money, shortDate } from './model';

const accountLabel = (line: SplitJournalLine) =>
  line.account_number
    ? `${line.account_number} · ${line.account_name ?? ''}`.trim()
    : 'Unknown account';

const debits = (lines: SplitJournalLine[]) => lines.filter(l => l.debit > 0);

/** "1033 · Finished goods" or "1033 · Finished goods and 6300 · Postage". */
const accountsOf = (lines: SplitJournalLine[]) =>
  [...new Set(debits(lines).map(accountLabel))].join(' and ');

export function SplitSection({
  proposals,
  invoiceNumber,
  invoiceCurrency,
  lines,
  busy,
  onApply,
  onUndo,
}: {
  proposals: SplitProposal[] | null;
  invoiceNumber: string;
  invoiceCurrency: string;
  lines: InvoiceLineItem[];
  busy: boolean;
  onApply: (transactionId: string) => void;
  onUndo: (transactionId: string) => void;
}) {
  if (proposals !== null && proposals.length === 0) return null;
  const lineName = new Map(lines.map(l => [l.id, l.description]));
  // A stored split's lines carry "INV-1: description"; the invoice number is said once above.
  const describe = (line: SplitJournalLine) =>
    (line.line_item_id && lineName.get(line.line_item_id)) ||
    line.description?.replace(`${invoiceNumber}: `, '') ||
    accountLabel(line);

  return (
    <section aria-label="Payment journal" className="space-y-3 rounded-2xl border bg-card p-4">
      <Eyebrow>In your books</Eyebrow>
      {proposals === null ? (
        <p className="text-[14px] text-text-2">
          How the payment is journaled cannot be shown right now. Try again in a moment.
        </p>
      ) : (
        proposals.map(p => (
          <div key={p.transaction_id} className="space-y-3">
            {proposals.length > 1 && (
              <p className="text-[13px] text-text-2">
                Payment of {money(p.payment_amount ?? 0, p.payment_currency ?? invoiceCurrency)} on{' '}
                {shortDate(p.occurred_at)}
              </p>
            )}
            {p.state === 'ready' && (
              <Ready
                proposal={p}
                invoiceCurrency={invoiceCurrency}
                describe={describe}
                busy={busy}
                onApply={() => onApply(p.transaction_id)}
              />
            )}
            {p.state === 'applied' && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="done">Split by this invoice</Chip>
                  <span className="text-[13px] text-text-2">
                    The payment’s journal follows the invoice’s lines.
                  </span>
                </div>
                <SplitLines lines={debits(p.lines)} describe={describe} />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onUndo(p.transaction_id)}
                >
                  Undo the split
                </Button>
              </>
            )}
            {(p.state === 'not_journaled' || p.state === 'unsupported') && (
              <p className="text-[14px] text-text-2">{p.reason}</p>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function Ready({
  proposal: p,
  invoiceCurrency,
  describe,
  busy,
  onApply,
}: {
  proposal: SplitProposal;
  invoiceCurrency: string;
  describe: (line: SplitJournalLine) => string;
  busy: boolean;
  onApply: () => void;
}) {
  const draft = p.replaces.some(r => r.status === 'draft');
  const share = p.share_of_invoice;
  const part = share !== null && Math.abs(share - 1) > 0.0001;
  const proposed = debits(p.lines);
  const vat = proposed.some(l => (l.vat ?? 0) > 0);

  return (
    <>
      <p className="text-[15px]">
        {draft ? 'The payment’s journal is a draft on ' : 'The payment is journaled to '}
        {accountsOf(p.current_lines)}
        {draft ? ', waiting for an account.' : '.'} Its invoice says what it was for:
      </p>
      <SplitLines lines={proposed} describe={describe} />
      <ul className="space-y-1 text-[13px] text-text-2">
        {part && (
          <li>
            The payment is {Math.round((share ?? 0) * 100)}% of the invoice, so each line takes that
            share.
          </li>
        )}
        {p.journal_currency && p.journal_currency !== invoiceCurrency && (
          <li>In {p.journal_currency}, as the payment was booked.</li>
        )}
        {vat && <li>VAT is included in each line, and its share is kept with the journal.</li>}
        <li>
          The journal keeps the payment’s date, {shortDate(p.occurred_at)}, and its cash side.
          {draft ? ' Splitting posts it.' : ''} You can undo it.
        </li>
      </ul>
      <Button size="sm" disabled={busy} onClick={onApply}>
        Split the journal
      </Button>
    </>
  );
}

function SplitLines({
  lines,
  describe,
}: {
  lines: SplitJournalLine[];
  describe: (line: SplitJournalLine) => string;
}) {
  return (
    <ul aria-label="Split" className="divide-y rounded-xl border">
      {lines.map((line, i) => (
        <li
          key={line.line_item_id ?? `${line.account_id}-${i}`}
          className="flex items-start justify-between gap-3 px-3.5 py-2.5"
        >
          <div className="min-w-0">
            <div className="truncate text-[15px]">{describe(line)}</div>
            <div className="text-[13px] text-text-2">
              {accountLabel(line)}
              {line.from_invoice_account === false && ' (the line has no account: kept as it was)'}
            </div>
          </div>
          <div className="shrink-0 tabular-nums">{money(line.debit, line.currency ?? 'GBP')}</div>
        </li>
      ))}
    </ul>
  );
}
