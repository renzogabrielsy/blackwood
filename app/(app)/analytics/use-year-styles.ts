"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE READER'S OWN YEAR COLOURS AND STROKES (owner feedback R9, 2026-09-03)
//
// Renzo: *"solid line, dotted, area line, etc of differing colors (which we can
// also customize and set)"*.
//
// ── WHY IT IS PAGE-WIDE AND NOT PER CARD ────────────────────────────────────
// A year is the SAME entity in every expand on this page. If 2025 were orange on
// the Purchase volume card and green on the Yield card, the reader would have to
// re-learn the legend at every row — and re-learning a legend is the one thing a
// fixed axis with a year per series exists to avoid. So the store is keyed by
// YEAR ALONE, one record for the whole page, and every mounted expand reads the
// same one live.
//
// ── R10 MOVED THE STORAGE, NOT THE SHAPE ────────────────────────────────────
// This hook used to own a `localStorage` key of its own
// (`bw.analytics.yearstyle.v1`) plus a same-tab broadcast. Both now live in
// `use-analytics-prefs.ts`, which persists the SAME `YearStyleMap` alongside
// every other analytics preference and adds the per-user copy in
// `user_table_settings` — so a colour set on the office machine is the colour
// on the laptop. The old key is still READ, once, by that store's legacy fold,
// so nobody loses a palette they already set.
//
// **The interface below is unchanged**, which is why `metric-expand.tsx` and
// `year-style-menu.tsx` needed no edit for this: the same-tab liveness they
// depend on is now the store's subscriber set rather than this file's, and it
// covers every preference instead of one.
//
// The storage disciplines are unchanged too and are documented once, in the
// store: read in an EFFECT (hydration), every read and write wrapped, and the
// stored value treated as UNTRUSTED — `parseYearStyles` in
// `lib/analytics/year-overlay.ts` still validates every field and drops
// anything it did not write, because a colour goes straight into a `style`
// attribute and an arbitrary string there is not a styling bug.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  pruneYearStyles,
  type YearLineStyle,
  type YearStyleMap,
} from "@/lib/analytics/year-overlay";
import { useAnalyticsPrefs } from "./use-analytics-prefs";

/** Kept exported for the store's legacy fold and for anything still naming it. */
export { LEGACY_YEAR_STYLE_KEY as YEAR_STYLE_KEY } from "@/lib/analytics/prefs";

export interface YearStyleStore {
  styles: YearStyleMap;
  setColor(year: number, color: string | null): void;
  setStyle(year: number, style: YearLineStyle | null): void;
  /** Put ONE year back to the palette default. */
  resetYear(year: number): void;
  /** Put every year back. Styles only — the page-wide Reset lives in the shell. */
  resetAll(): void;
  /** Anything at all is overridden — drives whether Reset is offered. */
  customised: boolean;
}

export function useYearStyles(): YearStyleStore {
  const { prefs, patch } = useAnalyticsPrefs();
  const styles = prefs.yearStyles;

  const apply = React.useCallback(
    (year: number, part: { color?: string | null; style?: YearLineStyle | null }) => {
      const key = String(year);
      const entry = { ...(styles[key] ?? {}) };
      if ("color" in part) {
        if (part.color == null) delete entry.color;
        else entry.color = part.color;
      }
      if ("style" in part) {
        if (part.style == null) delete entry.style;
        else entry.style = part.style;
      }
      const next: Record<string, typeof entry> = { ...styles };
      if (entry.color || entry.style) next[key] = entry;
      else delete next[key];
      patch({ yearStyles: pruneYearStyles(next) });
    },
    [patch, styles],
  );

  return {
    styles,
    setColor: React.useCallback(
      (year, color) => apply(year, { color }),
      [apply],
    ),
    setStyle: React.useCallback(
      (year, style) => apply(year, { style }),
      [apply],
    ),
    resetYear: React.useCallback(
      (year) => apply(year, { color: null, style: null }),
      [apply],
    ),
    resetAll: React.useCallback(() => patch({ yearStyles: {} }), [patch]),
    customised: Object.keys(styles).length > 0,
  };
}
