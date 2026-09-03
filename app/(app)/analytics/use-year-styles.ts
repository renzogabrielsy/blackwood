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
// same one live (`window` event + a same-tab broadcast, below).
//
// ── STORAGE DISCIPLINE, COPIED FROM `use-row-order.ts` ──────────────────────
//   • read in an EFFECT, never a lazy initialiser — the server renders the
//     default palette, so touching storage during render is a hydration
//     mismatch;
//   • every read and write wrapped — a private window or blocked site data means
//     "no saved styles", which is the default palette and a working page;
//   • the value is UNTRUSTED. `parseYearStyles` in `lib/analytics/year-overlay.ts`
//     validates every field and drops anything it did not write, because a colour
//     goes straight into a `style` attribute and an arbitrary string there is
//     not a styling bug.
//
// ── THE SAME-TAB BROADCAST ──────────────────────────────────────────────────
// The browser's own `storage` event fires in OTHER tabs only. Two expands can be
// open at once on this page (the RC Inventory matrix and the campaign table), so
// a change made in one must reach the other in THIS tab — hence the tiny
// subscriber set. It is a module-level `Set`, not context: the two rooms are
// mounted by different components under no common provider, and threading a
// provider through the page for a preference would be more machinery than the
// preference.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  parseYearStyles,
  pruneYearStyles,
  type YearLineStyle,
  type YearStyleMap,
} from "@/lib/analytics/year-overlay";

export const YEAR_STYLE_KEY = "bw.analytics.yearstyle.v1";

type Listener = (next: YearStyleMap) => void;
const listeners = new Set<Listener>();

function broadcast(next: YearStyleMap) {
  for (const l of listeners) l(next);
}

function read(): YearStyleMap {
  try {
    return parseYearStyles(window.localStorage.getItem(YEAR_STYLE_KEY));
  } catch {
    return {};
  }
}

function write(next: YearStyleMap) {
  try {
    const pruned = pruneYearStyles(next);
    if (Object.keys(pruned).length === 0) {
      window.localStorage.removeItem(YEAR_STYLE_KEY);
    } else {
      window.localStorage.setItem(YEAR_STYLE_KEY, JSON.stringify(pruned));
    }
  } catch {
    // A blocked store is not an error the reader can act on. The session keeps
    // the choice in memory; it simply will not survive a reload.
  }
}

export interface YearStyleStore {
  styles: YearStyleMap;
  setColor(year: number, color: string | null): void;
  setStyle(year: number, style: YearLineStyle | null): void;
  /** Put ONE year back to the palette default. */
  resetYear(year: number): void;
  /** Put every year back. */
  resetAll(): void;
  /** Anything at all is overridden — drives whether Reset is offered. */
  customised: boolean;
}

export function useYearStyles(): YearStyleStore {
  const [styles, setStyles] = React.useState<YearStyleMap>({});

  React.useEffect(() => {
    setStyles(read());
    const onLocal: Listener = (next) => setStyles(next);
    listeners.add(onLocal);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === YEAR_STYLE_KEY) setStyles(read());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const commit = React.useCallback((next: YearStyleMap) => {
    const pruned = pruneYearStyles(next);
    write(pruned);
    broadcast(pruned);
  }, []);

  const patch = React.useCallback(
    (year: number, part: { color?: string | null; style?: YearLineStyle | null }) => {
      setStyles((prev) => {
        const key = String(year);
        const entry = { ...(prev[key] ?? {}) };
        if ("color" in part) {
          if (part.color == null) delete entry.color;
          else entry.color = part.color;
        }
        if ("style" in part) {
          if (part.style == null) delete entry.style;
          else entry.style = part.style;
        }
        const next: Record<string, typeof entry> = { ...prev };
        if (entry.color || entry.style) next[key] = entry;
        else delete next[key];
        commit(next);
        return next;
      });
    },
    [commit],
  );

  return {
    styles,
    setColor: React.useCallback(
      (year, color) => patch(year, { color }),
      [patch],
    ),
    setStyle: React.useCallback(
      (year, style) => patch(year, { style }),
      [patch],
    ),
    resetYear: React.useCallback(
      (year) => patch(year, { color: null, style: null }),
      [patch],
    ),
    resetAll: React.useCallback(() => {
      setStyles(() => {
        commit({});
        return {};
      });
    }, [commit]),
    customised: Object.keys(styles).length > 0,
  };
}
