# RC IN Module — Delivery Master Log

## Purpose
Captures incoming raw charcoal deliveries. Dense Excel-like grid with paste support, keyboard navigation, audit trails, and role-based cost visibility.

> **Domain Module (Charcoal Tenant):** This module is domain-specific — it belongs to the charcoal plant operations layer, not the platform layer. Business logic, schema references, and terminology here are intentionally charcoal-specific. When adapters are built for the dashboard widgets, they will extract data from these tables — but widgets themselves will never import from this module.

## Files
| File | Lines | Role |
|------|-------|------|
| _(no `page.tsx`)_ | — | RC IN is **not** its own route — it renders as the Deliveries tab of `/inventory`. Data is fetched server-side in `../page.tsx` (the parent inventory logs page) and passed to `DeliveryMasterTableWrapper` via `InventoryView`. |
| `actions.ts` | ~640 | Server actions: `submitBulkDeliveries`, `bulkUpdateDeliveries`, `bulkDeleteDeliveries`, `deleteDelivery`, `updateDelivery`, `getDeliveryHistory`, `getAuditComments`, `getAuditLogEntry`, `addAuditComment` + 4 resolve actions. All mutation paths: (1) normalize `block_loc` via `normalizeBlockLoc()` before DB insert, (2) validate block_loc format + occupied-location on all bulk writes via the **shared module-scope `validateBlockLocsForRows(rows)` helper** (DUP-4 — one copy, was duplicated in submit+bulkUpdate; returns ALL errors at once, occupied-check is deliberately NON-FATAL on query error), (3) translate DB constraint names to friendly errors via `translateDbError()`. **`bulkDeleteDeliveries` + `deleteDelivery` enforce a SERVER-SIDE permission gate** (getUserRole() + `PRIVILEGED_ROLES` = Owner/Admin/Dev, mirroring the client `hasPermission('delete:all')`) — deletes are re-checked server-side, not just UI-hidden. **Price-gate scrubbing** (getDeliveryHistory / getAuditLogEntry) uses canonical `!roleCanViewPrices(role)` from `@/lib/auth` (DUP-2 — no more inline `role === 'Production'`). **`bulkUpdateDeliveries` is TRANSACTIONAL (PERF-3):** it no longer loops per-row (the old set_audit_comment → update → audit_logs lookup → audit_comments insert × N, which left earlier rows committed on a mid-loop failure). It still validates block-loc + upserts batches + builds each row's payload via `toDeliveryPayload`, then calls **one RPC `fn_bulk_update_deliveries(rows jsonb)`** (`{id, data, comment}[]`) that applies every partial update in a SINGLE transaction (all-or-nothing). The `deliveries` AFTER trigger `log_delivery_changes` still fires per row so the `audit_logs` trail is byte-for-byte identical; the RPC reproduces the "attach edit remark to the record's latest audit_log" glue. **Table-settings actions (`getTableSettings`/`saveTableSettings`) MOVED OUT** to the neutral `@/lib/actions/table-settings` (PURITY-1) — a `'use server'` file can't re-export them, so importers pull them from there directly. |
| `bulk-delivery-input.tsx` | ~1250 | Client grid editor — paste, keyboard nav, autocomplete, edit tracking, cell range selection + copy + delete. **Canonical Blackwood Table reference grid** (Phase 1 of the grid consolidation): the hand-rolled keyboard state machine (`handleGridKeyDown` + `moveSelection`), edit-trigger/revert logic, and smart-paste were replaced by the shared primitives — see "Blackwood Table primitives" below. |
| `components/delivery-master-table-wrapper.tsx` | ~31 | Client wrapper — `dynamic()` with `ssr: false` to avoid Radix hydration mismatch |
| `components/delivery-cards-mobile.tsx` | ~450 | **Phone read layer (Archetype C).** Rendered `sm:hidden` by `delivery-master-table.tsx`; the desktop `<table>` is `hidden sm:*` and byte-for-byte unchanged. Built on the platform primitive `@/components/shared/mobile/mobile-card-list` (`MobileCardList`). Fed the SAME `filteredData` + filter state + `canViewPrices` the desktop table uses (single source of truth — no refetch). Card headline (≤6, **NO ₱**): `date · supplier · batch · weight(kg) · block_loc · state`. Tap → full-width bottom `Sheet` detail with every field: 7-metric lab panel (MC/Grit/VM/Ash/FC 2dp, BD ASTM/JIS 3dp), ₱/kg + ₱ total (BOTH behind `canViewPrices`), truck, sacks, remarks, `TrueWeightPopover` deduction marker, and a "View history" button that opens the parent's `DeliveryHistoryDialog`. A mobile **Filters `Sheet`** (STATE/Supplier/LOC) reuses the exported `LocFilterContent` + the existing filter handlers/URL params (`sx`/`sup`/`loc`). "View full table" escape hatch mounts a read-only wide `<table>` in its own `overflow-auto` box. |
| `delivery-master-table.tsx` | ~2100 | Client data table — virtual scroll, column header filters (state/supplier/loc), 2 density modes (normal/expanded), heat-tinted lab cells, right-click context menu, column resize, settings dialog, year/month controls, cell selection + clipboard copy |
| `components/settings-dialog.tsx` | — | Settings dialog with density toggle, font size slider, lab range threshold editors with color previews |
| `components/columns-popover.tsx` | — | Column visibility popover with role-aware cost column gating |
| `components/density-toggle.tsx` | — | Normal/Expanded segmented control |
| `paste-utils.ts` | 47 | Column mapping and cell value cleaning (imports `parseExcelDate` from `@/lib/paste-utils`) |
| `delivery-grid-v2.tsx` | ~800 | RC IN on the **Blackwood Table** (`?grid=v2`) — the second, EDITABLE rendering built beside the live table. See the dedicated section at the bottom of this file. |
| `rc-in-grid-v2-save.ts` | ~450 | **PURE** edit + save model for `delivery-grid-v2.tsx` — the field vocabulary, canonical cell text, the per-field verdict, the whole-row payload builders and the lab-panel assembly. No React, no Supabase, no server actions. Asserted by `scripts/verify-rc-in-grid.ts` (33 assertions). |
| `components/delivery-search.tsx` | ~190 | **NEW (2026-09-02).** The v2 grid's `?search=` box — the live table's control, rebuilt as its SIBLING rather than extracted from it. Exports `DeliverySearch`, `DELIVERY_SEARCH_DEBOUNCE_MS` (300) and `DELIVERY_SEARCH_PLACEHOLDER`. Mounted only by `delivery-grid-v2.tsx`; `delivery-master-table.tsx` is untouched. See the search section at the bottom of this file. |
| `components/DeliveryHistoryDialog.tsx` | 561 | Delivery history + audit trail dialog |
| `components/audit-shared.tsx` | 87 | Shared audit display utilities |
| ~~`edit/[auditLogId]/`~~ | — | **Moved** to `app/(app)/edit/[auditLogId]/` (standalone route outside inventory layout) |
| ~~`error.tsx` / `loading.tsx`~~ | — | **Deleted** (CLEAN-1). Orphaned — Next.js only wires `error`/`loading` files to a route segment, and RC IN has no `page.tsx`. |

## Data
- **Tables:** `deliveries`, `batches` (upserted), `audit_logs`, `audit_comments`, `profiles`, `user_table_settings` (per-user per-module JSONB settings, RLS-protected, `user_id` + `module` unique constraint)
- **Views:** `view_rc_in_master`
- **RPC:** `set_audit_comment(comment text)` — sets comment context before update trigger fires
- **Types:** `DeliveryRow`, `InputDeliveryRow`, `AuditLogRow`, `AuditComment` (in `types/rc-in.ts`)

