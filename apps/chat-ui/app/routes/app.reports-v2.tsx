/**
 * Reports v2 — design-language preview.
 *
 * Frontend-only redesign of /reports following docs/design-language.md.
 * No loader/action: every figure is derived from local mock data, so the
 * original /reports page and its backend wiring stay untouched.
 */

import React, { useCallback, useState } from 'react';
import type { LinksFunction, MetaFunction } from 'react-router';
import { useSearchParams } from 'react-router';
import { DownloadSimple } from 'phosphor-react';
import { toast } from 'sonner';
import { DateRangePicker } from '~/components/ui/date-range-picker';
import { Eyebrow, fmtDate, gbp, int, pct } from '~/components/collections-v2/ui';
import { ThemeToggle, useCv2Theme } from '~/components/collections-v2/theme';
import {
  cashFlowFor,
  defaultRange,
  netIncomeOf,
  revenueFor,
  sliceRange,
  sum,
} from '~/components/reports-v2/data';
import { BalanceTab, CashTab, PnlTab, RevenueTab } from '~/components/reports-v2/tabs';
import '~/components/collections-v2/collections-v2.css';
import '~/components/reports-v2/reports-v2.css';

export const meta: MetaFunction = () => [
  { title: 'Reports (new design) - ThreadWise' },
  { name: 'description', content: 'Design-language preview of the Reports page' },
];

export const links: LinksFunction = () => [
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400&display=swap',
  },
];

