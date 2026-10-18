import { ResponsivePie } from '@nivo/pie';
import { ChartTooltip } from './ChartTooltip';
import { CHART_COLORS, fullMoney, nivoTheme } from './theme';

export interface ShareDatum {
  id: string;
  label: string;
  value: number;
}

/** Donut with a legend table beside it, so no information depends on colour alone. */
export function ShareChart({
  data,
  ariaLabel,
  height = 200,
  format = fullMoney,
  stacked = false,
}: {
  data: ShareDatum[];
  ariaLabel: string;
  height?: number;
  format?: (value: number) => string;
  /** Put the legend under the donut. Use inside narrow cards, where side by side is cramped. */
  stacked?: boolean;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (data.length === 0 || total <= 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">No data for this period.</p>
    );
  }
  const color = (i: number) => CHART_COLORS[i % CHART_COLORS.length];

  return (
    <div
      className={
        stacked ? 'grid gap-5' : 'grid items-center gap-6 sm:grid-cols-[minmax(0,200px)_1fr]'
      }
    >
      <div
        style={{ height }}
        className={stacked ? 'mx-auto w-full max-w-[220px]' : 'w-full'}
        aria-hidden
      >
        <ResponsivePie
          data={data}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          innerRadius={0.62}
          padAngle={1.5}
          cornerRadius={4}
          colors={data.map((_, i) => color(i)) as unknown as string[]}
          borderWidth={0}
          enableArcLabels={false}
          enableArcLinkLabels={false}
          theme={nivoTheme}
          animate={false}
          tooltip={({ datum }) => (
            <ChartTooltip
              rows={[{ label: datum.label, value: format(datum.value), color: datum.color }]}
            />
          )}
        />
      </div>
      <dl className="grid gap-2 text-sm" aria-label={ariaLabel}>
        {data.map((d, i) => (
          <div key={d.id} className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2 text-text-2">
              <span aria-hidden className="size-2 rounded-sm" style={{ background: color(i) }} />
              {d.label}
            </dt>
            <dd className="tabular-nums">
              {format(d.value)}
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {Math.round((d.value / total) * 100)}%
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
