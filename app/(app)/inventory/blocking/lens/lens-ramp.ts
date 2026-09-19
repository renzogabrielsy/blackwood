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
