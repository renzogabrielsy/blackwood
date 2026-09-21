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
// `globals.css` declares SEVEN fixed stops per ramp (`.lens-band-0` … `-6`,
// `.lens-age-0` … `-6`). A lens with THREE bands must not use the first three —
// that would paint its dearest/oldest band in the ramp's middle and say nothing.
// `rampStop` maps (band index, band count) across the whole scale so the ends are
// always the ends: 3 bands → 0 · 3 · 6, 4 bands → 0 · 2 · 4 · 6, 2 bands → 0 · 6.
//
// PURE: no React, no fetch, no tenant data — `scripts/verify-blocking-lens-ui.ts`
// calls these directly.
// ─────────────────────────────────────────────────────────────────────────────

/** Which colour scale a lens paints with. One entry per registered ramp in CSS. */
export type LensRampId = 'cost' | 'age';

/** How many colour stops each ramp declares in `globals.css`. */
export const LENS_RAMP_STOPS = 7;

/**
 * The CSS class prefix per ramp. THE only place either string is spelled — a lens
 * panel or a shared row must never concatenate one itself.
 */
export const LENS_RAMP_CLASS_PREFIX: Record<LensRampId, string> = {
  cost: 'lens-band-',
  age: 'lens-age-',
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
};

/** Which stop (0…6) a band lands on, by POSITION across the ramp. */
export function rampStop(index: number, bandCount: number): number {
  const last = LENS_RAMP_STOPS - 1;
  if (bandCount <= 1) return 0;
  const stop = Math.round((index * last) / (bandCount - 1));
  return Math.max(0, Math.min(last, stop));
}

/** The class name for that stop on that ramp. */
export function rampClass(ramp: LensRampId, index: number, bandCount: number): string {
  return `${LENS_RAMP_CLASS_PREFIX[ramp]}${rampStop(index, bandCount)}`;
}

/**
 * The `r g b` triple for that stop — for a document that cannot reach `globals.css`
 * (the blend proposal's iframe printout). On screen use `rampClass`.
 */
export function rampRgb(ramp: LensRampId, index: number, bandCount: number): string {
  return LENS_RAMP_RGB[ramp][rampStop(index, bandCount)];
}
