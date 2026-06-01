# Cenapro Module (Tenant #2 — CI / Cebu)

## Purpose
Top-level route `/cenapro` for the **second tenant** on the Blackwood platform: the CI / Cebu charcoal company ("Cenapro"). Two **read-only** screens visualize production data already ingested into the dedicated `cenapro` Postgres schema. Fully decoupled from the ICTC / Davao tenant — shares zero tables, types, or code.

> **Tenant/Domain Module (Cenapro):** Cebu-specific. Read-only views; the source of truth is an operator-uploaded `.xlsb` (the upload feature is a SEPARATE, not-yet-built follow-up). These screens never mutate — no inline editing, no server-action writes.

## Files
| File | Role |
|------|------|
| `layout.tsx` | Module shell — a borderless `Card` frame (matches Production's look). No shared period provider; each screen owns its own controls. |
| `page.tsx` | Landing hub — two `hover-lift` card-links (Production / Flec Inventory) + a "Tenant #2 · Cebu" note. |
| `loading.tsx` | Table skeleton (toolbar + header + 14 row stripes). |
| `error.tsx` | Error boundary — persistent message + **Copy button** (error HARD RULE) + a note that empty data is expected pre-exposure. |
| `types.ts` | **STOPGAP** hand-written cenapro row interfaces (see "Stopgap types" below) + warehouse constants + `formatDisposition()`. |
| `production/page.tsx` | Server — `fetchProductionEvents()` → `<ProductionTable />`. |
| `production/actions.ts` | `'use server'` — `fetchProductionEvents()`: reads full `cenapro.production_event` spine newest-first. |
| `production/production-table.tsx` | Client — dense Excel-style read-only table; header column-filters (Shift/Grade/Disposition/Warehouse); date sort toggle; inline error banner. Local `ColumnFilterMenu` + `DispositionBadge`. |
| `inventory/page.tsx` | Server — reads `?whse=&date=` URL params (defaults WHSE 7 / 2026-03-10), `fetchFlecInventory()` → `<FlecInventoryClient />`. |
| `inventory/actions.ts` | `'use server'` — `fetchFlecInventory(warehouse, startDate)`: calls `flec_balance` + `flec_ledger` RPCs in parallel. |
| `inventory/flec-inventory-client.tsx` | Client — warehouse `<Select>` + native start-date input (both push to URL params via `router.replace` in a transition); balance cards per grade×side; show-your-math movement ledger. Local `BalanceCard` + `LedgerDirection`. |

## Data
All from the **`cenapro` schema** (NOT `public`). Reached via `(supabase as ...).schema('cenapro')` — see Stopgap below.

- **`cenapro.production_event`** (752 rows, recv_date 2025-12-01 → 2026-05-28). Columns consumed: `recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code (nullable — 471 "unplaced" rows), source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side`.
  - `disposition_kind` ∈ `flec_bagging | partner_crusher | partner_kiln`. Rendered: Bag / Crusher C1 / Kiln RK3.
  - Verified distinct values: shift `M`; grades `2X6/3.5/3X50`; warehouses `WHSE 1/5/7`; equipment `C1/C2/RK1/RK2/RK3/RK4`. (Filter options are derived from data at runtime, not hardcoded.)
- **`cenapro.flec_balance(p_warehouse_code text, p_start_date date)`** → `(warehouse_code, grade_code, side, current_flec, opening_seed, as_of)`. Closing count per (grade, side). NOTE: a (grade,side) with an opening but no events ≥ start date does NOT appear (empty-period caveat, schema §6.2).
- **`cenapro.flec_ledger(p_warehouse_code text, p_start_date date)`** → `(…, recv_date, grade_code, side, disposition_kind, partner_equipment_code, kg_moved, flec_in, flec_out, opening_seed, flec_in_to_date, flec_out_to_date, running_balance)`. The show-your-math movement detail.
- **`cenapro.view_production_daily`** — typed in `types.ts` (`ProductionDailyRow`) but NOT surfaced as a screen in this task.
- Flec warehouses = `WHSE 1/2/5/7` (flec-count). **WHSE 3 is kg/DVO — DEFERRED, never surfaced.**
- Opening balances seeded for **WHSE 7** (3X50 RS=53, 2X6 LS=26 @ 2026-03-10) → that is the inventory page's default.

## Key Behaviors
- **READ-ONLY.** No editing, no mutations, no `revalidatePath`. Source of truth is the uploaded file.
- **Production table:** fetches all 752 rows once; filters + date-sort happen client-side (small dataset, no virtualization). Header filters HIDE rows (not sort); date toggle defaults **newest-first**. Sticky glass header (`bg-muted/90 backdrop-blur-sm`).
- **Flec Inventory:** warehouse + start-date drive state via **URL search params** (`?whse=&date=`); changing either `router.replace`s in a `useTransition` → server re-fetch. Start-date semantics made explicit ("Balances as of `<date>` forward"). Balance cards + per-row running-balance ledger ("opening + ins − outs = balance").
- **Error handling (HARD RULE):** every inline error banner is persistent + has a **Copy** button. `error.tsx` boundary likewise. All note that empty data is expected until PostgREST exposure.
- **Excel Standard:** `table-fixed`, explicit px widths, `px-2 py-1`, `h-8` rows, `text-xs`, `font-mono` right-aligned numerics, `tabular-nums`.
- **Navbar:** registered in `getBreadcrumb()` (`/cenapro`, `/cenapro/production`, `/cenapro/inventory`) + a **separate "Cenapro · Cebu" section** in the Modules dropdown (distinct from "ICTC · Davao").

## Stopgap types (IMPORTANT — remove after exposure)
The `cenapro` schema is **built + loaded but NOT yet exposed to PostgREST**, and `types/supabase.ts` does NOT include a `Database['cenapro']` namespace. Therefore:
- `types.ts` hand-declares `ProductionEventRow / FlecLedgerRow / FlecBalanceRow / ProductionDailyRow` (verified column-for-column via Supabase `execute_sql`, 2026-06-01).
- Server actions reach the schema by casting the server client to a minimal structural type and calling `.schema('cenapro').from(...)` / `.schema('cenapro').rpc(...)`.
- **Pages will NOT show live data in the browser until Renzo flips the "Exposed schemas" toggle + regenerates types.** That is expected — the screens render graceful empty/error states meanwhile.
- **After exposure + `supabase gen types typescript --linked`:** delete the stopgap interfaces, import the generated `Database['cenapro']` rows, and drop the `as unknown as {…}` casts in both `actions.ts` files.

## Dependencies
- `@/lib/supabase/server` — `createClient()` (server Supabase client; supports `.schema()` + `.rpc()`).
- `@/components/ui/{table,select,card,dropdown-menu,button}` — Shadcn primitives.
- `@/lib/utils` — `cn()`.
- `date-fns` — `format`, `parseISO`, `isValid` (date display only — `yyyy-MM-dd`).
- `sonner` — success toast on error-copy (errors themselves are inline banners per HARD RULE).
- `lucide-react` — icons.

## See Also
- `/Users/renzosy/blackwood/cenapro/CENAPRO_SCHEMA.md` — the authoritative schema contract (tables, `flec_ledger`/`flec_balance`, `view_production_daily`, the 28 ported business rules, DVO deferral).
- [Navbar](../../../components/NAVBAR.md) — page titles / breadcrumbs / Modules dropdown.
- [Production module](../production/CONTEXT.md) — ICTC production; source of the dense-table + `ColumnFilterMenu` patterns reused here.
