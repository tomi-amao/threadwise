/**
 * MonthDetailDrawer
 *
 * What is behind one month's cost figure on the Revenue tab: for cost of goods sold, the order
 * lines it was costed from; for shipping and other spend, the bank transactions, each of which can
 * be left out of the figures (and put back) from here.
 */

import { useEffect } from 'react';
import { Link, useFetcher, useRevalidator } from 'react-router';
import { ArrowSquareOut } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DataTable } from '~/components/ui/data-table';
import { Drawer } from '~/components/ui/drawer';
import type { ExpenseDetailLine, ReportsData } from '~/lib/api/reports.server';
import { int, money, monthLabel, shortDate, titleCase } from './model';

export type MonthDetailKind = 'cogs' | 'shipping' | 'other';

const COPY: Record<MonthDetailKind, { title: string; lead: string }> = {
  cogs: {
    title: 'Cost of goods sold',
    lead: 'Each row is a sale, costed from its inventory movement at the price captured when it sold. These are the same movements the posted cost-of-sales journal was built from. A line with no cost movement is not here: it counts as £0 (the accounting health check lists those).',
  },
  shipping: {
    title: 'Shipping and fulfilment',
    lead: 'Outbound bank transactions classified as shipping and fulfilment.',
  },
  other: {
    title: 'Other outbound and expenses',
    lead: 'Outbound bank transactions that are not shipping: other expenses and other cash that left the business.',
  },
};

export function MonthDetailDrawer({
  data,
  target,
  onClose,
}: {
  data: ReportsData;
  target: { kind: MonthDetailKind; month: string } | null;
  onClose: () => void;
}) {
  const toggle = useFetcher<{ ok?: boolean; error?: string }>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (toggle.state === 'idle' && toggle.data?.ok) revalidator.revalidate();
    // revalidator is stable enough; depending on it would loop.
  }, [toggle.state, toggle.data]);

  const kind = target?.kind;
  const month = target?.month ?? '';
  const copy = kind ? COPY[kind] : null;

  const cogs = kind === 'cogs' ? data.cogsDetailsByMonth[month] : null;
  const expenseLines: ExpenseDetailLine[] =
    kind === 'shipping'
      ? (data.shippingDetailsByMonth[month]?.lines ?? [])
      : kind === 'other'
        ? [
            ...(data.otherExpensesDetailsByMonth[month]?.lines ?? []),
            ...(data.otherOutboundDetailsByMonth[month]?.lines ?? []),
          ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        : [];
  const total =
    kind === 'cogs'
      ? (cogs?.totalCogs ?? 0)
      : kind === 'shipping'
        ? (data.shippingDetailsByMonth[month]?.totalAmount ?? 0)
        : (data.otherExpensesDetailsByMonth[month]?.totalAmount ?? 0) +
          (data.otherOutboundDetailsByMonth[month]?.totalAmount ?? 0);
  const count = kind === 'cogs' ? (cogs?.lines.length ?? 0) : expenseLines.length;

  return (
    <Drawer
      open={!!target}
      onOpenChange={o => !o && onClose()}
      eyebrow={target ? monthLabel(month) : 'Month'}
      title={copy?.title ?? 'Detail'}
      description="The records behind this month's figure"
      className="w-[min(720px,100vw)]"
    >
      {copy && (
        <>
          <p className="text-[14px] text-text-2">{copy.lead}</p>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="eyebrow">Total</dt>
              <dd className="mt-1 font-serif text-[28px] tabular-nums">{money(total)}</dd>
            </div>
            <div>
              <dt className="eyebrow">{kind === 'cogs' ? 'Costed lines' : 'Transactions'}</dt>
              <dd className="mt-1 font-serif text-[28px] tabular-nums">{int(count)}</dd>
            </div>
          </dl>
          {toggle.data?.error && (
            <p
              role="alert"
              className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-[14px] text-destructive"
            >
              {toggle.data.error}
            </p>
          )}

          {count === 0 ? (
            <p className="text-[14px] text-text-2">Nothing was found for this month.</p>
          ) : kind === 'cogs' ? (
            <DataTable label="Cost of goods sold lines" dense>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Product</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {(cogs?.lines ?? []).map(line => (
                  <tr key={line.lineItemId}>
                    <td className="whitespace-nowrap">
                      <Link
                        to={`/orders?tab=all&order=${line.orderId}`}
                        className="rounded-sm font-mono text-[13px] text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {line.orderNumber ?? 'Order'}
                      </Link>
                      <span className="block text-xs text-text-2">
                        {shortDate(line.orderCreatedAt)}
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate">
                      {line.productName ?? 'Unknown product'}
                    </td>
                    <td className="text-right tabular-nums">{int(line.quantity)}</td>
                    <td className="text-right tabular-nums">{money(line.resolvedCogs)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <DataTable label="Transactions" dense>
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {expenseLines.map(line => (
                  <tr
                    key={`${line.transactionId}-${line.occurredAt}`}
                    className={line.excluded ? 'opacity-60' : ''}
                  >
                    <td className="max-w-[320px]">
                      <Link
                        to={`/transactions?transactionId=${encodeURIComponent(line.transactionId)}`}
                        className="inline-flex max-w-full items-center gap-1 rounded-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="truncate">{line.description || 'No description'}</span>
                        <ArrowSquareOut size={12} aria-hidden className="shrink-0" />
                      </Link>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-text-2">
                        {shortDate(line.occurredAt)} · {titleCase(line.transactionType)}
                        {kind === 'other' && (
                          <Chip>
                            {line.bucket === 'other_outbound' ? 'Other outbound' : 'Other expense'}
                          </Chip>
                        )}
                        {line.excluded && <Chip tone="draft">Left out</Chip>}
                      </span>
                    </td>
                    <td className="whitespace-nowrap text-right tabular-nums">
                      {line.excluded ? '—' : money(line.amount)}
                    </td>
                    <td className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={toggle.state !== 'idle'}
                        onClick={() =>
                          toggle.submit(
                            {
                              intent: 'toggleExpenseExclusion',
                              transactionId: line.transactionId,
                              excluded: String(!line.excluded),
                            },
                            { method: 'post', action: '/reports' }
                          )
                        }
                      >
                        {line.excluded ? 'Put back' : 'Leave out'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      )}
    </Drawer>
  );
}
