# RC IN Module — Delivery Master Log

## Purpose
Captures incoming raw charcoal deliveries. Dense Excel-like grid with paste support, keyboard navigation, audit trails, and role-based cost visibility.

## Files
| File | Lines | Role |
|------|-------|------|
| `page.tsx` | ~5 | Redirect stub — redirects to `/inventory`. Data fetching moved to `../page.tsx` (parent inventory page) |
| `actions.ts` | 617 | 9 server actions: `submitBulkDeliveries`, `bulkUpdateDeliveries`, `bulkDeleteDeliveries`, `deleteDelivery`, `updateDelivery`, `getDeliveryHistory`, `getAuditComments`, `getAuditLogEntry`, `addAuditComment` + 4 resolve actions |
| `bulk-delivery-input.tsx` | ~1420 | Client grid editor — paste, keyboard nav, autocomplete, edit tracking, cell range selection + copy + delete |
| `components/delivery-master-table-wrapper.tsx` | ~31 | Client wrapper — `dynamic()` with `ssr: false` to avoid Radix hydration mismatch |
| `delivery-master-table.tsx` | ~1570 | Client data table — virtual scroll, header bar filters, column visibility, year/month controls, cell selection + clipboard copy |
| `paste-utils.ts` | 47 | Column mapping and cell value cleaning (imports `parseExcelDate` from `@/lib/paste-utils`) |
| `components/DeliveryHistoryDialog.tsx` | 561 | Delivery history + audit trail dialog |
| `components/audit-shared.tsx` | 87 | Shared audit display utilities |
| `edit/[auditLogId]/page.tsx` | 30 | Server component for edit discussion page |
| `edit/[auditLogId]/edit-discussion.tsx` | 452 | Resolve/request workflows, comments, diff display |
| `error.tsx` | 25 | Error boundary |
| `loading.tsx` | 47 | Loading skeleton |

## Data
- **Tables:** `deliveries`, `batches` (upserted), `audit_logs`, `audit_comments`, `profiles`
- **Views:** `view_rc_in_master`
- **RPC:** `set_audit_comment(comment text)` — sets comment context before update trigger fires
- **Types:** `DeliveryRow`, `InputDeliveryRow`, `AuditLogRow`, `AuditComment` (in `types/rc-in.ts`)

