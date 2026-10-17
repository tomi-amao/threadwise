import * as React from 'react';
import { cn } from '~/lib/utils';
import { Eyebrow } from './eyebrow';

/**
 * Two page headers; each page uses exactly one.
 *
 * `Hero`: for pages where one number or sentence is the point (Dashboard, Reports,
 *   Collections index, Landing). Big serif headline, lead paragraph, soft glow.
 * `CompactHeader`: for dense tool pages (Transactions, Inventory, Orders...). Eyebrow,
 *   a modest serif title and inline actions, so the table starts near the top.
 *
 * Wrap part of the title in <em> to colour it with the accent text colour.
 */
export const EM_ACCENT = '[&_em]:not-italic [&_em]:text-accent-text';
const EM = EM_ACCENT;

export function Hero({
  eyebrow,
  title,
  titleAs: Title = 'h1',
  lead,
  actions,
  className,
}: {
  titleAs?: 'h1' | 'h2';
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  lead?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('hero-glow px-5 pb-12 pt-16 sm:px-8 lg:px-16', className)}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <Title className={cn('mt-5 max-w-[820px] font-serif text-[clamp(38px,5vw,60px)]', EM)}>
        {title}
      </Title>
      {lead && <p className="mt-6 max-w-[540px] text-lg text-text-2">{lead}</p>}
      {actions && <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}

export function CompactHeader({
  eyebrow,
  title,
  titleAs: Title = 'h1',
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  titleAs?: 'h1' | 'h2';
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-end justify-between gap-4 px-5 pb-6 pt-8 sm:px-8 lg:px-16',
        className
      )}
    >
      <div className="min-w-0">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <Title className={cn('mt-2 font-serif text-[clamp(28px,3.4vw,40px)]', EM)}>{title}</Title>
        {description && <p className="mt-2 max-w-xl text-[15px] text-text-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}

/** Page frame: caps the width and gives headers and sections the same side gutters. */
export function Page({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-[1280px] pb-24', className)}>{children}</div>;
}

export function PageSection({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('px-5 sm:px-8 lg:px-16', className)} {...props}>
      {children}
    </section>
  );
}
