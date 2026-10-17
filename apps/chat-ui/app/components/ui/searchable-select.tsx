/**
 * SearchableSelect
 *
 * Custom styled dropdown with optional search filtering.
 * Renders the dropdown list in a portal so it escapes modal/table stacking contexts.
 *
 * Usage:
 *   <SearchableSelect
 *     options={[{ value: 'x', label: 'X', group: 'Category' }]}
 *     value={current}
 *     onChange={setValue}
 *     emptyOption="None"
 *     placeholder="Select…"
 *   />
 */

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { computePosition, autoUpdate, offset, flip, shift, size } from '@floating-ui/react-dom';
import { DismissableLayerBranch } from '@radix-ui/react-dismissable-layer';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { CaretDown, Check, MagnifyingGlass, X } from 'phosphor-react';
import { cn } from '~/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string;
  label: string;
  /** Optional group header shown above consecutive items sharing this key */
  group?: string;
  /** Optional secondary text shown beneath the label */
  meta?: string;
}

export interface SearchableSelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** Placeholder text shown in the trigger when nothing is selected */
  placeholder?: string;
  /** If provided, prepends a "clear / empty" option with this label */
  emptyOption?: string;
  /** Force search box on or off. Defaults to true when options.length > 6 */
  searchable?: boolean;
  /** Extra className applied to the trigger button */
  className?: string;
  /** Accessible name for the trigger when there is no visible <label> for it */
  'aria-label'?: string;
  disabled?: boolean;
  /** Custom renderer for each option row */
  renderOption?: (option: SelectOption, isSelected: boolean) => React.ReactNode;
  /** Custom renderer for the selected value shown in the trigger */
  renderValue?: (option: SelectOption | null) => React.ReactNode;
  /** Stop click propagation on the trigger (useful inside table rows) */
  stopPropagation?: boolean;
}

/** Gap kept between the dropdown and the edge of whatever is clipping it. */
const VIEWPORT_PADDING = 8;

