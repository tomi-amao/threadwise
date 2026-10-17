import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { BarChart } from '~/components/charts';
import { CHART_COLORS } from '~/components/charts';
import { EmptyState } from '~/components/ui/empty-state';
import { Eyebrow } from '~/components/ui/eyebrow';
import { Segmented } from '~/components/ui/segmented';
import type { KPIData, MonthlyRevenue, OrderStatusBreakdown } from '~/types/dashboard';
import { Section, SeeAll } from './Section';
import { int, money, monthLabel, pct, share, titleCase } from './format';

type Window = '6' | '12' | 'all';

export function RevenueSection({
  months,
  statuses,
  kpis,
  currency,
}: {
  months: MonthlyRevenue[];
  statuses: OrderStatusBreakdown[];
  kpis: KPIData;
  currency: string;
}) {
  const [window, setWindow] = useState<Window>('12');
  const shown = useMemo(
    () => (window === 'all' ? months : months.slice(-Number(window))),
    [months, window]
  );
  const best = useMemo(
    () =>
      shown.reduce<MonthlyRevenue | null>((a, m) => (!a || m.revenue > a.revenue ? m : a), null),
    [shown]
  );
  const windowTotal = shown.reduce((s, m) => s + m.revenue, 0);

  const feeShare = share(kpis.processingFees, kpis.grossRevenue);
  const refundShare = share(kpis.totalRefunds, kpis.grossRevenue);

  return (
    <Section
      eyebrow="Revenue"
      title={
        <>
          Money in, <em>and what stays.</em>
        </>
      }
      note={
        kpis.grossRevenue > 0
          ? `Fees take ${pct(feeShare, 1)} of gross and refunds ${pct(refundShare, 1)}.${best ? ` ${monthLabel(best.month)} was the strongest month at ${money(best.revenue, currency)}.` : ''}`
          : 'Revenue appears here once orders come in.'
      }
      action={
        months.length > 0 && (
          <Segmented<Window>
            label="Chart window"
            value={window}
            onChange={setWindow}
            options={[
              { value: '6', label: '6 months' },
              { value: '12', label: '12 months' },
              { value: 'all', label: 'All' },
            ]}
          />
        )
      }
    >
      <div className="grid items-start gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="min-w-0 rounded-2xl border bg-card p-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <Eyebrow>Monthly gross revenue</Eyebrow>
            <span className="font-mono text-[13px] text-text-2">
              {money(windowTotal, currency)} in window
            </span>
          </div>
          <BarChart
            ariaLabel="Monthly gross revenue"
            data={shown.map(m => ({ label: monthLabel(m.month), value: m.revenue }))}
            format={v => money(v, currency)}
          />
          <div className="mt-4">
            <SeeAll to="/reports">Open reports</SeeAll>
          </div>
        </div>

        <div className="min-w-0 rounded-2xl border bg-card p-6">
          <Eyebrow>Orders by status</Eyebrow>
          {statuses.length === 0 ? (
            <EmptyState className="py-10" title="No orders yet." />
          ) : (
            <>
              <div className="mt-2.5 font-serif text-4xl tabular-nums">{int(kpis.totalOrders)}</div>
              <div
                className="mb-5 mt-4 flex h-3 gap-0.5 overflow-hidden rounded-full bg-border"
                aria-hidden
              >
                {statuses.map((s, i) => (
                  <span
                    key={s.status}
                    title={`${titleCase(s.status)}: ${s.count}`}
                    className="h-full min-w-[3px]"
                    style={{ flexGrow: s.count, background: CHART_COLORS[i % CHART_COLORS.length] }}
                  />
                ))}
              </div>
              <dl className="divide-y">
                {statuses.map((s, i) => (
                  <div key={s.status} className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="flex items-center gap-2.5 text-text-2">
                      <span
                        aria-hidden
                        className="size-2 rounded-sm"
                        style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      {titleCase(s.status)}
                    </dt>
                    <dd className="tabular-nums">
                      {int(s.count)}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {pct(share(s.count, kpis.totalOrders))}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4">
                <SeeAll to="/orders">All orders</SeeAll>
              </div>
            </>
          )}
        </div>
      </div>
      {months.length === 0 && (
        <p className="mt-6 text-sm text-text-2">
          Nothing to chart yet.{' '}
          <Link to="/integrations" className="underline underline-offset-4 hover:text-accent-text">
            Connect a store
          </Link>{' '}
          to start.
        </p>
      )}
    </Section>
  );
}
