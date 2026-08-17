# Universal Table Module — "Blackwood Table v2"

> Implementation prompt for an Opus 5 agent. Written 2026-08-17 after two rounds of questions with
> Renzo and four read-only audits (research pack: `docs/universal-table/`). It is a PLAN — read all of
> it, then enter plan mode for the phase you are about to build, get approval, and only then execute.
> Work phase by phase; each phase is its own merge to `main` with its own Definition of Done.

---

## 0. Read first (mandatory, in this order)

1. `TIMELINE.md` (top), `CLAUDE.md` in full — especially *Platform Philosophy*, *Layer separation rule*,
   *UI Design System*, *"Never crush, always scroll"*, *Error Toasts (HARD RULE)*, *Motion & Glass*,
   *Frozen Panes*, *Price gating*, *Component Context Files*, *Git Workflow*.
2. The latest handoff: `ls handoffs/ | sort -r | head -1`.
3. `components/shared/grid/CONTEXT.md` — the existing "Blackwood Table" primitives (phases 0/1/4 of an
   earlier consolidation shipped; this prompt is the continuation and supersedes that plan).
4. `app/(app)/cenapro/deliveries/CONTEXT.md` — ALL 1,600 lines. Every decision documented there is a
   decision the module inherits (paste sink, Escape's two meanings, caret-follow, drag auto-scroll,
   virtuoso RAW-in/PUBLIC-out, draft rows, dirty tracking, day spacer, filters grammar, axis guard, ₱
   boundary). You are extracting that behaviour, not re-deciding it.
5. `docs/universal-table/00-README.md` → then `01` (code audit — findings A1–A22, parity table B, the
   seam C, top-10 D), `02` (perf — the render-boundary rule), `03` (RC IN/OUT feature inventory —
   what must survive, what is dead, what is a bug), `04` (all 55 tables app-wide, the Cenapro vs ICTC
   period-control comparison). Read them fully; do not re-derive what they already measured.
6. `app/(app)/inventory/CONTEXT.md`, `rc-in/CONTEXT.md`, `rc-out/CONTEXT.md`, `production/CONTEXT.md`
   (+ `daily/`), `app/(app)/cenapro/CONTEXT.md` (production ledger + QC sections),
   `components/providers/AUTH.md`, `components/NAVBAR.md`.

Agent conventions (from CLAUDE.md + Renzo's standing preferences): implementation subagents run on
Opus (`senior-frontend-engineer` for UI, `supabase-backend-engineer` for actions/SQL); ALL git
operations go through `git-branch-guardian` (`git add .`, conventional commits); ONE subagent at a
time — no teams unless Renzo says "use a team"; verify every subagent's output on disk (`git status`,
open the files) before believing its report; do the work yourself where a subagent would just narrate.

---

## 1. Goal and the decisions already made (do not re-open these)

**Renzo, 2026-08-17:** *"It is best to make one table module and have everything that uses a table in
the app use that table module we make. … The best one to base off of right now is CENAPRO Deliveries
table. … I really like how it feels like an actual sheet where I can copy paste entries like a Google
Sheet would. … I know there's a lot of tables in this app but I'd really like things to feel coherent
so when I input data, I don't have to feel like I'm adjusting based on what feature I'm using."*

| # | Decision | Renzo's answer |
|---|---|---|
| D1 | **Scope** | **Editable ledgers ONLY.** Read-only tables (Blocking grid, RC Movement matrix, digest bands, sync cases, admin, liquidation balance tree, shipments) do NOT migrate. |
| D2 | **Input model** | **Cenapro-style everywhere**: click a cell, type, paste, blank draft rows at the bottom, one Save. **No add dialog and no edit dialog anywhere** — "even the editing should be like Cenapro style where there isn't a dialog we have to click to edit." |
| D3 | **ICTC navigation** | RC IN → its own route `/inventory/rc-in`; RC OUT → `/inventory/rc-out` (like Blocking / RC Movement / Flecon already are). The Deliveries/Usage tab bar and the year/month footer strip are **deleted**. Both routes get the shared **Year + Month** picker and the **Endless/Focus** toggle. **"Make sure the Blocking table does NOT get changed one bit — it is perfect as is — and make sure data doesn't get corrupted."** |
| D4 | **RC IN period axis** | **Year + calendar Month** (`transaction_date`). Batch stays a column filter, not a period axis. |
| D5 | **Google-Sheets must-haves for v1** | Undo/Redo stack (Ctrl+Z / Ctrl+Y / Cmd+Shift+Z) · paste ONE value onto a selected RANGE fills it · Ctrl+Arrow / Home / End / PageUp / PageDown · click row-number selects the row, click column header selects the column (+ Shift+Space / Ctrl+Space) · right-click → insert row above/below, delete row(s), clear row · column resize + reorder + hide, remembered per user per table. **Deferred (later phase, not dropped):** Cut (Ctrl+X), fill handle drag + Ctrl+D / Ctrl+R. |
| D6 | **Parity harness** | **Playwright e2e** — each checklist item is an automated browser test. Renzo handles visual feel himself: *"I just need the code to make sense."* |
| D7 | **Migration order** | module → **RC IN** (the stated pain point) → RC OUT → ICTC Production (Daily / Electricity / Trucks) → Flecon (see §5, Phase 4 note) → Cenapro production + QC → liquidation's interactive tables (confirm scope first). |
| D8 | **Branch** | `feat/universal-table`, cut from `main`. Each phase merges to `main` on its own when its DoD is met (Renzo tests on the live app; Vercel deploys from `main`; nothing here touches `workers/sync/`, so no Fly deploy). |

