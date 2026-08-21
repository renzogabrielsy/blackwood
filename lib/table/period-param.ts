// ─────────────────────────────────────────────────────────────────────────────────
// `?year=` + `?month=` — the PERIOD axis. PLATFORM LAYER, pure.
//
// A dense sheet is read one period at a time. Every module that has grown a period
// control so far grew its own: a footer strip with twelve buttons here, two popovers
// there, a `?m=` param counted from ZERO in one place and a month NAME in another. Three
// spellings of one question is three chances for two screens to disagree about what a
// URL means — the same argument `grid-param.ts` makes about `?grid=`, and the reason this
// module exists beside it rather than inside a page.
//
// ── The axis, stated once ───────────────────────────────────────────────────────
//   `?year=2026`   a calendar year        `?year=all`    every year
//   `?month=8`     a calendar month, **1–12, ONE-based**  `?month=all`  every month
//
// **One-based, deliberately.** The live table's `?m=` is zero-based because it was a
// JavaScript `Date.getMonth()` leaking into a URL — `?m=7` means AUGUST, which is wrong
// to every human who has ever read it and to the `yyyy-MM` text the rows are stored in.
// This axis is the month a person would say. The two params are independent: `?m=` is
// still the live table's and is untouched by anything here.
//
// ── An unrecognised value means the PAGE'S DEFAULT ──────────────────────────────
// `?month=`, `?month=13`, `?month=aug` and absence are the same answer, exactly as
// `resolveGrid` treats `?grid=3`. There is no way to type a URL that half-selects a
// period, and a page states its own default once, at the single place it reads the param.
//
// ── Comparison is TEXT, never a Date ────────────────────────────────────────────
// `inPeriod` slices `yyyy-MM-dd` and compares digits. Parsing a stored date back into a
// `Date` to ask which month it is in is the classic place a timezone quietly moves a row
// to the previous day — the live table string-slices for the same reason, and so does
// every grid that consumes this.
//
// ── Purity ──────────────────────────────────────────────────────────────────────
// No React, no Next, no Supabase, no tenant knowledge — `scripts/verify-table-core.ts`
// enforces all four with a source scan over this directory.
// ─────────────────────────────────────────────────────────────────────────────────

/** The query param that scopes a screen to a calendar year. */
export const PERIOD_YEAR_PARAM = 'year';

/** The query param that narrows a screen to one calendar month WITHIN that year. */
export const PERIOD_MONTH_PARAM = 'month';

/**
 * "Every one of them", for either axis — the value a URL carries and the value a control
 * shows. A single spelling shared by both params, so a page never has to remember whether
 * it was `all` here and `_all` there.
 */
export const PERIOD_ALL = 'all';

/** A year scope: a calendar year, or every year. */
export type PeriodYear = number | typeof PERIOD_ALL;

/** A month scope: a calendar month **1–12**, or every month. */
export type PeriodMonth = number | typeof PERIOD_ALL;

/**
 * A raw param as it arrives from either side of the boundary: a server component's
 * `searchParams` hands over `string | string[] | undefined` (a repeated param is an
 * array), a client's `URLSearchParams.get()` hands over `string | null`.
 */
export type PeriodParam = string | string[] | null | undefined;

/** A repeated param arrives as an array — take the first, the way every axis here does. */
function one(v: PeriodParam): string | undefined {
    if (v === null || v === undefined) return undefined;
    return Array.isArray(v) ? v[0] : v;
}

/**
 * What the URL SAID about the year: a number, `PERIOD_ALL`, or `null` for "it did not
 * say". `null` is not a scope — `resolvePeriodYear` is the one that answers with one.
 */
export function parsePeriodYear(raw: PeriodParam): PeriodYear | null {
    const v = one(raw);
    if (v === undefined || v === '') return null;
    if (v === PERIOD_ALL) return PERIOD_ALL;
    // A year is four digits and nothing else. `parseInt('2026abc')` would happily answer
    // 2026, which is how a typo becomes a scope nobody asked for.
    if (!/^\d{4}$/.test(v)) return null;
    const n = Number(v);
    return n >= 1900 && n <= 9999 ? n : null;
}

/**
 * What the URL SAID about the month: **1–12**, `PERIOD_ALL`, or `null` for "it did not
 * say". `0` and `13` are refused rather than clamped: a clamp turns a typo into a silent
 * wrong answer, and the whole point of the default is that it is reachable by accident.
 */
export function parsePeriodMonth(raw: PeriodParam): PeriodMonth | null {
    const v = one(raw);
    if (v === undefined || v === '') return null;
    if (v === PERIOD_ALL) return PERIOD_ALL;
    if (!/^\d{1,2}$/.test(v)) return null;
    const n = Number(v);
    return n >= 1 && n <= 12 ? n : null;
}

