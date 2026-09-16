// ═════════════════════════════════════════════════════════════════════════════════
// HOW WIDE A `/operations` MODAL IS — ONE definition, shared by every dialog on the
// screen.
//
// Renzo, 2026-09-16, reading the shipped page on a 1080p 24" monitor: *"The modal is
// causing shrinkage and overflowing of the table UIs. The space can be MUCH better
// utilized considering how much space we have… It should also occupy the space that
// is available so it can be viewed on any device."*
//
// He is describing a real defect and not a preference. `sm:max-w-4xl` is **896px**,
// and the ACTUAL FED PRICE table is twelve columns wide — so on a 1920px screen the
// dialog clamped itself to less than the table needed, the table scrolled sideways
// INSIDE it, and every header that did not fit ellipsised (`BLOCK PRICE ₱…`,
// `RESIKO LO…`) while ~900px of monitor sat empty on either side.
//
// ── THE RULE ────────────────────────────────────────────────────────────────────
// A dialog is sized to **what it holds**, clamped to **what the viewport has**:
//
//     width = min(96vw, content width + padding, OPS_MODAL_MAX_WIDTH)
//
// so it is exactly as wide as its table on a large screen, never wider than the
// viewport on a small one, and never so wide on an ultrawide that a reader has to
// track a line across a metre of glass. `96vw` (not `100vw`) keeps the overlay
// visible on both sides, which is what tells a reader the thing is a dialog.
//
// **THE CONTENT WIDTH IS NEVER A LITERAL.** Every caller passes the Σ of its own
// declared column widths — `blocksTableWidth()`, `productionTablesWidth()` — so a
// column that grows cannot leave the dialog behind, which is precisely how the
// truncation above survived three rounds of review. (That Σ is column-width
// bookkeeping, i.e. layout — the one arithmetic this screen permits.)
//
// HEIGHT is the same idea on the other axis and needs no per-caller number: every
// modal is `max-h-[92vh]` with the header, the formula line, the result bar and the
// caveats pinned, and the TABLE — the only part that can be arbitrarily long — is
// the flexible child that scrolls. See {@link OPS_MODAL_BODY} for why it is
// `flex-auto` and never `flex-1`.
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * The ceiling, in px. Beyond roughly this a table stops being scannable — the eye
 * loses the row on the way back — and no table on this screen is wider: the widest,
 * ACTUAL FED PRICE at twelve columns, measures well under it.
 */
export const OPS_MODAL_MAX_WIDTH = 1720;

/** The dialog's own horizontal padding (`sm:p-5` → 20px a side) plus its 1px border. */
export const OPS_MODAL_PADDING = 44;

/** A modal with no table — the inputs list. Comfortable for a two-column list. */
export const OPS_MODAL_NARROW = 560;

/**
 * `width` / `maxWidth` for a `DialogContent`.
 *
 * Inline, because it has to beat `DialogContent`'s own `w-full max-w-[calc(…)]
 * sm:max-w-lg` — and a style property beats every class, so there is no ordering
 * game to lose. `maxWidth: 96vw` is what makes the phone case work: the width
 * expression already clamps to `96vw`, and the second clamp is the belt to its
 * braces for a browser that resolves `min()` late.
 */
export function opsModalWidth(contentWidth: number): { width: string; maxWidth: string } {
  const capped = Math.min(Math.round(contentWidth), OPS_MODAL_MAX_WIDTH);
  return { width: `min(96vw, ${capped}px)`, maxWidth: 'min(96vw, 100%)' };
}

/**
 * The `DialogContent` class list every `/operations` modal shares.
 *
 * `flex` beats the primitive's `grid`, `gap-3` its `gap-4`, `p-4 sm:p-5` its `p-6`
 * and `max-h-[92vh]` its safe-area clamp — all through `tw-merge`, which resolves
 * each of those by utility GROUP rather than by source order.
 */
export const OPS_MODAL_CONTENT =
  // `transition-none` is NOT cosmetic. `DialogContent` carries `duration-200` for its
  // entrance animation, and `transition-property`'s CSS INITIAL VALUE is `all` — so a
  // duration with no explicit property list makes EVERY property transition, WIDTH
  // included. With the dialog's width now varying per modal, re-opening on a wider
  // table would animate a layout property over 200ms, which CLAUDE.md forbids
  // outright ("never animate width/height — these trigger layout recalculation").
  // Killing the transition does not touch the animation: `animate-in` reads its
  // duration from `--tw-duration`, which `duration-200` sets separately.
  'flex max-h-[92vh] flex-col gap-2.5 overflow-hidden p-4 transition-none sm:p-5';

/**
 * The scrolling middle of a modal.
 *
 * **`flex-auto`, NEVER `flex-1`.** `flex-1` is `flex: 1 1 0%`, so the child's
 * hypothetical main size is ZERO; in a container whose own height is `auto` (which
 * is every one of these dialogs — they are only *clamped* at 92vh, never fixed) the
 * container then measures itself as if the child were empty and the child collapses
 * to nothing. `flex-auto` is `flex: 1 1 auto`: the hypothetical size is the content,
 * so a short table sizes the dialog to itself and a long one is shrunk by the clamp
 * — and `min-h-0` is what allows that shrink to go below the content at all.
 */
export const OPS_MODAL_BODY = 'flex min-h-0 flex-auto flex-col';
