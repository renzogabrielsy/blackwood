// ─────────────────────────────────────────────────────────────────────────────
// THE LENS COLOUR RAMPS — one table, and the only place a band class name is built.
//
// ── A RAMP IS A PROPERTY OF THE LENS, NOT OF THE FRAME ──────────────────────
// The price lens ramps emerald → amber → rose, because that is the conventional
// COST ramp and "red = dear" reads with no legend. The age lens must NOT reuse it:
// tinting an old block red would be read as "expensive", which is a different fact
// about a different column. So each registered lens declares a `ramp` id and every
// shared presentational piece derives its swatch class from THAT — nothing in the
// frame, and nothing in a shared component, knows the string `lens-band-`.
//
// ── STOPS, NOT BAND INDICES ─────────────────────────────────────────────────
// `globals.css` declares SEVEN fixed stops for each ORDINAL ramp (`.lens-band-0` … `-6`,
// `.lens-age-0` … `-6`). A lens with THREE bands must not use the first three —
// that would paint its dearest/oldest band in the ramp's middle and say nothing.
// `rampStop` maps (band index, band count) across the whole scale so the ends are
// always the ends: 3 bands → 0 · 3 · 6, 4 bands → 0 · 2 · 4 · 6, 2 bands → 0 · 6.
//
// ── AN ORDINAL RAMP IS A GRADIENT. A NOMINAL ONE IS A SET OF NAMES (2026-09-22) ──
// The SUPPLIER lens broke that rule, and it had to. Price and age bands are ORDERED,
// so "further along the scale" MEANS something and spreading N bands across seven stops
// is the right answer. Supplier bands are **nominal categories** — ORNALES is not
// "more" than PAQUIBOT — so a gradient would invite a reading that does not exist, and
// positional mapping would MOVE a supplier's colour the moment the reader changed N.
// So `category` declares THIRTEEN stops (twelve distinguishable hues + one NEUTRAL grey
// reserved for the `others` fold) and a band takes the stop matching its own rank, with
// `others` always on the grey. Two consequences worth knowing:
//
//   • `categoryStop(index, isOthers)` is how the supplier lens names its slot, and every
//     shared presentational piece accepts an explicit `rampStop` so it can pass it
//     through. `rampClass`/`rampRgb` stay the ONLY place a class name or triple is
//     built — there is no second class-name spelling anywhere.
//   • the twelve hues deliberately avoid emerald `16 185 129` and orange `249 115 22`,
//     which are `.spotlight-supplier-all` / `-some` (ALL vs SOME of a searched supplier).
//     Reusing either for band IDENTITY would collide with a meaning this page already
//     has. `scripts/verify-blocking-lens-ui.ts` asserts the absence of both triples.
//
// PURE: no React, no fetch, no tenant data — `scripts/verify-blocking-lens-ui.ts`
// calls these directly.
// ─────────────────────────────────────────────────────────────────────────────

/** Which colour scale a lens paints with. One entry per registered ramp in CSS. */
export type LensRampId = 'cost' | 'age' | 'category';

/** How many colour stops each ORDINAL ramp declares in `globals.css`. */
export const LENS_RAMP_STOPS = 7;

/** How many stops the NOMINAL ramp declares — 12 hues plus the neutral. */
export const LENS_CATEGORY_STOPS = 13;

/** The neutral grey slot, reserved for the `others` fold and nothing else. */
export const LENS_CATEGORY_NEUTRAL_STOP = LENS_CATEGORY_STOPS - 1;

/** Per-ramp stop count, so nothing has to know which ramps are ordinal. */
export const LENS_RAMP_STOP_COUNT: Record<LensRampId, number> = {
  cost: LENS_RAMP_STOPS,
  age: LENS_RAMP_STOPS,
  category: LENS_CATEGORY_STOPS,
};

/** Is this ramp a GRADIENT (positional) or a set of NAMES (identity)? */
export const LENS_RAMP_IS_ORDINAL: Record<LensRampId, boolean> = {
  cost: true,
  age: true,
  category: false,
};

/**
 * The CSS class prefix per ramp. THE only place any of these strings is spelled — a
 * lens panel or a shared row must never concatenate one itself.
 */
export const LENS_RAMP_CLASS_PREFIX: Record<LensRampId, string> = {
  cost: 'lens-band-',
  age: 'lens-age-',
  category: 'lens-cat-',
};

/**
 * THE SEVEN HUES PER RAMP, as `r g b` triples — the SAME values `globals.css`
 * declares as `--lens-hue` on `.lens-band-0…6` and `.lens-age-0…6`.
 *
 * ── WHY A SECOND COPY EXISTS, AND WHY IT CANNOT DRIFT ───────────────────────
 * On screen nothing needs it: a band's colour is the CSS class, and no component
 * spells one. But the blend proposal's printout is a **fully self-contained HTML
 * document printed in a hidden iframe** (`_shared/print-utils.ts`) — it has no
 * `globals.css`, so `.lens-band-3` means nothing inside it, and a printed group
 * header tinted by a class would come out white. The alternative — reading the
 * computed custom property off a probe element at print time — is a clever way to
 * make a document depend on the live DOM it was built to be independent of.
 *
 * So the triples are duplicated here, deliberately, and made PROVABLY equal rather
 * than assumed: `scripts/verify-blend-analysis-ui.ts` parses `globals.css` and
 * asserts every one of the fourteen matches. That is the project's standing answer to
 * a constant that must live in two places (CLAUDE.md, the client/server boundary
 * trap: duplicate it, then assert the copies match).
 */
