// =====================================================================
// ICTC Owner Analytics — THE READER'S OWN SETTINGS (owner feedback R10)
// =====================================================================
// Renzo, 2026-09-03, verbatim: *"Currently, the style selections for the charts
// in analytics has no sense of memory or permanence when it comes to user
// selection. Every choice is made back to default when switching around
// different charts and rows and from a refresh. I would much rather it
// remembers the last settings used per user."*
//
// ── WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────
// It is the SHAPE of the saved settings and the arithmetic over that shape:
// what a default is, how an untrusted stored value is read, how a stale value
// is pruned, and how the three older `localStorage` keys become one record.
// It is PURE and client-safe — no React, no `window`, no Supabase — for the
// same reason `row-order.ts` and `year-overlay.ts` are: a settings bug should
// be readable and provable without mounting anything, and every one of these
// functions has to run against a value that arrived from a browser store
// (untrusted, possibly stale, possibly written by an older build).
//
// The STORAGE (localStorage + the per-user row in `user_table_settings`) lives
// in `app/(app)/analytics/use-analytics-prefs.ts`. The split is the same one
// `row-order.ts` / `use-row-order.ts` already draws.
//
// ── THE FOUR RULES A SAVED SETTING OBEYS ──────────────────────────────
//
// 1. **A stored value is UNTRUSTED.** Everything is validated field by field
//    and anything unrecognised is DROPPED rather than trusted — a colour goes
//    straight into a `style` attribute, and a comparison mode goes into a fold.
//    `parseAnalyticsPrefs` never throws and never returns a partial shape: a
//    corrupt record degrades to the defaults, which is a working page.
//
// 2. **A saved setting is a PREFERENCE, never a fact about the data.** A year
//    the payload no longer carries is PRUNED (`pruneAnalyticsPrefs`), a row key
//    that no longer names a row is dropped by `resolveOrder`, and a year that
//    appears for the first time is simply not mentioned — so a preference set
//    today can never hide a row or a year added tomorrow.
//
// 3. **The URL still wins wherever the URL speaks.** `?year=`, `?hide=`,
//    `?bhide=` and `?metric=` are never stored here: they describe WHAT IS ON
//    SCREEN, and a link carrying one is a statement its recipient must see
//    exactly. What IS stored is the three toggles the URL only spells in their
//    NON-default state (`wd`, `cmp`, `dict`) — and there the URL still wins
//    when it is present; the preference only answers the question the address
//    left silent.
//
// 4. **A default must be expressible as "nothing stored".** Every field has a
//    default here, and `isDefaultPrefs` is what the Reset affordance reads —
//    so "I have never chosen anything" and "I chose the defaults" are the same
//    state, and there is no way to end up with an invisible saved value that
//    behaves differently from a fresh browser.
//
// ── WHY `expandHiddenYears` IS `null` RATHER THAN `[]` ────────────────
// `[]` means "the reader has every year switched on"; `null` means "the reader
// has never said". They are DIFFERENT, and the difference is load-bearing:
// R4's smart default opens a row with its empty years already switched off,
// and that default must keep working for a reader who has never touched the
// control. Collapsing the two would either kill the smart default for everyone
// or resurrect it over an explicit "show me all of them". Same NULL ≠ 0
// discipline the SQL layer applies to an unpriced delivery.
// =====================================================================

import type { ComparisonMode } from "./matrix";
import {
  parseYearStyles,
  pruneYearStyles,
  type YearStyleMap,
} from "./year-overlay";

/**
 * The `localStorage` key AND the `user_table_settings.module` value.
 *
 * Versioned like `bw.analytics.roworder.v2.` is, so a future change of shape
 * cannot be read as this one. The module key is NOT versioned — the DB row is
 * one per user per module and a shape change is handled by the parser, which
 * drops what it does not recognise.
 */