const TABS = [
  { id: 'revenue', label: 'Revenue' },
  { id: 'pnl', label: 'Profit & loss' },
  { id: 'balance', label: 'Balance sheet' },
  { id: 'cash', label: 'Cash flow' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function ReportsV2() {
  const [dark, setDark] = useCv2Theme();
  const [params, setParams] = useSearchParams();

  const rawTab = params.get('tab') as TabId | null;
  const tab: TabId = TABS.some(t => t.id === rawTab) ? (rawTab as TabId) : 'revenue';
  // Absent params mean "this year so far"; an explicit all=1 means all time.
  // (The picker reports all time as an empty from/to, which would otherwise be
  // indistinguishable from "nothing chosen".)
  const allTime = params.get('all') === '1';
  const fallback = defaultRange();
  const from = allTime ? '' : (params.get('from') ?? fallback.from);
  const to = allTime ? '' : (params.get('to') ?? fallback.to);

  const [pickerHost, setPickerHost] = useState<HTMLElement | null>(null);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.set('tab', tab);
    Object.entries(patch).forEach(([k, v]) => next.set(k, v));
    setParams(next, { replace: true });
  };

  const applyRange = useCallback(
    (f: string, t: string) => {
      const next = new URLSearchParams(params);
      if (!f && !t) {
        next.set('all', '1');
        next.delete('from');
        next.delete('to');
      } else {
        next.delete('all');
        next.set('from', f);
        next.set('to', t);
      }
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const months = sliceRange(from, to);
  const empty = months.length === 0;
  const last = months[months.length - 1];
  const rangeLabel = allTime ? 'All time' : `${fmtDate(from)} to ${fmtDate(to)}`;
  const rev = revenueFor(months);
  const netIncome = sum(months.map(netIncomeOf));
  const cash = cashFlowFor(months);
  const netMargin =
    rev.netSales + rev.shipping > 0 ? (netIncome / (rev.netSales + rev.shipping)) * 100 : null;

  return (
    <div className="cv2" data-theme={dark ? 'dark' : 'light'}>
      <div className="cv2-glow" aria-hidden />

      <div className="cv2-wrap" style={{ paddingTop: 20 }}>
        <div className="cv2-between">
          <span className="cv2-chip cv2-chip-active cv2-chip-plain">
            Preview · new design · mock data
          </span>
          <ThemeToggle dark={dark} onChange={setDark} />
        </div>
      </div>

      <header className="cv2-wrap cv2-rise" style={{ paddingTop: 64, paddingBottom: 48 }}>
        <Eyebrow>Financial reports · {rangeLabel}</Eyebrow>
        <h1 className="cv2-h1" style={{ marginTop: 20, maxWidth: 800 }}>
          Where the money <em>actually went.</em>
        </h1>
        <p className="cv2-lead" style={{ marginTop: 24 }}>
          Four statements, one date range. Pick your dates, and every number below follows them.
        </p>

        <div className="cv2-between" style={{ marginTop: 36, flexWrap: 'wrap' }}>
          <div ref={setPickerHost} className="cv2-picker">
            <DateRangePicker
              from={from}
              to={to}
              onApply={applyRange}
              fiscalYearEnd={{ day: 31, month: 3 }}
              className="cv2-picker-trigger"
              portalContainer={pickerHost}
            />
          </div>
          <button
            type="button"
            className="cv2-btn cv2-btn-secondary"
            onClick={() =>
              toast.info('Export is part of the live page — not wired in this preview.')
            }
          >
            <DownloadSimple size={16} weight="light" /> Export pack
          </button>
        </div>
      </header>

      <section className="cv2-wrap cv2-rise" style={{ animationDelay: '60ms' }}>
        <div className="cv2-stats">
          <div className="cv2-stat">
            <Eyebrow>Net revenue</Eyebrow>
            <div className="cv2-stat-value">{gbp(rev.netRevenue)}</div>
            <div className="cv2-stat-label">After refunds and fees</div>
            <div className="cv2-stat-cap">
              {int(rev.orders)} orders · {gbp(rev.avgOrderValue, 2)} average
            </div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Net income</Eyebrow>
            <div className={`cv2-stat-value ${netIncome < 0 ? 'cv2-neg' : ''}`}>
              {gbp(netIncome)}
            </div>
            <div className="cv2-stat-label">After all costs</div>
            <div className="cv2-stat-cap">{pct(netMargin)} net margin</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>Operating cash</Eyebrow>
            <div className={`cv2-stat-value ${cash.totalOperating < 0 ? 'cv2-neg' : ''}`}>
              {gbp(cash.totalOperating)}
            </div>
            <div className="cv2-stat-label">From trading</div>
            <div className="cv2-stat-cap">Before funding or equipment</div>
          </div>
          <div className="cv2-stat">
            <Eyebrow>In the bank</Eyebrow>
            <div className="cv2-stat-value">{gbp(cash.closing)}</div>
            <div className="cv2-stat-label">Live balance</div>
            <div className="cv2-stat-cap">Not tied to the period</div>
          </div>
        </div>
      </section>

      <div className="cv2-wrap" style={{ marginTop: 72 }}>
        <div className="cv2-tabs" role="tablist">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="cv2-tab"
              aria-selected={tab === t.id}
              onClick={() => update({ tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <main className="cv2-wrap cv2-rise" key={tab} style={{ paddingTop: 40, paddingBottom: 112 }}>
        {tab === 'balance' && <BalanceTab endLabel={last?.label ?? ''} />}
        {empty && tab !== 'balance' && (
          <div className="cv2-card" style={{ padding: '72px 24px', textAlign: 'center' }}>
            <Eyebrow>No data in range</Eyebrow>
            <h3 className="cv2-h3" style={{ margin: '12px auto', maxWidth: 420 }}>
              Nothing recorded for those dates.
            </h3>
            <p className="cv2-2" style={{ margin: 0 }}>
              The preview&rsquo;s mock ledger runs from 1 Nov 2025 to 11 Oct 2026. Pick a range
              inside it.
            </p>
          </div>
        )}
        {!empty && tab === 'revenue' && <RevenueTab months={months} />}
        {!empty && tab === 'pnl' && <PnlTab months={months} endLabel={last.label} />}
        {!empty && tab === 'cash' && <CashTab months={months} />}
      </main>
    </div>
  );
}
