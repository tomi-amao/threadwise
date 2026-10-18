import * as React from 'react';
import { cn } from '~/lib/utils';

/**
 * A word or phrase with a definition behind it: dotted underline, and the explanation appears on
 * hover or keyboard focus. Accounting pages use it for every figure whose meaning depends on how it
 * is calculated, so the definition travels with the number instead of living in a manual.
 *
 * The definition is real text in the page (referenced by `aria-describedby`), so screen readers
 * read it with the term; the popup is only the visual treatment. Escape dismisses it.
 *
 *   <Term definition="Gross sales minus discounts and returns.">Net sales</Term>
 */
export function Term({
  children,
  definition,
  className,
  align = 'start',
}: {
  children: React.ReactNode;
  definition: React.ReactNode;
  className?: string;
  /** Which edge of the term the popup lines up with, so it stays on screen at the page edges. */
  align?: 'start' | 'end';
}) {
  const id = React.useId();
  const [dismissed, setDismissed] = React.useState(false);
  return (
    <span className={cn('group/term relative inline-block', className)}>
      <button
        type="button"
        aria-describedby={id}
        onKeyDown={e => {
          if (e.key === 'Escape') setDismissed(true);
        }}
        onBlur={() => setDismissed(false)}
        onMouseLeave={() => setDismissed(false)}
        className="cursor-help rounded-sm text-left [font:inherit] [letter-spacing:inherit] [text-transform:inherit] underline decoration-border-strong decoration-dotted underline-offset-[5px] transition-colors hover:decoration-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </button>
      <span
        id={id}
        role="tooltip"
        className={cn(
          // display:none (not just invisible) while hidden: an invisible popup near the right edge
          // still makes the page scroll sideways on a phone. aria-describedby can still point at it.
          'pointer-events-none absolute bottom-full z-50 mb-2 hidden w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border-strong bg-popover px-3.5 py-2.5 text-left text-[13px] font-normal normal-case leading-relaxed tracking-normal text-popover-foreground shadow-lg',
          align === 'start' ? 'left-0' : 'right-0',
          !dismissed && 'group-focus-within/term:block group-hover/term:block'
        )}
      >
        {definition}
      </span>
    </span>
  );
}
