# Shared Print — the platform's printing primitives

## Purpose

Everything the app needs to turn a piece of the screen into a sheet of paper, with **ZERO
tenant knowledge**. Per CLAUDE.md's layer rule, code under `components/shared/` may not
know what charcoal, a campaign, a block or a peso is — so this folder knows only that a
page is a rectangle, a monospace glyph has an advance width, and a table has to fit inside
both. Everything domain-shaped (WHICH columns, HOW many characters each needs, what the
labels say) is decided by the caller and handed in as numbers.

Two reports use it today — `/analytics` (where `printCard` and `GroupPrintStage` were
born) and `/operations` — and RC Movement's printed matrix (2026-09-17) is the third, which
is what pulled the *geometry* half out into `print-fit.ts`.

## Files

| File | Lines | Role |
|------|-------|------|
| `print-card.ts` | ~79 | **The MECHANISM.** `printCard(el)` marks the element `data-print-card`, tags every ancestor up to `<body>` `data-print-ancestor`, adds `bw-printing` to `<body>`, calls `window.print()`, and takes all three marks off again on `afterprint` (with a 1s fallback, because not every engine fires `afterprint` on a dismissed dialog). The print rules in `globals.css` key off exactly those attributes. Moved here from `app/(app)/analytics/` on 2026-09-16; the analytics path is a one-line re-export. |
| `group-print.tsx` | ~157 | **The OFFSTAGE STAGE.** `GroupPrintStage` renders a real, laid-out, 1040px column parked in a zero-sized clipped box (`.bw-print-stage`), waits `LAYOUT_SETTLE_MS` (400ms) for layout to settle, then calls `printCard` on it and unmounts on `afterprint` (2s fallback). `GroupPrintPage` is the per-sheet wrapper that carries the page break. `showHeader` (default true) draws the report's own title block; `/operations` and RC Movement pass FALSE because each of their pages carries its own heading. |
| `print-page-rules.ts` | 93 | **The `@page` BLOCK, injected for the duration of one print.** `buildPrintPageRules({scopeAttr, marginMm, extraCss})` returns the rules as a STRING; `usePrintPageRules(css \| null)` mounts them while non-null and removes them on cleanup. Added 2026-09-17 for RC Movement. |
| `print-fit.ts` | 234 | **PAPER GEOMETRY** — the arithmetic behind a "this fits on one sheet" promise. Pure: **zero imports**, no React, not even `'use client'`. Added 2026-09-17 for RC Movement. |

## Data

`print-fit.ts` is the only file here with a data model, and it is entirely dimensional:

| Type / function | What it is |
|---|---|
| `PX_PER_MM` · `PX_PER_PT` · `A4_SHORT_MM` · `A4_LONG_MM` | Unit constants. A print box is laid out at 96dpi. |
| `a4LandscapeBox(marginMm) → PrintPageBox` | The printable rectangle in CSS px. At 7mm: **1069.61 × 740.79 px**. |
| `monoCharPx(fontPt, advanceEm)` | The advance of ONE monospace glyph, in px, at a given size. |
| `PrintColumnDemand` | One column's demand expressed in **CHARACTERS** (`chars`), not pixels — because the width follows the font and the font is what is being solved for. `minPx` is a floor; `fixedPx` is for a column that does not scale with the body font. |
| `fitColumnWidths({columns, availablePx, ladder, padPx, advanceEm}) → PrintWidthFit` | **THE HORIZONTAL SOLVE** — the largest font step on a DESCENDING ladder at which every column fits. Returns `fits: false` at the floor when nothing does, so the caller can paginate instead of shrinking below legibility. |
| `maxRepeatingColumns({fixed, unit, …}) → number` | How many REPEATING columns fit beside a fixed spine at a given font. Returns at least 1 (0 would make a caller loop forever). |
| `fitRowHeight({budgetPx, rowCount, minRowH, maxRowH, chromePx, ladder}) → PrintRowFit` | **THE VERTICAL SOLVE** — row height as a function of the ROW COUNT, clamped, with the font stepping down beside it. Also returns `lineH`, because a `<tr>` height is only a FLOOR in the table model: the only way to pin a row is to pin its content. |
| `splitEvenly(items, maxPerChunk)` | BALANCED chunking — 25 at 20 per page is `13 + 12`, never `20 + 5`. |

## Key Behaviors

**The one MEASURED input, and why it can only be enforced.** `advanceEm` is the advance
width of one glyph of the caller's monospace face as a fraction of the font size. **Node has
no font engine**, so it cannot be derived here — it is measured in a real browser by the
caller and passed in. For the app's mono stack it is **0.6120**, carried by RC Movement as
**0.62, rounded UP**: a width derived from an under-estimate is a clipped number.

