-- =====================================================================
-- Digest drill-down breakdown views — RC OUT · PRODUCTION · POWER
-- =====================================================================
-- Three sibling views to `view_digest_rcin_supplier_daily` (migration
-- 20260828032427), built in the SAME idiom and for the SAME reason: the
-- drill-down modal shows ONE breakdown dimension per tile, and PostgREST
-- aggregate functions are DISABLED on this project (a `weight_kg.sum()`
-- select returns PGRST123), so a grouped read has exactly one door — a view.
--
-- Each view is:
--   * windowed to a TRAILING 400 DAYS from the Asia/Manila calendar date,
--     with NO upper bound (a future-dated row is never invisible);
--   * `security_invoker`, SELECT to `authenticated` only, `anon` revoked;
--   * NOT granted to `service_role` — the sync worker does not read any of
--     them (L-044's arrow direction: a consumer downstream of the same table
--     is not a dependency). `scripts/verify-worker-view-grants.ts` must still
--     report 4 views / 0 findings after this migration;
--   * kept to a MINIMAL dependency closure — the relations named in its own
--     FROM and nothing else. None of them touches
--     `view_digest_operational_days`, so `authenticated`'s existing SELECT on
--     the base tables is the whole readability requirement.
--
-- WHY 400 DAYS AND NOT date_trunc('year') — unchanged from the RC IN view.
-- The drill-down resolves three ranges against the operational date: 30d, 90d
-- and "This year". A year-anchored floor serves only the third: on 5 January
-- it sits at 25 December while the 90-day range still reaches back to
-- ~7 October, and two thirds of that window would fall outside the view and
-- understate SILENTLY. A fixed trailing window has to cover max(365, 90) days,
-- so 400 is that plus five weeks of headroom.
--
-- NO ₱ ANYWHERE. `rc_out`'s computed price columns (`rc_out_avg_price`,
-- `rc_out_avg_wtd_value`) are deliberately NOT selected and nothing here is
-- divisible into a price, so all three views are safe for EVERY role including
-- Production and need no `canViewPrices()` gate at the server action. Keep it
-- that way: a ₱ column here turns an ungated surface into a leak.
--
-- =====================================================================
-- 1. view_digest_rcout_batch_daily — WHAT WAS FED, not WHERE IT WENT
-- =====================================================================
-- THE BREAKDOWN-IDENTITY DECISION, AND THE MEASUREMENT BEHIND IT.
-- The obvious candidate dimension for RC OUT is `destination`. Measured over
-- the 400-day window (2026-08-28):
--
--     MAIN     1,188 rows   10,185,287 kg   (93.8% of rows, 94.9% of kg)
--     SUNDRY      78 rows      552,629 kg
--
-- Two values, one of which is essentially the whole table. A rail ranked by
-- destination would print one bar every day and say nothing — the same
-- non-information as the blocking grand total that equalled the sum of its
-- parts. What actually varies day to day is WHICH PILE was drawn down, so the
-- grain is the BATCH (and the block it sits in), and `destination` rides along
-- as a COLUMN rather than the ranking key.
--
-- Carrying it as a column is FREE, measured: over the same window the row
-- count is 1,255 whether you group by (date, batch) alone, by (date, batch,
-- block_loc), or by (date, batch, block_loc, destination) — identical. Within
-- one (date, batch) pair the block and the destination are constant in every
-- live row, so adding them to the GROUP BY splits nothing. It is still in the
-- GROUP BY rather than a `min()`, so the day a batch IS fed to two
-- destinations the row splits honestly instead of labelling a mixed total with
-- one of its halves. And SUNDRY is worth showing: a sundry move is charcoal
-- going to sun-drying, not into the plant, and the tile total contains both.
--
-- `block_loc` is NEVER NULL in `rc_out` but is BLANK ('') on 491 of the 1,266
-- windowed rows, so it is normalized with `NULLIF(btrim(...), '')` — a blank
-- string rendered in a rail reads as a missing label, a NULL reads as "not
-- recorded", and only one of those is true. The GROUP BY uses the same
-- normalized expression so two blank spellings can never rank as two blocks.
-- (`batches.location_ref` would fill 245 of those, but it is CLEARED by
-- `fn_update_blackwood_state` when a batch loses its last delivery, so it
-- describes the batch NOW, not where this feeding came from. Not used.)
--
-- The join to `batches` is on `rc_out.batch_id`, which is NOT NULL with an FK,
-- so the INNER JOIN cannot drop a row — which is what makes the day totals
-- agree with `view_digest_daily_flow.out_kg` exactly. `batch_code` is UNIQUE on
-- `batches`, so grouping by the code rather than the id cannot merge two
-- batches either.
--
-- AGREEMENT (measured 2026-08-28): sum(kg) per day equals
-- `view_digest_daily_flow.out_kg` on 121 of 121 days of the flow window, max
-- gap 0.00 kg, zero mismatches, and zero days exist on either side that the
-- other lacks — by construction, both being unfiltered sums of
-- `rc_out.weight_kg` grouped by `transaction_date`. NET FLOW and the Feed In vs Out card are
-- therefore derivable in the adapter as (RC IN daily − RC OUT daily) with no
-- fourth view.
--
-- ROW BUDGET (measured 2026-08-28): 1,255 rows over the full 400-day window;
-- 830 for 2026 YTD; 251 for the trailing 90 days; 1,056 for the whole of 2025.
-- READ THIS BEFORE WIRING THE ADAPTER: unlike the RC IN supplier view (820
-- rows / 400d), this grain is ~4.2 rows per operating day, so a "This year"
-- read LATE in a heavy year approaches ~1,250 rows and PostgREST's hard cap is
-- 1,000. The adapter MUST include this read in its `truncated` test (the
-- existing ROW_CAP mechanism, which is 1000 precisely because the server's cap
-- is), so a floor is never presented as a total. If an exact full-year batch
-- ranking is ever required, add a MONTHLY companion view — do not raise the
-- limit, which cannot work.
-- =====================================================================

