---
name: cenapro-schema
description: Cenapro = Tenant #2, isolated `cenapro` Postgres schema (v1 foundation). Schema layout, the PostgREST exposure gap, the batch_year divergence, the flec ledger functions.
metadata:
  type: project
---

# Cenapro — Tenant #2 (isolated `cenapro` Postgres schema)

Built 2026-06-01 on branch `feat/cenapro-integration`. Authoritative design doc: `/Users/renzosy/blackwood/cenapro/CENAPRO_SCHEMA.md`. Cenapro is the second tenant on the Blackwood platform (CI / Cebu charcoal), **fully walled off from ICTC** — it lives in a dedicated `cenapro` Postgres schema, zero FKs/triggers/enums touch `public.*`. DVO subsystem deferred in v1 (WHSE 3, SRC=DVO rows parked in drift_log).

**Why:** Renzo's hard requirement — Cenapro must be "separate from any ICTC db… unique to itself while living in the Blackwood Supabase db." Verified isolation by snapshotting `public` table md5 (`c5f03245e6c606fe534247b2317f6089`, 22 base tables) before+after; unchanged.

**How to apply:** When working on Cenapro, stay inside `cenapro.*`. NEVER add a cross-schema FK to `public`. The `branch` column on plant/warehouse (values 'CI'/'ICTC') is a *label only*, not a coupling.

## Migrations (on disk, applied to remote)
- `supabase/migrations/20260601113339_create_cenapro_schema.sql` — schema, 6 lookups+seed, production_event spine, warehouse_opening_balance, drift_log, unique_tag trigger, flec_ledger/flec_balance, view_production_daily, grants.
- `supabase/migrations/20260601113340_harden_cenapro_function_search_path.sql` — pins `SET search_path = ''` on all 4 cenapro functions (clears `function_search_path_mutable` advisor). Safe: bodies schema-qualify everything; only pg_catalog built-ins otherwise.
- **Filename-vs-tracked-version mismatch:** MCP `apply_migration` recorded them under its own timestamps (`20260601033734_create_cenapro_schema`, and a second). The on-disk files use `20260601113339/40`. Same DDL; just note when reconciling `list_migrations` vs disk.

## Objects (cenapro.*)
- **Lookups (text `code` PK, FK-by-code):** shift (3: M/E/N), grade (4: 3X50/2X6/3.5/4X8), plant (4: W6/W7/W6\/W7/DVO), warehouse (5: WHSE 1/2/3/5/7), source_location (8: TNK 1-4/W6/W7/FLEC/DVO), partner_equipment (8: C1-C4 crushers, RK1-RK4 kilns). 33 seed rows total. **partner_equipment is the downstream partner's machines, NOT quality classes** (CENAPRO_PRODUCTION_ANALYSIS.md got this wrong — ignore it).
- **production_event** — the spine. uuid PK; `unique_tag` is audit/export-only (never a join key); partner-equipment-presence CHECK; disposition_kind ∈ flec_bagging/partner_crusher/partner_kiln.
- **warehouse_opening_balance** — seeds the flec ledger (most-recent opening ≤ start date).
- **drift_log** — append-only telemetry (DVO rows, unique_tag collisions, cosmetic WHSE=W6/W7). NEVER auto-create lookups; humans resolve drift.
- **Trigger `tr_cenapro_pe_unique_tag`** (BEFORE INSERT/UPDATE) → `fn_set_unique_tag()`: persists `unique_tag`, auto-derives `batch_year`, bumps `updated_at`.

## DIVERGENCE from the doc — `batch_year` (Renzo-requested)
Doc §12 Q2 left batch identity open (working default: bare month text + rely on dates). Renzo overrode: **every batch is disambiguated by year, effective identity = (batch, batch_year)**. So `production_event` has `batch_year int NOT NULL`, auto-derived from `recv_date` by the trigger when not supplied, with advisory index `idx_cenapro_pe_batch_identity (batch, batch_year)`. `view_production_daily` surfaces+groups by it. **`unique_tag` kept byte-for-byte workbook parity** (Excel-serial date segments already encode the year) — batch_year is the queryable first-class column, NOT a new tag segment.

