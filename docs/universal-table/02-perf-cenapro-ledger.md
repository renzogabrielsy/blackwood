# Performance Review: Cenapro RC Deliveries Ledger (`deliveries-ledger.tsx`)

**Mode:** Diagnose · **Read-only** · 2026-08-17
**Files read:** `app/(app)/cenapro/deliveries/{deliveries-ledger.tsx, types.ts, use-deliveries-window.ts, ledger-url.ts, actions.ts, page.tsx, CONTEXT.md}`, `lib/hooks/{use-grid-keyboard-nav, use-grid-edit-session, use-cell-selection, use-cell-aggregation, use-grid-context-menu}.ts`, `components/shared/grid/EditInput.tsx`, `components/providers/status-bar-context.tsx`, `react-virtuoso@4.18.11/dist/index.mjs`

---

## Summary

The ledger is **correct and carefully reasoned, and structurally has no re-render boundary
anywhere**. `DeliveriesLedger` is a single ~3,780-line component (`:447`–`:4223`) holding
every piece of edit state, and the cell renderers are **plain closures re-created on every
render** — `React.memo` appears **zero times in 5,494 lines**. So one keystroke re-renders
every cell currently mounted, and `TableVirtuoso` does not stop it: `itemContent`,
`computeItemKey` and `fixedHeaderContent` are all **inline arrows**, and `context` changes
on every keystroke, so virtuoso republishes and re-renders its whole visible window too.

Virtualization is bounding the DOM, not the work. That is survivable in the endless scope
today (~900 `<td>` per keystroke) and **already the wrong side of a frame in the focus
scope** (~4,240 `<td>` per keystroke on March 2026). As the universal table module across
~15 grids, the per-cell constant (`~12 allocations + 2 tailwind-merge calls`) is the number
that will be multiplied.

**Nothing here is a leak.** All five `useEffect`s that subscribe globally have correct
cleanup. The problems are all "work done that did not need doing".

---

## Findings

