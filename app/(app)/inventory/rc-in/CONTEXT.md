# RC IN Module — Delivery Master Log

## Purpose
Captures incoming raw charcoal deliveries. Dense Excel-like grid with paste support, keyboard navigation, audit trails, and role-based cost visibility.

> **Domain Module (Charcoal Tenant):** This module is domain-specific — it belongs to the charcoal plant operations layer, not the platform layer. Business logic, schema references, and terminology here are intentionally charcoal-specific. When adapters are built for the dashboard widgets, they will extract data from these tables — but widgets themselves will never import from this module.

## Files
| File | Lines | Role |
|------|-------|------|
| _(no `page.tsx`)_ | — | RC IN is **not** its own route — it renders as the Deliveries tab of `/inventory`. Data is fetched server-side in `../page.tsx` (the parent inventory logs page) and passed to `DeliveryMasterTableWrapper` via `InventoryView`. |
| `actions.ts` | ~680 | 11 server actions: `submitBulkDeliveries`, `bulkUpdateDeliveries`, `bulkDeleteDeliveries`, `deleteDelivery`, `updateDelivery`, `getDeliveryHistory`, `getAuditComments`, `getAuditLogEntry`, `addAuditComment` + 4 resolve actions + `getTableSettings(module)`, `saveTableSettings(module, settings)`. All mutation paths: (1) normalize `block_loc` via `normalizeBlockLoc()` before DB insert, (2) validate block_loc format + duplicate location on all writes, (3) translate DB constraint names to friendly errors via `translateDbError()`. **`bulkDeleteDeliveries` + `deleteDelivery` enforce a SERVER-SIDE permission gate** (getUserRole() + `PRIVILEGED_ROLES` = Owner/Admin/Dev, mirroring the client `hasPermission('delete:all')`) — deletes are re-checked server-side, not just UI-hidden. |
| `bulk-delivery-input.tsx` | ~1250 | Client grid editor — paste, keyboard nav, autocomplete, edit tracking, cell range selection + copy + delete. **Canonical Blackwood Table reference grid** (Phase 1 of the grid consolidation): the hand-rolled keyboard state machine (`handleGridKeyDown` + `moveSelection`), edit-trigger/revert logic, and smart-paste were replaced by the shared primitives — see "Blackwood Table primitives" below. |
| `components/delivery-master-table-wrapper.tsx` | ~31 | Client wrapper — `dynamic()` with `ssr: false` to avoid Radix hydration mismatch |
| `delivery-master-table.tsx` | ~2100 | Client data table — virtual scroll, column header filters (state/supplier/loc), 2 density modes (normal/expanded), heat-tinted lab cells, right-click context menu, column resize, settings dialog, year/month controls, cell selection + clipboard copy |
| `components/settings-dialog.tsx` | — | Settings dialog with density toggle, font size slider, lab range threshold editors with color previews |
| `components/columns-popover.tsx` | — | Column visibility popover with role-aware cost column gating |
| `components/density-toggle.tsx` | — | Normal/Expanded segmented control |
| `paste-utils.ts` | 47 | Column mapping and cell value cleaning (imports `parseExcelDate` from `@/lib/paste-utils`) |
| `components/DeliveryHistoryDialog.tsx` | 561 | Delivery history + audit trail dialog |
| `components/audit-shared.tsx` | 87 | Shared audit display utilities |
| ~~`edit/[auditLogId]/`~~ | — | **Moved** to `app/(app)/edit/[auditLogId]/` (standalone route outside inventory layout) |
| `error.tsx` | 25 | Error boundary |
| `loading.tsx` | 47 | Loading skeleton |

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
- `@/lib/auth.ts` — `getUserRole()` (includes dev override check)
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
- `@/app/(app)/inventory/_shared/true-weight-popover` — `TrueWeightPopover`, the display-only weight-deduction / true-weight popover shown on the master table Weight cell (also reused by the Blocking detail panel). See the weight-deduction columns block above.
- `@tanstack/react-table`, `@tanstack/react-virtual`, `date-fns`, `sonner`

## See Also
- [Blackwood Table — shared grid package](../../../../components/shared/grid/CONTEXT.md) — the three-layer grid primitives the bulk input grid now consumes (keyboard state machine + resolvers + edit session + paste). `bulk-delivery-input.tsx` is the canonical reference diff for migrating the other flat grids.
- [RC OUT](../rc-out/CONTEXT.md) — shares `DeliverySheetFooter` (at `../components/DeliverySheetFooter`) and `parseExcelDate()` (at `@/lib/paste-utils`)
- [Blocking](../blocking/CONTEXT.md) — warehouse grid visualization; reuses `bulkUpdateDeliveries()` for edit-in-place and `DeliveryHistoryDialog` for per-delivery info view
- [Auth Provider](../../../../components/providers/AUTH.md) — permission model for cost visibility
- [Navbar](../../../../components/NAVBAR.md) — breadcrumb registration
