# Supabase Backend Engineer Memory

## deliveries true-weight / deduction columns (schema layer, 2026-06-25) — [[deliveries-true-weight-deduction]]

Migration `20260625000000_add_deliveries_true_weight_deduction_note.sql` (MCP apply, idempotent `ADD COLUMN IF NOT EXISTS`) adds 2 PURELY ADDITIVE DISPLAY-ONLY NULLABLE cols: `true_weight_kg numeric NULL` (gross before ASH+wet; NULL=no deduction; "tagged"=IS NOT NULL) + `deduction_note text NULL`. Both COMMENT-ed. INVARIANTS: `weight_kg`/`cost_basis` stay `numeric NOT NULL` (Sheet-deducted wt + full price), UNTOUCHED; NOTHING computational uses the 2 cols — no trigger/view/balance ever references them (every balance stays on weight_kg); no backfill; RLS unchanged. Piece 1 of 3 (schema only) — sync extractor + UI popover are separate parallel engineers. types regenerated (`true_weight_kg: number|null`, `deduction_note: string|null`). Locked design `DEDUCTIONS_DESIGN.md`. See deliveries-true-weight-deduction.md.

## Blocking "Blend Proposal" data layer (2026-06-19) — [[blend-proposal]]

`fn_blend_proposal(text[])` RPC (migration `20260619000000`, SECURITY INVOKER, GRANT auth+anon) = balance-weighted blend `SUM(stat*balance)/NULLIF(SUM(balance),0)` over `view_blocking_grid WHERE block_loc=ANY()`; price weight FILTERs null avg_php_kg (L-008 safe); 1-row return, empty/no-match → zeros/nulls. Action `buildBlendProposal(blockLocs)` in blocking/actions.ts (+ exports `BlendProposal`/`BlendProposalBlock` for FE): rpc + `.in()` passthrough rows; TS only ×1.30 markup + assembly; gated by canonical `canViewPrices()` (nulls all ₱ pre-return); read-only, no revalidate. types regenerated. See blend-proposal.md.

## Reprocessing excluded from delivery analytics — sundried+refeed+recook (2026-06-16) — [[delivery-sundried-exclusion]]

CANONICAL exclusion (latest migration `20260616031158_exclude_refeed_recook_and_alias_baguio_tipalan.sql`) on all 4 Summaries analytics views: `AND NOT ( (batch_code ILIKE '%SUNDR%' AND COALESCE(remarks,'') NOT ILIKE '%FOR SUNDR%') OR batch_code ILIKE '%REFEED%' OR batch_code ILIKE '%RECOOK%' OR supplier ILIKE '%refeed%'/'%re-feed%'/'%re feed%'/'%recook%'/'%re-cook%'/'%re cook%' )`. Excludes plant REPROCESSING (already-counted-as-incoming): post-sundrying OUTPUT (dried result on SUNDRY batch), refeed (RC tank re-feed), recook. KEEPS all suppliers incl Layupan/SUNDRY BACKLOG + FOR-SUNDRYING inputs. Do NOT filter supplier text for sundry. Final kept: 1,508 rows / 28,926,630.10 kg (refeed/recook = 4 rows/46,629 kg). Evolution: `20260616023550` (over-broad, superseded) → `25308` (sundried keep-inputs) → `30054` (UPPER+TRIM supplier) → `31158` (this: +refeed/recook +Baguio/Tipalan alias, see [[delivery-supplier-analytics]]). Weighting/types untouched. See delivery-sundried-exclusion.md.

## Summaries → By Supplier data layer (2026-06-16) — [[delivery-supplier-analytics]]

2 SECURITY-INVOKER supplier-grain views (migration `20260616000000_create_view_delivery_supplier_analytics.sql`): `view_delivery_supplier_monthly_analytics` (year,month,supplier) + `view_delivery_supplier_yearly_analytics` (year,supplier true weighted rollup). Same L-008 weighting as [[delivery-monthly-analytics]]. Supplier grouping = IMMUTABLE SQL helper `public.canonical_supplier(text)` (single source of truth, used in all 3 supplier views' GROUP BY+label; function-only CREATE OR REPLACE updates every view at once): order-sensitive CASE → (1) tipal/tipla → BAGUIO/TIPALAN; (2) bagui/bagi w/o tipalan → BAGUIO; (3) misdeclare "/" combos (Mercado/Ornales, Mercado/Paquibot, Arbelera/Mercado, Nazarte/Arbelera either order) → ORNALES; (4) "/" combos (Compra/Suarez/Baraquel + Paquibot) → PAQUIBOT; (5) nazareno/nazarino → NAZARENO (typo merge, AFTER combos so Nazarte/Arbelera stays ORNALES); (6) ELSE `COALESCE(NULLIF(UPPER(TRIM()),''),'UNKNOWN')`. Combo clauses need BOTH names → standalones (Mercado/Suarez/Arbelera/Nazarte) stay own supplier, no false positives. Migrations: `20260616062408` (helper+combos) → `20260616063514` (nazareno alias, NAZARENO merged = 10 rows/101,610 kg). THIRD view `view_delivery_supplier_subgroup_yearly_analytics` (year, main_supplier=canonical, subgroup=UPPER(TRIM)) = constituent breakdown. Pure regrouping (3 views' grand totals all = 28,926,630.10 kg). Combos live in 2025: ORNALES +123,749 kg, PAQUIBOT +28,302 kg. Action `fetchSupplierAnalytics()` → `SupplierAnalytics`/`SupplierYearSummary` (now incl `subgroups: SupplierSubgroup[]` {label,weightKg,sacks,deliveries,phpPerKg}, weightKg DESC, price-gated)/`SupplierMonthRow`. Types regenerated (new view emitted). summaries page.tsx+client frontend-owned. See delivery-supplier-analytics.md.

