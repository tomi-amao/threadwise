import { useId } from 'react';
import { ResponsiveLine } from '@nivo/line';
import { ChartSummary, ChartTooltip } from './ChartTooltip';
import { CHART_COLORS, compactMoney, fullMoney, nivoTheme } from './theme';

export interface LineSeries {
  id: string;
  data: { x: string; y: number }[];
}

/** Multi-series lines: amber first, plum second. Includes a legend only when there is more than one series. */
export function LineChart({
  series,
  ariaLabel,
  height = 280,
  format = fullMoney,
  axisFormat = compactMoney,
}: {
  series: LineSeries[];
  ariaLabel: string;
  height?: number;
  format?: (value: number) => string;
  axisFormat?: (value: number) => string;
}) {
  const summaryId = useId();
  const points = series[0]?.data.length ?? 0;
  if (points === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Nothing to chart for this period.
      </p>
    );
  }
  const colors = CHART_COLORS.slice(0, series.length) as unknown as string[];

  return (
    <div className="w-full">
      {series.length > 1 && (
        <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-text-2" aria-hidden>
          {series.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2">
              <span className="h-[3px] w-3.5 rounded-sm" style={{ background: colors[i] }} />
              {s.id}
            </li>
          ))}
        </ul>
      )}
      <div style={{ height }}>
        <ChartSummary id={summaryId}>
          {ariaLabel}:{' '}
          {series
            .map(s => `${s.id}: ${s.data.map(p => `${p.x} ${format(p.y)}`).join(', ')}`)
            .join('. ')}
          .
        </ChartSummary>
        <ResponsiveLine
          data={series}
          margin={{ top: 12, right: 12, bottom: 32, left: 48 }}
          xScale={{ type: 'point' }}
          yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
          curve="monotoneX"
          colors={colors}
          lineWidth={2}
          pointSize={6}
          pointColor={{ from: 'color' }}
          pointBorderWidth={2}
          pointBorderColor="var(--card)"
          enableGridX={false}
          gridYValues={4}
          axisLeft={{
            tickSize: 0,
            tickPadding: 8,
            tickValues: 4,
            format: v => axisFormat(Number(v)),
          }}
          axisBottom={{ tickSize: 0, tickPadding: 8, tickRotation: points > 8 ? -45 : 0 }}
          theme={nivoTheme}
          animate={false}
          useMesh
          role="img"
          ariaLabel={ariaLabel}
          ariaDescribedBy={summaryId}
          tooltip={({ point }) => (
            <ChartTooltip
              title={String(point.data.x)}
              rows={[
                {
                  label: String(point.seriesId),
                  value: format(Number(point.data.y)),
                  color: point.seriesColor,
                },
              ]}
            />
          )}
        />
      </div>
    </div>
  );
}
