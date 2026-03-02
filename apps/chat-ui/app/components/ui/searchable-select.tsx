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
import { DismissableLayerBranch } from '@radix-ui/react-dismissable-layer';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { CaretDown, Check, MagnifyingGlass, X } from 'phosphor-react';

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
  disabled?: boolean;
  /** Custom renderer for each option row */
  renderOption?: (option: SelectOption, isSelected: boolean) => React.ReactNode;
  /** Custom renderer for the selected value shown in the trigger */
  renderValue?: (option: SelectOption | null) => React.ReactNode;
  /** Stop click propagation on the trigger (useful inside table rows) */
  stopPropagation?: boolean;
}

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
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const [activeIdx, setActiveIdx] = useState<number>(-1);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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

  // ── Dropdown positioning ───────────────────────────────────────────────────
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUpward = spaceBelow < 280 && spaceAbove > spaceBelow;
    const minW = Math.max(rect.width, 240);

    setDropdownStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      minWidth: minW,
      maxWidth: Math.min(minW, 400),
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + 4, top: 'auto' }
        : { top: rect.bottom + 4, bottom: 'auto' }),
      zIndex: 9999,
      // Radix Dialog sets pointer-events:none on body when open; restore it for this portal.
      pointerEvents: 'auto',
    });
  }, []);

  // ── Open / close ───────────────────────────────────────────────────────────
  const openDropdown = useCallback(
    (e: React.MouseEvent) => {
      if (stopPropagation) e.stopPropagation();
      if (disabled) return;
      updatePosition();
      setOpen(true);
      setQuery('');
      setActiveIdx(-1);
    },
    [disabled, stopPropagation, updatePosition]
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

  // Block wheel/touchmove from reaching react-remove-scroll's document-level
  // handler (which calls preventDefault on elements outside the dialog DOM).
  useEffect(() => {
    if (!open) return;
    let cleanup: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      const el = dropdownRef.current;
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
      if (dropdownRef.current?.contains(target)) return;
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
      | { type: 'group'; label: string }
      | { type: 'option'; option: SelectOption; idx: number };

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
            <div ref={dropdownRef} style={dropdownStyle}>
              <div className="rounded-lg border border-border bg-popover shadow-xl overflow-hidden flex flex-col">
                {/* Search input */}
                {showSearch && (
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2">
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
                <ul ref={listRef} className="overflow-y-auto max-h-56 py-1" role="listbox">
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
        className={`flex items-center gap-1.5 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors hover:bg-muted/30 ${className}`}
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
