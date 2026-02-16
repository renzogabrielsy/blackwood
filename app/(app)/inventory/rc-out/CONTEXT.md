# RC OUT Module — Inventory Usage

## Purpose
Tracks raw charcoal consumption/depletion from batches. Excel-like grid input with infinite scroll table, computed pricing columns, and batch code resolution.

## Files
| File | Lines | Role |
|------|-------|------|
| `page.tsx` | ~5 | Redirect stub — redirects to `/inventory`. Data fetching moved to `fetchRcOutTabData()` server action (lazy-loaded client-side) |
| `actions.ts` | ~260 | 7 server actions: `getRcOutRecords`, `deleteRcOutRecord`, `bulkDeleteRcOut`, `createRcOutRecord`, `submitBulkUsage`, `bulkUpdateUsage`, `fetchRcOutTabData` |
| `bulk-usage-input.tsx` | ~1220 | Client grid editor — keyboard nav, paste, autocomplete, batch resolution, cell range selection + copy + delete |
| `components/rc-out-table-wrapper.tsx` | ~36 | Client wrapper — `dynamic()` with `ssr: false` to avoid Radix hydration mismatch |
| `components/rc-out-table.tsx` | ~890 | Client data table — virtual scroll, infinite scroll, filtering, bulk ops, cell selection + clipboard copy |
| `paste-utils.ts` | 30 | Column mapping and cell value cleaning |

## Data
- **Table:** `rc_out` — `id`, `transaction_date`, `batch_id` (FK→batches), `production_batch`, `destination`, `weight_kg`, `block_loc`, `remarks`, `created_at`
- **Computed columns:** `rc_out_avg_price` (aliased as `avg_price`), `rc_out_avg_wtd_value` (aliased as `avg_wtd_value`) — PostgreSQL generated columns, NOT calculated in JS
- **Joins:** `batches(batch_code)` for display
- **Types:** `RcOutRow`, `RcOutInput`, `InputRcOutRow` (defined locally in actions/components)

## Key Behaviors
- **Lazy-loaded via tab context:** RC OUT data is NOT fetched server-side on initial page load. Instead, `../components/rc-out-lazy-tab.tsx` calls `fetchRcOutTabData()` on first render (when user switches to Usage tab). Once loaded, the component stays mounted via CSS `hidden` class — subsequent tab switches are instant with full state preservation.
- **`fetchRcOutTabData()` server action:** Returns `{ records, batches, destinations, productionBatches, year, month }` for the lazy tab. Uses current month as default date range.
- **Batch code → batch_id resolution:** User selects by `batch_code` (text); module resolves to `batch.id` (UUID) before insert. Skipped rows toast a warning.
- **Infinite scroll (not month-based):** Initial load = 40 records, subsequent = 15 per trigger. `hasMore` set to false when batch returns < 15.
- **Month + year filtering:** `year` and `month` are internal React state (not URL params), since RC OUT is lazy-loaded in a tab and `router.push()` would navigate the parent page. Both month and year changes trigger a data refetch via `getRcOutRecords()` server action. Footer behavior matches RC IN: `monthsDisabled` when year='all', auto-month logic resets to January on year change from 'all'.
- **Search (internal state, not URL-driven):** `searchTerm` and `searchField` are internal React state, matching the year/month approach. Typing triggers a 300ms debounced refetch via `getRcOutRecords()` server action -- no `router.push()` or URL params involved. This prevents search from leaking into the parent Deliveries tab URL. The search field selector (`all`, `batch_code`, `production_batch`, `destination`, `block_loc`, `remarks`) is also internal state. The component has no dependency on `next/navigation`.
- **Computed DB columns:** `avg_price` and `avg_wtd_value` are DB-computed — never calculated client-side. Permission-gated behind `view:prices`.
- **Audit trail:** Updates use `set_audit_comment()` RPC + `audit_comments` posting, same pattern as RC IN.
- **Auto-fill block_loc:** Selecting a batch auto-populates `block_loc` from `batch.location_ref`.
- **Cell selection + clipboard copy (master table):** `useCellSelection` and `useClipboardCopy` hooks enable Excel-like rectangular cell selection (click-drag, Shift+Arrow, Ctrl+A) and Ctrl+C copy as TSV. Mutually exclusive with row selection mode. Selection count is pushed to `StatusBarProvider` context via `useStatusBar().setCellSelectionCount()` and displayed in the unified `FloatingStatusBar`. Clears on data/sorting changes, clicking outside the scroll container, or pressing Escape.
- **Cell selection + copy + delete (bulk input):** All 3 hooks (`useCellSelection`, `useClipboardCopy`, `useCellDelete`) with two-mode system: single-cell edit (click without drag) vs range selection (click+drag, Shift+Arrow). Range mode: Ctrl+C copies as TSV, Backspace/Delete clears all cells. Non-shift nav exits range. Printable char exits range and edits anchor cell. Selection count pushed to `StatusBarProvider` context (same as master table).
- **Glass & Motion:** Table header/footer use frosted glass (`bg-muted/90 backdrop-blur-sm`). Row hover uses `transition-all duration-150`. Empty state uses `animate-fade-up`. Selection bar uses `animate-fade-up`. Bulk input headers use `bg-muted/90 backdrop-blur-sm`.

### Batch Status Trigger
- `fn_process_blackwood_usage` fires on `rc_out` INSERT/UPDATE/DELETE
- Updates `batches.status` and `batches.current_weight` automatically
- INSERT: Depletes weight, sets status (CLOSED > SUNDRYING > IN-USE > STORED)
- DELETE: Adds back weight, recalculates status from remaining records
- UPDATE: Adjusts weight delta, recalculates status; handles batch_id changes
- Note: FEED location is indicated by WHSE column in RC IN (derived from block_loc), not by batch status

## Dependencies
- `@/lib/paste-utils` — shares `parseExcelDate()` for paste operations
- `../../components/DeliverySheetFooter` — shared footer with sliding month/year indicators (at `app/(app)/inventory/components/`)
- `@/components/providers/auth-context` — `hasPermission('view:prices')` gates price columns
- `@/components/providers/table-settings` — fontSize, rowHeight settings
- `@/components/providers/status-bar-context` — `useStatusBar()` for pushing cell selection count to FloatingStatusBar
- `@/lib/hooks/use-cell-selection` — rectangular cell selection with drag, keyboard, and auto-scroll
- `@/lib/hooks/use-clipboard-copy` — Ctrl+C copies selected cells as TSV
- `@/lib/hooks/use-cell-delete` — Backspace/Delete clears multi-cell selection (bulk input only)
- `@tanstack/react-table`, `@tanstack/react-virtual`, `date-fns`, `sonner`

## See Also
- [RC IN](../rc-in/CONTEXT.md) — shares footer component and paste utilities
- [Auth Provider](../../../../components/providers/AUTH.md) — permission model for price visibility
- [Navbar](../../../../components/NAVBAR.md) — breadcrumb registration
