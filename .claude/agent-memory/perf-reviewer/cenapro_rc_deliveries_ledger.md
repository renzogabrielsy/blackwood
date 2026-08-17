---
name: cenapro-rc-deliveries-ledger
description: Perf profile of app/(app)/cenapro/deliveries/deliveries-ledger.tsx — the grid slated to become the universal table module. No render boundary anywhere; virtuoso props are inline arrows. Diagnosed 2026-08-17.
metadata:
  type: project
---

# Cenapro RC Deliveries ledger — performance profile (diagnosed 2026-08-17)

`app/(app)/cenapro/deliveries/deliveries-ledger.tsx` — 5,494 lines, of which `DeliveriesLedger`
is ONE component spanning `:447`–`:4223`. **`React.memo` appears zero times in the file.**

**Why:** this grid is slated to become the app's universal table module, so its per-cell and
per-keystroke constants get multiplied across ~15 grids. It was audited before that promotion.

**How to apply:** treat the four headline facts below as the baseline for any re-review; check
whether a fix landed before re-reporting the same finding.

## The four headline facts

1. **No render boundary.** `setEdits` (`:551`) lives in the top-level component and every cell
   renderer (`renderCell :2841`, `deliveryCells :2965`, `sampleCells :3249`, `draftCells :3294`,
   `rowClassFor :3560`, `headerRow :3500`, `colGroup :3546`) is a plain unmemoized closure.
   One keystroke re-renders every mounted cell.
2. **Virtualization does not stop it.** `itemContent` / `computeItemKey` / `fixedHeaderContent`
   are inline arrows (`:3919`, `:3926`, `:3927`) and `context={ctx}` (`:3597`) changes every
   keystroke because `dirtyIds` (`:625`) is a new `Set`. react-virtuoso 4.18.11 publishes all
   four as prop streams (`dist/index.mjs:2780`), so it republishes and re-renders its whole
   visible window. Two independent causes of the same damage.
3. **Per-`<td>` constant ≈ 12 allocations + 2 `twMerge`** — two `cn()` calls, four fresh event
   closures, a `style` object, an `opts` object, a template-string `invalidCells` key, and
   `addressable()` called twice. This is the number that scales to 15 grids.
4. **Measured shapes.** Endless ≈ 50 rendered rows × 18 cols = ~900 `<td>`/keystroke.
   Focus on March 2026 (180 receipts + 27 draws + 26 days, the busiest month) = ~280 `<tr>`,
   ~4,243 `<td>`, all re-rendered per keystroke — already janky today. Endless is the URL
   default (`ledger-url.ts:44`), so focus is opt-in.

## Gestures ranked by real cost

- **Sample (moisture draw) keystroke** is the most expensive: `setSampleDrafts` → `samplesOf`
  identity → full `flatten()` over the loaded window + `placeById` Map rebuild + 11 callback
  identity changes, on top of the full repaint.
- **Drag-select** — full re-render per `mouseenter`, interleaved with an *unconditional* 60fps
  RAF loop (`:1209`) that calls `getBoundingClientRect()` + 6 layout reads every frame whether
  or not the pointer is near an edge. Textbook layout thrash.
- **Caret move** — 4 batched state updates, one render, but repaints everything.
- **Paste** — correctly batched into one render, but existing rows issue one `setEdits` updater
  per cell (`:1799`); the new-row branch (`:1807`) already does the right accumulate-then-commit.

## What is CORRECT and must not be "fixed"

- Selection membership is genuinely **O(1)** (`use-cell-selection.ts:346`, bounds test).
- The RAW-in / PUBLIC-out virtuoso index discipline is right; `scrollTo` passes the raw array
  position. Verified against `dist/index.mjs:668, 1123, 1492, 1775`.
- All six ledger `useEffect`s have correct cleanup. **No leaks anywhere in this module.**
- The 50ms debounce on the StatusBar push (`:1334`) is correct (cancel-only cleanup).
- Row heights are explicit per kind, so nothing forces a virtuoso re-measure per render.
- The paste sink, frozen-pane opacity rules, and the ₱ boundary are correctness machinery —
  none of the perf recommendations require touching them.

## Known non-perf defect found in passing

`use-deliveries-window.ts:129` decrements `firstItemIndex` by the **record** count while `items`
grows by records + moisture sub-rows + day-spacer rows (`:5110`, `:5137`). The prepend anchor
drifts and the viewport jumps on scroll-up. CONTEXT.md acknowledges it as pre-existing.

Related: [[status-bar-context-pattern]], [[cenapro_production_ledger]]
