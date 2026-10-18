import * as React from 'react';
import { CaretDown } from 'phosphor-react';
import { cn } from '~/lib/utils';
import { Button } from './button';

export interface SplitMenuItem {
  label: string;
  description: string;
  /** A short tag after the label, e.g. "Default" or "Resets". */
  tag?: string;
  onSelect: () => void;
}

/**
 * A button with a menu of variations beside it: the main button does the usual thing, the caret
 * opens the less usual ones, each explained. Escape or a click elsewhere closes it, and focus
 * returns to the caret.
 */
export function SplitMenu({
  label,
  busyLabel,
  busy = false,
  disabled = false,
  icon,
  variant = 'default',
  items,
  onPrimary,
}: {
  label: string;
  busyLabel: string;
  busy?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  variant?: 'default' | 'outline';
  items: SplitMenuItem[];
  onPrimary: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const caret = React.useRef<HTMLButtonElement>(null);
  const menuId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        caret.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative inline-flex">
      <Button
        variant={variant}
        onClick={onPrimary}
        disabled={disabled}
        className="rounded-r-none border-r-0"
      >
        {icon}
        {busy ? busyLabel : label}
      </Button>
      <Button
        ref={caret}
        variant={variant}
        disabled={disabled}
        aria-label={`More ways to ${label.toLowerCase()}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(o => !o)}
        className={cn(
          'rounded-l-none px-2.5',
          variant === 'default' && 'border-l border-l-foreground/15'
        )}
      >
        <CaretDown size={14} aria-hidden />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-border-strong bg-popover p-1.5 shadow-lg"
        >
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="block w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <span className="flex items-center gap-2 text-[15px] font-medium">
                {item.label}
                {item.tag && (
                  <span className="font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-text-2">
                    {item.tag}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[13px] text-text-2">{item.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