---

## 2. Non-negotiables

1. **Platform layer = zero tenant knowledge.** The module lives in `lib/table/` (pure, no React) +
   `components/shared/table/` (React) + the evolved `lib/hooks/`. It never imports from `app/(app)/**`,
   never mentions charcoal, pesos, suppliers, batches, moisture. It consumes ports (§3) filled by
   tenant adapters. Grafana's model, CLAUDE.md's Hexagonal rule.
2. **Behaviour parity first, features second.** Phase 1 migrates the Cenapro ledger onto the module
   with every documented behaviour intact (`scripts/verify-rc-deliveries-cells.ts` — 116 assertions —
   is the acceptance test for the seam and must stay green through the extraction; new assertions may
   be added, existing ones may only be moved into `scripts/verify-table-*.ts` when the helper they
   assert moves). The v1 must-haves (D5) are added ON TOP, in the module, once.
3. **The render boundary is a design rule, not a patch.** One memoized `<Row>` component; stable
   `itemContent` / `computeItemKey` / `fixedHeaderContent`; virtuoso `context` carries static bits
   only; per-cell class strings precomputed per `(column, pin, rowKind, state)`; handlers live on the
   row and dispatch by `data-col`; one state batch per paste; the drag auto-scroll RAF runs only in an
   edge band. Read `docs/universal-table/02-perf-cenapro-ledger.md` findings 1–9 before designing
   the row/cell components. A keystroke must re-render one row, not the sheet.
4. **ONE journalled writer for every cell mutation.** Typing-commit, Delete/Backspace clear, paste,
   fill-range, context-menu clear row, Escape-revert, "fill from draws"-style consumer actions — all
   go through the same `applyMutation(step)` that (a) routes each cell through `mergeFieldEdit` (dirty
   state stays honest, audit findings A6/A7) and (b) records the step in the undo journal. A cell
   write anywhere else is a bug (this is what makes Ctrl+Z possible at all — audit D.5).
5. **The grid always owns a caret and always gets focus back.** Clicking a selectable-but-not-editable
   cell (e.g. a DB-computed total) must NOT null the active cell into a dead keyboard (A2); a context
   menu item, a filter popover, a dialog closing all return focus to the sink (A10/A11); a right-click
   selects the cell under it (A18); a click on any cell coordinate lands somewhere (A19).
6. **Heterogeneous rows are first-class.** The row model answers `occupies(colKey)` per row kind, and
   the paste planner refuses to scatter a block across kinds — a block copied from receipts lands on
   receipts, skips sub-rows, and REPORTS what it skipped (A4 is a data-corruption bug today).
7. **Frozen columns are `pin: 'start' | 'end'`, never "the prefix"** (audit C.1 entangled table).
8. **Filters in endless mode are pushed into the QUERY, never applied to the loaded window** — the
   Cenapro rule ("a filter applied to the loaded window lies about the rest") becomes the module rule;
   the data-source port carries the lens.
9. **All CLAUDE.md UI rules apply verbatim:** Excel Standard density, `table-fixed` + explicit px widths
   + `min-width = Σ columns` + `overflow-x-auto` (never a `1fr`/`w-auto` absorber), frozen surfaces
   OPAQUE (`.frozen-col`/`.frozen-row`/`.frozen-corner`/`.frozen-edge` z-scale), `border-collapse:
   separate` with row rules on the CELLS, no animation on rows/cells/selection, `errorToast()` for
   every error surface, `focus({preventScroll:true})` everywhere and never React's `autoFocus`.
10. **Price gating stays SERVER-side per consumer.** The module only knows "this column does not exist
    for this viewer" (`visible(ctx)` on the column spec) — the adapter nulls ₱ before the payload
    leaves the server, exactly as today. The module's clipboard/pill/filters must never be able to
    surface a column the spec hides (the Cenapro invariants for `buildColumns(false)`, `FILTER_COLUMNS`
    from `BASE_COLS`, and `PRICE_FIELDS` all carry over as module tests).
11. **Blocking is untouched — files, behaviour, data.** Do not edit `app/(app)/inventory/blocking/**`,
    `app/(app)/inventory/_shared/blocking-detail-panel.tsx`, `_shared/edit-delivery-dialog.tsx`,
    `_shared/blend-proposal-dialog.tsx`, `view_blocking_grid`, or the RC IN exports they import
    (`DeliveryHistoryDialog`, `bulkUpdateDeliveries`, `getDeliveryHistory` …). Their deep-link
    `/inventory?tab=…&editBatch=…` keeps working through a redirect shim (§5 Phase 2), so not one
    Blocking file changes.
12. **Data integrity on the ICTC side is the EXISTING server actions.** RC IN keeps writing through
    `submitBulkDeliveries` / `bulkUpdateDeliveries` (block_loc format + occupied validation, batch
    upsert-first, transactional RPC, audit trail, edit-reason comment) and RC OUT through
    `submitBulkUsage` / `bulkUpdateUsage`. Read-side actions are NEW (keyset page + month + dimensions,
    mirroring `cenapro/deliveries/actions.ts`); write-side actions are reused, not rewritten. Any change
    to a server action or SQL goes to `supabase-backend-engineer` and gets a `verify-*.ts` script.
13. **Every code change updates the relevant `CONTEXT.md` in the same changeset** (CLAUDE.md STRICT
    rule). The module gets its own `components/shared/table/CONTEXT.md`; `components/shared/grid/
    CONTEXT.md` is rewritten to point at it and mark what is retired.
