// ─────────────────────────────────────────────────────────────────────────────
// SHARED LENS VOCABULARY — the handful of things every lens on this frame needs.
//
// It exists so the SECOND lens is not a fork of the first. A duplicated formatter
// is how two lenses on one page end up printing "10,469,899 kg" and "10469899 kg"
// side by side, and a duplicated debounce is how one of them costs a round-trip per
// keystroke while the other does not.
//
// ── IT FORMATS. IT DOES NOT COMPUTE. ────────────────────────────────────────
// Every kilogram, share and weighted figure a lens shows comes out of SQL and is
// rendered verbatim. Nothing here sums, divides by a total or averages anything —
// `Math.round` for display is the whole of its arithmetic, and
// `scripts/verify-blocking-lens-ui.ts` asserts the absence of the rest.
// ─────────────────────────────────────────────────────────────────────────────

/** How long a settings change waits before it costs a round-trip. Both lenses. */
export const LENS_DEBOUNCE_MS = 250;

/** The one em dash on this frame — "we don't know", never a zero. */
export const LENS_EMDASH = '—';

/** What a band row and the ratio bar are measured in. Shared by every lens. */
export type LensUnit = 'kg' | 'blocks';

/** `1,275,018 kg`. Rounded for DISPLAY only — the payload keeps full precision. */
export function formatLensKg(n: number): string {
  return `${Math.round(n).toLocaleString()} kg`;
}

/** `12.2%`, or an em dash when the server said NULL (no population to share out). */
export function formatLensSharePct(v: number | null): string {
  return v === null ? LENS_EMDASH : `${v.toFixed(1)}%`;
}

/** `396.7` days, one decimal. Null reads as an em dash — never `0`. */
export function formatLensDays(v: number | null, decimals = 1): string {
  return v === null
    ? LENS_EMDASH
    : v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** `1,176 days` / `1 day`. Whole days, for a headline that has no room for a decimal. */
export function formatLensWholeDays(v: number | null): string {
  if (v === null) return LENS_EMDASH;
  const rounded = Math.round(v);
  return `${rounded.toLocaleString()} day${rounded === 1 ? '' : 's'}`;
}

/** `22 blocks` / `1 block`. */
export function formatLensBlocks(n: number): string {
  return `${n.toLocaleString()} block${n === 1 ? '' : 's'}`;
}
