/**
 * DateRangePicker
 *
 * Shopify-analytics-style date range control: a trigger button that opens a
 * panel with a sidebar of period presets next to a two-month calendar.
 * Presets update the pending selection immediately; nothing is applied
 * (i.e. nothing navigates) until Apply is pressed, so a preset can be used
 * as a starting point and then fine-tuned on the calendar.
 *
 * Positioning uses the same computePosition/autoUpdate + imperative-style
 * approach as SearchableSelect (see that file for why): routing position
 * through React state trails scroll by a render, which reads as jitter.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computePosition, autoUpdate, offset, flip, shift } from '@floating-ui/react-dom';
import { DayPicker, type DateRange, type ChevronProps } from 'react-day-picker';
import { CalendarBlank, CaretDown, CaretLeft, CaretRight } from 'phosphor-react';

const VIEWPORT_PADDING = 8;

// ─── Date helpers (native Date — no date-fns, matching this app's existing
// ad-hoc date math in app.reports.tsx's getPresets()) ──────────────────────

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISODate(s: string): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  const parsed = new Date(y, m - 1, d);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function formatLong(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatShort(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}
function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}
function startOfWeek(d: Date): Date {
  return addDays(d, -d.getDay());
}
function endOfWeek(d: Date): Date {
  return addDays(startOfWeek(d), 6);
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function startOfQuarter(d: Date): Date {
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
}
function endOfQuarter(d: Date): Date {
  return endOfMonth(addMonths(startOfQuarter(d), 2));
}
function sameDay(a?: Date, b?: Date): boolean {
  if (!a || !b) return a === b;
  return toISODate(a) === toISODate(b);
}

export interface FiscalYearEnd {
  /** 1-31 */
  day: number;
  /** 1-12 */
  month: number;
}

function getFinancialYearRanges(fye: FiscalYearEnd, today: Date) {
  let end = new Date(today.getFullYear(), fye.month - 1, fye.day);
  if (today > end) end = new Date(today.getFullYear() + 1, fye.month - 1, fye.day);
  const start = addDays(new Date(end.getFullYear() - 1, fye.month - 1, fye.day), 1);
  const lastEnd = addDays(start, -1);
  const lastStart = addDays(new Date(lastEnd.getFullYear() - 1, fye.month - 1, fye.day), 1);
  return {
    toDate: { from: start, to: today },
    lastYear: { from: lastStart, to: lastEnd },
  };
}

type Selection = 'all' | DateRange;

interface Preset {
  label: string;
  selection: Selection;
}

function buildPresets(fiscalYearEnd: FiscalYearEnd | undefined, today: Date): Preset[][] {
  const yesterday = addDays(today, -1);
  const lastWeekRef = addDays(today, -7);
  const lastMonthRef = addMonths(today, -1);
  const lastQuarterRef = addMonths(today, -3);
  const thisYearStart = new Date(today.getFullYear(), 0, 1);
  const lastYearStart = new Date(today.getFullYear() - 1, 0, 1);
  const lastYearEnd = new Date(today.getFullYear() - 1, 11, 31);

  const groups: Preset[][] = [
    [
      { label: 'Today', selection: { from: today, to: today } },
      { label: 'Yesterday', selection: { from: yesterday, to: yesterday } },
      { label: 'This week', selection: { from: startOfWeek(today), to: today } },
      {
        label: 'Last week',
        selection: { from: startOfWeek(lastWeekRef), to: endOfWeek(lastWeekRef) },
      },
      { label: 'This month', selection: { from: startOfMonth(today), to: today } },
      {
        label: 'Last month',
        selection: { from: startOfMonth(lastMonthRef), to: endOfMonth(lastMonthRef) },
      },
    ],
    [
      { label: 'This quarter', selection: { from: startOfQuarter(today), to: today } },
      {
        label: 'Last quarter',
        selection: { from: startOfQuarter(lastQuarterRef), to: endOfQuarter(lastQuarterRef) },
      },
      { label: 'This year', selection: { from: thisYearStart, to: today } },
      { label: 'Last year', selection: { from: lastYearStart, to: lastYearEnd } },
    ],
  ];

  if (fiscalYearEnd) {
    const fy = getFinancialYearRanges(fiscalYearEnd, today);
    groups.push([
      { label: 'Financial year to date', selection: fy.toDate },
      { label: 'Last financial year', selection: fy.lastYear },
    ]);
  }

  groups.push([{ label: 'All time', selection: 'all' }]);

  return groups;
}

