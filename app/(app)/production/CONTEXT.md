# Production Module

## Purpose
Top-level route `/production` for charcoal plant operations data: daily production runs, downtime, waste streams, electricity consumption, and truck odometer readings. Excel-parity views matching the MASTER sheet structure — implemented as **true inline-editable grids** (no dialogs).

> **Domain Module (Charcoal Tenant):** Charcoal-specific operations layer. All data is fully visible to all authenticated users. Cost/price data (Electricity RATE/TTL PHP) is gated by `hasPermission('view:prices')`.

## Files
| File | Role |
|------|------|
| `page.tsx` | Server entry point — renders `<ProductionView />` |
| `daily/daily-cards-mobile.tsx` | **Phone read layer** for the Daily ledger (`sm:hidden`; desktop grid is `hidden sm:block`). Archetype C `MobileCardList` — one card per run row, fed the grid's OWN exported `buildGridRows()`; tap → section-grouped detail sheet (Identity / Production / Downtime / Waste). Read-only. |
| `daily/ledger-derive.ts` | Pure helper `deriveDailyMetrics(row: GridRow)` — captures the grid's inline DT TTL / PROD HRS / PROD LOSS / TTL WASTE compute in ONE place so the mobile card shows identical derived values (never recomputed differently). |
| `electricity/electricity-cards-mobile.tsx` | **Phone read layer** for Electricity (`sm:hidden`). Simplest `MobileCardList` — card headline `date · meter · TTL KWH · [start→end]`, detail = start/end/diff/mult/consumption/remarks. DIFF + TTL KWH read off the DB generated columns (`diff_kwh`, `consumption_kwh`). |
| `schedule/actions.ts` | **The in-app write path for `production_schedule`** (Phase B, 2026-07-30). Server actions only — the client never touches Supabase. `saveScheduleDay` (edit → `fn_save_schedule_day`, flips the WHOLE DAY to `owner='human'`), `takeUpstreamProposal` / `keepMineClearPending` (the two conflict resolutions — the ONLY callers that pass `p_clear_pending: true`), `releaseScheduleDay` (hand a human day back to the sync). Every value-bearing mutation goes through `fn_save_schedule_day` with the `row_version` the client READ, so a save racing the sync returns `version_conflict` and is surfaced as "reload", never force-written. `revalidatePath('/')` after each success (the schedule lives at `/?view=schedule`). Exports `SchedulePatch`, `SaveOutcome`, `ScheduleWriteResult`. **Schema gap, reported not patched:** no RPC exists to return ownership to the sync, so `releaseScheduleDay` uses a conditional PostgREST UPDATE guarded on `row_version` + `owner='human'` in the same statement (the actuals freeze is read first from `view_production_schedule_state` — advisory, since the real freeze is re-checked inside `fn_apply_schedule_upstream` / `fn_save_schedule_day`). A `fn_release_schedule_day(p_plan_date, p_expected_row_version)` belongs in a later migration. |
| `schedule/page.tsx` | **The `/production/schedule` route — renders the editable month grid** (no longer a redirect; 2026-07-30). Historical note (BUG-003). The Production Schedule left the production module: it lived under `layout.tsx` and so wrongly rendered inside the Daily·Electricity·Trucks tab shell. It is now a **view on the Home Digest** — `/?view=schedule` — and the month table itself lives in `components/digest/schedule-month-view.tsx` (`<ScheduleMonthView month basePath extraParams />`, unchanged queries/columns/frozen panes). **The redirect was removed** because the schedule became reachable ONLY via a toggle on `/`, so the shipped editor read as "never built". This file now renders `<ScheduleMonthView month basePath="/production/schedule" />` inside the shared `HOME_SHELL_CLS` (`components/digest/shell.ts`) — the SAME component, container and data loading `/?view=schedule` uses. **Two doors, one surface; no fork.** BUG-003 stays fixed by the `(tabs)` ROUTE GROUP: `layout.tsx` + `page.tsx` + `error.tsx` + `loading.tsx` moved into `app/(app)/production/(tabs)/` (URLs unchanged), so the Daily·Electricity·Trucks shell can no longer reach this sibling route. The page renders NO title header — the navbar owns it (`exact('/production/schedule')` in `getBreadcrumb()`). Its phone card list moved to `components/digest/schedule-cards-mobile.tsx`. See `app/(app)/CONTEXT.md` → "`/` hosts TWO views". |
| `(tabs)/layout.tsx` | Client layout for the TAB surfaces only (inside the URL-invisible `(tabs)` route group, so `/production/schedule` opts out) — wraps in `ProductionTabProvider` + `ProductionPeriodProvider` + Card shell. Mounts the universal `<PeriodPicker />` header bar above tab content + `<ProductionSheetTabs />` footer |
| `error.tsx` | Error boundary |
| `loading.tsx` | Loading skeleton |
| `components/production-tab-context.tsx` | React context — `activeTab` / `setActiveTab`, localStorage key `production_active_tab` |
| `components/production-period-context.tsx` | **Shared period context** — `year` / `batch` / `availablePeriods` / `periodsLoading` / `setPeriod`. Owns the universal period state for ALL 3 tabs, syncs URL `?y=&b=`, fetches `fetchAvailablePeriods()` once + resolves default. |
| `components/period-picker.tsx` | The universal Year + Batch `<Select>` UI. Reads/writes the period context. **Never disabled** by any tab's loading state. |
| `components/sheet-tabs.tsx` | Bottom tab bar with sliding indicator (Daily · Electricity · Trucks) |
| `components/production-view.tsx` | Crossfade wrapper for 3 tabs (150ms opacity transition) |
| `components/daily-lazy-tab.tsx` | Lazy loader for Daily tab — consumes period context, refetches on activation-if-stale |
| `components/electricity-lazy-tab.tsx` | Lazy loader for Electricity tab — consumes period context, derives month via `batchToMonth()` |
| `components/trucks-lazy-tab.tsx` | Lazy loader for Trucks tab — consumes period context, derives month via `batchToMonth()` |
| `lib/batch-month.ts` | `batchToMonth(batch)` — maps month-name batches (abbreviated + full forms) → 0-indexed month. Returns null for null/unrecognized. Used by Electricity/Trucks tabs to translate the shared batch into a date filter. |