## Key Behaviors
- **Batch upsert-first:** Dedup by `batch_code` via JS Map, upsert batches before inserting deliveries
- **Cost scrubbing:** Production role users have `cost_basis` stripped from history snapshots/diffs in `getDeliveryHistory()` and `getAuditLogEntry()`
- **Year-based pagination:** URL param `?year=2024`; month filtering done client-side via string slicing on `YYYY-MM-DD` (avoids timezone issues). **Defaults to current year and current month on initial load** (no year param = current year via `new Date().getFullYear()`; month state initializes to `new Date().getMonth()`). When a header bar filter (STATE, WHSE, Supplier, LOC) is activated, the year auto-switches to "All Years" via `activateAllYearsIfNeeded()` to ensure the filter operates on the full dataset.
- **Header bar filters:** Client-side WHSE, STATE, LOC, and Supplier multi-select checkbox filters in the toolbar (order: Search, WHSE, STATE, LOC, SUPPLIER, Clear). **Two filter models are used:** STATE/WHSE use an **exclusion set pattern** (all included by default; unchecking excludes); Supplier/LOC use an **inclusion set pattern** (empty = show all; checking includes only selected values). WHSE/STATE use `Popover`+`Checkbox` labels with Select All / Deselect All buttons. Supplier/LOC use `Popover`+`Command`+`Checkbox` (searchable) with a "Clear" link (shown only when selections exist). Filters persist with search — search only overrides the FooterBar month filter, not header filters. Each active filter shows a count label (e.g., `State (3)` for exclusion remaining, `Supplier (2)` for inclusion selected) and an inline X button to clear. WHSE options are hardcoded (`WHSE A-D`, `FEED`). LOC/Supplier values come from server-fetched `allLocations`/`allSuppliers` props (all distinct values from entire DB, not scoped by year). LOC options use natural sort (`localeCompare` with `numeric: true`).
- **STATE filter default:** On fresh page load (no `sx` URL param), the STATE filter defaults to excluding CLOSED so users see only active inventory (STORED, IN-USE, SUNDRYING, SUNDRIED). Users can manually re-enable CLOSED via the STATE filter popover. Uses a URL sentinel value `sx=_all` to distinguish "user explicitly cleared the filter" from "fresh load (apply default)". This prevents the default from being re-applied after Suspense remounts when the user has intentionally shown all states.
- **Data fetching moved to parent:** RC IN data is fetched server-side in `../page.tsx` and passed to `DeliveryMasterTableWrapper` via `InventoryView`. The `rc-in/page.tsx` is now a redirect stub to `/inventory`.
- **Search always uses all fields:** The search field dropdown was removed. Server-side search in `../page.tsx` always queries across supplier, batch_code, truck_plate, and block_loc.
- **Cost column visibility:** Both header and body cells in `BulkInputRow` are gated behind `canViewPrices` prop (`hasPermission('view:prices')`), ensuring column count matches for all roles in the edit dialog
- **Paste-grid:** Tab-separated clipboard → Excel serial date parsing, currency stripping, auto-row expansion
- **Virtual scroll:** `@tanstack/react-virtual` with `overscan: 15`, respects user's `rowHeight` setting
- **Audit resolve workflow:** Employees request resolve/reopen; Admins directly toggle or approve/deny requests; system messages auto-posted to `audit_comments`
- **Keyboard nav:** Arrow keys, Tab, Enter, F2 (edit), Escape (revert), printable chars (type-over)
- **Cell selection + clipboard copy (master table):** `useCellSelection` and `useClipboardCopy` hooks enable rectangular cell selection (click-drag, Shift+click, Shift+Arrow, Ctrl+A) and Ctrl+C copy as TSV. Mutually exclusive with row selection mode (`enabled: !selectionMode`). Selection count is pushed to `StatusBarProvider` context via `useStatusBar().setCellSelectionCount()` and displayed in the unified `FloatingStatusBar`. Clears on filteredData/sorting changes, clicking outside the scroll container, or pressing Escape.
- **Cell selection + copy + delete (bulk input):** All 3 hooks (`useCellSelection`, `useClipboardCopy`, `useCellDelete`) with two-mode system: single-cell edit (click without drag) vs range selection (click+drag, Shift+Arrow). Range mode: Ctrl+C copies as TSV, Backspace/Delete clears all cells. Non-shift nav exits range. Printable char exits range and edits anchor cell. Selection count pushed to `StatusBarProvider` context (same as master table).
- **Glass & Motion:** Table header/footer use frosted glass (`bg-muted/90 backdrop-blur-sm`). Row hover uses `transition-all duration-150`. Empty state uses `animate-fade-up`. Loading overlay uses `animate-blur-in`. Selection bar uses `animate-fade-up`. Bulk input headers use `bg-muted/90 backdrop-blur-sm`. DeliveryHistoryDialog uses `stagger-fast` on field cards, `stagger-children` on activity feed.

### Filter Interaction Model
- **Server-side:** `year` (URL param) + `search` (URL param, always "all fields")
- **Client-side:** HeaderBar filters (STATE, WHSE, Supplier, LOC) + FooterBar month filter
- **Execution order in `filteredData` useMemo:**
  1. Apply HeaderBar filters — ALWAYS (even with active search)
  2. If search active: skip month filter, return
  3. If no search: apply FooterBar month filter, return
- Active filters show a subtle `border-primary bg-primary/5` highlight on their trigger button
- Each active filter has an inline X button to clear that filter's exclusion set; a global "Clear" button appears when any filter is active
- **Filter models:**
  - **STATE/WHSE (exclusion):** Filter state is `Set<string>` of excluded values. Empty set = all included. Toggling a checkbox adds/removes from the exclusion set. Button label shows remaining count (e.g., `State (3)` means 3 of 5 states included). Status bar shows `STATE (-2)` meaning 2 excluded. **"Deselect All" is UI-only** (sets all values to excluded in state but does NOT sync to URL or trigger year switch). When all values are excluded (`size >= total`), `filteredData` treats it as "no filter" (shows all). This prevents "Deselect All" from hiding everything. Exception: STATE filter initializes with `['CLOSED']` excluded by default on fresh load (see "STATE filter default" above).
  - **Supplier/LOC (inclusion):** Filter state is `Set<string>` of included values. Empty set = show all (no filter active). Non-empty set = show ONLY those values. Button label shows selected count (e.g., `Supplier (2)` means 2 selected). Popover shows a "Clear" link only when selections exist (no Select All / Deselect All). Values come from `allSuppliers`/`allLocations` props fetched from the entire DB in `page.tsx`.