function PickerChevron({ orientation }: ChevronProps) {
  return orientation === 'left' ? (
    <CaretLeft size={14} weight="bold" />
  ) : (
    <CaretRight size={14} weight="bold" />
  );
}

function selectionsEqual(a: Selection, b: Selection): boolean {
  if (a === 'all' || b === 'all') return a === b;
  return sameDay(a.from, b.from) && sameDay(a.to, b.to);
}

// ─── Component ────────────────────────────────────────────────────────────

export interface DateRangePickerProps {
  /** ISO date (YYYY-MM-DD), or '' for "all time" */
  from: string;
  /** ISO date (YYYY-MM-DD), or '' for "all time" */
  to: string;
  onApply: (from: string, to: string) => void;
  fiscalYearEnd?: FiscalYearEnd;
  className?: string;
  /**
   * Where the floating panel is mounted. Defaults to document.body; pass an
   * element to keep the panel inside a themed subtree (e.g. a page that
   * overrides the colour tokens), since portalled content otherwise inherits
   * only the root theme.
   */
  portalContainer?: HTMLElement | null;
}

export function DateRangePicker({
  from,
  to,
  onApply,
  fiscalYearEnd,
  className = '',
  portalContainer,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const today = useMemo(() => new Date(), []);
  const presetGroups = useMemo(() => buildPresets(fiscalYearEnd, today), [fiscalYearEnd, today]);
  const allPresets = useMemo(() => presetGroups.flat(), [presetGroups]);

  const appliedSelection: Selection = useMemo(() => {
    if (!from && !to) return 'all';
    return { from: parseISODate(from), to: parseISODate(to) };
  }, [from, to]);

  const [pending, setPending] = useState<Selection>(appliedSelection);
  const [month, setMonth] = useState<Date>(() => {
    const anchor = (appliedSelection !== 'all' ? appliedSelection.to : undefined) ?? today;
    return addMonths(anchor, -1);
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);

  const setFloatingRef = useCallback((node: HTMLDivElement | null) => {
    floatingRef.current = node;
    if (node) {
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
      strategy: 'fixed',
      middleware: [
        offset(6),
        flip({ padding: VIEWPORT_PADDING }),
        shift({ padding: VIEWPORT_PADDING }),
      ],
    }).then(({ x, y }) => {
      if (!floatingRef.current) return;
      Object.assign(floatingRef.current.style, {
        left: `${Math.round(x)}px`,
        top: `${Math.round(y)}px`,
        visibility: 'visible',
      });
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const reference = triggerRef.current;
    const floating = floatingRef.current;
    if (!reference || !floating) return;
    return autoUpdate(reference, floating, updatePosition);
  }, [open, updatePosition]);

  // Reset pending state to the applied selection each time the panel opens.
  const openPanel = useCallback(() => {
    setPending(appliedSelection);
    const anchor = (appliedSelection !== 'all' ? appliedSelection.to : undefined) ?? today;
    setMonth(addMonths(anchor, -1));
    setOpen(true);
  }, [appliedSelection, today]);

  const closePanel = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (floatingRef.current?.contains(target)) return;
      closePanel();
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open, closePanel]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, closePanel]);

  const activePresetLabel = useMemo(
    () => allPresets.find(p => selectionsEqual(p.selection, pending))?.label ?? null,
    [allPresets, pending]
  );

  const handlePickPreset = (preset: Preset) => {
    setPending(preset.selection);
    const anchor = (preset.selection !== 'all' ? preset.selection.to : undefined) ?? today;
    setMonth(addMonths(anchor, -1));
  };

  const handleCustomRange = () => {
    setPending({ from: undefined, to: undefined });
  };

  const handleCalendarSelect = (range: DateRange | undefined) => {
    setPending(range ?? { from: undefined, to: undefined });
  };

  const pendingRange: DateRange | undefined = pending === 'all' ? undefined : pending;
  const canApply = pending === 'all' || (!!pending.from && !!pending.to);

  const handleApply = () => {
    if (!canApply) return;
    if (pending === 'all') {
      onApply('', '');
    } else {
      onApply(toISODate(pending.from as Date), toISODate(pending.to as Date));
    }
    setOpen(false);
  };

  const handleFieldChange = (which: 'from' | 'to', value: string) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return;
    setPending(prev => {
      const base: DateRange = prev === 'all' ? { from: undefined, to: undefined } : prev;
      return { ...base, [which]: parsed };
    });
    setMonth(addMonths(parsed, which === 'to' ? -1 : 0));
  };

  const triggerLabel = useMemo(() => {
    if (appliedSelection === 'all') return 'All time';
    const matched = allPresets.find(p => selectionsEqual(p.selection, appliedSelection));
    if (matched) return matched.label;
    if (appliedSelection.from && appliedSelection.to) {
      return `${formatShort(appliedSelection.from)} – ${formatShort(appliedSelection.to)}`;
    }
    return 'Select dates';
  }, [appliedSelection, allPresets]);

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePanel() : openPanel())}
        className={`flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/70 ${className}`}
      >
        <CalendarBlank size={14} />
        {triggerLabel}
        <CaretDown
          size={12}
          className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={setFloatingRef}
            style={{ zIndex: 9999 }}
            className="flex w-[min(920px,95vw)] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
          >
            {/* Preset sidebar */}
            <div className="w-[200px] shrink-0 overflow-y-auto border-r border-border py-2">
              {presetGroups.map((group, gi) => (
                <div key={gi} className={gi > 0 ? 'mt-2 border-t border-border pt-2' : ''}>
                  {group.map(preset => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => handlePickPreset(preset)}
                      className={`block w-full truncate px-4 py-1.5 text-left text-sm transition-colors ${
                        activePresetLabel === preset.label
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-foreground hover:bg-accent/50'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              ))}
              <div className="mt-2 border-t border-border pt-2">
                <button
                  type="button"
                  onClick={handleCustomRange}
                  className={`block w-full truncate px-4 py-1.5 text-left text-sm transition-colors ${
                    activePresetLabel === null
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-foreground hover:bg-accent/50'
                  }`}
                >
                  Custom range
                </button>
              </div>
            </div>

            {/* Calendar side */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <input
                  type="text"
                  readOnly={false}
                  defaultValue={pendingRange?.from ? formatLong(pendingRange.from) : ''}
                  key={`from-${pendingRange?.from ? toISODate(pendingRange.from) : 'empty'}`}
                  onBlur={e => handleFieldChange('from', e.target.value)}
                  className="w-full min-w-0 rounded-md border border-border bg-muted px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/60"
                />
                <span className="shrink-0 text-muted-foreground">→</span>
                <input
                  type="text"
                  defaultValue={pendingRange?.to ? formatLong(pendingRange.to) : ''}
                  key={`to-${pendingRange?.to ? toISODate(pendingRange.to) : 'empty'}`}
                  onBlur={e => handleFieldChange('to', e.target.value)}
                  className="w-full min-w-0 rounded-md border border-border bg-muted px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/60"
                />
              </div>

              <div className="flex-1 overflow-x-auto px-4 py-3">
                <DayPicker
                  mode="range"
                  selected={pendingRange}
                  onSelect={handleCalendarSelect}
                  month={month}
                  onMonthChange={setMonth}
                  numberOfMonths={2}
                  navLayout="around"
                  showOutsideDays
                  disabled={{ after: today }}
                  components={{ Chevron: PickerChevron }}
                  classNames={{
                    months: 'flex gap-8',
                    month: 'relative flex flex-col gap-2',
                    month_caption:
                      'flex justify-center items-center h-8 text-sm font-semibold text-foreground',
                    caption_label: 'text-sm font-semibold text-foreground',
                    nav: 'hidden',
                    button_previous:
                      'absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30',
                    button_next:
                      'absolute right-0 top-0 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30',
                    month_grid: 'border-collapse',
                    weekdays: '',
                    weekday: 'w-9 pb-1 text-[11px] font-medium uppercase text-muted-foreground',
                    weeks: '',
                    week: '',
                    day: 'p-0 text-center align-middle',
                    day_button:
                      'h-9 w-9 rounded-full text-sm text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:text-muted-foreground/40',
                    today: '[&>button]:font-semibold [&>button]:text-primary',
                    outside: '[&>button]:text-muted-foreground/40',
                    disabled: '',
                    range_start:
                      'bg-primary/15 rounded-l-full [&>button]:bg-primary [&>button]:text-primary-foreground',
                    range_end:
                      'bg-primary/15 rounded-r-full [&>button]:bg-primary [&>button]:text-primary-foreground',
                    range_middle: 'bg-primary/15 [&>button]:rounded-full [&>button]:bg-transparent',
                    selected: '',
                  }}
                />
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                <button
                  type="button"
                  onClick={closePanel}
                  className="rounded-lg border border-border px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={!canApply}
                  className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>,
          portalContainer ?? document.body
        )}
    </div>
  );
}
