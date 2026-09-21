// ─────────────────────────────────────────────────────────────────────────────
// THE PRICE LENS'S SETTINGS — pure, and deliberately dull.
//
// Everything in this file is arithmetic over the operator's own CHOICES: which
// window market is measured over, where the band cut-lines sit, what a band is
// called, and which colour stop a band lands on. **No kilogram, no share and no
// band membership is computed here.** Those come out of SQL through
// `fetchBlockingPriceLens` and are rendered verbatim — the project rule ("never
// calculate weighted averages or inventory balances in TypeScript") applies with
// full force to a lens whose whole job is to describe a price distribution, and
// `scripts/verify-blocking-lens-ui.ts` asserts that no lens file sums kg or
// derives a share.
//
// ── THE STORED VALUE IS UNTRUSTED ────────────────────────────────────────────
// It comes back from `user_table_settings`, which is a free-form jsonb bag with no
// CHECK constraint, and it may have been written by an older build, by a different
// browser, or by hand. `parsePriceLensSettings` therefore validates FIELD BY FIELD
// and falls back per field — never "one bad key, everything to defaults", because
// that would silently throw away four good settings for one typo. A band edge in
// particular ends up in a peso comparison AND in a class name, so it is checked for
// integrality and range, not merely for being a number.
//
// ── WHY THE CSS CLASSES ARE RAMP STOPS AND NOT BAND INDICES ──────────────────
// `globals.css` declares seven fixed stops, `.lens-band-0` (cheapest) …
// `.lens-band-6` (dearest). A lens with THREE bands must not use the first three
// stops — that would paint "above market" in the ramp's yellow and say nothing.
// `bandRampStop` maps (band index, band count) onto the ramp so the ends are always
// the ends: 3 bands → stops 0 · 3 · 6, 2 bands → 0 · 6, 7 bands → all seven.
//
// That mapping is now SHARED (`lens/lens-ramp.ts`), because the age lens needs the
// same arithmetic over a different colour scale — age is not cost, and tinting an old
// block red would read as "expensive". The three exports below stay here, as the
// price lens's own names for the COST ramp, so nothing that already imports them has
// to learn a second module; they delegate rather than restate.
// ─────────────────────────────────────────────────────────────────────────────

import { LENS_RAMP_STOPS, rampClass, rampStop, type LensRampId } from './lens-ramp';
import type { LensUnit } from './lens-shared';
import {
  BLOCKING_PRICE_LENS_DEFAULT_EDGES,
  BLOCKING_PRICE_LENS_MAX_EDGES,
  BLOCKING_TRAILING_DAYS_DEFAULT,
  BLOCKING_TRAILING_DAYS_MAX,
  BLOCKING_TRAILING_DAYS_MIN,
  type BlockingMarketBasisKey,
  type BlockingPriceBand,
} from '../types';

/** The lens's stable id — its `?lens=` value and its settings key. */
export const PRICE_LENS_ID = 'price';

/**
 * How many cut-lines a reader may move a band edge to, either side of R.
 *
 * ±50 is not a technical limit, it is a sanity one: raw charcoal trades in the
 * high ₱30s–₱40s, so an edge fifty pesos from market is already outside every
 * price the yard has ever seen and a hundred would only ever be a typo.
 */
export const PRICE_LENS_EDGE_MIN = -50;
export const PRICE_LENS_EDGE_MAX = 50;

/** How many colour stops `globals.css` declares (`.lens-band-0` … `-6`). */
export const PRICE_LENS_RAMP_STOPS = LENS_RAMP_STOPS;

/** This lens paints on the COST ramp — emerald (cheapest) → rose (dearest). */
export const PRICE_LENS_RAMP: LensRampId = 'cost';

/** Which window (or typed figure) "market" is measured over. */
export type PriceLensBasis = BlockingMarketBasisKey | 'manual';

/** What the band rows and the ratio bar are measured in. Shared with every lens. */
export type PriceLensUnit = LensUnit;

const BASIS_KEYS: readonly PriceLensBasis[] = [
  'this_month',
  'last_month',
  'last_3_months',
  'trailing_days',
  'manual',
];

/** Human labels for the "Market is" select, in the order it offers them. */
export const PRICE_LENS_BASIS_LABELS: Record<PriceLensBasis, string> = {
  this_month: "This month's deliveries",
  last_month: "Last month's deliveries",
  last_3_months: 'Last 3 months',
  trailing_days: 'Last N days',
  manual: 'Set a price',
};

