# RC IN / RC OUT Feature Inventory — Pre-Migration Report

Read-only audit of `app/(app)/inventory/{rc-in,rc-out}` and the `/inventory` shell, done by reading every file the task named plus following the actual wiring (grep-verified, not assumed) for cross-module consumers, dead code, and shared-state coupling. All line numbers are current as of this read.

---

## 1. RC IN feature inventory (`app/(app)/inventory/rc-in/`)

Legend: **core** = must survive byte-for-byte or the users will notice immediately; **nice** = valuable but the migration can reasonably change its shape; **dead-or-redundant** = confirmed unused/broken today, do not bother porting as-is.

| Feature | Where (file:line) | How it works (1 line) | Depends on | Verdict |
|---|---|---|---|---|
| Toolbar: search | `delivery-master-table.tsx:1606-1622` | Debounced 300ms, pushes `?search=` via `router.push`; server (`page.tsx`) queries supplier/batch_code/truck_plate/block_loc across **all years** when active | URL param `search`, `page.tsx` server query | core |
| Toolbar: Clear filters | `delivery-master-table.tsx:1624-1635` | Shown only when `hasActiveFilters`; resets STATE/Supplier/LOC and restores pre-filter year/month | client filter state | core |
| Density toggle (Normal/Expanded) | `delivery-master-table.tsx:1643`, `components/density-toggle.tsx` | 2-mode segmented control, `h-8`/`h-12` rows | `useTableSettings().setDensity` | core |
| Columns popover | `delivery-master-table.tsx:1645-1649`, `components/columns-popover.tsx` | 18-column checklist, PHP/KG+PHP Total hidden from list unless `hasPermission('view:prices')`, "Show All" reset | `settings.hiddenColumns` (provider) | core |
| Settings dialog (font size, lab highlights) | `delivery-master-table.tsx:1600`, `components/settings-dialog.tsx` | Font slider 9-14px; 7 lab-metric rows (checkbox / fixed direction text / limit number input / 8-color popover / per-metric reset); global "Reset to Defaults" | `useTableSettings()` | core |
| Select mode toggle | `delivery-master-table.tsx:1661-1673` | Toggles `selectionMode`; clears cell-selection when entering | local state | core |
| Add button → bulk grid dialog | `delivery-master-table.tsx:1520-1544, 1675-1678` | Opens `BulkDeliveryInput` in `mode='create'` | `BulkDeliveryInput`, `submitBulkDeliveries` | core |
| Refresh button | `delivery-master-table.tsx:1680-1693` | `router.refresh()` + 1s spinner (fire-and-forget; real freshness comes from `revalidatePath`) | Next.js router | core |
| Year dropdown ("All Years" + year Select) | `components/DeliverySheetFooter.tsx` (whole file), mounted at `delivery-master-table.tsx:1985-1993` | Sliding-indicator control; year list = currentYear+1 down to 2010; changing year sets `?year=` and clears `?view_date=` | `?year=` URL param, `handleYearChange` | **core** — this is exactly what the user wants replaced by a "Year dropdown," so port the *interaction contract*, not necessarily this exact widget |
| Month strip (All Months + 12 months) | `DeliverySheetFooter.tsx:14-17,189-224` | Sliding-indicator segmented row; **client-side only** — filters already-fetched year data by string-slicing `transaction_date.slice(5,7)` (avoids TZ bugs) | `?m=` URL param (silent `history.replaceState`, not a real nav) | core (same note as above — this is the "footer strip" the user called a mess) |
| Footer disabled during search/year-load | `DeliverySheetFooter.tsx:117-120`, `delivery-master-table.tsx:1990-1991` | Whole footer grays out while `search` active, search input focused, or `isYearLoading`; months additionally disabled when year=`all` | — | nice |
| Year change → 2s loading overlay | `delivery-master-table.tsx:363-366,387-393,1718-1725` | Blur-in overlay + spinner, min 2s even though `router.replace` may resolve faster | `isYearLoading` state | nice |
| **Server-side year scope** | `page.tsx:40-46` | `?year=<n>` → `gte/lte transaction_date`; `?year=all` or `search` present → no date bound at all | `page.tsx` query builder | core |
| **Default year/month on load** | `page.tsx:19` (year), `delivery-master-table.tsx:227` (month) | No `?year=` → `new Date().getFullYear()`; month state inits to `new Date().getMonth()` | — | core |
| **"All Years" auto-switch on filter** | `delivery-master-table.tsx:458-465 (STATE), 496-503 (Supplier/LOC), 520-527 (setLocFilter)` | Any header filter going from empty→non-empty (or STATE exclusion going partial) while year≠`all` calls `handleYearChange('all', …)` so the filter runs over the full dataset, not just the visible year | `preFilterDate` ref | core — subtle, easy to silently drop |
| **Pre-filter date restore** | `delivery-master-table.tsx:428-447 (maybeRestoreDate)` | Saves `{year, month}` into a ref the *first* time any filter activates; restores it the moment **all** filters are cleared (STATE full-exclusion counts as cleared) | same ref | core |
| STATE header filter (exclusion model) | `delivery-master-table.tsx:2040-2097 (StateHeaderFilter)`, filter logic `450-482` | `Set<string>` of **excluded** states; empty = all shown. Select All / Deselect All (Deselect All is **UI-only**, no URL sync/year-switch). Default on fresh load excludes `CLOSED` | `?sx=` (comma list, or sentinel `_all`) | core |
| `sx=_all` sentinel | `delivery-master-table.tsx:241-251,467-471,543-563` | Distinguishes "user explicitly cleared" from "fresh load → apply CLOSED-excluded default" so the default doesn't reassert itself after a Suspense remount | URL param `sx` | core — non-obvious, will silently regress if missed |
| Supplier header filter (inclusion model) | `delivery-master-table.tsx:2099-2155 (SupplierHeaderFilter)` | `Set<string>` of **included** suppliers; empty = show all. `Command`-searchable checkbox list, "Clear" link | `?sup=`, `allSuppliers` prop (all-time distinct, from `page.tsx`) | core |
| LOC header filter (inclusion model) | `delivery-master-table.tsx:2157-2196 (LocHeaderFilter)`, content `2199-2332 (LocFilterContent, exported)` | 4 collapsible WHSE sections (A/B/C/D) with whse-level tri-state checkbox + per-loc checkboxes; whse toggle flips the whole group atomically | `?loc=`, `allLocations` prop | core |
| Column header filter badges | e.g. `2060-2069` | `Filter` icon dims/brightens + numeric badge shows exclude/include count per column | — | nice |
| Filter URL persistence (silent) | `delivery-master-table.tsx:269-299` | `sx`/`sup`/`loc`/`m` written via raw `window.history.replaceState` (NOT `router.replace`) so filter state survives a `loading.tsx` remount without a server round-trip; deprecated `wx`/`supx`/`lx` cleaned up on mount (`253-263`) | — | core |
| Column visibility | `columns-popover.tsx`, applied `1028-1034` | Persisted in `settings.hiddenColumns` | table-settings provider + DB | core |
| Column resize (drag handles) | `delivery-master-table.tsx:1038-1054 (enableColumnResizing:true), 1764-1775 (handle), 1056-1068 (debounced persist)` | TanStack `columnResizeMode:'onChange'`; persists to `settings.columnWidths` 300ms after drag stops | table-settings provider + DB | core |
| Bold / Italic / Underline column formatting | `delivery-master-table.tsx:1483-1496 (menu items), 1838-1843 (applied)` | Column context-menu toggles with `keepOpen` + `trailingIcon=Check`; applies CSS classes to every body cell in that column | `settings.columnFormats` | nice — real feature, but check if anyone actually uses it before assuming "core" |
| Lab highlight thresholds | `types/table-settings.ts:38-46 (DEFAULT_LAB_HIGHLIGHTS)`, editor `settings-dialog.tsx:137-216`, applied `delivery-master-table.tsx:941 + 1828-1834` | **Single-threshold** system (not old good/warn/alert range): per-metric enabled flag, fixed direction (MC/Grit/VM/Ash = bad-above; BD ASTM/BD JIS/FC = bad-below), numeric limit, 1-of-8 color. Applied to BOTH the inner cell span *and* the `<td>` background | `settings.labHighlights` | core |
| Density (row height) | `types/table-settings.ts:1,9-13`, toggle in toolbar + settings dialog | 2 modes only (`normal`=32px, `expanded`=40/48px in virtualizer); **legacy "compact" mode removed** | `settings.densityMode` | core |
| Font size 9-14px | `settings-dialog.tsx:111-125` | Slider, applied via inline `style={{fontSize}}` throughout | `settings.fontSize` | core |
| ⚠️ **Settings persistence is a SINGLE GLOBAL provider shared with RC OUT** | `components/providers/index.tsx:18`, `components/providers/table-settings.tsx:50 (tableId='rc_in' default)` | `TableSettingsProvider` is mounted **once** at the app root with **no `tableId` prop**, so it always stores under module key `'rc_in'`. RC OUT's font-size/row-height controls (see RC OUT table below) read/write **this exact same context instance** — they are not independent today. | `user_table_settings(user_id,'rc_in')` + localStorage key `rc_in_table_settings` | **flag explicitly** — decide on purpose whether the new universal module keeps this coupling or finally scopes settings per table |
| `initialSettings` server prop | `page.tsx:82,94` → `inventory-view.tsx:52` → `delivery-master-table-wrapper.tsx` | Fetched via `getTableSettings('rc_in')` and threaded all the way down, but `DeliveryMasterTable`'s prop interface (`delivery-master-table.tsx:194-200`) **never declares or reads it** — it's silently dropped. The real provider (root layout) never receives it either. | — | **dead-or-redundant** — confirmed via full trace; don't assume this wiring does anything |
| Heat-tinted lab cells | `delivery-master-table.tsx:937-951 (cell), 1826-1834 (row td)` | `getLabHighlightBg()` colors both the value and the cell background when a lab value crosses its configured threshold | `types/table-settings.ts` | core |
| Expanded-mode annotations | throughout columns memo, e.g. `740-749` (state), `776-785` (date/day name), `799-808` (supplier + delivery count), `883-892` (weight + sacks subline), `909-916` (sacks), `984-999` (cost delta vs weighted avg) | Only in `densityMode==='expanded'`; second line under the primary value | `supplierCounts`, `avgCostBasis` memos | nice |
| Conditional TOTALS footer | `delivery-master-table.tsx:1887-1979` | Only rendered when `hasActiveFilters`; weighted lab averages, weight/PHP totals with `formatCompact()` + tooltip for full number; column-count-aware `colSpan` via `visiblePrefixCount` | `hasActiveFilters`, `filteredRows` | core |
| Row context menu (single) | `delivery-master-table.tsx:1325-1424 (SINGLE_ROW_ITEMS)` | View Details / Edit Delivery / Select Row / Copy Row / Filter by Supplier / Filter by Batch (block_loc) / — / Delete (permission-`hidden`) | `useGridContextMenu`, `GridContextMenu` (shared primitive) | core |
| Row context menu (multi) | `delivery-master-table.tsx:1426-1458 (MULTI_ROW_ITEMS), 1460-1467 (selection logic)` | Shown when 2+ rows selected AND the right-clicked row is in the selection: Edit Selected(N) / Copy Selected(N) / Select All / Deselect All / — / Delete Selected(N) | same | core |
| Right-click on non-selected row (selection mode) | `delivery-master-table.tsx:1817-1823` | Auto-adds the clicked row to the selection before opening the menu | — | nice |
| Column context menu | `delivery-master-table.tsx:1472-1510 (COLUMN_MENU_ITEMS)` | Sort Asc/Desc / — / Bold·Italic·Underline (keepOpen+Check) / — / Hide Column / Reset Column Width | same shared primitive | core |
| Row selection mode | `delivery-master-table.tsx:320-321,618-625,1661-1673,1697-1713` | Toggle button; click row to toggle; selection bar shows count + Deselect All/Edit/Delete | — | core |
| ⚠️ Selection-bar Delete button **not permission-gated client-side** | `delivery-master-table.tsx:1708-1710` | Unlike the context-menu Delete (`hidden: () => !hasPermission('delete:all')`, line 1407), the bulk Delete button in the selection-mode bar is **always visible/enabled**; a non-privileged user sees it, clicks it, and gets a server-rejected `errorToast` (`bulkDeleteDeliveries` enforces `PRIVILEGED_ROLES` server-side) | `hasPermission`, server gate | **flag as a bug to fix during migration**, not necessarily "must survive" as-is |
| Cell selection (rectangular) | `delivery-master-table.tsx:1084-1093,1854-1864` | Click-drag, Shift+click, Shift+Arrow, Ctrl+A; mutually exclusive with row-selection mode (`enabled: !selectionMode`); button-0-only (right-click doesn't start a drag) | `@/lib/hooks/use-cell-selection` | core |
| Cell aggregation pill | `delivery-master-table.tsx:1160-1181` | SUM for weight/sacks/php_total, AVERAGE for lab metrics + cost_basis; pushed to `StatusBarProvider` → `FloatingStatusBar` (Sheets-style auto-calc dropdown) | `use-cell-aggregation`, `status-bar-context` | core |
| Copy as TSV (Ctrl+C) | `delivery-master-table.tsx:1183-1188` | Copies selected rectangular range | `use-clipboard-copy` | core |
| Clear-selection triggers | `delivery-master-table.tsx:1190-1217` | On filteredData/sorting change, click outside scroll container (excludes status bar/popovers), Escape | — | nice |
| `DeliveryHistoryDialog` — info panel | `components/DeliveryHistoryDialog.tsx:199-234` | Remounts by `key={deliveryId}`; field cards (date/supplier/price, batch/block/whse, truck/sacks/remarks), changed-field yellow highlight + "Prev:" tooltip sourced from latest UPDATE diff | `getDeliveryHistory()` | core |
| — Liquidation block | `DeliveryHistoryDialog.tsx:481-501` | PHP/TTL card, gated `canViewPrices` | `hasPermission('view:prices')` | core |
| — Weight Deduction block | `DeliveryHistoryDialog.tsx:503-540` | Only when `true_weight_kg != null`; True Weight/Recorded/Deduction note always shown, Effective ₱/kg gated | `true_weight_kg`, `deduction_note` | nice (display-only annotation feature, low usage surface but simple to port) |
| — Lab Results row | `DeliveryHistoryDialog.tsx:544-555` | 7-metric strip with changed-highlight | — | core |
| — Activity Log feed | `DeliveryHistoryDialog.tsx:561-601` | Latest update always expanded; older entries in an `Accordion` | `history` array | core |
| — `RemarkPopover` (comments) | `DeliveryHistoryDialog.tsx:53-197` | Per audit-log-entry comment thread; shows "Edit Reason" (the `audit_logs.comment` set at edit time) + free-form comments (incl. system messages "marked this edit as resolved"/"reopened this edit"); Cmd/Ctrl+Enter submits; "See full discussion" deep-links to `/edit/[auditLogId]` | `getAuditComments`, `addAuditComment` | core |
| Audit resolve workflow (full) | **lives outside RC IN's own dialog**, at `/edit/[auditLogId]/edit-discussion.tsx` (imports `resolveAuditLog`/`requestResolveAuditLog`/`approveResolveRequest`/`denyResolveRequest` from `rc-in/actions.ts`) | Employees request resolve/reopen; Admin/Owner/Dev directly toggle or approve/deny; every action posts a system comment | server actions (§4) | **core — do not assume this lives in the table module; it's a standalone route.** Migration must keep `/edit/[auditLogId]` working or explicitly re-home it |
| `?editBatch=` deep-link from Blocking | `delivery-master-table.tsx:1219-1247` | Reads `editBatch` + `editView` (defaults to `'deliveries'` when `editView` missing, for back-compat); on match: enters selection mode, selects matching rows, opens bulk-edit after 100ms, strips **both** params from URL | Blocking's `_shared/blocking-detail-panel.tsx` "Edit All" | core — exact contract detailed in §3 |
| `TrueWeightPopover` (Σ marker) | mounted `delivery-master-table.tsx:864-882` | Only rendered when `true_weight_kg != null`; Σ icon left of the weight value; popover shows True weight / Recorded / Deduction / Effective ₱/kg (gated) | `_shared/true-weight-popover.tsx` | nice |
| Mobile card layer | `components/delivery-cards-mobile.tsx` (whole file, 575 lines), mounted `sm:hidden` at `2027-2020` | `MobileCardList` primitive; ≤6-field headline (NO ₱ ever); full detail Sheet incl. lab panel, gated prices, deduction, remarks, "View history" button; separate Filters Sheet reusing `LocFilterContent`; "View full table" read-only wide-table escape hatch | `@/components/shared/mobile/mobile-card-list` | core (desktop is `hidden sm:*`, this is `sm:hidden` — fully additive, don't drop it while chasing the desktop rewrite) |
| Price gating points (RC IN, exhaustive) | `page.tsx:67,73` (server nulls `cost_basis` before payload leaves), `delivery-master-table.tsx:215,976-1026,1932,1955` (columns + footer), `columns-popover.tsx:49-56` (list gating), `bulk-delivery-input.tsx:143,618,998,1026` (grid columns), `DeliveryHistoryDialog.tsx:246,455,482,522` (dialog), `delivery-cards-mobile.tsx:88,269-274` (mobile), `rc-in/actions.ts:308,367-376,381-386,711,745-748` (history/audit scrub) | Client gate = `hasPermission('view:prices')`; **security boundary is server-side** (`page.tsx` nulls `cost_basis` before the payload leaves, and `getDeliveryHistory`/`getAuditLogEntry` strip it from snapshots/diffs) | `@/lib/auth` `roleCanViewPrices`/`canViewPrices` | core — reproduce the server-side scrub, not just a client `if` |
| Delete permission gate | client: `hasPermission('delete:all')` (`1407,1455`); server: `PRIVILEGED_ROLES` check in `deleteDelivery`/`bulkDeleteDeliveries` (`actions.ts:264-295,396-422`) | Owner/Admin/Dev only; server re-checks independent of client hide | `@/types/auth` `PRIVILEGED_ROLES` | core |
| Virtual scroll (master table) | `delivery-master-table.tsx:1070-1082` | `@tanstack/react-virtual`, `overscan: 15`, row height driven by density | — | core |
| **Bulk-delivery-input dialog** — create/edit modes | `bulk-delivery-input.tsx:139-160 (rows init), 495-543 (submit)` | `mode='create'` → `submitBulkDeliveries`; `mode='edit'` (array of `initialData`) → `bulkUpdateDeliveries`, IDs tracked in `rowIdsRef` aligned by row index | `rc-in/actions.ts` | core |
| — Autocomplete: Supplier | `bulk-delivery-input.tsx:837-852` | `AutocompletePopover` over `allSuppliers` | shared component | core |
| — Autocomplete: Batch (BLOCK column) w/ block_loc auto-fill | `bulk-delivery-input.tsx:854-879` | Selecting a known `batch_code` auto-fills `block_loc` from `batch.location_ref` via `updateRowFields` | `batches` prop | core |
| — BLOCK LOC field | `bulk-delivery-input.tsx:881-892` | Plain text `Input` — **no live client-side format validation or autocomplete**; validated only on submit, server-side | `rc-in/actions.ts:validateBlockLocsForRows` | core (the absence of live validation is current behavior, worth deciding whether to keep) |
| — `block_loc` validation rule | `lib/validation.ts:22-70` (`validateBlockLoc`), used by `rc-in/actions.ts:65-125` | Regex `^(PCA\|PCB\|[A-DF])-(\d{1,2})([A-D])$` + warehouse-specific row/col range tables (A: cols1-20/rows A-C, B/C: cols1-20/rows A-B, D/F: cols1-20/rows A-D, PCA/PCB: cols15-17/rows A-C); format errors **and** occupied-by-a-different-active-batch errors are collected and returned together (never short-circuits); occupied-check is non-fatal on a DB query error | `validateBlockLocsForRows` (module-scope shared helper) | core |
| — Batch upsert | `rc-in/actions.ts:29-47`, called by both submit and update paths | Dedup by `batch_code` via `Map`, upsert `batches(batch_code, location_ref)` **before** the delivery insert/update | `batches` table `onConflict: batch_code` | core |
| — Paste (Excel/TSV) | `bulk-delivery-input.tsx:396-409` | `useGridPaste` — Excel serial-date parsing, currency/number stripping, auto-row-expansion past the end | `@/lib/hooks/use-grid-paste`, `rc-in/paste-utils.ts` | core |
| — `enableEnterAnchor: false` | `bulk-delivery-input.tsx:380-394` | Plain Enter always drops straight down (no Tab-run "return to lane" behavior RC IN never had) | `@/lib/hooks/use-grid-keyboard-nav` | core (behavioral contract, not just a flag) |
| — Cell range select+copy+delete (grid) | `bulk-delivery-input.tsx:168-228 (selection/copy), 296-308 (delete)` | Click+drag / Shift+Arrow range; Ctrl+C copies TSV; Backspace/Delete clears range; single-cell click edits in place | shared hooks | core |
| — Per-row "Edit Reason" (audit comment) | `bulk-delivery-input.tsx:763-807` | **Edit mode only** — `PencilLine` popover, separate from the row's own `remarks` field; text becomes the `comment` sent to `bulkUpdateDeliveries` (attached to the batch's audit_log trail) | `auditComments` state | core — don't conflate with the `remarks` business field |
| — Cost columns gated | `bulk-delivery-input.tsx:143,618-624,997-1023` | PHP/KG + PHP TTL header **and** body cells both hidden for Production, keeping column count consistent | `canViewPrices` | core |
| `updateDelivery(id, data)` single-row action | `rc-in/actions.ts:180-210` | Validates+normalizes block_loc, single `.update()` | — | **dead-or-redundant** — confirmed via repo-wide grep: **zero importers**. All edits (even single-row) go through `bulkUpdateDeliveries` with a 1-element array. Do not port as a "must keep" API. |

---

## 2. RC OUT feature inventory (`app/(app)/inventory/rc-out/`)

RC OUT is smaller and **structurally different from RC IN in ways the migration needs to know about explicitly** — several things the task brief assumed RC OUT shares with RC IN, it does not.

| Feature | Where (file:line) | How it works | Depends on | Verdict |
|---|---|---|---|---|
| ⚠️ **No `DeliverySheetFooter` / no year-month footer strip** | grep-verified: zero references to `DeliverySheetFooter` anywhere under `rc-out/` | RC OUT loads **all `rc_out` rows upfront** (`fetchRcOutTabData()`, no date scoping at all) and filters year via a normal **toolbar popover** (inclusion model, like Batch/Plant/Block Loc), not a footer strip | `rc-out-table.tsx:879-927 (YEAR popover)` | **Correction to the task brief** — RC OUT does not currently have the footer-strip UX the task description implied it shares with RC IN. If the new universal module gives RC OUT the same Year+Month footer as RC IN, that is a **net-new UX change**, not a like-for-like port. |
| Toolbar: search | `rc-out-table.tsx:182-188,818-827` | Client-side only, 150ms debounce, searches production_batch/destination/block_loc/remarks/batch_code/transaction_date | local state | core |
| BATCH filter (inclusion) | `rc-out-table.tsx:829-877` | `Command`-searchable checkbox; options sorted by `MONTH_ORDER` (Jan→Dec), computed server-side in `fetchRcOutTabData` | `?`-less client state | core |
| YEAR filter (inclusion) | `rc-out-table.tsx:879-927` | Plain checkbox list (only ~3 values, no search box) | — | core |
| STATE filter (exclusion) | `rc-out-table.tsx:929-981` | `STATE_OPTIONS = ['IN-USE','SUNDRYING','SUNDRIED','CLOSED']` (**no STORED** — deliberately excluded, unlike RC IN's 5-state list); default excludes CLOSED; "Show All"/"Hide All" | `stateExcluded` | core |
| PLANT/ETC filter (inclusion) | `rc-out-table.tsx:983-1031` | `Command`-searchable over `destinations` | — | core |
| BLOCK LOC filter (inclusion) | `rc-out-table.tsx:1033-1081` | `Command`-searchable, union of `rc_out.block_loc` + `batches.location_ref` | — | core |
| Filter order | `rc-out-table.tsx:241-261` | STATE → YEAR → BATCH → PLANT/ETC → BLOCK LOC → search | `filteredData` memo | core |
| ⚠️ **No STATE/Supplier/LOC integrated into column headers** — all 5 filters live in the toolbar, not the header row (unlike RC IN) | — | — | — | design note, not a bug |
| Closed Blocks summary toggle | `rc-out-table.tsx:139-170 (state+lazy fetch), 1349-1426 (render), toolbar button 1098-1107` | Default OFF; swaps the feeding table for one-row-per-CLOSED-block from `view_rc_out_closed_blocks`; **lazy-fetched on first toggle-ON only** (`closedBlocks !== null` guard); columns: Close Date/Batch/Block/Total Fed(kg)/Feedings/[Avg ₱/kg/Total Value if priced]; **zero client re-sort/re-sum** — server array order only | `fetchClosedBlocks()`, `view_rc_out_closed_blocks` | **core** — this is a real, non-trivial feature the RC IN side has no equivalent of; do not lose it in a "unify the two tables" pass |
| "Closed Blocks" hides the 5 feeding filters | `rc-out-table.tsx:814-1096` | Replaced by an empty `<div/>` placeholder so the right-side button cluster stays right-aligned | — | nice |
| Select mode / Add Record / Refresh | `rc-out-table.tsx:1108-1138` | Same pattern as RC IN | — | core |
| ⚠️ Settings popover ≠ RC IN's Settings dialog | `rc-out-table.tsx:1140-1182` | Its own `Popover` with only **Font Size** slider (9-14px) and a **"Row Height" slider (20-60px)** | `useTableSettings()` — **same global instance as RC IN** | see coupling note below |
| ⚠️ **"Row Height" slider is dead** | `rc-out-table.tsx:1167-1179` calls `setRowHeight(value[0])`; `components/providers/table-settings.tsx:118-123` | `setRowHeight` is a **no-op backward-compat shim** in the current provider ("row height is now derived from densityMode"). RC OUT's row-height UI does nothing when moved. | — | **dead-or-redundant** — do not port this control as-is; if row-height needs to be independently tunable, it needs new plumbing |
| ⚠️ **RC OUT's row height/font size are the SAME global state as RC IN's** | `components/providers/index.tsx:18` (single provider, no `tableId`) | Changing RC IN's Density toggle changes RC OUT's `rowHeight`; changing RC OUT's Font Size slider changes RC IN's font too — they read/write one `user_table_settings(user_id,'rc_in')` row | — | **flag explicitly for the migration decision** — same finding as in §1, repeated here because it's directly observable from RC OUT's own Settings popover |
| No column-visibility popover | — (doesn't exist for RC OUT) | All 9-10 columns always shown (minus the 2 price columns when gated) | — | design note |
| No column resize | `rc-out-table.tsx:569-578` — `useReactTable()` call has **no** `enableColumnResizing`/`columnResizeMode` | Column widths are fixed `size` values only | — | design note (gap vs RC IN) |
| No bold/italic/underline formatting, no column context menu | — | RC OUT uses a per-row kebab `DropdownMenu` (Edit/Delete) instead of right-click | `rc-out-table.tsx:530-556` | design note |
| No lab columns / no lab highlight settings | — | RC OUT has no lab data (`rc_out` has no lab_results) | — | n/a |
| Master table columns | `rc-out-table.tsx:389-567` | DATE, STATE (batch status badge+tooltip), BATCH (production_batch), BLOCK (batches.batch_code), WT, PLANT/ETC (destination), BLOCK LOC (fallback to `batches.location_ref`), REMARKS (truncate+tooltip), AVG PRICE, AVG VAL (both price-gated), Actions (kebab) | — | core |
| STATE badge coloring | `rc-out-table.tsx:80-98` | `getStateClasses()` (badge) + `getRowStateClasses()` (subtle full-row tint) — RC IN uses a dot, not a badge/row-tint; **visually distinct pattern from RC IN** | — | design note |
| Row selection mode | `rc-out-table.tsx:282-283,1109-1119,1186-1202` | Same pattern; **same gap as RC IN**: | | |
| ⚠️ Selection-bar Delete not client-gated | `rc-out-table.tsx:1197-1199` | Same issue as RC IN — visible/enabled regardless of role, relies on server `PRIVILEGED_ROLES` rejection + `errorToast` | `deleteRcOutRecord`/`bulkDeleteRcOut` server gate | flag as a bug, same as RC IN |
| Cell selection + clipboard copy + aggregation | `rc-out-table.tsx:584-709` | Same shared hooks as RC IN; numeric aggregation cols: weight_kg, avg_price, avg_wtd_value | `use-cell-selection`, `use-clipboard-copy`, `use-cell-aggregation` | core |
| Conditional TOTALS footer | `rc-out-table.tsx:1306-1341` | Only when `hasActiveFilters`; Total WT + (if priced) blended Avg Price / Total Value | — | core |
| Virtual scroll (master table, feeding view only) | `rc-out-table.tsx:711-716` | `overscan: 10` (vs RC IN's 15); **Closed Blocks summary table is NOT virtualized** (plain map over `closedBlocks ?? []`) | — | core (feeding); note the closed-blocks table has no virtualization — fine at "one row per closed block" scale but worth knowing |
| `?editBatch=` + `?editView=usage` deep-link | `rc-out-table.tsx:208-238` | Matches by `production_batch` OR `batches.batch_code`; **requires `editView==='usage'` explicitly** (a missing/other value is claimed by the Deliveries table instead) | Blocking/RC Movement "Edit All" on Usage | core — exact contract in §3 |
| ⚠️ **No per-row audit-history viewer** | confirmed via full read of `rc-out/actions.ts` (all 6 exports) — no `getUsageHistory`/`getAuditLogEntry`-equivalent exists | `bulkUpdateUsage` still writes to `audit_logs`/`audit_comments` via the `fn_bulk_update_usage` RPC (the data exists), but **there is no UI anywhere that lets a user view an rc_out row's edit history** — no "View History" button, no dialog | — | **note this explicitly to the user** — it's an existing gap, not something the migration is dropping. Decide up front whether the new module should finally add one (mirroring RC IN's `DeliveryHistoryDialog`) or intentionally leave it out |
| Mobile card layer | `components/rc-out-cards-mobile.tsx` (574 lines; read header + props + first ~120 lines in full, remainder pattern-confirmed against `delivery-cards-mobile.tsx`, which its own header comment says it mirrors) | Feeding/Closed-Blocks segmented control swaps the `MobileCardList` data source; feeding headline ≤6 fields (NO ₱); Filters Sheet reuses the same filter setters; full-table escape hatch (feeding only) | `MobileCardList` | core |
| Price gating (RC OUT, exhaustive) | `rc-out/actions.ts:122,164-184 (fetchRcOutTabData nulls avg_price/avg_wtd_value server-side), 239,250-254 (fetchClosedBlocks nulls total_value/avg_price server-side)`; render gate `rc-out-table.tsx:559-567,1322-1337` | ⚠️ **Different pattern from RC IN**: the table **no longer self-derives via `hasPermission('view:prices')`** — it takes a server-computed `canViewPrices` boolean prop and renders exactly what the server already gated, so render visibility can never drift from the data gate | `@/lib/auth canViewPrices()` (server) | core — reproduce the server-first pattern, it's actually cleaner than RC IN's and worth carrying forward |
| Delete permission gate | `rc-out/actions.ts:11-33,35-55` | `PRIVILEGED_ROLES` server check, same shape as RC IN | — | core |
| **Bulk-usage-input dialog** — create/edit | `bulk-usage-input.tsx:93-112 (init), 414-466 (submit)` | `submitBulkUsage` / `bulkUpdateUsage`; same audit-comment side-channel as RC IN (`auditComments[index]`) | `rc-out/actions.ts` | core |
| — No price columns at all | header row `bulk-usage-input.tsx:530-541`, `types/rc-out.ts:27-45` | `rc_out` has no writable price field (avg_price/avg_wtd_value are DB-computed from the batch's deliveries) — the grid has nothing to gate | — | n/a |
| — Autocomplete: Production Batch, Block (batch_code) w/ block_loc auto-fill, Destination | `bulk-usage-input.tsx:745 (production_batch), 769-774 (batch_code + auto-fill), 824 (destination)` | Selecting a batch auto-populates `block_loc` from `batch.location_ref`, mirroring RC IN | `AutocompletePopover` | core |
| — Batch code → batch_id resolution + skip warning | `bulk-usage-input.tsx:399-412,421-432` | On submit, `batch_code` is resolved to `batch.id`; unmatched rows are **skipped with a per-row toast** (`Batch "X" not found. Skipped.`), not a hard failure | `batches` prop | core |
| — Cell range select+copy+delete + single-cell Ctrl+C | `bulk-usage-input.tsx:246-311,329-339` | Same shared hooks; **explicitly preserves single-cell Ctrl/Cmd+C** outside range mode (a branch the shared `useGridKeyboardNav` hook doesn't cover on its own) | shared hooks | core |
| — Paste | `bulk-usage-input.tsx:341-354` | `useGridPaste`, COLUMN_MAP = DATE/BATCH/BLOCK/WT/PLANT-ETC/REMARKS/BLOCK LOC | `rc-out/paste-utils.ts` | core |
| — `enableEnterAnchor: false` | `bulk-usage-input.tsx:313-327` | Same contract as RC IN | — | core |
| — Blur handling for Radix portals | `bulk-usage-input.tsx:516-528` | `requestAnimationFrame` check before ending edit, so focus landing in a Remarks/Autocomplete popover portal doesn't prematurely commit — RC IN's blur handler (`bulk-delivery-input.tsx:588-594`) is simpler and does **not** have this extra portal check | — | nice — worth carrying the more defensive RC OUT version forward for both grids |

### What RC OUT genuinely shares with RC IN
- Shared hooks: `use-cell-selection`, `use-clipboard-copy`, `use-cell-delete`, `use-cell-aggregation`, `use-grid-keyboard-nav` + `createCoordinateNavResolver`, `use-grid-edit-session`, `use-grid-paste` — all from `@/lib/hooks/*`.
- Shared components: `AutocompletePopover`, `GridCell` (from `@/components/shared/grid/*`).
- Shared `parseExcelDate()` (from `@/lib/paste-utils`, the platform-layer one — each module has its own thin `paste-utils.ts` with a module-specific `COLUMN_MAP`).
- The single global `TableSettingsProvider`/`useTableSettings()` — for font size and (nominally) row height, per the coupling note above.
- `StatusBarProvider`/`useStatusBar()` for the floating aggregation pill.
- **Does NOT share** `DeliverySheetFooter` (RC OUT has no footer strip at all — see the correction above).
- **Does NOT share** any audit-history dialog (RC OUT has none).

---

## 3. The `/inventory` shell

### Wiring
| Piece | File | Role |
|---|---|---|
| `layout.tsx` | `app/(app)/inventory/layout.tsx` | **Thin**, tab-shell-agnostic — just `bg-muted/20` + padded container for ALL `/inventory/*` routes |
| `page.tsx` | `app/(app)/inventory/page.tsx` | Server component for the logs page only. Fetches deliveries (paginated via `fetchAllRows`, year/search-scoped), active (non-CLOSED) batches, all-time distinct suppliers/locations, `canViewPrices()`, `initialSettings` (dead, see §1). Wraps `<InventoryView>` in `<LogsShell>` inside a `<Suspense>` |
| `loading.tsx` | `app/(app)/inventory/loading.tsx` | Route-level skeleton; also covers `blocking`/`rc-movement`/`flecon-bags` by inheritance (no loading file of their own) |
| `components/logs-shell.tsx` | — | Client wrapper owning `InventoryTabProvider` + `Card` frame + `<InventorySheetTabs>` footer — **mounted only for the logs page** |
| `components/inventory-tab-context.tsx` | — | `?tab=deliveries\|usage` is the source of truth (`useSearchParams`+`router.replace`, NOT nuqs); `localStorage['inventory_active_tab']` is a first-load-only fallback that seeds the URL once, post-hydration. Also hosts a `window` listener for `INVENTORY_NAVIGATE_EVENT` (fallback path of Blocking's "Edit All" — see below) |
| `components/sheet-tabs.tsx` | — | Sliding-indicator tab bar, order Deliveries·Usage |
| `components/inventory-view.tsx` | — | Crossfade: both tab containers **always mounted**; inactive one gets `absolute inset-0 invisible opacity-0 pointer-events-none`; 150ms `setTimeout` fade-out→swap→fade-in |
| `components/rc-out-lazy-tab.tsx` | — | `fetchRcOutTabData()` fires on first render of the Usage container (not on page load); `hasFetchedRef` guards StrictMode double-invoke; loading spinner + error/retry UI (`errorToast`) |

### Tab persistence / crossfade
- Default tab = `deliveries`. URL (`?tab=`) wins over localStorage; localStorage only seeds a first-load redirect when no `?tab=` is present.
- Crossfade is pure CSS opacity, no unmount — RC OUT's fetched data survives tab switches (single `RcOutLazyTab` instance stays mounted).

### What else mounts inside `/inventory` — confirmed
**Only Deliveries and Usage.** Blocking (`/inventory/blocking`), RC Movement (`/inventory/rc-movement`), and FLECON Bags (`/inventory/flecon-bags`) are **already standalone routes** with their own `page.tsx` + route-view component, rendered under the thin shared `layout.tsx` — **not** wrapped by `LogsShell`/`InventoryTabProvider`/the tab bar. Confirmed by directory listing (`blocking/page.tsx`, `rc-movement/page.tsx`, `flecon-bags/page.tsx` all exist; `rc-in/` and `rc-out/` have **no** `page.tsx`) and by `inventory/CONTEXT.md`'s explicit route map. This means the requested migration (RC IN/RC OUT → own routes) has **direct precedent already shipped in this codebase** for Blocking/Movement/Bags — same pattern, same seams.

### The exact `?editBatch=` deep-link contract (grep-verified end to end)
Both standalone routes' detail panels navigate identically:
```
/inventory?tab=<deliveries|usage>&search=<batchCode>&year=all&editBatch=<batchCode>&editView=<deliveries|usage>
```
- Built in `blocking/blocking-route-view.tsx:97` and `rc-movement/rc-movement-route-view.tsx:84`, both via a `handleNavigateToBatch` passed as `onNavigateToBatch` into the shared `_shared/blocking-detail-panel.tsx` (`132`, `122`).
- The panel's **fallback path** (no `onNavigateToBatch` — currently dead code since both real callers always pass the prop) instead does `router.push('/inventory?search=...&year=all&editBatch=...')` **without** `tab=`/`editView=` (`blocking-detail-panel.tsx:477`) and fires `emitInventoryNavigate()` so an in-shell host can flip its tab (`inventory-tab-context.tsx:75-83`).
- `editView` is the **discriminator** because both RC IN and RC OUT tables are always mounted on `/inventory` and both read `editBatch` off the URL: RC IN's effect (`delivery-master-table.tsx:1219-1247`) treats a *missing* `editView` as `'deliveries'` (back-compat default); RC OUT's effect (`rc-out-table.tsx:208-238`) requires `editView === 'usage'` exactly, otherwise it leaves both params untouched for the other table to consume. Whichever table matches strips **both** params from the URL.

### What breaks if the tab bar is removed and RC IN/RC OUT become their own routes
1. **`components/navbar.tsx` breadcrumb registry** (`BREADCRUMB_REGISTRY`, lines 66-123) — needs two new `prefix()` entries inserted **before** the existing `prefix('/inventory')` catch-all (line 82), exactly mirroring how `/inventory/blocking`, `/inventory/rc-movement`, `/inventory/flecon-bags` were added at lines 79-81. Order matters (more-specific-first) or the new routes will fall through to the generic "Inventory" breadcrumb.
2. **`components/navbar.tsx` `ICTC_INVENTORY` nav dropdown** (lines 154-159) — `{ name: 'Deliveries', href: '/inventory?tab=deliveries' }` and `{ name: 'Usage', href: '/inventory?tab=usage' }` must be repointed to the new route paths (both desktop dropdown, line ~252, and mobile sheet, line ~371, read from this same array — no duplicate list to forget).
3. **The `?editBatch=`/`?editView=` deep-link** — `blocking-route-view.tsx:97` and `rc-movement-route-view.tsx:84` construct the URL with `tab=`/`editView=`; these must be repointed to the new route + drop `editView` (each new route only has its own table mounted, so the discrimination hack becomes unnecessary) or `editBatch` alone. The RC IN/RC OUT tables' own `editBatch` effects can then be simplified (no more "defer to the other table" logic).
4. **`_shared/blocking-detail-panel.tsx`'s dead fallback path** (line 477) still hardcodes `/inventory?...` — should be updated or removed for correctness even though it's not on the live path today.
5. **`inventory-tab-context.tsx`'s `INVENTORY_NAVIGATE_EVENT` listener** becomes unused if there's no more in-page tab to flip.
6. **`components/notification-bell.tsx:63`** — `` `/inventory?date=${meta.date}` `` for `delivery_created` notifications. **Already dead today** (confirmed: neither `page.tsx` nor `delivery-master-table.tsx` ever reads a `date` param — only `year`/`m`/`search`/`sx`/`sup`/`loc`/`tab`/`editBatch`/`editView`). Worth fixing regardless of the migration, not created by it.
7. **`components/digest/bag-inventory.tsx`**'s `href="/inventory/flecon-bags"` is unaffected (different module).
8. **RC OUT's lazy-load-on-tab-switch optimization** (`rc-out-lazy-tab.tsx`) has no meaning once Usage is its own route — that fetch naturally becomes either a server-side `page.tsx` fetch (matching how RC IN/Cenapro do it) or an on-mount client fetch of its own route, either of which is a **reasonable, expected change**, not a regression, if done deliberately.
9. Filter/year/search state currently silently written to a **shared** `/inventory` URL (`sx`,`sup`,`loc`,`m`,`year`,`search`,`tab`,`editBatch`,`editView` all coexist on one path) would naturally scope to each new route's own URL — simplification, not a breakage.

---

## 4. Server actions contract

### `app/(app)/inventory/rc-in/actions.ts`
| Action | Signature | Enforcement |
|---|---|---|
| `submitBulkDeliveries` | `(rows: DeliveryRow[]) => {success, message?}` | `validateBlockLocsForRows` (format + occupied-by-different-active-batch, all errors collected); upserts batches first; `translateDbError()` on constraint violations; `revalidatePath('/inventory')`. **No role/permission check** — any authenticated (RLS-permitted) user may insert. |
| `updateDelivery` | `(id, data: Partial<DeliveryRow>) => {success, message?}` | Format-validates+normalizes `block_loc` if present; single `.update()`. **No permission check.** ⚠️ **Zero importers repo-wide — dead code.** |
| `bulkUpdateDeliveries` | `(updates: {id, data: DeliveryRow, comment?}[]) => {success, message?}` | Same block-loc validation as submit; upserts batches; **single transactional RPC `fn_bulk_update_deliveries(rows jsonb)`** — all-or-nothing (replaced the old per-row loop so a mid-batch failure no longer leaves partial commits); the `deliveries` AFTER trigger still fires per row for `audit_logs`. **No permission check** (any authenticated user may edit). |
| `bulkDeleteDeliveries` | `(ids: string[]) => {success, message?}` | **Server-side gate**: `getUserRole()` + `PRIVILEGED_ROLES` (Owner/Admin/Dev), independent of the client `hasPermission('delete:all')` hide. |
| `deleteDelivery` | `(id: string) => {success, message?}` | Same `PRIVILEGED_ROLES` gate. |
| `getDeliveryHistory` | `(deliveryId) => {success, current, history}` | Resolves caller role; if `!roleCanViewPrices(role)`, strips `cost_basis` from the current record **and** from every `snapshot`/`diff` in the returned history before it leaves the server. |
| `getAuditLogEntry` | `(auditLogId) => {success, log, delivery}` | Same price-scrub pattern as `getDeliveryHistory`, applied to a single audit log + its linked delivery. Backs `/edit/[auditLogId]`. |
| `getAuditComments` | `(auditLogId) => AuditComment[]` | Joins `profiles` for author display. No gate. |
| `addAuditComment` | `(auditLogId, body) => {success, message?}` | Requires an authenticated user; no role gate. |
| `resolveAuditLog` | `(auditLogId) => {success, resolved}` | `PRIVILEGED_ROLES` gate; toggles `resolved`/`resolved_by`/`resolved_at`; posts a system comment. |
| `requestResolveAuditLog` | `(auditLogId, type: 'resolve'\|'reopen') => {success}` | Any authenticated user; sets `resolve_requested*` fields + system comment. |
| `approveResolveRequest` | `(auditLogId) => {success, resolved}` | `PRIVILEGED_ROLES` gate; must have a pending request; applies it + system comment. |
| `denyResolveRequest` | `(auditLogId, reason) => {success}` | `PRIVILEGED_ROLES` gate; must have a pending request; requires a reason, posted as a system comment. |

All mutation actions call `revalidatePath('/inventory')`; the resolve-family also calls `revalidatePath('/edit/${auditLogId}')`.

### `app/(app)/inventory/rc-out/actions.ts`
| Action | Signature | Enforcement |
|---|---|---|
| `deleteRcOutRecord` | `(id) => {success, message?}` | `PRIVILEGED_ROLES` server gate. |
| `bulkDeleteRcOut` | `(ids) => {success, message?}` | Same gate. |
| `submitBulkUsage` | `(rows: RcOutInput[]) => {success, message?}` | Plain insert. **No permission or block-loc validation of any kind** — unlike RC IN, there is no equivalent of `validateBlockLocsForRows` here. |
| `bulkUpdateUsage` | `(updates: {id, data: RcOutInput, comment?}[]) => {success, message?}` | **Single transactional RPC `fn_bulk_update_usage(rows jsonb)`** — same all-or-nothing pattern as RC IN; `rc_out` has **no** audit trigger of its own, so the RPC explicitly attaches the comment to the record's *latest existing* `audit_log` row (reproducing old per-row glue). No permission check. |
| `fetchRcOutTabData` | `() => {records, batches, destinations, batchOptions, yearOptions, blockLocs, canViewPrices}` | Resolves `canViewPrices()` once; nulls `avg_price`/`avg_wtd_value` on every record **before** returning. Uses the shared `fetchAllRows()` paginator (bypasses PostgREST's 1000-row cap) for the main query and for block-loc/destination distincts, wrapped in a lenient local `fetchAll` that swallows page errors. |
| `fetchClosedBlocks` | `() => {rows, canViewPrices, error?}` | Same price-gate-before-return pattern applied to `total_value`/`avg_price` from `view_rc_out_closed_blocks`. |

Both mutation paths call `revalidatePath('/inventory')`.

### Shared/neutral (used by both, platform layer)
| Action | Signature | Notes |
|---|---|---|
| `getTableSettings` | `(module='rc_in') => RcInTableSettings` | `lib/actions/table-settings.ts` — generic `(user_id, module)` store in `user_table_settings`; merges stored JSON over `DEFAULT_RC_IN_SETTINGS`. Moved out of `rc-in/actions.ts` (a `'use server'` file can't re-export) specifically so the globally-mounted `TableSettingsProvider` doesn't import a tenant module. |
| `saveTableSettings` | `(module, settings: Partial<RcInTableSettings>) => {success, message?}` | Reads-merges-upserts; debounced 500ms by the client provider. |

Both are typed against `RcInTableSettings` today because RC IN is the only module that actually persists settings server-side — this is the concrete mechanism behind the "shared global state" finding in §1/§2: there is exactly **one** `(user_id, 'rc_in')` row, and RC OUT's font-size/row-height controls read and write it too, since the provider is never instantiated with `tableId='rc_out'` anywhere.

---

## 5. Cross-module consumers

Grep-verified against every `from '@/app/(app)/inventory/rc-in...'` / `'.../rc-out...'` import in the repo, outside the modules' own folders.

### RC IN — real code consumers (4 files, all Blocking/audit-related)
| Consumer | Imports | Why |
|---|---|---|
| `app/(app)/edit/[auditLogId]/page.tsx` | `getAuditLogEntry`, `getAuditComments` | Server-fetches the single audit-log-entry page |
| `app/(app)/edit/[auditLogId]/edit-discussion.tsx` | `resolveAuditLog`, `requestResolveAuditLog`, `approveResolveRequest`, `denyResolveRequest`, `addAuditComment`, `getAuditComments` (actions) **+** `DiffDisplay`, `OperationBadge`, `getUserInitials`, `getUserName` (`rc-in/components/audit-shared.tsx`) | The standalone full-discussion page — this is where the entire resolve/reopen/approve/deny workflow UI actually lives, not inside the RC IN table itself |
| `app/(app)/inventory/_shared/blocking-detail-panel.tsx` | `DeliveryHistoryDialog` (`rc-in/components/DeliveryHistoryDialog`) | Blocking's slide-over reuses RC IN's exact info/history dialog for a delivery's read-only view |
| `app/(app)/inventory/_shared/edit-delivery-dialog.tsx` | `bulkUpdateDeliveries` (`rc-in/actions`) | A **third**, simpler single-record edit surface (plain form, not the grid) used only from inside the Blocking detail panel; calls `bulkUpdateDeliveries` with a 1-element array rather than reusing `bulk-delivery-input.tsx` |

### RC OUT — real code consumers
**None outside the `/inventory` shell itself.** The only file outside `rc-out/` that imports from it is `app/(app)/inventory/components/rc-out-lazy-tab.tsx`, which is the shell's own lazy-tab wrapper (`fetchRcOutTabData`, `RcOutTableWrapper`) — not a third-party reuse. Nobody else (Blocking, RC Movement, digest, jarvis) imports RC OUT's dialogs, actions, or components. This is a real asymmetry: **RC IN is reused; RC OUT is not.**

### Data-layer (not code-layer) consumers — worth knowing, lower migration risk
These do **not** import RC IN/RC OUT's React components or server actions, but query the underlying `deliveries`/`rc_out`/`batches` tables (or views over them) **directly** via Supabase, so they're coupled to the **schema**, not the module's code:
- `lib/jarvis/tool-handlers.ts:42-179` — the Jarvis AI chat tool `query_deliveries` does `.from('deliveries')` directly, with its own column allow-list, for natural-language Q&A.
- `lib/digest/queries.ts` — the home dashboard digest reads `rc_out`, `block_loc`, `batch_code` (MTD in/out KG, unpriced-deliveries-in-30-days count, etc.), likely via a blocking-grid-style view.
- `lib/investigator/allowlist.ts:46,57` — allowlists both `rc_out` and `deliveries` tables for whatever "investigator"/review-queue agent tool this backs.
- `app/(app)/review-queue/actions.ts` — has its own **locally-defined** `updateDelivery()` function (name collision with, but unrelated to, RC IN's dead `updateDelivery` export) that writes to `deliveries` directly as part of daily-report ingestion.

**Practical implication for the migration:** a pure UI/component rewrite of RC IN/RC OUT (new table module, same underlying tables/views/columns) is safe for Jarvis, the digest, and the investigator/review-queue tooling — they never call into the module's code. Only changing the **database schema** (table/column/view names or shapes) would ripple into those. The **actual blast radius for a code-level rewrite** is narrow and well-defined: `/edit/[auditLogId]/*`, `_shared/blocking-detail-panel.tsx`, `_shared/edit-delivery-dialog.tsx`, and `navbar.tsx` (breadcrumbs + nav dropdown, per §3).

---

## Summary of the non-obvious findings worth flagging to the implementation agent up front

1. **RC OUT has no year/month footer strip today** — the task brief's framing that it "shares `DeliverySheetFooter`" with RC IN is incorrect; giving RC OUT that UX is a deliberate UX addition, not a port.
2. **Font size / row height settings are a single global state shared by RC IN and RC OUT** (one `TableSettingsProvider` mounted at the app root with a hardcoded `tableId='rc_in'`). Decide on purpose whether the new module keeps this coupling.
3. **RC OUT's "Row Height" slider is already dead** (`setRowHeight` is a no-op shim) — don't port it as functioning.
4. **`initialSettings` fetched server-side in `page.tsx` never reaches the table** — confirmed dead prop-drilling, three layers deep.
5. **`updateDelivery(id, data)` in `rc-in/actions.ts` has zero importers** — dead code, not an API to preserve.
6. **RC OUT has no per-row audit-history viewer at all** — not a migration regression, an existing gap; decide whether to finally add one.
7. **Selection-bar bulk Delete is not client-permission-gated in either table** (context-menu Delete is; the selection-bar one isn't) — a real, reproducible inconsistency worth fixing rather than faithfully porting.
8. **RC IN is reused by Blocking/`/edit/[auditLogId]`; RC OUT is reused by nobody** — the migration's blast radius outside the two modules is asymmetric.
9. This codebase already executed the exact migration shape being proposed (tabs → standalone routes) for Blocking/RC Movement/FLECON Bags — `navbar.tsx`'s breadcrumb registry and nav dropdown, plus the `onNavigateToBatch`/`editView` deep-link seam, are the proven template to copy for RC IN/RC OUT.
