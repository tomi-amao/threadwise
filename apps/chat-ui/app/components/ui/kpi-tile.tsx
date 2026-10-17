import * as React from 'react';
import { cn } from '~/lib/utils';
import { Eyebrow } from './eyebrow';
import { Sparkline } from './sparkline';

/**
 * A single headline number for a dashboard row: mono label, serif value, one line of context,
 * and an optional sparkline. Sized to sit six across on a wide screen.
 */
export function KpiTile({
  label,
  value,
  caption,
  trend,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  caption?: React.ReactNode;
  /** Values over time, oldest first. Omit for a tile with no trend. */
  trend?: number[];
  tone?: 'default' | 'negative';
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border bg-card px-5 py-4">
      <Eyebrow>{label}</Eyebrow>
      <div
        className={cn(
          'mt-2 min-w-0 truncate font-serif text-[clamp(24px,2.1vw,32px)] tabular-nums',
          tone === 'negative' && 'text-destructive'
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 truncate text-[13px] text-muted-foreground">{caption}</div>
      {trend && <Sparkline data={trend} width={120} height={22} fluid className="mt-2.5" />}
    </div>
  );
}
