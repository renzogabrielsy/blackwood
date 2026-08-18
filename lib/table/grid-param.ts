// ─────────────────────────────────────────────────────────────────────────────────
// `?grid=v2` — the side-by-side axis. PLATFORM LAYER, pure.
//
// The universal-table migration builds each screen's new grid BESIDE its existing one
// rather than in place of it (the strangler-fig method — see
// `handoffs/2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`), and one
// query param decides which of the two renders. It is deliberately the SAME param on
// every screen: an operator comparing two screens in two tabs should not have to
// remember two spellings, and a bookmark that says "show me the new one" should mean
// the same thing everywhere.
//
// It is an axis of the CLIENT, never of the DATA. Both implementations read the
// identical server payload; nothing here reaches a query, an action or a role gate, and
// nothing here can change what a page fetches. The param's ONLY effect is which
// component renders the rows that were fetched either way.
//
// ── Why this lives in the platform layer ────────────────────────────────────────
// The first migrated screen defined `GRID_V2` / `parseGrid` inside its own tenant
// module. That was correct while there was one consumer and wrong the moment there were
// two: the toggle control, the server pages and each screen's URL helpers all have to
// agree on the param NAME and its ONE recognised value, and three copies of a string
// literal is three chances to disagree. This module is the single definition; a tenant
// module that already exported the names re-exports them from here rather than keeping
// a second copy.
//
// ── Purity ──────────────────────────────────────────────────────────────────────
// No React, no Next, no Supabase, no tenant knowledge — `scripts/verify-table-core.ts`
// enforces all four with a source scan over this directory. Everything below is a
// function over plain strings, which is also what makes it assertable without a browser.
//
// TEMPORARY BY DESIGN. When a screen's new grid becomes its only grid, that screen stops
// passing the param; when the last one has cut over, this module and the toggle that
// writes it are deleted together. A permanent second grid is a second grid nobody
// maintains.
// ─────────────────────────────────────────────────────────────────────────────────

/** The query param that chooses which implementation of a screen's grid renders. */
export const GRID_PARAM = 'grid';

/**
 * The ONE recognised value. Anything else — absent, empty, misspelt, `?grid=V2`,
 * `?grid=3` — means the screen's CURRENT grid, which is what makes the default
 * unreachable by accident: there is no way to type a URL that half-selects the new one.
 */
export const GRID_V2 = 'v2';

/**
 * A raw param as it arrives from either side of the boundary: a server component's
 * `searchParams` hands over `string | string[] | undefined` (a repeated param is an
 * array), a client's `URLSearchParams.get()` hands over `string | null`.
 */
export type GridParam = string | string[] | null | undefined;

/** A repeated param arrives as an array — take the first, the way every axis here does. */
function one(v: GridParam): string | undefined {
    if (v === null || v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : v;
}

/**
 * The param's meaning: `GRID_V2`, or `null` for "the current grid".
 *
 * Returns the CONSTANT rather than the caller's string, so a consumer comparing the
 * result against `GRID_V2` is comparing two references to the same definition.
 */
export function parseGrid(raw: GridParam): string | null {
    return one(raw) === GRID_V2 ? GRID_V2 : null;
}

/** The predicate form — `if (isGridV2(params.grid))`. */
export function isGridV2(raw: GridParam): boolean {
    return parseGrid(raw) === GRID_V2;
}

/**
 * Anything that can enumerate `[name, value]` pairs: a `URLSearchParams`, Next's
 * `ReadonlyURLSearchParams`, or a plain array of tuples. Typed structurally so this
 * module never has to name a framework type.
 */
export type QueryEntries = Iterable<[string, string]>;

/**
 * The current query string with the grid param SET or REMOVED, and **every other param
 * carried over untouched** — that last clause is the whole point of the function.
 *
 * A toggle that dropped the screen's scope, period, search, lens or column filters would
 * flip you between two grids showing two different sets of rows, which is precisely the
 * comparison the side-by-side method exists to make possible. So the copy is exhaustive
 * and order-preserving, and it uses `append` rather than `set` so a legitimately repeated
 * param survives as a repeat.
 *
 * Returns the query string WITHOUT a leading `?`, empty when there is nothing to carry.
 */
export function withGrid(params: QueryEntries, v2: boolean): string {
    const out = new URLSearchParams();
    for (const [key, value] of params) {
        // The one param this function owns. Dropped on the way through and re-added
        // below only when it is on, so `?grid=v2&grid=v2` is unreachable and the OFF
        // state leaves no empty `?grid=` behind.
        if (key === GRID_PARAM) continue;
        out.append(key, value);
    }
    if (v2) out.append(GRID_PARAM, GRID_V2);
    return out.toString();
}

/**
 * `withGrid` as a full href. The `?` is emitted only when there is a query, so the OFF
 * state of a screen with no other params is the screen's own clean URL — the same one
 * every existing link already points at.
 */
export function gridHref(pathname: string, params: QueryEntries, v2: boolean): string {
    const query = withGrid(params, v2);
    return query ? `${pathname}?${query}` : pathname;
}
