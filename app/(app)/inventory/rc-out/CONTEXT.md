# RC OUT Module — Inventory Usage

## Purpose
Tracks raw charcoal consumption/depletion from batches. Excel-like grid input with virtual scroll table, computed pricing columns, and batch code resolution. All data loaded upfront with client-side filtering.

> **Domain Module (Charcoal Tenant):** This module is domain-specific — it belongs to the charcoal plant operations layer, not the platform layer. Business logic, schema references, and terminology here are intentionally charcoal-specific. When adapters are built for the dashboard widgets, they will extract data from these tables — but widgets themselves will never import from this module.

## Files
| File | Lines | Role |
|------|-------|------|
| _(no `page.tsx`)_ | — | RC OUT is **not** its own route — it renders as the Usage tab of `/inventory`, lazy-loaded via `fetchRcOutTabData()` (see Key Behaviors). |
| `actions.ts` | ~200 | Server actions: `deleteRcOutRecord`, `bulkDeleteRcOut`, `submitBulkUsage`, `bulkUpdateUsage`, `fetchRcOutTabData`, `fetchClosedBlocks`. **`deleteRcOutRecord` + `bulkDeleteRcOut` enforce a SERVER-SIDE permission gate** (getUserRole() + `PRIVILEGED_ROLES` = Owner/Admin/Dev, mirroring the client `hasPermission('delete:all')`) — re-checked server-side, not just UI-hidden. **`bulkUpdateUsage` is TRANSACTIONAL (PERF-3):** it no longer loops per-row (the old set_audit_comment → update → audit_logs lookup → audit_comments insert × N left earlier rows committed on a mid-loop failure). It calls **one RPC `fn_bulk_update_usage(rows jsonb)`** (`{id, data, comment}[]`) applying every partial update in a SINGLE transaction (all-or-nothing). `rc_out` has NO audit trigger, so the RPC reproduces the exact old glue: set the GUC, partial-update the row, then attach the edit remark to the record's LATEST existing audit_log — behaviour unchanged. |
| `bulk-usage-input.tsx` | ~1220 | Client grid editor — keyboard nav, paste, autocomplete, batch resolution, cell range selection + copy + delete |
| `components/rc-out-table-wrapper.tsx` | ~36 | Client wrapper — `dynamic()` with `ssr: false` to avoid Radix hydration mismatch |
| `components/rc-out-table.tsx` | ~1290 | Client data table — virtual scroll, 5 client-side filters (Batch/Year/State/Plant/Block Loc), cell selection + clipboard copy. Hosts the "Closed Blocks" summary toggle (swaps the feeding table for a one-row-per-closed-block summary from `view_rc_out_closed_blocks`) |
| `paste-utils.ts` | 30 | Column mapping and cell value cleaning |

## Data
- **Table:** `rc_out` — `id`, `transaction_date`, `batch_id` (FK→batches), `production_batch`, `destination`, `weight_kg`, `block_loc`, `remarks`, `created_at`
- **Computed columns:** `rc_out_avg_price` (aliased as `avg_price`), `rc_out_avg_wtd_value` (aliased as `avg_wtd_value`) — PostgreSQL generated columns, NOT calculated in JS

  > **NOTE on price source:** `rc_out` has **no price column of its own** (the generated columns above resolve via the batch join, not a stored rc_out value). Any feature that needs a fed ₱/kg or fed value must compute it from the batch's weighted-avg cost over `deliveries.cost_basis` — **not** `batches.avg_cost`, which is documented STALE for some live batches (known imperative-ingestion `+=` drift, e.g. JAN-26-BLK11). This is the same basis the Blocking module and the `view_rc_movement_*_price` views use. See `view_rc_out_closed_blocks` below.
- **Joins:** `batches(batch_code, status, location_ref)` for display, STATE column, and block_loc fallback
- **Types:** `RcOutRow` (includes `batches?: { batch_code: string; status: string; location_ref: string }`), `RcOutInput`, `InputRcOutRow` (defined locally in actions/components)

### View: `view_rc_out_closed_blocks` (Closed Blocks summary)
Read-only SQL view (migration `20260629000000_create_view_rc_out_closed_blocks.sql`) that produces **one summary row per CLOSED block** — a batch whose `batches.status = 'CLOSED'` that has at least one `rc_out` feeding — collapsing all of that batch's feedings into totals, dated by when it was logged closed. **All aggregation lives in SQL** (project hard rule — never sum in TypeScript). Powers the frontend's "Closed Blocks" summary toggle (one summary row per closed block instead of one row per feeding). No triggers, no writes.

**Column contract (frontend-facing, do not rename):**

