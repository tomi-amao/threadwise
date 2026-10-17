import * as React from 'react';
import { useId } from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'phosphor-react';
import { Eyebrow } from '~/components/ui/eyebrow';
import { EM_ACCENT } from '~/components/ui/page-header';
import { cn } from '~/lib/utils';

/**
 * One dashboard section: mono eyebrow, a serif sentence as the heading (wrap a phrase in <em>
 * for the accent colour), an optional note, an optional action at the right. `band` shades
 * the section with the alt background so neighbouring sections separate without heavy rules.
 */
export function Section({
  eyebrow,
  title,
  note,
  action,
  band = false,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  note?: React.ReactNode;
  action?: React.ReactNode;
  band?: boolean;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn(band && 'border-y bg-muted/50')}>
      <div className="mx-auto w-full max-w-[1280px] px-5 py-16 sm:px-8 lg:px-16 lg:py-20">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-[680px]">
            <Eyebrow>{eyebrow}</Eyebrow>
            <h2
              id={headingId}
              className={cn('mt-3 font-serif text-[clamp(28px,3.2vw,40px)]', EM_ACCENT)}
            >
              {title}
            </h2>
            {note && <p className="mt-3 max-w-[560px] text-text-2">{note}</p>}
          </div>
          {action}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Quiet "see more" link with an arrow, used as a section action. */
export function SeeAll({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 rounded-sm text-[15px] text-foreground transition-colors hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ArrowRight size={14} weight="light" aria-hidden />
    </Link>
  );
}

/** Numbered column: mono 01/02, serif title with a full stop, grey explanatory text. */
export function NumberedColumn({
  n,
  title,
  value,
  children,
}: {
  n: string;
  title: string;
  value?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-t border-border-strong pt-4">
      <div className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground">{n}</div>
      <h3 className="mt-2 font-serif text-[26px]">{title}</h3>
      {value && <div className="mt-1 font-serif text-[32px] tabular-nums">{value}</div>}
      {children && <p className="mt-1 text-[15px] text-text-2">{children}</p>}
    </div>
  );
}
