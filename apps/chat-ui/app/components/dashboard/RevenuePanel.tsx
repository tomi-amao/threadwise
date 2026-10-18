import { useMemo, useState } from 'react';
import { BarChart } from '~/components/charts';
import { Panel, PanelLink } from '~/components/ui/panel';
import { Segmented } from '~/components/ui/segmented';
import type { MonthlyRevenue } from '~/types/dashboard';
import { money, monthLabel } from './format';

type Window = '6' | '12' | 'all';

export function RevenuePanel({ months, currency }: { months: MonthlyRevenue[]; currency: string }) {
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
  const total = shown.reduce((s, m) => s + m.revenue, 0);

  return (
    <Panel
      testId="panel-revenue"
      className="md:col-span-2 xl:col-span-8"
      title="Monthly gross revenue"
      note={
        best
          ? `${money(total, currency)} in window. ${monthLabel(best.month)} was strongest at ${money(best.revenue, currency)}.`
          : 'Revenue appears here once orders come in.'
      }
      action={
        <div className="flex items-center gap-4">
          {months.length > 0 && (
            <Segmented<Window>
              label="Chart window"
              value={window}
              onChange={setWindow}
              options={[
                { value: '6', label: '6m' },
                { value: '12', label: '12m' },
                { value: 'all', label: 'All' },
              ]}
            />
          )}
          <PanelLink to="/reports">Reports</PanelLink>
        </div>
      }
    >
      <BarChart
        ariaLabel="Monthly gross revenue"
        height={270}
        data={shown.map(m => ({ label: monthLabel(m.month), value: m.revenue }))}
        format={v => money(v, currency)}
      />
    </Panel>
  );
}
