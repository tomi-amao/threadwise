import { cn } from '~/lib/utils';

/** Thin progress bar. `value` is 0 to 1. `over` switches to the problem colour. */
export function Meter({
  value,
  over = false,
  label,
  className,
}: {
  value: number;
  over?: boolean;
  /** Accessible description, e.g. "62% of budget used". */
  label?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role={label ? 'meter' : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label ? Math.round(pct) : undefined}
      aria-hidden={label ? undefined : true}
      className={cn('h-1.5 overflow-hidden rounded-full bg-border', className)}
    >
      <span
        className={cn(
          'block h-full rounded-full transition-[width]',
          over ? 'bg-destructive' : 'bg-primary'
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