| Column | Postgres type → TS | Meaning |
|---|---|---|
| `batch_id` | uuid → `string \| null` | `batches.id` |
| `batch_code` | text → `string \| null` | `batches.batch_code` |
| `block_loc` | text → `string \| null` | the block this batch occupied: `batches.location_ref`, falling back to the most recent non-empty `rc_out.block_loc` when location_ref is NULL/`''`. **MAY be NULL** for FEED batches that never had a block — expected. |
| `close_date` | date → `string \| null` | `MAX(transaction_date)` of the batch's CLOSED-marked feedings, COALESCEd to `MAX(transaction_date)` over all its feedings when no feeding carries a CLOSED marker. **Non-null for every row.** |
| `total_fed_kg` | numeric → `number \| null` | `SUM(weight_kg)` across all the batch's feedings |
| `feed_count` | int → `number \| null` | `COUNT(*)` of the batch's `rc_out` rows |
| `first_fed_date` | date → `string \| null` | `MIN(transaction_date)` |
| `total_value` | numeric → `number \| null` | `total_fed_kg × batch_unit_cost` (blended ₱/kg from `deliveries.cost_basis`); NULL when the batch has no priced deliveries |
| `avg_price` | numeric → `number \| null` | `total_value / total_fed_kg` = the blended ₱/kg for the closed block |

- **Base = `rc_out`** (`FROM rc_out JOIN batches WHERE status='CLOSED'`): only closed batches with ≥1 feeding appear → **440 rows** (449 batches are CLOSED, but 9 are test/QA junk with zero `rc_out` and zero deliveries, so they have no real data and no resolvable close_date and are correctly dropped). Every row has a non-null `close_date`.
- **PRICE source = `deliveries.cost_basis` weighted-avg** per batch (`SUM(cost_basis*weight_kg)/NULLIF(SUM(weight_kg),0)`), **not** `batches.avg_cost` (stale — see note above). `avg_price` equals that blended ₱/kg.
- **PRICE columns are NOT gated in the view** — `total_value` and `avg_price` are exposed raw. They MUST be role-gated **downstream** in the frontend's server fetch: null them when `!canViewPrices()` (canonical helper in `@/lib/auth`, respects the impersonation cookie; Production is the only price-denied role) **before the payload leaves the server**, and thread a `canViewPrices` boolean down for conditional render. This is the exact pattern `view_blocking_grid` + its server action already use.
- **SECURITY INVOKER** (Postgres default for views) — inherits RLS from `rc_out` + `batches`, same as `view_blocking_grid` and `view_rc_movement_*`. `GRANT SELECT TO authenticated, anon`.
- **Frontend query shape:** `supabase.from('view_rc_out_closed_blocks').select('*')` (optionally `.order('close_date', { ascending: false })`). Null `total_value`/`avg_price` server-side when `!canViewPrices()`.