### `deliveries` weight-deduction / true-weight columns (added 2026-06-25)
Two **purely additive, display-only** annotation columns on `deliveries` (migration `20260625000000_add_deliveries_true_weight_deduction_note.sql`; locked design in `DEDUCTIONS_DESIGN.md`). The sync populates them; the UI reads them as a popover/hover.

| Column | Type | Nullability | Meaning |
|---|---|---|---|
| `true_weight_kg` | `numeric` | NULL | Physical/gross weight BEFORE both ASH and wet deductions. `NULL` = ordinary load with no deduction. |
| `deduction_note` | `text` | NULL | Short human note explaining the deduction, e.g. `−5.86% ASH; −1,009 wet`. `NULL` = no deduction. |

Key semantics:
- **Display-only / informational.** `weight_kg` stays the Sheet-DEDUCTED weight (the only value the sync compares — zero new conflicts) and `cost_basis` stays the FULL price. The two new columns are extra tags, never overwriting either.
- **"Tagged" = `true_weight_kg IS NOT NULL`.** A row "has a deduction" when this column is non-null; that's the derived tag the UI marker keys on.
- **NO balance/view/trigger uses them.** Every balance everywhere (grid, closing, blend proposal, batch totals) stays on `weight_kg`. No trigger reads/writes them, no view aggregates them, no computation parses `deduction_note`. So Blackwood still matches the Sheet on every column and every balance.
- **Effective ₱/kg (cost ÷ true weight) is DISPLAYED, never stored** — and stays price-gated like every ₱ value.
- **Shared UI: `../_shared/true-weight-popover.tsx`** (`TrueWeightPopover`) — the one display-only component that surfaces these columns cross-surface. It renders ONLY on **tagged** rows (`true_weight_kg != null`); each caller mounts its own quiet `Σ` (lucide `Sigma`) marker button as the trigger. Surfaces: (1) the **master table** Weight cell (marker left of the right-aligned number, both density modes), (2) the **Blocking detail panel** delivery-history rows (`_shared/blocking-detail-panel.tsx`). The **DeliveryHistoryDialog** shows the same four facts INLINE as field-cards (no popover) instead. In all three, the **effective ₱/kg** line is `canViewPrices`-gated (computed `cost_basis / true_weight_kg`, accounting ₱ format) while the **true-weight + recorded + deduction-note** lines are NOT gated. Purely informational — touches no balance/total/aggregate; untagged rows render byte-for-byte as before (no marker, no extra DOM).