// ─── Component ────────────────────────────────────────────────────────────────

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  emptyOption,
  searchable,
  className = '',
  disabled = false,
  renderOption,
  renderValue,
  stopPropagation = false,
  'aria-label': ariaLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Position is applied by mutating the floating element's style directly,
  // not through React state. Going through useFloating's React-managed
  // floatingStyles means every scroll tick is: scroll event → computePosition
  // (async) → setState → re-render → paint — which trails the natively
  // scrolled content by a frame and reads as jitter/lag. Writing the style
  // straight onto the node from the same callback autoUpdate already calls
  // skips that render round-trip, so the panel tracks the trigger as closely
  // as the browser's own scroll-then-paint timing allows.
  const setFloatingRef = useCallback((node: HTMLDivElement | null) => {
    floatingRef.current = node;
    if (node) {
      // Fresh mount each time the dropdown opens — start hidden at a neutral
      // position until the first computePosition() resolves below, then
      // updatePosition() owns top/left/visibility for the rest of this
      // open session.
      node.style.position = 'fixed';
      node.style.top = '0px';
      node.style.left = '0px';
      node.style.visibility = 'hidden';
    }
  }, []);

  const updatePosition = useCallback(() => {
    const reference = triggerRef.current;
    const floating = floatingRef.current;
    if (!reference || !floating) return;

    computePosition(reference, floating, {
      placement: 'bottom-start',
      // computePosition defaults to 'absolute' (document-relative)
      // coordinates; we apply the result via position:fixed
      // (viewport-relative). They only happen to agree when the page's own
      // scroll is exactly zero — make it explicit instead of relying on that.
      strategy: 'fixed',
      middleware: [
        offset(4),
        flip({ padding: VIEWPORT_PADDING }),
        shift({ padding: VIEWPORT_PADDING }),
        size({
          padding: VIEWPORT_PADDING,
          apply({ rects, availableWidth, availableHeight, elements }) {
            const minW = Math.max(rects.reference.width, 240);
            Object.assign(elements.floating.style, {
              minWidth: `${Math.round(minW)}px`,
              maxWidth: `${Math.round(Math.min(minW, 400, availableWidth))}px`,
              // Never floor this to a minimum height: a floor larger than
              // the real gap is precisely what makes the panel punch
              // through the edge of its scroll container. Shrink to
              // whatever is actually there and let the list scroll inside.
              maxHeight: `${Math.max(0, Math.floor(availableHeight))}px`,
            });
          },
        }),
      ],
    }).then(({ x, y }) => {
      // The dropdown may have closed (and its portal node unmounted) while
      // this promise was in flight.
      if (!floatingRef.current) return;
      Object.assign(floatingRef.current.style, {
        left: `${Math.round(x)}px`,
        top: `${Math.round(y)}px`,
        visibility: 'visible',
      });
    });
  }, []);

  // autoUpdate covers scroll/resize on every ancestor between the trigger
  // and the viewport (including nested scroll regions, e.g. this list's own
  // container inside a scrollable modal) for as long as the dropdown is
  // open, calling updatePosition on each. elementResize is off: size()
  // above writes width/height onto this same floating element on every
  // call, which would otherwise retrigger the ResizeObserver that watches
  // it, which calls update again — an infinite loop that made the panel
  // oscillate. The list's own size still changes when filtering narrows it,
  // so that case is repositioned explicitly below instead.
  useEffect(() => {
    if (!open) return;
    const reference = triggerRef.current;
    const floating = floatingRef.current;
    if (!reference || !floating) return;
    return autoUpdate(reference, floating, updatePosition, { elementResize: false });
  }, [open, updatePosition]);

  const showSearch = searchable !== undefined ? searchable : options.length > 6;

  // Build flat list including optional empty entry
  const allOptions = useMemo<SelectOption[]>(() => {
    const base: SelectOption[] = emptyOption ? [{ value: '', label: emptyOption }] : [];
    return [...base, ...options];
  }, [options, emptyOption]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allOptions;
    const q = query.toLowerCase();
    return allOptions.filter(
      o =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        o.group?.toLowerCase().includes(q) ||
        o.meta?.toLowerCase().includes(q)
    );
  }, [allOptions, query]);

  const selectedOption = allOptions.find(o => o.value === value) ?? null;

  // ── Open / close ───────────────────────────────────────────────────────────
  const openDropdown = useCallback(
    (e: React.MouseEvent) => {
      if (stopPropagation) e.stopPropagation();
      if (disabled) return;
      setOpen(true);
      setQuery('');
      setActiveIdx(-1);
    },
    [disabled, stopPropagation]
  );

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIdx(-1);
  }, []);

  const select = useCallback(
    (val: string) => {
      onChange(val);
      closeDropdown();
    },
    [onChange, closeDropdown]
  );

  // Filtering changes the list's height, and autoUpdate's elementResize is
  // deliberately off (see above), so reposition explicitly here.
  useEffect(() => {
    if (open) updatePosition();
  }, [open, filtered.length, updatePosition]);

  // Block wheel/touchmove from reaching react-remove-scroll's document-level
  // handler (which calls preventDefault on elements outside the dialog DOM).
  useEffect(() => {
    if (!open) return;
    let cleanup: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      const el = floatingRef.current;
      if (!el) return;
      const stop = (e: Event) => e.stopPropagation();
      el.addEventListener('wheel', stop, { passive: true });
      el.addEventListener('touchmove', stop, { passive: true });
      cleanup = () => {
        el.removeEventListener('wheel', stop);
        el.removeEventListener('touchmove', stop);
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [open]);

  // Focus search input when opened
  useEffect(() => {
    if (open && showSearch) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, showSearch]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Allow clicks inside the trigger or the portal dropdown
      if (triggerRef.current?.contains(target)) return;
      if (floatingRef.current?.contains(target)) return;
      closeDropdown();
    };
    // Use capture so we see it before Radix's dismissable layer
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open, closeDropdown]);

  // Close on Escape, arrow navigation
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDropdown();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault();
        select(filtered[activeIdx].value);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, filtered, activeIdx, closeDropdown, select]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  // ── Group rendering helpers ────────────────────────────────────────────────
  const groupedFiltered = useMemo(() => {
    // Returns entries: { type: 'group', label } | { type: 'option', option, idx }
    type Entry =
      { type: 'group'; label: string } | { type: 'option'; option: SelectOption; idx: number };

    const entries: Entry[] = [];
    let lastGroup: string | undefined = undefined;

    filtered.forEach((opt, idx) => {
      if (opt.group && opt.group !== lastGroup) {
        entries.push({ type: 'group', label: opt.group });
        lastGroup = opt.group;
      }
      entries.push({ type: 'option', option: opt, idx });
    });

    return entries;
  }, [filtered]);

  // ── Trigger display ────────────────────────────────────────────────────────
  const triggerContent = renderValue ? (
    renderValue(selectedOption)
  ) : selectedOption && selectedOption.value !== '' ? (
    <span className="truncate">{selectedOption.label}</span>
  ) : (
    <span className="truncate text-muted-foreground">{placeholder}</span>
  );

  // ── Dropdown via Radix Portal (escapes transforms + cooperates with focus trap) ──
  const dropdown = open
    ? createPortal(
        <FocusScope trapped={false}>
          <DismissableLayerBranch>
            <div
              ref={setFloatingRef}
              className="flex flex-col overflow-hidden"
              style={{
                zIndex: 9999,
                // Radix Dialog sets pointer-events:none on body when open; restore it for this portal.
                pointerEvents: 'auto',
              }}
            >
              <div className="rounded-lg border border-border bg-popover shadow-xl overflow-hidden flex flex-col min-h-0">
                {/* Search input */}
                {showSearch && (
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
                    <MagnifyingGlass size={14} className="text-muted-foreground shrink-0" />
                    <input
                      ref={searchRef}
                      type="text"
                      value={query}
                      onChange={e => {
                        setQuery(e.target.value);
                        setActiveIdx(-1);
                      }}
                      placeholder="Search…"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    />
                    {query && (
                      <button
                        onClick={() => setQuery('')}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                )}

                {/* Options list */}
                <ul
                  ref={listRef}
                  className="overflow-y-auto overscroll-contain flex-1 min-h-0 max-h-56 py-1"
                  role="listbox"
                >
                  {groupedFiltered.length === 0 && (
                    <li className="px-3 py-5 text-center text-xs text-muted-foreground">
                      No results found
                    </li>
                  )}
                  {groupedFiltered.map((entry, i) => {
                    if (entry.type === 'group') {
                      return (
                        <li
                          key={`group-${entry.label}-${i}`}
                          className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 select-none"
                        >
                          {entry.label}
                        </li>
                      );
                    }
                    const { option, idx } = entry;
                    const isSelected = option.value === value;
                    const isActive = idx === activeIdx;
                    return (
                      <li
                        key={option.value}
                        role="option"
                        aria-selected={isSelected}
                        onMouseEnter={() => setActiveIdx(idx)}
                        onMouseDown={e => {
                          e.preventDefault();
                          select(option.value);
                        }}
                        className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                          isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                        }`}
                      >
                        {renderOption ? (
                          renderOption(option, isSelected)
                        ) : (
                          <div className="flex-1 min-w-0">
                            <span className="truncate block">{option.label}</span>
                            {option.meta && (
                              <span className="text-xs text-muted-foreground truncate block">
                                {option.meta}
                              </span>
                            )}
                          </div>
                        )}
                        {isSelected && (
                          <Check size={14} weight="bold" className="shrink-0 text-primary" />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </DismissableLayerBranch>
        </FocusScope>,
        document.body
      )
    : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={openDropdown}
        aria-label={ariaLabel}
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors hover:bg-muted/30',
          className
        )}
      >
        <span className="flex-1 min-w-0 text-left">{triggerContent}</span>
        <CaretDown
          size={13}
          weight="bold"
          className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {dropdown}
    </div>
  );
}