## Tab Catalog
| Tab | Submodule | Data | UI |
|-----|-----------|------|----|
| Daily | `daily/` | `production_shifts`, `production_runs`, `production_downtime`, `production_waste` | ONE unified inline-editable ledger (replaces 3 side-by-side grids as of 2026-05-28) |
| Electricity | `electricity/` | `electricity_readings` | Single inline-editable grid (monthly summary removed May 2026; `view_electricity_monthly` dropped 2026-05-29) |
| Trucks | `trucks/` | `truck_readings` | Single inline-editable grid (monthly summary removed; `view_trucks_monthly` still exists but unused) |

## Grid Architecture (Excel-Style)
All 5 grids share the same pattern (modelled after `bulk-delivery-input.tsx`):
- **Row states:** `existing | new | modified | deleted` — dirty tracking per row
- **Dirty indicator:** amber left border on `modified` rows; strikethrough on `deleted` rows
- **Save/Discard:** each grid independently batches its own inserts/updates/deletes into one server action call
- **Trailing empty row:** always maintained at the bottom for adding new data
- **Keyboard nav:** Arrow/Tab/Enter navigation, F2 edit, Escape revert, Home/End row edges
- **Paste:** Ctrl+V from clipboard auto-expands rows; `parseExcelDate` handles date columns
- **Range selection:** left-click-drag, Shift+Arrow, Ctrl+A; Ctrl+C copies TSV
- **Status bar:** pushes selection count + aggregates to `StatusBarProvider`
- **Error toasts:** `errorToast()` from `lib/toast.ts` — HARD RULE