## unique_tag format (byte-for-byte workbook parity, Q5 default)
`concat_ws('-', recv_serial, prod_serial-or-blank, batch, shift, grade, plant, warehouse, whse_side-blank-DVO_SIDE, src, FLEC|partner_code)`. Excel serial = `date - DATE '1899-12-30'`. e.g. 2026-03-10 → 46091. Blank DVO_SIDE renders as `--` exactly like the sheet. Verified live.

## flec ledger = SQL set-returning functions (no balance math in TS)
- `cenapro.flec_ledger(p_warehouse_code text, p_start_date date)` — WHSE 1/2/5/7 only (`default_unit='flec_count'`). Start-date-scoped: seed = most-recent opening ≤ start; rows = events ≥ start; running_balance = seed + windowed SUM(flec_in − flec_out) per (grade, side). Direction derived from typed columns (disposition_kind + source.kind), NOT the workbook substring trick. Returns inputs alongside output (opening_seed, flec_in/out_to_date) for information-density.
- `cenapro.flec_balance(p_warehouse_code, p_start_date)` — last running_balance per (grade, side); wraps flec_ledger. A (grade, side) with an opening but no events ≥ start produces NO row → the adapter must left-join the opening seed to show current_flec = opening_seed.
- Verified live: opening 50 + bag 10 − partner-pull 4 from FLEC source = closing 56. Both run on empty data returning 0 rows, no crash.
- Call from a server action: `supabase.schema('cenapro').rpc('flec_ledger', { p_warehouse_code, p_start_date })`.

## PostgREST exposure — SOLVED via public.* accessors (2026-06-01), NOT the dashboard toggle
A non-`public` schema is NOT reachable by supabase-js, and `gen types` does NOT emit it, until `cenapro` is in the API "Exposed schemas" list. We CANNOT flip that: the managed `authenticator` role has NO `pgrst.db_schemas` rolconfig at all (controlled at the platform config layer; `ALTER ROLE authenticator SET pgrst.db_schemas` is denied), the hosted Supabase MCP is OAuth-based (no extractable mgmt token), and Renzo won't toggle the dashboard. **RESOLUTION: thin READ-ONLY `public.cenapro_*` look-through accessors** (migration `20260601113341_add_public_cenapro_accessors`, MCP version `20260601074957`). cenapro stays the sole home of data + ALL business logic; `public` gets only windows. The cenapro SQL grants ARE applied (USAGE + SELECT/INSERT/UPDATE/DELETE for authenticated+service_role, SELECT for anon, EXECUTE on functions, default privileges), which is exactly why the accessors can be SECURITY INVOKER.

### The 3 accessors (all in `public`, all SECURITY INVOKER, granted to authenticated+anon+service_role)
- **VIEW `public.cenapro_production_events`** (`WITH (security_invoker=true)`) — 16 UI-consumed cols of `cenapro.production_event`: id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag. (Deliberately omits provenance/dirty/source_row/notes/flec_stat/timestamps.) Frontend: `supabase.from('cenapro_production_events')`.
- **FUNCTION `public.cenapro_flec_balance(p_warehouse_code text, p_start_date date)`** — 1:1 passthrough of `cenapro.flec_balance`, identical 6-col TABLE. Frontend: `supabase.rpc('cenapro_flec_balance', { p_warehouse_code, p_start_date })`.
- **FUNCTION `public.cenapro_flec_ledger(p_warehouse_code text, p_start_date date)`** — 1:1 passthrough of `cenapro.flec_ledger`, identical 16-col TABLE. Frontend: `supabase.rpc('cenapro_flec_ledger', { … })`.

### Why SECURITY INVOKER (not DEFINER): VERIFIED
`authenticated` already holds `has_schema_privilege(...,'cenapro','USAGE')=t`, SELECT on `production_event`, EXECUTE on both cenapro fns (themselves INVOKER). Proven by `SET LOCAL ROLE authenticated` + `SET LOCAL ROLE anon` — both read all 3 accessors (pe=752, balance=2 rows, ledger=100 rows, 3X50/RS current=56). So an invoker chain works end-to-end with ZERO privilege escalation; the caller reads cenapro only via its own grants → tenant isolation intact. DEFINER would add ambient authority + need a pinned search_path to be safe — unnecessary here. Public fns still pin `SET search_path=''` (schema-qualified bodies) purely to clear the `function_search_path_mutable` advisor. Advisor check post-apply: the only new findings are 2 WARN `pg_graphql_*_table_exposed` on the view (intended GraphQL cost of the anon/auth SELECT grant, same as every ICTC table) — NO new ERROR, NO `security_definer_view`, NO search-path WARN.

