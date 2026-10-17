import * as React from 'react';
import { cn } from '~/lib/utils';

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode }[];
  /** Accessible name for the group. */
  label: string;
  className?: string;
}

/** Pill group for filters and sort orders. Scrolls sideways inside itself on narrow screens. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-border-strong bg-card p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
    >
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === o.value
              ? 'bg-foreground text-background'
              : 'text-text-2 hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
