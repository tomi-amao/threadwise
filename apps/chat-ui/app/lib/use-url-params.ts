/**
 * URL search params as state, safe against fast successive updates.
 *
 * React Router's setSearchParams applies asynchronously, and a component that builds each new
 * URL from the params of its last render will lose an update that was made before the previous
 * one had rendered (a quick "clear filters" followed by choosing a filter would bring the old
 * filters back). This hook remembers the URL it last wrote and builds the next one from that.
 *
 * `apply` always replaces the history entry (filters are a view, not a place to navigate back to).
 */

import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';

export function useUrlParams() {
  const [sp, setSp] = useSearchParams();

  const latest = useRef(sp);
  /** The URL we wrote that the router has not rendered yet, if any. */
  const pending = useRef<string | null>(null);
  const seen = useRef(sp.toString());

  const current = sp.toString();
  if (current !== seen.current) {
    seen.current = current;
    // Adopt what the router shows, unless it is a stale intermediate state of our own writes.
    if (pending.current === null || current === pending.current) {
      latest.current = new URLSearchParams(sp);
      pending.current = null;
    }
  }

  const apply = useCallback(
    (build: (params: URLSearchParams) => URLSearchParams) => {
      const next = build(new URLSearchParams(latest.current));
      latest.current = next;
      pending.current = next.toString();
      setSp(next, { replace: true });
    },
    [setSp]
  );

  return [sp, apply] as const;
}
