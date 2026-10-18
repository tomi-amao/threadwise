/**
 * Transaction filters live in the URL (?q=&direction=&status=&type=&source=&from=&to=&page=)
 * so a filtered view can be shared, reloaded, and reached with the back button. These helpers
 * are the only place that knows the parameter names.
 */

export interface TxnFilters {
  q: string;
  direction: '' | 'in' | 'out';
  /** The API only distinguishes active from excluded (not journalled/pending). */
  status: '' | 'active' | 'excluded';
  type: string;
  source: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: TxnFilters = {
  q: '',
  direction: '',
  status: '',
  type: '',
  source: '',
  from: '',
  to: '',
};

const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function readFilters(sp: URLSearchParams): TxnFilters {
  return {
    q: sp.get('q') ?? '',
    direction: oneOf(sp.get('direction'), ['', 'in', 'out'] as const, ''),
    status: oneOf(sp.get('status'), ['', 'active', 'excluded'] as const, ''),
    type: sp.get('type') ?? '',
    source: sp.get('source') ?? '',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
  };
}

export const readPage = (sp: URLSearchParams): number => Math.max(1, Number(sp.get('page')) || 1);

/** How many distinct filters are set (the date range counts once). */
export function activeFilterCount(f: TxnFilters): number {
  return [f.q, f.direction, f.status, f.type, f.source, f.from || f.to].filter(Boolean).length;
}

/** New search params with `patch` applied. Changing a filter returns to page 1. */
export function withFilters(sp: URLSearchParams, patch: Partial<TxnFilters>): URLSearchParams {
  const next = new URLSearchParams(sp);
  for (const [key, value] of Object.entries(patch)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  next.delete('page');
  return next;
}

export function withoutFilters(sp: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(sp);
  for (const key of Object.keys(EMPTY_FILTERS)) next.delete(key);
  next.delete('page');
  return next;
}

export function withPage(sp: URLSearchParams, page: number): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (page > 1) next.set('page', String(page));
  else next.delete('page');
  return next;
}

export function withTransaction(sp: URLSearchParams, id: string | null): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (id) next.set('transactionId', id);
  else next.delete('transactionId');
  return next;
}
