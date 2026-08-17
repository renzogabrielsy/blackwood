# Blackwood Table Inventory — Full Report (2026-08-17)

> Read-only inventory of every table / grid / ledger component in the app (55 components), produced for the universal-table plan. Scope of the migration is the EDITABLE ledgers only (Renzo, 2026-08-17); the read-only rows are listed so nothing is missed, not because they migrate.


# Blackwood Table Inventory — Full Report

*Scope: `app/(app)/**`, `components/**`, `lib/hooks/**`. Excludes `_archived/`, `node_modules/`, `workers/`. All paths below are relative to `/Users/renzosy/blackwood/`.*

## DELIVERABLE 1 — Table Component Catalog (55 components)

### Cenapro tenant (15)

| # | file path | route / where mounted | tenant | kind | render tech | shared grid primitives used | period / nav control | frozen panes? | per-user settings? | price gating? | mobile layer? | LOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `app/(app)/cenapro/deliveries/deliveries-ledger.tsx` | `/cenapro/deliveries` | Cenapro | editable-ledger | react-virtuoso `TableVirtuoso` | `useGridEditSession`, `useGridKeyboardNav`, `useGridContextMenu`, `useCellSelection`, `useCellAggregation`, `EditInput`, `GridContextMenu` (bespoke paste/copy/delete — does **not** use `useGridPaste`/`useClipboardCopy`/`useCellDelete`) | Endless/Focus `ScopeToggle` (local) + one combined "Month YYYY" dropdown (focus only) + issue lens + 6 column filters + search — all URL params | Y (`separate`, both axes) | N | Y (33 call sites) | N | 5494 |
| 2 | `app/(app)/cenapro/liquidation/banks/banks-view.tsx` | `/cenapro/liquidation/banks` | Cenapro | read-only-table (+CRUD dialogs) | plain `<table>` | none/hand-rolled | none | Y (`separate`) | N | N | N | 834 |
| 3 | `app/(app)/cenapro/liquidation/liquidation-view.tsx` | `/cenapro/liquidation` | Cenapro | read-only-table (balance tree) | plain `<table>` | none/hand-rolled | none | Y (`separate`) | N | N | N | 976 |
| 4 | `app/(app)/cenapro/liquidation/opening-balance-dialog.tsx` | dialog from liquidation-view | Cenapro | read-only-table (history, in dialog) | plain `<table>` | none/hand-rolled | none | Y (`separate`) | N | N | N | 711 |
| 5 | `app/(app)/cenapro/liquidation/payments-panel.tsx` | Sheet, per-trader, from liquidation-view | Cenapro | read-only-table (+void/restore) | plain `<table>` | none/hand-rolled | none | Y (`separate`) | N | N | N | 614 |
| 6 | `app/(app)/cenapro/liquidation/spread-panel.tsx` | opened from payments-panel / deliveries-ledger ctx-menu | Cenapro | read-only-table (interactive allocation) | plain `<table>` | none/hand-rolled | none | Y (`separate`) | N | N | N | 662 |
| 7 | `app/(app)/cenapro/liquidation/subgroups/subgroups-view.tsx` | `/cenapro/liquidation/subgroups` | Cenapro | read-only-table (+CRUD) | plain `<table>` | none/hand-rolled | none | Y (`separate`) | N | N | N | 308 |
| 8 | `app/(app)/cenapro/production/production-daily-block.tsx` | inside production-ledger-grid.tsx (`?view=daily-w6/w7`, focus scope) | Cenapro | editable matrix (merged-rowSpan pivot) | plain `<table>` | `EditInput`, `useGridEditSession`, `useGridKeyboardNav` (DOM-order resolver) | inherits parent's View/Scope/Filter axes | N (none found) | N | N | N (desktop-only) | 2344 |
| 9 | `app/(app)/cenapro/production/production-endless-pivots.tsx` | `/cenapro/production` (endless + daily-w6/w7) | Cenapro | editable matrix, virtualized | react-virtuoso `TableVirtuoso` | `EditInput`, `GridContextMenu`, `useGridContextMenu`, `useGridKeyboardNav` (DOM-order) — **no** `useGridEditSession` | `ViewModeSwitcher` + `ScopeToggle` + `CenaproPeriodPicker` (jump-to anchor) | Y (`separate`, x2 tables) | N | N | N | 2143 |
| 10 | `app/(app)/cenapro/production/production-endless-sheet.tsx` | `/cenapro/production` (endless + ledger, default) | Cenapro | editable-ledger, virtualized, in-list draft pool | react-virtuoso `TableVirtuoso` | `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useGridKeyboardNav` (coordinate), `useGridEditSession`, `EditInput` (via draft-entry-zone.tsx) | `ViewModeSwitcher` + `ScopeToggle` + `CenaproPeriodPicker` + 6-col filter axis | Y (`separate`) | N | N | N | 1787 |
| 11 | `app/(app)/cenapro/production/production-ledger-cards-mobile.tsx` | `/cenapro/production` (ledger view, mobile) | Cenapro | mobile-cards | `@tanstack/react-virtual` (via MobileCardList) | `MobileCardList` | inherits parent filters | n/a | N | N | *is* the mobile layer | 420 |
| 12 | `app/(app)/cenapro/production/production-ledger-grid.tsx` | `/cenapro/production` (focus scope, any view) — hosts Daily Block + mobile | Cenapro | editable-ledger (**canonical/richest** — CONTEXT.md's named source for SelectCell/DatePickerCell/a context menu) | plain `<table>` | `GridCell`, `SelectCell`, `DatePickerCell`, `GridContextMenu`, `useGridContextMenu`, `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useGridKeyboardNav`, `useGridEditSession` (`useGridPaste` is **imported but never called** — dead import; paste is hand-rolled) | `CenaproPeriodPicker` (Year+Batch) + `ViewModeSwitcher` + `ScopeToggle` + 6-col filter axis | Y (`separate`) | N | N | Y (#11) | 1771 |
| 13 | `app/(app)/cenapro/qc/breakdown/qc-breakdown-client.tsx` | `/cenapro/qc/breakdown` | Cenapro | read-only-table (2 rollup tables) + charts | plain `<table>` x2 | none/hand-rolled | `MonthYearPicker` (`?m=`) | N | N | N | N | 545 |
| 14 | `app/(app)/cenapro/qc/qc-ledger-client.tsx` | `/cenapro/qc` | Cenapro | editable-ledger | plain `<table>` | `GridCell`, `EditInput`, `useGridEditSession`, `useGridKeyboardNav` — **no** context-menu/range-selection/paste hooks | `MonthYearPicker` (`?m=`) | row-only (`.frozen-row`/`.frozen-row-bottom`, no frozen columns) | N | N | N | 2378 |
| 15 | `app/(app)/cenapro/inventory/flec-inventory-client.tsx` | `/cenapro/inventory` | Cenapro | editable-ledger (small — opening balances) | shadcn `<Table>` (full) | none/hand-rolled (plain `<Input>`+`<Popover>`, no shared grid hooks) | none | N | N (localStorage display pref only) | N | N | 968 |

### ICTC inventory tenant (11)

| # | file path | route / where mounted | tenant | kind | render tech | shared grid primitives used | period / nav control | frozen panes? | per-user settings? | price gating? | mobile layer? | LOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 16 | `app/(app)/inventory/_shared/blend-proposal-dialog.tsx` | dialog from blocking-grid.tsx | ICTC | read-only-table (dialog + PDF export) | plain `<table>` | none/hand-rolled | none | N | N | N (no `canViewPrices` call, though it renders ₱ figures — relies on caller-level gating) | N | 621 |
| 17 | `app/(app)/inventory/_shared/blocking-detail-panel.tsx` | slide-over from blocking-grid.tsx **and** rc-movement-matrix.tsx | ICTC | read-only-table (panel; also builds a print-HTML `<table>` string) | plain `<table>` x2 | none/hand-rolled | none | N | N | Y | N | 1135 |
| 18 | `app/(app)/inventory/blocking/blocking-grid.tsx` | `/inventory/blocking` | ICTC | matrix (warehouse heatmap) | **CSS grid** (`grid blocking-grid-cols`, `grid-template-columns` off `--blocking-cols`; NOT `<table>`) | none/hand-rolled | `?block=` URL param (cell selection, not a period) | n/a | Y (`useTableSettings`) | Y (localStorage toggle) | N | 1364 |
| 19 | `app/(app)/inventory/flecon-bags/components/flecon-bags-view.tsx` | `/inventory/flecon-bags` | ICTC | matrix (read-only, Excel-mirror) | plain `<table>` | none/hand-rolled | none (whole ledger + Forwarded/Current Balance rows) | Y (`separate`) | N | N (explicitly, "NO price data anywhere") | N | 708 |
| 20 | `app/(app)/inventory/rc-in/bulk-delivery-input.tsx` | `<Dialog>` from delivery-master-table.tsx (Add/Edit Deliveries) | ICTC | **bulk-input-dialog** | plain `<table>` + shadcn `TableRow/Cell/Head/Header` parts | `GridCell`, `RemarksCellAdaptor`, `AutocompletePopover`, `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useGridKeyboardNav`, `useGridEditSession`, `useGridPaste` — **the fullest hook suite in the app** | none (fixed-size draft grid) | N | Y (`useTableSettings`) | Y | N | 1053 |
| 21 | `app/(app)/inventory/rc-in/components/delivery-cards-mobile.tsx` | RC IN mobile layer | ICTC | mobile-cards | `@tanstack/react-virtual` (via MobileCardList) | `MobileCardList` | inherits DeliverySheetFooter's year/month | n/a | N | Y | n/a | 574 |
| 22 | `app/(app)/inventory/rc-in/delivery-master-table.tsx` | `/inventory` (Deliveries tab, default) | ICTC | read-only-table (+row-select, bulk delete, inline history) | TanStack Table (`useReactTable`) + `@tanstack/react-virtual`, **plain `<table>`** (file comment: "Shadcn table components not used — using raw HTML elements for density control") | `GridContextMenu`, `useGridContextMenu`, `useCellSelection`, `useClipboardCopy`, `useCellAggregation`, `useTableSettings` | `DeliverySheetFooter` — Year + 12-month sliding strip | N | Y (the *owning* `useTableSettings` slot — default `tableId='rc_in'`) | Y | Y (#21) | 2332 |
| 23 | `app/(app)/inventory/rc-movement/rc-movement-matrix.tsx` | `/inventory/rc-movement` | ICTC | matrix (read-only, campaign feed) | plain `<table>` | none/hand-rolled | `?campaign=<BATCH-YEAR>` URL param (campaign-scoped; no year/month dropdown) | Y (`separate`) | N | Y (Fed ₱/kg column price-gated) | N | 1591 |
| 24 | `app/(app)/inventory/rc-out/bulk-usage-input.tsx` | `<Dialog>` from rc-out-table.tsx (Add/Edit Usage) | ICTC | **bulk-input-dialog** | plain `<table>` + shadcn parts | `GridCell`, `AutocompletePopover`, `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useGridKeyboardNav`, `useGridEditSession`, `useGridPaste`, `useTableSettings` | none | N | Y (reads the **shared, RC-IN-keyed** `useTableSettings` slot — see prose (b)/(d)) | N | N | 891 |
| 25 | `app/(app)/inventory/rc-out/components/rc-out-cards-mobile.tsx` | RC OUT mobile layer | ICTC | mobile-cards | `@tanstack/react-virtual` (via MobileCardList) | `MobileCardList` | inherits header Year/Batch multi-select | n/a | N | Y | n/a | 607 |
| 26 | `app/(app)/inventory/rc-out/components/rc-out-table.tsx` | `/inventory` (Usage tab, lazy) | ICTC | read-only-table (+row-select, bulk delete, Closed-Blocks toggle) | TanStack Table + `@tanstack/react-virtual` + shadcn `Table*` sub-parts | `useCellSelection`, `useClipboardCopy`, `useCellAggregation`, `useTableSettings` | Header **multi-select Year + Batch checkbox popovers** (its own, NOT `DeliverySheetFooter`) | N | Y (reads the shared RC-IN slot) | Y | Y (#25) | 1471 |

### ICTC production tenant (6)

| # | file path | route / where mounted | tenant | kind | render tech | shared grid primitives used | period / nav control | frozen panes? | per-user settings? | price gating? | mobile layer? | LOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 27 | `app/(app)/production/daily/daily-cards-mobile.tsx` | `/production` (Daily tab, mobile) | ICTC | mobile-cards | `@tanstack/react-virtual` (via MobileCardList) | `MobileCardList` | Universal Year+Batch `PeriodPicker` (inherited) | n/a | N | N | n/a | 293 |
| 28 | `app/(app)/production/daily/daily-ledger-grid.tsx` | `/production` (Daily tab) | ICTC | editable-ledger | plain `<table>` + shadcn `Table*` parts | `GridCell`, `DatePickerCell`, `GridContextMenu`, `useGridContextMenu`, `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useGridKeyboardNav`, `useGridEditSession` | Universal Year+Batch `PeriodPicker` (`ProductionPeriodProvider`, mounted once in `(tabs)/layout.tsx`) | Y (`separate`) | N | N | Y (#27) | 2200 |
| 29 | `app/(app)/production/electricity/electricity-cards-mobile.tsx` | `/production` (Electricity tab, mobile) | ICTC | mobile-cards | `@tanstack/react-virtual` (via MobileCardList) | `MobileCardList` | Universal `PeriodPicker` (inherited) | n/a | N | N | n/a | 135 |
| 30 | `app/(app)/production/electricity/electricity-grid.tsx` | `/production` (Electricity tab) | ICTC | editable-ledger | plain `<table>` + shadcn parts | `GridCell`, `RemarksCellAdaptor`, `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useGridKeyboardNav`, `useGridEditSession` | Universal Year+Batch `PeriodPicker` | N (sticky header only, plain collapse) | N | N | Y (#29) | 658 |
| 31 | `app/(app)/production/setups/setups-manager.tsx` | `/production/setups` (own route, **outside** the tab shell) | ICTC | read-only-table (+add/edit/retire/restore/reorder dialogs) | plain `<table>` | none/hand-rolled | none (whole setup library) | N | N | N | N | 523 |
| 32 | `app/(app)/production/trucks/trucks-grid.tsx` | `/production` (Trucks tab) | ICTC | editable-ledger | plain `<table>` + shadcn parts | `GridCell`, `DatePickerCell`, `useCellSelection`, `useClipboardCopy`, `useCellDelete`, `useCellAggregation`, `useGridKeyboardNav`, `useGridEditSession` | Universal Year+Batch `PeriodPicker` | Y (`separate`) | N | N | Y — but **bespoke inline "Archetype E" phone-summary** in the same file (`sm:hidden`), **not** `MobileCardList` | 950 |

### Platform / other tenant (7)

| # | file path | route / where mounted | tenant | kind | render tech | shared grid primitives used | period / nav control | frozen panes? | per-user settings? | price gating? | mobile layer? | LOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 33 | `app/(app)/shipments/[cardId]/page.tsx` | `/shipments/[cardId]` | Platform | read-only-table (attachments list) | plain `<table>` | none/hand-rolled | none | N | N | N | N | 349 |
| 34 | `app/(app)/summaries/supplier-brief-client.tsx` | `/summaries` (By Supplier view) | Platform | read-only-table (analyst, copy/aggregate) | plain `<table>` | `useCellSelection`, `useClipboardCopy`, `useCellAggregation` | Year tabs | N | N | Y | Y (#35) | 2304 |
| 35 | `app/(app)/summaries/supplier-cards-mobile.tsx` | `/summaries` mobile | Platform | mobile-cards | `@tanstack/react-virtual` (via MobileCardList) | `MobileCardList` | inherits parent | n/a | N | Y | n/a | 367 |
| 36 | `app/(app)/price-demos/demo2/page.tsx` | `/price-demos/demo2` | Platform (design demo, mock data) | read-only-table | plain `<table>` | none/hand-rolled | none (mock data only) | N | N | N | N | 514 |
| 37 | `app/(app)/price-demos/demo4/analyst-brief-client.tsx` | `/price-demos/demo4` **and** `/summaries` (By Period — imported directly, not duplicated) | Platform | read-only-table (analyst, copy/aggregate) | plain `<table>` | `useCellSelection`, `useClipboardCopy`, `useCellAggregation` | Year tabs | N | N | Y | Y (#38) | 1541 |
| 38 | `app/(app)/price-demos/demo4/monthly-delivery-cards-mobile.tsx` | `/price-demos/demo4` + `/summaries` mobile | Platform | mobile-cards | `@tanstack/react-virtual` (via MobileCardList) | `MobileCardList` | inherits parent | n/a | N | Y | n/a | 270 |
| 39 | `app/(app)/admin/components/UserManagementTable.tsx` | `/admin` | Platform | read-only-table (+role edit, revoke/invite dialogs) | shadcn `<Table>` (full) | none/hand-rolled | none | N | N | N | N | 168 |

### Platform — home digest (`components/digest/`) (7)

| # | file path | route / where mounted | tenant | kind | render tech | shared grid primitives used | period / nav control | frozen panes? | per-user settings? | price gating? | mobile layer? | LOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 40 | `components/digest/bag-inventory.tsx` | `/` (home digest board) | Platform | read-only-table | plain `<table>` | none/hand-rolled | none (today's snapshot) | N | N | N (comment confirms: no ₱) | N | 170 |
| 41 | `components/digest/digest-footer-band.tsx` | `/` (home digest board) | Platform | read-only-table (small "Data Freshness") + card widgets | plain `<table>` | none/hand-rolled | none | N | N | N | N | 219 |
| 42 | `components/digest/schedule-cards-mobile.tsx` | `/?view=schedule` + `/production/schedule`, mobile | Platform | **list** (hand-rolled `<ul>`/`ScheduleRowCard` — **not** `MobileCardList`) | plain list | none/hand-rolled | month prev/next (inherited) | n/a | N | N | *is* the mobile layer | 51 |
| 43 | `components/digest/schedule-conflict-dialog.tsx` | dialog from schedule-month-grid.tsx | Platform | read-only-table (upstream-conflict diff) | plain `<table>` | none/hand-rolled | none | N | N | N | N | 293 |
| 44 | `components/digest/schedule-month-grid.tsx` | `/?view=schedule` + `/production/schedule` | Platform | editable-ledger (matrix, day rows) — explicitly "Built on the shared Blackwood Table primitives... No second editing engine" | plain `<table>` | `GridCell`, `EditInput`, `DatePickerCell`, `SelectCell` (via `schedule-setup-cell.tsx`), `useGridEditSession`, `useGridKeyboardNav` (DOM-order) | Month `prev`/`next` `<Link>` (`?month=`) — no dropdowns | N (no frozen columns) | N | N (no ₱ in the schedule domain) | Y (#42) | 1391 |
| 45 | `components/digest/schedule-table.tsx` | shared by `SchedulePreview` (home digest) + `SchedulePreviewMobile` bottom sheet | Platform | read-only-table (shared dense display) | plain `<table>` | none/hand-rolled | none (5-row preview slice) | N | N | N | n/a | 174 |
| 46 | `components/digest/trucks-summary.tsx` | `/` (home digest board) | Platform | read-only-table | plain `<table>` | none/hand-rolled | none (today's snapshot) | N | N | N | N | 101 |

### Platform — review queue & sync cases (9)

| # | file path | route / where mounted | tenant | kind | render tech | shared grid primitives used | period / nav control | frozen panes? | per-user settings? | price gating? | mobile layer? | LOC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 47 | `components/review-queue/ClassifiedRowsTable.tsx` | `/review-queue` (via `ReviewDetailPanel.tsx`) | Platform | read-only-table (approve/reject decisions; renders `cost_basis` un-gated — page itself is `PRIVILEGED_ROLES`-only) | plain `<table>` (desktop) | `MobileCardList` (own built-in mobile layer, same file) | none | N | N | N (route-level gate, not cell-level) | Y (built-in, same file) | 613 |
| 48 | `components/sync/cases/CaseDetail.tsx` | `/sync/cases` detail pane (via `CasesClient`) | Platform | read-only-table (orchestrator; composes #50–53,55) | plain `<table>` (via children) | none/hand-rolled | none | n/a | N | N | N | 541 |
| 49 | `components/sync/cases/CaseThread.tsx` | inside CaseDetail | Platform | read-only-table (message-thread markdown table) | plain `<table>` | none/hand-rolled | none | N | N | N | N | 216 |
| 50 | `components/sync/cases/CreateBatchCard.tsx` | inside CaseDetail (`unmapped_batch_code`) | Platform | read-only-table (x2 preview) | plain `<table>` | none/hand-rolled | none | N | N | N | N | 208 |
| 51 | `components/sync/cases/FindingDetailCards.tsx` | inside CaseDetail | Platform | read-only-table (multiple per-kind comparison tables — largest of the group) | plain `<table>` | none/hand-rolled | none | N | N | N | N | 807 |
| 52 | `components/sync/cases/GroupResolutionCard.tsx` | inside CaseDetail | Platform | read-only-table | plain `<table>` | none/hand-rolled | none | N | N | N | N | 102 |
| 53 | `components/sync/cases/ResolutionCard.tsx` | inside CaseDetail | Platform | read-only-table | plain `<table>` | none/hand-rolled | none | N | N | N | N | 158 |
| 54 | `components/sync/cases/RunGroupedList.tsx` | `/sync/cases` left rail (via `CasesClient`) | Platform | **list** (+ embedded per-run `<table>`) | plain `<table>` (per group) | none/hand-rolled | filter chips (all/open/investigated/known) — not a period control | N | N | N | N | 347 |
| 55 | `components/sync/cases/SourceDiffCard.tsx` | inside CaseDetail (`source_diff` resolution) | Platform | read-only-table (comparison) | plain `<table>` | none/hand-rolled | none | N | N | N | N | 480 |

**Excluded after inspection (checked, no genuine data-table render):** `production-view.tsx` (Cenapro, 51-line thin remount wrapper), `delivery-history-dialog.tsx` / `assign-cheque-dialog.tsx` (Cenapro, no `<table>`), `components/review-queue/PendingReviewList.tsx` (a `grid md:grid-cols-2` of `<Card>`s, not tabular), `price-demos/demo1` and `demo3` (chart-only, no `<table>`), `components/production/setup-form-dialog.tsx` (form, not a table), `components/jarvis/JarvisMessage.tsx` (a `ReactMarkdown` component override that styles **markdown**-authored tables in chat replies — not an app data grid), `delivery-master-table-wrapper.tsx` / `rc-out-table-wrapper.tsx` (pure `next/dynamic({ssr:false})` code-split shims, no markup of their own), `CasesClient.tsx` (orchestrator, no direct `<table>`).

Combined line count of the 55 catalogued components: **≈54,600 lines.**

---

## DELIVERABLE 2 — Prose

### (a) The Cenapro PRODUCTION period control (Renzo's favorite) vs. the ICTC production picker

**Cenapro (`app/(app)/cenapro/production/`) — pure-URL, three orthogonal axes, server-resolved:**

`ledger-url.ts` is a pure module (no `'use client'`, no Next import) owning three independent axes so the server page and every client toolbar share one contract:
- **VIEW** — `?view=ledger|daily-w6|daily-w7` (default `ledger`, omitted from the URL).
- **SCOPE** — `?scope=endless|focus` (default `endless`, omitted; legacy `?focus=1` still maps to `focus`).
- **FILTER** — six per-column multi-select params (`shift`, `grade`, `plant`, `whse`, `src`, `ccc`), each holding a comma-joined value list; an empty selection is "show all" and the param is dropped entirely.

`page.tsx` (server component) resolves all three axes from `searchParams`, resolves the active period (`?year=&batch=`, or the newest period if absent/invalid), and branches into exactly one of three trees — every VIEW × SCOPE combination is reachable, no dead ends:
1. `endless + ledger` → `ProductionEndlessSheet`, server-prefetching one keyset window anchored at the resolved period (or "latest").
2. `endless + daily-w6/w7` → `ProductionEndlessPivots`, server-prefetching one anchored day-window.
3. `focus + any view` → `ProductionView` → `ProductionLedgerGrid`, which fetches **every row of the one selected period** and is fully editable; its own toolbar switches VIEW/SCOPE internally.

**The Year + Batch dropdowns** live in `period-picker.tsx`'s `CenaproPeriodPicker` — a *local* client component (not a shared React context), rendered independently inside each of the three trees' own toolbar. `periods` (newest-first) comes from the server via `fetchCenaproPeriods()`; the Year `<Select>` and Batch `<Select>` share a `go(year, batch)` callback that does `router.replace('?year=&batch=', {scroll:false})` inside `useTransition` (so the toolbar shows a spinner during the round trip), while **preserving** the `view`/`scope`/filter params already in the URL. There is deliberately no "All periods" option.

**Critically, the dropdown behaves differently by scope, because it's the same URL params doing two different jobs:**
- In **Focus** scope, picking a Year/Batch **clamps** the query — only that period's rows are fetched into the fully-editable grid.
- In **Endless** scope, picking a Year/Batch is a **jump-to anchor** — the endless keyset-paginated infinite scroll doesn't leave endless mode; the component just remounts (keyed by `` `${anchorKey}|${filterKey}` ``) with a freshly server-prefetched window and a new `firstItemIndex` positioned at that point in history.

**The Endless/Focus toggle** (`ledger-controls.tsx`'s `ScopeToggle`, plus a sibling `ViewModeSwitcher`) is a small segmented pill control, also `router.replace`-driven inside `useTransition`, deleting the legacy `?focus=1` param on any use and preserving `view`/`year`/`batch`. A `useLedgerFilters()` hook in the same file gives the six filter menus **optimistic local state**: it mirrors the pending selection so checkboxes tick instantly while the URL write (and the server re-fetch it triggers) is still in flight, then drops the mirror the moment the real URL settles (including on Back/Forward).

**ICTC production (`app/(app)/production/components/`) — a persistent React Context, Year + Batch only, no scope/filter axes:**

`ProductionPeriodProvider` (`production-period-context.tsx`) is mounted exactly **once**, in `(tabs)/layout.tsx`, wrapping the whole Daily/Electricity/Trucks tab shell — this is documented as the "Universal Period Control" (2026-05-29) and is explicitly *never* disabled by any individual tab's loading state. It holds `year: number|null` (`null` = All Years) and `batch: string|null` (`null` = All Batches), initializes synchronously from `?y=&b=` on first render (avoiding a flash of the default), then resolves a sensible default (current year + current month's batch, else the latest available batch, else "All") in an effect — **but only when the URL didn't already specify** `y`/`b`. `setPeriod()` writes state and calls `window.history.replaceState` directly — not a Next.js router transition, so switching period is a synchronous client-side update with no server round trip; each of the three tabs independently watches `{year, batch, periodsLoading}` and re-fetches only when its own `fetchedPeriodRef` shows the period changed while it's the active tab (Daily filters by `production_batch` directly; Electricity/Trucks convert batch→calendar month via `batchToMonth()` since those tables store raw dates).

`period-picker.tsx`'s `PeriodPicker` renders two `<Select>`s ("All Years"/"All Batches" pinned first) that read/write that context.

**The contrast that matters for the universal-module plan:** Cenapro's picker is stateless URL params resolved server-side, spans three independent axes (view/scope/filter) including a genuine infinite-scroll "endless" mode with keyset pagination, and is re-instantiated per view-tree; ICTC's is a single persistent client Context with only a Year/Batch axis (no separate scope concept — "All"/"All" is the closest analogue to endless, but it's a plain unbounded fetch, not cursor-paginated), mounted once and shared unconditionally across three unrelated tabs via `history.replaceState`.

### (b) The ICTC inventory navigation (Renzo dislikes) — and a correction to the premise

`app/(app)/inventory/page.tsx` (server) reads `?year=&search=`. If `search` is present it ignores year entirely and does an `ilike` search across supplier/batch_code/truck_plate/block_loc over the whole table; otherwise, if `year !== 'all'`, it queries `transaction_date` between Jan 1 and Dec 31 of that **one year** — every server fetch loads a **whole year** at once (via `fetchAllRows`, which pages around PostgREST's 1000-row cap). There is no server-side month param at all.

`inventory-view.tsx` is a crossfade wrapper: it renders **both** the Deliveries container and the Usage container unconditionally on every load, toggling only `opacity-0 invisible pointer-events-none` vs `opacity-100` (150ms) based on `useInventoryTab()` — so RC OUT's lazy tab mounts (and fires its own client fetch) the first time you open Usage, then stays mounted with its state intact when you flip back to Deliveries.

The **Deliveries/Usage tab bar** (`InventorySheetTabs`, rendered at the bottom of `LogsShell`'s `<Card>`) is driven by `InventoryTabProvider`: `?tab=deliveries|usage` in the URL is the source of truth (`useSearchParams`+`router.replace`); `localStorage['inventory_active_tab']` is a **fallback only** — it seeds the URL once, post-hydration, when no `?tab=` is present, and an explicit `?tab=` always wins. `LogsShell` wraps *only* `/inventory` — the standalone `/inventory/blocking` and `/inventory/rc-movement` routes render outside it entirely (this was itself a deliberate fix for a past bug, BUG-003, where a tab shell leaked onto an unrelated route).

**The year/month footer strip is `components/DeliverySheetFooter.tsx`**, mounted only inside `delivery-master-table.tsx` (RC IN). It's two sliding-indicator button rows sharing the same visual language: "All Years" + a `<Select>` of years (current+1 down to 2010), and 13 month buttons ("All Months" + Jan–Dec). **Year** drives the server param `?year=` via `router.replace` in `handleYearChange` — a real round trip that reruns `page.tsx`'s Supabase query (with its own `isYearLoading` state carrying a 2-second minimum spinner). **Month** (`?m=`) is **purely client-side**: once that year's rows are in memory, a `filteredData` `useMemo` does `d.transaction_date.slice(5,7)` string-matching to slice down to the chosen month — no new fetch. So a Year change is slow-ish and a Month change is instant, and the two live in genuinely different code paths. The State-exclusion / Supplier / LOC filters, when engaged, temporarily force `year='all'` (via a `preFilterDate` ref) so they can search the whole history, then try to restore the prior year+month once every filter clears.

**Correction to the stated premise:** the code does **not** show RC OUT sharing `DeliverySheetFooter`. I confirmed this three ways — a direct grep of both files, a read of `rc-out-table.tsx` (which has its own multi-select **Year** and **Batch** checkbox popovers living in its column-header toolbar, filtering `allData` client-side against `selectedYears`/`selectedBatches` `Set`s, plus a shadcn `TableFooter` for on-screen sum totals — structurally unrelated to `DeliverySheetFooter`), and the module's own `app/(app)/inventory/CONTEXT.md`, which states outright: *"`components/DeliverySheetFooter.tsx` | Year + 12-month picker — used by RC IN (Deliveries tab)."* What RC OUT genuinely **does** share with RC IN is the **Deliveries/Usage tab bar** (`LogsShell`/`InventorySheetTabs`) and the app-wide `useTableSettings()` density/column-width state (see (d) — that sharing is arguably accidental, since the provider defaults to a hardcoded `tableId='rc_in'` app-wide). I'm flagging this precisely rather than silently going along with the premise, since the report needs to be accurate for migration planning — it's the tab bar + the (currently-shared-by-accident) settings slot that a universal module would need to generalize, not the footer.

### (c) Cenapro deliveries ledger structure

| file | lines |
|---|---|
| `app/(app)/cenapro/deliveries/deliveries-ledger.tsx` | 5494 |
| `app/(app)/cenapro/deliveries/types.ts` | 1951 |
| `app/(app)/cenapro/deliveries/use-deliveries-window.ts` | 306 |
| `app/(app)/cenapro/deliveries/ledger-url.ts` | 441 |
| `app/(app)/cenapro/deliveries/actions.ts` | 1100 |
| **total (these 5 files)** | **9292** |

Inside `deliveries-ledger.tsx` alone: **52** `useCallback`, **6** `useEffect`, **24** `useMemo`, **21** `useState`, **11** `useRef`. Counting distinct hook *APIs* invoked (not call sites): 6 React built-ins (`useCallback/useEffect/useMemo/useState/useRef/useTransition`) + 3 Next.js (`useRouter/usePathname/useSearchParams`) + 7 custom/shared (`useCellSelection`, `useCellAggregation`, `useDeliveriesWindow` [local], `useStatusBar` [platform provider], `useGridEditSession`, `useGridKeyboardNav`, `useGridContextMenu`) = **16 distinct hook APIs**. It deliberately does **not** use `useGridPaste`, `useClipboardCopy`, or `useCellDelete` — its own CONTEXT.md explains why: *"This used to go through the platform's `useGridPaste`, and it could not do the job"* and *"A grid that DOES have [a stored per-cell value to revert to] (Cenapro RC Deliveries) expresses the whole behaviour in its own `onGridKeyDown` wrapper and never touches this hook."*

Two more data points on how load-bearing this component is treated: a dedicated, framework-free **116-assertion** regression script (`scripts/verify-rc-deliveries-cells.ts`) asserts invariants about its cell geometry, TSV paste/copy round-trips, frozen-block scroll arithmetic, day-spacer rows, and the react-virtuoso raw-vs-public index-space clamp — run via `npx tsx scripts/verify-rc-deliveries-cells.ts`. And its own `app/(app)/cenapro/deliveries/CONTEXT.md` documentation file is **1599 lines** — nearly 30% the length of the component itself — walking through roughly 15 subsystems (cell geometry, the two meanings of Escape, caret-follow scrolling, drag-to-edge auto-scroll, the virtuoso index space, dirty-state semantics, draft rows, the floating selection pill, sample sub-rows needing their own `NavResolver`, day spacers, the clipboard TSV round trip, the paste sink internals, frozen panes, duplicate-pairing, and the audit trail).

### (d) `lib/hooks/` grid hooks and `components/shared/grid/*`

**`lib/hooks/` (8 files, 1389 lines):**

| file | lines | what it does |
|---|---|---|
| `use-cell-aggregation.ts` | 79 | Live sum/avg/count over the current range selection (the status-bar aggregate while dragging). |
| `use-cell-delete.ts` | 48 | Clears every cell in a range selection to `''` on Delete/Backspace — no per-cell undo snapshot by design. |
| `use-cell-selection.ts` | 396 | Rectangular multi-cell range selection (anchor/focus, drag-extend, Shift+Arrow) — the largest range hook. |
| `use-clipboard-copy.ts` | 67 | Ctrl/Cmd+C → serializes the active range as TSV to the clipboard. |
| `use-grid-context-menu.ts` | 80 | Right-click menu state: viewport edge-flip, capture-phase outside-click + Escape to close. |
| `use-grid-edit-session.ts` | 89 | Owns `isEditing` + the pre-edit snapshot + start/revert/commit for one cell being typed into. |
| `use-grid-keyboard-nav.ts` | 516 | **The linchpin** — the Esc/Enter/Tab/F2/Delete/printable-char state machine + the Tab-run "Enter-anchor" lane memory, delegating "next cell" to a pluggable `NavResolver` (coordinate `{row,col}` vs. DOM-order `navid` string) and rectangular range behaviour to an optional `range` slot. |
| `use-grid-paste.ts` | 114 | Excel/TSV smart-paste: parse clipboard TSV, auto-grow rows past the end, map columns via a caller `columnMap`, clean each value. **Only 2 real call sites app-wide** (RC IN & RC OUT bulk-input dialogs) — imported-but-never-called in Cenapro's `production-ledger-grid.tsx`, and explicitly rejected/removed from Cenapro's `deliveries-ledger.tsx` ("it could not do the job"). |

**`components/shared/grid/*` (7 code files + `CONTEXT.md`, 713 code lines):**

| file | lines | what it does |
|---|---|---|
| `DatePickerCell.tsx` | 106 | Native `<input type=date>` overlay cell; also exports the canonical `formatDateShort`. |
| `EditInput.tsx` | 101 | Bare inline text editor for every "type-over" edit; exports the canonical `EDIT_INPUT` class; `autoFocus` implemented via a ref callback (never React's native prop) so it can pass `{preventScroll:true}`. |
| `GridCell.tsx` | 154 | The coordinate `{row,col}` display/edit cell wrapper (ring/tint selection feedback) — used by every flat coordinate grid. |
| `GridContextMenu.tsx` | 109 | Declarative (non-Radix, to avoid focus-steal) right-click menu, driven by `useGridContextMenu` + a `GridMenuItem[]` array. |
| `RemarksCellAdaptor.tsx` | 103 | Pre-existing remarks-cell adaptor (predates the Phase-0 primitive set); only 2 real consumers (RC IN bulk-add, Electricity grid). |
| `SelectCell.tsx` | 112 | Categorical dropdown cell (DropdownMenu+RadioGroup), promoted verbatim from the Cenapro production ledger. |
| `index.ts` | 23 | Barrel export. |
| `CONTEXT.md` | ~204 | The design doc for exactly this consolidation effort — documents the "canonical interaction model" table and the two `NavResolver` flavors. |

**`components/shared/mobile/*` (1 code file + `CONTEXT.md`, 217 code lines):** `mobile-card-list.tsx` — `MobileCardList<T>`, the sole "Archetype C" primitive (virtualized via `@tanstack/react-virtual` + `measureElement`, tap→bottom-Sheet detail, optional "View full table" escape hatch). **8 real consumers**: rows 21, 25, 11, 35/38 (shared), 27, 29, and 47's own inline mobile layer. Two mobile surfaces deliberately opt out (per the CONTEXT.md's own note that "Frozen-pane matrices... are Archetype E, not C"): row 42 (`schedule-cards-mobile.tsx`, hand-rolled `<ul>`) and Trucks' inline phone-summary inside row 32.

**Adjacent platform infrastructure worth knowing about for the plan:** `components/providers/table-settings.tsx` (206 lines, `TableSettingsProvider`/`useTableSettings`) and `lib/actions/table-settings.ts` (71 lines, the `'use server'` `getTableSettings`/`saveTableSettings` pair against `user_table_settings`, keyed `(user_id, module)`). The DB schema is already generic (any `module` string), but **the provider is mounted exactly once app-wide, in `components/providers/index.tsx`, with `tableId` defaulted to `'rc_in'` and never overridden anywhere** — so RC OUT's and Blocking's `useTableSettings()` calls today read/write the *same* RC-IN-keyed settings row, not independent ones. `lib/actions/table-settings.ts` says so itself: *"The settings SHAPE is still typed as `RcInTableSettings` today because RC IN is the only table that persists settings... the storage layer is already generic."*

### (e) `border-collapse: separate` (both-axis frozen panes) vs. plain

Three tiers found, verified by inline `style={{borderCollapse:'separate', borderSpacing:0}}` plus the project's `.frozen-col`/`.frozen-row`/`.frozen-corner`/`.frozen-edge` utility classes:

**Tier 1 — full frozen panes (both rows and columns), `border-collapse: separate`, 15 files (17 `<table>` instances — deliveries-ledger.tsx and production-endless-pivots.tsx each render two):**
- `app/(app)/cenapro/deliveries/deliveries-ledger.tsx` (x2 tables)
- `app/(app)/cenapro/liquidation/banks/banks-view.tsx`
- `app/(app)/cenapro/liquidation/liquidation-view.tsx`
- `app/(app)/cenapro/liquidation/opening-balance-dialog.tsx`
- `app/(app)/cenapro/liquidation/payments-panel.tsx`
- `app/(app)/cenapro/liquidation/spread-panel.tsx`
- `app/(app)/cenapro/liquidation/subgroups/subgroups-view.tsx`
- `app/(app)/cenapro/production/production-daily-block.tsx`
- `app/(app)/cenapro/production/production-endless-pivots.tsx` (x2 tables)
- `app/(app)/cenapro/production/production-endless-sheet.tsx`
- `app/(app)/cenapro/production/production-ledger-grid.tsx`
- `app/(app)/inventory/flecon-bags/components/flecon-bags-view.tsx`
- `app/(app)/inventory/rc-movement/rc-movement-matrix.tsx`
- `app/(app)/production/daily/daily-ledger-grid.tsx`
- `app/(app)/production/trucks/trucks-grid.tsx`

Every one of these carries an explicit code comment repeating the same rule (e.g. flecon-bags-view.tsx: *"border-separate + border-spacing:0 is MANDATORY (not border-collapse): under the collapsed border model, sticky cell backgrounds render transparent and scrolling content bleeds through the frozen columns"*), so this is a well-understood, deliberate, repeated-by-hand pattern across at least 5 different files/authors — exactly the kind of duplication a universal module should absorb.

**Tier 2 — row-only freeze (plain `border-collapse`, `.frozen-row`/`.frozen-row-bottom` classes but no frozen left columns):** `app/(app)/cenapro/qc/qc-ledger-client.tsx` (sticky header row + a sticky month-total footer row via `.frozen-row-bottom`+`.frozen-edge-top`, "the flecon Current Balance pattern" reused for a row rather than a corner).

**Tier 3 — plain Tailwind `sticky top-0` header only (no project frozen-pane system at all):** `app/(app)/inventory/rc-in/delivery-master-table.tsx`, `app/(app)/inventory/rc-out/components/rc-out-table.tsx`, `app/(app)/production/electricity/electricity-grid.tsx` — these use shadcn's `<TableHeader className="sticky top-0">` directly, not the `.frozen-*` utility classes.

**Tier 4 — no freezing at all:** the remaining small read-only tables (all of `components/sync/cases/*`, `components/digest/schedule-conflict-dialog.tsx`/`schedule-table.tsx`/`bag-inventory.tsx`/`digest-footer-band.tsx`/`trucks-summary.tsx`, `blend-proposal-dialog.tsx`, `admin/UserManagementTable.tsx`, `shipments/[cardId]/page.tsx`, `setups-manager.tsx`, `price-demos/demo2/page.tsx`, `flec-inventory-client.tsx`).

---

**A closing note for the planning phase:** the single richest reference file for "what the universal primitive needs to support" is `app/(app)/cenapro/production/production-ledger-grid.tsx` (row 12) — it's the only file using *every* presentational primitive (`GridCell`, `SelectCell`, `DatePickerCell`, `GridContextMenu`) plus the full logic-hook suite, and is explicitly named as the canonical source for three of the six shared cell components in `components/shared/grid/CONTEXT.md`. The Cenapro RC Deliveries ledger you're modeling the new module on (row 1) is deliberately the **one grid that opted out** of three of the shared hooks (`useGridPaste`, `useClipboardCopy`, `useCellDelete`) because they couldn't do its job — worth resolving that tension explicitly before committing every other grid to the same primitives.
