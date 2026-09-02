"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ROW ORDER — the reader's own sequence for one table group (owner feedback R5)
//
// Renzo: *"drag to reorder rows within their table metric group of course."*
//
// ── WHERE IT IS PERSISTED, AND WHY NOT THE URL ───────────────────────────────
// `localStorage`, keyed per SECTION. Every other view control on this page
// lives in the address bar (`year`, `g`, `wd`, `cmp`, `metric`, `hide`, `dict`,
// and R5's `bhide`) because each of them describes WHAT IS ON SCREEN — a link
// carrying one shows the recipient the same figures.
//
// A row order is not that. It describes how one reader likes to read, it
// changes no number, hides nothing and adds nothing, and pasting it into a
// colleague's browser would silently rearrange a page they had already learned
// the shape of. It is also long — eight to ten keys per section — and would
// dominate an address whose whole point is to be legible. So: per browser, per
// section, and never in a link.
//
// ── THE TWO PROPERTIES THAT KEEP IT HONEST ───────────────────────────────────
// 1. **It is read in an EFFECT, never during render.** The server renders the
//    registry order, so the first client paint must be the registry order too;
//    reading `localStorage` in a lazy `useState` initialiser would produce a
//    different tree on the client and a hydration mismatch. The saved order is
//    applied on the tick after mount, which is imperceptible and correct.
// 2. **A save is a preference, not a row list.** `resolveOrder` drops a key
//    that no longer names a row and appends a row the save never heard of, so a
//    row added in a later round cannot be hidden by an order set today. See
//    `lib/analytics/row-order.ts`.
//
// Storage failing is not an error state. A private window, a browser with site
// data blocked or a full quota all mean "this reader has no saved order", which
// is exactly the default — so every read and write is wrapped and a failure is
// silent by design.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import {
  dropKey,
  isDefaultOrder,
  moveKey,
  resolveOrder,
} from "@/lib/analytics/row-order";

/** Versioned, so a future change of shape cannot be read as this one. */
const STORAGE_PREFIX = "bw.analytics.roworder.v1.";

function read(scope: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + scope);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

function write(scope: string, order: readonly string[] | null) {
  try {
    if (order == null) window.localStorage.removeItem(STORAGE_PREFIX + scope);
    else window.localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(order));
  } catch {
    // A reader with storage blocked keeps the registry order for this session.
    // That is a degraded preference, never a degraded figure.
  }
}

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
  /** Stable per table group — `metrics:flow`, `campaign`, `grades`. */
  scope: string,
  /** The registry's own order. The authority on which rows exist. */
  defaults: readonly string[],
): RowOrder {
  const [saved, setSaved] = React.useState<readonly string[] | null>(null);

  // Property 1 above — after mount, never during render.
  React.useEffect(() => {
    setSaved(read(scope));
  }, [scope]);

  const order = React.useMemo(
    () => resolveOrder(defaults, saved),
    [defaults, saved],
  );

  const commit = React.useCallback(
    (next: readonly string[]) => {
      // A no-op move (a row already at the top being pushed up) returns the
      // same reference, so it never writes and never re-renders.
      if (next === order) return;
      setSaved(next);
      write(scope, next);
    },
    [order, scope],
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
    setSaved(null);
    write(scope, null);
  }, [scope]);

  return {
    order,
    custom: !isDefaultOrder(order, defaults),
    move,
    drop,
    reset,
  };
}
