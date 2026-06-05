---
name: digest-backend
description: Daily Sync Digest backend — view_digest_* SQL views + lib/digest/queries.ts (getDigestData) feeding the new / route that replaces the widget dashboard
metadata:
  type: project
---

# Daily Sync Digest backend (2026-06-04)

Replaces the old modular widget dashboard at `/`. Backend-only deliverable: SQL views + typed server query module. Frontend agent builds UI against `getDigestData()`.

**Why:** the `/` dashboard pivoted from composable widgets to a "Daily Sync Digest" (today's ops numbers + sync-health from audit_logs provenance).

**How to apply:** all aggregation is in the views; `lib/digest/queries.ts` only shapes rows. If the contract `lib/digest/types.ts` (DigestData) changes, update queries.ts mapping — do NOT move math into TS.

## Files
- Migration: `supabase/migrations/20260604000000_create_digest_views.sql` (applied as TWO MCP migrations: `create_digest_views` + `create_digest_helper_views`).
- Query module: `lib/digest/queries.ts` — `getDigestData(): Promise<DigestData>`. Uses `@/lib/supabase/server` `createClient()` (server client is UNTYPED — not `<Database>` — so view `.from()` calls compile loosely; I declare explicit row interfaces).
- Contract (do NOT edit): `lib/digest/types.ts`.

## Views (all SECURITY INVOKER, SELECT→authenticated)
- `view_digest_operational_days` — 1 row {operational_date, prev_operational_date}. operational = latest day with ANY data across deliveries/rc_out/production_shifts/electricity (UNION + ROW_NUMBER). prev = 2nd-latest such day (NOT op-1).
- `view_digest_stream_freshness` — per-stream max date (deliveries/rc_out/production/electricity/trucks).
- `view_digest_daily_flow` — zero-filled calendar series, in_kg/out_kg per day (generate_series from min delivery/rc_out date → operational_date). Source for FlowPoint + rc_in/rc_out/net_flow KPIs+sparks.
- `view_digest_daily_price` — weighted avg ₱/kg = sum(w*cost)/sum(w), **WHERE cost_basis > 0** (excludes L-008 gsheet placeholders).
- `view_digest_daily_production` — sum production_runs.ttl_kg per shift transaction_date.
- `view_digest_daily_power` — sum electricity consumption_kwh per reading_date.
- `view_digest_grades` — production by (date, grade).
- `view_digest_mtd` — MTD rollup for the OPERATIONAL month (not calendar today). label via to_char(...,'FMMonth YYYY').
- `view_digest_audit_enriched` — audit_logs + parsed employee + provenance (regexp_match 'provenance=(\w+)'). **Employee priority: Deliveries Manager > Production Manager/table production*/electricity/truck > rc-out-manager > gsheet-sync keyword > provenance=gsheet fallback > other.** Named-employee BEFORE provenance so "Price enrichment by Deliveries Manager ... gsheet" → deliveries-manager, not gsheet-sync.
- `view_digest_latest_sync` + `view_digest_latest_sync_by_employee` — counts for max(performed_day).
- `view_digest_rcin_daystats` — suppliers + sacks per day (rc_in KPI sub-line).
- `view_digest_unpriced_recent` — count cost_basis=0 in trailing 30d of operational date (missing_price flag).

## Flags (derived in queries.ts, light logic only)
- stale_stream (warn): stream throughDate lags operationalDate > 2 days. Trucks currently fires (7d behind).
- missing_price (info): unpriced count > 0 (currently 0).
- conflict (warn): audit comment in last 7d matching flag|conflict|held|UNMAPPED.

## Live sample (2026-06-02 operational)
rc_in 10865kg (prev 20450, -46.9%); rc_out 35666 (prev 34705); production 26520 (prev 21060); power 672kWh (prev 684); net_flow -24801. price 38.00₱/kg. MTD June: in 31315 / out 70371 / prod 47580. latestSync 2026-06-03: 9 ins/2 upd/0 del (production-manager 5, gsheet-sync 3, deliveries-manager 2, rc-out-manager 1).

## Gotchas
- ActivityItem.id is `number` in the contract but audit ids are uuids → queries.ts hashes uuid→positive int32 (`hashId`). Frontend should treat it as an opaque key, not a DB id.
- `npx tsc --noEmit` passes clean. Types regenerated via `supabase gen types typescript --linked` (16 view_digest refs in types/supabase.ts).
