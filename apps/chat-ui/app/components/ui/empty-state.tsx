import * as React from 'react';
import { cn } from '~/lib/utils';
import { Eyebrow } from './eyebrow';

export function EmptyState({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('px-6 py-16 text-center', className)}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h3 className="mx-auto mt-3 max-w-md font-serif text-2xl">{title}</h3>
      {description && <p className="mx-auto mt-2 max-w-md text-text-2">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
