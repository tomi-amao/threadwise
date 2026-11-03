/**
 * BooksVsStock: whether the stock records agree with the books, and when they do not, what
 * moved the books since they last did.
 *
 * The books' stock accounts are filled by payments (a supplier paid is journaled to stock the
 * day it is paid) and emptied by cost of goods sold; the stock records are the count in the
 * store at unit cost. The two meet at a stock-count adjustment. A payment for goods that have
 * not arrived yet shows here as a difference that closes by itself once the count catches up.
 */

import { Link } from 'react-router';
import { Chip } from '~/components/ui/chip';
import { Eyebrow } from '~/components/ui/eyebrow';
import type { BooksVsStock as BooksVsStockData } from '~/lib/api/inventory.server';
import { money } from './model';

const day = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const linkClass =
  'rounded-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function BooksVsStock({ data }: { data: BooksVsStockData }) {
  const { books, stock, difference, reconciled, since, entries, entriesTotal } = data;
  const booksHigher = difference > 0;
  // If the two agreed at the last adjustment, the stock records moved by what the books moved
  // by less what is still different.
  const stockMoved = Math.round((entriesTotal - difference) * 100) / 100;
  const explained = Math.abs(stockMoved) < 0.01;

  return (
    <section
      aria-label="Stock against the books"
      className="space-y-3 rounded-2xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Eyebrow>Stock against your books</Eyebrow>
        {reconciled ? (
          <Chip tone="done">Matches</Chip>
        ) : (
          <Chip tone="active">
            {booksHigher ? 'Books are higher' : 'Stock records are higher'} by{' '}
            {money(Math.abs(difference), 2)}
          </Chip>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3">
        {[
          ['Books', money(books, 2), 'stock accounts'],
          ['Stock records', money(stock, 2), 'sellable, at unit cost'],
          ['Difference', money(difference, 2), reconciled ? 'none' : 'books less stock records'],
        ].map(([label, value, caption]) => (
          <div key={label}>
            <dt className="eyebrow">{label}</dt>
            <dd className="mt-1 font-serif text-[22px] tabular-nums">{value}</dd>
            <dd className="text-[13px] text-text-2">{caption}</dd>
          </div>
        ))}
      </dl>

      {!reconciled && (
        <>
          {entries.length > 0 ? (
            <>
              <p className="text-[14px] text-text-2">
                {since
                  ? `Journaled to stock since the last adjustment, ${day(since)}:`
                  : 'The latest journals to stock (nothing has adjusted it yet):'}
              </p>
              <ul aria-label="Stock journals" className="divide-y rounded-xl border">
                {entries.map(e => (
                  <li
                    key={e.journalId}
                    className="flex items-start justify-between gap-3 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[15px]">{e.description || 'Journal'}</div>
                      <div className="text-[13px] text-text-2">
                        {day(e.date)}
                        {e.invoiceId ? (
                          <>
                            {' · '}
                            <Link to={`/invoices?invoice=${e.invoiceId}`} className={linkClass}>
                              Invoice {e.invoiceNumber}
                            </Link>
                          </>
                        ) : e.transactionId ? (
                          <>
                            {' · '}
                            <Link
                              to={`/transactions?transactionId=${e.transactionId}`}
                              className={linkClass}
                            >
                              View the transaction
                            </Link>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="shrink-0 tabular-nums">{money(e.amount, 2)}</div>
                  </li>
                ))}
              </ul>
            </>
          ) : since ? (
            <p className="text-[14px] text-text-2">
              Nothing has been journaled to stock since the last adjustment, {day(since)}.
            </p>
          ) : null}

          <p className="text-[13px] text-text-2">
            {!since
              ? 'A stock-count adjustment journal brings the books to the count.'
              : entries.length > 0 && explained
                ? booksHigher
                  ? 'These account for the difference: stock paid for that is not in the stock records yet. It closes once the counts in your store catch up.'
                  : 'These account for the difference.'
                : `${entries.length > 0 ? `These moved the books by ${money(entriesTotal, 2)}. ` : ''}Meanwhile the stock records ${stockMoved >= 0 ? 'rose' : 'fell'} by ${money(Math.abs(stockMoved), 2)} with no journal: a count or a cost that changed. A stock-count adjustment journal brings the books to the count.`}
          </p>
        </>
      )}
    </section>
  );
}
