import * as React from 'react';
import { CaretDown } from 'phosphor-react';
import { cn } from '~/lib/utils';

/**
 * A styled native <select>. Use for short, fixed option lists (type, source, status): the
 * browser's own control is the most accessible and works well on touch. For long or searchable
 * lists use SearchableSelect.
 */
export interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Required: there is no visible label, so the control needs a name. */
  'aria-label': string;
  /** Pill (filter bars) or rounded rectangle (forms). */
  shape?: 'pill' | 'field';
}

export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, shape = 'pill', children, ...props }, ref) => (
    <div className="relative inline-flex">
      <select
        ref={ref}
        className={cn(
          'h-10 w-full appearance-none border border-border-strong bg-card py-2 pl-4 pr-9 text-[15px] text-foreground transition-colors hover:border-ring focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-tint disabled:opacity-50',
          shape === 'pill' ? 'rounded-full' : 'rounded-xl',
          className
        )}
        {...props}
      >
        {children}
      </select>
      <CaretDown
        size={13}
        weight="light"
        aria-hidden
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  )
);
NativeSelect.displayName = 'NativeSelect';