## Key Behaviors
- **Batch upsert-first:** Dedup by `batch_code` via JS Map, upsert batches before inserting deliveries
- **Cost scrubbing:** Production role users have `cost_basis` stripped from history snapshots/diffs in `getDeliveryHistory()` and `getAuditLogEntry()`
- **Year-based pagination:** URL param `?year=2024`; month filtering done client-side via string slicing on `YYYY-MM-DD` (avoids timezone issues). **Defaults to current year and current month on initial load** (no year param = current year via `new Date().getFullYear()`; month state initializes to `new Date().getMonth()`). When a header bar filter (STATE, WHSE, Supplier, LOC) is activated, the year auto-switches to "All Years" via `activateAllYearsIfNeeded()` to ensure the filter operates on the full dataset.
- **Toolbar layout:** `[Search] [Clear filters (when active)] [--- spacer ---] [Density toggle] [Columns] [Settings] [Select mode] [Add] [Refresh]`
- **Column header filters:** STATE, Supplier, and LOC filters are all integrated into their respective column headers (not the toolbar). Each uses a `Popover` triggered by clicking the column header label. Active filters show a `Filter` icon and count badge. **Two filter models are used:** STATE uses an **exclusion set pattern** (all included by default; unchecking excludes); Supplier and LOC use an **inclusion set pattern** (empty = show all; checking includes only selected values). STATE popover has Select All / Deselect All buttons + state dots. Supplier popover has `Command` (searchable) + checkboxes with a "Clear" link. LOC popover shows 4 collapsible WHSE sections (A/B/C/D) with warehouse-level and individual location checkboxes. Values come from server-fetched `allSuppliers`/`allLocations` props (all distinct values from entire DB, not scoped by year).
- **WHSE column:** REMOVED entirely. WHSE filtering is done via the LOC column header filter. WHSE info is shown as annotation in expanded mode under the LOC value ("WHSE A").
- **STATE filter default:** On fresh page load (no `sx` URL param), the STATE filter defaults to excluding CLOSED so users see only active inventory (STORED, IN-USE, SUNDRYING, SUNDRIED). Users can manually re-enable CLOSED via the STATE filter popover. Uses a URL sentinel value `sx=_all` to distinguish "user explicitly cleared the filter" from "fresh load (apply default)". This prevents the default from being re-applied after Suspense remounts when the user has intentionally shown all states.
- **Data fetching moved to parent:** RC IN data is fetched server-side in `../page.tsx` and passed to `DeliveryMasterTableWrapper` via `InventoryView`. There is **no `rc-in/page.tsx`** — RC IN is only ever mounted as the Deliveries tab of `/inventory`.
- **Mobile read layer (additive, `sm:hidden`):** The desktop toolbar, selection bar, and scrollable `<table>` are all `hidden sm:*`; below `sm` the table renders `DeliveryCardsMobile` (see Files) instead. Strictly ADDITIVE — desktop editing/bulk-input/cell-select/context-menu paths are unchanged. Two small refactors support it: `LocFilterContent` is now **exported** (reused by the mobile Filters drawer) and the desktop LOC popover's inline handler was extracted to a shared `setLocFilter` callback (applies a full LOC inclusion set atomically — same URL-sync + auto-All-Years behaviour — used by both the desktop popover and the mobile drawer). Prices stay gated by the same `canViewPrices` prop; ₱ never appears in a card headline. See `@/components/shared/mobile/CONTEXT.md` for the primitive.
- **Search always uses all fields:** The search field dropdown was removed. Server-side search in `../page.tsx` always queries across supplier, batch_code, truck_plate, and block_loc.
- **Cost column visibility:** Both header and body cells in `BulkInputRow` are gated behind `canViewPrices` prop (`hasPermission('view:prices')`), ensuring column count matches for all roles in the edit dialog
- **Data refresh mechanism:** After every add/edit/delete operation, the table calls `router.refresh()` to trigger a server-side re-render and re-fetch fresh data from the parent `page.tsx`. A manual refresh button (`RefreshCw` icon) in the toolbar provides a fallback. The `refreshing` state drives a spinner on the button (1-second timeout since `router.refresh()` is fire-and-forget). Server actions still call `revalidatePath` as before; the explicit `router.refresh()` ensures the UI picks up changes immediately after mutations.
- **Paste-grid:** Tab-separated clipboard → Excel serial date parsing, currency stripping, auto-row expansion
- **Row density:** 2 modes (normal `h-8`, expanded `h-12`) controlled by `DensityToggle` segmented control in the toolbar. Compact mode removed. Settings persist to DB via `user_table_settings`.
- **Lab cell highlights:** Lab value cells (MC, Grit, VM, Ash, FC, BD ASTM, BD JIS) show colored backgrounds when values exceed a single threshold limit. Uses simplified `getLabHighlightBg()` from `@/types/table-settings`. Each metric has a fixed direction based on charcoal quality science (MC/Grit/VM/Ash = "above" is bad; BD ASTM/BD JIS/FC = "below" is bad). Users can configure the limit value, choose from 8 highlight colors (red, amber, orange, yellow, blue, purple, pink, emerald), and enable/disable per metric. Replaces the old dual-range (good/warning/alert) system.
- **Expanded mode annotations:** In expanded density, sub-line annotations show day name, delivery count per batch, and cost delta vs weighted average.
- **Cell borders:** Near-invisible `border-r border-border/10` between cells.
- **BD headers:** Two-line word wrap (`BD\nASTM`, `BD\nJIS`) in column headers.
- **Remarks column:** Visible truncated text + hover tooltip. Now positioned before cost columns in display order.
- **Row actions:** Right-click context menu (vertical list style) with: View Details, Edit Delivery, Select Row, Copy Row, Filter by Supplier, Filter by Batch, separator, Delete Delivery (permission-gated via `hasPermission('delete:all')`). Context menu works in all modes including selection mode. **Multi-select context menu:** When right-clicking a selected row while multiple rows are selected, shows: Edit Selected (N), Copy Selected (N), Select All, Deselect All, separator, Delete Selected (N) (permission-gated). Right-clicking a non-selected row in selection mode auto-adds it to the selection first. **(Phase 4 consolidation)** Both menus now run on the shared `useGridContextMenu` hook + declarative `GridContextMenu` component (two hook instances: row menu keyed on the delivery `id`, column menu keyed on the column id; see `components/shared/grid/CONTEXT.md`). The row menu's `items` are computed from selection (`MULTI_ROW_ITEMS` when 2+ selected and the clicked row is in the selection, else `SINGLE_ROW_ITEMS`), bulk actions read `selectedIds` from closure. Permission-gated Delete uses `hidden: () => !hasPermission('delete:all')`.
- **Column context menu:** Right-click on any column header shows a context menu with: Sort Ascending, Sort Descending, separator, Bold/Italic/Underline toggles (with checkmarks), separator, Hide Column, Reset Column Width. Formatting is persisted in `settings.columnFormats`. The toggles use `keepOpen` (the menu stays open so several can be flipped without re-opening) + `trailingIcon` (a right-aligned `Check` when active) — two fields added to `GridMenuItem` in Phase 4 specifically to reproduce this menu 1:1.
- **Column header borders:** Visible `border-r border-border/40` between column headers for clearer separation and resize handle discoverability. Last column omits the right border.
- **Column formatting:** Columns can be set to bold, italic, or underline via the column context menu. Applied as CSS classes to all body cells in that column. Persisted in `RcInTableSettings.columnFormats`.
- **Column resize:** TanStack `columnSizing` with drag handles on column headers. Widths persist to settings provider and DB.
- **Settings dialog:** Full dialog (`components/settings-dialog.tsx`) with density toggle, font size slider (9-14px), simplified lab highlight editors (one row per metric: checkbox + metric name + direction text + limit input + color picker from 8 colors).
- **Column visibility:** Managed by settings provider (`hiddenColumns` array in `RcInTableSettings`), persisted to DB. `ColumnsPopover` component with role-aware cost column gating (PHP/KG and PHP TTL only shown if `hasPermission('view:prices')`).
- **editBatch deep-link:** When URL contains `?editBatch=<batch_code>`, the table auto-selects all matching deliveries and opens the bulk edit dialog. Used by the Blocking detail panel's "Edit All" button. The param is cleaned from the URL after triggering.
- **Virtual scroll:** `@tanstack/react-virtual` with `overscan: 15`, respects user's density setting
- **Audit resolve workflow:** Employees request resolve/reopen; Admins directly toggle or approve/deny requests; system messages auto-posted to `audit_comments`
- **Keyboard nav:** Arrow keys, Tab, Enter, F2 (edit), Escape (revert), printable chars (type-over)
- **Cell selection + clipboard copy (master table):** `useCellSelection` and `useClipboardCopy` hooks enable rectangular cell selection (left-click-drag, Shift+click, Shift+Arrow, Ctrl+A) and Ctrl+C copy as TSV. Right-click does NOT trigger cell selection (button 0 check in `handleCellMouseDown`). Mutually exclusive with row selection mode (`enabled: !selectionMode`). Selection count and `useCellAggregation` aggregates are pushed to `StatusBarProvider` context via `useStatusBar()` and displayed in the unified `FloatingStatusBar` with a Google Sheets-like auto-calculate dropdown (SUM/AVERAGE/COUNT/MIN/MAX). Numeric columns for aggregation: weight_kg, sacks, mc, grit, bd_astm, bd_jis, vm, ash, fc, cost_basis, php_ttl. Clears on filteredData/sorting changes, clicking outside the scroll container, or pressing Escape.
- **Cell selection + copy + delete (bulk input):** All 3 hooks (`useCellSelection`, `useClipboardCopy`, `useCellDelete`) plus `useCellAggregation` with two-mode system: single-cell edit (click without drag) vs range selection (click+drag, Shift+Arrow). Range mode: Ctrl+C copies as TSV, Backspace/Delete clears all cells. Non-shift nav exits range. Printable char exits range and edits anchor cell. Selection count and aggregates pushed to `StatusBarProvider` context (same as master table). Numeric columns for aggregation: weight_kg, sacks, mc, grit, bd_astm, bd_jis, vm, ash, fc, cost_basis.
- **Blackwood Table primitives (bulk input grid):** As of the grid consolidation Phase 1, `bulk-delivery-input.tsx` consumes the shared, source-agnostic grid primitives instead of hand-rolled per-grid logic — it is the **canonical reference diff** all other flat grids copy. Wiring:
  - **`useGridKeyboardNav<CoordinateId>`** (`@/lib/hooks/use-grid-keyboard-nav`) — the cell-id-agnostic keyboard state machine (Esc/Enter/Tab/F2/Delete/printable-char interpretation), replacing the old local `handleGridKeyDown`. Target resolution is delegated to **`createCoordinateNavResolver({ rowCount, columnMap: COLUMN_MAP })`** (replaces the old `moveSelection` math: skip null columns, Tab row-wrap + boundary clamp, Enter-down / Shift+Enter-up). `enableEnterAnchor: false` — RC IN's plain Enter always drops straight down (no Tab-run "return to lane" behavior). The existing `useCellSelection`/`useClipboardCopy`/`useCellDelete` instances are wired into the hook's opt-in **`range` slot** (`GridRangeSlot`: `extend`/`clear`/`seedFromActive`/`anchorId`/`onCopy`/`onDelete`). `useCellAggregation` (status bar) is unchanged.
  - **`useGridEditSession<CoordinateId>`** (`@/lib/hooks/use-grid-edit-session`) — owns `isEditing` + the pre-edit snapshot + `startEditing`/`revertChanges`/`commit`, replacing the old local `isEditing` state + `preEditValue` ref + `startEditing`/`revertChanges`. Wired to the grid via `getValue: getCellValue` and `setValue` (→ `updateRow` through `COLUMN_MAP`). Commit does **not** auto-focus; focus is restored explicitly only where the old code did (Tab/Enter commit, Escape revert, single-cell click) so `onBlur` never re-focuses. `GridCell` still calls `onStartEditing(row, col, char?)`/`onRevert()` via thin `{row,col}`-id adapters; a stable `endEditRef` lets the click/blur handlers end an active edit without a forward reference to the later-created session.
  - **`useGridPaste<InputDeliveryRow>`** (`@/lib/hooks/use-grid-paste`) — the Excel/TSV smart-paste (parse TSV, auto-create rows past the end, map via `COLUMN_MAP`, clean via `cleanCellValue`), replacing the old local `handleSmartPaste`/`handleGridPaste`. The container `onPaste` clears the selection after pasting; the "Pasted N rows" success toast is preserved.
  - Behavior is intentionally **byte-for-byte identical** to the pre-migration grid (click=select-no-edit, type=type-over, dblclick/F2=edit-preserve, Esc=revert, Enter/Tab=commit+move skipping non-editable + row-wrap, Shift+Arrow range, Ctrl+C copy, Delete clears). No animation added to cells/selection (CLAUDE.md motion rule). See `components/shared/grid/CONTEXT.md` for the full three-layer package model.