## Daily Tab Layout (as of 2026-05-28)
ONE unified ledger inside `overflow-x-auto`. `table minWidth: 1800px`. Columns grouped into sections: Identity (blue) · Production (green) · Downtime (amber) · Waste (red). Each ledger row = one `production_runs` entry. Downtime/Waste columns appear only on the primary grade row per shift; secondary rows have muted gray cells. See `daily/CONTEXT.md` for full column order and multi-grade rendering rules.

## Production Schedule (Phase B — in-app editing, 2026-07-30)

The schedule **UI** lives in `components/digest/` (rendered at BOTH `/?view=schedule` and `/production/schedule`),
but its **server actions** stay here at `app/(app)/production/schedule/actions.ts`
— this is the plan's domain module.

**Ownership model** (`production_schedule.owner`, migration
`20260730060000_production_schedule_ownership.sql`):

| owner | meaning | editable in-app? | sync may write it? |
|---|---|---|---|
| `joseph` | following Joseph Go's emailed schedule | yes | yes |
| `gsheet` | Renzo's PROD SCHED baseline | yes | yes |
| `human` | edited in the app | yes | **no** — upstream is parked in `pending_upstream` |
| `actual` | production reported for the date (DERIVED, never stored) | **no — frozen** | no |

**Rules the UI enforces (and the DB re-enforces):**
- **Editing any cell takes the WHOLE DAY.** Approved lock granularity; there is no
  separate lock toggle. `fn_save_schedule_day` sets `owner='human'` +
  `human_edited_at/by` regardless of which field changed. The grid makes this
  legible BEFORE the commit (owner-chip flip preview + sky row rail + a save bar
  that names the days losing their upstream owner and reads "Take ownership &
  save N").
- **`row_version` is echoed on every write.** The RPC's own WHERE does the check;
  a `version_conflict` is reported as "this day changed since you loaded it,
  reload", never retried or forced.
- **`p_clear_pending` defaults to FALSE.** An unrelated edit must never silently
  discard a parked proposal — only the two explicit resolve actions clear it.
- **Ownership must be reversible.** `releaseScheduleDay` hands a human day back
  (owner → `joseph`/`gsheet` from the `source` prefix, `source_rev` cleared so the
  next run RE-APPLIES rather than no-opping). Without it ownership only ratchets
  one way and the calendar slowly freezes.
- **Grades (JSONB) are read-only** in Phase B — no JSON editor yet.

## Shared Types
`BulkSavePayload<TInsert, TUpdate>` — now defined locally in `electricity/actions.ts` and `trucks/actions.ts` (no longer shared from `daily/actions.ts` — the daily module was rewritten with a different atomic save pattern).
```ts
type BulkSavePayload<TInsert, TUpdate> = {
  inserts: TInsert[];
  updates: { id: string; data: TUpdate }[];
  deletes: string[];
};
```

## Universal Period Control (as of 2026-05-29)

The Year + Batch picker is a **module-level, shared period control** — NOT per-tab state. It lives in `(tabs)/layout.tsx` (in a header bar above the tab content), stays mounted across tab switches, and is **never disabled** by any tab's loading state.

**Architecture:**
- `ProductionPeriodProvider` (in `components/production-period-context.tsx`) holds `year: number | null` (null = All Years) and `batch: string | null` (null = All Batches). Provided in `(tabs)/layout.tsx`, wrapping everything alongside `ProductionTabProvider`.
- It fetches `fetchAvailablePeriods()` (from `daily/actions.ts`) ONCE on mount to populate options, then resolves a sensible default: current year + current month's batch (if present), else falls back to the last available batch, else All. URL params (`?y=&b=`) override the default and are honored on mount.
- `setPeriod(year, batch)` updates state + replaces URL params via `history.replaceState`.
- `<PeriodPicker />` (in `components/period-picker.tsx`) renders the two `<Select>`s and reads/writes the context. Year: "All Years" pinned + divider + descending years. Batch: "All Batches" pinned + divider + batches for the selected year (union across years when year=All).

**Per-tab consumption + stale-refetch:**
- Each lazy tab reads `{ year, batch, periodsLoading }` from the context (no local picker state).
- Each tab tracks the period it last fetched via a `fetchedPeriodRef` (serialized `"year|batch"` string).
- A single `useEffect` (deps: `activeTab`, `year`, `batch`, `periodsLoading`, `load`) fires a fetch when: the tab is active AND `!periodsLoading` AND `fetchedPeriodRef.current !== periodKey(year, batch)`. This covers BOTH cases: (a) tab becomes active with a stale period, (b) period changes while the tab is active.
- Inactive tabs never fetch — they pick up the latest period lazily on next activation.
- The `periodsLoading` guard prevents a wasted initial "All Batches" fetch before the default batch resolves.
- Daily filters by `production_batch` directly. Electricity/Trucks call `batchToMonth(batch)` and pass `(year, month)` to their fetch actions (batch → calendar month, since they store dates not batch names).

## Mobile Read Layer (phones, `sm:hidden`)
Additive Archetype C card views for the read surfaces — the dense desktop grids/tables are wrapped `hidden sm:block` and are otherwise **untouched** (editing / keyboard / paste stay desktop-only). Each mobile view is fed the SAME row data the desktop uses (single source of truth), never a second fetch:
- **Daily** (`daily/daily-cards-mobile.tsx`): built on `MobileCardList`, one card per run row from the grid's exported `buildGridRows()`; derived metrics from `ledger-derive.ts::deriveDailyMetrics`. Wrapped in `daily-view.tsx` (`h-[72dvh] sm:hidden`).
- **Electricity** (`electricity/electricity-cards-mobile.tsx`): `MobileCardList` over the `readings` rows. Wrapped in `electricity-view.tsx` (`h-[70dvh] sm:hidden`).
- **Schedule** — its own route again (`/production/schedule`, outside the `(tabs)` group) AND a view on `/`; **not a Production TAB.** Its phone card list moved with it to `components/digest/schedule-cards-mobile.tsx` (a full-month list of the shared `ScheduleRowCard`), rendered by `components/digest/schedule-month-view.tsx` on `/?view=schedule`. The month switcher + prev/next `<Link>`s stay shared across breakpoints. See `app/(app)/CONTEXT.md`.
- **Trucks** is intentionally NOT covered here — it is a frozen-pane matrix (Archetype E), handled in a later phase.
- No ₱ exists anywhere in Production → no price gating on any mobile surface.

## Key Behaviors
- **Lazy loading:** All 3 tabs load on first activation AND refetch when the shared period changes (see Universal Period Control). `fetchedPeriodRef` per tab prevents redundant fetches for an unchanged period.
- **Crossfade:** 150ms opacity transition (same pattern as Inventory).
- **Tab persistence:** localStorage key `production_active_tab`, default `'daily'`.
- **Period persistence:** URL params `?y=` (year or `all`) and `?b=` (batch name or `all`), owned by `ProductionPeriodProvider`.
- **Error handling:** Each lazy tab has Retry button on fetch failure. The shared picker stays interactive even when a tab is in its error/loading state.
- **Navbar:** Registered in `getBreadcrumb()` at `startsWith('/production')`. Production enabled in `MODULES` array.

## Schema References

**Parent table (2026-05-28):**
- `production_shifts` — `id`, `transaction_date`, `production_batch`, `shift` (M/E/N). Natural key: `(transaction_date, production_batch, shift)`. One row per unique shift. All 3 child tables FK to this via `shift_id`.

**Child tables (restructured 2026-05-28 — `transaction_date`, `production_batch`, `shift` columns dropped; now live in parent):**
- `production_runs` — `shift_id` (FK), `customer` (CEBU/KURARAY/..., default 'CEBU'), `grade` (3X50/6X50/8X50/2X6), `ttl_kg`, `sacks_bags`. Natural key: `(shift_id, customer, grade)`. N:1 with production_shifts.
- `production_downtime` — `shift_id` (FK), `shift_hrs`, `dt_hrs`, `dt_mins`, `dt_reason`. Natural key: `(shift_id)` — exactly 1 per shift.
- `production_waste` — `shift_id` (FK), 8 waste stream kg columns (rs1a/rs1b/bf/rs23/rs5/trml1/trml2/grit). Natural key: `(shift_id)` — exactly 1 per shift. **SKS columns dropped 2026-05-28** — mixed-type text blobs with no aggregation value.

**Other tables (unaffected by restructure):**
- `electricity_readings` — date, meter (MAIN/BUNKHOUSE/PUMP), start_kwh (raw reading), end_kwh (raw reading), diff_kwh (generated = end−start), **meter_multiplier** (NOT NULL DEFAULT 120), **consumption_kwh** (generated = (end−start) × meter_multiplier). The `120` is a METER MULTIPLIER, NOT a peso rate — source email computes `CONSUMPTION (KWH) = diff × 120`. Renamed from `rate_php_per_kwh` 2026-05-29 (see PRODUCTION_DESIGN.md §15.2 Section D).
- `truck_readings` — date, plate_no, start_km, end_km, fuel_liters

**Views:**
- `view_production_daily` — one row per `production_shifts` entry. Joins runs (LEFT, aggregated by grade), downtime (LEFT, 1:1), waste (LEFT, 1:1) via shift_id. Exposes `shift_id` as row identifier. Computes dt_total_hrs, productive_hrs, total_waste_kg, prod_loss_pct.
- ~~`view_electricity_monthly`~~ — **DROPPED 2026-05-29** (referenced the old `rate_php_per_kwh` column + computed a bogus `month_ttl_php` peso total; the monthly-summary UI was removed May 2026 and nothing queried it).
- `view_trucks_monthly` — monthly aggregates per plate (note: also unused by the UI — monthly summary card was removed; harmless but a candidate for future cleanup)

**Note (2026-05-27):** `production_runs.customer` was added during the MASTER backfill. Default `CEBU` covers ~99% of rows. The unified Daily ledger grid (`daily/daily-ledger-grid.tsx`, which replaced the old `production-runs-grid.tsx`) exposes a CUSTOMER column with a single-select header filter; new rows entered via the grid default to `CEBU` via the DB default when not set.

**Note (2026-05-28, DONE):** The Daily tab UI (`daily/`) was **rebuilt** for the parent-child shift model. Its server actions (`fetchDailyTabData`, `saveBulkDailyLedger`) now use `production_shifts` as the entry point, and the former 3 side-by-side grids were replaced by the single unified `daily-ledger-grid.tsx` (old `production-runs-grid.tsx`/`downtime-grid.tsx`/`waste-grid.tsx` deleted). No stale type signatures remain. See `daily/CONTEXT.md` for the full picture.

## Dependencies
- `@/components/providers/auth-context` — `useAuth()`, `hasPermission('view:prices')` for cost gating
- `@/components/providers/status-bar-context` — `useStatusBar()` for selection aggregates
- `@/lib/hooks/use-cell-selection` — range selection
- `@/lib/hooks/use-clipboard-copy` — Ctrl+C
- `@/lib/hooks/use-cell-delete` — Delete/Backspace on selection
- `@/lib/hooks/use-cell-aggregation` — SUM/AVG in status bar
- `@/lib/paste-utils` — `parseExcelDate`, `trimCellValue`
- `@/components/shared/grid/GridCell` — unified cell display/edit component
- `@/components/shared/grid/RemarksCellAdaptor` — popover remarks editor
- `@/lib/toast` — `errorToast()` for all error toasts (HARD RULE)
- `@/types/supabase` — `Tables<>`, `TablesInsert<>`, `TablesUpdate<>` for all type inference

## See Also
- [Navbar](../../../components/NAVBAR.md)
- [Auth Provider](../../../components/providers/AUTH.md)
- [RC IN bulk-delivery-input](../inventory/rc-in/bulk-delivery-input.tsx) — canonical Excel grid pattern