export const PRICE_LENS_BASIS_ORDER: readonly PriceLensBasis[] = [
  'this_month',
  'last_month',
  'last_3_months',
  'trailing_days',
  'manual',
];

export interface PriceLensSettings {
  basis: PriceLensBasis;
  /** The N of `trailing_days`. Whole days, 1–400. */
  trailingDays: number;
  /** The typed ₱ for `manual`. `null` = not stated yet — never 0. */
  manualPrice: number | null;
  /** Whole-peso cut-lines relative to R, de-duplicated and ascending. */
  edgeOffsets: number[];
  /** `bandEdgeKey()` → the name the reader gave that band. */
  bandNames: Record<string, string>;
  unit: PriceLensUnit;
}

export const DEFAULT_PRICE_LENS_SETTINGS: PriceLensSettings = {
  basis: 'this_month',
  trailingDays: BLOCKING_TRAILING_DAYS_DEFAULT,
  manualPrice: null,
  edgeOffsets: [...BLOCKING_PRICE_LENS_DEFAULT_EDGES],
  bandNames: {},
  unit: 'kg',
};

// ── Edges ───────────────────────────────────────────────────────────────────

/**
 * De-duplicate and sort a cut-line list the way the server action does, dropping
 * anything that is not a whole number inside ±50.
 *
 * Silently DROPPING a junk element is right here and wrong in the action: this
 * function's input is a stored preference (salvage what is good), while the
 * action's input is a live request (refuse it, and say why). The two therefore
 * agree on the shape they produce and differ only in how they treat rubbish —
 * which is the correct asymmetry, not a second definition.
 */
export function normalizeEdgeOffsets(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const clean: number[] = [];
  for (const raw of input) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) continue;
    if (raw < PRICE_LENS_EDGE_MIN || raw > PRICE_LENS_EDGE_MAX) continue;
    clean.push(raw);
  }
  return Array.from(new Set(clean)).sort((a, b) => a - b);
}

/** Why an edge could not be added — a sentence for the panel, never a throw. */
export type EdgeChangeResult =
  | { ok: true; edgeOffsets: number[] }
  | { ok: false; message: string };

export function addEdgeOffset(current: readonly number[], offset: number): EdgeChangeResult {
  if (!Number.isFinite(offset) || !Number.isInteger(offset)) {
    return { ok: false, message: 'A cut line has to be a whole number of pesos from market.' };
  }
  if (offset < PRICE_LENS_EDGE_MIN || offset > PRICE_LENS_EDGE_MAX) {
    return {
      ok: false,
      message: `Keep a cut line within ₱${PRICE_LENS_EDGE_MAX} of market — further out than that and no block can ever be on the other side of it.`,
    };
  }
  if (current.includes(offset)) {
    return { ok: false, message: 'That cut line is already on the scale.' };
  }
  if (current.length >= BLOCKING_PRICE_LENS_MAX_EDGES) {
    return {
      ok: false,
      message: `A lens takes at most ${BLOCKING_PRICE_LENS_MAX_EDGES} cut lines (${BLOCKING_PRICE_LENS_MAX_EDGES + 1} bands). Remove one first.`,
    };
  }
  return { ok: true, edgeOffsets: normalizeEdgeOffsets([...current, offset]) };
}

export function removeEdgeOffset(current: readonly number[], offset: number): EdgeChangeResult {
  const next = current.filter((e) => e !== offset);
  if (next.length === current.length) {
    return { ok: false, message: 'That cut line is not on the scale.' };
  }
  // At least one edge must survive: with none there is one band holding the whole
  // yard, which is the same picture as no lens at all.
  if (next.length === 0) {
    return {
      ok: false,
      message:
        'A lens needs at least one cut line — with none, every block is in the same band and nothing is highlighted.',
    };
  }
  return { ok: true, edgeOffsets: normalizeEdgeOffsets(next) };
}

// ── Manual price ────────────────────────────────────────────────────────────

/** Parse the typed ₱. Positive, finite, at most 2 decimals — or a reason why not. */
export function parseManualPriceInput(
  text: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: 'Type a market price.' };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    if (/^\d*\.\d{3,}$/.test(trimmed)) {
      return { ok: false, message: 'A price carries at most two decimal places.' };
    }
    return { ok: false, message: 'That is not a price — use digits, e.g. 40.25.' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    // A ₱0 market would put every block above market, which is the one answer
    // that looks like a working lens and is not.
    return { ok: false, message: 'A market price has to be above zero.' };
  }
  return { ok: true, value };
}

function isStorableManualPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && Math.round(v * 100) === v * 100;
}

/**
 * THE TYPED CUT LINE — the ONE place a ₱ is rounded anywhere on the client.
 *
 * `R = floor(market) + 1` is right for a MEASURED market (40.23 → 41, so ₱41 and up is
 * above market) and **wrong for a price a human typed**: an operator who types ₱41 means
 * ₱41 and up is above market, and `floor(41) + 1` hands them 42 — a lens one peso looser
 * than the one they asked for. A typed 41 is not a measurement that happens to be whole,
 * **it IS the line.** So the `manual` basis sends `Math.ceil(typed)` as
 * `fetchBlockingPriceLens`'s third argument and the server uses it verbatim; every
 * MEASURED basis sends nothing and R stays computed in exactly one place, in SQL.
 *
 * It lives HERE, in the pure settings module, for two reasons the data layer's contract
 * states outright: `actions.ts` does no arithmetic (`verify-blocking-price-lens.ts`
 * asserts no `floor`/`ceil` exists in it), and this is the module that already owns every
 * decision the reader made. `Math.floor` remains banned in every lens file — the market
 * rule is SQL's — and `verify-blocking-lens-ui.ts` asserts this function is the single
 * `Math.ceil` in the directory.
 *
 * Returns `null` for anything that is not a usable price, so a caller passes nothing
 * rather than a fabricated line.
 */
export function manualRoundedUpPhp(price: number | null): number | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const r = Math.ceil(price);
  return r >= 1 ? r : null;
}

// ── Band identity, labels and colours ───────────────────────────────────────

/**
 * A band's identity for naming purposes: its two OFFSETS from R, not its index.
 *
 * Keying on the index would silently re-point every name the moment a cut line is
 * added below — the operator's "Cheap stock" label would jump to a different slice
 * of the yard. Keying on the offsets means a name follows its own interval and a
 * band whose interval no longer exists simply has no name, which is correct.
 * `*` stands for an OPEN end.
 */
export function bandEdgeKey(lowerOffset: number | null, upperOffset: number | null): string {
  return `${lowerOffset ?? '*'}:${upperOffset ?? '*'}`;
}

/** The band's offsets from R. Both bounds are integers by construction (R is). */
export function bandOffsets(
  band: Pick<BlockingPriceBand, 'lowerPhp' | 'upperPhp'>,
  roundedUpPhp: number,
): { lowerOffset: number | null; upperOffset: number | null } {
  return {
    lowerOffset: band.lowerPhp === null ? null : Math.round(band.lowerPhp - roundedUpPhp),
    upperOffset: band.upperPhp === null ? null : Math.round(band.upperPhp - roundedUpPhp),
  };
}

const PESO = '₱';

function whole(n: number): string {
  return `${PESO}${Math.round(n).toLocaleString()}`;
}

