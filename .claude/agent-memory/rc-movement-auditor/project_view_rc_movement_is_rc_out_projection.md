---
name: view-rc-movement-is-rc-out-projection
description: view_rc_movement.fed_today summed per date is always identical to SUM(rc_out.weight_kg) per date — the view is a pure projection of rc_out, not an independent source.
metadata:
  type: project
---

`view_rc_movement` is a derived projection of `rc_out`, NOT an independent data source.

Empirically verified 2026-05-30 across 22 dates (2026-04-30 → 2026-05-28): for every date,
`SUM(view_rc_movement.fed_today)` == `SUM(rc_out.weight_kg)` exactly (diff = 0 on all dates).
`fed_today` is the per-batch row weight; the view just adds running balances, pct_loss, php, and feed_day_n on top of the same rc_out rows.

**Why:** The audit protocol (Step 5) frames "RC MOVEMENT vs view_rc_movement" as a separate
cross-check axis from "RC MOVEMENT vs rc_out sums" (Step 4). In practice these two axes are the
SAME comparison — the view cannot diverge from rc_out per-date totals because it is built from them.
The only meaningful drift axis is RC MOVEMENT (the email/xlsx) vs the DB (rc_out == view).

**How to apply:** Don't report "view vs rc_out" as an independent reconciliation result — it will
always be 0 and pads the report. Use view_rc_movement for what only IT exposes: per-batch
`balance_after` (negative = over-consumption), `cum_fed` vs deliveries_total, `pct_loss`,
`feed_day_n`, and batch-level attribution of a daily drift. Use rc_out for the daily-sum drift
vs RC MOVEMENT. See [[anomaly-negative-balance-batches-are-preexisting]].
