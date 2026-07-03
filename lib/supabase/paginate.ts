/**
 * Shared PostgREST pagination helper.
 *
 * PostgREST caps every response at a maximum row count (Supabase default
 * `max_rows` = 1000). To read a table/view that may exceed that cap we page
 * through it with `.range(from, to)` until a short page signals the end.
 *
 * This is the ONE canonical implementation — the identical 1000-row `.range()`
 * loop was previously copy-pasted into `app/(app)/inventory/page.tsx`,
 * `rc-out/actions.ts`, `flecon-bags/actions.ts`, and `rc-movement/actions.ts`.
 *
 * Contract:
 *   - `buildQuery(from, to)` returns a fresh PostgREST query for the `[from, to]`
 *     page window. It is re-invoked once per page so filters/ordering are
 *     reapplied every iteration. The builder MUST apply `.range(from, to)` (the
 *     range args are threaded through so the builder stays the single place the
 *     query is assembled — mirroring the originals, three of which called
 *     `buildQuery().range(...)` and one built the range inline).
 *   - The helper THROWS on the first PostgREST error, so callers that want to
 *     degrade gracefully should wrap the call in try/catch (matching the prior
 *     per-file behaviour: page.tsx and rc-movement already threw; rc-out swallowed
 *     errors; flecon-bags surfaced them — each call site keeps its own semantics
 *     around this throw).
 *   - Early-exit condition is IDENTICAL to the originals: stop as soon as a page
 *     returns fewer than `pageSize` rows.
 *
 * `pageSize` defaults to 1000 (the PostgREST cap). Never pass a larger value —
 * PostgREST would silently clamp it and the short-page early-exit would misfire.
 */
type RangeResult<T> = { data: T[] | null; error: { message: string } | null };

export async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<RangeResult<T>>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    all.push(...page);
    hasMore = page.length === pageSize;
    from += pageSize;
  }

  return all;
}
