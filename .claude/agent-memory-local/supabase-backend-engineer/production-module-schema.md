---
name: production-module-schema
description: Production domain DB schema — 5 tables + 3 views applied 2026-05-27. Natural keys, CHECK constraints, GENERATED columns.
metadata:
  type: project
---

## Applied migrations (2026-05-27)

- `supabase/migrations/20260527010000_create_production_tables.sql`
- `supabase/migrations/20260527010001_create_production_views.sql`

## Tables

### production_runs
Natural key: `(transaction_date, grade, shift)`
- grade CHECK IN ('3X50','6X50','8X50','2X6')
- shift CHECK IN ('M','E','N')
- ttl_kg NOT NULL >= 0
- sacks_bags integer nullable
- no destination/customer column — CEBU is implicit, extractor strips "CEBU " prefix

### production_downtime
Natural key: `(transaction_date, shift)`
- shift_hrs NOT NULL > 0
- dt_hrs/dt_mins NOT NULL DEFAULT 0 with range checks
- dt_reason text nullable (from MC email, NOT in MASTER)
- dt_ttl_hrs and productive_hrs computed in view_production_daily, NOT stored

### production_waste
Natural key: `(transaction_date, shift)`
- 8 streams: rs1a, rs1b, bf, rs23, rs5, trml1, trml2, grit
- _kg columns: numeric NOT NULL DEFAULT 0 CHECK >= 0
- _sacks columns: text nullable (mixed types in source: "3 bags" vs integer)
- grit has NO sacks column per design doc
- ttl_waste_kg and prod_loss_pct computed in view_production_daily, NOT stored

### electricity_readings
Natural key: `(reading_date, meter)`
- meter is TEXT not enum — MAIN/BUNKHOUSE/PUMP confirmed, others may exist
- diff_kwh is GENERATED ALWAYS AS (end_kwh - start_kwh) STORED
- rate_php_per_kwh DEFAULT 120

### truck_readings
Natural key: `(reading_date, plate_no)`
- ttl_km is GENERATED ALWAYS AS (end_km - start_km) STORED
- fuel_liters nullable

## Views

### view_production_daily
Full outer join of production_runs (aggregated to shift level via CTE) + production_downtime + production_waste.
Key design choices:
- runs_agg CTE collapses multiple grade rows per (date, shift) into one using FILTER pivots
- waste_totals CTE pre-computes total_waste_kg to avoid repeating the 8-term sum
- FULL OUTER JOIN ensures rows appear even if only one sub-table has data
- prod_loss_pct = total_waste_kg / (total_output_kg + total_waste_kg)

### view_electricity_monthly
GROUP BY DATE_TRUNC('month', reading_date)::date, meter
month_diff_kwh = MAX(end_kwh) - MIN(start_kwh) — handles daily accumulation correctly

### view_trucks_monthly
GROUP BY DATE_TRUNC('month', reading_date)::date, plate_no
month_km = SUM(ttl_km) — captures all daily legs

## Permissions
All 5 tables + 3 views: GRANT SELECT TO authenticated
All 5 tables: GRANT INSERT, UPDATE, DELETE TO authenticated
No RLS — follows existing project pattern (auth at role-check layer via lib/auth.ts)

## types/supabase.ts
Regenerated via `mcp__supabase__generate_typescript_types` and written directly.
Note: `supabase gen types typescript --linked` CLI fails on this machine (requires SUPABASE_DB_PASSWORD). Use MCP generate + Write instead.

## Advisor notes
- "unused_index" warnings for the new date indexes — expected, tables are empty
- "RLS disabled" is expected — intentional by design
- All other warnings (auth_rls_initplan, multiple_permissive_policies) are pre-existing and not introduced by this migration

**Why:** Production Manager agent (Phase 2+) will INSERT into these tables via Supabase MCP service-role calls. No FK references to other tables — production_batch is a text field (month name like 'MAY'), not linked to batches table.