export const ANALYTICS_PREFS_KEY = "bw.analytics.prefs.v1";
export const ANALYTICS_PREFS_MODULE = "analytics";

/** The legacy keys R10 folds in. Read once, then left alone — see `migrate`. */
export const LEGACY_YEAR_STYLE_KEY = "bw.analytics.yearstyle.v1";
export const LEGACY_ROW_ORDER_PREFIX = "bw.analytics.roworder.v2.";
/** R5's original prefix, before R8 bumped it. Read too — a reader may hold either. */
export const LEGACY_ROW_ORDER_PREFIX_V1 = "bw.analytics.roworder.v1.";

export interface AnalyticsPrefs {
  /** R9 — year colour + stroke overrides, keyed by year. `{}` = the palette. */
  yearStyles: YearStyleMap;
  /**
   * R9/R10 — the years switched OFF in the expand charts, PAGE-WIDE.
   * `null` = never chosen, so each card applies R4's smart default.
   */
  expandHiddenYears: readonly string[] | null;
  /** R4 — the price overlay on an expand card. Default OFF, as asked. */
  showOverlay: boolean;
  /** R3 — the trailing-average line on an expand card. Default ON. */
  showAvg: boolean;
  /** R1 — what the second chip under every value says. */
  comparison: ComparisonMode;
  /** The per-working-day normalisation. */
  perWorkingDay: boolean;
  /** R3 — the master Definitions switch. */
  showDictionary: boolean;
  /** R5 — the reader's row sequence, per section scope. */
  rowOrder: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_ANALYTICS_PREFS: AnalyticsPrefs = Object.freeze({
  yearStyles: {},
  expandHiddenYears: null,
  showOverlay: false,
  showAvg: true,
  comparison: "yoy" as ComparisonMode,
  perWorkingDay: false,
  showDictionary: true,
  rowOrder: {},
});

const YEAR_RE = /^\d{4}$/;
/** A scope is a code-authored literal (`metrics:flow`); anything else is junk. */
const SCOPE_RE = /^[a-z0-9:_-]{1,64}$/i;
/** A row key is a registry key. Bounded so a hostile store cannot be a payload. */
const ROW_KEY_RE = /^[a-z0-9_.:-]{1,64}$/i;
/** Bounds, so a corrupt or hostile store can never become a large render. */
const MAX_YEARS = 64;
const MAX_SCOPES = 32;
const MAX_ROWS_PER_SCOPE = 128;

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strList(v: unknown, re: RegExp, cap: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string" || !re.test(item)) continue;
    seen.add(item);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

/**
 * Read an UNTRUSTED value — a `localStorage` string, or the `settings` jsonb
 * this user's `user_table_settings` row hands back — into the full shape.
 *
 * Never throws. Every field falls back to its default independently, so one
 * corrupt key costs one setting rather than all of them.
 */
export function parseAnalyticsPrefs(raw: unknown): AnalyticsPrefs {
  let src: unknown = raw;
  if (typeof raw === "string") {
    if (!raw) return { ...DEFAULT_ANALYTICS_PREFS };
    try {
      src = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_ANALYTICS_PREFS };
    }
  }
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return { ...DEFAULT_ANALYTICS_PREFS };
  }
  const o = src as Record<string, unknown>;

  // `parseYearStyles` is THE validator for a year style and takes a string, so
  // an object arriving from jsonb is re-serialised into it rather than
  // re-implemented here. One definition, whichever door the value came in.
  const yearStyles: YearStyleMap =
    typeof o.yearStyles === "string"
      ? parseYearStyles(o.yearStyles)
      : o.yearStyles && typeof o.yearStyles === "object"
        ? parseYearStyles(JSON.stringify(o.yearStyles))
        : {};

  const expandHiddenYears =
    o.expandHiddenYears === null || o.expandHiddenYears === undefined
      ? null
      : strList(o.expandHiddenYears, YEAR_RE, MAX_YEARS);

