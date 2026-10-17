/**
 * TransactionsPage
 *
 * Search, filter and inspect financial transactions. Filtering and paging happen on the server
 * (the FastAPI accounting API); the filters live in the URL. Clicking a row opens the drawer
 * (?transactionId=).
 *
 * The API returns rows and a total count, but no money totals and no way to filter by filing
 * status (journalled / pending). So the summary tiles that show money are labelled "this page"
 * and are computed from the rows on screen; only "Matching" is a true total.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  CaretRight,
  CircleNotch,
  MagnifyingGlass,
  X,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Chip } from '~/components/ui/chip';
import { DateRangePicker } from '~/components/ui/date-range-picker';
import { EmptyState } from '~/components/ui/empty-state';
import { Input } from '~/components/ui/input';
import { KpiTile } from '~/components/ui/kpi-tile';
import { NativeSelect } from '~/components/ui/native-select';
import { CompactHeader } from '~/components/ui/page-header';
import { Segmented } from '~/components/ui/segmented';
import { fetchChartOfAccounts, type ChartOfAccountEntry } from '~/lib/api/accounting';
import {
  listTransactions,
  type FinancialTransaction,
  type ListTransactionsResponse,
} from '~/lib/api/transactions';
import { useUrlParams } from '~/lib/use-url-params';
import { cn } from '~/lib/utils';
import { useAuth } from '~/providers/AuthProvider';
import { TransactionDrawer } from './TransactionDrawer';
import {
  FILING,
  SOURCE_LABEL,
  TYPE_LABEL,
  baseAmount,
  dayKey,
  dayLabel,
  filingOf,
  int,
  money,
  typeLabel,
} from './format';
import {
  activeFilterCount,
  readFilters,
  readPage,
  withFilters,
  withPage,
  withTransaction,
  withoutFilters,
  type TxnFilters,
} from './filters';

const PAGE_SIZE = 50;

type Load =
  | { status: 'loading'; data: ListTransactionsResponse | null; error: null }
  | { status: 'ready'; data: ListTransactionsResponse; error: null }
  | { status: 'error'; data: ListTransactionsResponse | null; error: string };

function SkeletonRows() {
  return (
    <ul aria-hidden className="divide-y">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-muted" />
        </li>
      ))}
    </ul>
  );
}

function TransactionRow({
  txn,
  selected,
  onOpen,
}: {
  txn: FinancialTransaction;
  selected: boolean;
  onOpen: () => void;
}) {
  const filing = filingOf(txn);
  const excluded = filing === 'excluded';
  const inbound = txn.direction === 'in';
  const foreign = !!txn.base_currency_code && txn.currency_code !== txn.base_currency_code;
  const title = txn.counterparty_name || txn.description || 'No description';
  const subtitle = txn.counterparty_name && txn.description ? txn.description : null;
  const chip = (
    <Chip tone={FILING[filing].tone} dot>
      {FILING[filing].label}
    </Chip>
  );

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected || undefined}
        className={cn(
          'group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-3.5 text-left transition-colors md:grid-cols-[minmax(0,1fr)_150px_120px_170px_16px]',
          'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          selected && 'bg-accent'
        )}
      >
        <div className="min-w-0">
          <div className={cn('truncate', excluded && 'text-text-2')}>{title}</div>
          {subtitle && <div className="truncate text-[13px] text-muted-foreground">{subtitle}</div>}
          <div className="mt-1.5 md:hidden">{chip}</div>
        </div>

        <div className="hidden font-mono text-xs uppercase leading-snug tracking-[0.04em] text-muted-foreground md:block">
          {typeLabel(txn.transaction_type)}
          <br />
          {SOURCE_LABEL[txn.source] ?? txn.source}
        </div>

        <div className="hidden md:block">{chip}</div>

        <div className="text-right">
          <div
            className={cn(
              'tabular-nums',
              inbound && !excluded && 'text-income',
              excluded && 'text-muted-foreground line-through'
            )}
          >
            {inbound ? '+' : '−'}
            {money(baseAmount(txn), txn.base_currency_code ?? 'GBP')}
          </div>
          {foreign && (
            <div className="font-mono text-xs text-muted-foreground">
              {money(txn.amount, txn.currency_code)}
            </div>
          )}
        </div>

        <CaretRight
          aria-hidden
          size={14}
          weight="light"
          className="hidden text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-accent-text md:block"
        />
      </button>
    </li>
  );
}

export function TransactionsPage() {
  const { entity } = useAuth();
  const entityId = entity?.id ?? '';
  const [sp, apply] = useUrlParams();

  const filters = readFilters(sp);
  const page = readPage(sp);
  const selectedId = sp.get('transactionId');
  const filterKey = JSON.stringify(filters);
  const activeCount = activeFilterCount(filters);

  const [load, setLoad] = useState<Load>({ status: 'loading', data: null, error: null });
  const [reloadKey, setReloadKey] = useState(0);
  const requestId = useRef(0);
  const [chart, setChart] = useState<ChartOfAccountEntry[]>([]);

  const update = useCallback(
    (patch: Partial<TxnFilters>) => apply(p => withFilters(p, patch)),
    [apply]
  );

  // Chart of accounts: once, for the drawer's ledger-account picker.
  useEffect(() => {
    if (!entityId) return;
    fetchChartOfAccounts(entityId)
      .then(setChart)
      .catch(() => {
        /* the picker is simply empty; the page itself still works */
      });
  }, [entityId]);

  // The list. A newer request supersedes an older one, so a slow response can't overwrite it.
  useEffect(() => {
    if (!entityId) return;
    const id = ++requestId.current;
    setLoad(l => ({ status: 'loading', data: l.data, error: null }));
    listTransactions({
      entityId,
      page,
      pageSize: PAGE_SIZE,
      search: filters.q || undefined,
      source: filters.source || undefined,
      direction: filters.direction || undefined,
      transactionType: filters.type || undefined,
      txnStatus: filters.status || undefined,
      dateFrom: filters.from || undefined,
      // The API compares against a timestamp, so a bare date would exclude the whole last day.
      dateTo: filters.to ? `${filters.to}T23:59:59.999Z` : undefined,
    })
      .then(data => {
        if (id === requestId.current) setLoad({ status: 'ready', data, error: null });
      })
      .catch((err: unknown) => {
        if (id !== requestId.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoad(l => ({ status: 'error', data: l.data, error: message }));
      });
    // `filters` is represented by filterKey.
  }, [entityId, page, filterKey, reloadKey]);

  // Search: type freely, apply after a short pause.
  const [searchText, setSearchText] = useState(filters.q);
  useEffect(() => setSearchText(filters.q), [filters.q]);
  useEffect(() => {
    if (searchText === filters.q) return;
    const timer = setTimeout(() => update({ q: searchText.trim() }), 350);
    return () => clearTimeout(timer);
  }, [searchText, filters.q, update]);

  const rows = load.data?.transactions ?? [];
  const total = load.data?.total_count ?? 0;
  const totalPages = load.data?.total_pages ?? 1;
  const loading = load.status === 'loading';

  const summary = useMemo(() => {
    const live = rows.filter(t => !t.excluded_reason);
    const inbound = live.filter(t => t.direction === 'in');
    const outbound = live.filter(t => t.direction === 'out');
    return {
      moneyIn: inbound.reduce((s, t) => s + baseAmount(t), 0),
      moneyOut: outbound.reduce((s, t) => s + baseAmount(t), 0),
      inCount: inbound.length,
      outCount: outbound.length,
      awaiting: live.filter(t => !t.journalised_at).length,
    };
  }, [rows]);

  const groups = useMemo(() => {
    const byDay = new Map<string, FinancialTransaction[]>();
    for (const t of rows) {
      const key = dayKey(t.occurred_at);
      byDay.set(key, [...(byDay.get(key) ?? []), t]);
    }
    return [...byDay.entries()];
  }, [rows]);

  const handleUpdated = useCallback((updated: FinancialTransaction) => {
    setLoad(l =>
      l.data
        ? {
            ...l,
            data: {
              ...l.data,
              transactions: l.data.transactions.map(t => (t.id === updated.id ? updated : t)),
            },
          }
        : l
    );
  }, []);

  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Transactions · Revolut and PayPal"
        title={
          <>
            Every pound in and out, <em>and where it was filed.</em>
          </>
        }
        description="Search, inspect and correct any movement in your bank accounts."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey(k => k + 1)}
            disabled={loading}
          >
            {loading ? (
              <CircleNotch size={14} weight="light" className="animate-spin" aria-hidden />
            ) : (
              <ArrowClockwise size={14} weight="light" aria-hidden />
            )}
            Refresh
          </Button>
        }
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Matching"
            value={int(total)}
            caption={activeCount > 0 ? 'match your filters' : 'in total'}
          />
          <KpiTile
            label="Money in"
            tone="income"
            value={money(summary.moneyIn, 'GBP', 0)}
            caption={`${summary.inCount} on this page`}
          />
          <KpiTile
            label="Money out"
            value={money(summary.moneyOut, 'GBP', 0)}
            caption={`${summary.outCount} on this page`}
          />
          <KpiTile
            label="Awaiting a journal"
            value={int(summary.awaiting)}
            caption="on this page"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-[280px]">
            <MagnifyingGlass
              size={16}
              weight="light"
              aria-hidden
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="Search transactions"
              aria-label="Search transactions"
              className="rounded-full pl-10"
            />
          </div>

          <DateRangePicker
            from={filters.from}
            to={filters.to}
            onApply={(f, t) => update({ from: f, to: t })}
            className="h-10 rounded-full border-border-strong bg-card px-4 text-[15px] font-normal hover:bg-card hover:border-ring"
          />

          <Segmented
            label="Direction"
            value={filters.direction || 'all'}
            onChange={v => update({ direction: v === 'all' ? '' : (v as 'in' | 'out') })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'in', label: 'In' },
              { value: 'out', label: 'Out' },
            ]}
          />
          <Segmented
            label="Status"
            value={filters.status || 'all'}
            onChange={v => update({ status: v === 'all' ? '' : (v as 'active' | 'excluded') })}
            options={[
              { value: 'all', label: 'Any status' },
              { value: 'active', label: 'Active' },
              { value: 'excluded', label: 'Excluded' },
            ]}
          />
          <NativeSelect
            className="w-[150px]"
            aria-label="Type"
            value={filters.type}
            onChange={e => update({ type: e.target.value })}
          >
            <option value="">All types</option>
            {Object.entries(TYPE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            className="w-[140px]"
            aria-label="Source"
            value={filters.source}
            onChange={e => update({ source: e.target.value })}
          >
            <option value="">All sources</option>
            {Object.entries(SOURCE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>

          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => apply(withoutFilters)}
              className="inline-flex items-center gap-1 rounded-sm text-sm text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={12} aria-hidden /> Clear {activeCount}
            </button>
          )}
        </div>

        <p role="status" className="sr-only">
          {loading ? 'Loading transactions' : `${int(total)} transactions`}
        </p>

        <div
          aria-busy={loading}
          className={cn(
            'overflow-hidden rounded-2xl border bg-row transition-opacity',
            loading && load.data && 'opacity-60'
          )}
        >
          {load.status === 'error' && !load.data ? (
            <EmptyState
              eyebrow="Could not load"
              title="Transactions did not load."
              description={load.error}
              action={
                <Button variant="outline" size="sm" onClick={() => setReloadKey(k => k + 1)}>
                  Try again
                </Button>
              }
            />
          ) : loading && !load.data ? (
            <SkeletonRows />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No transactions found."
              description={
                activeCount > 0
                  ? 'Nothing matches these filters.'
                  : 'Nothing has been imported yet.'
              }
              action={
                activeCount > 0 && (
                  <Button variant="outline" size="sm" onClick={() => apply(withoutFilters)}>
                    Clear filters
                  </Button>
                )
              }
            />
          ) : (
            <>
              {load.status === 'error' && (
                <p
                  role="alert"
                  className="border-b bg-destructive/10 px-5 py-2.5 text-sm text-destructive"
                >
                  Refreshing failed: {load.error}. Showing the last results.
                </p>
              )}
              {groups.map(([key, dayRows]) => (
                <div key={key}>
                  <h2 className="eyebrow flex items-baseline justify-between border-b bg-card bg-[linear-gradient(var(--accent-tint),var(--accent-tint))] px-5 py-2.5 text-accent-text! [&:not(:first-child)]:border-t">
                    <span>{dayLabel(key)}</span>
                    <span className="shrink-0 whitespace-nowrap pl-4 font-mono text-[11px] tracking-[0.06em]">
                      {dayRows.length}
                      <span className="hidden sm:inline">
                        {dayRows.length === 1 ? ' TRANSACTION' : ' TRANSACTIONS'}
                      </span>
                    </span>
                  </h2>
                  <ul className="divide-y">
                    {dayRows.map(txn => (
                      <TransactionRow
                        key={txn.id}
                        txn={txn}
                        selected={txn.id === selectedId}
                        onOpen={() => apply(p => withTransaction(p, txn.id))}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </div>

        {totalPages > 1 && (
          <nav
            aria-label="Pagination"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <span className="font-mono text-xs tracking-[0.04em] text-muted-foreground">
              {int(from)}–{int(to)} OF {int(total)}
            </span>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => apply(p => withPage(p, page - 1))}
              >
                <ArrowLeft size={14} weight="light" aria-hidden /> Previous
              </Button>
              <span className="font-mono text-[13px] text-text-2">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || loading}
                onClick={() => apply(p => withPage(p, page + 1))}
              >
                Next <ArrowRight size={14} weight="light" aria-hidden />
              </Button>
            </div>
          </nav>
        )}
      </div>

      <TransactionDrawer
        entityId={entityId}
        transactionId={selectedId}
        onClose={() => apply(p => withTransaction(p, null))}
        chartOfAccounts={chart}
        onTransactionUpdated={handleUpdated}
      />
    </div>
  );
}