export const LENS_RAMP_RGB: Record<LensRampId, readonly string[]> = {
  cost: [
    '16 185 129', // emerald — cheapest
    '132 204 22', // lime
    '234 179 8', // yellow
    '245 158 11', // amber
    '249 115 22', // orange
    '239 68 68', // red
    '225 29 72', // rose — dearest
  ],
  age: [
    '56 189 248', // sky — freshest
    '37 99 235', // blue
    '79 70 229', // indigo
    '124 58 237', // violet
    '147 51 234', // purple
    '192 38 211', // fuchsia
    '162 28 175', // deep fuchsia — oldest
  ],
  // THE NOMINAL RAMP — twelve distinguishable hues, then ONE NEUTRAL for `others`.
  // Neither emerald `16 185 129` nor orange `249 115 22` appears: those two are the
  // supplier SEARCH's ALL / SOME glow, and a band wearing one of them would collide
  // with a meaning the page already has.
  category: [
    '56 189 248', // sky
    '139 92 246', // violet
    '244 63 94', // rose
    '245 158 11', // amber
    '20 184 166', // teal
    '217 70 239', // fuchsia
    '132 204 22', // lime
    '99 102 241', // indigo
    '6 182 212', // cyan
    '236 72 153', // pink
    '234 179 8', // yellow
    '59 130 246', // blue
    '161 161 170', // zinc — the NEUTRAL, reserved for `others`
  ],
};

/**
 * Which stop a band lands on, by POSITION across an ORDINAL ramp.
 *
 * A NOMINAL ramp does not answer this question — a category has no position — so it
 * falls back to an identity mapping clamped short of the neutral slot, and the supplier
 * lens passes an explicit `categoryStop` instead. See the header note.
 */
export function rampStop(index: number, bandCount: number, ramp: LensRampId = 'cost'): number {
  if (!LENS_RAMP_IS_ORDINAL[ramp]) {
    return Math.max(0, Math.min(LENS_RAMP_STOP_COUNT[ramp] - 2, index));
  }
  const last = LENS_RAMP_STOP_COUNT[ramp] - 1;
  if (bandCount <= 1) return 0;
  const stop = Math.round((index * last) / (bandCount - 1));
  return Math.max(0, Math.min(last, stop));
}

/**
 * A NOMINAL band's own colour slot: its rank, or the reserved NEUTRAL for `others`.
 *
 * `others` is a fold of everyone the reader did not ask to see by name, so it must not
 * wear a hue that reads as one supplier's identity — and it must keep the SAME colour
 * whatever N is, which a positional mapping could not promise.
 */
export function categoryStop(index: number, isOthers: boolean): number {
  if (isOthers) return LENS_CATEGORY_NEUTRAL_STOP;
  return Math.max(0, Math.min(LENS_CATEGORY_NEUTRAL_STOP - 1, index));
}

/**
 * THE ONE RULE FOR "WHICH STOP DOES THIS BAND WEAR" — position, unless the lens said.
 *
 * Every shared presentational piece faces the same two-case question: an ORDINAL lens
 * leaves `rampStop` undefined and gets a position across the gradient, a NOMINAL one
 * states its own slot. The printed band table, the printed band headings and the printed
 * YARD MAP all need it, and two of them need a CLASS while the third needs an `r g b`
 * TRIPLE — so the case analysis lives here, once, and each caller pairs it with
 * `rampClassAtStop` or `rampRgbAtStop`. Written out per caller it is exactly the kind of
 * two-line duplicate that lets a swatch and a map cell disagree about one band's colour.
 */
export function resolveBandRampStop(
  ramp: LensRampId,
  index: number,
  bandCount: number,
  ownStop?: number,
): number {
  return ownStop === undefined ? rampStop(index, bandCount, ramp) : ownStop;
}

/** The class name for that stop on that ramp. */
export function rampClass(ramp: LensRampId, index: number, bandCount: number): string {
  return rampClassAtStop(ramp, rampStop(index, bandCount, ramp));
}

/**
 * The class name for a stop a caller has already decided.
 *
 * It exists so a NOMINAL lens can state its band's slot while the SHARED legend rows,
 * ratio bar and printed sheet keep calling exactly one class builder. The stop is
 * clamped to the ramp's own range, so a stale index can only ever be the wrong colour
 * and never an undeclared class.
 */
export function rampClassAtStop(ramp: LensRampId, stop: number): string {
  const clamped = Math.max(0, Math.min(LENS_RAMP_STOP_COUNT[ramp] - 1, Math.round(stop)));
  return `${LENS_RAMP_CLASS_PREFIX[ramp]}${clamped}`;
}

/**
 * The `r g b` triple for that stop — for a document that cannot reach `globals.css`
 * (the blend proposal's iframe printout). On screen use `rampClass`.
 */
export function rampRgb(ramp: LensRampId, index: number, bandCount: number): string {
  return rampRgbAtStop(ramp, rampStop(index, bandCount, ramp));
}

/** The triple for a stop a caller has already decided. The twin of `rampClassAtStop`. */
export function rampRgbAtStop(ramp: LensRampId, stop: number): string {
  const clamped = Math.max(0, Math.min(LENS_RAMP_STOP_COUNT[ramp] - 1, Math.round(stop)));
  return LENS_RAMP_RGB[ramp][clamped];
}
