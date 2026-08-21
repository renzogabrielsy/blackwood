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
// ── A page states its OWN default (2026-08-21) ──────────────────────────────────
// The migration's second phase flips a screen over while keeping the old table reachable:
// RC IN / RC OUT default to v2 and reach the classic table at `?grid=v1`, while the nine
// screens still on the old default behave exactly as they always did. That is one axis
// with a per-page default, NOT a second param — an operator comparing two screens in two
// tabs still only has to remember one spelling, and `resolveGrid(value, default)` is the
// single place the two halves of the question are combined.
//
// TEMPORARY BY DESIGN. When a screen's new grid becomes its only grid, that screen stops
// passing the param; when the last one has cut over, this module and the toggle that
// writes it are deleted together. A permanent second grid is a second grid nobody
// maintains.
// ─────────────────────────────────────────────────────────────────────────────────

/** The query param that chooses which implementation of a screen's grid renders. */
export const GRID_PARAM = 'grid';

/**
 * The new grid. Anything unrecognised — absent, empty, misspelt, `?grid=V2`, `?grid=3`
 * — means the PAGE'S OWN DEFAULT, which is what makes the default unreachable by
 * accident: there is no way to type a URL that half-selects a version.
 */
export const GRID_V2 = 'v2';

/**
 * The old grid, spelt out.
 *
 * It exists because a page can now DEFAULT to v2 (RC IN / RC OUT did, 2026-08-21), and a
 * flipped page needs a way to say "the old table" that the paramless URL no longer says.
 * On a v1-default page nothing ever writes it — `?grid=v1` there is simply the default
 * spelt out loud — so the nine screens still on the old default are untouched by its
 * existence.
 */
export const GRID_V1 = 'v1';

/**
 * Which of the two implementations a screen is showing. There are exactly two, and a
 * page always resolves to one of them — `null` from `parseGrid` means "the URL did not
 * say", never "neither".
 */
export type GridVersion = typeof GRID_V1 | typeof GRID_V2;

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
 * What the URL SAID: `GRID_V2`, `GRID_V1`, or `null` for "it did not say".
 *
 * Returns the CONSTANT rather than the caller's string, so a consumer comparing the
 * result against `GRID_V2` is comparing two references to the same definition.
 *
 * **`null` is not a version.** It used to double as "the current grid" because the
 * default was the same on every screen; it no longer is, so the two questions are now
 * asked separately and `resolveGrid` is the one that answers with a version.
 */
export function parseGrid(raw: GridParam): GridVersion | null {
    const v = one(raw);
    if (v === GRID_V2) return GRID_V2;
    if (v === GRID_V1) return GRID_V1;
    return null;
}

/**
 * What the page SHOWS: the URL's answer when it gave one, else the page's own default.
 *
 * A page states its default exactly once, here, at the single place it reads the param —
 * so "which grid is `/inventory` on today" has one answer in one expression instead of
 * being spread across a page, a toggle and a link builder that can disagree.
 *
 * An unrecognised value resolves to the DEFAULT, on either kind of page: a typo must
 * never half-select anything.
 */
export function resolveGrid(raw: GridParam, defaultVersion: GridVersion): GridVersion {
    return parseGrid(raw) ?? defaultVersion;
}

/**
 * The predicate form, for a page whose default is the OLD grid — `if (isGridV2(params.grid))`.
 *
 * Deliberately not default-aware: it is shorthand for `resolveGrid(raw, GRID_V1) === GRID_V2`
 * and reads wrong on a flipped page, where absence means v2. A v2-default page calls
 * `resolveGrid` and says so.
 */
export function isGridV2(raw: GridParam): boolean {
    return resolveGrid(raw, GRID_V1) === GRID_V2;
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
 *
 * ── `defaultVersion` keeps the URL CANONICAL ────────────────────────────────────
 * The param is only ever written when it says something the page does not already say,
 * so **the default side of the toggle is always the paramless URL** — on a v1-default
 * screen that is the old table (exactly as before this argument existed), and on a
 * v2-default screen it is the new one, with `?grid=v1` as the way back. Without this the
 * flipped page would have to write `?grid=v2` to mean "the thing you get anyway", and
 * every clean link into `/inventory` would read as the non-default state.
 *
 * It defaults to `GRID_V1`, so every existing caller is byte-identical.
 */
export function withGrid(
    params: QueryEntries,
    v2: boolean,
    defaultVersion: GridVersion = GRID_V1,
): string {
    const out = new URLSearchParams();
    for (const [key, value] of params) {
        // The one param this function owns. Dropped on the way through and re-added
        // below only when it says something, so `?grid=v2&grid=v2` is unreachable and the
        // default state leaves no empty `?grid=` behind.
        if (key === GRID_PARAM) continue;
        out.append(key, value);
    }
    const target: GridVersion = v2 ? GRID_V2 : GRID_V1;
    if (target !== defaultVersion) out.append(GRID_PARAM, target);
    return out.toString();
}

/**
 * `withGrid` as a full href. The `?` is emitted only when there is a query, so the
 * DEFAULT state of a screen with no other params is the screen's own clean URL — the
 * same one every existing link already points at.
 */
export function gridHref(
    pathname: string,
    params: QueryEntries,
    v2: boolean,
    defaultVersion: GridVersion = GRID_V1,
): string {
    const query = withGrid(params, v2, defaultVersion);
    return query ? `${pathname}?${query}` : pathname;
}
