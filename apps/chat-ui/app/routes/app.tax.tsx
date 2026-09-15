/**
 * Tax Route (Protected)
 *
 * UK corporation tax position, cut on the company's real accounting periods
 * rather than calendar years, plus the CT600 preparation pack.
 *
 * Design principle: never present a projection as a liability. An open
 * accounting period is still trading — its figures are a run-rate, and the
 * page says so wherever they appear.
 */

import { useState, useEffect } from 'react';
import type { MetaFunction } from 'react-router';
import { useLoaderData, useFetcher } from 'react-router';
import {
  Bank,
  CalendarCheck,
  CheckCircle,
  Warning,
  WarningCircle,
  Info,
  Receipt,
  FileArrowDown,
  Scales,
  ChartLineUp,
  UserCircle,
  CaretRight,
  MagnifyingGlass,
  X,
} from 'phosphor-react';
import { getTaxData } from '~/lib/api/tax.server';
import type { TaxData, TaxPeriod, TaxDeadline, ProfitBreakdownLine } from '~/lib/api/tax.server';
import type { AccountDrilldownData } from '~/lib/api/reports.server';

export const meta: MetaFunction = () => [
  { title: 'Tax - ThreadWise' },
  { name: 'description', content: 'UK corporation tax position and CT600 preparation' },
];

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

const formatDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export async function loader() {
  const data = await getTaxData();
  return { data };
}

// ─── Small building blocks ────────────────────────────────────────────

