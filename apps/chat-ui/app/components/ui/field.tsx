import * as React from 'react';
import { cn } from '~/lib/utils';

/** Label (mono eyebrow style) + control + optional hint, wired together for screen readers. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  /** A single form control. It receives `id` and `aria-describedby`. */
  children: React.ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = React.useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="eyebrow">
        {label}
      </label>
      {React.cloneElement(children, { id, 'aria-describedby': hintId })}
      {hint && (
        <span id={hintId} className="text-[13px] text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}
