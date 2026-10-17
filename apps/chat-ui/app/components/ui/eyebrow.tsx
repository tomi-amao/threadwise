import * as React from 'react';
import { cn } from '~/lib/utils';

/** Uppercase mono label that opens every section. */
export function Eyebrow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('eyebrow', className)} {...props} />;
}