function Card({
  title,
  icon,
  children,
  accent,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className={`rounded-xl border bg-card p-5 ${accent ?? 'border-border'}`}>
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  bold,
  indent,
  hint,
  onClick,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'muted';
  bold?: boolean;
  indent?: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-emerald-500'
      : tone === 'negative'
        ? 'text-rose-500'
        : tone === 'muted'
          ? 'text-muted-foreground'
          : 'text-foreground';
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-1.5 ${
        bold ? 'border-t border-border mt-1 pt-2.5' : ''
      } ${onClick ? '-mx-2 px-2 rounded-lg cursor-pointer hover:bg-muted/40 transition-colors group' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') onClick();
            }
          : undefined
      }
    >
      <div className={`min-w-0 ${indent ? 'pl-4' : ''}`}>
        <span
          className={`text-sm ${bold ? 'font-semibold text-foreground' : 'text-muted-foreground'} ${
            onClick ? 'group-hover:text-primary transition-colors' : ''
          }`}
        >
          {label}
          {onClick && (
            <MagnifyingGlass
              size={12}
              className="inline-block ml-1.5 opacity-0 group-hover:opacity-60 transition-opacity -mt-0.5"
            />
          )}
        </span>
        {hint && <p className="text-[11px] text-muted-foreground/70 mt-0.5">{hint}</p>}
      </div>
      <span
        className={`text-sm tabular-nums shrink-0 ${bold ? 'font-semibold' : ''} ${toneClass}`}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Computation waterfall ────────────────────────────────────────────

function Computation({
  period,
  onOpenProfitBreakdown,
}: {
  period: TaxPeriod;
  onOpenProfitBreakdown?: () => void;
}) {
  // Periods that predate reliable bookkeeping carry no figures at all.
  if (!period.ledgerBasis) {
    return (
      <div className="rounded-lg border border-border bg-background px-4 py-4">
        <div className="flex gap-2">
          <Info size={15} className="text-muted-foreground shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm text-foreground font-medium">
              No computation available for this period
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              It predates reliable bookkeeping in this system, so no figures are shown rather
              than ones that would look authoritative but be guesses. The real numbers are in
              the accounts filed at Companies House and your accountant&apos;s records.
            </p>
            {period.notes && (
              <p className="text-[11px] text-muted-foreground/80 mt-2 border-l-2 border-border pl-2">
                {period.notes}
              </p>
            )}
            {period.filedNetAssets !== null && (
              <p className="text-xs text-foreground mt-2">
                Net assets per filed accounts:{' '}
                <span className="font-semibold tabular-nums">{GBP(period.filedNetAssets)}</span>
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isLoss = (period.adjustedProfit ?? 0) < 0;
  const n = (v: number | null) => v ?? 0;
  return (
    <div>
      <Row
        label="Profit per the accounts"
        value={GBP(n(period.accountingProfit))}
        onClick={onOpenProfitBreakdown}
        hint={onOpenProfitBreakdown ? 'Click to see how this is made up' : undefined}
      />
      {n(period.addBacks) > 0 && (
        <Row
          label="Add back: disallowable expenditure"
          value={`+ ${GBP(n(period.addBacks))}`}
          tone="negative"
          indent
        />
      )}
      {n(period.deductions) > 0 && (
        <Row
          label="Less: allowances and reliefs"
          value={`− ${GBP(n(period.deductions))}`}
          tone="positive"
          indent
        />
      )}
      <Row label="Adjusted trading result" value={GBP(n(period.adjustedProfit))} bold />

      {n(period.lossBroughtForward) > 0 && (
        <Row
          label="Losses brought forward"
          value={GBP(n(period.lossBroughtForward))}
          tone="muted"
          hint="Carried forward from earlier periods"
        />
      )}
      {n(period.lossReliefUsed) > 0 && (
        <Row
          label="Less: loss relief applied"
          value={`− ${GBP(n(period.lossReliefUsed))}`}
          tone="positive"
          indent
        />
      )}

      <Row
        label="Taxable total profits"
        value={GBP(n(period.taxableProfit))}
        bold
        hint={isLoss ? 'A loss cannot be taxed — the result carries forward instead' : undefined}
      />

      {n(period.marginalRelief) > 0 && (
        <Row label="Marginal relief" value={`− ${GBP(n(period.marginalRelief))}`} tone="positive" indent />
      )}

      <Row
        label={
          n(period.taxableProfit) > 0
            ? `Corporation tax at ${(n(period.effectiveRate) * 100).toFixed(2)}%`
            : 'Corporation tax'
        }
        value={GBP(n(period.taxDue))}
        bold
      />

      {n(period.lossCarriedForward) > 0 && (
        <div className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2">
          <p className="text-xs text-blue-400">
            <strong>{GBP(n(period.lossCarriedForward))}</strong> of losses carry forward to reduce
            future profits.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Deadlines ────────────────────────────────────────────────────────

function DeadlineRow({ deadline }: { deadline: TaxDeadline }) {
  const cfg = {
    overdue: { cls: 'text-rose-400 border-rose-500/20 bg-rose-500/5', icon: <WarningCircle size={14} weight="fill" /> },
    due_soon: { cls: 'text-amber-400 border-amber-500/20 bg-amber-500/5', icon: <Warning size={14} weight="fill" /> },
    upcoming: { cls: 'text-muted-foreground border-border bg-background', icon: <CalendarCheck size={14} /> },
    satisfied: { cls: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5', icon: <CheckCircle size={14} weight="fill" /> },
  }[deadline.status];

  const when =
    deadline.daysRemaining < 0
      ? `${Math.abs(deadline.daysRemaining)} days past`
      : `in ${deadline.daysRemaining} days`;

  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${cfg.cls}`}>
      {cfg.icon}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">
          {deadline.kind === 'payment' ? 'Pay corporation tax' : 'File CT600 return'} —{' '}
          {deadline.label}
        </p>
        <p className="text-[11px] opacity-70">
          Due {formatDate(deadline.dueDate)} · {when}
        </p>
      </div>
      {deadline.amount !== null && deadline.amount > 0 && (
        <span className="text-sm font-semibold tabular-nums shrink-0">{GBP(deadline.amount)}</span>
      )}
      {deadline.status === 'satisfied' && deadline.amount === 0 && (
        <span className="text-[11px] shrink-0">Nothing to pay</span>
      )}
    </div>
  );
}

// ─── Profit breakdown drawer ───────────────────────────────────────────

const ACCOUNT_TYPE_LABEL: Record<ProfitBreakdownLine['accountType'], string> = {
  revenue: 'Revenue',
  cogs: 'Cost of Goods Sold',
  expense: 'Operating Expenses',
};

/** Inline expansion of one account's underlying journal entries for a period. */
function AccountTransactions({
  accountId,
  from,
  to,
}: {
  accountId: string;
  from: string;
  to: string;
}) {
  const fetcher = useFetcher<{ drilldown?: AccountDrilldownData; error?: string }>();

  useEffect(() => {
    const params = new URLSearchParams({ accountId, statement: 'pnl', from, to });
    fetcher.load(`/api/reports/account-drilldown?${params.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, from, to]);

  const loading = fetcher.state !== 'idle' && !fetcher.data;
  const entries = fetcher.data?.drilldown?.entries ?? [];

  return (
    <div className="mt-2 mb-1 rounded-lg border border-border/60 bg-background/60 overflow-hidden">
      {loading ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">Loading transactions…</p>
      ) : fetcher.data?.error ? (
        <p className="px-3 py-3 text-xs text-rose-400">{fetcher.data.error}</p>
      ) : entries.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">No entries found.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/30 text-muted-foreground">
              <th className="px-3 py-1.5 text-left font-medium">Date</th>
              <th className="px-3 py-1.5 text-left font-medium">Source</th>
              <th className="px-3 py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.journalId} className="border-t border-border/40">
                <td className="px-3 py-1.5 text-foreground whitespace-nowrap">
                  {formatDate(entry.journalDate.slice(0, 10))}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[240px]">
                  {entry.sourceLabel}
                  {entry.journalDescription && (
                    <span className="block text-[10px] text-muted-foreground/70 truncate">
                      {entry.journalDescription}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-foreground shrink-0">
                  {GBP(entry.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ProfitBreakdownRow({ line, period }: { line: ProfitBreakdownLine; period: TaxPeriod }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/30 transition-colors group"
      >
        <span className="flex items-center gap-1.5 min-w-0 text-sm text-foreground">
          <CaretRight
            size={11}
            className={`text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span className="font-mono text-[11px] text-muted-foreground shrink-0">
            {line.accountNumber}
          </span>
          <span className="truncate">{line.accountName}</span>
          <span className="text-[11px] text-muted-foreground shrink-0">
            ({line.lineCount} {line.lineCount === 1 ? 'entry' : 'entries'})
          </span>
        </span>
        <span className="text-sm tabular-nums text-foreground shrink-0">
          {GBP(Math.abs(line.balance))}
        </span>
      </button>
      {expanded && (
        <div className="px-3">
          <AccountTransactions
            accountId={line.accountId}
            from={period.startDate}
            to={period.endDate}
          />
        </div>
      )}
    </div>
  );
}

function ProfitBreakdownDrawer({
  period,
  lines,
  onClose,
}: {
  period: TaxPeriod;
  lines: ProfitBreakdownLine[];
  onClose: () => void;
}) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const groups: Record<ProfitBreakdownLine['accountType'], ProfitBreakdownLine[]> = {
    revenue: lines.filter(l => l.accountType === 'revenue'),
    cogs: lines.filter(l => l.accountType === 'cogs'),
    expense: lines.filter(l => l.accountType === 'expense'),
  };
  const totals = {
    revenue: groups.revenue.reduce((s, l) => s + l.balance, 0),
    cogs: groups.cogs.reduce((s, l) => s + l.balance, 0),
    expense: groups.expense.reduce((s, l) => s + l.balance, 0),
  };
  const netProfit = totals.revenue - totals.cogs - totals.expense;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">
              How this period&apos;s profit is calculated
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{period.label}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Click any account to see the individual entries behind it.
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

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {(['revenue', 'cogs', 'expense'] as const).map(type => (
            <div key={type}>
              <div className="flex items-center justify-between px-1 mb-2">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                  {ACCOUNT_TYPE_LABEL[type]}
                </span>
                <span className="text-xs font-semibold tabular-nums text-foreground">
                  {GBP(totals[type])}
                </span>
              </div>
              {groups[type].length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground border border-dashed border-border rounded-lg">
                  Nothing posted here this period.
                </p>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                  {groups[type].map(line => (
                    <ProfitBreakdownRow key={line.accountId} line={line} period={period} />
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">
              Revenue − COGS − Expenses
            </span>
            <span
              className={`text-base font-bold tabular-nums ${netProfit < 0 ? 'text-rose-500' : 'text-foreground'}`}
            >
              {GBP(netProfit)}
            </span>
          </div>

          <p className="text-[11px] text-muted-foreground">
            This is accounting profit, not taxable profit — the tax computation still applies
            disallowable add-backs and loss relief on top of this figure.
          </p>
        </div>
      </aside>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function TaxPage() {
  const { data } = useLoaderData<typeof loader>() as { data: TaxData };
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>(
    data.lastClosedPeriod?.periodId ?? data.currentPeriod?.periodId ?? ''
  );
  const packFetcher = useFetcher();
  const [profitBreakdownOpen, setProfitBreakdownOpen] = useState(false);

  const selected = data.periods.find(p => p.periodId === selectedPeriodId) ?? data.periods[0];
  const unresolved = data.reviewItems.filter(
    r => !r.resolved && r.periodId === selected?.periodId && selected?.ledgerBasis
  );
  const overdueCount = data.deadlines.filter(d => d.status === 'overdue').length;

  return (
    <div className="p-6 space-y-6 max-w-[1200px]">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Tax</h1>
          <p className="text-sm text-muted-foreground mt-1">
            UK corporation tax · {data.entity.name}
            {data.entity.yearEndLabel && ` · year end ${data.entity.yearEndLabel}`}
          </p>
        </div>
      </div>

      {/* Headline position */}
      <div className="grid gap-4 md:grid-cols-2">
        {data.lastClosedPeriod ? (
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <Scales size={16} className="text-primary" />
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Last completed period
              </span>
            </div>
            <p className="mt-3 text-3xl font-semibold text-foreground tabular-nums">
              {GBP(data.lastClosedPeriod.taxDue ?? 0)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.lastClosedPeriod.label} · due {formatDate(data.lastClosedPeriod.paymentDue)}
            </p>
            {data.lastClosedPeriod.taxDue === 0 && (
              <p className="mt-2 text-xs text-emerald-400">
                No tax payable — the period made a loss. The return is still required.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2">
              <Scales size={16} className="text-muted-foreground" />
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Completed periods
              </span>
            </div>
            <p className="mt-3 text-sm text-foreground">
              No completed period can be computed here yet.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Every period that has ended predates reliable bookkeeping in this system. Their
              figures live in the accounts filed at Companies House and your accountant&apos;s
              records — this page won&apos;t restate them from data it can&apos;t stand behind.
            </p>
          </div>
        )}

        {data.currentPeriod && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-5">
            <div className="flex items-center gap-2">
              <ChartLineUp size={16} className="text-amber-400" />
              <span className="text-[11px] uppercase tracking-wider text-amber-400">
                Current period · projection
              </span>
            </div>
            <p className="mt-3 text-3xl font-semibold text-foreground tabular-nums">
              {GBP(data.currentPeriod.taxDue ?? 0)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.currentPeriod.label} · {data.currentPeriod.monthsElapsed} of{' '}
              {data.currentPeriod.monthsInPeriod} months elapsed
            </p>
            <p className="mt-2 text-xs text-amber-400/90">
              Based on trading so far, not a liability. This figure will move as the rest of the
              year trades.
            </p>
          </div>
        )}
      </div>

      {/* Deadlines */}
      <Card
        title={`Deadlines${overdueCount > 0 ? ` · ${overdueCount} need attention` : ''}`}
        icon={<CalendarCheck size={16} className="text-primary" />}
      >
        <div className="space-y-2">
          {data.deadlines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deadlines yet.</p>
          ) : (
            data.deadlines.map(d => <DeadlineRow key={`${d.label}-${d.kind}`} deadline={d} />)
          )}
        </div>
        {overdueCount > 0 && (
          <div className="mt-3 flex gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
            <Info size={14} className="text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-[11px] text-muted-foreground">
              Past-dated items mean <strong>this app holds no record</strong> of the return being
              filed — it can&apos;t see HMRC. If your accountant already filed these, mark the
              period as filed so it stops flagging.
            </p>
          </div>
        )}
      </Card>

      {/* Period selector + computation */}
      <Card title="Tax computation" icon={<Receipt size={16} className="text-primary" />}>
        <div className="flex gap-2 flex-wrap mb-4">
          {data.periods.map(p => (
            <button
              key={p.periodId}
              onClick={() => setSelectedPeriodId(p.periodId)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                p.periodId === selectedPeriodId
                  ? 'border-primary bg-primary/10 text-foreground font-medium'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.label}
              {p.status === 'open' && <span className="ml-1.5 text-amber-400">·open</span>}
            </button>
          ))}
        </div>

        {selected && (
          <>
            {selected.isProjection && (
              <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                <p className="text-xs text-amber-400">
                  This period is still open — {selected.monthsElapsed} of{' '}
                  {selected.monthsInPeriod} months. Treat every figure below as a projection.
                </p>
              </div>
            )}
            <Computation
              period={selected}
              onOpenProfitBreakdown={
                selected.ledgerBasis ? () => setProfitBreakdownOpen(true) : undefined
              }
            />
          </>
        )}
      </Card>

      {/* Review queue */}
      {unresolved.length > 0 && selected && (
        <Card
          title={`Needs your judgement · ${unresolved.length} item${unresolved.length === 1 ? '' : 's'}`}
          icon={<Warning size={16} className="text-amber-400" />}
          accent="border-amber-500/25"
        >
          <p className="text-xs text-muted-foreground mb-3">
            These sit in accounts that often contain disallowable spending. Nothing is added back
            automatically, because the allowable split depends on facts the ledger doesn&apos;t
            record.
          </p>
          <div className="space-y-2">
            {unresolved.map(item => (
              <div
                key={`${item.periodId}-${item.accountNumber}`}
                className="rounded-lg border border-border bg-background px-3 py-2.5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-foreground">
                    <span className="font-mono text-[11px] text-muted-foreground mr-1.5">
                      {item.accountNumber}
                    </span>
                    {item.accountName}
                  </span>
                  <span className="text-sm tabular-nums text-foreground shrink-0">
                    {GBP(item.amount)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">{item.guidance}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Monitors */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="VAT registration" icon={<Bank size={16} className="text-primary" />}>
          <p className="text-2xl font-semibold text-foreground tabular-nums">
            {GBP0(data.vat.rollingTurnover)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            rolling 12-month turnover · {data.vat.percentOfThreshold.toFixed(0)}% of the{' '}
            {GBP0(data.vat.threshold)} threshold
          </p>
          <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full ${
                data.vat.percentOfThreshold > 85
                  ? 'bg-rose-500'
                  : data.vat.percentOfThreshold > 60
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, data.vat.percentOfThreshold)}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            {data.vat.registered
              ? 'Registered'
              : `${GBP0(data.vat.headroom)} of headroom before registration becomes compulsory`}
          </p>
        </Card>

        <Card title="Director's loan" icon={<UserCircle size={16} className="text-primary" />}>
          <p className="text-2xl font-semibold text-foreground tabular-nums">
            {GBP0(Math.abs(data.directorsLoan.balance))}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {data.directorsLoan.overdrawn
              ? 'owed by you to the company'
              : 'owed by the company to you'}
          </p>
          {data.directorsLoan.overdrawn ? (
            <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2">
              <p className="text-[11px] text-rose-400">
                Overdrawn balances attract a s455 charge of{' '}
                <strong>{GBP(data.directorsLoan.s455Charge)}</strong> (33.75%) if not repaid within
                9 months of the period end.
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-emerald-400 mt-3">
              In credit — no s455 charge arises.
            </p>
          )}
        </Card>

        <Card title="Tax provision" icon={<Scales size={16} className="text-primary" />}>
          <p className="text-2xl font-semibold text-foreground tabular-nums">
            {GBP0(data.provision.accruedLiability)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">accrued on the balance sheet</p>
          <div className="mt-3 space-y-1">
            <div className="flex justify-between text-[11px]">
              <span className="text-muted-foreground">Recorded as paid to date</span>
              <span className="tabular-nums text-foreground">
                {GBP(data.provision.taxRecordedAsPaid)}
              </span>
            </div>
            {data.provision.unprovided === null ? (
              <p className="text-[11px] text-muted-foreground border-t border-border pt-1.5 mt-1.5">
                No completed period can be computed here, so there is nothing to compare paid tax
                against. Tax on the current period is still accruing.
              </p>
            ) : (
              <>
                <div className="flex justify-between text-[11px]">
                  <span className="text-muted-foreground">Tax on completed periods</span>
                  <span className="tabular-nums text-foreground">
                    {GBP(data.provision.taxOnClosedPeriods)}
                  </span>
                </div>
                {Math.abs(data.provision.unprovided) > 0.5 && (
                  <div className="flex justify-between text-[11px] border-t border-border pt-1 mt-1">
                    <span className="text-amber-400">Unprovided</span>
                    <span className="tabular-nums text-amber-400 font-medium">
                      {GBP(data.provision.unprovided)}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      {/* CT600 pack */}
      <Card title="CT600 preparation pack" icon={<FileArrowDown size={16} className="text-primary" />}>
        <p className="text-sm text-muted-foreground">
          Generates the full computation for a period with every figure mapped to its CT600 box
          number — the working paper an accountant would prepare, ready to hand over or type in.
        </p>

        {data.entity.missingForFiling.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
            <p className="text-xs text-amber-400 font-medium">
              Still needed before the pack is complete
            </p>
            <ul className="mt-1 space-y-0.5">
              {data.entity.missingForFiling.map(m => (
                <li key={m} className="text-[11px] text-amber-400/80">
                  · {m}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <a
            href={`/api/tax/ct600-pack?periodId=${selected?.periodId ?? ''}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
          >
            <FileArrowDown size={15} />
            Generate for {selected?.label ?? 'period'}
            <CaretRight size={13} />
          </a>
          {packFetcher.state !== 'idle' && (
            <span className="text-xs text-muted-foreground">Preparing…</span>
          )}
        </div>

        <div className="mt-4 flex gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
          <Info size={14} className="text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground">
            This is a computation for review, not a submission. Filing a CT600 requires
            HMRC-recognised software and iXBRL-tagged statutory accounts. Have your accountant check
            the figures — particularly any judgement calls in the review queue — before anything is
            filed.
          </p>
        </div>
      </Card>

      {profitBreakdownOpen && selected && (
        <ProfitBreakdownDrawer
          period={selected}
          lines={data.profitBreakdownByPeriod[selected.periodId] ?? []}
          onClose={() => setProfitBreakdownOpen(false)}
        />
      )}
    </div>
  );
}
