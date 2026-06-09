---
name: rc-movement-production-yield
description: RC Movement production-output + yield/loss SQL views (fed vs ICTC produced by grade, monthly yield%)
metadata:
  type: project
---

# RC Movement: Production Output + Yield/Loss Views (2026-06-09)

Migration `supabase/migrations/20260609020000_create_rc_movement_production_yield_views.sql`. 4 additive SECURITY-INVOKER views, GRANT SELECT to authenticated+anon (prior rebuild lost grants & broke a chart — always re-grant).

**Why:** RC Movement matrix needs to connect RC fed (input) to ICTC production output by grade — TOTAL PRODUCED, per-grade produced, monthly yield/loss.

**How to apply:** these are read-only views for the matrix footer/columns. Frontend filters by month and pivots grade rows to columns.

## Views
- `view_rc_movement_production_daily` — (date, grade, produced_kg) = SUM(production_runs.ttl_kg) GROUP BY ps.transaction_date, grade.
- `view_rc_movement_production_daily_total` — (date, produced_kg) all-grades daily sum (gives SQL daily TOTAL so TS never aggregates).
- `view_rc_movement_production_monthly` — (month_start, grade, produced_kg).
- `view_rc_movement_yield_monthly` — (month_start, total_fed, total_produced, yield_pct, loss_kg). total_fed = SUM(rc_out.weight_kg) (FULL OUTER JOIN fed↔produced so fed-only months still appear). yield_pct = produced/NULLIF(fed,0). loss_kg = fed - produced.

## Key facts
- **Fed basis** = SUM(rc_out.weight_kg), NO destination filter — identical to view_rc_movement.fed_today and view_rc_movement_month_price.total_fed. Verified fed_matches=true for all 10 recent months.
- production_runs joins production_shifts via shift_id; shifts hold transaction_date. Production is continuous-tank → aggregated per DAY/MONTH only, never per fed-batch.
- Grades observed (check-constraint allows 3X50/6X50/8X50/2X6): live data has **3X50 (every month), 6X50, 2X6**. 8X50 not yet produced. Grade set is DYNAMIC — frontend must derive columns from rows.
- Spot-check 2026-05: fed 805904, produced 640646 (3X50 564746 + 6X50 75900), yield 79.49%, loss 165258.
- SURPRISE: 2025-09 & 2025-10 have fed but ZERO production (yield 0, full loss) — FULL OUTER JOIN surfaces them. Frontend should tolerate total_produced=0 / yield_pct=0.
