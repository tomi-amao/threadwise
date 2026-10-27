/**
 * Read every row of a query, not just the first page.
 *
 * Supabase's API caps each response at `max_rows` (1,000 by default) and `.limit(n)` cannot
 * raise that cap, so a plain `select()` over a larger table silently returns the first 1,000
 * rows and every total computed from it is wrong. This pages through with `.range()` until a
 * page comes back empty, or short once a full page has shown the cap is not below the page size.
 *
 * Two details matter for correctness:
 *  - Paging needs a stable order, otherwise rows can repeat or be skipped between pages. The
 *    query builder you pass MUST include an `.order(...)` on a unique column (use `id`).
 *  - It advances by the number of rows actually returned, not by the page size, so it is still
 *    correct if a project's `max_rows` is lower than the page size requested.
 */

interface Page {
  // `unknown`: the untyped Supabase client cannot verify a select string against a row type, so
  // the caller states the row shape via T and this helper trusts it (one cast, here).
  data: unknown[] | null;
  error: { message: string } | null;
}

export async function fetchAllRows<T>(
  label: string,
  /** Build the query for one page. Must be ordered by a unique column. */
  page: (from: number, to: number) => PromiseLike<Page>,
  pageSize = 1000
): Promise<T[]> {
  const rows: T[] = [];
  // A short page only means "no more rows" once a full page has proved `max_rows` is at least
  // the page size; before that it might be the cap, so ask once more. Each request is a round
  // trip to the database, which is what this saves.
  let sawFullPage = false;
  for (let from = 0; ;) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    from += data.length;
    if (data.length >= pageSize) sawFullPage = true;
    else if (sawFullPage) break;
  }
  return rows;
}