- **Focus never scrolls (2026-08-04).** `HTMLElement.focus()` scrolls its target into
  view with block AND inline `"center"` through every scrolling ancestor, and `"center"`
  always computes a target — so it fires even when nothing moved, re-centring the row and
  dragging the page. Every `gridRef.current?.focus()` in `bulk-delivery-input.tsx` (the
  single-cell click, the Escape revert, the Tab/Enter commit) and the `focusCell` helper
  now pass **`{ preventScroll: true }`**; the master table already did. Focus still moves;
  only the scroll is refused. See "Focus must never scroll" in
  `components/shared/grid/CONTEXT.md`.
  - **CLOSED 2026-08-05.** The 15 sites in this file are done: 13 shadcn `<Input>` cell
    editors now take **`ref={focusNoScroll}`** (`lib/utils.ts`) instead of `autoFocus`, and
    the 2 `<AutocompletePopover autoFocus>` cells (SUPPLIER, BLOCK) keep the prop — the
    component itself now honours it with a ref callback rather than passing React's
    `autoFocus` down to its `<Input>` (see `components/shared/AutocompletePopover.tsx`).
    **React's `autoFocus` prop is unfixable from the outside** — react-dom's `commitMount`
    is a bare `domElement.focus()` with no options — so a cell editor must simply not use
    it. The ref callback lands in the same commit/layout phase `commitMount` would have
    and, like react-dom, calls no `select()`/`setSelectionRange()`, so caret and selection
    behaviour are byte-identical; only the scroll is refused. ONE idiom, matching
    `components/shared/grid/EditInput.tsx`.
  - **This table's row borders are fine** — `bulk-delivery-input.tsx` uses plain
    `border-collapse` on the `<table>`, so a `<tr>`-level `border-b` renders. The Cenapro
    ledgers and the Production Daily/Trucks grids are `border-collapse: separate`, where
    the CSS spec paints borders on table CELLS ONLY and a row-level border is ignored
    outright. If this grid ever gains sticky frozen columns (which force `separate`), every
    row-level border in it goes inert in the same instant — move them to the cells with a
    `[&>*]:border-b [&>*]:border-b-<side-specific-colour>` child variant, never back onto
    the `<tr>`.
