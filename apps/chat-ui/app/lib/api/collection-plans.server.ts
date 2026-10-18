/**
 * Collection planning: the live exchange rate used to show a partner's amounts in their own
 * currency. Display only; nothing here is stored.
 *
 * Shared types, constants and projection maths live in app/lib/collection-plans.ts (no `.server`
 * suffix, since client components need them); the plan itself is read in collections.server.ts.
 */

// ─── Live FX rate (for display only — nothing is stored) ──────────────────

export interface FxRateResult {
  rate: number;
  /** As reported by the provider — a plain date/time string, not re-parsed,
   * since all we do with it is show it verbatim in an "as of" caption. */
  asOf: string;
  baseCurrency: string;
  targetCurrency: string;
}

// open.er-api.com: free, no API key, ~166 currencies (confirmed to include
// ones a 30-currency ECB-only provider like frankfurter.app does not, e.g.
// NGN) — chosen specifically because this feature's whole point is
// partners in countries a narrower provider doesn't cover. Rates refresh
// roughly daily, which is exactly the "indicative of today" precision a
// forward-looking plan needs — anything near-real-time would be false
// precision here.
const FX_API_BASE = 'https://open.er-api.com/v6/latest';
const FX_FETCH_TIMEOUT_MS = 5000;

/** Returns null (never throws) if the currencies match, the code is
 * unsupported, or the request fails/times out — the plan document must
 * still render without the conversion rather than break on a third-party
 * API hiccup. */
export async function fetchFxRate(
  baseCurrency: string,
  targetCurrency: string
): Promise<FxRateResult | null> {
  const base = baseCurrency.trim().toUpperCase();
  const target = targetCurrency.trim().toUpperCase();
  if (!base || !target || base === target) return null;

  try {
    const response = await fetch(`${FX_API_BASE}/${encodeURIComponent(base)}`, {
      signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = await response.json();
    if (data?.result !== 'success') return null;

    const rate = data?.rates?.[target];
    if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;

    return {
      rate,
      asOf: String(data.time_last_update_utc || ''),
      baseCurrency: base,
      targetCurrency: target,
    };
  } catch {
    return null;
  }
}