14. **Prompts and plans stay in the repo:** this file is the plan of record; append a dated
    "Decisions log" section at the bottom when Renzo decides something new.

---

## 3. Architecture of the module (the port)

The audit's seam (`01-audit…` §C.2) is the design. Restated as build instructions — express these
as TypeScript in the code, not here (prompt convention: no nested code fences).

### 3.1 Package layout

- `lib/table/` — **pure, portable, no React, no `@/` imports outside `lib/`.** Geometry
  (`columnOffsets`, `pinnedWidths`, `minTableWidth`, `columnScrollLeft`, `dragAutoScrollDelta`,
  `summarySpans`), clipboard (`parseClipboardTable`, `tsvEscape`, `clipboardNumber`, `planPaste`,
  `tilePaste` — the new "one value / one block tiled over a range" planner), dirty tracking
  (`mergeFieldEdit`, `isDirtyFieldEdits`, `countUnsavedWork`, `describeUnsavedWork`), the undo journal
  (`createJournal`, `push`, `undo`, `redo`, step grouping, cap 200, cleared on save/remount), draft-row
  rules (`DEFAULT_DRAFT_ROWS`, `MAX_DRAFT_ADD`, `clampDraftAdd`), the URL-axes grammar (scope, period,
  per-column filters `f_<key>=…`, `axesKey`) generalised from `cenapro/deliveries/ledger-url.ts` and
  `cenapro/production/ledger-url.ts`, and the group-spacer rule (`needsGroupSpacer`). Donor: the
  ~55% of `cenapro/deliveries/types.ts` that is already generic (audit §C.3).
- `components/shared/table/` — **React.** `BlackwoodTable` (container: virtuoso endless or plain focus,
  header, colgroup, pinned columns, summary rows, group spacers, draft pool, "Add N more rows",
  floating pill wiring), `Row` (memoized), `Cell` (the `absolute inset-0` interactive layer with the
  one-`bg-*` ternary), `HeaderCell` (label + selection click + filter trigger + resize handle + drag
  reorder), the paste sink, `AxisGuard` (unsaved-work prompt), `ColumnFilterPopover`, `PeriodPicker`
  (Year + Month or Year + Batch by config) + `ScopeToggle` (Endless / Focus) as platform chrome,
  `TableSettingsMenu` (density, font size, hidden columns, reset widths/order). Existing shared
  cells (`EditInput`, `SelectCell`, `DatePickerCell`, `GridContextMenu`) move in or are re-exported.
- `lib/hooks/` — `useGridKeyboardNav`, `useGridEditSession`, `useCellSelection`,
  `useCellAggregation`, `useGridContextMenu` are evolved in place (fix A1 and A8 here — they are
  platform bugs today). `useGridPaste`, `useClipboardCopy`, `useCellDelete` and `GridCell` are
  **retired** once no consumer remains (the Cenapro ledger already opted out of them because they
  could not do its job — audit §C.1, inventory §(d)); until then they stay untouched.
- `components/providers/table-settings.tsx` + `lib/actions/table-settings.ts` — generalised to
  **per-table `tableId`** (`user_table_settings(user_id, module)` is already generic; today ONE
  provider is mounted app-wide keyed `'rc_in'`, so RC OUT and Blocking silently share RC IN's row —
  inventory `03` §1/§2). Settings shape: `density`, `fontSize`, `columnWidths`, `columnOrder`,
  `hiddenColumns`, plus a consumer-owned `extras` JSONB (RC IN's `labHighlights` / `columnFormats`
  live there). No DB migration needed.

### 3.2 The three contracts

- **Column spec** (`ColumnSpec<Row, Ctx>`): `key` (stable — used in URL params, `invalidCells`
  keys, settings), `label`, `title?`, `width` (px), `align`, `pin?: 'start' | 'end'`, `cellKind`
  (`text | number | date | select | formula | readonly | derived`), `format(row, ctx)`,
  `editText(row, ctx)` (what the cell shows on focus), `parse(text, ctx)` → a patch or a refusal
  message (THE one commit verdict — also used by paste), `editable?(row, ctx)`, `visible?(ctx)`
  (price gating), `selectable?` (may a range cover it — subsumes the `key === 'ttl'` special case),
  `numericValue?(row)` (the pill), `clipboardValue?(row)` (stored value, never edit text — the
  Cenapro rule), `cleanPasted?(raw, ctx)`, `calcType?` (`SUM | AVERAGE`), `filter?` (`set | text |
  range | dateRange`, + the DB column), `summaryLane?` (`label | figure | note | total`), `resizable`
  / `reorderable` / `hideable` flags (default true; pinned columns reorder only within their pin
  group). These fields REPLACE the five domain switches the audit found (`isSelectableColumn`,
  `columnCalcType`, `getNumericCellValue`, `clipboardCellText`, `cleanPastedCell`).
- **Row model** (`RowKind` + `GridRow`): open `kind` string (never a closed union — `NavRow`/`ROW_RULE`
  today), `height`, `rule` (border-b weight), `occupies(colKey)` → which column this kind has and as
  what field (THE row-shape question, asked once; drives addressability, paste, the pill, the tint),
  `addressable`. Row items: records (with optional `children` sub-rows), drafts, and non-addressable
  `spacer | group-header | summary` items that never enter the nav coordinate space.
