---
name: rc-movement-fed-price
description: RC Movement weighted-avg FED PRICE views (day/month/batch grains) + the avg_cost-is-stale finding
metadata:
  type: project
---

# RC Movement FED PRICE views (2026-06-09)

Migration `20260609010000_create_rc_movement_fed_price_views.sql`. Three ADDITIVE
SECURITY-INVOKER views (view_rc_movement left untouched). GRANT SELECT to authenticated+anon.

- `view_rc_movement_day_price` (date, wtd_fed_price, total_fed) — per-row column (A)
- `view_rc_movement_month_price` (month_start date, wtd_fed_price, total_fed) — footer (B)
- `view_rc_movement_batch_price` (batch_id, batch_code, batch_price) — per-block footer (C)

All three share a `batch_cost` CTE: batch_price = SUM(cost_basis*weight_kg)/NULLIF(SUM(weight_kg),0)
from **deliveries**, NOT batches.avg_cost. Same basis for A/B/C so numbers are consistent.

## KEY FINDING: batches.avg_cost is STALE for some live batches
**Why:** 4/432 rc_out batches mismatch computed weighted-avg cost. Worst: JAN-26-BLK11 stored
avg_cost=42.44 vs true 45.57 (off ₱3.13/kg). Recent Jan-2026 batches affected — the live data
a dashboard shows. The trigger fn_update_blackwood_state maintains avg_cost but edge cases
(documented imperative-ingestion += path in blocking-current-weight-drift) drift it.
**How to apply:** for ANY price/cost feature, compute weighted-avg cost from deliveries.cost_basis
in SQL — do NOT trust batches.avg_cost. Blocking module already does this. No null/zero avg_cost
and no zero-cost deliveries among rc_out batches, so the computed basis is clean.

## Frontend query shapes (for next agent)
- (A) per-day for a month: `.from('view_rc_movement_day_price').select('date,wtd_fed_price,total_fed').gte('date',monthStart).lt('date',nextMonthStart)`
- (B) the month: `.from('view_rc_movement_month_price').select('wtd_fed_price,total_fed').eq('month_start',monthStartISO).maybeSingle()` (month_start = 'YYYY-MM-01')
- (C) per-batch: `.from('view_rc_movement_batch_price').select('batch_id,batch_price').in('batch_id',ids)`
wtd_fed_price/batch_price are NULL for zero-fed days/blocks (NULLIF guard) — handle null in UI.
