import * as React from 'react';
import { cn } from '~/lib/utils';

/**
 * Card-framed table that scrolls sideways inside itself instead of widening the page
 * (the bug every preview hit at phone width). Pass a plain <table> body:
 *
 *   <DataTable><thead>…</thead><tbody>…</tbody></DataTable>
 *
 * Right-align numeric columns with `className="text-right"` on both <th> and <td>.
 *
 * The scroll container is focusable and named so keyboard users can scroll it when it
 * overflows (axe: scrollable-region-focusable). `label` names the table for them.
 */
export function DataTable({
  label,
  bare = false,
  dense = false,
  surface = 'card',
  className,
  children,
}: {
  /** Accessible name, e.g. "Collections". */
  label: string;
  /** No border or background: for a table that sits inside a Panel, which supplies the card. */
  bare?: boolean;
  /** Tighter rows, for tables that share a screen with other panels. */
  dense?: boolean;
  /**
   * 'page': rows sit on the page's own background (a faint warm white in light mode) and the header is an
   * amber-tinted band, so it reads as a header. The parent supplies the frame.
   */
  surface?: 'card' | 'page';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        'overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        bare ? 'focus-visible:ring-inset' : 'rounded-[var(--radius)] border bg-card',
        className
      )}
    >
      <table
        className={cn(
          'w-full border-collapse text-[15px]',
          dense ? '[&_th]:py-2.5 [&_td]:py-2.5' : '[&_th]:py-3.5 [&_td]:py-4',
          '[&_th]:whitespace-nowrap [&_th]:border-b [&_th]:px-4 [&_th]:font-mono [&_th]:text-xs [&_th]:font-normal [&_th]:uppercase [&_th]:tracking-[0.08em] [&_th]:text-muted-foreground',
          '[&_th:not([class*=text-right])]:text-left',
          surface === 'page' &&
            '[&_th]:border-b-border-strong [&_th]:bg-card [&_th]:bg-[linear-gradient(var(--accent-tint),var(--accent-tint))] [&_th]:text-accent-text',
          '[&_td]:border-b [&_td]:px-4 [&_td]:align-middle',
          '[&_th:first-child]:pl-6 [&_td:first-child]:pl-6 [&_th:last-child]:pr-6 [&_td:last-child]:pr-6',
          '[&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover_td]:bg-accent',
          '[&_tfoot_td]:border-b-0 [&_tfoot_td]:border-t [&_tfoot_td]:border-t-foreground [&_tfoot_td]:font-medium'
        )}
      >
        {children}
      </table>
    </div>
  );
}
