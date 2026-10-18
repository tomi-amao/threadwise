/**
 * AccountDrawer
 *
 * The journals behind one line of the profit and loss or the balance sheet: where each amount
 * came from (a bank transaction, an order, a payment, a manual entry), with the full entry one
 * click away. Loaded from /api/reports/account-drilldown when opened.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowSquareOut, CaretDown, CircleNotch, MagnifyingGlass } from 'phosphor-react';
import { Chip } from '~/components/ui/chip';
import { Drawer } from '~/components/ui/drawer';
import { Input } from '~/components/ui/input';
import { NativeSelect } from '~/components/ui/native-select';
import type { AccountDrilldownData } from '~/lib/api/reports.server';
import { cn } from '~/lib/utils';
import { formatAccounting } from '~/components/ui/statement';
import { int, money, shortDate, titleCase, type DrilldownTarget } from './model';

type Load =
  | { key: string; state: 'ready'; drilldown: AccountDrilldownData }
  | { key: string; state: 'error'; message: string };

export function AccountDrawer({
  target,
  from,
  to,
  onClose,
}: {
  target: DrilldownTarget | null;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const key = target
    ? [target.statement, target.accountId, from || 'all', to || 'all'].join(':')
    : null;
  const [load, setLoad] = useState<Load | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [source, setSource] = useState('all');

  useEffect(() => {
    setOpen(null);
    setQ('');
    setSource('all');
    if (!target || !key) return;
    let live = true;
    const params = new URLSearchParams({
      accountId: target.accountId,
      statement: target.statement,
      requestKey: key,
    });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    fetch(`/api/reports/account-drilldown?${params}`)
      .then(r => r.json())
      .then((result: { drilldown?: AccountDrilldownData; error?: string }) => {
        if (!live) return;
        setLoad(
          result.drilldown
            ? { key, state: 'ready', drilldown: result.drilldown }
            : { key, state: 'error', message: result.error ?? 'Could not load these journals' }
        );
      })
      .catch(
        () => live && setLoad({ key, state: 'error', message: 'Could not load these journals' })
      );
    return () => {
      live = false;
    };
  }, [target, key, from, to]);

  const current = load && load.key === key ? load : null;
  const drilldown = current?.state === 'ready' ? current.drilldown : null;

  const entries = useMemo(() => {
    if (!drilldown) return [];
    const needle = q.trim().toLowerCase();
    return drilldown.entries.filter(entry => {
      if (source !== 'all' && entry.sourceKind !== source) return false;
      if (!needle) return true;
      return [
        entry.journalDescription,
        entry.lineDescription,
        entry.sourceReference,
        entry.sourceExternalId,
        entry.sourceSubtitle,
        entry.sourceLabel,
        entry.journalType,
      ].some(field => field?.toLowerCase().includes(needle));
    });
  }, [drilldown, q, source]);

  const sources = drilldown
    ? [...new Map(drilldown.entries.map(e => [e.sourceKind, e.sourceLabel])).entries()]
    : [];

  return (
    <Drawer
      open={!!target}
      onOpenChange={o => !o && onClose()}
      eyebrow={
        target
          ? `${target.statement === 'pnl' ? 'Profit and loss' : 'Balance sheet'} · account ${target.accountCode}`
          : 'Account'
      }
      title={target?.accountName ?? 'Account'}
      description="The journals that make up this line"
      className="w-[min(640px,100vw)]"
    >
      {target && !current && (
        <div role="status" className="flex items-center gap-2 text-text-2">
          <CircleNotch size={18} className="animate-spin" aria-hidden /> Loading journals…
        </div>
      )}
      {current?.state === 'error' && (
        <p role="alert" className="text-destructive">
          {current.message}
        </p>
      )}
      {drilldown && (
        <>
          <div>
            <div className="eyebrow">{drilldown.rangeLabel}</div>
            <div className="mt-1 font-serif text-[44px] tabular-nums">
              {formatAccounting(drilldown.total, 'GBP', 2)}
            </div>
            <p className="text-[13px] text-text-2">
              {int(drilldown.entryCount)} posted{' '}
              {drilldown.entryCount === 1 ? 'journal' : 'journals'}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="relative min-w-[200px] flex-1">
              <MagnifyingGlass
                size={16}
                weight="light"
                aria-hidden
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Search these journals"
                aria-label="Search journals"
                className="rounded-full pl-10"
              />
            </div>
            {sources.length > 1 && (
              <NativeSelect
                aria-label="Source"
                value={source}
                onChange={e => setSource(e.target.value)}
              >
                <option value="all">All sources</option>
                {sources.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="text-[14px] text-text-2">No journals match.</p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {entries.map(entry => {
                const isOpen = open === entry.journalId;
                return (
                  <li key={entry.journalId}>
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : entry.journalId)}
                      aria-expanded={isOpen}
                      className="flex w-full items-start justify-between gap-3 px-3.5 py-3 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[15px]">
                          {entry.journalDescription || entry.sourceLabel}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-text-2">
                          {shortDate(entry.journalDate)}
                          <Chip>{entry.sourceLabel}</Chip>
                          <span className="font-mono text-xs">
                            {titleCase(entry.journalType).toUpperCase()}
                          </span>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 tabular-nums">
                        {formatAccounting(entry.amount, 'GBP', 2)}
                        <CaretDown
                          size={14}
                          aria-hidden
                          className={cn('transition-transform', isOpen && 'rotate-180')}
                        />
                      </span>
                    </button>
                    {isOpen && (
                      <div className="space-y-2 border-t bg-card px-3.5 py-3">
                        <table className="w-full text-[13px]">
                          <thead>
                            <tr className="text-left text-text-2">
                              <th className="pb-1 font-normal">Account</th>
                              <th className="pb-1 text-right font-normal">Debit</th>
                              <th className="pb-1 text-right font-normal">Credit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {entry.lines.map(line => (
                              <tr key={line.id} className="border-t">
                                <td className="py-1.5 pr-2">
                                  <span className="font-mono text-xs text-text-2">
                                    {line.accountCode || '—'}
                                  </span>{' '}
                                  {line.accountName}
                                </td>
                                <td className="py-1.5 text-right tabular-nums">
                                  {line.debit > 0 ? money(line.debit) : '—'}
                                </td>
                                <td className="py-1.5 text-right tabular-nums">
                                  {line.credit > 0 ? money(line.credit) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {entry.sourceKind === 'transaction' && entry.sourceId && (
                          <Link
                            to={`/transactions?transactionId=${encodeURIComponent(entry.sourceId)}`}
                            className="inline-flex items-center gap-1 rounded-sm text-[13px] text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            View the transaction <ArrowSquareOut size={13} aria-hidden />
                          </Link>
                        )}
                        {entry.sourceReference && (
                          <p className="font-mono text-xs text-text-2">{entry.sourceReference}</p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Drawer>
  );
}
