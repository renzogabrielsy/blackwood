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
| `types.ts` | Row types **derived from the generated `types/supabase.ts`** (`cenapro_production_events` view + `cenapro_flec_balance`/`cenapro_flec_ledger` function Returns) + warehouse constants + `formatDisposition()`. See "Data path" below. |
| `production/page.tsx` | Server — `fetchProductionEvents()` → `<ProductionTable />`. |
| `production/actions.ts` | `'use server'` — `fetchProductionEvents()`: reads full `public.cenapro_production_events` view newest-first. |
| `production/production-table.tsx` | Client — dense Excel-style read-only table; header column-filters (Shift/Grade/Disposition/Warehouse); date sort toggle; inline error banner. Local `ColumnFilterMenu` + `DispositionBadge`. |
| `inventory/page.tsx` | Server — reads `?whse=&date=` URL params (defaults WHSE 7 / 2026-03-10), `fetchFlecInventory()` → `<FlecInventoryClient />`. |
| `inventory/actions.ts` | `'use server'` — `fetchFlecInventory(warehouse, startDate)`: calls `cenapro_flec_balance` + `cenapro_flec_ledger` RPCs in parallel. |
| `inventory/flec-inventory-client.tsx` | Client — warehouse `<Select>` + native start-date input (both push to URL params via `router.replace` in a transition); balance cards per grade×side; show-your-math movement ledger. Local `BalanceCard` + `LedgerDirection`. |

## Data
All reached through **read-only accessors in the already-served `public` schema** — the standard Supabase client hits them directly (no `.schema('cenapro')`, no cast). See "Data path" below for why. These accessors are thin wrappers over the underlying `cenapro` schema objects.

- **`public.cenapro_production_events`** (VIEW, 752 rows, recv_date 2025-12-01 → 2026-05-28). 16 columns: `id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code (nullable — "unplaced" rows), source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag`.
  - PostgREST types all VIEW columns as nullable (`T | null`) — the client consumers guard accordingly (e.g. the sort comparator coalesces `recv_date`/`id` to `''`).
  - `disposition_kind` ∈ `flec_bagging | partner_crusher | partner_kiln`. Rendered: Bag / Crusher C1 / Kiln RK3.
  - Verified distinct values: shift `M`; grades `2X6/3.5/3X50`; warehouses `WHSE 1/5/7`; equipment `C1/C2/RK1/RK2/RK3/RK4`. (Filter options are derived from data at runtime, not hardcoded.)
- **`public.cenapro_flec_balance(p_warehouse_code text, p_start_date date)`** → `(warehouse_code, grade_code, side, current_flec, opening_seed, as_of)`. Closing count per (grade, side). NOTE: a (grade,side) with an opening but no events ≥ start date does NOT appear (empty-period caveat, schema §6.2).
- **`public.cenapro_flec_ledger(p_warehouse_code text, p_start_date date)`** → `(…, recv_date, grade_code, side, disposition_kind, partner_equipment_code, kg_moved, flec_in, flec_out, opening_seed, flec_in_to_date, flec_out_to_date, running_balance)`. The show-your-math movement detail (function Returns are non-null).
- Flec warehouses = `WHSE 1/2/5/7` (flec-count). **WHSE 3 is kg/DVO — DEFERRED, never surfaced.**
- Opening balances seeded for **WHSE 7** (3X50 RS=53, 2X6 LS=26 @ 2026-03-10) → that is the inventory page's default.

## Key Behaviors
- **READ-ONLY.** No editing, no mutations, no `revalidatePath`. Source of truth is the uploaded file.
- **Production table:** fetches all 752 rows once; filters + date-sort happen client-side (small dataset, no virtualization). Header filters HIDE rows (not sort); date toggle defaults **newest-first**. Sticky glass header (`bg-muted/90 backdrop-blur-sm`).
- **Flec Inventory:** warehouse + start-date drive state via **URL search params** (`?whse=&date=`); changing either `router.replace`s in a `useTransition` → server re-fetch. Start-date semantics made explicit ("Balances as of `<date>` forward"). Balance cards + per-row running-balance ledger ("opening + ins − outs = balance").
- **Error handling (HARD RULE):** every inline error banner is persistent + has a **Copy** button. `error.tsx` boundary likewise. Banners show generic retry/copy guidance (the old "schema not exposed" copy was removed once the public `cenapro_*` accessors went live).
- **Excel Standard:** `table-fixed`, explicit px widths, `px-2 py-1`, `h-8` rows, `text-xs`, `font-mono` right-aligned numerics, `tabular-nums`.
- **Navbar:** registered in `getBreadcrumb()` (`/cenapro`, `/cenapro/production`, `/cenapro/inventory`) + a **separate "Cenapro · Cebu" section** in the Modules dropdown (distinct from "ICTC · Davao").

