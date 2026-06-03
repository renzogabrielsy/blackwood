# RC OUT Module — Inventory Usage

## Purpose
Tracks raw charcoal consumption/depletion from batches. Excel-like grid input with virtual scroll table, computed pricing columns, and batch code resolution. All data loaded upfront with client-side filtering.

> **Domain Module (Charcoal Tenant):** This module is domain-specific — it belongs to the charcoal plant operations layer, not the platform layer. Business logic, schema references, and terminology here are intentionally charcoal-specific. When adapters are built for the dashboard widgets, they will extract data from these tables — but widgets themselves will never import from this module.

## Files
| File | Lines | Role |
|------|-------|------|
| `page.tsx` | ~5 | Redirect stub — redirects to `/inventory`. Data fetching moved to `fetchRcOutTabData()` server action (lazy-loaded client-side) |
| `actions.ts` | ~280 | Server actions: `deleteRcOutRecord`, `bulkDeleteRcOut`, `createRcOutRecord`, `submitBulkUsage`, `bulkUpdateUsage`, `fetchRcOutTabData` |
| `bulk-usage-input.tsx` | ~1220 | Client grid editor — keyboard nav, paste, autocomplete, batch resolution, cell range selection + copy + delete |
| `components/rc-out-table-wrapper.tsx` | ~36 | Client wrapper — `dynamic()` with `ssr: false` to avoid Radix hydration mismatch |
| `components/rc-out-table.tsx` | ~1180 | Client data table — virtual scroll, 5 client-side filters (Batch/Year/State/Plant/Block Loc), cell selection + clipboard copy |
| `paste-utils.ts` | 30 | Column mapping and cell value cleaning |

## Data
- **Table:** `rc_out` — `id`, `transaction_date`, `batch_id` (FK→batches), `production_batch`, `destination`, `weight_kg`, `block_loc`, `remarks`, `created_at`
- **Computed columns:** `rc_out_avg_price` (aliased as `avg_price`), `rc_out_avg_wtd_value` (aliased as `avg_wtd_value`) — PostgreSQL generated columns, NOT calculated in JS
- **Joins:** `batches(batch_code, status, location_ref)` for display, STATE column, and block_loc fallback
- **Types:** `RcOutRow` (includes `batches?: { batch_code: string; status: string; location_ref: string }`), `RcOutInput`, `InputRcOutRow` (defined locally in actions/components)

## Key Behaviors
- **Lazy-loaded via tab context:** RC OUT data is NOT fetched server-side on initial page load. Instead, `../components/rc-out-lazy-tab.tsx` calls `fetchRcOutTabData()` on first render (when user switches to Usage tab). Once loaded, the component stays mounted via CSS `hidden` class — subsequent tab switches are instant with full state preservation.
- **`fetchRcOutTabData()` server action:** Returns `{ records, batches, destinations, batchOptions, yearOptions, blockLocs }`. All `rc_out` records are loaded upfront (no date scoping). `batchOptions` is `string[]` of plain production_batch codes (no year annotations). `yearOptions` is `number[]` of distinct years from `rc_out.transaction_date`, descending. `blockLocs` is the union of `rc_out.block_loc` and `batches.location_ref`. **IMPORTANT:** Filter queries (destinations, production_batch, block_loc) use paginated `.range()` loops (1000-row chunks) to bypass PostgREST's server-side `max_rows` cap of 1000.
- **Batch code → batch_id resolution:** User selects by `batch_code` (text); module resolves to `batch.id` (UUID) before insert. Skipped rows toast a warning.
- **All data loaded upfront:** No infinite scroll or pagination. All records fetched in one `fetchRcOutTabData()` call. Virtual scroll handles rendering performance.
- **Client-side search (150ms debounce):** `searchTerm` is internal React state. Typing triggers a 150ms debounced client-side filter across all fields (production_batch, destination, block_loc, remarks, batch_code, transaction_date). No server calls for search.
- **5 client-side filters (toolbar order: Search | Batch | Year | State | Plant/Etc | Block Loc | Clear):**
  - **BATCH** (inclusion model): Popover + Command + Checkbox. `batchOptions` prop is `string[]` of plain production_batch codes, sorted by calendar month order (January first, December last) via `MONTH_ORDER` lookup in `fetchRcOutTabData()`.
  - **YEAR** (inclusion model): Popover + Checkbox (no Command search — only ~3 values). `yearOptions` prop is `number[]`. Empty set = show all years.
  - **STATE** (exclusion model): Popover + Checkbox with Show All / Hide All. `STATE_OPTIONS = ['IN-USE', 'SUNDRYING', 'SUNDRIED', 'CLOSED']` (STORED removed — not a valid operational state for RC OUT filtering). Checked = visible, unchecked = excluded. Default: CLOSED excluded. Uses colored state badges. Clear resets to default (CLOSED excluded), not empty.
  - **PLANT/ETC** (inclusion model): Popover + Command + Checkbox.
  - **BLOCK LOC** (inclusion model): Popover + Command + Checkbox. Options are union of rc_out.block_loc + batches.location_ref.
  - All filter states are `Set<string>` or `Set<number>`. Client-side `filteredData` useMemo applies all filters in order: STATE > YEAR > BATCH > PLANT/ETC > BLOCK LOC > search.
