import type React from 'react';
import { InfoTooltip } from '~/components/ui/InfoTooltip';

export function KPICard({
  title,
  value,
  icon,
  iconColor,
  tooltip,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  iconColor: string;
  tooltip: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between mb-2">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${iconColor}`}>
          {icon}
        </div>
        <InfoTooltip text={tooltip} />
      </div>
      <p className="text-xs text-muted-foreground mb-0.5">{title}</p>
      <p className="text-xl font-bold text-foreground tracking-tight">{value}</p>
    </div>
  );
}
