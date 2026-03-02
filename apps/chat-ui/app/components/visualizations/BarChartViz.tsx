import { ResponsiveBar } from '@nivo/bar';

export interface BarChartProps {
  title: string;
  data: Array<{
    id: string;
    label: string;
    value: number;
    color?: string;
  }>;
  xAxisLabel?: string;
  yAxisLabel?: string;
  format?: 'currency' | 'number' | 'percentage';
}

const formatValue = (value: number, format?: 'currency' | 'number' | 'percentage') => {
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(value);
    case 'percentage':
      return `${value.toFixed(1)}%`;
    case 'number':
    default:
      return new Intl.NumberFormat('en-US').format(value);
  }
};

export function BarChartViz({ title, data, xAxisLabel, yAxisLabel, format = 'number' }: BarChartProps) {
  // Transform data for Nivo
  const chartData = data.map((item) => ({
    id: item.id,
    label: item.label,
    value: item.value,
    ...(item.color && { color: item.color }),
  }));

  return (
    <div className="w-full bg-neutral-900 rounded-lg p-6 border border-neutral-800">
      <h3 className="text-lg font-semibold text-white mb-4">{title}</h3>
      <div className="h-[400px] w-full">
        <ResponsiveBar
          data={chartData}
          keys={['value']}
          indexBy="label"
          margin={{ top: 20, right: 30, bottom: 80, left: 80 }}
          padding={0.3}
          valueScale={{ type: 'linear' }}
          indexScale={{ type: 'band', round: true }}
          colors={{ scheme: 'nivo' }}
          borderColor={{
            from: 'color',
            modifiers: [['darker', 1.6]],
          }}
          axisTop={null}
          axisRight={null}
          axisBottom={{
            tickSize: 5,
            tickPadding: 5,
            tickRotation: -45,
            legend: xAxisLabel,
            legendPosition: 'middle',
            legendOffset: 60,
          }}
          axisLeft={{
            tickSize: 5,
            tickPadding: 5,
            tickRotation: 0,
            legend: yAxisLabel,
            legendPosition: 'middle',
            legendOffset: -60,
            format: (value) => formatValue(value, format),
          }}
          labelSkipWidth={12}
          labelSkipHeight={12}
          labelTextColor={{
            from: 'color',
            modifiers: [['darker', 1.6]],
          }}
          tooltip={({ indexValue, value, color }) => (
            <div className="bg-neutral-800 px-3 py-2 rounded shadow-lg border border-neutral-700">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded"
                  style={{ backgroundColor: color }}
                />
                <span className="text-white font-medium">{indexValue}</span>
              </div>
              <div className="text-neutral-300 text-sm mt-1">
                {formatValue(value, format)}
              </div>
            </div>
          )}
          theme={{
            axis: {
              ticks: {
                text: { fill: '#a3a3a3' },
              },
              legend: {
                text: { fill: '#d4d4d4', fontSize: 12 },
              },
            },
            grid: {
              line: {
                stroke: '#404040',
                strokeWidth: 1,
              },
            },
            labels: {
              text: { fill: '#ffffff' },
            },
          }}
          role="img"
          ariaLabel={`Bar chart: ${title}`}
        />
      </div>
    </div>
  );
}
