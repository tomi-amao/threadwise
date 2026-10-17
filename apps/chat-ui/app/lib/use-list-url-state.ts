/**
 * URL state shared by the list pages (Invoices, Orders, Customers, Products): a search box that
 * applies after a short pause, a page number, and `set` to change several params at once.
 * Anything that changes the filters resets the page, unless `page` is part of the change.
 */

import { useCallback, useEffect, useState } from 'react';
import { useUrlParams } from './use-url-params';

export function useListUrlState() {
  const [sp, apply] = useUrlParams();

  const set = useCallback(
    (patch: Record<string, string | null>) =>
      apply(p => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) p.delete(key);
          else p.set(key, value);
        }
        if (!('page' in patch)) p.delete('page');
        return p;
      }),
    [apply]
  );

  const q = sp.get('q') ?? '';
  const page = Math.max(1, Number(sp.get('page')) || 1);

  const [searchText, setSearchText] = useState(q);
  useEffect(() => setSearchText(q), [q]);
  useEffect(() => {
    if (searchText === q) return;
    const timer = setTimeout(() => set({ q: searchText.trim() || null }), 300);
    return () => clearTimeout(timer);
  }, [searchText, q, set]);

  return { sp, set, q, page, searchText, setSearchText };
}
