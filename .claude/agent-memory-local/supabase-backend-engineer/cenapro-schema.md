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

## PostgREST exposure — THE pending manual step (blocks types + supabase-js)
A non-`public` schema is NOT reachable by supabase-js, and `supabase gen types` does NOT emit it, until `cenapro` is in the API "Exposed schemas" list. The migration's defensive `ALTER ROLE authenticator SET pgrst.db_schemas=...` **did not stick** (insufficient privilege on managed Supabase — expected). **Renzo must do it manually: Dashboard → Settings → API → Exposed schemas → add `cenapro`.** SQL grants ARE applied (USAGE + SELECT/INSERT/UPDATE/DELETE for authenticated+service_role, SELECT for anon, EXECUTE on functions, default privileges), so the schema is query-ready the instant exposure is toggled.

**Types regen is BLOCKED until exposed.** Verified BOTH the MCP generator and `supabase gen types typescript --linked` emit ZERO cenapro — they only see exposed schemas. `types/supabase.ts` was deliberately left unchanged (overwriting with public-only output would be a useless no-op). After Renzo flips the toggle: re-run `supabase gen types typescript --linked > types/supabase.ts` → it gains a `Database['cenapro']` namespace. Until then, Cenapro server actions use `(client as any)` casts (same stopgap pattern as [[project-rc-movement]]).

## Backfill (loaded 2026-06-01) — from `2025 CI PRODUCTION V2.xlsb`
Parser: `scripts/cenapro/backfill_from_xlsb.py` (pure parser→SQL generator, never hits DB). Emits `backfill_cenapro.sql`; re-chunk into `scripts/cenapro/chunks/stmt_*.sql` (16 stmts: 8 production_event UPSERTs + 1 opening + 1 drift-DELETE-then-INSERT + 6 drift INSERTs). Apply each via MCP `execute_sql` (schema still PostgREST-unexposed → no client path). Everything idempotent (UPSERT on `unique_tag`; opening UPSERT; drift = `DELETE WHERE resolved_at IS NULL` then re-insert) → re-applying the whole set is SAFE.
- **Final loaded counts: production_event 752, warehouse_opening_balance 2, drift_log 631.** Reconcile: 752 + hard-excluded drift (145 dvo + 7 legacy + 4 validity + 1 collision = 157) = 909 real rows.
- **PARSER EDIT (this session):** `bagging_missing_warehouse` (181 rows where older sheets put the plant code in WHSE) changed from DROP → INSERT with `warehouse_code=NULL`/`whse_side=NULL` + an INFORMATIONAL `bagging_warehouse_unknown` drift entry. These are real production, just unplaced — they correctly never appear in `flec_ledger` (joins on warehouse_code). Implemented via `validity()` returning a 3rd `unplaced` flag; effective `side` computed BEFORE unique_tag so the tag's side segment matches the stored NULL (byte-parity + collision-dedup correctness). `validity_violation` now = 4 (only genuinely-impossible: 2 bagging_from_flec + 2 partner_flec_bad_warehouse). DVO (145) / legacy_missing_src (7) / unique_tag_collision (1) exclusions unchanged.
- **CHUNKER GOTCHA:** drift unique_tags contain literal `--` (empty-segment joins, e.g. `45999----3X50`). A chunker that strips inline `--` comments to find the statement-terminating `;` will mangle these and collapse all drift INSERTs into one blob. Detect statement end by the RAW line ending in `;` — do NOT split on `--`. The only true inline comment is on the drift DELETE line; Postgres ignores it.
- **Ledger spot-check (codo parity):** `flec_ledger('WHSE 7','2026-03-10')` 3X50/RS: opening_seed 53, first event bagging +33 → running_balance 66; net 53 + 1023 in − 1020 out = closing **56** (`flec_balance` current_flec). 2X6/LS opens 26, fully consumed to 0 by 2026-03-21. Matches the codo reference exactly.
- ICTC untouched: `public` schema md5 `b7beac891f3c0a0794d7c388bc164dde` (27 tables / 257 cols incl views) identical before+after the load.

## Advisors
No cenapro ERROR-level findings. The `pg_graphql_*_table_exposed` WARNs on cenapro tables are the intended consequence of the anon/authenticated SELECT grants (every ICTC table has them too). No RLS in v1 by design (ICTC production-module parity) — policies are additive later if needed.
