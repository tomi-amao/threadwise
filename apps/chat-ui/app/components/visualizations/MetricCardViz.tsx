import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export interface MetricCardProps {
  title: string;
  value: number;
  format?: 'currency' | 'number' | 'percentage';
  trend?: {
    direction: 'up' | 'down' | 'neutral';
    value: number;
    period: string;
  };
  description?: string;
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

export function MetricCardViz({ title, value, format = 'currency', trend, description }: MetricCardProps) {
  const getTrendColor = (direction: 'up' | 'down' | 'neutral') => {
    switch (direction) {
      case 'up':
        return 'text-green-400';
      case 'down':
        return 'text-red-400';
      case 'neutral':
      default:
        return 'text-neutral-400';
    }
  };

  const TrendIcon = trend?.direction === 'up' 
    ? TrendingUp 
    : trend?.direction === 'down' 
    ? TrendingDown 
    : Minus;

  return (
    <div className="bg-neutral-900 rounded-lg p-6 border border-neutral-800 hover:border-neutral-700 transition-colors">
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-neutral-400 uppercase tracking-wide">
          {title}
        </h3>
        <div className="text-3xl font-bold text-white">
          {formatValue(value, format)}
        </div>
        {trend && (
          <div className={`flex items-center gap-1 text-sm ${getTrendColor(trend.direction)}`}>
            <TrendIcon className="w-4 h-4" />
            <span>{formatValue(trend.value, 'percentage')}</span>
            <span className="text-neutral-500">{trend.period}</span>
          </div>
        )}
        {description && (
          <p className="text-sm text-neutral-400 mt-2">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
