export interface FinancialTableProps {
  title: string;
  data: {
    headers: string[];
    rows: Array<{
      label: string;
      values: (string | number)[];
      isTotal?: boolean;
      indent?: number;
    }>;
  };
  format?: 'currency' | 'number' | 'percentage';
}

const formatValue = (value: string | number, format?: 'currency' | 'number' | 'percentage') => {
  if (typeof value === 'string') return value;
  
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

export function FinancialTableViz({ title, data, format = 'currency' }: FinancialTableProps) {
  return (
    <div className="w-full bg-neutral-900 rounded-lg p-6 border border-neutral-800">
      <h3 className="text-lg font-semibold text-white mb-4">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-700">
              <th className="text-left py-3 px-4 text-neutral-300 font-medium">
                {data.headers[0]}
              </th>
              {data.headers.slice(1).map((header, idx) => (
                <th key={idx} className="text-right py-3 px-4 text-neutral-300 font-medium">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={`
                  border-b border-neutral-800 
                  ${row.isTotal ? 'font-semibold border-t-2 border-neutral-600' : 'font-normal'}
                  hover:bg-neutral-800/50 transition-colors
                `}
              >
                <td
                  className={`py-3 px-4 text-white ${row.isTotal ? 'font-semibold' : ''}`}
                  style={{ paddingLeft: `${(row.indent || 0) * 1.5 + 1}rem` }}
                >
                  {row.label}
                </td>
                {row.values.map((value, valIdx) => (
                  <td
                    key={valIdx}
                    className={`
                      py-3 px-4 text-right 
                      ${row.isTotal ? 'text-white font-semibold' : 'text-neutral-300'}
                      ${typeof value === 'number' && value < 0 ? 'text-red-400' : ''}
                    `}
                  >
                    {formatValue(value, format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