- **Data source** (`GridDataSource<Row, Cursor, Lens>`): `fetchWindow({anchor | cursor, direction,
  lens})` → rows + `hasOlder`/`hasNewer`/`totalCount`/notice/error (keyset, ORDER BY fixed by the
  adapter, NULL group named explicitly), `fetchPeriod(period, lens)` for focus scope, `saveBatch(inputs)`
  → per-row verdicts (`saved | inserted | version_conflict | forbidden | invalid`), `deleteRow?`,
  `dimensions?()` (feeds `set` filters — never derived from the loaded rows), `cursorOf(row)`,
  `identityOf(row)`. The grid never imports Supabase; the adapter is a `'use server'` module per
  consumer. Validation runs client-side first via `parse`, and **one bad cell blocks the whole
  batch** (Cenapro rule) — the adapter re-checks server-side.

### 3.3 Hooks the module exports (composition, one concern each)

`useGridColumns(specs, ctx, settings)` → ordered/visible cols, offsets, pinned widths, min width,
summary spans · `useGridRows(items, kinds, drafts, grouping)` → nav rows, `placeById`,
`addressable`, `cellExists` · `useGridEdits(specs, rows)` → `getCellText` / `setCellText` (journalled)
/ `storedCellText` / `dirtyIds` / `invalidCells` / `revertSelection` / `clearSelection` /
`undo` / `redo` · `useGridInteraction(...)` → keyboard + selection + clipboard + paste sink +
caret-follow + drag auto-scroll, returning `gridProps`, `sinkProps`, `onKeyDown`, `onPaste` ·
`useGridWindow(dataSource, initial, lens)` → today's `useDeliveriesWindow` generalised (with the
`firstItemIndex` accounting fixed: decrement by ITEMS prepended, and never push it back up on
reset — A13/A14) · `useGridAxisGuard(unsaved, save)` → `requestAxisChange` + prompt · `useTableSettings(tableId)`.

### 3.4 Behaviours the module owns (carried over from the Cenapro ledger — see its CONTEXT.md)

Select ≠ edit (Enter opens the editor; typing type-overs; F2/double-click preserve) · Enter-while-
editing commits + moves down, Shift+Enter up, Tab-run then Enter returns to the lane · Escape while
editing reverts, Escape not editing UNDOES the unsaved edits under the selection then deselects ·
Delete/Backspace clears the cell or range without an editor and KEEPS the selection · Shift+click /
Shift+Arrow / drag ranges with edge auto-scroll where the pinned block is a WALL · Ctrl/Cmd+A · copy
single cell or range as properly-escaped TSV of STORED values · paste at the anchor, creating draft
rows past the end where a blank row means something, refusing (and saying so) where it does not ·
every paste outcome names itself · the paste SINK + document fallback with both interlocks · caret-
follow on both axes, instant, contained to the table's own scroller, `preventScroll` on every focus ·
draft pool + "Add N more rows" · seeded draft dates · dirty = `mergeFieldEdit` (typing a value back
is not an edit) · `invalidCells` keyed by row key + col key · the axis guard (Save and continue /
Discard N / Cancel + `beforeunload`) · group spacers as REAL full-height rows of per-column cells ·
summary rows whose spans are read off the column table · virtuoso RAW-in/PUBLIC-out · per-column
filters pushed to SQL, URL-held, chip row, server match count · the floating aggregate pill summing
STORED values only.

### 3.5 New in v1 (D5) — designed once, in the module

