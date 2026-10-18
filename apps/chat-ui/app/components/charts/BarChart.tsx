import { useId } from 'react';
import { ResponsiveBar } from '@nivo/bar';
import { ChartSummary, ChartTooltip } from './ChartTooltip';
import { compactMoney, fullMoney, nivoTheme } from './theme';

export interface BarPoint {
  label: string;
  value: number;
}

/**
 * Single-series bars. The tallest bar is full amber and the rest sit one ramp step lighter,
 * so the peak reads at a glance without a legend.
 */
export function BarChart({
  data,
  ariaLabel,
  height = 260,
  format = fullMoney,
  axisFormat = compactMoney,
  highlightPeak = true,
}: {
  data: BarPoint[];
  /** What the chart shows, e.g. "Monthly gross revenue". */
  ariaLabel: string;
  height?: number;
  format?: (value: number) => string;
  axisFormat?: (value: number) => string;
  highlightPeak?: boolean;
}) {
  const summaryId = useId();
  if (data.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Nothing to chart for this period.
      </p>
    );
  }
  const peak = Math.max(...data.map(d => d.value));
  const rows = data.map(d => ({ ...d, peak: highlightPeak && d.value === peak ? 1 : 0 }));

  return (
    <div style={{ height }} className="w-full">
      <ChartSummary id={summaryId}>
        {ariaLabel}: {data.map(d => `${d.label} ${format(d.value)}`).join(', ')}.
      </ChartSummary>
      <ResponsiveBar
        data={rows}
        keys={['value']}
        indexBy="label"
        margin={{ top: 12, right: 8, bottom: data.length > 8 ? 48 : 32, left: 48 }}
        padding={0.35}
        borderRadius={4}
        colors={({ data: d }) =>
          d.peak ? 'var(--ramp-1)' : highlightPeak ? 'var(--ramp-3)' : 'var(--ramp-1)'
        }
        enableLabel={false}
        enableGridX={false}
        gridYValues={4}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          tickValues: 4,
          format: v => axisFormat(Number(v)),
        }}
        axisBottom={{ tickSize: 0, tickPadding: 8, tickRotation: data.length > 8 ? -45 : 0 }}
        theme={nivoTheme}
        animate={false}
        role="img"
        ariaLabel={ariaLabel}
        ariaDescribedBy={summaryId}
        tooltip={({ indexValue, value }) => (
          <ChartTooltip
            title={String(indexValue)}
            rows={[{ label: 'Total', value: format(Number(value)) }]}
          />
        )}
      />
    </div>
  );
}
