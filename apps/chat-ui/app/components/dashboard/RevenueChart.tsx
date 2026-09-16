import { ResponsiveLine } from '@nivo/line';
import { Link } from 'react-router';
import { ArrowSquareOut } from 'phosphor-react';
import type { MonthlyRevenue } from '~/types/dashboard';

interface RevenueChartProps {
  data: MonthlyRevenue[];
  currency?: string;
}

const formatCurrency = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

const formatMonth = (month: string) => {
  const [year, m] = month.split('-');
  const date = new Date(Number(year), Number(m) - 1);
  return date.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
};

export function RevenueChart({ data, currency = 'GBP' }: RevenueChartProps) {
  // Show last 12 months max for readability
  const chartData = data.slice(-12);

  const lineData = [
    {
      id: 'Revenue',
      data: chartData.map((d) => ({
        x: formatMonth(d.month),
        y: d.revenue,
      })),
    },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Revenue Trend</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Monthly gross revenue</p>
        </div>
        <Link
          to="/reports"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        >
          View reports <ArrowSquareOut size={12} />
        </Link>
      </div>
      <div className="h-[280px] w-full">
        {chartData.length > 0 ? (
          <ResponsiveLine
            data={lineData}
            margin={{ top: 10, right: 20, bottom: 50, left: 60 }}
            xScale={{ type: 'point' }}
            yScale={{ type: 'linear', min: 'auto', max: 'auto' }}
            yFormat={(value) => formatCurrency(Number(value), currency)}
            axisBottom={{
              tickSize: 0,
              tickPadding: 8,
              tickRotation: -45,
            }}
            axisLeft={{
              tickSize: 0,
              tickPadding: 8,
              format: (value) =>
                `£${Number(value) >= 1000 ? `${(Number(value) / 1000).toFixed(0)}k` : value}`,
            }}
            colors={['hsl(var(--primary))']}
            lineWidth={2.5}
            pointSize={6}
            pointColor="hsl(var(--card))"
            pointBorderWidth={2}
            pointBorderColor="hsl(var(--primary))"
            enableArea
            areaBaselineValue={0}
            areaOpacity={0.08}
            enableGridX={false}
            gridYValues={5}
            curve="monotoneX"
            theme={{
              text: { fill: 'hsl(var(--muted-foreground))' },
              axis: {
                ticks: { text: { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } },
              },
              grid: { line: { stroke: 'hsl(var(--border))', strokeWidth: 1 } },
              crosshair: { line: { stroke: 'hsl(var(--primary))', strokeOpacity: 0.3 } },
            }}
            tooltip={({ point }) => (
              <div className="bg-popover text-popover-foreground border border-border rounded-lg px-3 py-2 shadow-lg text-xs">
                <p className="font-medium">{point.data.xFormatted}</p>
                <p className="text-primary font-semibold">{point.data.yFormatted}</p>
              </div>
            )}
            useMesh
          />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            No revenue data available
          </div>
        )}
      </div>
    </div>
  );
}