## Analyst Brief (demo4) live data layer (2026-06-15) — [[delivery-monthly-analytics]]

2 SECURITY-INVOKER views over `deliveries` (migration `20260615000000_create_view_delivery_monthly_analytics.sql`): `view_delivery_monthly_analytics` (year,month grain) + `view_delivery_yearly_analytics` (year grain, true weighted footer). avg_price/php_total over `cost_basis>0` ONLY (L-008 placeholder excluded from price, kept in volume); lab metrics volume-weighted with FILTER per-key. Action `app/(app)/price-demos/demo4/actions.ts` `fetchMonthlyDeliveryAnalytics()` shapes 12-month zero-filled axes + price-gates via canViewPrices(). Years in real data: 2020,2022-2026 (no 2021). Only 1 cost_basis=0 row (FEB-26-BLK1). See delivery-monthly-analytics.md.

## Price gating CANONICAL = canViewPrices() (2026-06-15) — [[price-gating]]

`lib/auth.ts` now exports `canViewPrices(): Promise<boolean>` (effective-role gate via getUserRole, respects dev_mock_role cookie, fails closed) + `roleCanViewPrices(role)` pure predicate. Production is the ONLY price-denied role. Phase-0 fix nulled ₱ SERVER-SIDE before payload leaves: RC IN (page.tsx cost_basis — replaced an inline profiles.select that ignored impersonation = leak #3), RC OUT (fetchRcOutTabData avg_price/avg_wtd_value), RC Movement (avgFedPriceDay/avgFedPrice/campaignAvgFedPrice). All return a `canViewPrices` bool for client render. RcOutRow price fields now `number|null`. getRcOutRecords = dead code (ungated but zero callers). Frontend render-hygiene wave still owed. See price-gating.md.

## RC Movement CAMPAIGN re-key (2026-06-09) — [[rc-movement-campaign]]

Matrix re-keyed calendar-month → PRODUCTION CAMPAIGN = (rc_out.production_batch, campaign_year=EXTRACT(YEAR FROM transaction_date)). 8 SECURITY-INVOKER views (options/cells/day_price/price/production_daily/production_daily_total/production/yield), all GRANT authenticated+anon. Migration `20260609030000_create_rc_movement_campaign_views.sql`. KEY: GROUP BY production_batch splits the 5/29 two-campaign day (MAY 11210 + JUNE 10600 same batch JAN-26-BLK10, NOT merged — proven). Exclude production_batch NULL/''. Same key on rc_out (fed) + production_shifts.production_batch (produced) for yield. SURPRISE: production data only Dec-2025+ → all 2025 Apr–Nov campaigns FED-NO-PRODUCTION (yield 0). view_rc_movement + _batch_price untouched. types regenerated. See rc-movement-campaign.md.

## RC Movement PRODUCTION + YIELD views (2026-06-09) — [[rc-movement-production-yield]]

4 SECURITY-INVOKER views connecting RC fed to ICTC production output by grade. Migration `20260609020000_create_rc_movement_production_yield_views.sql`, GRANT authenticated+anon. produced=SUM(production_runs.ttl_kg) via shift_id→production_shifts.transaction_date; fed=SUM(rc_out.weight_kg) (matches view_rc_movement_month_price.total_fed, verified). yield/daily/monthly grains. Grades live: 3X50/6X50/2X6 (dynamic). 2025-09/10 have fed-no-production (FULL OUTER JOIN). See rc-movement-production-yield.md.

## RC Movement FED PRICE views (2026-06-09) — [[rc-movement-fed-price]]

3 additive SECURITY-INVOKER views (day/month/batch grain) for weighted-avg fed price, all from deliveries.cost_basis (NOT batches.avg_cost). Migration `20260609010000_create_rc_movement_fed_price_views.sql`, GRANT to authenticated+anon. KEY FINDING: batches.avg_cost is STALE for some live batches (JAN-26-BLK11 off ₱3.13/kg) — always compute cost from deliveries in SQL. See rc-movement-fed-price.md.

## Daily Sync Digest backend (2026-06-04) — [[digest-backend]]

New `/` route (replaces widget dashboard). 12 `view_digest_*` SQL views (all aggregation here, SECURITY INVOKER) + `lib/digest/queries.ts` `getDigestData(): Promise<DigestData>` (shapes rows only). Contract `lib/digest/types.ts` (do NOT edit). operationalDate=latest day with ANY data (lags calendar). Employee parse in `view_digest_audit_enriched`: named-mgr BEFORE provenance fallback. Migration `20260604000000_create_digest_views.sql`. See digest-backend.md.

## Lean Sync Orchestrator — token-lean ICTC sync (2026-06-02) — [[lean-sync-orchestrator]]

Refactored gsheet-sync to a two-phase Python orchestrator (`scripts/sync_gsheet.py`) on a shared PostgREST helper (`scripts/lib/db.py`, service-role key from .env.local) so the agent reads only a compact `decisions_<mode>.json` (~1k tokens) instead of the full DB dump + classified JSON (~349k tokens) — >99% reduction, proven read-only (idempotent). Apply phase replicates trigger contract: deliveries cost_basis=0 placeholder (L-008), never `current_weight +=` (L-005/6), UPDATE trigger audit row (L-001); rc_out manual audit. Other 4 employees designed in `LEAN_SYNC_REFACTOR.md`. See lean-sync-orchestrator.md.

## Cenapro = Tenant #2, isolated `cenapro` schema (2026-06-01) — [[cenapro-schema]]

v1 DB foundation built on branch `feat/cenapro-integration`: dedicated `cenapro` Postgres schema, fully walled from ICTC (verified `public` md5 unchanged). 8 tables + 1 view + 4 functions + unique_tag trigger. Migrations `20260601113339_create_cenapro_schema` + `..40_harden..` + `..41_add_public_cenapro_accessors`. Flec ledger = SQL set-returning fns `flec_ledger`/`flec_balance(warehouse, start_date)` (no balance math in TS). DIVERGENCE: added `batch_year int` (effective identity = (batch, batch_year)) per Renzo. **EXPOSURE SOLVED (2026-06-01) WITHOUT the dashboard toggle: 3 thin READ-ONLY SECURITY-INVOKER `public.cenapro_*` look-through accessors** (view `cenapro_production_events` + fns `cenapro_flec_balance`/`cenapro_flec_ledger`) — supabase-js reads them in the served `public` schema; `types/supabase.ts` now emits them (no cenapro namespace); frontend can drop the `(client as any)` stopgap. cenapro data/logic untouched. Backfill loaded (752 pe). **WRITE PATH (2026-06-01, migration `..342`): Cenapro now the MAINTAINING app** — production edits via the auto-updatable `public.cenapro_production_events` view (`GRANT INS/UPD/DEL`, base trigger fires through it; chose view over RPC); opening balances reworked APPEND-ONLY (dropped UNIQUE → plain index, latest-effective = greatest period_start_date≤D tie-broken by created_at DESC, flec_ledger seed updated, 56 still holds) with 3 new `public.cenapro_*` accessors (`set_opening_balance`/`opening_balances`/`opening_balance_history`). Types regenerated. See cenapro-schema.md.

## Blocking phantom-inventory fix (2026-05-31) — [[blocking-current-weight-drift]]

`view_blocking_grid.balance` now computes `SUM(deliveries)−SUM(rc_out)` (migration 20260531041520), NOT `batches.current_weight`. Root cause of ~54t phantom: the **deliveries-manager ingestion path** did an imperative `current_weight += weight` ON TOP of the trigger (L-001 family) — triggers were CORRECT, not changed. 3 active batches re-synced (20260531041615). Key lesson: when debugging cache drift, prove trigger vs imperative by checking if rows from the *same trigger* on a *different ingestion run* are also wrong — if only one run's rows drift by exactly their own value, it's an external `+= delta`. See blocking-current-weight-drift.md.

## Production Module Schema (2026-05-28 parent-child restructure) — [[production-module-schema]]

4 tables + 3 views. `production_shifts` is parent; production_runs/downtime/waste are FK-children via `shift_id`. SKS columns dropped from production_waste. view_production_daily rewritten to join via shift_id. Migrations: 040000 + 040001. Row counts: 158 shifts / 207 runs / 158 downtime / 158 waste — all data preserved. Daily tab UI still uses old schema — pending frontend rebuild. types/supabase.ts regenerated via MCP. See production-module-schema.md.

## Jarvis Ingestion Pipeline Phase A (2026-05-27) — [[jarvis-ingestion-pipeline]]

`ingestion_watermarks` table applied. RC Deliveries extractor, classifier, diff engine, review queue actions shipped. `xlsx` v0.18.5. Key patterns: `Json as unknown as T[]` for JSONB casts; `(admin as any).from()` for generic table queries. See jarvis-ingestion-pipeline.md.

## Jarvis Foundation (2026-05-26) — [[jarvis-foundation]]

Migration `20260526020000_create_jarvis_tables` applied. 4 tables: jarvis_conversations, jarvis_messages, jarvis_learnings, pending_review. Server actions in `app/(app)/jarvis/actions.ts`. Anthropic SDK v0.98 requires TextBlockParam/ToolUseBlockParam (not TextBlock/ToolUseBlock) when building stored-message history. See jarvis-foundation.md for full details.

## RC Movement Feature (2026-05-25) — [[project-rc-movement]]

Migration + server action on disk, pending DB apply (project was paused during session).
Migration: `supabase/migrations/20260525000000_create_view_rc_movement.sql`
Action: `app/(app)/inventory/rc-movement/actions.ts`
After DB unpauses: run `supabase db push --include-all` then `supabase gen types typescript --linked > types/supabase.ts`, then remove the `(supabase as any)` cast in actions.ts (~lines 91-115).

## RLS Policy Conventions (2026-03-02)

### Core Tables: deliveries, batches, rc_out
**Migration:** `fix_rls_require_authenticated`

All three tables previously had `{public}` role policies (anonymous access). Fixed to `{authenticated}` only. Pattern used:
- SELECT: `TO authenticated USING (true)`
- INSERT: `TO authenticated WITH CHECK (true)`
- UPDATE: `TO authenticated USING (true) WITH CHECK (true)`
- DELETE: `TO authenticated USING (true)`

The `USING (true)` / `WITH CHECK (true)` advisor warnings are intentional — app-layer role checks handle data scrubbing beyond authentication. Do NOT add row-level predicates to these policies.

### Views: view_blocking_grid, view_rc_in_master
Both are `SECURITY INVOKER` (Postgres default for views). They inherit RLS from underlying tables — no separate policy needed. Owner is `postgres`. Neither has SECURITY DEFINER.

## Database Schema Insights

### user_table_settings Table (Added 2026-02-18)

**Migration:** `create_user_table_settings`

- `id` uuid PK, `user_id` uuid FK→auth.users (CASCADE), `module` text DEFAULT 'rc_in', `settings` jsonb DEFAULT '{}', `updated_at` timestamptz
- UNIQUE constraint: `uq_user_module (user_id, module)`
- RLS enabled: SELECT/INSERT/UPDATE policies — all use `auth.uid() = user_id`
- Index: `idx_uts_lookup ON (user_id, module)`
- **Types file:** `types/table-settings.ts` — `RcInTableSettings`, `DensityMode`, `LabMetric`, `HeatLevel`, `RangeSpec`, `DEFAULT_RC_IN_SETTINGS`, utility fns (`getHeatLevel`, `getHeatTint`, `getHeatLabel`, `getStateDotClass`)

### Batch Status Management (Updated 2026-02-17)

**Critical Discovery:** The `batch_status` enum drives the STATE column in RC IN. Status is now **fully derived from RC OUT data** via the `fn_process_blackwood_usage` trigger, with one exception: SUNDRIED is set by `fn_update_blackwood_state` on RC IN deliveries.

**Status Values:**
- `STORED` — default for new batches, no rc_out entries
- `IN-USE` — batch has rc_out entry with `destination='MAIN'`, no CLOSED remarks
- `CLOSED` — batch has ANY rc_out with `remarks ILIKE '%CLOSED%'` (regardless of destination)
- `SUNDRYING` — batch has rc_out with `destination='SUNDRY'`, no CLOSED remarks
- `SUNDRIED` — SUNDRY batch that has received deliveries but has no rc_out entries (sundrying complete, material stored)

**Priority Order:** CLOSED > SUNDRYING > IN-USE > SUNDRIED > STORED

**CLOSED takes absolute priority** — a batch with both SUNDRY destination AND CLOSED remark becomes CLOSED, not SUNDRYING.

**SUNDRIED Semantics:** SUNDRIED means "sundrying process complete, material received and stored." It is set by `fn_update_blackwood_state` when a delivery is added to a SUNDRY batch that is currently in STORED status. When RC OUT usage is recorded against a SUNDRIED batch, it moves to SUNDRYING (if destination='SUNDRY') or IN-USE (if destination='MAIN'). When all RC OUT records are deleted, it falls back to SUNDRIED (not STORED) because it's a SUNDRY batch.

**Note on FEED:** The `FEED` enum value still exists in `batch_status` but is no longer actively set by triggers (as of 2026-02-15). FEED location is indicated by the WHSE column in RC IN (derived from `block_loc` starting with 'F'), not by batch status. FEED batches follow the same status rules as other batches.

### Trigger: fn_process_blackwood_usage (2026-02-18 Preserve-CLOSED Fix)

**File:** Located in `supabase/migrations/` — full rewrite 2026-02-15, CLOSED priority fix 2026-02-17, preserve-CLOSED guard 2026-02-18

**Operations Supported:**
1. **INSERT** — Optimized, checks only new row, depletes weight, sets status
2. **DELETE** — Adds weight back, **recalculates** status from remaining rc_out records
3. **UPDATE** — Adjusts weight delta, **recalculates** status; handles batch_id changes

**Key Behavior:**
- Block location (`block_loc`) auto-copied from `batches.location_ref` if not provided
- Status recalculation uses `EXISTS` queries with priority cascade
- UPDATE/DELETE operations query ALL rc_out records to determine correct state
- If batch_id changes during UPDATE, BOTH old and new batches are recalculated

**CLOSED-Preservation Guard (2026-02-18):** Migration `fix_preserve_closed_status_on_rc_out_edit`. The UPDATE section has a guard AFTER the `new_status := CASE ... END` block that prevents a CLOSED batch from being reopened if a replacement batch already occupies its location. Without this, editing an rc_out record on a CLOSED batch (e.g. clearing its remarks) would recompute status to SUNDRYING/IN-USE and violate `idx_unique_active_batch_per_location`. Guard fires when: batch is CLOSED + same batch_id + new_status != CLOSED + another active batch at the same location_ref. Same guard applied to OLD.batch_id in the batch_id-change sub-block.

**Status Priority (CRITICAL):** CLOSED > SUNDRYING > IN-USE > SUNDRIED > STORED
- **CLOSED remark ALWAYS takes highest priority** — regardless of destination
- INSERT CASE statement checks `NEW.remarks ILIKE '%CLOSED%'` FIRST, before destination checks
- This ensures SUNDRY + CLOSED → CLOSED (not SUNDRYING)
- DELETE/UPDATE fallback: checks if batch is SUNDRY (`batch_code ILIKE '%SUNDRY%'`) before defaulting to STORED
- Migration `fix_closed_remark_priority_in_rc_out_trigger.sql` (2026-02-17) fixed the INSERT logic

**Common Pitfall:** Previously, the RC IN batch upsert **overrode** trigger-managed status back to 'STORED'. This was fixed by removing the `status` field from `upsertBatchesFromRows()` in `app/(app)/inventory/rc-in/actions.ts` (line 17).

### Trigger: fn_update_blackwood_state (2026-02-18 DELETE + location_ref Fix)

**File:** Located in `supabase/migrations/` — fixed to handle UPDATE operations on 2026-02-16, SUNDRIED status added 2026-02-17, current_weight recalculation added 2026-02-17, DELETE trigger registration + location_ref clear added 2026-02-18

**Trigger registration fix (2026-02-18):** `tr_blackwood_delivery` had `tgtype=23` (BEFORE INSERT OR UPDATE only) — DELETE handler code existed but never fired. Migration `fix_delivery_delete_trigger` dropped and recreated it as BEFORE INSERT OR UPDATE OR DELETE (`tgtype=31`).

**Operations Supported:**
1. **INSERT** — Incremental weighted average for `avg_cost`, `quality_stats`, `current_weight`; sets SUNDRIED for SUNDRY batches
2. **UPDATE** — Recalculates `avg_cost` AND `current_weight` (delivery total − rc_out total) from scratch
3. **DELETE** — Recalculates `avg_cost` AND `current_weight`; clears `location_ref = ''` and resets `status = 'STORED'` if no deliveries remain for the batch

**Critical INSERT Behavior (SUNDRIED Status):**
- After updating avg_cost/quality_stats, checks if `batch_code ILIKE '%SUNDRY%'` AND batch status is STORED
- If both conditions are true, upgrades status to SUNDRIED
- This only upgrades from STORED → SUNDRIED (won't override IN-USE or CLOSED)

**Critical UPDATE Behavior:**
- When `batch_code` changes: recalculates BOTH old and new batches from all their deliveries
- When `cost_basis` or `weight_kg` changes (same batch): recalculates that batch from all its deliveries
- Uses full aggregation query: `SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0)`

**current_weight Formula (DELETE/UPDATE):**
```sql
current_weight = SUM(deliveries.weight_kg WHERE batch_code = X)
               - SUM(rc_out.weight_kg JOIN batches WHERE batch_code = X)
```

**BEFORE trigger gotcha — always exclude OLD.id in DELETE existence checks:**
In a BEFORE DELETE trigger, the row being deleted still exists in the table. An `EXISTS (SELECT 1 FROM deliveries WHERE batch_code = OLD.batch_code)` check will always find OLD row itself and return true. Always add `AND id != OLD.id` to exclude it when checking whether any deliveries remain.

**Why the Fixes Were Needed:**
- DELETE/UPDATE handlers only recalculated `avg_cost` — `current_weight` was never updated on edits/deletes → fixed 2026-02-17
- Migration `fix_delivery_trigger_current_weight` (2026-02-17) added current_weight to DELETE/UPDATE handlers
- Migration `recalculate_all_batch_weights` (2026-02-17) one-time fixed all stale current_weight values
- INSERT handler was left untouched (it correctly does incremental += already)
- `tr_blackwood_delivery` was BEFORE INSERT OR UPDATE only — DELETE handler was dead code → fixed 2026-02-18
- DELETE handler did not clear `location_ref` on last-delivery removal → blocking grid showed ghost batches → fixed 2026-02-18
- The original fix history: trigger added UPDATE support in `fix_delivery_trigger_handle_updates.sql` (2026-02-16)

**Data Cleanup:** If batches have stale avg_cost, run:
```sql
UPDATE batches b
SET avg_cost = COALESCE(calc.avg, 0)
FROM (
  SELECT batch_code, SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0) as avg
  FROM deliveries
  GROUP BY batch_code
) calc
WHERE calc.batch_code = b.batch_code;
```

### Batches Table: Key Schema Facts

- `location_ref` is **NOT NULL** — empty string `''` is the sentinel for "no location" (cannot use NULL)
- When clearing location on CLOSED batches: `SET location_ref = ''` not `NULL`
- `status` is nullable with default `'STORED'::batch_status`
- No `updated_at` column exists in the current schema (trigger sets it — actually it does exist per trigger code; verify if issues arise)

### Blocking Integrity Constraints (Added 2026-02-17)

**Migration:** `add_blocking_integrity_constraints`

- `chk_block_loc_format` on `deliveries`: `block_loc IS NULL OR block_loc ~ '^[A-DF]-\d{1,2}[A-D]$'`
- `chk_location_ref_format` on `batches`: `location_ref = '' OR location_ref ~ '^[A-DF]-\d{1,2}[A-D]$'`
- `idx_unique_active_batch_per_location`: partial unique index on `batches(location_ref)` WHERE status IN ('STORED','IN-USE') AND location_ref != ''

**Format pattern:** `^[A-DF]-\d{1,2}[A-D]$` — WHSE A/B/C/D/F, hyphen, 1-2 digit column, letter row A-D

**Pre-constraint cleanup done:**
- Test/QA batches closed: `test`, `TEST_RT_BATCH`, `QA_NOTIF_TEST_001`, `QA_POLL_TEST_002`, `FEB-26-TEST1`, `JAN-25-BLK01`
- Empty string `block_loc` values → NULL (85 rows cleaned)
- Duplicate active locations resolved: keep highest `current_weight`, close others

### View: view_blocking_grid (Updated 2026-02-17)

**Migration:** `update_view_blocking_grid_dedup`

Uses `DISTINCT ON (b.location_ref)` ordered by `current_weight DESC` to guarantee one row per location.

**Columns:** `batch_id`, `batch_code`, `block_loc`, `status`, `balance`, `php_per_kg`, `bd`, `ash`, `mc`

**Note:** Previous view had different column aliases (`avg_php_kg`, `avg_mc`, etc.) and more columns. The blocking module expects the new aliases. Drop + recreate was required (not `CREATE OR REPLACE`) because columns were removed.

### View: view_rc_in_master

**Columns Include:** `state` (aliased from `batches.status`)

**Query Pattern:**
```sql
SELECT *, batches(location_ref, status) FROM deliveries
```

Always fetch BOTH `location_ref` and `status` when querying deliveries for the RC IN module.

### Enum Addition Best Practice

PostgreSQL requires enum values to be committed before use in function definitions. Always split enum additions into separate migrations:
1. Migration 1: `ALTER TYPE batch_status ADD VALUE 'NEW_VALUE';`
2. Migration 2: Function/trigger updates that reference the new value

**Error if violated:** `unsafe use of new value "X" of enum type`

## RC OUT Module Architecture (2026-02-17 Refactor)

### fetchRcOutTabData() Server Action

**Location:** `app/(app)/inventory/rc-out/actions.ts`, line ~226

**Purpose:** Lazy-loads ALL rc_out records on first tab render (when user switches to Usage tab). No date scoping — loads entire dataset.

**Return Shape:**
```ts
{
  records: RcOutRow[];        // ALL rc_out records, desc by transaction_date
  batches: Batch[];           // for bulk input batch resolution
  destinations: string[];     // distinct rc_out.destination values
  batchOptions: string[];     // plain production_batch codes (no year annotations)
  yearOptions: number[];      // distinct years from transaction_date, descending
  blockLocs: string[];        // union of rc_out.block_loc + batches.location_ref, natural sorted
}
```

**Key Implementation Details:**
1. **Paginated fetch with `fetchAll()`** — bypasses PostgREST 1000-row `max_rows` cap
2. **Full join query:** Same select as `getRcOutRecords()` with batches join + generated columns
3. **Flattening logic:** Handles array vs single object for `batches` join (same pattern as `getRcOutRecords`)
4. **Natural sort for blockLocs:** `localeCompare(_, _, { numeric: true })` ensures "A1" < "A10"
5. **Derived filters:** `destinations`, `batchOptions`, `yearOptions` all computed from `records` — no separate queries
6. **blockLocs union:** Fetches BOTH `rc_out.block_loc` AND `batches.location_ref` (paginated), deduplicates, natural sorts

**Data Volume:** 1,414 rc_out records — same ballpark as RC IN, proven safe with fetchAll + TanStack Virtual.

**Previous Behavior (Removed 2026-02-17):**
- Month-based date scoping with `startDate`/`endDate` from `date-fns`
- Year annotations in `allBatchOptions` (e.g., "OCTOBER (2024, 2025)")
- Separate query for `productionBatchesRaw` with transaction_date join
- Returned `year`, `month` strings

**Why Removed:**
- RC OUT table already uses infinite scroll (not month-based pagination)
- Client-side filtering handles year/month selection via footer controls
- Loading ALL data upfront enables instant filter changes (no refetch needed)
- Year annotations were redundant — batch codes are unique enough without year labels

## RC IN Module Architecture

### Batch Upsert Strategy

**Location:** `app/(app)/inventory/rc-in/actions.ts`, function `upsertBatchesFromRows()`

**Pattern:**
1. Map delivery rows to batch upsert payload (`batch_code`, `location_ref`)
2. Deduplicate via JS Map keyed by `batch_code`
3. Upsert with `onConflict: 'batch_code'`
4. **DO NOT include `status`** — DB default ('STORED') + trigger handle state

**Critical Rule:** Never send `status` in batch upserts. The trigger owns state management.

### Data Flow for STATE Column

1. User submits deliveries → `submitBulkDeliveries()` action
2. Batches upserted → default status = 'STORED'
3. User creates RC OUT entry → `fn_process_blackwood_usage` trigger fires
4. Trigger updates batch status based on RC OUT data
5. RC IN page queries `deliveries` with `batches(status)` join
6. Frontend displays color-coded STATE badges

### Type Definitions

**File:** `types/rc-in.ts`

**Key Types:**
- `DeliveryRow` — includes optional `state?: string`
- `DeliveryHistoryRow` — extends DeliveryRow, includes `batches?: { location_ref: string; status: string }`
- Always map `(d as any).batches?.status || 'STORED'` to `state` in page.tsx

## Common Debugging Patterns

### Verify Trigger Behavior

```sql
-- Check trigger is active
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'tr_blackwood_usage';

-- View function source
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'fn_process_blackwood_usage';
```

### Verify Status Distribution

```sql
SELECT status, COUNT(*) FROM batches GROUP BY status ORDER BY count DESC;
```

Expected distribution post-migration (2026-02-15):
- Initial (after STATE rewrite): CLOSED: 258, STORED: 154, FEED: 73, IN-USE: 5, SUNDRYING: 3
- After FEED removal: CLOSED: 322, STORED: 159, IN-USE: 9, SUNDRYING: 3 (0 FEED)

### Test Trigger Operations

```sql
-- Test INSERT (should set SUNDRYING)
INSERT INTO rc_out (batch_id, destination, weight_kg, transaction_date)
SELECT id, 'SUNDRY', 100, '2026-01-01' FROM batches WHERE batch_code = 'TEST-BATCH';

-- Test DELETE (should recalculate to STORED if no other rc_out records)
DELETE FROM rc_out WHERE id = '<rc_out_id>';

-- Verify batch status changed
SELECT batch_code, status FROM batches WHERE batch_code = 'TEST-BATCH';
```

## Migration History

### 2026-02-15: STATE Column Rewrite

**Migrations:**
1. `20260214173510_rewrite_state_column_derive_from_rc_out.sql` — Add SUNDRYING enum
2. `20260214173709_rewrite_trigger_view_and_data_fix.sql` — Rewrite trigger, update view, fix data
3. `20260215XXXXXX_remove_feed_status_from_triggers.sql` — Remove FEED from trigger logic

**Changes:**
- Added SUNDRYING to batch_status enum
- Rewrote fn_process_blackwood_usage to handle INSERT/UPDATE/DELETE
- Updated view_rc_in_master to include `state` column
- One-time data fix recalculated all batch statuses from rc_out data
- Removed status from batch upsert in RC IN actions
- Updated RC IN page to fetch and map batch status
- Updated DeliveryHistoryRow type to include status
- Removed FEED priority checks from both fn_process_blackwood_usage and fn_update_blackwood_state
- Recalculated all FEED batches to proper status based on rc_out records

**Files Modified:**
- `supabase/migrations/` (3 migrations)
- `app/(app)/inventory/rc-in/actions.ts` (line 17 — removed status)
- `app/(app)/inventory/rc-in/page.tsx` (line 30, 79 — added status)
- `app/(app)/inventory/rc-in/CONTEXT.md` (removed FEED from status list)
- `app/(app)/inventory/rc-out/CONTEXT.md` (removed FEED from trigger priority)
- `types/rc-in.ts` (line 27 — added status to batches type)
- `types/supabase.ts` (regenerated)

## PostgREST Query Limits (2026-02-16 Discovery)

### max_rows Cap: 1000

PostgREST has a server-side `max_rows` setting (default 1000) that **silently truncates** result sets regardless of client-side `.limit()` values. This caused RC OUT filter queries with `.limit(5000)` to return only the first 1000 rows alphabetically.

**Impact:** With 1,414 RC OUT rows where 1,395 are "MAIN" destination, alphabetical ordering meant the first 1000 were ALL "MAIN" — so rare values like "MAN", "MIAN", and "SUNDRY" (17 rows) never appeared in filter dropdowns.

**Fix Pattern: Paginated `.range()` Loops**

```ts
const PAGE = 1000;
async function fetchAll<T>(buildQuery: () => any): Promise<T[]> {
    let all: T[] = [];
    let from = 0;
    let hasMore = true;
    while (hasMore) {
        const { data } = await buildQuery().range(from, from + PAGE - 1);
        all = all.concat(data || []);
        hasMore = (data?.length || 0) === PAGE;
        from += PAGE;
    }
    return all;
}

// Usage
const destinations = await fetchAll<{ destination: string }>(() =>
    supabase.from('rc_out').select('destination').not('destination', 'is', null).order('destination')
);
```

**Applied in:** `app/(app)/inventory/rc-out/actions.ts` `fetchRcOutTabData()` — all 3 filter queries (destinations, production_batch, block_loc) now use paginated fetch.

**When to Use:** Any filter/autocomplete query that needs to collect ALL unique values from a table with >1000 rows.

## Supabase CLI Patterns

### Type Regeneration

Always run after schema changes:
```bash
supabase gen types typescript --linked > types/supabase.ts
```

### Migration Workflow

1. Create migration: `supabase migration new <descriptive_name>`
2. Write idempotent SQL (use `IF NOT EXISTS`, `CREATE OR REPLACE`)
3. Apply via MCP: `mcp__supabase__apply_migration`
4. Verify with diagnostic queries
5. Regenerate types

### Verification After Deployment

1. Check enum values: `SELECT unnest(enum_range(NULL::batch_status))::text;`
2. Check data distribution: `SELECT status, COUNT(*) FROM batches GROUP BY status;`
3. Test CRUD operations on rc_out and verify batch status updates
4. Run `npm run build` to catch type errors

## Performance Notes

### Trigger Efficiency

The rewritten trigger uses `EXISTS` subqueries for status recalculation. For large datasets:
- INSERT is optimized (no subqueries, direct CASE evaluation)
- DELETE/UPDATE are slower (must scan rc_out table for each batch)

**Monitoring:** If rc_out grows large (>10k records per batch), consider:
- Indexing `rc_out(batch_id, destination, remarks)` for EXISTS queries
- Debouncing bulk deletes/updates to reduce trigger invocations

### View Performance

`view_rc_in_master` uses LEFT JOIN on batches. No indexing needed (batch_code is unique key).

## Related Modules

- **RC OUT:** Creates rc_out records that trigger batch status updates
- **RC IN:** Displays batch status in STATE column (read-only, no manual override)
- See `app/(app)/inventory/rc-in/CONTEXT.md` and `rc-out/CONTEXT.md` for module details
