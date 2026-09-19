// ─────────────────────────────────────────────────────────────────────────────
// THE BLOCKING LENS FRAME — the contract, and nothing else.
//
// A "lens" is a docked panel that decides how EVERY cell of the Blocking grid is
// marked. The Price lens (2026-09-19) is the first one; Supplier and Age are the
// two the owner named next. This file exists so a second lens is a REGISTRATION
// and not a rewrite: the frame knows a lens by four things — an id, a label, a
// `canShow` predicate, and a panel component — and the grid knows a lens by ONE
// thing, the classifier below.
//
// ── THE ONE SEAM: A CLASSIFIER, NOT A CLASS MAP ──────────────────────────────
// The grid asks a function "how is this block marked?", block by block. It is a
// FUNCTION rather than a `Record<block_loc, string>` for a reason: a lens knows
// things the grid must not have to learn — that an UNPRICED block is in no band
// (and must therefore keep its normal, un-lensed style rather than be painted as
// the cheapest one, the L-008 mistake in a new costume), that an EMPTY slot is
// dimmed, that "nothing selected" means "show every band". Encoding that as a map
// would force the grid to know which absences mean "dim" and which mean "leave
// alone".
//
// ── A LENS OWNS ITS OWN STATE AND PUBLISHES THE RESULT UPWARD ────────────────
// Each lens is a self-contained component: it fetches its own data, holds its own
// settings, and hands the frame a classifier through `onClassifierChange`. It is
// deliberately NOT a hook on the definition object — the frame renders one lens at
// a time, and calling `activeLens.useController()` out of a registry would change
// which hook runs when the active lens changes, which is a rules-of-hooks
// violation. Mounting and unmounting a component is the legal way to swap.
//
// This module is PURE: types plus one resolver. No React, no fetch, no tenant
// data — so `scripts/verify-blocking-lens-ui.ts` can read it, and so a lens body
// can import it without dragging the frame in.
// ─────────────────────────────────────────────────────────────────────────────

import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { BlockData } from '../types';

/** A lens's stable identity — also its `?lens=` value and its settings key. */
export type BlockingLensId = string;

/**
 * How one cell is marked by the active lens.
 *
 * `dimmed` wins over `className`: a dimmed cell is out of focus, and a glow ring
 * on a 30%-opacity cell reads as neither. Returning `null` from the classifier
 * means **leave this cell exactly as it would look with no lens open** — which is
 * a third answer, distinct from both "marked" and "dimmed", and is what an
 * unpriced block gets.
 */
export interface BlockingLensClassification {
  className?: string;
  dimmed?: boolean;
}

/** `block_loc` → how it is marked. `null` = leave the cell un-lensed. */
export type BlockingLensClassifier = (
  blockLoc: string,
) => BlockingLensClassification | null;

/**
 * What the page can offer, which is what `canShow` decides against.
 *
 * `canViewPrices` is the grid's EFFECTIVE flag (`serverCanViewPrices && showPrices`)
 * — the same value every other ₱ decision on this page reads. A lens whose whole
 * output is price information gates on it; a future Supplier or Age lens will not,
 * which is exactly why this is a predicate per lens and not one flag on the frame.
 */
export interface BlockingLensCapabilities {
  canViewPrices: boolean;
}

/** Props every lens panel body receives from the frame. */
export interface BlockingLensPanelProps {
  /** The live grid map. A lens READS it; it never mutates it. */
  data: Record<string, BlockData>;
  caps: BlockingLensCapabilities;
  /**
   * Publish the classifier the grid consumes. Call with `null` to un-lens the
   * grid while keeping the panel open (e.g. nothing measurable yet).
   */
  onClassifierChange: (classifier: BlockingLensClassifier | null) => void;
  /**
   * Close the whole panel. A lens calls this when it has become unusable — the
   * price lens does so on a `prices_hidden` refusal, quietly and with no toast,
   * because that is a fact about the reader and not an error they can act on.
   */
  onRequestClose: () => void;
}

/**
 * One registered lens.
 *
 * To add the second one: write a panel body that takes `BlockingLensPanelProps`,
 * export a definition of this shape, and push it into `BLOCKING_LENSES` in
 * `registry.tsx`. Nothing in `blocking-grid.tsx` changes — the tab strip, the
 * docking, the persistence key, the Escape handling and the mutual exclusivity
 * with the status/supplier spotlights are all the frame's, not the lens's.
 */
export interface BlockingLensDefinition {
  id: BlockingLensId;
  /** Tab label and panel title. */
  label: string;
  icon: LucideIcon;
  /** One short line under the title — what this lens answers. */
  blurb: string;
  /** May this lens be offered to this reader at all? */
  canShow: (caps: BlockingLensCapabilities) => boolean;
  Panel: ComponentType<BlockingLensPanelProps>;
}

/**
 * Turn a classification into the cell class the grid applies, or `null` for
 * "un-lensed" so a caller can keep using a `??` chain against the supplier and
 * status spotlights.
 *
 * `.spotlight-dimmed` is REUSED rather than cloned — it is the one definition of
 * "out of focus" on this grid, and a second dimming rule would eventually drift
 * from it.
 */
export function resolveLensCellClass(
  classifier: BlockingLensClassifier | null,
  locKey: string,
): string | null {
  if (!classifier) return null;
  const marked = classifier(locKey);
  if (!marked) return null;
  if (marked.dimmed) return 'spotlight-dimmed';
  return marked.className ?? null;
}
