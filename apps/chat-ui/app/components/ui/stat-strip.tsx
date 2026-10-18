import * as React from 'react';
import { cn } from '~/lib/utils';
import { Eyebrow } from './eyebrow';

/** Four numbers in one hairline-divided band. Collapses to 2 columns on narrow screens. */
export function StatStrip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border lg:grid-cols-4',
        className
      )}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  title,
  caption,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  /** Short bold line under the number. */
  title?: React.ReactNode;
  /** Muted line with the sample size or source. */
  caption?: React.ReactNode;
  tone?: 'default' | 'negative' | 'income';
}) {
  return (
    <div className="min-w-0 bg-card px-6 py-6">
      <Eyebrow>{label}</Eyebrow>
      <div
        className={cn(
          'mt-2.5 font-serif text-[clamp(28px,3.4vw,44px)] tabular-nums',
          tone === 'negative' && 'text-destructive',
          tone === 'income' && 'text-income'
        )}
      >
        {value}
      </div>
      {title && <div className="mt-2 text-sm font-semibold">{title}</div>}
      {caption && <div className="mt-0.5 text-[13px] text-muted-foreground">{caption}</div>}
    </div>
  );
}