**Types regen DONE via MCP `generate_typescript_types`** (CLI `gen types --linked` still fails here — needs a DB password we lack; MCP route works). Because the accessors live in the served `public` schema, `types/supabase.ts` now emits them WITHOUT a `cenapro` namespace: `Database['public']['Views']['cenapro_production_events']` + `Database['public']['Functions']['cenapro_flec_balance' | 'cenapro_flec_ledger']`. **Frontend can drop the `(client as any)` stopgap** (the [[project-rc-movement]] pattern) for these three reads. NOTE: only these 3 read shapes are surfaced — any NEW cenapro column/function the UI needs requires ADDING/widening a `public.cenapro_*` accessor (the dashboard toggle is still the only thing that would expose the whole schema, and it remains un-flipped).

## WRITE PATH — Cenapro is now the MAINTAINING app (2026-06-01, migration `..342`)
Migration `supabase/migrations/20260601113342_cenapro_write_path_and_opening_balance_history.sql` (MCP applied; recorded under its own timestamp via `apply_migration`). Turns the read-only accessors editable. Layers cleanly on `..341`. ICTC untouched; advisor shows NO new ERROR and NO finding on any new object — `public.cenapro_production_events` is NOT in the `security_definer_view` ERROR list (stays INVOKER), the 3 new fns have no search-path WARN.

### Part A — production writes via the AUTO-UPDATABLE public view (chose view, NOT RPC)
`public.cenapro_production_events` was ALREADY auto-updatable (`information_schema.views`: is_insertable_into=YES, is_updatable=YES, is_trigger_*=NO — simple single-table projection, all 16 cols individually updatable). So the migration just `GRANT INSERT, UPDATE, DELETE ... TO authenticated` (it previously had SELECT only). **No INSTEAD OF trigger, no RPC fallback needed.** Verified by a rolled-back `SET LOCAL ROLE authenticated` test: INSERT through the view (omitting unique_tag + batch_year) fires the base BEFORE trigger → unique_tag `46127-46126-APRIL-M-3X50-W6-WHSE 5-LS-TNK 2-FLEC` + batch_year 2026, defaults fill provenance=cenapro_xlsb/dirty=true; UPDATE warehouse_code WHSE 5→7 recomputes the tag's warehouse segment; DELETE → 0. Frontend: `supabase.from('cenapro_production_events').insert()/.update()/.delete()/.upsert()` (types now carry Insert/Update blocks — drop any `(client as any)`). unique_tag + batch_year are trigger-set — a client value is overwritten.

