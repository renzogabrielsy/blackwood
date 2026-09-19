// ─────────────────────────────────────────────────────────────────────────────
// THE LENS REGISTRY — the whole list, in one array.
//
// ADDING THE SECOND LENS IS THIS FILE PLUS ONE PANEL COMPONENT. Nothing in
// `blocking-grid.tsx`, `blocking-route-view.tsx` or `globals.css` has to move:
//
//   1. write `lens/<id>-lens-panel.tsx` exporting a component that takes
//      `BlockingLensPanelProps` and publishes a classifier through
//      `onClassifierChange`;
//   2. export a `BlockingLensDefinition` beside it (`id`, `label`, `icon`,
//      `blurb`, `canShow`, `Panel`);
//   3. add it to `BLOCKING_LENSES` below.
//
// The frame then gives it a tab, the docking, per-user settings under
// `blocking_lens_<id>`, the Escape handling, the `?lens=<id>` deep link and the
// mutual exclusivity with the status / supplier spotlights, for free.
//
// ── `canShow` IS A UI DECISION, NEVER THE SECURITY BOUNDARY ──────────────────
// The Price lens reads `caps.canViewPrices`, so a Production user is never offered
// it — but the two server actions behind it refuse a `!canViewPrices()` caller
// outright, before touching the database, and THAT is the boundary. A lens with no
// ₱ (Supplier, Age) will read `() => true`, at which point the Highlight button
// stays visible for every role and only the Price tab is absent. That is why the
// predicate lives per lens and not as one flag on the frame.
// ─────────────────────────────────────────────────────────────────────────────

import { PRICE_LENS } from './price-lens-panel';
import type { BlockingLensCapabilities, BlockingLensDefinition, BlockingLensId } from './types';

/** Every lens the Blocking page knows about, in tab order. */
export const BLOCKING_LENSES: readonly BlockingLensDefinition[] = [PRICE_LENS];

/** The lenses this reader may be offered. Order is preserved. */
export function visibleLenses(caps: BlockingLensCapabilities): BlockingLensDefinition[] {
  return BLOCKING_LENSES.filter((l) => l.canShow(caps));
}

/**
 * Resolve a `?lens=` value (or a remembered id) against what this reader may see.
 *
 * A lens id that is unknown, or that this reader may not be offered, resolves to
 * `null` rather than to the first lens — a Production user landing on a shared
 * `?lens=price` link must get the page, not a substitute lens they did not ask for.
 */
export function resolveLens(
  id: BlockingLensId | null | undefined,
  caps: BlockingLensCapabilities,
): BlockingLensDefinition | null {
  if (!id) return null;
  const found = BLOCKING_LENSES.find((l) => l.id === id);
  if (!found) return null;
  return found.canShow(caps) ? found : null;
}