## Key Behaviors
- **Lazy-loaded via tab context:** RC OUT data is NOT fetched server-side on initial page load. Instead, `../components/rc-out-lazy-tab.tsx` calls `fetchRcOutTabData()` on first render (when user switches to Usage tab). Once loaded, the component stays mounted via CSS `hidden` class — subsequent tab switches are instant with full state preservation.
- **Load error / retry (lazy tab):** `rc-out-lazy-tab.tsx` wraps the `fetchRcOutTabData()` call in try/catch with `loading` / `error` state (same fetch/loading/error/retry pattern the standalone Blocking + Movement route views use). On failure it renders a centered "Failed to load Usage data." message + a Retry button (re-runs the same fetch) AND fires `errorToast()` from `@/lib/toast` (persist-until-dismissed + Copy, per the Error Toasts HARD RULE — never `toast.error` directly). A `hasFetchedRef` guard prevents the initial-mount fetch from re-firing once good data is held. The same `loadData` powers both the table's `onRefresh` and the retry button.
- **`fetchRcOutTabData()` server action:** Returns `{ records, batches, destinations, batchOptions, yearOptions, blockLocs, canViewPrices }`. **PRICE-GATED (server-side):** it calls the canonical `canViewPrices()` from `@/lib/auth` (respects the `dev_mock_role` impersonation cookie via `getUserRole()`) and, when false (Production, incl. impersonated), sets `record.avg_price` / `record.avg_wtd_value` to `null` **before returning** — the ₱ values never reach the browser. The `canViewPrices` boolean is returned for conditional client render. All `rc_out` records are loaded upfront (no date scoping). `batchOptions` is `string[]` of plain production_batch codes (no year annotations). `yearOptions` is `number[]` of distinct years from `rc_out.transaction_date`, descending. `blockLocs` is the union of `rc_out.block_loc` and `batches.location_ref`. **IMPORTANT:** Filter queries (destinations, production_batch, block_loc) page through results via the **shared `fetchAllRows()` helper** (`@/lib/supabase/paginate`, DUP-1 — replaces the former local `fetchAll` loop) to bypass PostgREST's server-side `max_rows` cap of 1000. A thin local `fetchAll` wraps it to preserve this module's lenient contract (swallows a page error and returns the partial/empty set instead of throwing).
- **"Closed Blocks" summary toggle (default OFF):** A `PackageCheck` toggle button (first item in the toolbar's right cluster) swaps the feeding table for a one-row-per-closed-block summary sourced from `view_rc_out_closed_blocks`. **Lazy-fetched** via `fetchClosedBlocks()` on first toggle-ON only (a `closedBlocks !== null` guard prevents refetch once data is held; on error it stays null so a later toggle-off/on retries). `fetchClosedBlocks()` returns `{ rows, canViewPrices, error? }` and is **price-gated server-side** via the canonical `canViewPrices()` — it nulls `total_value`/`avg_price` **before returning** so a Production payload never carries ₱. Errors surface via `errorToast()` (persist-until-dismissed + Copy; never `toast.error`). Summary column order LEFT→RIGHT: **Close Date · Batch · Block · Total Fed (kg) · Feedings · Avg ₱/kg · Total Value**. Default sort is `close_date` desc (the server's `.order()`); rows render in server array order with **NO client re-sort, re-sum, or re-aggregation** (all aggregation lives in the SQL view — project hard rule). Null `block_loc` renders `—` (covers null and `''`). The two ₱ columns (Avg ₱/kg AND Total Value) are **OMITTED ENTIRELY** (header `<th>` AND body `<td>`, not blanked) when the server-returned `canViewPrices` is false — a Production user sees only the first 5 columns. The summary uses a plain `<table>` (not TanStack) at Excel-standard density (`px-2 py-1`, `text-xs`, 32px rows, `font-mono` right-aligned numerics). In summary mode the 5 feeding filters are hidden (replaced by an empty placeholder `<div />` so the right cluster stays right-aligned); the feeding `<table>` path renders only when the toggle is OFF.
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
- **Computed DB columns:** `avg_price` and `avg_wtd_value` are DB-computed — never calculated client-side. **Security boundary = server-side:** they are nulled in `fetchRcOutTabData()` via `canViewPrices()` before leaving the server (see Data section), so a Production user's payload never contains ₱ values. **Render gate = the server-computed `canViewPrices` boolean** (single source of truth): it is threaded `fetchRcOutTabData() → RcOutLazyTab → RcOutTableWrapper → RcOutTable` and drives the conditional render of the price columns (column filter in `rc-out-table.tsx`) and the TOTALS-footer price cells. The table no longer self-derives via `hasPermission('view:prices')` — render visibility now exactly matches the server data gate, so Production never sees empty/blank price columns.
- **Audit trail:** Updates use `set_audit_comment()` RPC + `audit_comments` posting, same pattern as RC IN.
- **Auto-fill block_loc:** Selecting a batch auto-populates `block_loc` from `batch.location_ref`.
- **Data refresh mechanism:** After every add/edit/delete operation, the table automatically refetches all data via `onRefresh` prop (calls `fetchRcOutTabData()` again from `RcOutLazyTab`). A manual refresh button (`RefreshCw` icon) in the toolbar provides a fallback. The `refreshing` state drives a spinner on the button. The `onRefresh` prop is threaded through `RcOutLazyTab` -> `RcOutTableWrapper` -> `RcOutTable`. Server actions still call `revalidatePath` as before; the client-side refetch ensures the lazy-loaded tab picks up changes immediately.
- **Cell selection + clipboard copy (master table):** `useCellSelection` and `useClipboardCopy` hooks enable Excel-like rectangular cell selection (click-drag, Shift+Arrow, Ctrl+A) and Ctrl+C copy as TSV. Mutually exclusive with row selection mode. Selection count and `useCellAggregation` aggregates are pushed to `StatusBarProvider` context via `useStatusBar()` and displayed in the unified `FloatingStatusBar` with a Google Sheets-like auto-calculate dropdown (SUM/AVERAGE/COUNT/MIN/MAX). Numeric columns for aggregation: weight_kg, avg_price, avg_wtd_value. Clears on data/sorting changes, clicking outside the scroll container, or pressing Escape.
- **Cell selection + copy + delete (bulk input):** All 3 hooks (`useCellSelection`, `useClipboardCopy`, `useCellDelete`) plus `useCellAggregation` with two-mode system: single-cell edit (click without drag) vs range selection (click+drag, Shift+Arrow). Range mode: Ctrl+C copies as TSV, Backspace/Delete clears all cells. Non-shift nav exits range. Printable char exits range and edits anchor cell. Selection count and aggregates pushed to `StatusBarProvider` context (same as master table). Numeric column for aggregation: weight_kg.
- **Shared Blackwood Table primitives (bulk input):** `bulk-usage-input.tsx` consumes the shared grid keyboard/edit/paste hooks — `useGridKeyboardNav` (coordinate resolver via `createCoordinateNavResolver(COLUMN_MAP)`), `useGridEditSession` (owns `isEditing` + pre-edit snapshot + start/revert/commit), and `useGridPaste` (Excel/TSV smart-paste). The old hand-rolled `handleGridKeyDown`/`moveSelection`/`startEditing`/`revertChanges`/`handleSmartPaste` were deleted; the existing `useCellSelection`/`useClipboardCopy`/`useCellDelete` instances are wired into the hook's `range` slot. `enableEnterAnchor: false` (plain Enter drops straight down — RC OUT never used the Tab-then-Enter lane return). A thin container wrapper preserves single-cell Ctrl/Cmd+C (the shared hook only copies in range mode). Mirrors the RC IN reference. See `components/shared/grid/CONTEXT.md`.
- **editBatch + editView deep-link:** When URL contains `?editBatch=<batch_code>` **AND `editView === 'usage'`**, the table auto-selects all matching records (by `production_batch` or `batches.batch_code`) and opens the bulk edit dialog. `editView` is required because on `/inventory` both the Deliveries (RC IN) and Usage (RC OUT) tables are always mounted and BOTH read `?editBatch=`; this table early-returns unless `editView === 'usage'` (the Deliveries table claims a missing/`'deliveries'` value), so the wrong editor never opens. Used by the Blocking / RC Movement detail panel's "Edit All" button on the Usage History section. On a match, **both `editBatch` and `editView`** are stripped from the URL via `replaceState`; the non-matching table leaves them untouched.
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
- `@/lib/auth` — `canViewPrices()` (server) resolves the price gate in `fetchRcOutTabData()`; the resulting boolean is threaded to the table for render-gating (the table no longer imports `auth-context`/`hasPermission`)
- `@/lib/toast` — `errorToast()` surfaces `fetchRcOutTabData()` load failures in `rc-out-lazy-tab.tsx` (persist-until-dismissed + Copy, per the Error Toasts HARD RULE)
- `@/components/providers/table-settings` — fontSize, rowHeight settings
- `@/components/providers/status-bar-context` — `useStatusBar()` for pushing cell selection count and aggregates to FloatingStatusBar
- `@/lib/hooks/use-cell-selection` — rectangular cell selection with drag, keyboard, and auto-scroll
- `@/lib/hooks/use-clipboard-copy` — Ctrl+C copies selected cells as TSV
- `@/lib/hooks/use-cell-delete` — Backspace/Delete clears multi-cell selection (bulk input only)
- `@/lib/hooks/use-cell-aggregation` — computes SUM/AVERAGE/COUNT/MIN/MAX over selected numeric cells for status bar display
- `@/lib/hooks/use-grid-keyboard-nav`, `@/lib/hooks/use-grid-edit-session`, `@/lib/hooks/use-grid-paste` — shared Blackwood Table grid primitives (keyboard state machine + coordinate resolver, inline-edit session, smart paste) used by `bulk-usage-input.tsx`
- `@/components/ui/command` — searchable multi-select for inclusion-model filters
- `@/components/ui/checkbox` — checkboxes in filter popovers
- `@tanstack/react-table`, `@tanstack/react-virtual`, `sonner`

## See Also
- [Blackwood Table (shared grid primitives)](../../../../components/shared/grid/CONTEXT.md) — `bulk-usage-input.tsx` consumes the shared keyboard/edit/paste hooks
- [RC IN](../rc-in/CONTEXT.md) — shares paste utilities; the canonical reference migration for the shared grid primitives
- [RC Movement](../rc-movement/CONTEXT.md) — consumes `rc_out` (weight + transaction_date → `view_rc_movement`; production_batch → matrix "Batch" column)
- [Blocking](../blocking/CONTEXT.md) — warehouse grid visualization; usage data feeds balance calculations
- [Auth Provider](../../../../components/providers/AUTH.md) — permission model for price visibility
- [Navbar](../../../../components/NAVBAR.md) — breadcrumb registration