- **Auto All Years + Pre-filter Date Restore:** When any filter becomes active (exclusion set non-empty for STATE/WHSE, or inclusion set non-empty for Supplier/LOC) and year is not already `all`, the year automatically switches to `all` (via `handleYearChange`) to ensure the filter operates on the full dataset. The user's previous year+month is saved in `preFilterDate` ref. When all filters are cleared (individually or via Clear All), the saved year+month is restored automatically via `maybeRestoreDate()`. For STATE/WHSE, full exclusion (`size >= total`) is treated as inactive for restore purposes.
- **Filter state URL persistence:** Filter state and month selection are silently synced to URL params via `window.history.replaceState` (no Next.js navigation or server round-trip). **URL params:** `sx` (STATE exclusion), `wx` (WHSE exclusion), `sup` (Supplier inclusion), `loc` (LOC inclusion), `m` (month). Comma-separated values (e.g., `?sx=CLOSED,SUNDRYING`, `?sup=SUPPLIER_A,SUPPLIER_B`). Special sentinel `sx=_all` means "user explicitly cleared the STATE filter" (prevents default re-application). Absent `sx` param = fresh load (default exclusion of CLOSED). Legacy params `supx`/`lx` are cleaned up when encountered. This ensures filter state survives Suspense remounts triggered by `loading.tsx` when `router.replace` changes the `year` param. On remount, all filter `useState` initializers read from `searchParams`. The `handleYearChange` function reads from `window.location.search` (not React's `searchParams`) to include the silently-synced params in the real navigation URL.

### Column Visibility (Columns Button)
- Toolbar **Columns** button (`SlidersHorizontal` icon, between Select and Add Delivery) opens a popover titled "Visible Columns" listing all hideable columns
- Uses `hiddenColumns` state (`Set<string>`) persisted to `localStorage` key `rc-in-hidden-columns`
- Checked = visible, unchecked = hidden. "Show All" button resets when any columns are hidden.
- Role-aware: PHP/KG and PHP TTL only appear in the list if `hasPermission('view:prices')`
- Actions column is never hideable
- Footer dynamically adjusts: `colSpan` for TOTALS label is computed from visible prefix columns (`visiblePrefixCount`), and each footer cell conditionally renders based on `hiddenColumns`

### Footer Compact Number Formatting
- `formatCompact()` utility formats large numbers with suffix: `k` (thousands), `m` (millions), `b` (billions), `t` (trillions)
- Applied to WT total, lab weighted averages, PHP/KG weighted average, and PHP TTL total in the footer row

### STATE Column (Derived)
- STATE is `batches.status`, managed by the `fn_process_blackwood_usage` trigger on `rc_out`
- Values: STORED (default), IN-USE, CLOSED, SUNDRYING
- Color-coded badges in both master table and bulk input with `shadow-sm ring-1` enhancement (IN-USE: blue ring, CLOSED: red ring, SUNDRYING: amber ring; STORED has no ring)
- **Row highlighting:** Master table rows are tinted by state via `getRowStateClasses()` (IN-USE: blue-50, CLOSED: red-50, SUNDRYING: amber-50; STORED: no tint). Class ordering: state tint < selection (`bg-primary/5`) < hover (`hover:bg-muted/50`)
- Trigger handles INSERT/UPDATE/DELETE on rc_out to keep status accurate
- RC IN batch upsert does NOT set status (let DB default + trigger manage it)
- Note: FEED location is indicated by WHSE column (derived from block_loc starting with 'F'), not status

## Dependencies
- `@/lib/rc-utils.ts` — `calculateWhse()` derives warehouse from block_loc first letter
- `@/lib/field-labels.ts` — `getFieldLabel()`, `formatFieldValue()`, `flattenLabResultsDiff()`
- `@/lib/auth.ts` — `getUserRole()` (includes dev override check)
- `@/components/providers/auth-context` — `useAuth()`, `hasPermission('view:prices')`
- `@/components/providers/table-settings` — `useTableSettings()` (fontSize, rowHeight)
- `@/components/providers/status-bar-context` — `useStatusBar()` for pushing cell selection count to FloatingStatusBar
- `@/lib/hooks/use-cell-selection` — rectangular cell selection with drag, keyboard, and auto-scroll
- `@/lib/hooks/use-clipboard-copy` — Ctrl+C copies selected cells as TSV
- `@/lib/hooks/use-cell-delete` — Backspace/Delete clears multi-cell selection (bulk input only)
- `@tanstack/react-table`, `@tanstack/react-virtual`, `date-fns`, `sonner`

## See Also
- [RC OUT](../rc-out/CONTEXT.md) — shares `DeliverySheetFooter` (at `../components/DeliverySheetFooter`) and `parseExcelDate()` (at `@/lib/paste-utils`)
- [Auth Provider](../../../../components/providers/AUTH.md) — permission model for cost visibility
- [Navbar](../../../../components/NAVBAR.md) — breadcrumb registration