- **Undo/Redo** — the journal (§2 rule 4). Steps: one commit, one clear (single or range), one paste,
  one fill, one clear-row, one Escape-revert. Ctrl+Z / Ctrl+Y / Cmd+Shift+Z / Ctrl+Shift+Z. Not
  captured while an editor is open (the input's own undo applies). Cleared on successful save and on
  axis remount; the "N unsaved" chip is unaffected because undo writes through `mergeFieldEdit`.
- **Tile-paste** — the paste planner iterates the TARGET range when the clipboard is 1×1 (fills every
  addressable cell) or when the selection is an exact multiple of the block (Sheets tiles); otherwise
  today's anchor-paste. Same primitive later powers Ctrl+D / Ctrl+R (deferred).
- **Jumps** — Ctrl/Cmd+Arrow to the edge of the contiguous data block in that direction (within the
  loaded rows in endless; the month in focus); Home/End = first/last selectable column of the row;
  Ctrl+Home/End = first/last loaded row; PageUp/PageDown = one scroller `clientHeight`. All follow
  the caret with the existing instant scroll arithmetic.
- **Row / column selection** — click the row-number lane selects the row's selectable cells; click a
  column header LABEL selects that column across loaded rows (the filter/resize affordances stay
  separate targets); Shift+Space / Ctrl+Space; Shift+click extends; the pill labels endless counts
  "of loaded rows".
- **Row context menu** — *Insert row above / below* inserts a DRAFT adjacent to the clicked row,
  pre-seeded with its date/period so it sorts beside it after save (order is the adapter's canonical
  sort; the visual position before save is where it was inserted) · *Delete row(s)* — drafts vanish,
  saved rows go through the adapter's `deleteRow` with the consumer's permission gate + confirmation
  (never weakened) · *Clear row* — journalled clear of every editable cell · plus the consumer's own
  items (view history, copy row as TSV, discard changes on this row, domain actions).
- **Column resize / reorder / hide** — drag the header edge (persist widths), drag the header to
  reorder within its pin group (persist order), hide via the header menu / settings (persist), "reset
  to defaults"; all per user per `tableId` through the generalised settings provider. Frozen offsets,
  `minWidth`, summary spans and the caret-follow all read the LIVE column table so nothing drifts.

---

## 4. The Google-Sheets parity checklist — the spec AND the test list

Playwright spec IDs (`e2e/table/…`). "Today" = the Cenapro ledger per audit table B.

| ID | Behaviour | v1 | Today |
|---|---|---|---|
| T01 | Click selects, does not edit | must | ✓ |
| T02 | Typing a printable char type-overs into an editor (single cell AND after an up/left range drag → same cell, A1) | must | ✓ / ✗ platform bug |
| T03 | Enter opens editor; F2 / double-click preserve; Enter-while-editing commits + moves down; Shift+Enter up | must | ✓ |
| T04 | Tab / Shift+Tab commit + move, wrap rows; Tab-run then Enter returns to lane | must | ✓ |
| T05 | Arrows skip cells the row does not have (sub-rows) | must | ✓ |
| T06 | Ctrl/Cmd+Arrow jump to data edge; Home/End; Ctrl+Home/End; PageUp/PageDown | must | ✗ |
| T07 | Shift+click, Shift+Arrow, drag rectangles; drag to edge auto-scrolls; pinned block is a wall | must | ✓ |
| T08 | Ctrl/Cmd+A selects only selectable columns (A8) | must | ~ |
| T09 | Click row number → row selected; click header label → column selected; Shift+Space / Ctrl+Space | must | ✗ |
| T10 | Delete/Backspace clears cell/range without an editor and keeps the selection | must | ✓ |
| T11 | Escape while editing reverts; Escape not editing undoes the selection's unsaved edits, then deselects | must | ✓ |
| T12 | Undo/Redo across typing, clears, pastes, fills, clear-row (Ctrl+Z / Ctrl+Y / Cmd+Shift+Z) | must | ✗ |
| T13 | Ctrl/Cmd+C copies a single cell or a range as escaped TSV of STORED values; ₱ columns absent for a gated viewer | must | ✓ |
| T14 | Ctrl/Cmd+V pastes a block at the anchor; a block taller than the sheet creates draft rows; overflow is reported never truncated | must | ✓ |
| T15 | Paste ONE value onto a selected range fills every addressable cell; an exact-multiple block tiles | must | ✗ |
| T16 | Paste onto heterogeneous rows lands only on same-kind rows and reports skipped cells (A4) | must | ✗ bug |
| T17 | Paste validates through `parse` and clears a stale invalid mark (A5) | must | ✗ |
| T18 | Right-click selects the cell under it and opens the menu; menu close returns focus (A10/A18) | must | ✗ |
| T19 | Insert row above/below (draft, seeded), Delete row(s) (gated + confirmed), Clear row (journalled) | must | ✗ |
| T20 | Column resize by drag, reorder by drag within pin group, hide/show, reset — persisted per user per table and restored on reload | must | ✗ |
| T21 | Clicking a selectable-but-read-only cell never deadens the keyboard (A2); a click on any cell coordinate lands somewhere (A19) | must | ✗ |
| T22 | Draft rows: 20 by default, "Add N more" (1–500), untouched draft is not unsaved work, seeded date, typed-back-to-seed stays clean | must | ✓ |
| T23 | Dirty tracking: typing a value back to stored drops the row from unsaved; the "N unsaved" chip, Save button and axis guard read ONE number | must | ✓ |
| T24 | Axis guard: changing scope/period/filter with unsaved work prompts Save-and-continue / Discard / Cancel; no prompt when the axes key does not change | must | ✓ |
| T25 | Endless: keyset window pages both ways with no scroll jump on prepend (items, not records — A13/A14); Focus: whole period, day groups + summary rows | must | ~ |
| T26 | Per-column filters are pushed to SQL, held in the URL, shown as chips, and never expose a hidden (₱) column | must | ✓ |
| T27 | Aggregate pill: SUM/AVERAGE/COUNT/MIN/MAX over stored values, per-column defaults, COUNT correct on heterogeneous rows | must | ~ |
| T28 | Frozen columns stay opaque and edged while scrolling both axes; header/footer never bleed | must | ✓ |
| T29 | A keystroke re-renders one row (perf gate: React Profiler commit count in a Playwright trace ≤ 2 rows) | must | ✗ |
| T30 | Cut (Ctrl+X) | later | ✗ |
| T31 | Fill handle drag + Ctrl+D / Ctrl+R | later | ✗ |
| T32 | Per-column sort (breaks the keyset cursor — needs a data-layer decision) | later | ✗ |
| T33 | Find (Ctrl+F) inside the sheet | later | ~ (toolbar search) |

---

## 5. Phases (each = plan mode → approval → build → DoD → merge to `main`)

### Phase 0 — Fix the three dangerous findings IN PLACE (small, ships first)

Not the extraction — surgical fixes to what exists, because they are live bugs today:
- **A1** (`lib/hooks/use-grid-keyboard-nav.ts`): typing over an up/left-dragged range seeds the edit
  in one cell and mounts the editor in another. Fix in the platform hook (affects every grid) so the
  range branch and the char branch agree on the cell.
- **A3** (`app/(app)/cenapro/deliveries/actions.ts::deleteDelivery`): no `canViewPrices()` gate; the
  refusal dialog and success toast print cheque numbers and ₱ to a Production role. Gate the ₱ in the
  payload (null `allocatedPhp`/`releasedPhp`/`blocking[].amountPhp` etc. server-side, render "figures
  hidden by your role") and decide the role gate on delete with Renzo (recommend `requirePrivileged()`
  like RC IN's delete).
- **A4** (`deliveries-ledger.tsx::applyClipboardPaste`): a multi-row paste onto a receipt with
  moisture sub-rows scatters cells across kinds and toasts success. Minimal fix: map block rows to the
  next same-kind (receipt/draft) nav rows and report skipped sub-row cells; the full `occupies()`
  design lands in Phase 1.
- Also A2 (clicking TTL PRICE nulls the active cell) if it is a two-line fix in the ledger's
  `onMouseDown`.
DoD: `npm run build`, `npm run lint`, `npx tsx scripts/verify-rc-deliveries-cells.ts` green (+ new
assertions for A1/A4), a browser check of each repro in `01-audit…` A1–A4, `CONTEXT.md` updated,
BUG_LEDGER entries. Merge to `main`.

### Phase 1 — Build the module; migrate the Cenapro RC Deliveries ledger onto it; Playwright

1. Create `lib/table/`, `components/shared/table/`, evolve `lib/hooks/`, generalise the settings
   provider (§3). Donor code: `cenapro/deliveries/types.ts` (generic 55%), `deliveries-ledger.tsx`
   (generic ~44% + the entangled 21% re-expressed through the three contracts), `use-deliveries-window.ts`,
   `ledger-url.ts` (both Cenapro modules'), `production/period-picker.tsx` + `ledger-controls.tsx`
   (Cenapro production's URL-axes `PeriodPicker` / `ScopeToggle` — the one Renzo likes; the ICTC
   production `ProductionPeriodProvider` context is the OTHER pattern and is replaced in Phase 3).
2. Rebuild `app/(app)/cenapro/deliveries/` as the FIRST consumer: `types.ts` shrinks to the domain
   half (supplier/warehouse parse pairs, formula cells, samples sub-row kind, settlement column,
   flag/duplicate surfacing, `PRICE_FIELDS`), `deliveries-ledger.tsx` becomes an adapter + column
   specs + row kinds + consumer menu items over `<BlackwoodTable>`. Behaviour byte-identical except
   the fixed audit findings and the D5 additions.
3. **Playwright**: add `@playwright/test`, `playwright.config.ts`, `npm run test:e2e`, `e2e/table/`.
   The parity suite runs against a **dev-only playground route** `app/(app)/dev/table-playground/
   page.tsx` (returns `notFound()` in production unless `TABLE_PLAYGROUND=1`) that mounts
   `<BlackwoodTable>` on an **in-memory mock data source** — the "static mock adapter" CLAUDE.md's
   Grafana model always intended: deterministic rows incl. sub-rows, a formula-ish column, a pinned-end
   column, a hidden-for-role column, a slow-page toggle for T25. Every T-row in §4 marked *must* is a
   spec (T30–T33 are `test.fixme`). Plus one smoke spec per real consumer route (loads, types, saves a
   draft, deletes it — using the `feature-tester` discipline: create → verify → clean up). Dev server:
   `env -u ANTHROPIC_API_KEY npm run dev` (known env quirk); Supabase REST is reachable from the sandbox.
4. `scripts/verify-table-core.ts` (pure helpers moved from the Cenapro verify script + the journal +
   tile-paste + `occupies` + pin geometry) — framework-free, `npx tsx`, must stay green.
5. Run `perf-reviewer` on the module + migrated ledger as a gate: T29 must pass (one row per keystroke;
   focus scope on March 2026 must type smoothly).
DoD: build + lint + all verify scripts + Playwright green; `components/shared/table/CONTEXT.md`
written; `components/shared/grid/CONTEXT.md` + `cenapro/deliveries/CONTEXT.md` rewritten (delete
what moved, point at the module, keep the decisions); handoff file. Merge to `main`.

### Phase 2 — ICTC RC IN → `/inventory/rc-in`; RC OUT → `/inventory/rc-out`

Read `docs/universal-table/03-rc-in-out-feature-inventory.md` in full first — its "must survive"
verdicts, dead code, and bug list are binding.
- **Routes:** `app/(app)/inventory/rc-in/page.tsx` and `rc-out/page.tsx` (server components; URL axes
  → `fetchDeliveryPage` keyset / `fetchDeliveryMonth` focus / dimensions, mirroring Cenapro's
  `actions.ts` read side; new server actions, `supabase-backend-engineer`, price-gated with
  `canViewPrices()`, ₱ nulled before return). `app/(app)/inventory/page.tsx` becomes a **redirect shim**:
  `/inventory` → `/inventory/rc-in`; `?tab=usage` → `/inventory/rc-out`; `editBatch`/`search`/`year`
  forwarded — so every existing link (navbar, Blocking's and RC Movement's "Edit All" deep-links, old
  bookmarks) still works and **no Blocking file changes**. `?editBatch=X` on the new routes = apply the
  batch filter and focus the first matching row for inline editing (no dialog). Delete `logs-shell`,
  `sheet-tabs`, `inventory-tab-context`, `inventory-view`, `rc-out-lazy-tab`, `DeliverySheetFooter`.
  Add the two navbar breadcrumb entries BEFORE the `/inventory` catch-all and re-point the
  `ICTC_INVENTORY` dropdown (`components/navbar.tsx` — same template Blocking used).
- **Period control:** shared `PeriodPicker` (Year + Month) + `ScopeToggle`; endless is the default,
  opens at the newest row with the draft pool at the bottom (oldest → newest, Cenapro convention).
- **RC IN on the module** — column specs in RC IN order (CLAUDE.md "RC IN Column Config": state ·
  date · supplier · batch · block/loc · truck · sacks · weight · MC · grit · VM · ash · FC · BD ASTM ·
  BD JIS · remarks · PHP/KG · PHP total; note the inventory shows weight before sacks and lab order
  mc/grit/bd_astm/bd_jis/vm/ash/fc today — keep TODAY's visible order and let per-user reorder handle
  preference; ask Renzo in plan mode if unsure). Inline editing everywhere; drafts at the bottom;
  supplier / batch / block autocomplete become `select`/`text` cell kinds with the same
  `AutocompletePopover`; batch pick auto-fills block_loc; block_loc validated via `parse` client-side
  with the SAME rule as `lib/validation.ts` and again server-side; save = `submitBulkDeliveries` for
  drafts + `bulkUpdateDeliveries` for edits (transactional RPC, batch upsert-first, audit trail); the
  per-row **Edit Reason** (audit comment) survives as a context-menu item + an optional reason field
  on the Save confirmation applied to rows without one (propose in plan mode). **Filters pushed to
  SQL:** STATE (default excludes CLOSED unless the URL says otherwise — the `sx=_all` semantics
  survive as an explicit "all states" URL value), Supplier, LOC (with the WHSE grouping UI), Batch,
  plus the search; the old "auto-All-Years on filter + pre-filter restore" is retired BY DESIGN
  because endless filters run over history and focus filters AND with the month (say so in the
  CONTEXT). **Must survive:** density + font size + column visibility/resize (now via the module's
  settings), lab highlight thresholds (consumer `extras`), heat-tinted lab cells, expanded-mode
  annotations (or an explicit decision to drop — ask), conditional TOTALS summary row, row + column
  context menus (view history, copy row, filter by supplier/batch, delete gated `hasPermission('delete:all')`
  + server `PRIVILEGED_ROLES`), `DeliveryHistoryDialog` + audit resolve workflow (untouched — the
  `/edit/[auditLogId]` route imports RC IN's actions and `audit-shared.tsx`; keep those exports),
  `TrueWeightPopover` (Σ), the mobile card layer (`delivery-cards-mobile.tsx`, fed the module's
  loaded rows), price gating at every listed point, `?editBatch=`. **Dead — do not port:** the
  `initialSettings` prop-drill, `updateDelivery`, RC OUT's row-height slider, `?date=` in
  `notification-bell.tsx` (fix the link while there). **Bugs to fix, not port:** selection-bar bulk
  Delete not client-gated (both tables). Delete `bulk-delivery-input.tsx` and the Add/Edit dialogs
  once nothing imports them (`_shared/edit-delivery-dialog.tsx` is Blocking's — it stays).
- **RC OUT on the module** — same shape; RC OUT has NO footer strip today (its Year/Batch are toolbar
  popovers), so Year + Month + Endless/Focus is a deliberate UX addition. Keep: STATE (no STORED) /
  YEAR / BATCH / PLANT / BLOCK LOC filters (pushed to SQL), the **Closed Blocks** toggle view
  (`view_rc_out_closed_blocks`, lazy, read-only — render it as a second, read-only table on the same
  module or leave it as it is; ask), batch-code → batch_id resolution with the per-row "not found,
  skipped" behaviour moved into `parse` (refuse at commit — better than skipping silently; confirm),
  destination/batch autocomplete, the mobile layer, price gating (`fetchRcOutTabData` pattern: the
  server decides `canViewPrices`), delete gate. RC OUT has no audit-history viewer today — offer to
  add one mirroring RC IN's (the data exists) or record the decision not to.
- Settings: `tableId = 'rc_in'` and `'rc_out'` — the shared-slot bug ends here; migrate the existing
  `'rc_in'` row's shape once (density/fontSize/columnWidths/hiddenColumns/labHighlights → new shape).
DoD: build + lint + verify + Playwright (playground + RC IN/RC OUT smoke) green; a `feature-tester`
pass on RC IN (create draft → save → edit → save → delete → verify DB + audit_logs + batches
recompute); Blocking + RC Movement deep-links tested end-to-end (unchanged files); `inventory/
CONTEXT.md`, `rc-in/CONTEXT.md`, `rc-out/CONTEXT.md`, `NAVBAR.md` updated; TIMELINE + handoff.
Merge to `main`.

### Phase 3 — ICTC Production: Daily, Electricity, Trucks

Same module; period control = `PeriodPicker` in **Year + Batch** mode (production's own axis —
`production_batch` is not a calendar month, see `production/CONTEXT.md`); replace the
`ProductionPeriodProvider` context + per-tab `fetchedPeriodRef` dance with the URL-axes contract; keep
the three grids' domain rules (shift parent → runs/downtime/waste children, `fn_apply_production_
upstream` untouched, human-edit latch + `releaseProductionRows` buttons, natural keys for electricity
/ trucks, Trucks' Archetype-E phone summary), delete the hand-rolled keyboard/paste/dirty code they
each carry. Ask Renzo whether the Daily/Electricity/Trucks TABS stay under `/production` (a tab bar
that hosts three separate ledgers is not the thing he disliked — the year/month strip was) or split.

### Phase 4 — Flecon (scoped) + Cenapro production/QC

- **Flecon:** the ICTC `flecon-bags-view.tsx` is a READ-ONLY sync-fed matrix (inventory `04` row 19) →
  OUT of scope under D1. The editable Flecon surface is Cenapro's `flec-inventory-client.tsx` (opening
  balances, tiny) → migrate. State this to Renzo in plan mode so "Flecon" in D7 is not misread.
- **Cenapro production:** `production-endless-sheet.tsx` (+ `draft-entry-zone`), `production-ledger-grid.tsx`
  (the richest primitive consumer today), the pivots `production-endless-pivots.tsx` /
  `production-daily-block.tsx` (merged-rowSpan matrix — the DOM-order resolver case; decide whether
  the module supports a `matrix` row model or these two stay on the DOM-order primitives), the QC
  ledger `qc-ledger-client.tsx`, and (decide) the platform `components/digest/schedule-month-grid.tsx`.
  `CenaproPeriodPicker` is replaced by the module's `PeriodPicker` (Year + Batch mode) — it IS the
  donor, so this should be a rename.

### Phase 5 — Liquidation (confirm scope first)

The liquidation tables are read-only-with-dialogs; the two genuinely interactive ones are the cheque
`spread-panel.tsx` (allocation amounts on the edge) and `payments-panel.tsx`. Under D1 they are the
only candidates. Ask Renzo before building.

### Closing phase — retire and document

Delete `useGridPaste`, `useClipboardCopy`, `useCellDelete`, `GridCell` when unreferenced; rewrite
`components/shared/grid/CONTEXT.md` as a pointer; update `CLAUDE.md` ("Blackwood Table" section:
where the module lives, the three contracts, the parity checklist, how to add a consumer, the
Playwright command); TIMELINE; final handoff.

---

## 6. Traps and facts the audits established (do not rediscover them)

- `border-collapse: separate` is LOAD-BEARING for frozen panes; row rules go on the CELLS.
- `HTMLElement.focus()` scrolls to "center" through every ancestor — `preventScroll: true` always;
  React `autoFocus` is unfixable, use a ref callback (`focusNoScroll` / `EditInput`'s pattern).
- Virtuoso: hand RAW array indices IN, PUBLIC (`+ firstItemIndex`) OUT; `firstItemIndex` must move by
  the number of ITEMS prepended and never be pushed back up on reset (`react-virtuoso/dist/index.mjs`
  `:876-890` drives the scroll compensation off the delta).
- `paste` is a clipboard event dispatched only at an editable target — the SINK is not optional.
- The keyset cursor is welded to one ORDER BY per adapter; user sort is a data-layer redesign (T32).
- A field-level ₱ boundary is a SERVER boundary; the grid can only omit columns.
- `user_table_settings` is already generic; only the provider was hard-wired to `'rc_in'`.
- The `/inventory` shell's `?editBatch=` + `editView=` discriminator exists only because two tables
  were mounted on one URL; with own routes it collapses to `?editBatch=` alone (keep it via the shim).
- `blocking-detail-panel.tsx` imports RC IN's `DeliveryHistoryDialog`; `_shared/edit-delivery-dialog.tsx`
  imports `bulkUpdateDeliveries`; `/edit/[auditLogId]` imports six RC IN actions + `audit-shared.tsx` —
  keep every one of those exports.
- ANTHROPIC_API_KEY env quirk: `env -u ANTHROPIC_API_KEY npm run dev`. The Bash sandbox cannot reach
  Postgres :5432 (REST/Storage :443 work) — never test DB connections from Bash.
- Two deploy targets: this work is `app/**` only → `main` → Vercel; no Fly deploy.

---

## 7. Open decisions to confirm with Renzo in plan mode (recommendation in parentheses)

1. RC IN "Edit Reason" comment in an inline model (context-menu per row + optional Save-time reason).
2. RC IN expanded-mode annotations and bold/italic/underline column formats — keep or drop (keep
   density + font + widths + hidden; drop column formats unless he uses them).
3. RC OUT audit-history viewer — add one mirroring RC IN's? (yes, cheap, data exists).
4. RC OUT Closed Blocks view — read-only table on the module or untouched (untouched, it is read-only).
5. Delete-role gate on Cenapro `deleteDelivery` (privileged only, like RC IN).
6. Production tabs under `/production` — keep the tab bar with the shared Year + Batch picker (keep).
7. Cenapro daily pivots (merged-rowSpan matrix) — module row-model support or stay on DOM-order
   primitives (stay, unless the module's `matrix` kind falls out cheaply).
8. Liquidation scope (spread + payments panels only, later).
9. Column reorder across the pin boundary — allowed? (no; reorder within pin group only).
10. Undo history survives Save? (no — cleared on save; Sheets muscle memory tolerates it and it keeps
    "unsaved" honest).

---

## 8. Working agreement for the implementing agent

- Enter plan mode for the phase, present the plan (files, contracts, tests, DoD, questions from §7),
  get approval, then build. Do the work yourself where a subagent would only narrate; use ONE
  subagent at a time; verify subagent output on disk.
- Every phase ends with: `npm run build`, `npm run lint`, every `scripts/verify-*.ts`, Playwright,
  CONTEXT.md updates, BUG_LEDGER entries for fixed bugs, TIMELINE + handoff, then git via
  `git-branch-guardian` (`git add .`, conventional commit, push `feat/universal-table`; merge to
  `main` only when the phase's DoD is met and Renzo has said ship).
- End each phase with a summary of what was built, what files changed, and every decision made or
  deferred — in plain business language first, code details second.

## Decisions log

- 2026-08-17 — D1–D8 above (Renzo, via two rounds of questions). Research pack filed under
  `docs/universal-table/`.
