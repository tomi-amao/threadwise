import * as React from 'react';
import { cn } from '~/lib/utils';

/**
 * Small status label. Amber (`active`) is reserved for live/active state; money in uses
 * `income`; problems use `negative`. Never rely on colour alone: each chip carries text.
 */
const TONES = {
  active: 'border-transparent bg-accent-tint text-accent-text',
  planned: 'border-transparent bg-plum-tint text-text-2',
  done: 'border-border text-text-2',
  draft: 'border-dashed border-border-strong text-muted-foreground',
  // Solid mix rather than a transparent tint: on a hovered table row a translucent fill picks up
  // the row's amber and drops below 4.5:1 (found by the Inventory axe scan).
  negative:
    'border-transparent bg-[color-mix(in_srgb,var(--destructive)_15%,var(--card))] text-destructive',
  income: 'border-transparent bg-plum-tint text-income',
  plain: 'border-border text-text-2',
} as const;

export type ChipTone = keyof typeof TONES;

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  /** Leading status dot. */
  dot?: boolean;
}

export function Chip({ tone = 'plain', dot = false, className, children, ...props }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase leading-relaxed tracking-[0.06em]',
        TONES[tone],
        className
      )}
      {...props}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