- **Escape-after-Delete audit (2026-08-04) — no gap here, nothing changed.**
  A **single-cell** Delete/Backspace goes through `useGridKeyboardNav`'s
  `edit.start(active, '')`, which snapshots the pre-edit value before blanking, so Escape
  reverts it. A **range** Delete runs `useCellDelete` (no snapshot) and the shared hook
  then drops the selection — not undoable. That is left as-is on purpose: this is a
  **staging grid**, so in `mode='create'` there is no stored value to revert to at all,
  and in `mode='edit'` the only baseline is the `initialData` the dialog was opened with
  (the form's own Cancel/Discard, not a cell-level undo). Forcing a "revert to stored"
  semantic onto a create-mode row would be incoherent. The **master table has no cell
  delete at all** — its cell selection is read-only (copy + aggregate), and Escape simply
  clears the selection.
- **Glass & Motion:** Table header/footer use frosted glass (`bg-muted/90 backdrop-blur-sm`). Row hover uses `transition-all duration-150`. Empty state uses `animate-fade-up`. Loading overlay uses `animate-blur-in`. Selection bar uses `animate-fade-up`. Bulk input headers use `bg-muted/90 backdrop-blur-sm`. DeliveryHistoryDialog uses `stagger-fast` on field cards, `stagger-children` on activity feed. Virtual scroll rows use `animate-row-fade` (100ms opacity-only) for subtle recycle animation.
- **Conditional TOTALS footer:** The TOTALS `<TableFooter>` row is conditionally rendered only when `hasActiveFilters` is true (any STATE, WHSE, Supplier, or LOC filter is active). Uses `animate-slide-up` (250ms translateY + opacity) for entrance. The `DeliverySheetFooter` (year/month nav bar) is always visible — only the TOTALS row is conditional.
- **Tab crossfade:** Switching between the Deliveries/Usage tabs uses CSS `transition-opacity duration-150` on the visible tab container (Blocking + Movement are standalone routes now, not tabs). Managed by `displayTab` + `transitioning` state in `inventory-view.tsx` — a single `setTimeout(150)` fades out, swaps content, then fades in. No CSS keyframes involved.
- **Tab persistence:** Active tab persisted to `localStorage` key `inventory_active_tab`. On mount, reads stored value; defaults to `'deliveries'` if not found. `InventoryTabProvider` in `../components/inventory-tab-context.tsx` manages this.
- **Sheet tab bar:** Uses glass effect (`bg-muted/50 backdrop-blur-sm`) with a sliding indicator behind the active tab (same `bg-zinc-800 dark:bg-zinc-200 transition-all duration-300` pattern as DeliverySheetFooter year/month indicators). Active tab text inverts to `text-background`.

### Column Order
state, transaction_date, supplier, batch_code, block_loc, truck_plate, weight_kg, sacks, mc, grit, bd_astm, bd_jis, vm, ash, fc, remarks, cost_basis, php_total

### Filter Interaction Model
- **Server-side:** `year` (URL param) + `search` (URL param, always "all fields")
- **Client-side:** Column header filters (STATE, Supplier, LOC) + FooterBar month filter
- **Execution order in `filteredData` useMemo:**
  1. Apply HeaderBar filters — ALWAYS (even with active search)
  2. If search active: skip month filter, return
  3. If no search: apply FooterBar month filter, return
- Active column header filters show a `Filter` icon (with primary color) and count badge in the column header
- A global "Clear filters" button appears in the toolbar when any header filter is active
- **Filter models:**
  - **STATE (exclusion):** Filter state is `Set<string>` of excluded values. Empty set = all included. Toggling a checkbox adds/removes from the exclusion set. Button label shows remaining count (e.g., `State (3)` means 3 of 5 states included). Status bar shows `STATE (-2)` meaning 2 excluded. **"Deselect All" is UI-only** (sets all values to excluded in state but does NOT sync to URL or trigger year switch). When all values are excluded (`size >= total`), `filteredData` treats it as "no filter" (shows all). This prevents "Deselect All" from hiding everything. Exception: STATE filter initializes with `['CLOSED']` excluded by default on fresh load (see "STATE filter default" above).
  - **Supplier/LOC (inclusion):** Filter state is `Set<string>` of included values. Empty set = show all (no filter active). Non-empty set = show ONLY those values. Button label shows selected count (e.g., `Supplier (2)` means 2 selected). Popover shows a "Clear" link only when selections exist (no Select All / Deselect All). Values come from `allSuppliers`/`allLocations` props fetched from the entire DB in `page.tsx`.
- **Auto All Years + Pre-filter Date Restore:** When any filter becomes active (exclusion set non-empty for STATE, or inclusion set non-empty for Supplier/LOC) and year is not already `all`, the year automatically switches to `all` (via `handleYearChange`) to ensure the filter operates on the full dataset. The user's previous year+month is saved in `preFilterDate` ref. When all filters are cleared (individually or via Clear All), the saved year+month is restored automatically via `maybeRestoreDate()`. For STATE, full exclusion (`size >= total`) is treated as inactive for restore purposes.
- **Filter state URL persistence:** Filter state and month selection are silently synced to URL params via `window.history.replaceState` (no Next.js navigation or server round-trip). **URL params:** `sx` (STATE exclusion), `sup` (Supplier inclusion), `loc` (LOC inclusion), `m` (month). Comma-separated values (e.g., `?sx=CLOSED,SUNDRYING`, `?sup=SUPPLIER_A,SUPPLIER_B`). Special sentinel `sx=_all` means "user explicitly cleared the STATE filter" (prevents default re-application). Absent `sx` param = fresh load (default exclusion of CLOSED). **Deprecated:** `wx` (WHSE exclusion) is cleaned up on mount. Legacy params `supx`/`lx` are also cleaned up when encountered. This ensures filter state survives Suspense remounts triggered by `loading.tsx` when `router.replace` changes the `year` param. On remount, all filter `useState` initializers read from `searchParams`. The `handleYearChange` function reads from `window.location.search` (not React's `searchParams`) to include the silently-synced params in the real navigation URL.

### Column Visibility (Columns Popover)
- Toolbar **Columns** button opens `ColumnsPopover` (`components/columns-popover.tsx`) listing all hideable columns
- Uses `hiddenColumns` array in `RcInTableSettings`, persisted via settings provider (localStorage + DB)
- Checked = visible, unchecked = hidden. "Show All" button resets when any columns are hidden.
- Role-aware: PHP/KG and PHP TTL only appear in the list if `hasPermission('view:prices')`
- Actions column is never hideable
- Footer dynamically adjusts: `colSpan` for TOTALS label is computed from visible prefix columns (`visiblePrefixCount`), and each footer cell conditionally renders based on `hiddenColumns`

### Footer Compact Number Formatting
- `formatCompact()` utility formats large numbers with suffix: `k` (thousands), `m` (millions), `b` (billions), `t` (trillions)
- Applied to WT total, lab weighted averages, PHP/KG weighted average, and PHP TTL total in the footer row

### STATE Column (Derived)
- STATE is `batches.status`, managed by the `fn_process_blackwood_usage` trigger on `rc_out`
- Values: STORED (default), IN-USE, CLOSED, SUNDRYING, SUNDRIED
- **State display:** Colored dot + text only (no badges, no ring, no row tinting). Dot class from `getStateDotClass()` in `@/types/table-settings`
- Trigger handles INSERT/UPDATE/DELETE on rc_out to keep status accurate
- RC IN batch upsert does NOT set status (let DB default + trigger manage it)
- Note: FEED location is indicated by WHSE column (derived from block_loc starting with 'F'), not status

## Dependencies
- `@/lib/rc-utils.ts` — `calculateWhse()` derives warehouse from block_loc first letter
- `@/lib/field-labels.ts` — `getFieldLabel()`, `formatFieldValue()`, `flattenLabResultsDiff()`
- `@/lib/auth.ts` — `getUserRole()` (includes dev override check) + `roleCanViewPrices(role)` (canonical price gate; replaces inline `role === 'Production'` compares — DUP-2)
- `@/lib/validation.ts` — `validateBlockLoc()`, `normalizeBlockLoc()` (used by `validateBlockLocsForRows` + `updateDelivery`)
- `@/lib/supabase/paginate.ts` — `fetchAllRows()` shared PostgREST pagination helper (DUP-1); `../page.tsx`'s deliveries fetch uses it
- `@/lib/actions/table-settings.ts` — neutral `getTableSettings`/`saveTableSettings` (PURITY-1; formerly defined in this module)
- `@/components/providers/auth-context` — `useAuth()`, `hasPermission('view:prices')`
- `@/types/table-settings` — shared types (`DensityMode`, `LabMetric`, `LabHighlightSpec`, `ColumnFormat`, `RcInTableSettings`), default constants (`DEFAULT_LAB_HIGHLIGHTS`, `HIGHLIGHT_COLORS`), utilities (`getLabHighlightBg`, `getStateDotClass`)
- `@/components/providers/table-settings` — `useTableSettings()` provides full `RcInTableSettings` (density, fontSize, hiddenColumns, labHighlights, columnWidths, columnFormats). Methods: `setLabHighlights`, `setLabHighlightField`, `setColumnFormat`. Dual persistence: localStorage (instant) + DB via `user_table_settings` table (debounced 500ms). Backward compat: old `labRanges`/`disabledHighlights` in localStorage are silently migrated to defaults.
- `@/components/providers/status-bar-context` — `useStatusBar()` for pushing cell selection count and aggregates to FloatingStatusBar
- `@/lib/hooks/use-cell-selection` — rectangular cell selection with drag, keyboard, and auto-scroll
- `@/lib/hooks/use-clipboard-copy` — Ctrl+C copies selected cells as TSV
- `@/lib/hooks/use-cell-delete` — Backspace/Delete clears multi-cell selection (bulk input only)
- `@/lib/hooks/use-cell-aggregation` — computes SUM/AVERAGE/COUNT/MIN/MAX over selected numeric cells for status bar display
- `@/lib/hooks/use-grid-keyboard-nav` — shared keyboard state machine + `createCoordinateNavResolver` (bulk input grid; the linchpin Blackwood Table primitive)
- `@/lib/hooks/use-grid-edit-session` — shared inline-edit flag + pre-edit snapshot (bulk input grid)
- `@/lib/hooks/use-grid-paste` — shared Excel/TSV smart-paste (bulk input grid)
- `@/app/(app)/inventory/_shared/true-weight-popover` — `TrueWeightPopover`, the display-only weight-deduction / true-weight popover shown on the master table Weight cell (also reused by the Blocking detail panel + the mobile detail sheet). See the weight-deduction columns block above.
- `@/components/shared/mobile/mobile-card-list` — `MobileCardList`, the platform-layer Archetype C primitive (virtualized card list + tap→bottom-sheet detail + "View full table" escape hatch). `delivery-cards-mobile.tsx` is one of its two reference sites.
- `@tanstack/react-table`, `@tanstack/react-virtual`, `date-fns`, `sonner`

## `delivery-grid-v2.tsx` + `rc-in-grid-v2-save.ts` — RC IN on the Blackwood Table (`?grid=v2`, EDITABLE since 2026-08-21)

A SECOND rendering of the same `DeliveryHistoryRow[]` `page.tsx` already fetches, on the universal table module (`@/components/shared/table` + `@/lib/table`), reachable only at `/inventory?grid=v2`. `delivery-master-table.tsx`, `bulk-delivery-input.tsx` and `actions.ts` are production and are **not edited by one character**; see `../CONTEXT.md` → "The `?grid=v2` side-by-side" for the toggle wiring.

| File | Role |
|---|---|
| `delivery-grid-v2.tsx` | The React adapter — columns, row families, the flatten, the toolbar strip, the Save button, the edit-reason dialog, and the two server-action calls. |
| `rc-in-grid-v2-save.ts` | **PURE** (no React, no Supabase, no actions) — the field vocabulary, `storedFieldText` / `savedFieldText`, `normalizeRcInField` / `parseRcInField` / `cleanPastedRcInCell`, `buildDeliveryUpdate` / `buildDeliveryInsert`, the lab-panel assembly, the draft-id pool, and the refusal wording. Asserted by `scripts/verify-rc-in-grid.ts` (**33 assertions**), no DB and no browser. |

### Editing (2026-08-21) — the first EDITABLE ICTC table on the universal module

**Sixteen editable lanes, exactly the ones the bulk-input dialog lets an operator set** — Date, Supplier, Batch Code, Block/Loc, Truck Plate, Sacks (integer), Weight (0dp), MC/Grit/VM/Ash/FC (2dp), BD ASTM/BD JIS (3dp), PHP/KG (price-gated), Remarks. `RC_IN_EDIT_FIELDS` is the ONE list and `isRcInEditField` is what `RowKind.occupies()` asks, so a column added to `COLUMNS` is covered with no second edit. **STATE and PHP TOTAL carry no `parse`** — one reads the joined batch, the other is arithmetic over two other cells, and neither is a field anybody could type into.

**One verdict, shared by the commit and the save.** `parseRcInField` is called by every column's `ColumnSpec.parse` AND by `buildDeliveryUpdate`, so a value typed and the same value refused at Save can never disagree. A **blank cell commits without complaint** (it means CLEARED); the two fields a delivery cannot exist without — `transaction_date` and `batch_code` — are refused at ROW level in the builder, so clearing a cell you are about to retype does not raise a persistent toast mid-typing.

**Two lanes canonicalise at commit (`ColumnSpec.normalize`).** `8/21` becomes `2026-08-21` via the shared `normalizeTypedDate` (context year = the ROW's own year, else the newest dated row in view); `a-12b` becomes `A-12B` via `normalizeBlockLoc`, because `toDeliveryPayload` imposes that spelling on the way to the database anyway. `cleanPastedRcInCell` runs the same normalisation for the clipboard path, so a typed `8/21` and a pasted `8/21` can never land on two different years. Block/Loc format is judged by the SHARED `validateBlockLoc` — the same predicate `actions.ts` runs server-side, asked at the cell instead of after Save.

**THE PAYLOAD IS A WHOLE ROW, and that is the server's rule, not a preference.** `toDeliveryPayload` in `actions.ts` rebuilds a fixed object from whatever it is handed — `weight_kg: Number(row.weight_kg)`, `sacks: Number(row.sacks)`, `cost_basis: … ? 0 : Number(...)`, `block_loc: row.block_loc ? normalize(...) : null` — so a genuinely partial `data` object does **not** leave the other columns alone: it clears `block_loc`, writes NULL over `weight_kg`/`sacks`, and writes **₱0 over the price**. `upsertBatchesFromRows` would additionally upsert a batch whose `batch_code` is `undefined`. So every update is a COMPLETE `DeliveryRow`, assembled as *stored value unless the operator typed over it*, with the dialog's own coercions (`parseInt(...) || 0`, `parseFloat(...) || 0`). `verify-rc-in-grid.ts` SCANS `actions.ts` for those four lines, so the day the action gains a partial-patch door this decision is re-opened by a failing assertion rather than by memory.

**THE LAB PANEL IS SENT WHOLE, because `fn_bulk_update_deliveries` merges with `to_jsonb(d) || v_data` — a SHALLOW jsonb merge.** A `lab_results` object in the payload REPLACES the stored one key-for-key, so sending `{ mc: 12 }` after an MC edit would delete GRIT, VM, ASH, FC and both BD readings: six lab values gone, on a successful save, with no error anywhere. `buildLabPanel` therefore reassembles the panel from **the stored object plus the edits**. Three properties, all asserted: an untouched key rides back verbatim; **no lab cell edited at all → the key is `undefined`**, dropped by `JSON.stringify`, so the merge leaves the column completely alone (a null panel stays null rather than becoming `{}`); a **CLEARED** lab cell **deletes its key rather than storing 0**, because a 0 in a lab lane is a READING and "never measured" is a different fact. This is one deliberate improvement over the dialog, and it can only ever preserve MORE — the dialog rebuilds all seven lanes as `parseFloat(...) || 0`, so editing a remark on a delivery with an empty panel writes seven fabricated `0.00` readings. **Inserts still get the dialog's full seven-zero panel** (a new row has no stored panel to preserve, so shape parity wins).

**`savedFieldText` ≠ `storedFieldText`, in exactly one lane.** The sheet DISPLAYS the batch's `location_ref` when a delivery carries no `block_loc` of its own (the live table's habit). Reading that back into a whole-row save would write a fallback the operator is only being SHOWN onto the delivery itself — a column silently filled in on every row an unrelated remark edit touched. `savedFieldText` returns `row.block_loc ?? ''` and every other lane is the same answer in both. The two cannot desync the other way either: `mergeFieldEdit` compares against the DISPLAYED text, so typing the fallback back in is a non-edit that never reaches the payload.

**Drafts.** A `DEFAULT_DRAFT_ROWS` pool of blank rows sits at the very bottom (below the last month heading — they belong to no month until dated), saved through `submitBulkDeliveries`, the same door the Add dialog uses, so batch upsert-by-`batch_code` stays the server's job. The validity rule is the dialog's verbatim: **a batch code and a weight above 0**. The seed date is `new Date().toISOString().split('T')[0]` — `createEmptyRow`'s own value — and the strip above the sheet SAYS it, because a date nobody typed must not reach the ledger unseen. Drafts are off under a `search` (a search is a CUT of history and a new delivery does not belong at the end of a cut), which also switches off paste-grows-the-sheet.

**The save-time EDIT REASON.** `bulkUpdateDeliveries` already carries a per-row `comment` that the RPC attaches to each row's latest `audit_logs` entry. On Save, if there is at least one EDITED row, a small dialog asks for one optional note applied to all of them; a save that is purely new rows skips the question entirely (an insert has no prior state to explain). Skippable — the primary button saves whatever is in the box, including nothing — and never blocking.

**What the actions actually return, and what the UI therefore says.** Both `bulkUpdateDeliveries` and `submitBulkDeliveries` answer with a single `{ success, message? }` for the WHOLE batch — **never one verdict per row**. `fn_bulk_update_deliveries` is transactional, so a refusal genuinely means nothing was written, and `saveFailureMessage` says exactly that ("the whole batch was rolled back… every keystroke is still on screen") with the action's own message appended verbatim. There is no partial-success state to render and none is invented. The updates run FIRST and a failure stops the run; if the updates land and the INSERTS are refused, the toast says so explicitly. Every error surface is `errorToast` (persistent + Copy, HARD RULE) — the verify script scans the file to forbid a bare `toast.error`.

**Nothing is written unless every dirty row builds a legal payload.** `handleSave` builds both buckets first and, on any refusal, raises ONE persistent toast naming every problem by row and writes nothing.

**After a successful save:** `edits.forget(savedRowIds)` (per-row, so a future partial verdict costs no keystrokes), consumed draft ids retired and the pool topped back up, journal cleared by `forget` per the module contract, then `router.refresh()` in a transition. **The component is not keyed on anything, so it does NOT remount** — the refetched rows arrive as the `data` prop, `flatten` / `byId` / `storedText` re-derive, and the saved rows have already been forgotten, so nothing is left lit and no keystroke of a refused row is disturbed.

**PRICE GATING — and why the whole door is shut for a price-blind role.** `canViewPrices` arrives as a PROP, resolved server-side in `page.tsx`; this file never calls `hasPermission` and never re-derives the role (asserted by a source scan). `ctx.canEdit` **is** `canViewPrices`, so a Production viewer's sheet stays read-only. Not squeamishness: `page.tsx` sends `cost_basis: undefined` to such a viewer, `toDeliveryPayload` turns that into **0** — the L-008 unpriced placeholder — and the only available write action rewrites `cost_basis` on every row it touches, so a Production operator correcting a REMARK would silently overwrite the delivered ₱/kg of every row they touched. `PRICE_BLIND_REFUSAL` is the single wording, refused in `buildDeliveryUpdate` AND `buildDeliveryInsert`, and PHP/KG additionally has its own `editable` clause and its own `parseRcInField` refusal. Four locks, and the column is `visible: false` for them on top. **This costs nothing that existed** — the grid was read-only for everyone until this pass.

> **The seam that would open it (declined, with a reason).** A price-blind in-app edit needs a server action that sends a genuinely PARTIAL patch — the shape `fn_bulk_update_deliveries` already supports (`to_jsonb(d) || v_data` merges only the keys present) and only `toDeliveryPayload` prevents. **Backend request:** `app/(app)/inventory/rc-in/actions.ts` · `bulkPatchDeliveries` · `(updates: { id: string; data: Partial<DeliveryRow>; comment?: string }[]) => Promise<{ success: boolean; message?: string }>` — identical to `bulkUpdateDeliveries` except it forwards `data` unchanged apart from `normalizeBlockLoc` on a PRESENT `block_loc`, skips `upsertBatchesFromRows` unless `batch_code` is present, and refuses a `cost_basis` key from a `!canViewPrices()` caller. Not built here: this pass may write no new server action.

**Not built in this pass:** cell AUTOCOMPLETE on Supplier / Batch / Loc (the live grid's `AutocompletePopover` over the `batches` + `allSuppliers` props, which arrive and are unread) — plain text for now, so a typo lands as typed and is refused only where the server refuses it. Also no row context menu, no delete, no history dialog.

**Props gap (not closed here — `page.tsx` is another agent's file this pass).** `/inventory` is year-scoped by `?year=`, and neither table receives it. `ctx.fallbackYear` is derived from the newest dated row in `data` instead, which is right in every view where the two agree; threading the param would make a bare `8/21` unambiguous in an empty year.

**Column order is `CLAUDE.md`'s, not the live table's.** Project `CLAUDE.md` → "RC IN Column Config" is canonical and this grid obeys it exactly: Date · Supplier · Batch Code · Block/Loc · Truck Plate · Sacks · Weight · MC, Grit, VM, Ash, FC (2dp) · BD ASTM, BD JIS (3dp) · PHP/KG · PHP Total · Remarks. The live table predates that config and differs in three places (labs interleaved as MC/GRIT/BD·BD/VM/ASH/FC, Weight before Sacks, Remarks before the ₱ columns), **so flipping the toggle visibly reorders the sheet.** That is the intended reading of the two sides.

**STATE leads the row**, ahead of Date. It is not one of the 17 columns `CLAUDE.md` lists — it is the live table's first column and what an operator scans for, so dropping it would make the comparison poorer for no gain. One entry in `COLUMNS`; removing it is a one-line change.

**STATE is `rowCopy: false` (2026-08-20).** Renzo: *"the state column should never be copied when doing copy row."* It is a status RAIL — derived from the batch, not part of the delivery record — and `Copy row` names no columns, so it is the one copy path that has to be told what the row IS. It narrows **that path only**: `lib/table/clipboard.ts::rowCopyColumns` is the one definition of the covered set, and the rectangle copy behind Ctrl/Cmd+C, `Copy` and `Copy with headers` builds its column list from the selection's own bounds and never consults it — so a sweep the operator deliberately made over STATE still copies it.

**Dates render VERBATIM.** `transaction_date` is stored as `yyyy-MM-dd`, which is also the format `CLAUDE.md` asks for, so there is no `new Date(...)` anywhere near it — the live table parses it back to a `Date` to re-print it as `MM/DD/YYYY`, and that round trip is the classic place a timezone quietly moves a delivery to the previous day.

**Price gating (display half).** The two ₱ columns do not EXIST for a gated viewer (`ColumnSpec.visible`), so they are absent from the coordinate space rather than blanked — the keyboard has no unreachable hole, a copy cannot address them, and the totals lane collapses on its own. The write half is above.

**What it reads from the shared provider, read-only:** `settings.densityMode` (row height 32/48), `settings.labHighlights` (the same thresholds `getLabHighlightBg` applies in the live table) and `settings.hiddenColumns` (a column hidden there is absent here). Nothing writes back — column widths dragged in v2 live in local state and are never persisted, because persisting them would be a write.

**Month group headings** are rendered through `renderChromeRow` (label · delivery count · kg · ₱), with a real blank spacer row at each month boundary. The sticky totals rule-off is ALWAYS shown, where the live table shows its TOTALS footer only when a filter is active.

### The SEARCH box (2026-09-02) — `components/delivery-search.tsx`

Renzo: *"The new v2 table doesn't have that same search bar found in the original table we
made for it. Migrate/copy that feature into our new current v2 table. It's very very
useful."* It is now the first control in the v2 strip, ahead of the `grid=v2` badge's prose.

**It is a NEW FILE, not an extraction, and that was a decision.** The brief allowed lifting
the live control into a component shared by both tables *only if the lift were pure*.
It is not: the live control carries a `{filteredData.length} found` badge counting
CLIENT-side filtered rows (a concept the v2 grid does not have), and it has neither a clear
(×) affordance nor an Escape handler — both of which this pass adds. Any one of those makes
the change behavioural, and `delivery-master-table.tsx` is production and is **still not
edited by one character**. So the live table stands exactly as it was and this is its
sibling: the things that matter are reproduced verbatim, and the two additions write the
same param the same way.

**Reproduced verbatim from the live control:** the placeholder
(`Search supplier, batch, truck...`), the lucide `Search` icon and its position, the
**300 ms** debounce, and `createQueryString` — a full copy of the current query with only
`search` set or deleted.

| Behaviour | Where it is decided |
|---|---|
| **The query** | `page.tsx` — `?search=` swaps the year-bounded fetch for an `ilike` across **supplier · batch_code · truck_plate · block_loc**. Unchanged by this pass. |
| **All Years** | `page.tsx` too. A search drops the date bound and `shownYear` resolves to `PERIOD_ALL`, so the picker goes inert and reads *All years*. **The control never touches `?year=`** — the live table does not either — so the year in the URL is carried across untouched by `createQueryString` and comes back into force the moment the search clears. There is no "restore" to write, because nothing was thrown away. |
| **The status line** | `delivery-grid-v2.tsx` — the SAME slot that prints `{period} · N rows`, so the count never moves. Under a search it reads the live table's sentence verbatim: *Found **6** results for "**ORNALES**" in **All Years***. |
| **Clear** | A `×` inside the input (right edge), shown only when the box has text. It bypasses the debounce and pushes immediately, then re-focuses the box. |
| **Escape** | Bound on the **input only**, never on the document, so Escape inside the sheet still means *revert this cell*. A non-empty box clears; an empty one blurs. `stopPropagation` so nothing else sees it. |
| **No `/`, no Cmd/Ctrl+K** | The live table binds neither, so neither is bound here. The Blackwood Table's keyboard space is the sheet's — a printable character types over the active cell — and a global `/` would steal it. |

**THE URL IS THE ONLY CHANNEL, and there must never be a second one.** No client-side
predicate filters the returned rows. A local "matches" would be a second definition of the
server's `ilike`, and the day the two disagree the sheet hides a row the server
deliberately found.

**Two guards that were already there and still hold:** blank draft rows are off under a
search (`showDrafts`), which through `drafts.enabled` also switches off
paste-grows-the-sheet — a search is a CUT of history and a new delivery does not belong at
the end of a cut; and **Save does not navigate**, it is `router.refresh()`, so a save made
while a search is active leaves the search exactly where it was (measured: Save enables
under a search, `?search=` untouched). `activeSearch` is now read ONCE at the top of the
component and shared by the draft rule, the status line and the empty state, so no two of
them can disagree about whether a search is in force.

Two small implementation notes. The component carries **its own `React.Suspense`
boundary** (`useSearchParams`), the same shape `PeriodPicker` uses, with the control at
rest as the fallback so the strip never reflows. A `pushedRef` remembers the last value
handed to `router.push`, so the debounce and the × cannot push the same query twice while a
navigation is in flight — one gesture, one history entry. It is marked `data-grid-chrome`;
the strip is a sibling of the table rather than a descendant, so no keystroke here reaches
the sheet today, and the marker is what keeps that true if the strip ever moves into a
toolbar slot. `router.push` passes `{ scroll: false }` — the rows are replaced in place, and
a sheet that jumps to the top mid-keystroke is one you cannot read while typing.

**Empty state under a search** says *No deliveries match "X" in any year.* rather than
naming the period, because under a search the period is not why the sheet is empty.

**Still not built:** the year dropdown + month strip (`DeliverySheetFooter`), the live table's OWN STATE/Supplier/LOC header filters and their `?sx=`/`?sup=`/`?loc=`/`?m=` URL persistence (the UNIVERSAL per-column sort and filter ARE built — see the section below), the "All Years" auto-switch and pre-filter date restore, the Columns popover, the Settings dialog, the density toggle, Delete / Refresh, row-selection mode, the row context menu, `DeliveryHistoryDialog`, `TrueWeightPopover` (the Σ deduction marker), the `?editBatch=` deep link, expanded-mode annotations, per-column bold/italic/underline, and the mobile card layer. Because there is no month filter, **v2 shows the whole `?year=` scope at once** while the live table opens on the current month. Where a behaviour is not built this file renders NOTHING rather than a control that looks alive and does nothing.

### The universal sort and filter, switched on (owner feedback R8, 2026-09-03)

Renzo: *"the columns in v2 table of deliveries don't have robust filtering/sorting as per my
rule about universal table modules."*

It is **two props** on the `BlackwoodTable` — `enableSort` and `enableFilter` — and no
per-column work at all. Every column already declared what the platform needs.

**Why the props are needed, and why the SCOPE was not changed instead.** `scope="endless"`
defaults both OFF, and that default protects something real: an endless grid's row order and
its window are the SERVER's keyset, so a client-side sort would reorder only the rows
currently loaded and `hasOlder` / `hasNewer` — which mean "there are older/newer rows beyond
this window **in the server's order**" — would become claims about an order that no longer
exists.

**This sheet has no such window.** It passes no `startReached`, no `endReached`, no
`firstItemIndex` and no pager of any kind: `page.tsx` hands it the WHOLE `?year=` scope (or
all years, under a search) in one payload and `items` is filtered from that array in this
file. The scope is `endless` here for the VIRTUALISER, not for a keyset — so the caveat the
default guards against cannot arise. The opt-in is explicit rather than a scope change,
because changing the scope would silently change how the rows are RENDERED. A new check
block in `scripts/verify-rc-in-grid.ts` (**34 assertions now, was 33**) asserts both the
opt-in and the ABSENCE of every pager prop, so the day someone adds a pager the gate fires
and this note gets re-read.

**What each column does, and where that came from.** `sortable` / `filterable` default to
true except on `cellKind: 'derived'`, and this grid declares no derived column — so all
eighteen are sortable and filterable with nothing declared. The comparison reads
`numericValue` where a column has one and `clipboardValue` otherwise:

| Lanes | Compare as | Because |
|---|---|---|
| SKS · WEIGHT · MC · GRIT · VM · ASH · FC · BD ASTM · BD JIS · PHP/KG · PHP TOTAL | **numbers** (`numericValue`) | already declared for the selection-summary arithmetic. This is also what makes the funnel offer **MIN / MAX** — the popover shows bounds only where a column declares one |
| STATE · DATE · SUPPLIER · BATCH · LOC · TRUCK · REMARKS | **case-insensitive text** (`clipboardValue`) | the same string a copy puts on the clipboard, so what the operator searches for is what they can see |

**DATE sorts as a date and no `new Date()` was introduced.** `transaction_date` is stored
AND rendered `yyyy-MM-dd`, which is chronological under
`localeCompare(…, { numeric: true })` — the round trip through a `Date` is the classic place
a timezone quietly moves a delivery to the previous day, and this grid still never does it.

**Two platform rules the module gets for free, both verified rather than assumed:** the month
group headings and the sticky Σ rule-off HIDE while a sort or a filter is active (a heading
is a claim about a RUN of adjacent rows, and a sort destroys the run), and clearing both
restores this file's own flatten byte for byte; and the blank draft rows never sort and never
filter out, so a row being typed cannot jump to the top or vanish because it does not match
yet.

**No `f_<column>` URL wiring, and none exists to copy.** The universal filter is VIEW state
by design — `lib/table/CONTEXT.md` §3 states it never touches the URL — and the Cenapro
grid's `filter: { kind, column }` spec is metadata for THAT module's own server-side filter
feature, not a search-param convention of the platform. The v2 grid's `?search=` box is
untouched and still owns the one param this screen writes; a consumer whose filters live in
search params keeps them, and this is a second, local axis beside them.

**Measured in the browser at 1512** (120 fabricated deliveries in a throwaway harness, since
deleted): a sort on DATE hides the month headings and renders the rows flat ascending; a
`MIN 20000` on WEIGHT leaves **59 of 120 rows**; the strip under the sheet reads
`59 of 120 rows · sorted by DATE ↑ · Clear`; the funnel offers `contains…` + MIN/MAX on
WEIGHT and `contains…` alone on the text lanes.

One sentence of chrome moved with it: the `grid=v2` badge's inventory line said *"the column
filters … are not built yet"* over a header that now plainly filters. It now names what is
actually still absent — the live table's own STATE/Supplier/LOC popovers and their URL
persistence, which are a different feature.

## See Also
- [Blackwood Table — the universal table module](../../../../lib/table/CONTEXT.md) — the port (`ColumnSpec` / `RowKind.occupies` / `TableSettings`), the React half, and the `?grid=v2` recipe `delivery-grid-v2.tsx` follows.
- [Cenapro RC Deliveries](../../cenapro/deliveries/CONTEXT.md) — `deliveries-grid-v2.tsx` + `grid-v2-save.ts`, the reference implementation this module's editing pass follows. The shapes are deliberately the same; the ONE structural difference is the server, which takes an allowlisted PARTIAL patch there and a whole row here.
- [Blackwood Table — shared grid package](../../../../components/shared/grid/CONTEXT.md) — the three-layer grid primitives the bulk input grid now consumes (keyboard state machine + resolvers + edit session + paste). `bulk-delivery-input.tsx` is the canonical reference diff for migrating the other flat grids.
- [RC OUT](../rc-out/CONTEXT.md) — shares `DeliverySheetFooter` (at `../components/DeliverySheetFooter`) and `parseExcelDate()` (at `@/lib/paste-utils`)
- [Blocking](../blocking/CONTEXT.md) — warehouse grid visualization; reuses `bulkUpdateDeliveries()` for edit-in-place and `DeliveryHistoryDialog` for per-delivery info view
- [Auth Provider](../../../../components/providers/AUTH.md) — permission model for cost visibility
- [Navbar](../../../../components/NAVBAR.md) — breadcrumb registration
