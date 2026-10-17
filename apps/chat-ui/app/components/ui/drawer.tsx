import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { Eyebrow } from './eyebrow';

/**
 * Right-hand slide-over for add/edit flows and detail views (replaces permanent side
 * forms). Built on Radix Dialog, so focus is trapped while open, returns to the trigger
 * on close, and Escape closes it.
 */
export function Drawer({
  open,
  onOpenChange,
  eyebrow,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Screen-reader description; hidden visually. */
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  // The drawer is opened from state, not from a <Dialog.Trigger>, so Radix has no trigger to
  // hand focus back to. Remember the opener as focus is about to move in, restore on close.
  const openerRef = React.useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-foreground/35 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={description ? undefined : undefined}
          onOpenAutoFocus={() => {
            openerRef.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={e => {
            e.preventDefault();
            openerRef.current?.focus();
          }}
          className={cn(
            'fixed inset-y-0 right-0 z-[61] flex w-[min(480px,100vw)] flex-col border-l border-border-strong bg-background text-foreground shadow-2xl duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
            className
          )}
        >
          <div className="flex items-start justify-between gap-4 px-7 pb-2 pt-6">
            <div className="min-w-0">
              {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
              <Dialog.Title className="mt-1.5 font-serif text-[28px]">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="sr-only">{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={18} weight="light" />
            </Dialog.Close>
          </div>
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-7 py-5 [&>*]:shrink-0">
            {children}
          </div>
          {footer && (
            <div className="flex justify-end gap-2.5 border-t border-border px-7 py-4">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
