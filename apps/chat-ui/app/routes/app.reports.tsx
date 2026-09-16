/**
 * Financial Reports Route (Protected)
 *
 * Comprehensive financial reports with date range filtering:
 * - Revenue Analysis (from orders & payments)
 * - Profit & Loss (from double-entry journals)
 * - Balance Sheet (cumulative from journals)
 * - Cash Flow Statement (from bank transactions)
 */

import React, { useState, useCallback, useEffect } from 'react';
import type { MetaFunction, LoaderFunctionArgs, ActionFunctionArgs } from 'react-router';
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { ResponsiveLine } from '@nivo/line';
import { ResponsiveBar } from '@nivo/bar';
import {
  FilePdf,
  ArrowClockwise,
  ChartLine,
  Scales,
  CurrencyCircleDollar,
  TrendUp,
  Calendar,
  CaretDown,
  CircleNotch,
  ShoppingCart,
  Receipt,
  ArrowsClockwise,
  Truck,
  Wallet,
  CaretRight,
  CheckCircle,
  ClockClockwise,
  FileText,
  ListBullets,
  MagnifyingGlass,
  Link,
  X,
} from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import { InfoTooltip } from '~/components/ui/InfoTooltip';
import { getReportsData } from '~/lib/api/reports.server';
import type {
  AccountDrilldownData,
  CashInsights,
  ReportStatement,
  ReportsData,
} from '~/lib/api/reports.server';
import { getServerSupabaseClient } from '~/lib/supabase';

export const meta: MetaFunction = () => [
  { title: 'Financial Reports - ThreadWise' },
  { name: 'description', content: 'View detailed financial reports' },
];

// ─── Formatting Helpers ───────────────────────────────────────────────

const GBP = (value: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

const GBP0 = (value: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

const NUM = (value: number) => new Intl.NumberFormat('en-GB').format(value);

const formatMonth = (month: string) => {
  const [year, m] = month.split('-');
  const date = new Date(Number(year), Number(m) - 1);
  return date.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
};

const formatLabel = (value: string | null | undefined) => {
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, character => character.toUpperCase());
};

const formatShortDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const truncateId = (value: string | null | undefined) => {
  if (!value) return '—';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
};

type ReportRowDrilldownTarget = {
  accountId: string;
  accountName: string;
  accountCode: number;
  balance: number;
  statement: ReportStatement;
};

type ReportAccountDrilldownResponse = {
  requestKey?: string;
  drilldown?: AccountDrilldownData;
  error?: string;
};

type CogsDetailsTarget = {
  month: string;
};

type ExpenseDetailsTarget = {
  month: string;
  kind: 'shipping' | 'other_expenses';
};

type ReportActionResponse = {
  ok?: boolean;
  error?: string;
  transactionId?: string;
  excluded?: boolean;
};

// ─── Date Range Presets ───────────────────────────────────────────────

interface PresetRange {
  label: string;
  from: string;
  to: string;
}

function getPresets(): PresetRange[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  const fmt = (d: Date) => d.toISOString().split('T')[0];

  return [
    {
      label: 'This Month',
      from: fmt(new Date(y, m, 1)),
      to: fmt(new Date(y, m + 1, 0)),
    },
    {
      label: 'Last Month',
      from: fmt(new Date(y, m - 1, 1)),
      to: fmt(new Date(y, m, 0)),
    },
    {
      label: 'Last 3 Months',
      from: fmt(new Date(y, m - 2, 1)),
      to: fmt(new Date(y, m + 1, 0)),
    },
    {
      label: 'Last 6 Months',
      from: fmt(new Date(y, m - 5, 1)),
      to: fmt(new Date(y, m + 1, 0)),
    },
    {
      label: 'This Year',
      from: fmt(new Date(y, 0, 1)),
      to: fmt(new Date(y, 11, 31)),
    },
    {
      label: 'Last Year',
      from: fmt(new Date(y - 1, 0, 1)),
      to: fmt(new Date(y - 1, 11, 31)),
    },
  ];
}

// ─── Loader ───────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;

  const data = await getReportsData(from, to);
  return { data };
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const supabase = getServerSupabaseClient();

  let body: Record<string, string>;
  try {
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      body = (await request.json()) as Record<string, string>;
    } else {
      const fd = await request.formData();
      body = Object.fromEntries(fd.entries()) as Record<string, string>;
    }
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { intent } = body;
  if (intent !== 'toggleExpenseExclusion') {
    return json({ error: `Unknown intent: ${String(intent)}` }, { status: 400 });
  }

  const transactionId = (body.transactionId || '').trim();
  if (!transactionId) {
    return json({ error: 'transactionId is required' }, { status: 400 });
  }

  const shouldExclude = String(body.excluded || '').toLowerCase() === 'true';

  const { data: currentTxn, error: fetchError } = await supabase
    .from('financial_transactions')
    .select('status, metadata')
    .eq('id', transactionId)
    .single();

  if (fetchError || !currentTxn) {
    return json({ error: fetchError?.message ?? 'Transaction not found' }, { status: 404 });
  }

  const currentStatus = String(currentTxn.status || '').toLowerCase();
  const currentMetadata =
    currentTxn.metadata && typeof currentTxn.metadata === 'object'
      ? (currentTxn.metadata as Record<string, unknown>)
      : {};

  let updatePayload: {
    status: string;
    excluded_reason: string | null;
    metadata: Record<string, unknown>;
  };

  if (shouldExclude) {
    const previousStatus =
      currentStatus && currentStatus !== 'excluded'
        ? currentStatus
        : typeof currentMetadata.reports_prev_status === 'string'
          ? String(currentMetadata.reports_prev_status).toLowerCase()
          : null;

    updatePayload = {
      status: 'excluded',
      excluded_reason: 'Excluded from reports drawer',
      metadata: {
        ...currentMetadata,
        ...(previousStatus ? { reports_prev_status: previousStatus } : {}),
      },
    };
  } else {
    const storedPreviousStatus =
      typeof currentMetadata.reports_prev_status === 'string'
        ? String(currentMetadata.reports_prev_status).toLowerCase()
        : '';
    const restoredStatus =
      storedPreviousStatus && storedPreviousStatus !== 'excluded'
        ? storedPreviousStatus
        : 'pending';
    const { reports_prev_status: _ignored, ...restMetadata } = currentMetadata;

    updatePayload = {
      status: restoredStatus,
      excluded_reason: null,
      metadata: restMetadata,
    };
  }

  const { error } = await supabase
    .from('financial_transactions')
    .update(updatePayload)
    .eq('id', transactionId);

  if (error) {
    return json({ error: error.message }, { status: 500 });
  }

  return json({ ok: true, transactionId, excluded: shouldExclude });
}

// ─── Sub-Components ───────────────────────────────────────────────────

type Tab = 'revenue' | 'pnl' | 'balance' | 'cashflow';

function DateRangeSelector({ currentFrom, currentTo }: { currentFrom: string; currentTo: string }) {
  const navigate = useNavigate();
  const [showCustom, setShowCustom] = useState(false);
  const [customFrom, setCustomFrom] = useState(currentFrom);
  const [customTo, setCustomTo] = useState(currentTo);
  const presets = getPresets();

  const isAllTime = !currentFrom && !currentTo;
  const currentLabel = isAllTime
    ? 'All Time'
    : presets.find(p => p.from === currentFrom && p.to === currentTo)?.label || 'Custom';

  const applyRange = (from: string, to: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    navigate(`/reports?${params.toString()}`);
    setShowCustom(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5 overflow-x-auto">
        <button
          onClick={() => navigate('/reports')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
            isAllTime
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          }`}
        >
          All Time
        </button>
        {presets.map(p => (
          <button
            key={p.label}
            onClick={() => applyRange(p.from, p.to)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              currentFrom === p.from && currentTo === p.to
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setShowCustom(!showCustom)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
            currentLabel === 'Custom'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:text-foreground'
          }`}
        >
          Custom
        </button>
      </div>

      {showCustom && (
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg p-2">
          <input
            type="date"
            value={customFrom}
            onChange={e => setCustomFrom(e.target.value)}
            className="bg-muted border border-border rounded-md px-2 py-1 text-xs text-foreground"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={customTo}
            onChange={e => setCustomTo(e.target.value)}
            className="bg-muted border border-border rounded-md px-2 py-1 text-xs text-foreground"
          />
          <Button
            size="sm"
            variant="default"
            className="h-7 text-xs px-3"
            onClick={() => applyRange(customFrom, customTo)}
          >
            Apply
          </Button>
        </div>
      )}
    </div>
  );
}

function KPICard({
  title,
  value,
  icon,
  iconColor,
  tooltip,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  iconColor: string;
  tooltip: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between mb-2">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${iconColor}`}>
          {icon}
        </div>
        <InfoTooltip text={tooltip} />
      </div>
      <p className="text-xs text-muted-foreground mb-0.5">{title}</p>
      <p className="text-xl font-bold text-foreground tracking-tight">{value}</p>
    </div>
  );
}

