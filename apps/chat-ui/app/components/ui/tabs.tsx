import * as React from 'react';
import { cn } from '~/lib/utils';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** Small mono count shown after the label. */
  count?: number | string;
}

/**
 * Underlined page tabs. Arrow keys move between tabs (roving tabindex), Home/End jump to
 * the ends. The caller renders the panel; give it `role="tabpanel"` and
 * `aria-labelledby={tabId(id)}` if it needs to be associated.
 */
export const tabId = (id: string) => `tab-${id}`;

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : e.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    const id = tabs[next].id;
    onChange(id);
    refs.current[id]?.focus();
  };

  return (
    <div
      role="tablist"
      className={cn(
        'flex gap-7 overflow-x-auto border-b border-border [scrollbar-width:none]',
        className
      )}
    >
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={el => {
              refs.current[t.id] = el;
            }}
            id={tabId(t.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={e => onKeyDown(e, i)}
            className={cn(
              'relative inline-flex items-baseline gap-2 whitespace-nowrap py-3.5 text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'text-foreground' : 'text-text-2 hover:text-foreground'
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="font-mono text-[11px] tracking-[0.06em] text-muted-foreground">
                {t.count}
              </span>
            )}
            {selected && (
              <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}
