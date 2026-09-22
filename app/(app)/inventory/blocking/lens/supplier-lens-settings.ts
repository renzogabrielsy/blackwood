// ─────────────────────────────────────────────────────────────────────────────
// THE SUPPLIER LENS'S SETTINGS — pure, and deliberately dull.
//
// There are exactly TWO choices to store: how many suppliers are named before the
// `others` fold, and whether the ratio is measured in kilograms or in blocks. **No
// kilogram, no share, no dominance and no band membership is computed here.** Those come
// out of SQL through `fetchBlockingSupplierLens` and are rendered verbatim — the project
// rule ("never calculate weighted averages or inventory balances in TypeScript") applies
// with full force, and `scripts/verify-blocking-lens-ui.ts` asserts that no lens file
// sums a kilogram or derives a share.
//
// ── THERE ARE NO BAND NAMES, AND THAT IS NOT AN OMISSION ────────────────────
// Price and age bands are INTERVALS the reader chose, so they need naming — "Cheap
// stock", "Feed these first". A supplier band already has a name: the supplier's. Letting
// a reader rename ORNALES to something else would let the legend disagree with the yard
// about whose charcoal it is, and the `others` band's label belongs to the UI (the
// payload deliberately carries `key: null` / `display: null` there and does NOT name it).
// So there is no `bandNames` document and nothing keyed on a band identity.
//
// ── NO PRICE GATE, AND THAT IS THE POINT ────────────────────────────────────
// Nothing in this lens is money and none of it is derivable into money — a supplier's
// name beside a kilogram total says nothing about what it cost — so the Supplier lens is
// offered to EVERY role including Production, the one that actually walks the yard. See
// `types.ts` → "Supplier lens" and `scripts/verify-blocking-supplier-lens.ts`, which
// asserts the ABSENCE of a `canViewPrices` call in the action.
//
// ── `normalizeTopN` IS THE PURE TWIN OF THE ACTION'S OWN GUARD ──────────────
// `actions.ts` carries `'use server'`, so its synchronous validation cannot leave the
// file. This is the copy the UI uses, and the two agree on the SHAPE they accept — a
// whole number in 1…12 — while differing on how they treat rubbish, which is the correct
// asymmetry: here the input is a STORED PREFERENCE, so salvage what is good and fall
// back; there it is a LIVE REQUEST, so refuse it and say why (`invalid_top_n`).
// ─────────────────────────────────────────────────────────────────────────────

import {
  BLOCKING_SUPPLIER_LENS_DEFAULT_TOP_N,
  BLOCKING_SUPPLIER_LENS_MAX_TOP_N,
  BLOCKING_SUPPLIER_LENS_MIN_TOP_N,
  type BlockingSupplierBand,
} from '../types';
import { categoryStop, rampClassAtStop, type LensRampId } from './lens-ramp';
import type { LensUnit } from './lens-shared';

/** The lens's stable id — its `?lens=` value and its settings key. */
export const SUPPLIER_LENS_ID = 'supplier';

/**
 * Suppliers are NOMINAL categories, so this lens paints on the CATEGORY ramp.
 *
 * Not the cost ramp and not the age ramp: both are gradients, and a gradient over
 * supplier names would invite a reading ("further along = more of something") that does
 * not exist. See `lens-ramp.ts` for why the category ramp is identity-mapped and why its
 * twelve hues avoid the supplier search's emerald and orange.
 */
export const SUPPLIER_LENS_RAMP: LensRampId = 'category';

export interface SupplierLensSettings {
  /** How many suppliers are named before the `others` fold. 1…12. */
  topN: number;
  unit: LensUnit;
}

export const DEFAULT_SUPPLIER_LENS_SETTINGS: SupplierLensSettings = {
  topN: BLOCKING_SUPPLIER_LENS_DEFAULT_TOP_N,
  unit: 'kg',
};

// ── Top N ───────────────────────────────────────────────────────────────────

/** A whole number in 1…12, or `null` for "not a usable preference". */
export function normalizeTopN(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isFinite(input) || !Number.isInteger(input)) return null;
  if (input < BLOCKING_SUPPLIER_LENS_MIN_TOP_N || input > BLOCKING_SUPPLIER_LENS_MAX_TOP_N) {
    return null;
  }
  return input;
}

/** Why a top-N could not be accepted — a sentence for the panel, never a throw. */
export type TopNChangeResult =
  | { ok: true; topN: number }
  | { ok: false; message: string };