CREATE OR REPLACE VIEW public.view_digest_rcout_batch_daily
WITH (security_invoker = true) AS
SELECT
  r.transaction_date                      AS transaction_date,
  b.batch_code                            AS batch_code,
  NULLIF(btrim(r.block_loc), '')          AS block_loc,
  r.destination                           AS destination,
  sum(r.weight_kg)::numeric               AS kg,
  count(*)::int                           AS feeding_count
FROM public.rc_out r
JOIN public.batches b ON b.id = r.batch_id
WHERE r.transaction_date >= ((now() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '400 days')::date
GROUP BY r.transaction_date, b.batch_code, NULLIF(btrim(r.block_loc), ''), r.destination;

COMMENT ON VIEW public.view_digest_rcout_batch_daily IS
  'One row per (transaction_date, batch_code, block_loc, destination) over public.rc_out joined to '
  'public.batches for the code, windowed to a trailing 400 days from the Asia/Manila calendar date. '
  'THE breakdown grain behind the RC OUT drill-down rail. The ranking dimension is the BATCH/BLOCK '
  'fed, NOT the destination: measured 2026-08-28 the window is 93.8% MAIN by row and 94.9% by kg, so '
  'a destination rail would print one bar and say nothing. destination is carried as a column '
  '(measured free: the row count is 1,255 with or without it and block_loc in the GROUP BY) and stays '
  'in the GROUP BY so a batch fed to two destinations splits honestly. block_loc is NULLIF-btrimmed '
  'because rc_out stores blanks, not NULLs, for an unrecorded block. Unfiltered otherwise: sum(kg) '
  'per day equals view_digest_daily_flow.out_kg over the same range (measured 121/121 days). Carries '
  'NO price column — rc_out''s computed rc_out_avg_price / rc_out_avg_wtd_value are deliberately not '
  'selected — so it is safe for every role including Production. Not granted to service_role: the '
  'sync worker does not read it. ROW BUDGET: 1,255 rows / 400d, 830 for 2026 YTD, 1,056 for all of '
  '2025 — a late-in-year "This year" read can approach PostgREST''s 1000-row cap, so the caller must '
  'include this read in its truncation test.';

GRANT SELECT ON public.view_digest_rcout_batch_daily TO authenticated;
REVOKE ALL ON public.view_digest_rcout_batch_daily FROM anon;

-- =====================================================================
-- 2. view_digest_production_grade_daily
-- =====================================================================
-- One row per (transaction_date, grade). The date lives on the SHIFT parent
-- (`production_shifts.transaction_date`), not on the run — the same join
-- `view_digest_daily_production` and `view_digest_grades` already use, and the
-- INNER JOIN from `production_runs` is what carries the digest's established
-- "a production day is a day with a `production_runs` CHILD" rule
-- (`view_digest_stream_reported_days`, migration 20260714000000) into this view
-- for free: a shift filed with no runs contributes nothing here, exactly as it
-- reports nothing there. Do not weaken that by starting the FROM at
-- `production_shifts`.
--
-- `view_digest_grades` already groups (date, grade, shift) but is windowed to
-- 120 days off the operational date and splits the grain by shift, which is a
-- stacking detail for the small card, not a ranking. This view keeps the grain
-- at (date, grade) and reports the shift spread as `shift_count`.
--
-- `sacks` IS DELIBERATELY NULLABLE AND NOT COALESCED TO 0. Measured
-- 2026-08-28: 218 of the 324 windowed runs carry a NULL `sacks_bags`. A
-- COALESCE(...,0) would print "0 bags" for a grade whose bag count was simply
-- never recorded, which is the NULL≠0 mistake this codebase has now refused
-- three times (the L-008 unpriced `cost_basis`, `avg_cost`, the actual-fed
-- ₱/kg). `runs_with_sacks` says how much of the grade's output the bag figure
-- actually covers, so the UI can qualify it instead of guessing.
--
-- AGREEMENT (measured 2026-08-28): sum(kg) per day equals
-- `view_digest_daily_production.kg` on 93 of 93 days of that view's window,
-- zero mismatches, and zero days exist on either side that the other lacks.
-- (93, not 121 like the flow view: `view_digest_daily_production` emits only
-- days that actually produced — it has no zero-filled calendar spine — so its
-- 120-day window contains 93 rows.)
--
-- ROW BUDGET (measured 2026-08-28): 282 rows over 400 days, 4 distinct grades
-- (3X50 dominant at 5,328,548 kg; 6X50, 2X6, 4X8). Nowhere near the 1000-row
-- cap at any range.
-- =====================================================================

CREATE OR REPLACE VIEW public.view_digest_production_grade_daily
WITH (security_invoker = true) AS
SELECT
  ps.transaction_date                     AS transaction_date,
  pr.grade                                AS grade,
  sum(pr.ttl_kg)::numeric                 AS kg,
  count(*)::int                           AS run_count,
  count(DISTINCT ps.shift)::int           AS shift_count,
  sum(pr.sacks_bags)::int                 AS sacks,
  count(pr.sacks_bags)::int               AS runs_with_sacks
FROM public.production_runs pr
JOIN public.production_shifts ps ON ps.id = pr.shift_id
WHERE ps.transaction_date >= ((now() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '400 days')::date
GROUP BY ps.transaction_date, pr.grade;

COMMENT ON VIEW public.view_digest_production_grade_daily IS
  'One row per (transaction_date, grade) over public.production_runs joined to its '
  'public.production_shifts parent for the date, windowed to a trailing 400 days from the Asia/Manila '
  'calendar date. THE by-grade grain behind the PRODUCTION drill-down rail. The INNER JOIN from runs '
  'carries the digest''s "a production day has a production_runs child" rule (view_digest_stream_'
  'reported_days) — do not start the FROM at production_shifts. sum(kg) per day equals '
  'view_digest_daily_production.kg over the same range (measured 93/93 reported days). sacks is NULLABLE and '
  'NOT coalesced to 0: 218 of 324 windowed runs have no sacks_bags, and 0 would claim zero bags where '
  'the truth is "not recorded" — read runs_with_sacks for the coverage. Carries NO price column. Not '
  'granted to service_role: the sync worker does not read it. ROW BUDGET: 282 rows / 400d.';

GRANT SELECT ON public.view_digest_production_grade_daily TO authenticated;
REVOKE ALL ON public.view_digest_production_grade_daily FROM anon;

-- =====================================================================
-- 3. view_digest_power_meter_daily
-- =====================================================================
-- One row per (reading_date, meter). `kwh` is `sum(consumption_kwh)` — the SAME
-- column `view_digest_daily_power` sums, checked rather than assumed, so the
-- modal total can never disagree with the POWER tile. `consumption_kwh` is the
-- multiplier-applied figure, not the raw meter movement: measured on the MAIN
-- meter, 943,260 kWh consumption against 7,860.5 of raw `diff_kwh` — a factor
-- of 120. Summing `diff_kwh` here would report a number 120× smaller than the
-- tile with nothing on screen to explain it, so the raw movement is carried
-- separately as `raw_diff_kwh` (context only, never the headline).
--
-- `(reading_date, meter)` is the table's natural key, so the sum is over
-- exactly one row today; it is written as an aggregate anyway so a future
-- duplicate reading adds instead of one silently winning.
--
-- MEASURED SHAPE (2026-08-28), because a breakdown rail with one bar needs
-- explaining rather than fixing: three meters exist — MAIN (315 readings,
-- 943,260 kWh, through 2026-08-26), BUNKHOUSE (115, 204,660) and PUMP (115,
-- 55,044) — but BUNKHOUSE and PUMP were LAST REPORTED 2025-12-12. So a 30d or
-- 90d range legitimately shows MAIN alone, and only a long range shows all
-- three. That is the data, not a bug in the view.
--
-- AGREEMENT (measured 2026-08-28): sum(kwh) per day equals
-- `view_digest_daily_power.kwh` on 94 of 94 reported days, zero mismatches, and
-- zero days exist on either side that the other lacks. (94, not 121: like the
-- production view, `view_digest_daily_power` has no zero-filled calendar spine
-- and emits only days with a reading.)
--
-- ROW BUDGET (measured 2026-08-28): 545 rows over 400 days.
-- =====================================================================

CREATE OR REPLACE VIEW public.view_digest_power_meter_daily
WITH (security_invoker = true) AS
SELECT
  e.reading_date                          AS reading_date,
  e.meter                                 AS meter,
  sum(e.consumption_kwh)::numeric         AS kwh,
  sum(e.diff_kwh)::numeric                AS raw_diff_kwh,
  count(*)::int                           AS reading_count
FROM public.electricity_readings e
WHERE e.reading_date >= ((now() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '400 days')::date
GROUP BY e.reading_date, e.meter;

COMMENT ON VIEW public.view_digest_power_meter_daily IS
  'One row per (reading_date, meter) over public.electricity_readings, windowed to a trailing 400 '
  'days from the Asia/Manila calendar date. THE per-meter grain behind the POWER drill-down rail. '
  'kwh = sum(consumption_kwh) — the SAME column view_digest_daily_power sums, so the modal total '
  'always equals the tile (measured 94/94 reported days). consumption_kwh is multiplier-applied; the raw '
  'meter movement is carried separately as raw_diff_kwh and is ~120x smaller on MAIN — never use it '
  'as the headline. NOTE the real shape: of the three meters, BUNKHOUSE and PUMP were last reported '
  '2025-12-12, so short ranges legitimately show MAIN alone. Carries NO price column. Not granted to '
  'service_role: the sync worker does not read it. ROW BUDGET: 545 rows / 400d.';

GRANT SELECT ON public.view_digest_power_meter_daily TO authenticated;
REVOKE ALL ON public.view_digest_power_meter_daily FROM anon;
