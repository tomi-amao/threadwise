import { ResponsiveLine } from '@nivo/line';

export interface LineChartProps {
  title: string;
  data: Array<{
    id: string;
    data: Array<{
      x: string | number;
      y: number;
    }>;
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

export function LineChartViz({ title, data, xAxisLabel, yAxisLabel, format = 'number' }: LineChartProps) {
  return (
    <div className="w-full bg-neutral-900 rounded-lg p-6 border border-neutral-800">
      <h3 className="text-lg font-semibold text-white mb-4">{title}</h3>
      <div className="h-[400px] w-full">
        <ResponsiveLine
          data={data}
          margin={{ top: 20, right: 30, bottom: 80, left: 80 }}
          xScale={{ type: 'point' }}
          yScale={{
            type: 'linear',
            min: 'auto',
            max: 'auto',
            stacked: false,
            reverse: false,
          }}
          yFormat={(value) => formatValue(Number(value), format)}
          axisTop={null}
          axisRight={null}
          axisBottom={{
            tickSize: 5,
            tickPadding: 5,
            tickRotation: -45,
            legend: xAxisLabel,
            legendOffset: 60,
            legendPosition: 'middle',
          }}
          axisLeft={{
            tickSize: 5,
            tickPadding: 5,
            tickRotation: 0,
            legend: yAxisLabel,
            legendOffset: -60,
            legendPosition: 'middle',
            format: (value) => formatValue(value, format),
          }}
          pointSize={8}
          pointColor={{ theme: 'background' }}
          pointBorderWidth={2}
          pointBorderColor={{ from: 'serieColor' }}
          pointLabelYOffset={-12}
          useMesh={true}
          colors={{ scheme: 'nivo' }}
          enableArea={true}
          areaOpacity={0.1}
          tooltip={({ point }) => (
            <div className="bg-neutral-800 px-3 py-2 rounded shadow-lg border border-neutral-700">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: point.color }}
                />
                <span className="text-white font-medium">{point.seriesId}</span>
              </div>
              <div className="text-neutral-300 text-sm mt-1">
                {point.data.xFormatted}: {formatValue(Number(point.data.y), format)}
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
          }}
          role="img"
          ariaLabel={`Line chart: ${title}`}
        />
      </div>
    </div>
  );
}
