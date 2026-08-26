# Production — Trucks Tab

## Purpose
Daily truck odometer and fuel readings for fleet tracking, displayed as a **pivoted grid**: one row per DATE, with each truck plate as its own column group.

## Files
| File | Role |
|------|------|
| `actions.ts` | `fetchTrucksTabData(year, month)`, `saveBulkTrucks`. Defines `BulkSavePayload` locally. **Human-edit latch (2026-08-03):** every insert/update also passes `human_edited_at` via the local `claim()` helper, so the row is marked as yours and the sync will not overwrite it. The DB trigger `fn_stamp_human_edit` is the actual guarantee (it also fills `human_edited_by` from `auth.uid()`); hand a row back with `releaseProductionRows` in `app/(app)/production/actions.ts`. See the module CONTEXT → "Human-edit latch". |
| `trucks-view.tsx` | Scope-label wrapper (shows "Showing: {scope}") — passes `readings` to `TrucksGrid`. Accepts `year: number\|null`, `month: number\|null`, and `v2?: boolean`. Under `v2` it renders `TrucksGridV2` in a `hidden sm:block` wrapper AND the live `TrucksGrid` in a `sm:hidden` one, because the phone summary lives inside the live component — so the phone is byte-identical on both sides. |
| `trucks-grid.tsx` | Pivoted, inline-editable grid for `truck_readings` (one row per date, plate column groups) |
| `trucks-grid-v2-save.ts` | **PURE pivot + edit + save model for the v2 sheet** (2026-08-26). No React, no Supabase, no server action — asserted by `scripts/verify-electricity-trucks-grid.ts` (62 assertions, shared with the electricity sheet). Owns the column-key codec (`colKeyOf` / `parseColKey`), `derivePlates`, `buildDayRows` (the live grid's pivot **plus the per-plate stored `id`**, minus its `_state`/`_dirty` bookkeeping), `storedFieldText`, `parse` / `normalize` / `cleanPasted`, and `buildTrucksSavePlan` — which turns ONE dirty day row into N per-plate updates/inserts. See "v2 editing" below. |
| `trucks-grid-v2.tsx` | **Blackwood Table rendering of the same pivot, EDITABLE since 2026-08-26** (`?grid=v2`; originally read-only, 2026-08-18). Built beside `trucks-grid.tsx`, which is unchanged. Same DATE-frozen matrix (`pin: 'start'`), same `derivePlates` order, same `formatNum`, same `end − start` TTL. **The two-row header is approximated, not reproduced**: `BlackwoodTable` builds ONE header row, so since the header pass each header cell carries TWO LINES via `labelNode` + `headerWrap` — the plate on top, `START KM` / `END KM` / `TTL KM` / `FUEL L` beneath — at 84px subcolumns. `label` stays the flat `AAV 6111 START KM` string, because the header `title`, the resize handle's `aria-label` and `Copy with headers` all read it as TEXT. What is still missing is only the SPAN (four cells each saying the plate, rather than one saying it once). TTL lanes are `addressable: false` + `selectable: true`. **No phone layer** — `TrucksSummaryMobile` lives inside the live component, which still renders on the phone under `?grid=v2`. See the module CONTEXT → "The `?grid=v2` side-by-side". |

## Pivoted Layout
One row per `reading_date`. Each truck plate is a 4-subcolumn group: **START KM / END KM / TTL KM / FUEL**.

Two-row header:
- **Row 1 (group labels):** `DATE` (rowspan 2, frozen) | `AAV 6111` (colspan 4) | `KCA 378` (colspan 4) | `FORKLIFT` (colspan 4) | …extras
- **Row 2 (subcolumn labels):** START / END / TTL / FUEL — repeated per plate group

Column index map (3 plates → 13 cols): `0=DATE`, then per plate `[startCol=start_km, +1=end_km, +2=ttl_km(computed/null), +3=fuel_liters]`. `colAddr(col)` resolves any column index to `{kind:'date'} | {kind:'ttl',plate} | {kind:'cell',addr:{plate,field}}`.

## Plate Column Set (dynamic but stable)
`derivePlates(data)` = canonical `['AAV 6111', 'KCA 378', 'FORKLIFT']` (fixed order, always shown) UNION any distinct `plate_no` present in the fetched rows (extras appended alphabetically). Keeps columns stable on sparse data; surfaces new trucks automatically.

## Key Behaviors
- **Inline editing (shared Blackwood Table primitives):** keyboard nav + the edit session are driven by `useGridKeyboardNav` + `useGridEditSession` — see `components/shared/grid/CONTEXT.md`. `enableEnterAnchor: false`. Because EVERY truck column is navigable (DATE, the editable metric cells, AND the read-only computed TTL cols), the coordinate `columnMap` passed to `createCoordinateNavResolver` has **no null entries** (a length-`colCount` array of non-null sentinels) so the resolver never skips a column — matching the old `moveActive` (plain `col±1`, no skip). Per-cell editability (DATE = select-only native picker, TTL = read-only) is enforced in the grid's own `startEditing` (the authoritative guard), not the resolver. `revertChanges` is kept custom (NOT the session's) so trucks' intentional behavior is preserved — only the field value rolls back, the row's `modified` state and the cell's `_dirty` flag are **kept**. `Home`/`End` are intercepted before the shared handler (Home → col 0 / DATE, End → last col). `handleSmartPaste` stays local (pivot-aware: maps flat col indices to `colAddr`, marks `_dirty`, maintains the trailing row). **Known minor divergence:** the shared coordinate resolver clamps Tab at the grid's first/last cell to `from.col`, whereas the old `moveActive` wrapped around within the clamped row (last-cell forward-Tab → col 0; first-cell Shift+Tab → last col). Interior Tab/arrow/Enter behavior is identical; only the two absolute corner cells differ. The reference wiring is `app/(app)/inventory/rc-in/bulk-delivery-input.tsx`.
- **Focus never scrolls (2026-08-04):** `HTMLElement.focus()` scrolls its target into view with block AND inline `"center"` through every scrolling ancestor, and `"center"` always computes a target — so it fires even when nothing moved, re-centring the row and dragging the page. All three `gridRef.current?.focus()` sites (single-cell click, the custom `revertChanges`, the Tab/Enter commit) now pass **`{ preventScroll: true }`**. Focus still moves; only the scroll is refused. **CLOSED 2026-08-05:** the 3 metric editors now pass **`ref={focusNoScroll}`** (`lib/utils.ts`) instead of `autoFocus`. React's `autoFocus` prop is unfixable from the outside — react-dom's `commitMount` is a bare `domElement.focus()` with no options — so the prop must simply not be used on a cell editor. The ref callback lands in the same commit/layout phase and, like react-dom, calls no `select()`/`setSelectionRange()`, so caret behaviour is byte-identical. Same idiom as `components/shared/grid/EditInput.tsx`. See "Focus must never scroll" in `components/shared/grid/CONTEXT.md`.
- **Row rules were INVISIBLE until 2026-08-05 — `border-collapse: separate` paints CELL borders only.** This table is `borderCollapse: 'separate'` (load-bearing: under `collapse` a border belongs to the TABLE rather than the cell, so the sticky DATE column loses its edges), and in the separated-borders model the CSS spec ignores a border declared on `<tr>`/`<tbody>`/`<col>` outright. So the body row's `border-b border-border/30` and both header rows' `border-b border-foreground/10` and `/20` were **inert** — the pivot drew vertical column lines and no horizontal ones. Each is now applied to the row's CELLS via a child variant (`[&>*]:border-b [&>*]:border-b-border/30`, etc.), preserving the original weights. Header row 1's DATE cell is `rowSpan={2}`, so its rule lands at the bottom of the whole header block (correct) at the /10 weight rather than /20 — a 1px difference in the first column only. **Never re-add a `<tr>`-level border, and never flip to `collapse`.** The colour is side-specific so tailwind-merge cannot restyle the cells' own `border-r`; row heights are unchanged (preflight makes cells `border-box`, so the 1px rule draws inside the explicit 28px height). The `border-l-2` dirty marker on the `<tr>` is inert for the same reason and is **deliberately still open** — it needs to move onto the FIRST cell only, since a `[&>*]:` variant would draw it on every cell.
- **Escape-after-Delete audit (2026-08-04) — no gap, nothing changed:** a **single-cell** Delete/Backspace goes through `useGridKeyboardNav`'s `edit.start(active, '')`, which snapshots the pre-edit value before blanking, so Escape reverts it (through the custom `revertChanges`, which by design keeps the row's `modified` state and the cell's `_dirty` flag). A **range** Delete runs `useCellDelete` → `clearCell` (writes `''` through `updateCell`, no snapshot; DATE/TTL are not clearable) and the shared hook then drops the selection — not undoable, and deliberately left that way: the pivot rows are mutated in place with `_state`/`_dirty` and carry **no per-cell stored value** to revert to. Discard, which rebuilds the pivot from the fetched readings, is this grid's undo at the granularity it actually has.
- **Frozen DATE column:** `sticky left:0 z-30 bg-background`, right-edge separator shadow (`shadow-[2px_0_4px_rgba(0,0,0,0.12)]`), `group-hover:bg-muted/50` for uniform row hover. Header DATE cell is `sticky z-40` with `rowSpan={2}`. Uses the shared `DatePickerCell` (imported from `@/components/shared/grid`; always-on native picker, "MMM d" display). (The former local copy of `DatePickerCell` was deleted in the Phase 2 Blackwood Table migration.)
- **Computed TTL KM:** `end_km − start_km`, read-only tinted cell (`bg-muted/40`, `font-semibold`, `text-foreground/70`). Still drag-selectable for SUM/AVG aggregation, never written (GENERATED in DB).
- **Numeric formatting:** `formatNum()` — thousand separators, 0 decimals unless the value is fractional (then 2).
- **Editing model:** trailing empty DATE row at the bottom; typing/pasting into it materializes the row. Dirty-tracking is **per plate-cell** (`PlateCell._dirty`) plus per-row `_state`. Discard resets to `buildGridRows(initialData)`.
- **Cell selection + aggregation:** `useCellSelection` / `useCellAggregation` / `useStatusBar` — drag-select numeric cells (incl. computed TTL) → FloatingStatusBar shows SUM/AVG. DATE column (col 0) is non-selectable.
- **Smart paste:** Excel range paste maps left-to-right across the flat column indices (DATE + plate subcols); TTL columns are skipped.
- **Empty state:** `animate-fade-up` "Awaiting Production Manager sync..." message.
- **Error toasts:** `errorToast()` from `lib/toast.ts`.
- **Mobile (Archetype E phone-summary):** the days×plates grid is really a frozen matrix (one 288px plate group can't fit beside the 96px frozen DATE), so the `<div ref={gridRef}>` grid is `hidden sm:block` (desktop-only; editing stays desktop by decree) and a `sm:hidden` **`TrucksSummaryMobile`** renders a **read-only per-day card** listing each plate's `km` (start→end), `ttl` (the grid's own inline `end − start` display value, not a new total), and `fuel`. It reuses the grid's existing `rows` pivot + `plates` (dropping the trailing empty `new` row and plates with no values for the day). `formatNum` is reused; the component is local to `trucks-grid.tsx`.

## Save Logic (pivot → rows)
Walk every dirty/new grid row; for each `(reading_date, plate)` cell:
- **Existing** (`cell._id` present): push an **update** keyed by id — only if the cell was touched (`_dirty`).
- **New** (no id) **with any non-empty value**: push an **insert** for that `(reading_date, plate_no)`.
- `ttl_km` is never written (GENERATED). Empty new cells are skipped.

Calls `saveBulkTrucks({ inserts, updates, deletes: [] })` — the pivot never deletes whole readings (no per-cell delete column). Server validation (`end_km ≥ start_km`, `fuel ≥ 0`) and audit logging are unchanged from the original flat-grid action.

## v2 editing (2026-08-26)

The `?grid=v2` sheet saves through the **existing** `saveBulkTrucks`, unchanged — no new server action, no SQL. Everything that decides WHAT is sent lives in `trucks-grid-v2-save.ts`; the `.tsx` is the React adapter, and the two-line header work is untouched by it.

- **One rendered row is N database rows.** A dirty day produces one update per touched plate cell that has a stored id, and one insert per plate cell that has values but no id — which is why `buildDayRows` keeps the per-plate `id` the read-only pass dropped.
- **Editing the DATE moves the WHOLE day.** Every stored reading on that row is re-filed under the new date (an ordinary update whose other values are the stored ones). The live grid updates only cells whose own value was touched, so a date-only correction there saves **nothing at all** and leaves the row dirty forever. If the target date already holds one of those trucks, the pre-flight key sweep refuses the whole save by name.
- **REMARKS are carried, never typed.** The matrix has no text lane, so the stored remark rides back on every update — exactly what the live grid does.
- **What the database really enforces:** `UNIQUE (reading_date, plate_no)`, `start_km >= 0`, `end_km >= 0`, `fuel_liters >= 0`. **`end_km >= start_km` is NOT a constraint** — `translateDbError` maps `chk_truck_readings_end_km`, which no migration ever created, and `saveBulkTrucks` only checks it on an update when both halves are present. Hence the whole-cell payload (six keys) and the model's own check.
- **A day is filed WHOLE**: if any cell on a row is refused, none of that row's cells is posted — and the run-wide rule still applies on top of it, so **nothing is written unless every dirty row is legal**. `saveBulkTrucks` is staged and not transactional and reports no counts on failure, so on a server refusal the sheet forgets nothing, reloads, and the persistent toast says which readings may already be stored rather than claiming a rollback.
- **TTL KM previews unsaved edits** through `ctx.cellText`; the selection total and the clipboard read the SAVED figures (the platform documents `clipboardValue` as the stored value, and `numericValue` takes the row only). A DRAFT row shows no TTL — `format` runs against a stored row and a draft has none.
- **A blank DAY row** is seeded with today's date and needs at least one truck reading; a plate with only FUEL typed still files (start/end 0), exactly as the live grid's `hasValue` rule does. A cleared FUEL cell saves **NULL**, never 0.
- **`onSaveSuccess` is load-bearing.** `trucks-lazy-tab.tsx` holds its rows in CLIENT state, so `router.refresh()` cannot bring a saved reading back — only the host's refetch can. `periodYear` is an optional prop for the bare-`8/21` year fallback.
- **Not built:** the date-PICKER cell (the DATE lane is typed and canonicalised on commit), per-row delete (`deletes: []`, as the live grid also sends), and the phone summary.

## Hooks Used
- `useGridKeyboardNav` + `createCoordinateNavResolver`, `useGridEditSession` — shared Blackwood Table keyboard/edit primitives (see `components/shared/grid/CONTEXT.md`)
- `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useStatusBar`

## Server Action Contract
```ts
saveBulkTrucks(payload: BulkSavePayload<TablesInsert<'truck_readings'>, TablesUpdate<'truck_readings'>>)
  => Promise<{ ok: true, insertedCount, updatedCount, deletedCount } | { ok: false, error: string }>
```

## Data Fetch
`fetchTrucksTabData(year?: number | null, month?: number | null)` — filters `truck_readings` (DESC by date, ASC by plate) by `reading_date`. Driven by the **module-level shared period** (see `production/CONTEXT.md` → "Universal Period Control"):
- `year=null` → all readings (no date filter)
- `year=<num>, month=null` → all readings in that calendar year
- `year=<num>, month=<n>` → that month of that year (`month` is 0-indexed)

The `trucks-lazy-tab` derives `month = batchToMonth(batch)` from the shared batch before calling (unrecognized/null batch → null month → whole year). `undefined` args fall back to the current month for backwards compatibility. Returns `{ readings, year, month }`. The grid pivots them client-side via `buildGridRows`.

## Removed
- **Monthly summary card** (`view_trucks_monthly`) — deleted from the grid/view and no longer fetched in `actions.ts`. The DB view still exists (harmless) but is unused by the UI.
