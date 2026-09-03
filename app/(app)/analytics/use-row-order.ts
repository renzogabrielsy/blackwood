"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ROW ORDER — the reader's own sequence for one table group (owner feedback R5)
//
// Renzo: *"drag to reorder rows within their table metric group of course."*
//
// ── WHERE IT IS PERSISTED, AND WHY NOT THE URL ───────────────────────────────
// A row order is not a description of what is on screen. It describes how one
// reader likes to read, it changes no number, hides nothing and adds nothing,
// and pasting it into a colleague's browser would silently rearrange a page
// they had already learned the shape of. It is also long — eight to ten keys
// per section — and would dominate an address whose whole point is to be
// legible. So: per reader, per section, and never in a link.
//
// ── R10 MOVED THE STORAGE, NOT THE ARITHMETIC ────────────────────────────────
// It used to own a `localStorage` key per scope (`bw.analytics.roworder.v2.<scope>`).
// The sequences now live inside the ONE analytics preference record
// (`use-analytics-prefs.ts`) under `rowOrder[scope]`, which adds two things this
// hook could not have on its own: a per-USER copy in `user_table_settings`, so a
// reorder follows the reader to another browser, and one Reset that clears every
// analytics preference at once instead of one section at a time. The old
// per-scope keys — v2 AND R5's original v1 — are still read once by that store's
// legacy fold, so nobody loses an order they already set.
//
// **The interface below is unchanged**, so `analytics-matrix.tsx` needed no edit.
//
// ── THE TWO PROPERTIES THAT KEEP IT HONEST ───────────────────────────────────
// 1. **It is read in an EFFECT, never during render.** The server renders the
//    registry order, so the first client paint must be the registry order too;
//    reading storage in a lazy `useState` initialiser would produce a different
//    tree on the client and a hydration mismatch. That effect now lives in the
//    store, once for every preference, rather than here once per scope.
// 2. **A save is a preference, not a row list.** `resolveOrder` drops a key
//    that no longer names a row and appends a row the save never heard of, so a
//    row added in a later round cannot be hidden by an order set today. See
//    `lib/analytics/row-order.ts`.
//
// Storage failing is not an error state — a private window, blocked site data
// or a full quota all mean "this reader has no saved order", which is exactly
// the default. Every read and write is wrapped in the store, and a failure is
// silent by design.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  dropKey,
  isDefaultOrder,
  moveKey,
  resolveOrder,
} from "@/lib/analytics/row-order";
import { useAnalyticsPrefs } from "./use-analytics-prefs";

export interface RowOrder {
  /** The keys to render, in order. Always covers every default key exactly once. */
  order: readonly string[];
  /** The reader has moved something — the only state in which `Reset` is offered. */
  custom: boolean;
  /** Nudge one row up (`-1`) or down (`+1`). The keyboard path. */
  move(key: string, delta: number): void;
  /** Drop one row onto another. The pointer path. */
  drop(key: string, target: string): void;
  reset(): void;
}

export function useRowOrder(
  /** Stable per table group — `metrics:flow`, `metrics:campaigns`, `grades`. */
  scope: string,
  /** The registry's own order. The authority on which rows exist. */
  defaults: readonly string[],
): RowOrder {
  const { prefs, patch } = useAnalyticsPrefs();
  const saved = prefs.rowOrder[scope] ?? null;

  const order = React.useMemo(
    () => resolveOrder(defaults, saved),
    [defaults, saved],
  );

  const commit = React.useCallback(
    (next: readonly string[]) => {
      // A no-op move (a row already at the top being pushed up) returns the
      // same reference, so it never writes and never re-renders.
      if (next === order) return;
      patch({ rowOrder: { ...prefs.rowOrder, [scope]: [...next] } });
    },
    [order, patch, prefs.rowOrder, scope],
  );

  const move = React.useCallback(
    (key: string, delta: number) => commit(moveKey(order, key, delta)),
    [commit, order],
  );

  const drop = React.useCallback(
    (key: string, target: string) => commit(dropKey(order, key, target)),
    [commit, order],
  );

  const reset = React.useCallback(() => {
    // Absent, not empty: an empty array would be a saved order that says
    // nothing, and `resolveOrder` would have to treat it as the registry's
    // anyway. Removing the scope is what makes "reset" and "never touched"
    // the same state — the store's rule 4.
    const next = { ...prefs.rowOrder };
    delete next[scope];
    patch({ rowOrder: next });
  }, [patch, prefs.rowOrder, scope]);

  return {
    order,
    custom: !isDefaultOrder(order, defaults),
    move,
    drop,
    reset,
  };
}