### Part B — opening balances now APPEND-ONLY (full history, never overwrite)
- Dropped `cenapro_wob_natural_key UNIQUE (warehouse_code, grade_code, side, period_start_date)`; replaced with PLAIN index `idx_cenapro_wob_cell` (the DESC `idx_cenapro_wob_seed_lookup` stays — it's what the ledger/accessors scan). Table is now append-only: every "set" = a NEW row; nothing UPDATEd/DELETEd. `created_at` is the within-date tiebreak.
- **Effective opening as of D = greatest period_start_date ≤ D, tie-broken by greatest created_at.** `cenapro.flec_ledger` seed subquery ORDER BY changed `period_start_date DESC` → `period_start_date DESC, ob.created_at DESC` (only change to the body; SET search_path='' kept). `flec_balance` + the public passthroughs inherit it unchanged. **Verified 53→56 invariant STILL HOLDS.** Tiebreak proven: re-setting 3X50/RS on the SAME date 2026-03-10 to 99 → accessor + ledger seed both become 99, closing balance 102 (rolled back).
- 3 new `public` accessors (all SECURITY INVOKER, `SET search_path=''`):
  - **`public.cenapro_set_opening_balance(p_warehouse_code, p_grade_code, p_side, p_effective_date date, p_count int)`** — INSERTS a new append-only entry, RETURNS the row. EXECUTE→authenticated, service_role. Frontend: `supabase.rpc('cenapro_set_opening_balance', {...})`.
  - **`public.cenapro_opening_balances(p_warehouse_code, p_as_of_date date)`** — CURRENT effective opening per (grade, side) as of the date (DISTINCT ON (grade,side) ORDER BY period_start_date DESC, created_at DESC). Drives the editable STARTING block. EXECUTE→authenticated, anon, service_role.
  - **`public.cenapro_opening_balance_history(p_warehouse_code)`** — ALL entries (id, grade, side, period_start_date, opening_flec_count, created_at) newest-first per (grade,side), for backtracking. EXECUTE→authenticated, anon, service_role.
- Verified as `authenticated` (rolled back): two sets for (WHSE 1,3X50,LS) at 2026-01-01/100 + 2026-03-01/250 → `cenapro_opening_balances(...,'2026-02-15')`=100, `(...,'2026-05-01')`=250, history count=2.

### Types regen (DONE via MCP `generate_typescript_types`, written to types/supabase.ts)
Because everything lives in served `public`: `Database['public']['Views']['cenapro_production_events']` now has Insert/Update blocks (write-enabled), and `Database['public']['Functions']` gained `cenapro_set_opening_balance` / `cenapro_opening_balances` / `cenapro_opening_balance_history`. Full project `tsc --noEmit -p tsconfig.json` passes clean.

## Backfill (loaded 2026-06-01) — from `2025 CI PRODUCTION V2.xlsb`
Parser: `scripts/cenapro/backfill_from_xlsb.py` (pure parser→SQL generator, never hits DB). Emits `backfill_cenapro.sql`; re-chunk into `scripts/cenapro/chunks/stmt_*.sql` (16 stmts: 8 production_event UPSERTs + 1 opening + 1 drift-DELETE-then-INSERT + 6 drift INSERTs). Apply each via MCP `execute_sql` (schema still PostgREST-unexposed → no client path). Everything idempotent (UPSERT on `unique_tag`; opening UPSERT; drift = `DELETE WHERE resolved_at IS NULL` then re-insert) → re-applying the whole set is SAFE.
- **Final loaded counts: production_event 752, warehouse_opening_balance 2, drift_log 631.** Reconcile: 752 + hard-excluded drift (145 dvo + 7 legacy + 4 validity + 1 collision = 157) = 909 real rows.
- **PARSER EDIT (this session):** `bagging_missing_warehouse` (181 rows where older sheets put the plant code in WHSE) changed from DROP → INSERT with `warehouse_code=NULL`/`whse_side=NULL` + an INFORMATIONAL `bagging_warehouse_unknown` drift entry. These are real production, just unplaced — they correctly never appear in `flec_ledger` (joins on warehouse_code). Implemented via `validity()` returning a 3rd `unplaced` flag; effective `side` computed BEFORE unique_tag so the tag's side segment matches the stored NULL (byte-parity + collision-dedup correctness). `validity_violation` now = 4 (only genuinely-impossible: 2 bagging_from_flec + 2 partner_flec_bad_warehouse). DVO (145) / legacy_missing_src (7) / unique_tag_collision (1) exclusions unchanged.
- **CHUNKER GOTCHA:** drift unique_tags contain literal `--` (empty-segment joins, e.g. `45999----3X50`). A chunker that strips inline `--` comments to find the statement-terminating `;` will mangle these and collapse all drift INSERTs into one blob. Detect statement end by the RAW line ending in `;` — do NOT split on `--`. The only true inline comment is on the drift DELETE line; Postgres ignores it.
- **Ledger spot-check (codo parity):** `flec_ledger('WHSE 7','2026-03-10')` 3X50/RS: opening_seed 53, first event bagging +33 → running_balance 66; net 53 + 1023 in − 1020 out = closing **56** (`flec_balance` current_flec). 2X6/LS opens 26, fully consumed to 0 by 2026-03-21. Matches the codo reference exactly.
- ICTC untouched: `public` schema md5 `b7beac891f3c0a0794d7c388bc164dde` (27 tables / 257 cols incl views) identical before+after the load.

## Advisors
No cenapro ERROR-level findings. The `pg_graphql_*_table_exposed` WARNs on cenapro tables are the intended consequence of the anon/authenticated SELECT grants (every ICTC table has them too). No RLS in v1 by design (ICTC production-module parity) — policies are additive later if needed.