  const rowOrder: Record<string, readonly string[]> = {};
  if (o.rowOrder && typeof o.rowOrder === "object" && !Array.isArray(o.rowOrder)) {
    let scopes = 0;
    for (const [scope, value] of Object.entries(o.rowOrder as Record<string, unknown>)) {
      if (!SCOPE_RE.test(scope)) continue;
      const keys = strList(value, ROW_KEY_RE, MAX_ROWS_PER_SCOPE);
      if (!keys || keys.length === 0) continue;
      rowOrder[scope] = keys;
      scopes += 1;
      if (scopes >= MAX_SCOPES) break;
    }
  }

  return {
    yearStyles,
    expandHiddenYears,
    showOverlay: bool(o.showOverlay, DEFAULT_ANALYTICS_PREFS.showOverlay),
    showAvg: bool(o.showAvg, DEFAULT_ANALYTICS_PREFS.showAvg),
    comparison:
      o.comparison === "actual" || o.comparison === "yoy"
        ? o.comparison
        : DEFAULT_ANALYTICS_PREFS.comparison,
    perWorkingDay: bool(o.perWorkingDay, DEFAULT_ANALYTICS_PREFS.perWorkingDay),
    showDictionary: bool(o.showDictionary, DEFAULT_ANALYTICS_PREFS.showDictionary),
    rowOrder,
  };
}

/**
 * Drop what the payload no longer knows about — rule 2.
 *
 * `knownYears` is the page's own year list (`AnalyticsData.years`), so a year
 * that has left the data cannot sit in a hidden set forever, and a year style
 * for a year nobody can chart is not carried around. It is called with the
 * page's list, NEVER with one card's — a card knows only its own row's years,
 * and pruning against that would delete the reader's choice about every OTHER
 * row the moment they opened a short one.
 *
 * Returns the SAME object when nothing moved, so a caller can skip a write.
 */
export function pruneAnalyticsPrefs(
  prefs: AnalyticsPrefs,
  knownYears: readonly number[],
): AnalyticsPrefs {
  if (knownYears.length === 0) return prefs;
  const known = new Set(knownYears.map((y) => String(y)));

  const styles: Record<string, YearStyleMap[string]> = {};
  let stylesMoved = false;
  for (const [year, v] of Object.entries(prefs.yearStyles)) {
    if (known.has(year)) styles[year] = v;
    else stylesMoved = true;
  }

  let hidden = prefs.expandHiddenYears;
  let hiddenMoved = false;
  if (hidden) {
    const kept = hidden.filter((y) => known.has(y));
    if (kept.length !== hidden.length) {
      hiddenMoved = true;
      hidden = kept;
    }
  }

  if (!stylesMoved && !hiddenMoved) return prefs;
  return { ...prefs, yearStyles: styles, expandHiddenYears: hidden };
}

/** Is this record the shipped default? Drives the Reset affordance. */
export function isDefaultPrefs(prefs: AnalyticsPrefs): boolean {
  const d = DEFAULT_ANALYTICS_PREFS;
  if (Object.keys(pruneYearStyles(prefs.yearStyles)).length > 0) return false;
  if (prefs.expandHiddenYears !== null) return false;
  if (prefs.showOverlay !== d.showOverlay) return false;
  if (prefs.showAvg !== d.showAvg) return false;
  if (prefs.comparison !== d.comparison) return false;
  if (prefs.perWorkingDay !== d.perWorkingDay) return false;
  if (prefs.showDictionary !== d.showDictionary) return false;
  if (Object.keys(prefs.rowOrder).length > 0) return false;
  return true;
}

/**
 * The wire form — what goes into `localStorage` and into the jsonb column.
 *
 * Empty collections are OMITTED rather than written as `{}`/`[]`, so a
 * defaulted record serialises to `{}` and rule 4 holds on the wire as well as
 * in memory. `expandHiddenYears` is the exception: `[]` is a real, different
 * answer from absent (see the header), so an empty array IS written.
 */