## Data path (public `cenapro_*` accessors — NOT `.schema('cenapro')`)
The cenapro data is served through **read-only accessors that live in the `public` schema**, which PostgREST already exposes:
- a VIEW `public.cenapro_production_events` (the 16 UI columns)
- two set-returning functions `public.cenapro_flec_balance(...)` / `public.cenapro_flec_ledger(...)`

All three are granted to `authenticated` + `anon`, so the **standard Supabase client reaches them directly** — `supabase.from('cenapro_production_events')` and `supabase.rpc('cenapro_flec_balance'|'cenapro_flec_ledger', …)`. No `.schema('cenapro')`, no structural casts.

**Why this path (and not exposing the `cenapro` schema):** flipping PostgREST's "Exposed schemas" toggle to add `cenapro` would surface the *entire* schema's API surface and is a project-wide setting. Wrapping just the three objects the UI needs as `public.cenapro_*` accessors keeps the blast radius minimal while still giving fully-typed, first-class client access.

**Types:** `types.ts` derives all three row shapes from the generated `types/supabase.ts` (no hand-written interfaces), so they auto-update on every `supabase gen types typescript --linked`:
- `ProductionEventRow = Database['public']['Views']['cenapro_production_events']['Row']`
- `FlecBalanceRow = Database['public']['Functions']['cenapro_flec_balance']['Returns'][number]`
- `FlecLedgerRow = Database['public']['Functions']['cenapro_flec_ledger']['Returns'][number]`

Notes:
- The production `.select(...)` column list MUST be a **single string literal** (not `+`-concatenated) — the typed PostgREST client parses it at the type level to infer the row shape; concatenation defeats inference and falls back to an error type.
- `formatDisposition(disposition: string | null, …)` is typed loosely (string) to consume the generated row types directly; at runtime it's always one of the three known kinds, unknown values render as-is.
- The old `ProductionDailyRow` stopgap interface (for `view_production_daily`) was **removed** — it had no consumer and no matching `public.cenapro_*` accessor in the generated types. Re-derive it from generated types if/when that view is surfaced and exposed.
- **Live data confirmed from Node** via the anon key (2026-06-01): `cenapro_production_events` count = 752; `cenapro_flec_balance(WHSE 7, 2026-03-10)` 3X50/RS `current_flec` = 56; `cenapro_flec_ledger(WHSE 7, 2026-03-10)` = 100 rows, all 16 columns. The browser pages are auth-gated (a `GET /cenapro` returns 307 → login when unauthenticated), so this Node check is the runtime proof short of a logged-in session.

## Dependencies
- `@/lib/supabase/server` — `createClient()` (server Supabase client; reads the public `cenapro_*` view/RPCs directly via `.from()` / `.rpc()`).
- `@/types/supabase` — generated `Database` type; `types.ts` derives the cenapro row shapes from it.
- `@/components/ui/{table,select,card,dropdown-menu,button}` — Shadcn primitives.
- `@/lib/utils` — `cn()`.
- `date-fns` — `format`, `parseISO`, `isValid` (date display only — `yyyy-MM-dd`).
- `sonner` — success toast on error-copy (errors themselves are inline banners per HARD RULE).
- `lucide-react` — icons.

## See Also
- `/Users/renzosy/blackwood/cenapro/CENAPRO_SCHEMA.md` — the authoritative schema contract (tables, `flec_ledger`/`flec_balance`, `view_production_daily`, the 28 ported business rules, DVO deferral).
- [Navbar](../../../components/NAVBAR.md) — page titles / breadcrumbs / Modules dropdown.
- [Production module](../production/CONTEXT.md) — ICTC production; source of the dense-table + `ColumnFilterMenu` patterns reused here.