/** A single row in a financial statement table */
function FinRow({
  label,
  amount,
  isSection,
  isTotal,
  isGrandTotal,
  indent,
  tooltip,
  negative,
  onClick,
  interactiveLabel,
}: {
  label: string;
  amount?: number;
  isSection?: boolean;
  isTotal?: boolean;
  isGrandTotal?: boolean;
  indent?: number;
  tooltip?: string;
  negative?: boolean;
  onClick?: () => void;
  interactiveLabel?: string;
}) {
  const pl = (indent || 0) * 1.25;
  const isInteractive = typeof onClick === 'function';

  if (isSection) {
    return (
      <tr>
        <td
          className="py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
          style={{ paddingLeft: `${pl}rem` }}
          colSpan={2}
        >
          <span className="flex items-center">
            {label}
            {tooltip && <InfoTooltip text={tooltip} />}
          </span>
        </td>
      </tr>
    );
  }

  const formatted =
    amount !== undefined ? (negative ? `(${GBP(Math.abs(amount))})` : GBP(amount)) : '';

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (!isInteractive) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };

  return (
    <tr
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={isInteractive ? 0 : undefined}
      role={isInteractive ? 'button' : undefined}
      aria-label={interactiveLabel}
      className={`${
        isGrandTotal ? 'border-t-2 border-foreground/20' : isTotal ? 'border-t border-border' : ''
      } ${isInteractive ? 'cursor-pointer hover:bg-muted/30 focus:outline-none focus:bg-muted/30' : ''}`}
    >
      <td
        className={`py-2 ${
          isGrandTotal
            ? 'font-bold text-foreground text-sm'
            : isTotal
              ? 'font-semibold text-foreground text-sm'
              : 'text-muted-foreground text-sm'
        }`}
        style={{ paddingLeft: `${pl}rem` }}
      >
        <span className="flex items-center gap-2">
          {label}
          {tooltip && <InfoTooltip text={tooltip} />}
          {isInteractive && !isTotal && !isGrandTotal && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              View details
              <CaretRight size={12} />
            </span>
          )}
        </span>
      </td>
      <td
        className={`py-2 text-right tabular-nums ${
          isGrandTotal
            ? 'font-bold text-foreground text-sm'
            : isTotal
              ? 'font-semibold text-foreground text-sm'
              : 'text-foreground text-sm'
        } ${amount !== undefined && amount < 0 && !negative ? 'text-rose-500' : ''}`}
      >
        {formatted}
      </td>
    </tr>
  );
}

function DrawerBadge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'emerald' | 'blue' | 'amber';
}) {
  const className =
    tone === 'emerald'
      ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
      : tone === 'blue'
        ? 'bg-blue-500/10 text-blue-500 border-blue-500/20'
        : tone === 'amber'
          ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
          : 'bg-muted text-muted-foreground border-border';

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}

function DrilldownMetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 py-2 text-sm last:border-0">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right text-foreground">{value}</span>
    </div>
  );
}

