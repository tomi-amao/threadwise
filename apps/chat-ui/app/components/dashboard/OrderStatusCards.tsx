import {
  CheckCircle,
  Clock,
  XCircle,
  ArrowsClockwise,
  Package,
  Truck,
} from 'phosphor-react';
import type { OrderStatusBreakdown } from '~/types/dashboard';

interface OrderStatusCardsProps {
  statuses: OrderStatusBreakdown[];
  totalOrders: number;
}

const statusConfig: Record<string, { icon: React.ReactNode; color: string }> = {
  delivered: {
    icon: <CheckCircle size={18} weight="duotone" />,
    color: 'text-emerald-500 bg-emerald-500/10',
  },
  paid: {
    icon: <CheckCircle size={18} weight="duotone" />,
    color: 'text-emerald-500 bg-emerald-500/10',
  },
  pending: {
    icon: <Clock size={18} weight="duotone" />,
    color: 'text-amber-500 bg-amber-500/10',
  },
  processing: {
    icon: <ArrowsClockwise size={18} weight="duotone" />,
    color: 'text-blue-500 bg-blue-500/10',
  },
  shipped: {
    icon: <Truck size={18} weight="duotone" />,
    color: 'text-blue-500 bg-blue-500/10',
  },
  cancelled: {
    icon: <XCircle size={18} weight="duotone" />,
    color: 'text-neutral-400 bg-neutral-500/10',
  },
  refunded: {
    icon: <ArrowsClockwise size={18} weight="duotone" />,
    color: 'text-rose-500 bg-rose-500/10',
  },
  partially_refunded: {
    icon: <ArrowsClockwise size={18} weight="duotone" />,
    color: 'text-orange-500 bg-orange-500/10',
  },
};

const defaultConfig = {
  icon: <Package size={18} weight="duotone" />,
  color: 'text-muted-foreground bg-muted',
};

export function OrderStatusCards({ statuses, totalOrders }: OrderStatusCardsProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-foreground">Order Status</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {totalOrders.toLocaleString('en-GB')} total orders
        </p>
      </div>

      <div className="space-y-3">
        {statuses.map((s) => {
          const config = statusConfig[s.status] || defaultConfig;
          const pct = totalOrders > 0 ? (s.count / totalOrders) * 100 : 0;
          const label = s.status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

          return (
            <div key={s.status} className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${config.color}`}>
                {config.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-foreground">{label}</span>
                  <span className="text-xs text-muted-foreground">
                    {s.count} ({pct.toFixed(0)}%)
                  </span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: config.color.includes('emerald')
                        ? 'rgb(16 185 129)'
                        : config.color.includes('amber')
                          ? 'rgb(245 158 11)'
                          : config.color.includes('blue')
                            ? 'rgb(59 130 246)'
                            : config.color.includes('rose')
                              ? 'rgb(244 63 94)'
                              : config.color.includes('orange')
                                ? 'rgb(249 115 22)'
                                : 'rgb(163 163 163)',
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