export function serializeAnalyticsPrefs(prefs: AnalyticsPrefs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const styles = pruneYearStyles(prefs.yearStyles);
  if (Object.keys(styles).length > 0) out.yearStyles = styles;
  if (prefs.expandHiddenYears !== null) out.expandHiddenYears = [...prefs.expandHiddenYears];
  if (prefs.showOverlay !== DEFAULT_ANALYTICS_PREFS.showOverlay) out.showOverlay = prefs.showOverlay;
  if (prefs.showAvg !== DEFAULT_ANALYTICS_PREFS.showAvg) out.showAvg = prefs.showAvg;
  if (prefs.comparison !== DEFAULT_ANALYTICS_PREFS.comparison) out.comparison = prefs.comparison;
  if (prefs.perWorkingDay !== DEFAULT_ANALYTICS_PREFS.perWorkingDay) {
    out.perWorkingDay = prefs.perWorkingDay;
  }
  if (prefs.showDictionary !== DEFAULT_ANALYTICS_PREFS.showDictionary) {
    out.showDictionary = prefs.showDictionary;
  }
  if (Object.keys(prefs.rowOrder).length > 0) out.rowOrder = prefs.rowOrder;
  return out;
}

/**
 * Fold the three pre-R10 `localStorage` keys into one record — the ONE-TIME
 * migration, run only when no R10 record exists yet.
 *
 * Nobody loses what they already set: a reader who spent R9 picking year
 * colours and R5 dragging rows keeps both, and the old keys are left ALONE
 * rather than deleted — a rollback to the previous build must still find them,
 * and an orphan key costs a few hundred bytes in one browser.
 *
 * `entries` is the browser's whole `localStorage` as key/value pairs, passed in
 * rather than read here, because this module never touches `window`.
 */
export function migrateLegacyPrefs(
  entries: readonly (readonly [string, string])[],
): AnalyticsPrefs {
  const out: AnalyticsPrefs = { ...DEFAULT_ANALYTICS_PREFS };
  const rowOrder: Record<string, readonly string[]> = {};
  for (const [key, value] of entries) {
    if (key === LEGACY_YEAR_STYLE_KEY) {
      out.yearStyles = parseYearStyles(value);
      continue;
    }
    const prefix = key.startsWith(LEGACY_ROW_ORDER_PREFIX)
      ? LEGACY_ROW_ORDER_PREFIX
      : key.startsWith(LEGACY_ROW_ORDER_PREFIX_V1)
        ? LEGACY_ROW_ORDER_PREFIX_V1
        : null;
    if (!prefix) continue;
    const scope = key.slice(prefix.length);
    // v2 wins over v1 for the same scope — R8 bumped the version precisely
    // because the older array names rows that may no longer exist.
    if (prefix === LEGACY_ROW_ORDER_PREFIX_V1 && rowOrder[scope]) continue;
    if (!SCOPE_RE.test(scope)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    const keys = strList(parsed, ROW_KEY_RE, MAX_ROWS_PER_SCOPE);
    if (keys && keys.length > 0) rowOrder[scope] = keys;
  }
  out.rowOrder = rowOrder;
  return out;
}

/**
 * Which of the two stored copies to open with.
 *
 * `localStorage` wins whenever it exists, because every write goes there FIRST
 * and to the database on a 500 ms debounce — so the local copy is never older
 * than the remote one for the browser that made the change, and a tab closed
 * inside the debounce window would otherwise silently lose the last thing the
 * reader did. The database copy is what a SECOND browser (or a cleared cache)
 * reads, which is the whole reason it exists.
 */
export function chooseStoredPrefs(
  local: AnalyticsPrefs | null,
  remote: AnalyticsPrefs | null,
): AnalyticsPrefs {
  return local ?? remote ?? { ...DEFAULT_ANALYTICS_PREFS };
}