| # | Severity | File:Line | Issue | Recommendation |
|---|---|---|---|---|
| 1 | **CRITICAL** | `deliveries-ledger.tsx:3927`, `:3919`, `:3926` | `itemContent={(_i, item) => renderItemCells(item)}`, `computeItemKey={(_i, item) => item.key}` and `fixedHeaderContent={() => headerRow}` are inline arrows. react-virtuoso publishes each as a prop stream (`dist/index.mjs:2780` reads `itemContent` / `computeItemKey` / `context` via `_(…)`); a new identity per render republishes and re-renders **every visible row + the header**. Virtualization caps the DOM but not the render work. | Hoist `computeItemKey` to a module const (`const ITEM_KEY = (_i, it) => it.key`). Wrap `itemContent` and `fixedHeaderContent` in `useCallback` with real deps. Then extract the row body into a `React.memo`'d `<LedgerRow item={…} …/>` so a stable `itemContent` actually buys skipped rows. |
| 2 | **CRITICAL** | `deliveries-ledger.tsx:551`, `:2841`, `:2965` | No render boundary between `setEdits` and the cells. `setEdits` (`:551`) lives in the top-level component; `renderCell` (`:2841`), `deliveryCells` (`:2965`), `sampleCells` (`:3249`), `draftCells` (`:3294`), `renderItemCells` (`:3589`), `rowClassFor` (`:3560`), `rowHeightFor` (`:3580`), `headerRow` (`:3500`) and `colGroup` (`:3546`) are all **plain, unmemoized** function/JSX values. Every keystroke rebuilds all of them and re-renders every mounted cell. Measured shapes: **endless ≈ 50 rendered rows × 18 cols = ~900 `<td>`**; **focus / March 2026 = 180 receipts + 27 draws + 20 drafts = 227 data rows × 18 = 4,086 `<td>` through `renderCell`** (+26 day headers, +26 day totals, +1 add-rows ⇒ ~280 `<tr>`, ~4,243 `<td>`). | Split the row into a memoized component whose props are primitives/stable refs: `item`, `cols`, `rowEdits` (the row's own `FieldEdits` object — already a stable identity when untouched), `isActiveRow`, `selectionBand` for that row, `dirty`, and a **stable handler bundle** built once with `useCallback`/refs. A keystroke then re-renders 1 row, not 50 (or 227). |
| 3 | **CRITICAL** | `deliveries-ledger.tsx:2848`–`:2958` | Per-`<td>` cost inside `renderCell`: two `cn()` calls (`:2870` 8 args, `:2921` 7 args — `cn = twMerge(clsx(...))`, `lib/utils.ts:4`), **four fresh closures** (`onContextMenu :2896`, `onMouseDown :2932`, `onMouseEnter :2949`, `onDoubleClick :2950`), a `style` object (`:2894`, plus a second spread object when frozen), the `opts` object literal at each call site, and `` invalidCells.has(`${rowKeyOf(navRow)}:${col.key}`) `` (`:2853`) which **allocates a template string per cell** (two for sample rows — `rowKeyOf :879` builds `${deliveryId}#${sampleIndex}`). `addressable()` is also called twice per cell (`:2851` directly, `:2852` again inside `cellExists`). ⇒ **~12 allocations + 2 twMerge per cell**: ~10,800 allocs + 1,800 twMerge per keystroke (endless), **~51,000 allocs + 8,500 twMerge (focus/March)**. | (a) Precompute the two class strings: the `<td>` class is a pure function of `(colIndex, isFrozen, navKind, rail)` — memoize into a `Map` keyed on that tuple, or drop `cn()` for a plain template join since these classes have no tailwind-merge conflicts to resolve. (b) Hoist the four handlers to the row component and dispatch by reading `data-col` off `e.currentTarget` — one handler set per row instead of 4×18. (c) Compute `rowKeyOf(navRow)` **once per row**, not once per cell, and pass it down. (d) Have `cellExists` take the already-computed `canEdit` instead of recomputing `addressable`. |
| 4 | **WARNING** | `deliveries-ledger.tsx:3597`–`:3604` | `ctx` (the virtuoso `context` prop) is memoized on `[minWidth, dirtyIds, dirtyDraftIds, cols]`. `dirtyIds` (`:625`) is a **new `Set` on every keystroke** because `setEdits` (`:827`) always returns a fresh `out` object. So `ctx` changes every keystroke ⇒ `LedgerScroller`, `LedgerTable`, `LedgerTableHead` and **every** `LedgerTableRow` re-render — a second, independent mechanism doing the same damage as #1. | Stop putting mutable state in `context`. Keep `ctx` to the truly static bits (`minWidth`, `colGroup`, `onScroller`) and let the memoized row read its own `dirty` flag from a prop that only that row's key changes. If `rowClassFor` must stay in context, hold `dirtyIds` in a ref and expose a stable `isDirty(id)` reader. |
| 5 | **WARNING** | `deliveries-ledger.tsx:1209`–`:1243` | The drag auto-scroll RAF loop is **unconditional**: `tick()` ends with `raf = requestAnimationFrame(tick)` (`:1234`) whatever the delta, and every frame calls `scroller.getBoundingClientRect()` (`:1221`) plus reads `scrollTop`/`scrollLeft`/`scrollHeight`/`clientHeight`/`scrollWidth`/`clientWidth` (`:1226`–`:1229`) — **6 forced-layout reads at 60fps for the whole drag**, even when the pointer is dead centre. Because `handleCellMouseEnter` re-renders the entire grid on every cell hover, this interleaves *invalidate layout → force layout → invalidate → force* every frame. Classic layout thrash. | Only schedule a frame when the pointer is actually inside an edge band. Cache the scroller `rect` on drag start (`pointerdown`) and refresh it on `scroll`/`resize` rather than per frame — the scroller's viewport box does not move during a drag. Read `scrollHeight`/`scrollWidth` once per drag too. |
| 6 | **WARNING** | `deliveries-ledger.tsx:657`–`:660`, `:5250` | `samplesOf(id)` falls back to `toDrafts(recordsById.get(id)?.samples ?? [])`, and `toDrafts` (`:5250`) **allocates a fresh array of 9-property objects on every call**. It is called from **six** sites: inside `flatten` for every record (`:5136`), `sampleCells` (`:3250`), `getCellText` (`:756`), `setCellText` (`:796`), `storedCellText` (`:859`) and `getNumericCellValue` (`:1294`). During a drag-selection over draws, that is one array allocation **per cell per pointer move**. | Memoize per receipt: `const storedDrafts = useMemo(() => { const m = new Map(); for (const r of records) m.set(r.row.id, toDrafts(r.samples)); return m; }, [records])`, then `samplesOf = (id) => sampleDrafts[id] ?? storedDrafts.get(id) ?? EMPTY`. One allocation per record per window load instead of thousands per interaction. |
| 7 | **WARNING** | `deliveries-ledger.tsx:668`–`:671`, `:678`–`:686` | Editing a **sample (moisture draw) cell** is far more expensive than editing a receipt cell. `setSampleDrafts` (`:797`) → `samplesOf` identity changes → `flatten` (`:5038`) re-runs over the **entire loaded window** (~1,100 records at full depth), rebuilding `items` + `navRows` (~2,200 objects) → `placeById` rebuilds a ~970-entry `Map` (`:678`) → and `addressable`, `resolver`, `getCellText`, `setCellText`, `storedCellText`, `rowKeyOf`, `contextYearFor`, `getNumericCellValue`, `clipboardCellText`, `applyClipboardPaste`, `scrollTo` **all change identity**. Per keystroke. | Make `flatten` independent of unsaved draw text. `flatten` only needs each receipt's **draw count** to emit sub-rows — pass `(id) => (sampleDrafts[id] ?? storedSamples(id)).length` and let the row renderer read the text. Then `flatten` depends on `[records, scope, draftIds, sampleCounts]` and a keystroke inside a draw does not re-flatten the sheet. |
| 8 | **WARNING** | `deliveries-ledger.tsx:1799` | Paste over **existing** rows issues **one `setCellText` per cell** (`:1799`), i.e. one `setEdits` updater per cell. React 19 batches them into a single render (good), but each queued updater does `{...prev}` on the whole edit map plus `mergeFieldEdit`'s `{...current}` (`types.ts:1283`). A 300 × 17 paste ⇒ 5,100 updaters over a map growing to 300 keys ≈ **~765,000 property copies + 5,100 intermediate objects**. The **new-row** path is already correct — it accumulates into a local `newEdits` and does one `setDraftEdits` (`:1809`). | Apply the same accumulate-then-commit shape to existing rows: build a local `Record<string, FieldEdits>` in the loop and issue **one** `setEdits(prev => merge(prev, patch))`. Same O(cells) work, one map copy instead of N. |
| 9 | **WARNING** | `use-deliveries-window.ts:129` vs `deliveries-ledger.tsx:5110`, `:5137` | `fetchOlder` decrements `firstItemIndex` by `fresh.length` — the number of **records** — while the `items` array grows by records **+ their moisture sub-rows + day-spacer rows**. Prepending 120 records that carry 10 draws and 15 day-gaps grows `items` by 145 but shifts the index by 120 ⇒ the anchor is 25 rows off, so virtuoso re-anchors and re-measures, and the viewport visibly jumps on load-older. CONTEXT.md acknowledges this ("pre-existing approximation"). | Have `flatten` return the count of items produced by the prepended slice, or make `fetchOlder` flatten the incoming page and decrement by the **item** count. The two must speak the same index space. |
| 10 | **WARNING** | `deliveries-ledger.tsx:2970` + `:2992` (→ `types.ts:1390`, `:1486`) | `flagSummary(row)` runs **twice per delivery row per render** — once inside `rowIssues(row)` (`types.ts:1390`) and once directly (`:2992`). Each call allocates: `rawArr.map(...)` calling `readImportFlags([el])` (which itself `flatMap`s a single-element array), plus a `.filter()` for the unresolved count ⇒ ~3 arrays per call, 6 per row. Only 12 of 971 receipts carry flags, so this is mostly empty-array churn — but it is per row per render. | Compute once: `const flagState = flagSummary(row)` then derive the issue set from it — `rowIssues` could take the summary as an optional second arg, or `deliveryCells` can inline the three cheap checks and reuse `flagState.live`. Zero behaviour change. |
| 11 | **WARNING** | `use-cell-selection.ts:181`–`:196` | The ledger deliberately does **not** pass `scrollContainerRef` (documented at `:1180`), so the platform hook's `tickAutoScroll` bails on frame 1 (`:149`). But the effect still attaches a `document` `pointermove` listener for the whole drag (`:188`), allocating a `{x, y}` object per event (~60–120/sec) that nothing reads, and still burns one scheduled frame. Cleanup is correct — this is waste, not a leak. | Gate the effect: `if (!enabled || !isDragging || !scrollContainerRef?.current) return;`. Two-line change in shared platform code; the four other consumers all pass a container so their behaviour is unchanged. |
| 12 | INFO | `deliveries-ledger.tsx:3500`–`:3543` | `headerRow` is rebuilt every render, mounting/reconciling 18 `<th>` and **12 Radix `ColumnFilterPopover` roots** (`:3506`) on every keystroke. Radix popover roots are not free. | `useMemo` the header on `[cols, filters, dimensions, period, fallbackYear, setColumnFilter]`, and memoize `ColumnFilterPopover` itself. |
| 13 | INFO | `deliveries-ledger.tsx:2969`, `:3295` | `edits[id] ?? {}` and `draftEdits[item.draftId] ?? {}` allocate a **fresh empty object per untouched row per render** (~227 per render in focus). Also breaks referential equality for any future memo on `rowEdits`. | Hoist `const NO_EDITS: FieldEdits = {}` to module scope and use `?? NO_EDITS`. Required anyway before #2's memo can work. |
| 14 | INFO | `deliveries-ledger.tsx:1127`–`:1132` | `scrollTo`'s focus branch does `scroller.getBoundingClientRect()` + `querySelector('thead')` + `getBoundingClientRect()` + `querySelector('tfoot')` + `getBoundingClientRect()` + `el.getBoundingClientRect()` = **4 forced layouts + 3 querySelectors per caret move**. Fine at typing speed; wasteful when a key is held (auto-repeat ~30/sec). | Cache the `thead`/`tfoot` elements in refs on mount and their heights per render pass. The header/footer heights are constant (32/34px). |
| 15 | INFO | `deliveries-ledger.tsx:2212`–`:2336` | `menuItems` is memoized on `[…, dirtyIds, dirtyDraftIds, selectedDeliveryIds, recordsById]` — `dirtyIds` is new every keystroke, so the 10-item array + 10 closures rebuild per keystroke even with the menu closed. | Guard on `menu.state !== null`, or pass `dirtyIds` through a ref so the item array is stable. Low absolute cost; it is the pattern that matters at 15 grids. |
| 16 | INFO | `use-cell-aggregation.ts:46`–`:57` | The aggregation loop is **O(selection area)** and re-runs on every `range` change. `Ctrl/Cmd+A` on a fully-loaded endless window (~1,100 nav rows × 18 cols) = **~19,800 `getNumericCellValue` calls synchronously inside render**. A large drag re-pays this on every `mouseenter` as the area grows. | Cap or debounce: skip the aggregation above an area threshold (e.g. 20,000 cells) and report count only, or move it behind the same 50ms debounce the status-bar push already uses (`deliveries-ledger.tsx:1334`) so it is computed once per settle rather than once per pointer move. |

---

## Hot Path Analysis

### 1. One character typed in a cell

```
EditInput onChange (EditInput.tsx:89)
 └─ setCellText(id, value)                       deliveries-ledger.tsx:784
     └─ setEdits(prev => ({...prev, [id]: next}))            :827   ← always a NEW object
         └─ DeliveriesLedger re-renders  ─────────── the entire ~3,780-line body
             ├─ dirtyIds useMemo recomputes → NEW Set                :625
             ├─ unsaved useMemo recomputes                            :650
             ├─ getCellText identity changes (dep: edits)             :746
             │   ├─ edit.startEditing / commit identities change   use-grid-edit-session.ts:52,76
             │   │   (`onAfterCommit` is an INLINE arrow at :1018 — changes every render regardless)
             │   ├─ validateOnCommit changes                          :927
             │   ├─ clipboardCellText changes                        :1382
             │   │   └─ copySelectionToClipboard changes             :1418
             │   │       └─ rangeSlot useMemo changes                 :1509
             │   │           └─ useGridKeyboardNav.handleKeyDown recomputes   use-grid-keyboard-nav.ts:131
             │   │               └─ onGridKeyDown changes             :1616
             │   └─ revertSelectedCells changes                       :1495
             ├─ ctx useMemo changes (dep: dirtyIds)                   :3597  ← FINDING 4
             ├─ headerRow / colGroup / renderCell / deliveryCells /
             │  sampleCells / draftCells / rowClassFor / rowHeightFor
             │  all rebuilt (plain values)                     :3500,:3546,:2841,:2965,…
             └─ <TableVirtuoso> receives NEW context + NEW itemContent
                 + NEW computeItemKey + NEW fixedHeaderContent        :3915-3929  ← FINDING 1
                 └─ virtuoso republishes → re-renders EVERY visible row
                     └─ renderItemCells(item) → deliveryCells(item)   :3589,:2965
                         ├─ rowIssues(row)   → flagSummary(row)   [1 of 2]   types.ts:1390
                         ├─ duplicateBadge(row)                                types.ts:754
                         ├─ flagSummary(row)                      [2 of 2]   :2992  ← FINDING 10
                         └─ cols.map(...) → renderCell × 18                    :2996
                             per cell: 2× cn(), 4 closures, style obj,
                             opts obj, template-string invalidKey,
                             addressable() ×2                                  :2848-2958
```

**Cost per keystroke (endless, ~50 rendered rows × 18 cols = 900 cells):**
~900 `renderCell` calls · ~1,800 `twMerge` · ~3,600 event closures · ~10,800 total allocations
· 900 React element diffs. Realistically **6–15 ms**.

**Cost per keystroke (focus, March 2026 — 227 data rows × 18 = 4,086 cells, ~280 `<tr>`):**
~4,086 `renderCell` calls · ~8,500 `twMerge` · ~16,300 event closures · ~51,000 allocations
· ~4,240 element diffs. Realistically **40–110 ms** — **visibly janky typing.**

**What SHOULD re-render:** the one `<input>` and the one `<td>` behind it. Everything else
is waste.

**Sample-cell keystroke** adds, on top of all the above: a full `flatten()` over the loaded
window (`:5038`, ~2,200 object allocations at full depth), a `placeById` `Map` rebuild
(`:678`, ~970 entries), and identity changes in 11 further callbacks — see Finding 7.

### 2. Moving the caret (Tab / Arrow)

```
onGridKeyDown (:1616) → useGridKeyboardNav.handleKeyDown → applyMove
 ├─ setActiveCell(next)                                    :1166 → setActiveCellState
 └─ onAfterMove (:1554)
     ├─ cellSelection.clearSelection()   → 3 setStates      use-cell-selection.ts:214
     ├─ scrollTo(id.row)                                    :1079
     │   endless: items.findIndex(...)  — O(items), ~1,100 scans, then virtuosoRef.scrollIntoView
     │   focus:   4× getBoundingClientRect + 3× querySelector  ← FINDING 14
     ├─ scrollToCol(id.col)  — 3 forced layout reads, 1 possible write   :1148
     └─ focusGrid()                                          :502
```

All four state updates batch into **one** render — but that render repaints **every visible
cell** (Findings 1–3), because there is no memo boundary. Selection membership itself is
correctly **O(1)**: `isSelected` (`use-cell-selection.ts:346`) is a plain bounds check on
the normalized range, and `isSelectable`/`addressable` are array lookups. **The lookup is
not the problem; the repaint is.**

### 3. Drag-selecting a range

```
mousedown on cell (:2932) → handleCellMouseDown → setAnchor/setFocus/setIsDragging
 └─ isDragging=true → ledger RAF effect starts (:1209)
     every frame, unconditionally:  getBoundingClientRect() + 6 layout reads   ← FINDING 5
 mousemove → onMouseEnter (:2949) → handleCellMouseEnter → setFocus(coord)
     └─ FULL grid re-render (all visible cells)
         └─ range object changes → useCellAggregation re-runs O(area)   ← FINDING 16
             └─ 50 ms debounced push to StatusBarProvider (:1334) ✔ correct
```

Per pointer move during a drag: **1 full grid re-render + 1 O(area) aggregation + 6 forced
layout reads on the next frame**, interleaved so the layout read always follows an
invalidation. This is the single most reliably janky gesture in the module today.

### 4. Pasting 300 rows × 17 cols

- **Onto existing rows:** 5,100 `setCellText` calls → 5,100 queued `setEdits` updaters →
  **one** render (React 19 auto-batching) but ~765,000 property copies. See Finding 8.
- **Past the end (new rows):** correct — accumulates into `newEdits` and issues one
  `setDraftIds` + one `setDraftEdits` (`:1807`–`:1816`). This is the shape the existing-row
  branch should copy.
- Geometry (`planPaste`, `types.ts:1250`) is pure and O(1). `cleanPastedCell` and
  `contextYearFor` are O(1) per cell. The loop itself is honestly O(rows × cols).

---

## Question-by-question

**1. Keystroke → re-render.** The whole component re-renders, and the whole `TableVirtuoso`
`itemContent` tree with it (two independent causes: inline `itemContent`/`computeItemKey`/
`fixedHeaderContent`, and `context` changing because `dirtyIds` is a new `Set`).
`edits` invalidates `getCellText` → `edit.startEditing`/`commit` → `validateOnCommit` →
`clipboardCellText` → `copySelectionToClipboard` → `rangeSlot` → `handleKeyDown` →
`onGridKeyDown`, plus `revertSelectedCells`, `dirtyIds`, `unsaved`, `ctx`, `menuItems`.
`setCellText` itself is stable (deps `[navRows, cols, recordsById, draftCanonical]`) — good.
`selection` state (`activeCell`, `range`) invalidates nothing memoized, but repaints
everything for lack of a boundary.

**2. Cell renderer cost.** ~12 allocations + 2 `twMerge` per `<td>` (Finding 3). Cells per
viewport: **endless ≈ 900** (~50 rows × 18 — 32px rows, `increaseViewportBy` 400/400 adds
~25 rows); **focus/March 2026 = 4,086 through `renderCell`** (~4,243 `<td>` total across
280 `<tr>`).

**3. Selection.** **O(1) per cell** — `isSelected` is a bounds test against the normalized
range (`use-cell-selection.ts:346`). Correct by construction. But **yes, moving the caret
repaints every visible cell**, because `setActiveCellState` re-renders the whole component
and nothing downstream is memoized.

**4. Drag / caret-follow loops.** **No leaks.** All cleanups are present and correct
(`:1239`, `:1948`, `:2779`, `use-cell-selection.ts:191`/`:210`, `use-grid-context-menu.ts:73`).
Two real wastes: the ledger's RAF loop runs unconditionally with a per-frame
`getBoundingClientRect` (Finding 5), and the platform hook attaches a `pointermove`
listener it can never use (Finding 11).

**5. Virtuoso.** `increaseViewportBy: {top: 400, bottom: 400}` is sensible (~12 rows each
side). `computeItemKey` correctly keys off `item.key` and ignores the index — **the RAW/PUBLIC
index discipline documented in CONTEXT.md is correct and `scrollTo` passes the raw array
position** (verified against `dist/index.mjs:668`, `:1123`, `:1492`, `:1775`). Row heights
are explicit per kind (`rowHeightFor :3580`) so measurement is stable and nothing forces a
re-measure per render. **The two real problems are prop identity (Finding 1 / 4) and the
`firstItemIndex` prepend drift (Finding 9).**

**6. Dirty tracking.** `mergeFieldEdit` is O(fields ≤ 18) and `dirtyIds` is O(edited rows) —
both cheap *in themselves*. But `dirtyIds` is recomputed on every keystroke and its new
`Set` identity is what invalidates `ctx`, which is what re-renders every virtuoso row.
Cheap to compute, expensive downstream.

**7. Focus scope (non-virtualized).** Busiest month is **March 2026: 180 receipts, 27 draws,
26 days** ⇒ 26 day headers + 180 + 27 + 26 day totals + 20 drafts + 1 = **~280 `<tr>`,
~4,243 `<td>`** — all re-rendered per keystroke. **This is the one path that is slow
today,** not merely at scale. Mitigating factor: `endless` is the default
(`ledger-url.ts:44`), so focus is opt-in.

**8. Paste of a large block.** O(rows × cols) with **one render** (correctly batched), but
**one `setEdits` updater per cell** for existing rows — see Finding 8. The new-row path is
already the right shape.

**9. Effects.** Six `useEffect`s in the ledger, all with correct cleanup:
`:1050` orphan-focus (deps `[edit.isEditing, activeCell, focusGrid]`, cheap DOM read);
`:1209` drag RAF (Finding 5); `:1334` status-bar debounce (correct — 50ms, cancel-only
cleanup); `:1344` unmount-only status-bar reset; `:1918` `document` paste listener
(bound once with `[]`, read through `pasteFromClipboardRef` — a good pattern);
`:2770` `beforeunload` (rebinds only when `unsaved.total` changes value, not per keystroke).
Plus `use-cell-selection.ts:181`/`:199` and `use-grid-context-menu.ts:62`. **No missing
cleanup, no unconditional-every-render effect, no leak.**

---

## Slow today vs. will not scale

**Actually slow today**

1. **Focus scope on a busy month** — ~4,240 `<td>` re-rendered per keystroke (#1, #2, #3).
2. **Drag-selecting a range** — full re-render per `mouseenter` + a 60fps forced-layout loop
   interleaved with it (#5), + O(area) aggregation (#16).
3. **Typing in a moisture draw** — full `flatten` + `placeById` rebuild per keystroke (#7).
4. **Prepend jump on scroll-up** in endless (#9) — a visible correctness/UX artefact.

**Fine today, will not scale to 15 grids**

5. Endless-scope keystroke (~900 cells) is currently inside a frame on a fast machine, but
   there is **no headroom**: it is the same unbounded pattern, just with a smaller viewport.
   Any grid with more columns, taller viewports, or a slower client crosses the line.
6. The per-cell constant (#3) is the number that gets multiplied by every future grid.
   Fixing it once in a shared `renderCell` primitive pays back 15×.
7. `toDrafts`/`samplesOf` allocation (#6), double `flagSummary` (#10), `?? {}` (#13),
   `menuItems` churn (#15) — individually trivial, collectively the difference between a
   grid module that is cheap by construction and one that needs a perf pass per instance.

---

## Recommended order of attack (before this becomes the universal module)

1. **Add the render boundary** — memoized `<LedgerRow>`, stable `itemContent` /
   `computeItemKey` / `fixedHeaderContent`, and get mutable state out of virtuoso `context`.
   (#1, #2, #4, #13.) This is ~90% of the win and everything else compounds on it.
2. **Cut the per-cell constant** — precomputed class strings, per-row handlers, per-row
   `rowKeyOf`. (#3.)
3. **Decouple `flatten` from unsaved draw text** and memoize `toDrafts`. (#6, #7.)
4. **Make the drag loop conditional and cache the rect.** (#5.)
5. **One `setEdits` per paste**, and **fix the `firstItemIndex` prepend count**. (#8, #9.)
6. Housekeeping: single `flagSummary`, gated `menuItems`, `pointermove` gate in the platform
   hook. (#10, #11, #15.)

## Verdict

**NEEDS CHANGES** before promotion to the universal table module.

Blockers: **#1, #2, #3** — there is no re-render boundary anywhere in the grid, so
virtualization bounds the DOM but not the work, and the focus scope is already janky on a
real month of data. **#5** is a second blocker for the drag gesture specifically.

Not blockers, but fix in the same pass since they are the patterns that get copied 15 times:
**#4, #6, #7, #8, #13**.

No leaks, no missing cleanup, no incorrect memo deps that would cause staleness. The
correctness reasoning in this module (index spaces, frozen-pane opacity, the paste sink, the
₱ boundary) is sound and **none of the recommendations above require touching any of it**.