/** What the page SHOWS: the URL's answer when it gave one, else the page's own default. */
export function resolvePeriodYear(raw: PeriodParam, defaultYear: PeriodYear): PeriodYear {
    return parsePeriodYear(raw) ?? defaultYear;
}

/** What the page SHOWS: the URL's answer when it gave one, else the page's own default. */
export function resolvePeriodMonth(raw: PeriodParam, defaultMonth: PeriodMonth): PeriodMonth {
    return parsePeriodMonth(raw) ?? defaultMonth;
}

/**
 * The `yyyy-MM` head of a stored `yyyy-MM-dd`, or `''` when the row carries no date.
 *
 * Two undated rows therefore compare equal and group together, which is what keeps a
 * grouped sheet from growing a heading per missing date.
 */
export function periodKeyOf(dateText: string | null | undefined): string {
    return (dateText ?? '').slice(0, 7);
}

/**
 * **THE definition of "does this row belong to the selected period."** Both consumers of
 * this axis call it rather than re-slicing the string, so a grid and its totals can never
 * disagree about which rows are on screen.
 *
 * A row with NO DATE is excluded from any narrowed period and included in `all`/`all` —
 * it belongs to no month, and quietly filing it under the one currently selected would
 * make a total that cannot be reproduced by looking at the rows.
 */
export function inPeriod(
    dateText: string | null | undefined,
    year: PeriodYear,
    month: PeriodMonth,
): boolean {
    if (year === PERIOD_ALL && month === PERIOD_ALL) return true;
    const key = periodKeyOf(dateText);
    if (key.length < 7) return false;
    if (year !== PERIOD_ALL && key.slice(0, 4) !== String(year)) return false;
    if (month !== PERIOD_ALL && Number(key.slice(5, 7)) !== month) return false;
    return true;
}

/** The number of distinct `yyyy-MM` groups a narrowed period can contain: 1, or many. */
export function isSinglePeriod(year: PeriodYear, month: PeriodMonth): boolean {
    return year !== PERIOD_ALL && month !== PERIOD_ALL;
}

/**
 * Anything that can enumerate `[name, value]` pairs: a `URLSearchParams`, Next's
 * `ReadonlyURLSearchParams`, or a plain array of tuples. Typed structurally so this
 * module never has to name a framework type.
 */
export type PeriodQueryEntries = Iterable<[string, string]>;

/** The period a link means, and the period a paramless URL already means. */
export interface PeriodSelection {
    year: PeriodYear;
    month: PeriodMonth;
}

/**
 * The current query string with the two period params SET, and **every other param
 * carried over untouched** — the same clause that is the whole point of `withGrid`.
 *
 * A period control that dropped the screen's tab, grid, search or column filters would
 * change two things at once and land the operator somewhere they did not ask to be. So
 * the copy is exhaustive and order-preserving, and it uses `append` so a legitimately
 * repeated param survives as a repeat.
 *
 * ── `defaults` keeps the URL CANONICAL ──────────────────────────────────────────
 * A param is written only when it says something the page does not already say, so **the
 * page's own default period is always the paramless URL** and a clean link into the
 * screen reads as the default state rather than as a scope somebody chose.
 *
 * Note the page's default month may itself be derived from the data (the newest month
 * that has any). That is deliberate — "open on the month worth reading" is the behaviour
 * — and it means a paramless URL follows the data forward. Any period a person actually
 * PICKED that differs from it is written out, so a link they copied still means what it
 * meant.
 *
 * Returns the query string WITHOUT a leading `?`, empty when there is nothing to carry.
 */
export function withPeriod(
    params: PeriodQueryEntries,
    next: PeriodSelection,
    defaults: PeriodSelection,
): string {
    const out = new URLSearchParams();
    for (const [key, value] of params) {
        // The two params this function owns. Dropped on the way through and re-added
        // below only when they say something, so `?year=2026&year=2026` is unreachable
        // and the default state leaves no empty param behind.
        if (key === PERIOD_YEAR_PARAM || key === PERIOD_MONTH_PARAM) continue;
        out.append(key, value);
    }
    if (next.year !== defaults.year) out.append(PERIOD_YEAR_PARAM, String(next.year));
    if (next.month !== defaults.month) out.append(PERIOD_MONTH_PARAM, String(next.month));
    return out.toString();
}

/**
 * `withPeriod` as a full href. The `?` is emitted only when there is a query, so the
 * DEFAULT state of a screen with no other params is the screen's own clean URL.
 */
export function periodHref(
    pathname: string,
    params: PeriodQueryEntries,
    next: PeriodSelection,
    defaults: PeriodSelection,
): string {
    const query = withPeriod(params, next, defaults);
    return query ? `${pathname}?${query}` : pathname;
}