function CogsDetailsDrawer({
  data,
  target,
  onClose,
}: {
  data: ReportsData;
  target: CogsDetailsTarget | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!target) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [target, onClose]);

  if (!target) return null;

  const details = data.cogsDetailsByMonth[target.month];
  const lines = details?.lines || [];
  const totalCogs = details?.totalCogs || 0;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <DrawerBadge tone="blue">COGS Details</DrawerBadge>
              <DrawerBadge>{formatMonth(target.month)}</DrawerBadge>
            </div>
            <h2 className="mt-2 text-base font-semibold text-foreground">
              Source Line Items for Cost of Goods Sold
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each row is a sale, costed from its inventory movement at the price captured when it
              sold — the same movements the posted COGS journal for that order was built from.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Lines with no cost movement don't appear here — they contribute £0 to this total. See
              the accounting health check for which lines those are.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close COGS details"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Total COGS
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground tabular-nums">
                {GBP(totalCogs)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Costed lines
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">{NUM(lines.length)}</div>
            </div>
          </div>

          {lines.length === 0 ? (
            <div className="rounded-xl border border-border bg-background px-4 py-10 text-center text-sm text-muted-foreground">
              No COGS source line items were found for this month.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-background">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/40 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Order Date</th>
                    <th className="px-3 py-2 text-left font-medium">Order</th>
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">COGS</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(line => (
                    <tr key={line.lineItemId} className="border-t border-border/50 align-top">
                      <td className="px-3 py-2 text-foreground">
                        {formatDateTime(line.orderCreatedAt)}
                      </td>
                      <td className="px-3 py-2 text-foreground font-medium">
                        {truncateId(line.orderId)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {truncateId(line.productId)}
                      </td>
                      <td className="px-3 py-2 text-right text-foreground tabular-nums">
                        {NUM(line.quantity)}
                      </td>
                      <td className="px-3 py-2 text-right text-foreground tabular-nums font-medium">
                        {GBP(line.resolvedCogs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function ExpenseDetailsDrawer({
  data,
  target,
  onClose,
}: {
  data: ReportsData;
  target: ExpenseDetailsTarget | null;
  onClose: () => void;
}) {
  const toggleFetcher = useFetcher<ReportActionResponse>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!target) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [target, onClose]);

  useEffect(() => {
    if (toggleFetcher.state !== 'idle') return;
    if (toggleFetcher.data?.ok) {
      revalidator.revalidate();
    }
  }, [toggleFetcher.state, toggleFetcher.data, revalidator]);

  if (!target) return null;

  const isShipping = target.kind === 'shipping';
  const shippingDetails = data.shippingDetailsByMonth[target.month];
  const otherExpenseDetails = data.otherExpensesDetailsByMonth[target.month];
  const otherOutboundDetails = data.otherOutboundDetailsByMonth[target.month];

  const lines = isShipping
    ? (shippingDetails?.lines || [])
    : [...(otherExpenseDetails?.lines || []), ...(otherOutboundDetails?.lines || [])].sort(
        (a, b) => b.occurredAt.localeCompare(a.occurredAt)
      );

  const totalAmount = isShipping
    ? shippingDetails?.totalAmount || 0
    : (otherExpenseDetails?.totalAmount || 0) + (otherOutboundDetails?.totalAmount || 0);

  const handleToggleExclude = (transactionId: string, nextExcluded: boolean) => {
    toggleFetcher.submit(
      {
        intent: 'toggleExpenseExclusion',
        transactionId,
        excluded: String(nextExcluded),
      },
      { method: 'post' }
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <DrawerBadge tone={isShipping ? 'amber' : 'blue'}>
                {isShipping ? 'Shipping Details' : 'Other Outbound & Expense Details'}
              </DrawerBadge>
              <DrawerBadge>{formatMonth(target.month)}</DrawerBadge>
            </div>
            <h2 className="mt-2 text-base font-semibold text-foreground">
              {isShipping
                ? 'Shipping & Fulfilment Transactions'
                : 'Other Outbound & Expense Transactions'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isShipping
                ? 'These outbound financial transactions were classified as Shipping & Fulfilment.'
                : 'These outbound financial transactions combine Other Expenses and Other Outbound from the monthly breakdown.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close expense details"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Total
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground tabular-nums">
                {GBP(totalAmount)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Transactions
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">{NUM(lines.length)}</div>
            </div>
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Category
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">
                {isShipping ? 'Shipping' : 'Other Outbound & Expenses'}
              </div>
            </div>
          </div>

          {toggleFetcher.data?.error && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">
              {toggleFetcher.data.error}
            </div>
          )}

          {lines.length === 0 ? (
            <div className="rounded-xl border border-border bg-background px-4 py-10 text-center text-sm text-muted-foreground">
              No transactions were found for this month.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-background">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/40 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-left font-medium">Transaction</th>
                    <th className="px-3 py-2 text-left font-medium">Type</th>
                    {!isShipping && <th className="px-3 py-2 text-left font-medium">Bucket</th>}
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(line => (
                    <tr
                      key={`${line.transactionId}-${line.occurredAt}`}
                      className={`border-t border-border/50 align-top ${line.excluded ? 'bg-muted/20 opacity-60' : ''}`}
                    >
                      <td className="px-3 py-2 text-foreground">
                        {formatDateTime(line.occurredAt)}
                      </td>
                      <td className="px-3 py-2 text-foreground font-medium">
                        {truncateId(line.transactionId)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatLabel(line.transactionType)}
                      </td>
                      {!isShipping && (
                        <td className="px-3 py-2 text-muted-foreground">
                          {line.bucket === 'other_outbound' ? 'Other Outbound' : 'Other Expenses'}
                        </td>
                      )}
                      <td className="px-3 py-2 text-muted-foreground">{line.description || '—'}</td>
                      <td className="px-3 py-2 text-right text-foreground tabular-nums font-medium">
                        {line.excluded ? '—' : GBP(line.amount)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleToggleExclude(line.transactionId, !line.excluded)}
                          disabled={toggleFetcher.state !== 'idle'}
                          className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                        >
                          {line.excluded ? 'Unexclude' : 'Exclude'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function DrilldownLineItemsTable({
  lines,
}: {
  lines: AccountDrilldownData['entries'][number]['lines'];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/40 text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Account</th>
            <th className="px-3 py-2 text-right font-medium">Debit</th>
            <th className="px-3 py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(line => (
            <tr key={line.id} className="border-t border-border/50 align-top">
              <td className="px-3 py-2">
                <div className="font-medium text-foreground">
                  {line.accountCode || '—'} — {line.accountName}
                </div>
                {line.description && (
                  <div className="mt-0.5 text-muted-foreground">{line.description}</div>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-foreground">
                {line.debit > 0 ? GBP(line.debit) : '—'}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-foreground">
                {line.credit > 0 ? GBP(line.credit) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountDrilldownDrawer({
  target,
  currentFrom,
  currentTo,
  onClose,
}: {
  target: ReportRowDrilldownTarget | null;
  currentFrom: string;
  currentTo: string;
  onClose: () => void;
}) {
  const fetcher = useFetcher<ReportAccountDrilldownResponse>();
  const navigate = useNavigate();
  const [expandedJournalId, setExpandedJournalId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');

  const requestKey = target
    ? [target.statement, target.accountId, currentFrom || 'all', currentTo || 'all'].join(':')
    : null;

  useEffect(() => {
    if (!target || !requestKey) {
      setExpandedJournalId(null);
      setSearchQuery('');
      setSourceFilter('all');
      return;
    }

    const params = new URLSearchParams({
      accountId: target.accountId,
      statement: target.statement,
      requestKey,
    });

    if (currentFrom) params.set('from', currentFrom);
    if (currentTo) params.set('to', currentTo);

    setExpandedJournalId(null);
    setSearchQuery('');
    setSourceFilter('all');
    fetcher.load(`/api/reports/account-drilldown?${params.toString()}`);
  }, [target, requestKey, currentFrom, currentTo]);

  useEffect(() => {
    if (!target) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [target, onClose]);

  if (!target) return null;

  const drilldown =
    fetcher.data?.requestKey === requestKey ? (fetcher.data.drilldown ?? null) : null;
  const error = fetcher.data?.requestKey === requestKey ? (fetcher.data.error ?? null) : null;
  const isLoading = !!requestKey && (fetcher.state !== 'idle' || (!drilldown && !error));
  const total = drilldown?.total ?? target.balance;
  const itemCount = drilldown?.entryCount ?? 0;
  const statementLabel =
    target.statement === 'pnl' ? 'Profit & Loss account' : 'Balance Sheet account';
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const sourceOptions = drilldown
    ? Array.from(
        new Map(drilldown.entries.map(entry => [entry.sourceKind, entry.sourceLabel])).entries()
      ).map(([value, label]) => ({ value, label }))
    : [];
  const filteredEntries =
    drilldown?.entries.filter(entry => {
      if (sourceFilter !== 'all' && entry.sourceKind !== sourceFilter) {
        return false;
      }

      if (!normalizedSearch) return true;

      const searchableFields = [
        entry.journalDescription,
        entry.lineDescription,
        entry.sourceReference,
        entry.sourceExternalId,
        entry.sourceSubtitle,
        entry.sourceLabel,
        entry.sourceType,
        entry.journalType,
        entry.journalId,
      ];

      return searchableFields.some(field => field?.toLowerCase().includes(normalizedSearch));
    }) ?? [];

  const handleOpenTransaction = (transactionId: string) => {
    onClose();
    navigate(`/transactions?transactionId=${encodeURIComponent(transactionId)}`);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <DrawerBadge tone="blue">{statementLabel}</DrawerBadge>
              <DrawerBadge>{target.accountCode || '—'}</DrawerBadge>
              <DrawerBadge tone="amber">{drilldown?.rangeLabel ?? 'Loading range…'}</DrawerBadge>
            </div>
            <h2 className="mt-2 text-base font-semibold text-foreground">{target.accountName}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Drill into each journal contributing to this row, including source provenance and the
              full journal entry.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close account drilldown"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Statement Balance
              </div>
              <div
                className={`mt-1 text-lg font-semibold tabular-nums ${total < 0 ? 'text-rose-500' : 'text-foreground'}`}
              >
                {GBP(total)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Journal Items
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">{NUM(itemCount)}</div>
            </div>
            <div className="rounded-xl border border-border bg-background px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Normal Balance
              </div>
              <div className="mt-1 text-lg font-semibold text-foreground">
                {formatLabel(drilldown?.normalBalance ?? 'loading')}
              </div>
            </div>
          </div>

          {isLoading && (
            <div className="flex items-center justify-center gap-3 rounded-xl border border-border bg-background py-16 text-muted-foreground">
              <ClockClockwise size={20} className="animate-spin" />
              Loading journal drilldown…
            </div>
          )}

          {!isLoading && error && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-500">
              {error}
            </div>
          )}

          {!isLoading && !error && drilldown && drilldown.entries.length === 0 && (
            <div className="rounded-xl border border-border bg-background px-4 py-10 text-center text-sm text-muted-foreground">
              No contributing journals were found for this row in the selected range.
            </div>
          )}

          {!isLoading && !error && drilldown && drilldown.entries.length > 0 && (
            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-background p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                  <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                    <label className="block">
                      <span className="mb-1.5 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <MagnifyingGlass size={12} />
                        Search journals
                      </span>
                      <input
                        type="search"
                        value={searchQuery}
                        onChange={event => setSearchQuery(event.target.value)}
                        placeholder="Search description, external ID, journal ID…"
                        className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                      />
                    </label>

                    <label className="block">
                      <span className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Source type
                      </span>
                      <select
                        value={sourceFilter}
                        onChange={event => setSourceFilter(event.target.value)}
                        className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none transition-colors focus:border-primary"
                      >
                        <option value="all">All source types</option>
                        {sourceOptions.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="text-sm text-muted-foreground">
                    Showing{' '}
                    <span className="font-semibold text-foreground">
                      {NUM(filteredEntries.length)}
                    </span>{' '}
                    of{' '}
                    <span className="font-semibold text-foreground">
                      {NUM(drilldown.entries.length)}
                    </span>{' '}
                    journals
                  </div>
                </div>
              </div>

              {filteredEntries.length === 0 && (
                <div className="rounded-xl border border-border bg-background px-4 py-10 text-center text-sm text-muted-foreground">
                  No journals match the current search and source filters.
                </div>
              )}

              {filteredEntries.map(entry => {
                const isExpanded = expandedJournalId === entry.journalId;

                return (
                  <section
                    key={entry.journalId}
                    className="overflow-hidden rounded-xl border border-border bg-background"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedJournalId(current =>
                          current === entry.journalId ? null : entry.journalId
                        )
                      }
                      className="w-full px-4 py-4 text-left transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <DrawerBadge tone="emerald">
                              {formatLabel(entry.journalType)}
                            </DrawerBadge>
                            <DrawerBadge>{entry.sourceLabel}</DrawerBadge>
                            {entry.sourceReference && (
                              <DrawerBadge tone="amber">{entry.sourceReference}</DrawerBadge>
                            )}
                          </div>
                          <div className="mt-2 text-sm font-semibold text-foreground">
                            {entry.journalDescription || entry.lineDescription || 'Journal entry'}
                          </div>
                          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                            <span>{formatShortDate(entry.journalDate)}</span>
                            <span>•</span>
                            <span>Journal {truncateId(entry.journalId)}</span>
                            {entry.sourceSubtitle && (
                              <>
                                <span>•</span>
                                <span>{entry.sourceSubtitle}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div
                            className={`text-sm font-semibold tabular-nums ${entry.amount < 0 ? 'text-rose-500' : 'text-foreground'}`}
                          >
                            {GBP(entry.amount)}
                          </div>
                          <div className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                            {isExpanded ? 'Hide details' : 'Show details'}
                            <CaretRight
                              size={12}
                              className={
                                isExpanded
                                  ? 'rotate-90 transition-transform'
                                  : 'transition-transform'
                              }
                            />
                          </div>
                        </div>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="space-y-4 border-t border-border px-4 py-4">
                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
                          <div>
                            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                              <ListBullets size={16} />
                              Journal Lines
                            </div>
                            <DrilldownLineItemsTable lines={entry.lines} />
                          </div>

                          <div>
                            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                              <FileText size={16} />
                              Journal Metadata
                            </div>
                            <div className="rounded-xl border border-border bg-card px-4 py-2">
                              {entry.sourceKind === 'transaction' && entry.sourceId && (
                                <div className="border-b border-border/50 py-3">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="w-full justify-center gap-2"
                                    onClick={() => handleOpenTransaction(entry.sourceId!)}
                                  >
                                    <Link size={14} />
                                    Open in Transaction Detail
                                  </Button>
                                </div>
                              )}
                              <DrilldownMetaRow
                                label="Journal Type"
                                value={formatLabel(entry.journalType)}
                              />
                              <DrilldownMetaRow label="Source" value={entry.sourceLabel} />
                              <DrilldownMetaRow
                                label="Source Type"
                                value={formatLabel(entry.sourceType)}
                              />
                              <DrilldownMetaRow
                                label="External ID"
                                value={entry.sourceExternalId || '—'}
                              />
                              <DrilldownMetaRow
                                label="Source ID"
                                value={truncateId(entry.sourceId)}
                              />
                              <DrilldownMetaRow
                                label="Journal ID"
                                value={truncateId(entry.journalId)}
                              />
                              <DrilldownMetaRow
                                label="Posted"
                                value={formatDateTime(entry.postedAt)}
                              />
                              <DrilldownMetaRow
                                label="Created"
                                value={formatDateTime(entry.createdAt)}
                              />
                              <DrilldownMetaRow
                                label="Account Impact"
                                value={
                                  <span
                                    className={`font-semibold tabular-nums ${entry.amount < 0 ? 'text-rose-500' : 'text-foreground'}`}
                                  >
                                    {GBP(entry.amount)}
                                  </span>
                                }
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-emerald-500" />
            Statement totals remain journal-first. This drawer shows the exact journal activity
            behind the selected account row.
          </div>
        </div>
      </aside>
    </>
  );
}

// ─── Revenue Analysis Tab ─────────────────────────────────────────────

function RevenueAnalysisTab({
  data,
  onOpenCogsDetails,
  onOpenShippingDetails,
  onOpenOtherExpensesDetails,
}: {
  data: ReportsData;
  onOpenCogsDetails: (month: string) => void;
  onOpenShippingDetails: (month: string) => void;
  onOpenOtherExpensesDetails: (month: string) => void;
}) {
  const { revenue, monthly } = data;
  const monthlyTotals = monthly.reduce(
    (totals, month) => ({
      totalSales: totals.totalSales + month.totalSales,
      discounts: totals.discounts + month.discounts,
      returns: totals.returns + month.returns,
      processingFees: totals.processingFees + month.processingFees,
      cogs: totals.cogs + month.cogs,
      shippingCost: totals.shippingCost + month.shippingCost,
      otherOutbound:
        totals.otherOutbound + Math.max(month.operatingExpenses - month.shippingCost, 0) + month.otherOutbound,
      netIncome: totals.netIncome + month.netIncome,
      orders: totals.orders + month.orders,
    }),
    {
      totalSales: 0,
      discounts: 0,
      returns: 0,
      processingFees: 0,
      cogs: 0,
      shippingCost: 0,
      otherOutbound: 0,
      netIncome: 0,
      orders: 0,
    }
  );

  const chartData = [
    {
      id: 'Total Sales',
      data: monthly.map(m => ({ x: formatMonth(m.month), y: m.totalSales })),
    },
    {
      id: 'Net Income',
      data: monthly.map(m => ({ x: formatMonth(m.month), y: m.netIncome })),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Monthly Trend Chart */}
      {monthly.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-foreground mb-1">
            Revenue Trend
            <InfoTooltip text="Monthly Shopify-aligned total sales versus net income for the selected period. Discounts, returns, and processing fees use the same logic as the top Revenue Breakdown, while net income continues to follow the monthly cost and operating-expense calculation." />
          </h3>
          <div className="h-[280px] w-full">
            <ResponsiveLine
              data={chartData}
              margin={{ top: 20, right: 20, bottom: 50, left: 60 }}
              animate={false}
              xScale={{ type: 'point' }}
              yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
              yFormat={v => GBP0(Number(v))}
              axisBottom={{ tickSize: 0, tickPadding: 8, tickRotation: -45 }}
              axisLeft={{
                tickSize: 0,
                tickPadding: 8,
                format: v => `£${Number(v) >= 1000 ? `${(Number(v) / 1000).toFixed(0)}k` : v}`,
              }}
              colors={['hsl(var(--primary))', 'hsl(142, 71%, 45%)']}
              lineWidth={2.5}
              pointSize={5}
              pointColor="hsl(var(--card))"
              pointBorderWidth={2}
              pointBorderColor={{ from: 'serieColor' }}
              enableArea={false}
              enableGridX={false}
              gridYValues={5}
              curve="monotoneX"
              legends={[
                {
                  anchor: 'top',
                  direction: 'row',
                  translateY: -20,
                  itemWidth: 100,
                  itemHeight: 20,
                  symbolSize: 10,
                  symbolShape: 'circle',
                  itemTextColor: 'hsl(var(--muted-foreground))',
                },
              ]}
              theme={{
                text: { fill: 'hsl(var(--muted-foreground))' },
                axis: {
                  ticks: {
                    text: { fontSize: 11, fill: 'hsl(var(--muted-foreground))' },
                  },
                },
                grid: { line: { stroke: 'hsl(var(--border))', strokeWidth: 1 } },
                legends: { text: { fontSize: 11 } },
              }}
              tooltip={({ point }) => (
                <div className="bg-popover text-popover-foreground border border-border rounded-lg px-3 py-2 shadow-lg text-xs">
                  <p className="font-medium">{point.data.xFormatted}</p>
                  <p style={{ color: point.seriesColor }} className="font-semibold">
                    {point.seriesId}: {point.data.yFormatted}
                  </p>
                </div>
              )}
              useMesh
            />
          </div>
        </div>
      )}

      {/* Revenue Breakdown Table */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground mb-4">
          Revenue Breakdown
          <InfoTooltip text="Aligned to Shopify's total sales breakdown using order totals, raw Shopify shipping discounts and shipping refunds, plus payment-backed successful refunds. Processing fees are shown as an additional step after total sales so retained revenue is visible too." />
        </h3>
        <table className="w-full">
          <tbody>
            <FinRow
              label="Gross Sales"
              amount={revenue.grossSales}
              tooltip="Shopify-style gross sales: merchandise subtotal plus product discounts, excluding shipping and tax."
            />
            <FinRow
              label="Less: Discounts"
              amount={revenue.discounts}
              negative
              tooltip="Product discounts only. Shipping-only discounts are excluded so this matches Shopify's sales breakdown."
            />
            <FinRow
              label="Less: Returns"
              amount={revenue.returns}
              negative
              tooltip="Successful refunded payment amounts net of shipping refunds, matching Shopify's Returns line."
            />
            <FinRow
              label="Net Sales"
              amount={revenue.netSales}
              isTotal
              tooltip="Gross Sales minus Discounts and Returns."
            />
            <FinRow
              label="Shipping Charges"
              amount={revenue.shippingCollected}
              tooltip="Net shipping revenue after shipping discounts and shipping refunds."
            />
            <FinRow
              label="Taxes"
              amount={revenue.taxCollected}
              tooltip="Tax collected from customers."
            />
            <FinRow
              label="Total Sales"
              amount={revenue.totalSales}
              isTotal
              tooltip="Net Sales plus Shipping Charges and Taxes, aligned to Shopify's total sales breakdown."
            />
            <FinRow
              label="Less: Processing Fees"
              amount={revenue.processingFees}
              negative
              tooltip="Payment gateway fees (Stripe, PayPal) charged on captured payments. Includes card processing and platform fees."
            />
            <FinRow
              label="Net Revenue"
              amount={revenue.netRevenue}
              isGrandTotal
              tooltip="Total Sales minus Processing Fees. This is the revenue retained after successful refunds, shipping adjustments, and gateway fees."
            />
          </tbody>
        </table>

        <div className="mt-4 pt-4 border-t border-border grid grid-cols-2 md:grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-muted-foreground flex items-center">
              Orders in Period
              <InfoTooltip text="Total number of non-cancelled orders placed during the selected date range." />
            </p>
            <p className="text-lg font-semibold text-foreground">{NUM(revenue.orderCount)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground flex items-center">
              Average Order Value
              <InfoTooltip text="Gross Revenue divided by number of orders. Represents the average spend per order." />
            </p>
            <p className="text-lg font-semibold text-foreground">{GBP(revenue.avgOrderValue)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground flex items-center">
              Gifted Stock Cost
              <InfoTooltip text="Total cost of inventory movements recorded as GIFT in the selected period. This is shown separately so gifted stock does not distort sold COGS or sales margin." />
            </p>
            <p className="text-lg font-semibold text-foreground">{GBP(revenue.giftedStockCost)}</p>
          </div>
        </div>
      </div>

      {/* Monthly Breakdown Table */}
      {monthly.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-foreground mb-4">
            Monthly Breakdown
            <InfoTooltip text="Monthly Shopify-aligned total sales, product discounts, payment-backed returns, and captured-payment processing fees. Shipping is shown separately, while Other Outbound & Expenses combines non-shipping operating expenses and additional outbound cash movements. Net income remains based on sold COGS and operating expenses only." />
          </h3>
          <div className="overflow-x-auto -mx-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="sticky top-0 z-10 bg-card text-left text-xs font-medium text-muted-foreground px-5 py-2">
                    Month
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-3 py-2">
                    Total Sales
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-3 py-2">
                    Discounts
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-3 py-2">
                    Returns
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-3 py-2">
                    Processing Fees
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-3 py-2">
                    COGS
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-3 py-2">
                    Shipping
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-3 py-2">
                    Other Outbound & Expenses
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-3 py-2">
                    Net Income
                  </th>
                  <th className="sticky top-0 z-10 bg-card text-right text-xs font-medium text-muted-foreground px-5 py-2">
                    Orders
                  </th>
                </tr>
              </thead>
              <tbody>
                {monthly.map(m => (
                  <tr
                    key={m.month}
                    className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                  >
                    <td className="px-5 py-2 text-foreground font-medium">
                      {formatMonth(m.month)}
                    </td>
                    <td className="px-3 py-2 text-right text-foreground tabular-nums">
                      {GBP(m.totalSales)}
                    </td>
                    <td className="px-3 py-2 text-right text-rose-500 tabular-nums">
                      {m.discounts > 0 ? `(${GBP(m.discounts)})` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-rose-500 tabular-nums">
                      {m.returns > 0 ? `(${GBP(m.returns)})` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-amber-600 tabular-nums">
                      {m.processingFees > 0 ? `(${GBP(m.processingFees)})` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                      {m.cogs > 0 ? (
                        <button
                          type="button"
                          onClick={() => onOpenCogsDetails(m.month)}
                          className="cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-muted/40 hover:text-foreground"
                          title="View COGS source line items"
                        >
                          {`(${GBP(m.cogs)})`}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                      {m.shippingCost > 0 ? (
                        <button
                          type="button"
                          onClick={() => onOpenShippingDetails(m.month)}
                          className="cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-muted/40 hover:text-foreground"
                          title="View shipping transactions"
                        >
                          {`(${GBP(m.shippingCost)})`}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                      {Math.max(m.operatingExpenses - m.shippingCost, 0) + m.otherOutbound > 0 ? (
                        <button
                          type="button"
                          onClick={() => onOpenOtherExpensesDetails(m.month)}
                          className="cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-muted/40 hover:text-foreground"
                          title="View other outbound and expense transactions"
                        >
                          {`(${GBP(Math.max(m.operatingExpenses - m.shippingCost, 0) + m.otherOutbound)})`}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-foreground tabular-nums">
                      {GBP(m.netIncome)}
                    </td>
                    <td className="px-5 py-2 text-right text-muted-foreground">{NUM(m.orders)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-foreground/20 font-semibold">
                  <td className="px-5 py-2 text-foreground">Total</td>
                  <td className="px-3 py-2 text-right text-foreground tabular-nums">
                    {GBP(monthlyTotals.totalSales)}
                  </td>
                  <td className="px-3 py-2 text-right text-rose-500 tabular-nums">
                    {monthlyTotals.discounts > 0 ? `(${GBP(monthlyTotals.discounts)})` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-rose-500 tabular-nums">
                    {monthlyTotals.returns > 0 ? `(${GBP(monthlyTotals.returns)})` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-amber-600 tabular-nums">
                    {monthlyTotals.processingFees > 0
                      ? `(${GBP(monthlyTotals.processingFees)})`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                    {monthlyTotals.cogs > 0 ? `(${GBP(monthlyTotals.cogs)})` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                    {monthlyTotals.shippingCost > 0 ? `(${GBP(monthlyTotals.shippingCost)})` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                    {monthlyTotals.otherOutbound > 0
                      ? `(${GBP(monthlyTotals.otherOutbound)})`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-foreground tabular-nums">
                    {GBP(monthlyTotals.netIncome)}
                  </td>
                  <td className="px-5 py-2 text-right text-muted-foreground">
                    {NUM(monthlyTotals.orders)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Profit & Loss Tab ────────────────────────────────────────────────

function ProfitAndLossTab({
  data,
  onAccountSelect,
}: {
  data: ReportsData;
  onAccountSelect: (target: ReportRowDrilldownTarget) => void;
}) {
  const { accountingPnL } = data;
  const hasData =
    accountingPnL.sections.some(s => s.accounts.length > 0) || accountingPnL.netIncome !== 0;

  if (!hasData) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">No journal entries found for the selected period.</p>
        <p className="text-xs text-muted-foreground mt-1">
          The Profit & Loss statement is generated from double-entry accounting journals.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground mb-4">
        Profit & Loss Statement
        <InfoTooltip text="Generated from double-entry accounting journals (chart of accounts). Revenue is credit-normal, expenses are debit-normal. Only shows activity within the selected date range." />
      </h3>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left text-xs font-medium text-muted-foreground py-2">Account</th>
            <th className="text-right text-xs font-medium text-muted-foreground py-2">Balance</th>
          </tr>
        </thead>
        <tbody>
          {accountingPnL.sections.map(section => (
            <React.Fragment key={section.type}>
              <FinRow
                label={section.label}
                isSection
                tooltip={
                  section.type === 'revenue'
                    ? 'Revenue accounts from the chart of accounts. Credit balances represent income earned.'
                    : section.type === 'cogs'
                      ? 'Cost of Goods Sold accounts. Debit balances represent direct costs of products sold.'
                      : 'Operating expense accounts. Debit balances represent business costs incurred.'
                }
              />
              {section.accounts.map(acct => (
                <FinRow
                  key={acct.id ?? acct.code}
                  label={acct.name}
                  amount={acct.balance}
                  indent={1}
                  onClick={
                    acct.id
                      ? () =>
                          onAccountSelect({
                            accountId: String(acct.id),
                            accountName: acct.name,
                            accountCode: acct.code,
                            balance: acct.balance,
                            statement: 'pnl',
                          })
                      : undefined
                  }
                  interactiveLabel={acct.id ? `View ${acct.name} drilldown` : undefined}
                />
              ))}
              <FinRow label={`Total ${section.label}`} amount={section.total} isTotal />
              {section.type === 'cogs' && (
                <FinRow
                  label="Gross Profit"
                  amount={accountingPnL.grossProfit}
                  isTotal
                  tooltip="Total Revenue minus Cost of Goods Sold. Indicates profitability before operating expenses."
                />
              )}
            </React.Fragment>
          ))}
          <FinRow
            label="Net Income"
            amount={accountingPnL.netIncome}
            isGrandTotal
            tooltip="Gross Profit minus Operating Expenses. The bottom line — total profit (or loss) for the period."
          />
        </tbody>
      </table>
    </div>
  );
}

// ─── Balance Sheet Tab ────────────────────────────────────────────────

function BalanceSheetTab({
  data,
  onAccountSelect,
}: {
  data: ReportsData;
  onAccountSelect: (target: ReportRowDrilldownTarget) => void;
}) {
  const { balanceSheet } = data;
  const hasData =
    balanceSheet.assets.length > 0 ||
    balanceSheet.liabilities.length > 0 ||
    balanceSheet.equity.length > 0;

  if (!hasData) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">No balance sheet data available.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Balance sheet accounts are derived from double-entry journal entries.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground mb-1">
        Balance Sheet
        <InfoTooltip text="Point-in-time snapshot showing cumulative balances of all asset, liability, and equity accounts up to the end of the selected period. Assets = Liabilities + Equity." />
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        {data.dateRange.to
          ? `As of ${new Date(data.dateRange.to).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
          : 'As of today (all time)'}
      </p>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left text-xs font-medium text-muted-foreground py-2">Account</th>
            <th className="text-right text-xs font-medium text-muted-foreground py-2">Balance</th>
          </tr>
        </thead>
        <tbody>
          <FinRow
            label="Assets"
            isSection
            tooltip="Resources owned by the business. Debit-normal accounts — a positive balance means the business owns this value."
          />
          {balanceSheet.assets.map(a => (
            <FinRow
              key={a.id ?? a.code}
              label={a.name}
              amount={a.balance}
              indent={1}
              onClick={
                a.id
                  ? () =>
                      onAccountSelect({
                        accountId: String(a.id),
                        accountName: a.name,
                        accountCode: a.code,
                        balance: a.balance,
                        statement: 'balance',
                      })
                  : undefined
              }
              interactiveLabel={a.id ? `View ${a.name} drilldown` : undefined}
            />
          ))}
          <FinRow
            label="Total Assets"
            amount={balanceSheet.totalAssets}
            isTotal
            tooltip="Sum of all asset account balances."
          />

          <FinRow
            label="Liabilities"
            isSection
            tooltip="Obligations owed by the business. Credit-normal accounts — a positive balance represents money the business owes."
          />
          {balanceSheet.liabilities.map(l => (
            <FinRow
              key={l.id ?? l.code}
              label={l.name}
              amount={l.balance}
              indent={1}
              onClick={
                l.id
                  ? () =>
                      onAccountSelect({
                        accountId: String(l.id),
                        accountName: l.name,
                        accountCode: l.code,
                        balance: l.balance,
                        statement: 'balance',
                      })
                  : undefined
              }
              interactiveLabel={l.id ? `View ${l.name} drilldown` : undefined}
            />
          ))}
          <FinRow
            label="Total Liabilities"
            amount={balanceSheet.totalLiabilities}
            isTotal
            tooltip="Sum of all liability account balances."
          />

          <FinRow
            label="Equity"
            isSection
            tooltip="Owner's residual interest after liabilities are deducted from assets. Includes retained earnings and contributed capital."
          />
          {balanceSheet.equity.map(e => (
            <FinRow
              key={e.id ?? e.code}
              label={e.name}
              amount={e.balance}
              indent={1}
              onClick={
                e.id
                  ? () =>
                      onAccountSelect({
                        accountId: String(e.id),
                        accountName: e.name,
                        accountCode: e.code,
                        balance: e.balance,
                        statement: 'balance',
                      })
                  : undefined
              }
              interactiveLabel={e.id ? `View ${e.name} drilldown` : undefined}
            />
          ))}
          <FinRow
            label="Total Equity"
            amount={balanceSheet.totalEquity}
            isTotal
            tooltip="Sum of all equity account balances. Should equal Total Assets minus Total Liabilities."
          />

          <FinRow
            label="Liabilities + Equity"
            amount={balanceSheet.totalLiabilities + balanceSheet.totalEquity}
            isGrandTotal
            tooltip="Total Liabilities plus Total Equity. In a balanced set of books, this equals Total Assets."
          />
        </tbody>
      </table>

      {/* Balance check */}
      {Math.abs(
        balanceSheet.totalAssets - (balanceSheet.totalLiabilities + balanceSheet.totalEquity)
      ) > 0.01 && (
        <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500">
          Note: Total Assets ({GBP(balanceSheet.totalAssets)}) does not equal Liabilities + Equity (
          {GBP(balanceSheet.totalLiabilities + balanceSheet.totalEquity)}). This may indicate
          unreconciled journal entries.
        </div>
      )}
    </div>
  );
}

// ─── Cash Flow Tab ────────────────────────────────────────────────────

// ─── Cash insights ────────────────────────────────────────────────────

/**
 * The headline read on cash health, plus the trend that backs it up.
 *
 * The verdict is deliberately shown next to the monthly figures rather than
 * on its own: this business trades in release cycles, so a single summary
 * number without the swings behind it would hide more than it explains.
 */
function CashHealthCard({ insights }: { insights: CashInsights }) {
  const tone =
    insights.verdict === 'generating'
      ? { dot: 'bg-emerald-500', text: 'text-emerald-500' }
      : insights.verdict === 'consuming'
        ? { dot: 'bg-red-500', text: 'text-red-500' }
        : insights.verdict === 'breakeven'
          ? { dot: 'bg-amber-500', text: 'text-amber-500' }
          : { dot: 'bg-muted-foreground', text: 'text-muted-foreground' };

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center">
        Cash health
        <InfoTooltip text="Based on operating cash flow over the last 6 complete months — money from trading only, before any funding you put in. Six months rather than one because release-driven months swing widely; a single month would be noise, not a signal. The month still in progress is excluded." />
      </h3>

      <div className="flex items-center gap-2 mb-2">
        <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', tone.dot)} />
        <p className={cn('text-lg font-semibold', tone.text)}>{insights.verdictHeadline}</p>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{insights.verdictDetail}</p>

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4">
        <div>
          <p className="text-xs text-muted-foreground flex items-center">
            Avg month
            <InfoTooltip text="Average operating cash flow per complete month over the last 12 months. Excludes the current partial month and excludes director funding." />
          </p>
          <p
            className={cn(
              'text-sm font-semibold tabular-nums',
              insights.avgMonthlyOperating >= 0 ? 'text-emerald-500' : 'text-red-500'
            )}
          >
            {GBP(insights.avgMonthlyOperating)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground flex items-center">
            Last 12 months
            <InfoTooltip text="Total operating cash generated or consumed over the last 12 complete months, before funding." />
          </p>
          <p
            className={cn(
              'text-sm font-semibold tabular-nums',
              insights.trailing12Operating >= 0 ? 'text-emerald-500' : 'text-red-500'
            )}
          >
            {GBP(insights.trailing12Operating)}
          </p>
        </div>
        {insights.bestMonth && (
          <div>
            <p className="text-xs text-muted-foreground">Best month</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">
              {GBP(insights.bestMonth.amount)}{' '}
              <span className="font-normal text-muted-foreground">{insights.bestMonth.label}</span>
            </p>
          </div>
        )}
        {insights.worstMonth && (
          <div>
            <p className="text-xs text-muted-foreground">Worst month</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">
              {GBP(insights.worstMonth.amount)}{' '}
              <span className="font-normal text-muted-foreground">{insights.worstMonth.label}</span>
            </p>
          </div>
        )}
      </div>

      {insights.runwayMonths !== null && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <p className="text-xs text-amber-500 flex items-start gap-1.5">
            <span aria-hidden>!</span>
            <span>
              At the current average burn, cash on hand covers about{' '}
              <strong>{insights.runwayMonths} months</strong>. This assumes the trend continues
              unchanged — a strong release month would reset it.
            </span>
          </p>
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground flex items-center">
          Funded by trading
          <InfoTooltip text="Of all the cash that has come into the business, the share generated by trading rather than introduced by the director. 100% means the business has paid for itself entirely." />
        </p>
        {insights.selfFunding.pctFromTrading !== null ? (
          <>
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${Math.max(0, Math.min(100, insights.selfFunding.pctFromTrading))}%` }}
                />
              </div>
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {insights.selfFunding.pctFromTrading}%
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {GBP(insights.selfFunding.tradingCumulative)} from trading ·{' '}
              {GBP(insights.selfFunding.directorCumulative)} from you
              {insights.selfFunding.trailing12Covered
                ? ' · trading covered itself over the last 12 months'
                : ' · trading did not cover itself over the last 12 months'}
            </p>
          </>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">Not enough activity to measure yet.</p>
        )}
      </div>
    </div>
  );
}

/** Answers "how much can I commit to the next release" with its full derivation. */
function SafeToSpendCard({
  insights,
  onOpenBreakdown,
}: {
  insights: CashInsights;
  onOpenBreakdown: () => void;
}) {
  const pctOfCash =
    insights.cashOnHand > 0 ? Math.max(0, (insights.safeToSpend / insights.cashOnHand) * 100) : 0;

  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col">
      <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center">
        Safe to spend
        <InfoTooltip text="Cash in the bank, less the tax already accrued, any unpaid supplier bills, and a buffer the size of your worst trading month in the last year. What's left is what you could commit to a new release without relying on next month going well." />
      </h3>

      <p className="text-3xl font-semibold tabular-nums text-foreground">
        {GBP(insights.safeToSpend)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        of {GBP(insights.cashOnHand)} in the bank ({pctOfCash.toFixed(0)}%)
      </p>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted flex">
        <div
          className="h-full bg-primary"
          style={{ width: `${Math.max(0, Math.min(100, pctOfCash))}%` }}
        />
        <div className="h-full flex-1 bg-muted-foreground/25" />
      </div>

      <div className="mt-4 space-y-1.5 border-t border-border pt-3">
        {insights.safeToSpendLines.slice(1).map(line => (
          <div key={line.label} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-muted-foreground flex items-center min-w-0">
              <span className="truncate">{line.label}</span>
              <InfoTooltip text={line.detail} />
            </span>
            <span
              className={cn(
                'tabular-nums shrink-0',
                line.amount === 0 ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {GBP(line.amount)}
            </span>
          </div>
        ))}
      </div>

      <button
        onClick={onOpenBreakdown}
        className="mt-4 flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <MagnifyingGlass size={13} />
        See the full calculation
      </button>
    </div>
  );
}

/** Monthly operating cash, so the health verdict above is checkable rather than asserted. */
function CashTrendChart({ insights }: { insights: CashInsights }) {
  // Nivo's BarDatum indexes by string, so the extra fields the tooltip needs
  // ride along as numbers (0/1 for the partial flag) rather than booleans.
  const data = insights.monthly.map(month => ({
    month: month.label,
    operating: month.operating,
    _financing: month.financing,
    _net: month.net,
    _partial: month.isPartial ? 1 : 0,
  }));

  const hasPartial = insights.monthly.some(month => month.isPartial);

  // Explicit bounds with headroom. Nivo's 'auto' still floors the scale at zero
  // for bar charts, which would push loss months outside the plot area and on
  // top of the month labels — and loss months are the point of this chart.
  const values = insights.monthly.map(month => month.operating);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const headroom = Math.max(1, (rawMax - rawMin) * 0.08);
  const scaleMin = rawMin < 0 ? rawMin - headroom : 0;
  const scaleMax = rawMax + headroom;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center">
        Monthly operating cash
        <InfoTooltip text="Cash generated or consumed by trading each month, classified from each transaction's journal entry. Director funding is excluded so this shows the business standing on its own. Same figures as the statement below." />
      </h3>
      <p className="text-xs text-muted-foreground mb-4">
        Trading only — funding you put in is excluded.
        {hasPartial && ' The final bar is the current month, still in progress.'}
      </p>
      <div className="h-[300px] w-full">
        <ResponsiveBar
          data={data}
          keys={['operating']}
          indexBy="month"
          margin={{ top: 10, right: 16, bottom: 64, left: 68 }}
          padding={0.3}
          animate={false}
          enableLabel={false}
          valueScale={{ type: 'linear', min: scaleMin, max: scaleMax }}
          valueFormat={value => GBP0(Number(value))}
          colors={({ data: d }) =>
            (d as any)._partial
              ? 'hsl(215, 20%, 55%)'
              : (d as any).operating >= 0
                ? 'hsl(142, 71%, 45%)'
                : 'hsl(0, 72%, 51%)'
          }
          axisBottom={{ tickSize: 0, tickPadding: 10, tickRotation: -45 }}
          axisLeft={{
            tickSize: 0,
            tickPadding: 8,
            // Without an explicit count Nivo emits a tick per gridline candidate,
            // which at this height collapses into an unreadable stack.
            tickValues: 5,
            format: value =>
              `£${Math.abs(Number(value)) >= 1000 ? `${(Number(value) / 1000).toFixed(0)}k` : value}`,
          }}
          enableGridX={false}
          gridYValues={5}
          markers={[
            {
              axis: 'y',
              value: 0,
              lineStyle: { stroke: 'hsl(var(--border))', strokeWidth: 1.5 },
            },
          ]}
          theme={{
            text: { fill: 'hsl(var(--muted-foreground))' },
            axis: { ticks: { text: { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } } },
            grid: { line: { stroke: 'hsl(var(--border))', strokeWidth: 1 } },
          }}
          tooltip={({ data: d }) => (
            <div className="bg-popover text-popover-foreground border border-border rounded-lg px-3 py-2 shadow-lg text-xs space-y-0.5">
              <p className="font-medium">
                {(d as any).month}
                {(d as any)._partial && (
                  <span className="ml-1.5 font-normal text-muted-foreground">(in progress)</span>
                )}
              </p>
              <p className={(d as any).operating >= 0 ? 'text-emerald-500' : 'text-red-500'}>
                Trading: {GBP((d as any).operating)}
              </p>
              {(d as any)._financing !== 0 && (
                <p className="text-muted-foreground">
                  Funding in: {GBP((d as any)._financing)}
                </p>
              )}
              <p className="text-muted-foreground border-t border-border pt-0.5 mt-0.5">
                Net change: {GBP((d as any)._net)}
              </p>
            </div>
          )}
        />
      </div>
    </div>
  );
}

/** Full derivation of safe-to-spend, one line at a time. */
function SafeToSpendDrawer({
  insights,
  onClose,
}: {
  insights: CashInsights;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">
              How safe-to-spend is calculated
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every deduction, and why it&rsquo;s there.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {insights.safeToSpendLines.map((line, index) => (
            <div
              key={line.label}
              className={cn(
                'rounded-lg border p-3',
                index === 0 ? 'border-border bg-muted/30' : 'border-border'
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{line.label}</p>
                <p
                  className={cn(
                    'text-sm font-semibold tabular-nums shrink-0',
                    line.amount < 0 ? 'text-red-500' : 'text-foreground'
                  )}
                >
                  {GBP(line.amount)}
                </p>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{line.detail}</p>
            </div>
          ))}

          <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold text-foreground">Safe to spend</p>
              <p className="text-lg font-semibold tabular-nums text-foreground">
                {GBP(insights.safeToSpend)}
              </p>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              What you could commit today without depending on next month trading well.
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">A caveat worth keeping in mind.</strong> This is a
              snapshot of cash you hold now, not a forecast. It doesn&rsquo;t know about stock
              you&rsquo;re about to order, wages due, or a supplier invoice that hasn&rsquo;t been
              entered yet. It also assumes money already collected stays collected — a wave of
              refunds would change it.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}

/**
 * Whether the statement can be trusted, stated plainly.
 *
 * A cash flow statement that doesn't tie back to the bank is unverifiable, so
 * the check belongs on the page rather than in someone's head.
 */
function CashFlowIntegrity({ cashFlow }: { cashFlow: ReportsData['cashFlow'] }) {
  const { coverage } = cashFlow;
  const hasCoverageGap = coverage.unjournalledTxns > 0;
  const allClear = cashFlow.reconciles && !cashFlow.openingBalanceImplausible && !hasCoverageGap;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-foreground mb-3">
        Reconciliation
        <InfoTooltip text="Opening cash plus everything that moved should equal the bank's own closing balance. If it doesn't, the difference is shown rather than absorbed." />
      </h3>

      <table className="w-full mb-1">
        <tbody>
          <FinRow label="Opening cash" amount={cashFlow.openingBalance} indent={1} />
          <FinRow label="Net change in cash" amount={cashFlow.netChange} indent={1} />
          <FinRow label="Expected closing cash" amount={cashFlow.closingBalance} isTotal />
          <FinRow label="Closing cash per bank" amount={cashFlow.closingBalancePerBank} indent={1} />
          <FinRow
            label="Unexplained difference"
            amount={cashFlow.reconciliationVariance}
            isTotal
          />
        </tbody>
      </table>

      <div className="mt-4 space-y-2">
        {cashFlow.reconciles ? (
          <p className="text-xs text-emerald-500 flex items-start gap-1.5">
            <span aria-hidden>✓</span>
            <span>
              The statement ties to the bank. Every pound that moved is accounted for in a
              category above.
            </span>
          </p>
        ) : cashFlow.varianceIsMaterial ? (
          <p className="text-xs text-red-500 flex items-start gap-1.5">
            <span aria-hidden>!</span>
            <span>
              The statement is out by {GBP(Math.abs(cashFlow.reconciliationVariance))}. Treat the
              figures above as indicative until this is resolved.
            </span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <span aria-hidden>·</span>
            <span>
              Ties to the bank within {GBP(Math.abs(cashFlow.reconciliationVariance))}. This
              period contains a currency conversion whose opposite leg was excluded as noise, so
              the bank figure counts one side of it as an inflow. Too small to affect any
              decision.
            </span>
          </p>
        )}

        {cashFlow.openingBalanceImplausible && (
          <p className="text-xs text-amber-500 flex items-start gap-1.5">
            <span aria-hidden>!</span>
            <span>
              This all-time view implies an opening balance of{' '}
              {GBP(cashFlow.openingBalance)}, but the business started from nothing. Bank history
              doesn&rsquo;t reach back far enough to explain the bank&rsquo;s own earliest balance,
              so figures spanning the earliest periods are understated by roughly this amount.
            </span>
          </p>
        )}

        {hasCoverageGap && (
          <p className="text-xs text-amber-500 flex items-start gap-1.5">
            <span aria-hidden>!</span>
            <span>
              {coverage.unjournalledTxns} of {coverage.cashTxns} bank transactions aren&rsquo;t in a
              category yet.{' '}
              {coverage.draftTxns > 0 && (
                <>
                  {coverage.draftTxns}{' '}
                  {coverage.draftTxns === 1 ? 'has a draft journal' : 'have draft journals'} waiting
                  to be reviewed and posted — drafts are held out of every statement until you
                  confirm the account is right.{' '}
                </>
              )}
              {coverage.noJournalTxns > 0 && (
                <>
                  {coverage.noJournalTxns}{' '}
                  {coverage.noJournalTxns === 1 ? 'has' : 'have'} no journal at all; running
                  Generate Journals will create {coverage.noJournalTxns === 1 ? 'it' : 'them'}.
                </>
              )}
            </span>
          </p>
        )}

        {cashFlow.internalTransfersEliminated > 0 && (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <span aria-hidden>·</span>
            <span>
              {cashFlow.internalTransfersEliminated} transfer
              {cashFlow.internalTransfersEliminated === 1 ? '' : 's'} between your own accounts
              (currency conversions and sweeps) netted out — they move cash without changing how
              much you have.
            </span>
          </p>
        )}

        {allClear && (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <span aria-hidden>·</span>
            <span>
              All {coverage.cashTxns} bank transactions in this period are journalled and
              categorised.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function CashFlowTab({ data }: { data: ReportsData }) {
  const { cashFlow, cashInsights } = data;
  const [safeToSpendOpen, setSafeToSpendOpen] = useState(false);
  const hasData =
    cashFlow.operating.length > 0 ||
    cashFlow.investing.length > 0 ||
    cashFlow.financing.length > 0 ||
    cashFlow.unclassified.length > 0;
  const closingLabel = cashFlow.endingBalanceIsLive
    ? 'Closing cash (per bank, live)'
    : 'Closing cash (per bank, period end)';

  return (
    <div className="space-y-4">
      {/* Insights sit above the statement: the question "can I spend this" is
          asked far more often than "show me the statement". */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Cash health and safe-to-spend look at a trailing window ending today, so they
          don&rsquo;t change with the date filter above.
        </p>
        <a
          href="/api/reports/cash-flow-pack"
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <FilePdf size={14} />
          Download report
        </a>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <CashHealthCard insights={cashInsights} />
        <SafeToSpendCard
          insights={cashInsights}
          onOpenBreakdown={() => setSafeToSpendOpen(true)}
        />
      </div>

      {cashInsights.monthly.length > 1 && <CashTrendChart insights={cashInsights} />}

      {safeToSpendOpen && (
        <SafeToSpendDrawer insights={cashInsights} onClose={() => setSafeToSpendOpen(false)} />
      )}

      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-foreground mb-1">
          Cash Flow Statement
          <InfoTooltip text="Direct method. Cash movement comes from bank transactions; each movement is categorised by the account on the other side of its journal entry, not by the payee's name." />
        </h3>
        <p className="text-xs text-muted-foreground mb-4">
          Bank accounts only. PayPal activity is excluded — it passes through the same bank
          account, so counting it would count the same money twice.
        </p>
        <table className="w-full">
          <tbody>
            <FinRow
              label="Opening cash"
              amount={cashFlow.openingBalance}
              isTotal
              tooltip="Bank balance at the start of the period, rolled back from the bank's own reported balance."
            />

            <FinRow
              label="Operating Activities"
              isSection
              tooltip="Cash from the trading cycle — sales collected, suppliers, shipping, wages, overheads and tax."
            />
            {cashFlow.operating.map(item => (
              <FinRow
                key={item.label}
                label={item.accountNumber ? `${item.accountNumber} · ${item.label}` : item.label}
                amount={item.amount}
                indent={1}
              />
            ))}
            <FinRow
              label="Net Cash from Operations"
              amount={cashFlow.totalOperating}
              isTotal
              tooltip="The number that matters most for cash health: what the business itself generated or consumed, before funding."
            />

            {cashFlow.investing.length > 0 && (
              <>
                <FinRow
                  label="Investing Activities"
                  isSection
                  tooltip="Buying or disposing of long-lived assets — equipment, fixtures, systems."
                />
                {cashFlow.investing.map(item => (
                  <FinRow
                    key={item.label}
                    label={item.accountNumber ? `${item.accountNumber} · ${item.label}` : item.label}
                    amount={item.amount}
                    indent={1}
                  />
                ))}
                <FinRow label="Net Cash from Investing" amount={cashFlow.totalInvesting} isTotal />
              </>
            )}

            {cashFlow.financing.length > 0 && (
              <>
                <FinRow
                  label="Financing Activities"
                  isSection
                  tooltip="Money in or out from funding sources rather than trading — director's loan, share capital, borrowings."
                />
                {cashFlow.financing.map(item => (
                  <FinRow
                    key={item.label}
                    label={item.accountNumber ? `${item.accountNumber} · ${item.label}` : item.label}
                    amount={item.amount}
                    indent={1}
                  />
                ))}
                <FinRow label="Net Cash from Financing" amount={cashFlow.totalFinancing} isTotal />
              </>
            )}

            {cashFlow.unclassified.length > 0 && (
              <>
                <FinRow
                  label="Not Yet Journalled"
                  isSection
                  tooltip="Cash that genuinely moved through the bank but has no posted journal, so the ledger can't say what it was for. Counted in the totals — the money did move — but not attributed to a category."
                />
                {cashFlow.unclassified.map(item => (
                  <FinRow
                    key={item.label}
                    label={`${item.label} (${item.txnCount})`}
                    amount={item.amount}
                    indent={1}
                  />
                ))}
                <FinRow label="Total Unclassified" amount={cashFlow.totalUnclassified} isTotal />
              </>
            )}

            <FinRow
              label="Net Change in Cash"
              amount={cashFlow.netChange}
              isGrandTotal
              tooltip="Operating + Investing + Financing + anything not yet journalled."
            />
            <FinRow
              label={closingLabel}
              amount={cashFlow.closingBalancePerBank}
              isTotal
              tooltip="Derived independently from the bank's own reported balance — not from the movement above. That's what makes the check below meaningful."
            />
          </tbody>
        </table>

        {!hasData && (
          <p className="mt-4 text-center text-muted-foreground text-sm">
            No bank transactions found for the selected period.
          </p>
        )}
      </div>

      <CashFlowIntegrity cashFlow={cashFlow} />
    </div>
  );
}

// ─── Main Page Component ──────────────────────────────────────────────

export default function ReportsPage() {
  const { data } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('revenue');
  const [drilldownTarget, setDrilldownTarget] = useState<ReportRowDrilldownTarget | null>(null);
  const [cogsDetailsTarget, setCogsDetailsTarget] = useState<CogsDetailsTarget | null>(null);
  const [expenseDetailsTarget, setExpenseDetailsTarget] = useState<ExpenseDetailsTarget | null>(
    null
  );

  const currentFrom = searchParams.get('from') || '';
  const currentTo = searchParams.get('to') || '';

  const handleRefresh = useCallback(() => {
    revalidator.revalidate();
  }, [revalidator]);

  useEffect(() => {
    setDrilldownTarget(null);
    setCogsDetailsTarget(null);
    setExpenseDetailsTarget(null);
  }, [activeTab]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'revenue',
      label: 'Revenue Analysis',
      icon: <TrendUp size={16} weight="duotone" />,
    },
    {
      id: 'pnl',
      label: 'Profit & Loss',
      icon: <ChartLine size={16} weight="duotone" />,
    },
    {
      id: 'balance',
      label: 'Balance Sheet',
      icon: <Scales size={16} weight="duotone" />,
    },
    {
      id: 'cashflow',
      label: 'Cash Flow',
      icon: <CurrencyCircleDollar size={16} weight="duotone" />,
    },
  ];

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Header */}
      <header className="border-b border-border bg-card/95 backdrop-blur-sm sticky top-0 z-40">
        <div className="px-4 md:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-foreground">Financial Reports</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Detailed financial statements and analysis
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRefresh}
              disabled={revalidator.state === 'loading'}
              title="Refresh data"
              className="h-9 w-9"
            >
              {revalidator.state === 'loading' ? (
                <CircleNotch size={18} className="animate-spin" />
              ) : (
                <ArrowClockwise size={18} />
              )}
            </Button>
          </div>
        </div>
      </header>

      <main className="px-4 md:px-6 lg:px-8 py-6 space-y-6">
        {/* Date Range Selector */}
        <DateRangeSelector currentFrom={currentFrom} currentTo={currentTo} />

        {/* Summary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
          <KPICard
            title="Gross Revenue"
            value={GBP0(data.revenue.grossRevenue)}
            icon={<TrendUp size={18} weight="duotone" />}
            iconColor="bg-emerald-500/10 text-emerald-500"
            tooltip="Total current order value across non-cancelled orders in the selected period. This includes shipping and reflects ThreadWise order totals; the revenue breakdown below shows the Shopify-aligned sales components separately."
          />
          <KPICard
            title="Net Revenue"
            value={GBP0(data.revenue.netRevenue)}
            icon={<CurrencyCircleDollar size={18} weight="duotone" />}
            iconColor="bg-blue-500/10 text-blue-500"
            tooltip="Shopify-aligned Total Sales minus Processing Fees, using payment-backed successful refunds and shipping adjustments."
          />
          <KPICard
            title="Shipping Cost"
            value={GBP(data.revenue.shippingCost)}
            icon={<Truck size={18} weight="duotone" />}
            iconColor="bg-amber-500/10 text-amber-500"
            tooltip="Total outbound shipping and fulfilment cost in the selected period, classified from bank transactions using the shared Shipping & Fulfilment detection rule."
          />
          <KPICard
            title="Shipping Margin"
            value={GBP(data.revenue.shippingMargin)}
            icon={<Wallet size={18} weight="duotone" />}
            iconColor={
              data.revenue.shippingMargin >= 0
                ? 'bg-emerald-500/10 text-emerald-500'
                : 'bg-rose-500/10 text-rose-500'
            }
            tooltip="Shipping Collected minus Shipping Cost. Positive means shipping charges covered fulfilment spend; negative means the business subsidised shipping."
          />
          <KPICard
            title="Processing Fees"
            value={GBP0(data.revenue.processingFees)}
            icon={<Receipt size={18} weight="duotone" />}
            iconColor="bg-rose-500/10 text-rose-500"
            tooltip="Total payment gateway fees (Stripe, PayPal) on captured payments in the period."
          />
          <KPICard
            title="Refunds"
            value={GBP0(data.revenue.refunds)}
            icon={<ArrowsClockwise size={18} weight="duotone" />}
            iconColor="bg-orange-500/10 text-orange-500"
            tooltip="Successful refunded payment cash in the selected period, including shipping refunds. The sales breakdown below separates Returns from shipping refunds."
          />
          <KPICard
            title="Avg Order Value"
            value={GBP(data.revenue.avgOrderValue)}
            icon={<ShoppingCart size={18} weight="duotone" />}
            iconColor="bg-violet-500/10 text-violet-500"
            tooltip="Gross Revenue divided by total number of orders. Higher AOV means customers are spending more per order."
          />
          <KPICard
            title="Bank Balance"
            value={GBP(data.cashFlow.closingBalancePerBank)}
            icon={<Wallet size={18} weight="duotone" />}
            iconColor="bg-cyan-500/10 text-cyan-500"
            tooltip={
              data.cashFlow.endingBalanceIsLive
                ? 'Current total balance across all connected bank accounts, derived from the last synced bank balances plus subsequent bank transactions. This is a live figure, not period-specific.'
                : 'Bank balance as of the end of the selected reporting period, derived by rolling current bank balances backward through later bank transactions.'
            }
          />
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === tab.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'revenue' && (
          <RevenueAnalysisTab
            data={data}
            onOpenCogsDetails={month => setCogsDetailsTarget({ month })}
            onOpenShippingDetails={month => setExpenseDetailsTarget({ month, kind: 'shipping' })}
            onOpenOtherExpensesDetails={month =>
              setExpenseDetailsTarget({ month, kind: 'other_expenses' })
            }
          />
        )}
        {activeTab === 'pnl' && (
          <ProfitAndLossTab data={data} onAccountSelect={setDrilldownTarget} />
        )}
        {activeTab === 'balance' && (
          <BalanceSheetTab data={data} onAccountSelect={setDrilldownTarget} />
        )}
        {activeTab === 'cashflow' && <CashFlowTab data={data} />}
      </main>

      <AccountDrilldownDrawer
        target={drilldownTarget}
        currentFrom={currentFrom}
        currentTo={currentTo}
        onClose={() => setDrilldownTarget(null)}
      />

      <CogsDetailsDrawer
        data={data}
        target={cogsDetailsTarget}
        onClose={() => setCogsDetailsTarget(null)}
      />

      <ExpenseDetailsDrawer
        data={data}
        target={expenseDetailsTarget}
        onClose={() => setExpenseDetailsTarget(null)}
      />
    </div>
  );
}
