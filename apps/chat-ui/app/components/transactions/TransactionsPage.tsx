/**
 * TransactionsPage
 *
 * Full-page view for searching, filtering, and inspecting financial transactions.
 * Clicking a row opens the TransactionDrawer.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';
import {
  MagnifyingGlass,
  X,
  ArrowsClockwise,
  Funnel,
  ArrowLeft,
  ArrowRight,
  ArrowDown,
  ArrowUp,
  Receipt,
  CheckCircle,
  Warning,
  Prohibit,
  CaretRight,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { cn } from '~/lib/utils';
import {
  listTransactions,
  type FinancialTransaction,
  type ListTransactionsParams,
} from '~/lib/api/transactions';
import { fetchChartOfAccounts, type ChartOfAccountEntry } from '~/lib/api/accounting';
import { TransactionDrawer } from './TransactionDrawer';
import { useAuth } from '~/providers/AuthProvider';
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
  });
}

// ─── Filter Types ─────────────────────────────────────────────────────────────

interface Filters {
  search: string;
  source: string;
  direction: string;
  transactionType: string;
  txnStatus: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: Filters = {
  search: '',
  source: '',
  direction: '',
  transactionType: '',
  txnStatus: '',
  dateFrom: '',
  dateTo: '',
};

const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'revolut', label: 'Revolut' },
  { value: 'paypal', label: 'PayPal' },
];

const DIRECTION_OPTIONS = [
  { value: '', label: 'All directions' },
  { value: 'in', label: 'Inbound' },
  { value: 'out', label: 'Outbound' },
];

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'payment', label: 'Payment' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'expense', label: 'Expense' },
  { value: 'fee', label: 'Fee' },
  { value: 'fx_conversion', label: 'FX Conversion' },
  { value: 'refund', label: 'Refund' },
  { value: 'funding', label: 'Funding' },
  { value: 'payout', label: 'Payout' },
  { value: 'other', label: 'Other' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'excluded', label: 'Excluded' },
];

// ─── Filter Pill ──────────────────────────────────────────────────────────────

function FilterSelect({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={cn(
        'h-8 px-2 py-0 rounded-lg text-xs bg-white/8 border border-white/15 text-foreground',
        'focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer appearance-none pr-6',
        'bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 fill=%27none%27 viewBox=%270 0 20 20%27%3E%3Cpath stroke=%27%236b7280%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27 stroke-width=%271.5%27 d=%27M6 8l4 4 4-4%27/%3E%3C/svg%3E")] bg-no-repeat bg-right',
        className
      )}
    >
      {options.map(o => (
        <option key={o.value} value={o.value} className="bg-card">
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ─── Row Status Indicator ─────────────────────────────────────────────────────

function RowStatus({ txn }: { txn: FinancialTransaction }) {
  if (txn.excluded_reason) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-red-500/15 text-red-400 border-red-500/30">
        <Prohibit size={10} weight="fill" />
        Excluded
      </span>
    );
  }
  if (txn.journalised_at) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-green-500/15 text-green-400 border-green-500/30">
        <CheckCircle size={10} weight="fill" />
        Journalled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-amber-500/15 text-amber-400 border-amber-500/30">
      <Warning size={10} weight="fill" />
      Pending
    </span>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

function StatsBar({
  total,
  inbound,
  outbound,
  excluded,
}: {
  total: number;
  inbound: number;
  outbound: number;
  excluded: number;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {[
        { label: 'Total', value: total, className: 'text-foreground' },
        {
          label: 'Inbound',
          value: inbound,
          className: 'text-emerald-400',
          icon: <ArrowDown size={14} weight="bold" />,
        },
        {
          label: 'Outbound',
          value: outbound,
          className: 'text-rose-400',
          icon: <ArrowUp size={14} weight="bold" />,
        },
        {
          label: 'Excluded',
          value: excluded,
          className: 'text-muted-foreground',
          icon: <Prohibit size={14} />,
        },
      ].map(stat => (
        <div
          key={stat.label}
          className="bg-card rounded-xl border border-white/8 px-4 py-3 flex items-center gap-3"
        >
          {stat.icon && <span className={stat.className}>{stat.icon}</span>}
          <div>
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className={cn('text-lg font-bold', stat.className)}>{stat.value.toLocaleString()}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export function TransactionsPage() {
  const { entity } = useAuth();
  const entityId = entity?.id ?? '';
  const [searchParams, setSearchParams] = useSearchParams();

  const [transactions, setTransactions] = useState<FinancialTransaction[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [pendingSearch, setPendingSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [chartOfAccounts, setChartOfAccounts] = useState<ChartOfAccountEntry[]>([]);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedId = searchParams.get('transactionId');

  const setSelectedId = useCallback(
    (transactionId: string | null) => {
      const nextParams = new URLSearchParams(searchParams);
      if (transactionId) {
        nextParams.set('transactionId', transactionId);
      } else {
        nextParams.delete('transactionId');
      }
      setSearchParams(nextParams, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  // Derived stats from current page
  const inboundCount = transactions.filter(t => t.direction === 'in').length;
  const outboundCount = transactions.filter(t => t.direction === 'out').length;
  const excludedCount = transactions.filter(t => !!t.excluded_reason).length;

  // Load chart of accounts once
  useEffect(() => {
    if (!entityId) return;
    fetchChartOfAccounts(entityId)
      .then(setChartOfAccounts)
      .catch(() => {});
  }, [entityId]);

  const load = useCallback(
    async (f: Filters, p: number) => {
      if (!entityId) return;
      setIsLoading(true);
      try {
        const params: ListTransactionsParams = {
          entityId,
          page: p,
          pageSize: PAGE_SIZE,
        };
        if (f.search) params.search = f.search;
        if (f.source) params.source = f.source;
        if (f.direction) params.direction = f.direction;
        if (f.transactionType) params.transactionType = f.transactionType;
        if (f.txnStatus) params.txnStatus = f.txnStatus;
        if (f.dateFrom) params.dateFrom = f.dateFrom;
        if (f.dateTo) params.dateTo = f.dateTo;

        const data = await listTransactions(params);
        setTransactions(data.transactions);
        setTotalCount(data.total_count);
        setTotalPages(data.total_pages);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Failed to load transactions: ${msg}`);
      } finally {
        setIsLoading(false);
      }
    },
    [entityId]
  );

  // Reload whenever filters or page changes
  useEffect(() => {
    load(filters, page);
  }, [filters, page, load]);

  // Debounced search
  const handleSearchChange = (value: string) => {
    setPendingSearch(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setFilters(f => ({ ...f, search: value }));
      setPage(1);
    }, 350);
  };

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters(f => ({ ...f, [key]: value }));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPendingSearch('');
    setPage(1);
  };

  const hasActiveFilters =
    filters.search ||
    filters.source ||
    filters.direction ||
    filters.transactionType ||
    filters.txnStatus ||
    filters.dateFrom ||
    filters.dateTo;

  const handleTransactionUpdated = useCallback((updated: FinancialTransaction) => {
    setTransactions(prev => prev.map(t => (t.id === updated.id ? updated : t)));
  }, []);

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Transactions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Search, inspect, and update your financial transactions.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load(filters, page)}
          disabled={isLoading}
          className="shrink-0"
        >
          <ArrowsClockwise size={15} className={isLoading ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </div>

      {/* ── Stats Bar ── */}
      <StatsBar
        total={totalCount}
        inbound={inboundCount}
        outbound={outboundCount}
        excluded={excludedCount}
      />

      {/* ── Search & Filter Bar ── */}
      <div className="bg-card rounded-xl border border-white/8 p-4 space-y-3">
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative flex-1">
            <MagnifyingGlass
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <Input
              value={pendingSearch}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search description or counterparty…"
              className="h-9 pl-9 pr-8 text-sm bg-white/5 border-white/15"
            />
            {pendingSearch && (
              <button
                onClick={() => handleSearchChange('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Toggle filters */}
          <Button
            variant={showFilters ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowFilters(v => !v)}
            className={cn(
              'shrink-0',
              hasActiveFilters && !showFilters && 'border-primary text-primary'
            )}
          >
            <Funnel size={15} weight={hasActiveFilters ? 'fill' : 'regular'} />
            Filters
            {hasActiveFilters && (
              <span className="ml-1 bg-primary text-primary-foreground rounded-full w-4 h-4 text-[10px] flex items-center justify-center">
                {
                  [
                    filters.source,
                    filters.direction,
                    filters.transactionType,
                    filters.txnStatus,
                    filters.dateFrom || filters.dateTo,
                  ].filter(Boolean).length
                }
              </span>
            )}
          </Button>

          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>

        {/* Expanded filters */}
        {showFilters && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <FilterSelect
              value={filters.source}
              onChange={v => updateFilter('source', v)}
              options={SOURCE_OPTIONS}
            />
            <FilterSelect
              value={filters.direction}
              onChange={v => updateFilter('direction', v)}
              options={DIRECTION_OPTIONS}
            />
            <FilterSelect
              value={filters.transactionType}
              onChange={v => updateFilter('transactionType', v)}
              options={TYPE_OPTIONS}
            />
            <FilterSelect
              value={filters.txnStatus}
              onChange={v => updateFilter('txnStatus', v)}
              options={STATUS_OPTIONS}
            />
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>From</span>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={e => updateFilter('dateFrom', e.target.value)}
                className="h-8 px-2 rounded-lg text-xs bg-white/8 border border-white/15 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
              <span>To</span>
              <input
                type="date"
                value={filters.dateTo}
                onChange={e => updateFilter('dateTo', e.target.value)}
                className="h-8 px-2 rounded-lg text-xs bg-white/8 border border-white/15 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Table ── */}
      <div className="bg-card rounded-xl border border-white/8 overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2.5 border-b border-white/8 bg-white/3 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          <span>Description / Counterparty</span>
          <span className="text-right hidden sm:block">Date</span>
          <span className="hidden md:block">Type</span>
          <span>Status</span>
          <span className="text-right">Amount</span>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
            <ArrowsClockwise size={18} className="animate-spin" />
            Loading transactions…
          </div>
        )}

        {!isLoading && transactions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-sm gap-3">
            <Receipt size={40} weight="duotone" className="opacity-30" />
            <p>No transactions found.</p>
            {hasActiveFilters && (
              <button onClick={clearFilters} className="text-xs text-primary hover:underline">
                Clear filters
              </button>
            )}
          </div>
        )}

        {!isLoading &&
          transactions.map(txn => (
            <button
              key={txn.id}
              type="button"
              onClick={() => setSelectedId(txn.id)}
              className={cn(
                'w-full grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-3 items-center text-left',
                'border-b border-white/5 last:border-0',
                'hover:bg-white/4 transition-colors group',
                txn.excluded_reason && 'opacity-50',
                selectedId === txn.id && 'bg-white/6'
              )}
            >
              {/* Description */}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'font-medium text-sm truncate',
                      txn.direction === 'in' ? 'text-foreground' : 'text-foreground/80'
                    )}
                  >
                    {txn.counterparty_name || txn.description || 'No description'}
                  </span>
                  {/* Source pill */}
                  <span
                    className={cn(
                      'shrink-0 hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border',
                      txn.source === 'revolut'
                        ? 'bg-violet-500/15 text-violet-400 border-violet-500/30'
                        : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                    )}
                  >
                    {txn.source === 'revolut' ? 'RVT' : 'PP'}
                  </span>
                </div>
                {txn.counterparty_name && txn.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{txn.description}</p>
                )}
              </div>

              {/* Date */}
              <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:block">
                {formatDate(txn.occurred_at)}
              </span>

              {/* Type */}
              <span className="text-xs text-muted-foreground capitalize hidden md:inline-block whitespace-nowrap">
                {txn.transaction_type?.replace('_', ' ')}
              </span>

              {/* Status */}
              <span>
                <RowStatus txn={txn} />
              </span>

              {/* Amount */}
              <div className="flex items-center gap-1.5 justify-end">
                <span
                  className={cn(
                    'text-sm font-mono font-semibold whitespace-nowrap',
                    txn.direction === 'in' ? 'text-emerald-400' : 'text-rose-400'
                  )}
                >
                  {txn.direction === 'in' ? '+' : '−'}
                  {formatMoney(txn.amount, txn.currency_code)}
                </span>
                <CaretRight
                  size={14}
                  className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0"
                />
              </div>
            </button>
          ))}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)} of{' '}
            {totalCount.toLocaleString()} transactions
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage(p => p - 1)}
            >
              <ArrowLeft size={14} />
              Prev
            </Button>
            <span className="text-xs">
              Page {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage(p => p + 1)}
            >
              Next
              <ArrowRight size={14} />
            </Button>
          </div>
        </div>
      )}

      {/* ── Transaction Detail Drawer ── */}
      <TransactionDrawer
        entityId={entityId}
        transactionId={selectedId}
        onClose={() => setSelectedId(null)}
        chartOfAccounts={chartOfAccounts}
        onTransactionUpdated={handleTransactionUpdated}
      />
    </div>
  );
}
