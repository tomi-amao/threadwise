/**
 * PaymentMatch: which bank transaction paid (or was paid by) this invoice. The match is what
 * lets the ledger show which account the money moved through, so a finalised invoice without one
 * offers the likeliest transactions to pick from, nearest in amount first.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowSquareOut } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Eyebrow } from '~/components/ui/eyebrow';
import type { PaymentCandidate } from '~/types/invoice';
import { money, shortDate } from './model';

export function PaymentMatch({
  matchedId,
  candidates,
  isSale,
  busy,
  onMatch,
  onUnmatch,
}: {
  matchedId: string | null;
  candidates: PaymentCandidate[];
  isSale: boolean;
  busy: boolean;
  onMatch: (transactionId: string) => void;
  onUnmatch: (transactionId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section aria-label="Payment match" className="space-y-3 rounded-2xl border bg-card p-4">
      <Eyebrow>Bank payment</Eyebrow>
      {matchedId ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[15px]">Matched to a bank transaction.</p>
            <Link
              to={`/transactions?transactionId=${matchedId}`}
              className="mt-1 inline-flex items-center gap-1 rounded-sm text-[14px] text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              View the transaction <ArrowSquareOut size={14} aria-hidden />
            </Link>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onUnmatch(matchedId)}>
            Remove match
          </Button>
        </div>
      ) : candidates.length === 0 ? (
        <p className="text-[14px] text-text-2">
          No bank transaction of about this amount is waiting to be matched.
        </p>
      ) : (
        <>
          <p className="text-[14px] text-text-2">
            Not matched yet. {isSale ? 'Money received' : 'Money paid out'} close to this total:
          </p>
          {!open ? (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              Match a payment
            </Button>
          ) : (
            <ul className="divide-y rounded-xl border">
              {candidates.map(c => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[15px]">
                      {c.counterparty || c.description || 'Bank transaction'}
                    </div>
                    <div className="text-[13px] text-text-2">
                      {shortDate(c.occurred_at.slice(0, 10))}, {money(c.amount, c.currency)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => onMatch(c.id)}
                    aria-label={`Match ${c.counterparty || c.description || 'transaction'} for ${money(c.amount, c.currency)}`}
                  >
                    Match
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