- **STATE column:** Displays batch status as a colored badge after the DATE column, with `getStateClasses()` for badge colors (IN-USE=blue, CLOSED=red, SUNDRYING=amber, SUNDRIED=muted-amber, default=muted) and `getRowStateClasses()` for subtle row tinting.
- **BLOCK LOC column fallback:** Displays `rc_out.block_loc` with fallback to `batches.location_ref` when block_loc is empty. Same fallback applied in `getCellValue()` for clipboard copy and in `filteredData` for the Block Loc filter.
- **Conditional TOTALS footer:** The table footer with TOTALS row only renders when `hasActiveFilters` is true (STATE exclusion active with partial selection, or any inclusion filter active). Uses `animate-slide-up` class for entrance. Totals are computed from `filteredData`, not `allData`.
- **Remarks column (master table):** Shows truncated inline text (`max-w-[120px] truncate`) with Tooltip on hover. Column width 120px.
- **Bulk input column order:** DATE | BATCH | BLOCK | WT | PLANT/ETC | REMARKS | BLOCK LOC. Remarks is a plain text input cell (not a popover/icon pattern) — same inline editing as all other columns. `paste-utils.ts` COLUMN_MAP reflects this order.
- **Computed DB columns:** `avg_price` and `avg_wtd_value` are DB-computed — never calculated client-side. Permission-gated behind `view:prices`.
- **Audit trail:** Updates use `set_audit_comment()` RPC + `audit_comments` posting, same pattern as RC IN.
- **Auto-fill block_loc:** Selecting a batch auto-populates `block_loc` from `batch.location_ref`.
- **Data refresh mechanism:** After every add/edit/delete operation, the table automatically refetches all data via `onRefresh` prop (calls `fetchRcOutTabData()` again from `RcOutLazyTab`). A manual refresh button (`RefreshCw` icon) in the toolbar provides a fallback. The `refreshing` state drives a spinner on the button. The `onRefresh` prop is threaded through `RcOutLazyTab` -> `RcOutTableWrapper` -> `RcOutTable`. Server actions still call `revalidatePath` as before; the client-side refetch ensures the lazy-loaded tab picks up changes immediately.
- **Cell selection + clipboard copy (master table):** `useCellSelection` and `useClipboardCopy` hooks enable Excel-like rectangular cell selection (click-drag, Shift+Arrow, Ctrl+A) and Ctrl+C copy as TSV. Mutually exclusive with row selection mode. Selection count and `useCellAggregation` aggregates are pushed to `StatusBarProvider` context via `useStatusBar()` and displayed in the unified `FloatingStatusBar` with a Google Sheets-like auto-calculate dropdown (SUM/AVERAGE/COUNT/MIN/MAX). Numeric columns for aggregation: weight_kg, avg_price, avg_wtd_value. Clears on data/sorting changes, clicking outside the scroll container, or pressing Escape.
- **Cell selection + copy + delete (bulk input):** All 3 hooks (`useCellSelection`, `useClipboardCopy`, `useCellDelete`) plus `useCellAggregation` with two-mode system: single-cell edit (click without drag) vs range selection (click+drag, Shift+Arrow). Range mode: Ctrl+C copies as TSV, Backspace/Delete clears all cells. Non-shift nav exits range. Printable char exits range and edits anchor cell. Selection count and aggregates pushed to `StatusBarProvider` context (same as master table). Numeric column for aggregation: weight_kg.
- **editBatch deep-link:** When URL contains `?editBatch=<batch_code>`, the table auto-selects all matching records (by `production_batch` or `batches.batch_code`) and opens the bulk edit dialog. Used by the Blocking detail panel's "Edit All" button on the Usage History section. The param is cleaned from the URL after triggering.
- **Glass & Motion:** Table header/footer use frosted glass (`bg-muted/90 backdrop-blur-sm`). Row hover uses `transition-all duration-150`. Empty state uses `animate-fade-up`. Selection bar uses `animate-fade-up`. Bulk input headers use `bg-muted/90 backdrop-blur-sm`.

### Batch Status Trigger
- `fn_process_blackwood_usage` fires on `rc_out` INSERT/UPDATE/DELETE
- Updates `batches.status` and `batches.current_weight` automatically
- INSERT: Depletes weight, sets status (CLOSED > SUNDRYING > IN-USE > SUNDRIED > STORED)
- DELETE: Adds back weight, recalculates status from remaining records
- UPDATE: Adjusts weight delta, recalculates status; handles batch_id changes
- Note: FEED location is indicated by WHSE column in RC IN (derived from block_loc), not by batch status

## Dependencies
- `@/lib/paste-utils` — shares `parseExcelDate()` for paste operations
- `@/components/providers/auth-context` — `hasPermission('view:prices')` gates price columns
- `@/components/providers/table-settings` — fontSize, rowHeight settings
- `@/components/providers/status-bar-context` — `useStatusBar()` for pushing cell selection count and aggregates to FloatingStatusBar
- `@/lib/hooks/use-cell-selection` — rectangular cell selection with drag, keyboard, and auto-scroll
- `@/lib/hooks/use-clipboard-copy` — Ctrl+C copies selected cells as TSV
- `@/lib/hooks/use-cell-delete` — Backspace/Delete clears multi-cell selection (bulk input only)
- `@/lib/hooks/use-cell-aggregation` — computes SUM/AVERAGE/COUNT/MIN/MAX over selected numeric cells for status bar display
- `@/components/ui/command` — searchable multi-select for inclusion-model filters
- `@/components/ui/checkbox` — checkboxes in filter popovers
- `@tanstack/react-table`, `@tanstack/react-virtual`, `sonner`

## See Also
- [RC IN](../rc-in/CONTEXT.md) — shares paste utilities
- [RC Movement](../rc-movement/CONTEXT.md) — consumes `rc_out` (weight + transaction_date → `view_rc_movement`; production_batch → matrix "Batch" column)
- [Blocking](../blocking/CONTEXT.md) — warehouse grid visualization; usage data feeds balance calculations
- [Auth Provider](../../../../components/providers/AUTH.md) — permission model for price visibility
- [Navbar](../../../../components/NAVBAR.md) — breadcrumb registration