export function setTopN(value: number): TopNChangeResult {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, message: 'How many suppliers to name has to be a whole number.' };
  }
  if (value < BLOCKING_SUPPLIER_LENS_MIN_TOP_N) {
    return {
      ok: false,
      message: `Name at least ${BLOCKING_SUPPLIER_LENS_MIN_TOP_N} supplier — with none, every block is in the same band and nothing is highlighted.`,
    };
  }
  if (value > BLOCKING_SUPPLIER_LENS_MAX_TOP_N) {
    return {
      ok: false,
      message: `The ramp carries ${BLOCKING_SUPPLIER_LENS_MAX_TOP_N} distinguishable colours, so ${BLOCKING_SUPPLIER_LENS_MAX_TOP_N} is the most that can be named apart. The rest are grouped as Others.`,
    };
  }
  return { ok: true, topN: value };
}

/** Parse the typed N. A whole number, or a reason why not. */
export function parseTopNInput(
  text: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: 'Type how many suppliers to name.' };
  if (!/^\d{1,2}$/.test(trimmed)) {
    return {
      ok: false,
      message: `A whole number between ${BLOCKING_SUPPLIER_LENS_MIN_TOP_N} and ${BLOCKING_SUPPLIER_LENS_MAX_TOP_N}.`,
    };
  }
  return { ok: true, value: Number(trimmed) };
}

// ── Band labels and colours ─────────────────────────────────────────────────

/**
 * What a band is called.
 *
 * A named band is its SUPPLIER — the payload's `display`, a representative raw spelling,
 * never the matching key. **The `others` label is the UI's**: the payload carries
 * `key: null` / `display: null` there on purpose and does not name the fold, so the
 * count comes from `supplierCount` and reads `Others (11)` — a reader has to be able to
 * tell "one supplier called Others" from "eleven suppliers we did not name".
 */
export function supplierBandLabel(
  band: Pick<BlockingSupplierBand, 'isOthers' | 'display' | 'key' | 'supplierCount'>,
): string {
  if (band.isOthers) return `Others (${band.supplierCount})`;
  return band.display ?? band.key ?? 'Unnamed supplier';
}

/**
 * Which `.lens-cat-N` slot a band wears — its RANK, or the reserved neutral grey for
 * `others`.
 *
 * Identity, not position: a supplier's colour must not move when the reader changes how
 * many are named, and the fold must not wear a hue that reads as one supplier's identity.
 */
export function supplierBandRampStop(
  band: Pick<BlockingSupplierBand, 'index' | 'isOthers'>,
): number {
  return categoryStop(band.index, band.isOthers);
}

/** The class name for that slot. Built by `lens-ramp.ts` and nowhere else. */
export function supplierBandRampClass(
  band: Pick<BlockingSupplierBand, 'index' | 'isOthers'>,
): string {
  return rampClassAtStop(SUPPLIER_LENS_RAMP, supplierBandRampStop(band));
}

/**
 * The extra class a MIXED block's cell wears — see `globals.css` → the SUPPLIER lens's
 * MIXED marker for why it is a dashed INSET OUTLINE and not a badge.
 *
 * Spelled here once so no panel concatenates it, exactly as no panel concatenates a
 * ramp class.
 */
export const SUPPLIER_LENS_MIXED_CLASS = 'lens-cat-mixed';

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Validate a stored settings document, FIELD BY FIELD, falling back per field.
 *
 * It comes back from `user_table_settings`, a free-form jsonb bag with no CHECK
 * constraint, possibly written by an older build or by hand. Never "one bad key,
 * everything to defaults" — that throws away a good setting for one typo.
 */
export function parseSupplierLensSettings(raw: unknown): SupplierLensSettings {
  const out: SupplierLensSettings = { ...DEFAULT_SUPPLIER_LENS_SETTINGS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;

  const topN = normalizeTopN(rec.topN);
  if (topN !== null) out.topN = topN;

  if (rec.unit === 'kg' || rec.unit === 'blocks') out.unit = rec.unit;

  return out;
}

/**
 * The document to store — DEFAULTS OMITTED.
 *
 * `saveUserModuleSettings` REPLACES the row, so leaving a defaulted field out is what
 * makes "Reset to default" an actual removal rather than a value that lingers and has to
 * be recognised as default forever after.
 */
export function serializeSupplierLensSettings(s: SupplierLensSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (s.topN !== DEFAULT_SUPPLIER_LENS_SETTINGS.topN) body.topN = s.topN;
  if (s.unit !== DEFAULT_SUPPLIER_LENS_SETTINGS.unit) body.unit = s.unit;
  return body;
}

/** Is anything off the shipped defaults? Drives the Reset affordance. */
export function isDefaultSupplierLensSettings(s: SupplierLensSettings): boolean {
  return Object.keys(serializeSupplierLensSettings(s)).length === 0;
}
