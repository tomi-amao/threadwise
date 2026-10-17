import * as React from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'phosphor-react';
import { cn } from '~/lib/utils';

/**
 * A dashboard panel: card with a mono title, an optional action at the right, and a body.
 * `flush` removes body padding for a full-bleed table (use `<DataTable bare>` inside).
 * The title is a real <h2>, so the page has a heading outline without making every panel a
 * landmark (a screen full of landmarks is noise).
 */
export function Panel({
  title,
  action,
  note,
  flush = false,
  testId,
  className,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  /** One muted line under the title: the "so what" of the panel. */
  note?: React.ReactNode;
  flush?: boolean;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn('flex min-w-0 flex-col rounded-2xl border bg-card', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-6 pb-3 pt-5 sm:flex-nowrap">
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="eyebrow">{title}</h2>
          {note && <p className="mt-1.5 text-[13px] text-text-2">{note}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={cn('min-w-0 flex-1', !flush && 'px-6 pb-5')}>{children}</div>
    </div>
  );
}

/** Small "see more" link for a panel header. */
export function PanelLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 rounded-sm text-[13px] text-text-2 transition-colors hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowRight size={12} weight="light" aria-hidden />
    </Link>
  );
}