function money(n: number): string {
  return `${PESO}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * What a band is called.
 *
 * A name the reader typed always wins. Otherwise the three DEFAULT intervals get
 * the words the owner used — below market / at market / above market — and every
 * other interval gets a plain bound description. The "at market" form shows both
 * bounds to 2dp with the upper one as the last price actually IN the band
 * (`₱39.00 to ₱39.99`), because a half-open `[39, 40)` printed as "₱39 to ₱40"
 * reads as if ₱40 were inside it, and ₱40 is precisely what "above market" means.
 */
export function priceBandLabel(
  band: Pick<BlockingPriceBand, 'lowerPhp' | 'upperPhp'>,
  roundedUpPhp: number,
  names: Record<string, string> = {},
): string {
  const { lowerOffset, upperOffset } = bandOffsets(band, roundedUpPhp);
  const custom = names[bandEdgeKey(lowerOffset, upperOffset)];
  if (custom && custom.trim() !== '') return custom.trim();

  const { lowerPhp, upperPhp } = band;

  // Open above.
  if (upperPhp === null) {
    if (lowerPhp === null) return 'Every priced block';
    return lowerOffset === 0
      ? `Above market, ${whole(lowerPhp)} and up`
      : `${whole(lowerPhp)} and up`;
  }
  // Open below.
  if (lowerPhp === null) {
    return upperOffset === -1 ? `Below market, under ${whole(upperPhp)}` : `Under ${whole(upperPhp)}`;
  }
  // Two-sided.
  const range = `${money(lowerPhp)} to ${money(upperPhp - 0.01)}`;
  return lowerOffset === -1 && upperOffset === 0 ? `At market, ${range}` : range;
}

/**
 * Which `.lens-band-N` colour stop a band lands on — by POSITION across the ramp,
 * so the cheapest band is always the ramp's coolest end and the dearest its
 * hottest, whatever the band count. See the header note.
 */
export function bandRampStop(index: number, bandCount: number): number {
  return rampStop(index, bandCount);
}

/**
 * The class name for that stop on the COST ramp.
 *
 * It delegates to `lens-ramp.ts`, which is the one place either ramp's class prefix
 * is spelled — so nothing here, and nothing in a shared row, builds a class name by
 * concatenation.
 */
export function bandRampClass(index: number, bandCount: number): string {
  return rampClass(PRICE_LENS_RAMP, index, bandCount);
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Validate a stored settings document, FIELD BY FIELD, falling back per field.
 *
 * Anything unrecognised is dropped rather than trusted. An edge list that
 * normalises to empty (all junk, or over the cap) falls back to the shipped
 * default instead of leaving the lens with no bands at all.
 */
export function parsePriceLensSettings(raw: unknown): PriceLensSettings {
  const out: PriceLensSettings = {
    ...DEFAULT_PRICE_LENS_SETTINGS,
    edgeOffsets: [...DEFAULT_PRICE_LENS_SETTINGS.edgeOffsets],
    bandNames: {},
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;

  if (typeof rec.basis === 'string' && (BASIS_KEYS as readonly string[]).includes(rec.basis)) {
    out.basis = rec.basis as PriceLensBasis;
  }

  if (
    typeof rec.trailingDays === 'number' &&
    Number.isInteger(rec.trailingDays) &&
    rec.trailingDays >= BLOCKING_TRAILING_DAYS_MIN &&
    rec.trailingDays <= BLOCKING_TRAILING_DAYS_MAX
  ) {
    out.trailingDays = rec.trailingDays;
  }

  if (isStorableManualPrice(rec.manualPrice)) out.manualPrice = rec.manualPrice;

  const edges = normalizeEdgeOffsets(rec.edgeOffsets);
  if (edges.length > 0 && edges.length <= BLOCKING_PRICE_LENS_MAX_EDGES) out.edgeOffsets = edges;

  if (rec.bandNames && typeof rec.bandNames === 'object' && !Array.isArray(rec.bandNames)) {
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec.bandNames as Record<string, unknown>)) {
      // A name is rendered as TEXT, never as markup — but it is also capped, because
      // an unbounded string in a band row would push the panel's layout apart.
      if (typeof v !== 'string') continue;
      const name = v.trim().slice(0, 40);
      if (name === '') continue;
      if (!/^(-?\d+|\*):(-?\d+|\*)$/.test(k)) continue;
      names[k] = name;
    }
    out.bandNames = names;
  }

  if (rec.unit === 'kg' || rec.unit === 'blocks') out.unit = rec.unit;

  return out;
}

/**
 * The document to store — DEFAULTS OMITTED.
 *
 * `saveUserModuleSettings` REPLACES the row, so leaving a defaulted field out is
 * what makes "Reset to default" an actual removal rather than a value that lingers
 * and has to be recognised as default forever after.
 */
export function serializePriceLensSettings(s: PriceLensSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (s.basis !== DEFAULT_PRICE_LENS_SETTINGS.basis) body.basis = s.basis;
  if (s.trailingDays !== DEFAULT_PRICE_LENS_SETTINGS.trailingDays) body.trailingDays = s.trailingDays;
  if (s.manualPrice !== null) body.manualPrice = s.manualPrice;
  if (!sameEdges(s.edgeOffsets, DEFAULT_PRICE_LENS_SETTINGS.edgeOffsets)) {
    body.edgeOffsets = [...s.edgeOffsets];
  }
  if (Object.keys(s.bandNames).length > 0) body.bandNames = { ...s.bandNames };
  if (s.unit !== DEFAULT_PRICE_LENS_SETTINGS.unit) body.unit = s.unit;
  return body;
}

export function sameEdges(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Is anything off the shipped defaults? Drives the Reset affordance. */
export function isDefaultPriceLensSettings(s: PriceLensSettings): boolean {
  return Object.keys(serializePriceLensSettings(s)).length === 0;
}
