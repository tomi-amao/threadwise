/**
 * ReportsPage
 *
 * How the business is doing, and how we know. Four views of one set of records: revenue (from
 * orders and payments), profit and loss and the balance sheet (from the ledger), and cash (from
 * the bank). The tiles at the top say where things stand and whether the books balance; the date
 * range, tab and any open drawer live in the URL.
 */

import { useCallback } from 'react';
import { useRevalidator } from 'react-router';
import { ArrowClockwise } from 'phosphor-react';
import { Button } from '~/components/ui/button';
import { DateRangePicker } from '~/components/ui/date-range-picker';
import { KpiTile } from '~/components/ui/kpi-tile';
import { CompactHeader } from '~/components/ui/page-header';
import { Tabs, tabId } from '~/components/ui/tabs';
import type { ReportsData } from '~/lib/api/reports.server';
import { useUrlParams } from '~/lib/use-url-params';
import { AccountDrawer } from './AccountDrawer';
import { CashTab } from './CashTab';
import { MonthDetailDrawer, type MonthDetailKind } from './MonthDetailDrawer';
import { RevenueTab } from './RevenueTab';
import { BalanceSheetTab, ProfitLossTab } from './StatementTabs';
import { int, isBalanced, money, type DrilldownTarget } from './model';

const TABS = [
  { id: 'revenue', label: 'Revenue' },
  { id: 'pnl', label: 'Profit and loss' },
  { id: 'balance', label: 'Balance sheet' },
  { id: 'cash', label: 'Cash' },
] as const;
type TabKey = (typeof TABS)[number]['id'];
const isTab = (v: string | null): v is TabKey => TABS.some(t => t.id === v);
const isKind = (v: string | null): v is MonthDetailKind =>
  v === 'cogs' || v === 'shipping' || v === 'other';

export function ReportsPage({
  data,
  fiscalYearEnd,
}: {
  data: ReportsData;
  fiscalYearEnd: { day: number; month: number };
}) {
  const revalidator = useRevalidator();
  const [sp, apply] = useUrlParams();

  const rawTab = sp.get('tab');
  const tab: TabKey = isTab(rawTab) ? rawTab : 'revenue';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';

  const accountId = sp.get('account');
  const statement = sp.get('statement') === 'balance' ? 'balance' : 'pnl';
  const accountTarget: DrilldownTarget | null = accountId
    ? {
        accountId,
        statement,
        accountName: sp.get('name') ?? 'Account',
        accountCode: Number(sp.get('code')) || 0,
      }
    : null;
  const detailKind = sp.get('detail');
  const detailMonth = sp.get('month');
  const detail =
    isKind(detailKind) && detailMonth ? { kind: detailKind, month: detailMonth } : null;
  const safeOpen = sp.get('safe') === '1';

  const set = useCallback(
    (patch: Record<string, string | null>) =>
      apply(p => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) p.delete(key);
          else p.set(key, value);
        }
        return p;
      }),
    [apply]
  );
  const closeDrawers = {
    account: null,
    statement: null,
    name: null,
    code: null,
    detail: null,
    month: null,
    safe: null,
  };

  const balanced = isBalanced(data);
  const { revenue, accountingPnL, balanceSheet, cashInsights } = data;

  return (
    <div className="pb-10">
      <CompactHeader
        className="hero-glow px-4 sm:px-6 lg:px-8"
        eyebrow="Reports"
        title={
          <>
            How the business is doing, <em>and how we know.</em>
          </>
        }
        description="Every figure traces back to an order, a bank transaction or a journal."
        actions={
          <>
            <DateRangePicker
              from={from}
              to={to}
              onApply={(f, t) => set({ from: f || null, to: t || null, ...closeDrawers })}
              fiscalYearEnd={fiscalYearEnd}
              className="h-10 rounded-full border-border-strong bg-card px-4 text-[15px] font-normal hover:bg-card hover:border-ring"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => revalidator.revalidate()}
              disabled={revalidator.state !== 'idle'}
            >
              <ArrowClockwise size={14} weight="light" aria-hidden /> Refresh
            </Button>
          </>
        }
      />

      <div className="space-y-4 px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            label="Total sales"
            value={money(revenue.totalSales, 0)}
            caption={`${int(revenue.orderCount)} orders in the period`}
          />
          <KpiTile
            label="Net income"
            tone={accountingPnL.netIncome < 0 ? 'negative' : 'income'}
            value={money(accountingPnL.netIncome, 0)}
            caption="from the ledger, same period"
          />
          <KpiTile
            label="Cash in the bank"
            value={money(cashInsights.cashOnHand, 0)}
            caption={`${money(cashInsights.safeToSpend, 0)} safe to spend`}
          />
          <KpiTile
            label="Books balance"
            tone={balanced ? 'default' : 'negative'}
            value={
              balanced ? 'Balanced' : `Out by ${money(Math.abs(balanceSheet.balanceCheck), 0)}`
            }
            caption="assets = liabilities + equity"
          />
        </div>

        <Tabs
          tabs={TABS.map(t => ({ id: t.id, label: t.label }))}
          value={tab}
          onChange={id => set({ tab: id, ...closeDrawers })}
        />

        <div role="tabpanel" aria-labelledby={tabId(tab)}>
          {tab === 'revenue' && (
            <RevenueTab data={data} onOpenDetail={(kind, month) => set({ detail: kind, month })} />
          )}
          {tab === 'pnl' && (
            <ProfitLossTab
              data={data}
              onSelect={t =>
                set({
                  account: t.accountId,
                  statement: t.statement,
                  name: t.accountName,
                  code: String(t.accountCode),
                })
              }
            />
          )}
          {tab === 'balance' && (
            <BalanceSheetTab
              data={data}
              onSelect={t =>
                set({
                  account: t.accountId,
                  statement: t.statement,
                  name: t.accountName,
                  code: String(t.accountCode),
                })
              }
            />
          )}
          {tab === 'cash' && (
            <CashTab
              data={data}
              safeOpen={safeOpen}
              onSafeOpen={open => set({ safe: open ? '1' : null })}
            />
          )}
        </div>
      </div>

      <AccountDrawer
        target={accountTarget}
        from={from}
        to={to}
        onClose={() => set({ account: null, statement: null, name: null, code: null })}
      />
      <MonthDetailDrawer
        data={data}
        target={detail}
        onClose={() => set({ detail: null, month: null })}
      />
    </div>
  );
}
