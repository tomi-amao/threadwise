import { ResponsivePie } from '@nivo/pie';

export interface PieChartProps {
  title: string;
  data: Array<{
    id: string;
    label: string;
    value: number;
    color?: string;
  }>;
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

export function PieChartViz({ title, data, format = 'number' }: PieChartProps) {
  return (
    <div className="w-full bg-neutral-900 rounded-lg p-6 border border-neutral-800">
      <h3 className="text-lg font-semibold text-white mb-4">{title}</h3>
      <div className="h-[400px] w-full">
        <ResponsivePie
          data={data}
          margin={{ top: 40, right: 120, bottom: 80, left: 120 }}
          innerRadius={0.5}
          padAngle={0.7}
          cornerRadius={3}
          activeOuterRadiusOffset={8}
          borderWidth={1}
          borderColor={{
            from: 'color',
            modifiers: [['darker', 0.2]],
          }}
          colors={{ scheme: 'nivo' }}
          arcLinkLabelsSkipAngle={10}
          arcLinkLabelsTextColor="#d4d4d4"
          arcLinkLabelsThickness={2}
          arcLinkLabelsColor={{ from: 'color' }}
          arcLabelsSkipAngle={10}
          arcLabelsTextColor={{
            from: 'color',
            modifiers: [['darker', 2]],
          }}
          valueFormat={(value) => formatValue(value, format)}
          tooltip={({ datum }) => (
            <div className="bg-neutral-800 px-3 py-2 rounded shadow-lg border border-neutral-700">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded"
                  style={{ backgroundColor: datum.color }}
                />
                <span className="text-white font-medium">{datum.label}</span>
              </div>
              <div className="text-neutral-300 text-sm mt-1">
                {formatValue(datum.value, format)} ({datum.formattedValue})
              </div>
            </div>
          )}
          legends={[
            {
              anchor: 'bottom',
              direction: 'row',
              justify: false,
              translateX: 0,
              translateY: 56,
              itemsSpacing: 0,
              itemWidth: 100,
              itemHeight: 18,
              itemTextColor: '#d4d4d4',
              itemDirection: 'left-to-right',
              itemOpacity: 1,
              symbolSize: 18,
              symbolShape: 'circle',
            },
          ]}
          theme={{
            labels: {
              text: { fill: '#ffffff' },
            },
            legends: {
              text: { fill: '#d4d4d4' },
            },
          }}
        />
      </div>
    </div>
  );
}
