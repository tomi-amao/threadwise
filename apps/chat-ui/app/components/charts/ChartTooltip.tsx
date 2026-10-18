import * as React from 'react';

/** One tooltip look for every chart: card surface, hairline border, mono caption. */
export function ChartTooltip({
  title,
  rows,
}: {
  title?: React.ReactNode;
  rows: { label: React.ReactNode; value: React.ReactNode; color?: string }[];
}) {
  return (
    <div className="min-w-[140px] rounded-xl border border-border-strong bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      {title && <div className="eyebrow mb-1.5">{title}</div>}
      <div className="grid gap-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-text-2">
              {r.color && (
                <span aria-hidden className="size-2 rounded-sm" style={{ background: r.color }} />
              )}
              {r.label}
            </span>
            <span className="font-medium tabular-nums">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Text alternative for a chart: read by screen readers, invisible on screen. */
export function ChartSummary({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="sr-only">
      {children}
    </p>
  );
}