**Row height is a FUNCTION of the row count, and every row that will be drawn at the body
font belongs in the divisor.** `/operations` learned this the hard way — a row height
written as a CONSTANT is a page-fitting promise that holds for exactly one data shape, and
JULY 2026's 33 days ran onto a third sheet while AUGUST's 29 ran one row onto a fifth.
Pinning a totals or footer row at a constant instead of counting it is the same bug in
miniature.

**`@page` CANNOT be scoped to a class.** `globals.css` declares `@page { size: A4 landscape;
margin: 12mm }` and that one rule governs every print in the app. A dense report that needs
a tighter margin therefore cannot simply add a rule — it has to take one away for the
duration and give it back. That is the whole reason `print-page-rules.ts` injects and
removes rather than declaring. The injected block comes later in document order at equal
specificity, so it wins while it exists and leaves nothing behind when it does not.

**`print-color-adjust: exact` is load-bearing, not polish.** Without it a browser drops
every background fill unless the person printing happens to tick "Background graphics" —
i.e. the colour is in the markup and absent from the paper, which is indistinguishable from
never having built it. It is re-stated per report so a report's colour never depends on a
rule written for a different one.

**NO `tfoot` RULE, deliberately.** Chrome REPEATS a `<tfoot>` on every printed page, so a
totals row in one reads as a duplicated total. A printable report puts its totals in the
LAST `<tbody>` rows. `<thead>` keeps `table-header-group`, because a header that repeats is
a help.

**The stage is rendered OFFSTAGE WITH REAL LAYOUT, not `hidden print:block`.** That obvious
version was rejected on a measured property of recharts: `display: none` gives an element no
box, `ResponsiveContainer` measures its parent box, and a print media query does not apply
until the dialog is already open — so a sheet built that way prints empty chart frames. A
stage whose children are plain tables simply lays out faster than the settle window allows
for.

**Callers PORTAL the stage to `<body>`.** `printCard` flattens every ancestor with
`transform: none`, and Tailwind v4 centres an overlay with the INDIVIDUAL `translate`
property, which `transform: none` does not reset and which cannot be reset from the print
stylesheet either (Lightning CSS folds a `translate` reset back into a `transform`
shorthand). Any report that can be triggered from inside a dialog must portal.

**Known ordering nit (pre-existing, benign).** `GroupPrintStage` registers its own
`afterprint` listener *after* `printCard()` returns, and `printCard` calls `window.print()`
last — so in an engine that fires `afterprint` before `print()` returns, the stage unmounts
via its 2s fallback rather than the event. `printCard`'s own marks still come off on the
event, so nothing leaks; only the unmount is late. Measured end-to-end on RC Movement: body
class cleared immediately, stage and injected rules both gone well inside the fallback.

## Dependencies

- `app/globals.css` — `.bw-print-stage`, `.bw-print-sheet`, and the `@media print` block
  that keys off `bw-printing` / `data-print-card` / `data-print-ancestor` /
  `data-print-page`. **The attribute names are a contract between that file and this
  folder.**
- `react` / `react-dom` — `group-print.tsx` and `print-page-rules.ts` only. `print-card.ts`
  is a plain module (it touches the DOM at CALL time, not import time) and `print-fit.ts`
  has no imports at all.
- **Nothing else.** No Supabase, no auth, no `@/app/**`, no tenant module. Enforced by
  `scripts/verify-rc-movement-grid.ts` §5, which sweeps the comment-stripped source of
  `print-fit.ts` and `print-page-rules.ts` for tenant vocabulary and for `@/app/` imports.

## See Also

- `app/(app)/inventory/rc-movement/CONTEXT.md` → **"The printed sheet"** — the first caller
  of `print-fit.ts` / `print-page-rules.ts`, with the measured ceiling, the font ladder and
  the column-pagination fallback.
- `app/(app)/operations/CONTEXT.md` → `ops-page-print.tsx` / `ops-print-sheet.tsx` — the
  second caller. **It still carries its own copies of the row-height and page-box
  arithmetic** (`ledgerMetrics`, `OPS_PRINT_MAX_ROWS_PER_PAGE`); it was deliberately not
  edited when `print-fit.ts` was extracted, and **re-pointing it at this module is an open
  follow-up**, not a completed migration.
- `app/(app)/analytics/CONTEXT.md` — where `printCard` and `GroupPrintStage` originated.
- `components/shared/grid/CONTEXT.md` — the sibling platform primitive, same layer rule.
