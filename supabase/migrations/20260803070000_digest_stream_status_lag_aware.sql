-- =====================================================================
-- Digest — lag-aware stream status ("Awaiting report" all working day fix)
-- =====================================================================
-- Problem: PRODUCTION, POWER (electricity), TRUCKS and RC OUT are reported
-- by the operator the FOLLOWING morning. Keying their KPI cards to the
-- operational date therefore made them read "Awaiting report" on every
-- working day and only fill in retroactively — a sync that landed real
-- data changed nothing on the board (2026-08-03: production for 08-01 was
-- 14,296 kg on record while the PRODUCTION card still said "Awaiting").
--
-- Fix: give the digest, per stream and IN SQL,
--   * whether the stream is reported a day behind BY DESIGN,
--   * its latest reported day + the one before it (so a card can lead with
--     the real value AND compute a delta against the prior REPORTED day,
--     not against a day that simply has no row), and
--   * how many PLANNED WORKING days of reports are outstanding — counted
--     against `production_schedule` (`shifts > 0`), NOT raw calendar days,
--     so a Sunday / holiday is never "late".
--
-- Three small views, no duplicated stream registry:
--   view_digest_stream_registry      — the stream list + labels + lag flag
--   view_digest_stream_reported_days — one row per (stream, reported date)
--   view_digest_stream_status        — the read model the digest consumes
--
-- `view_digest_stream_freshness` is REDEFINED as a thin projection of the
-- status view, so its three columns and their semantics stay byte-identical
-- for every existing consumer while the registry lives in exactly ONE place.
--
-- CARRIED FORWARD (migration 20260714000000 — DO NOT REGRESS): the
-- `production` stream keys on the max `production_shifts.transaction_date`
-- that HAS a `production_runs` child (actual OUTPUT). Ivy's WASTE report
-- also creates shift rows, so `max(production_shifts.transaction_date)`
-- would report Production current while MC's output ingestion has stalled.
-- That rule now lives in `view_digest_stream_reported_days` — the ONE place
-- a "production reported day" is defined.
--
-- All three views are read-only, additive and `security_invoker` (the
-- caller's RLS applies to every base table, per the Phase-4 RLS posture).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The stream registry — labels + the lag-by-design classification.
--    `reports_next_day = true` means the source (MC's Daily Production
--    Report, the PROPOSED DAILY REPORT) describes YESTERDAY, so "no row
--    for the operational date" is the expected steady state, not a fault.
--    RC In is procurement: a delivery is weighed and recorded same-day.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_digest_stream_registry
WITH (security_invoker = true) AS
SELECT *
  FROM (
    VALUES
      ('deliveries'::text,  'RC In (deliveries)'::text, false, 1),
      ('rc_out'::text,      'RC Out (usage)'::text,     true,  2),
      ('production'::text,  'Production'::text,         true,  3),
      ('electricity'::text, 'Electricity'::text,        true,  4),
      ('trucks'::text,      'Trucks'::text,             true,  5)
  ) AS r(stream, label, reports_next_day, sort_order);

-- ---------------------------------------------------------------------
-- 2. Per-stream REPORTED days — one row per (stream, date) the stream has
--    actually filed. `UNION ALL` of self-DISTINCT branches (not `UNION`)
--    so the planner can prune branches on `stream = '…'` in the lateral.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_digest_stream_reported_days
WITH (security_invoker = true) AS
 SELECT DISTINCT 'deliveries'::text AS stream,
        d.transaction_date AS reported_date
   FROM deliveries d
  WHERE d.transaction_date IS NOT NULL
UNION ALL
 SELECT DISTINCT 'rc_out'::text,
        r.transaction_date
   FROM rc_out r
  WHERE r.transaction_date IS NOT NULL
UNION ALL
 -- ACTUAL OUTPUT only — see the migration header (20260714000000).
 SELECT DISTINCT 'production'::text,
        ps.transaction_date
   FROM production_shifts ps
  WHERE ps.transaction_date IS NOT NULL
    AND EXISTS (SELECT 1 FROM production_runs pr WHERE pr.shift_id = ps.id)
UNION ALL
 SELECT DISTINCT 'electricity'::text,
        e.reading_date
   FROM electricity_readings e
  WHERE e.reading_date IS NOT NULL
UNION ALL
 SELECT DISTINCT 'trucks'::text,
        t.reading_date
   FROM truck_readings t
  WHERE t.reading_date IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. The read model the digest consumes.
--
--    missed_working_days = the number of PLANNED WORKING days
--    (`production_schedule.shifts > 0`) strictly BETWEEN the stream's
--    latest reported day and the operational date. Two exclusions are
--    load-bearing:
--      * the operational date itself is excluded — for a next-day stream
--        today's report is not due yet, so today can never make a stream
--        late (this is the whole bug);
--      * `shifts = 0` days (Sunday / holiday) are excluded — a rest day
--        produces no report and is never a missed one.
--    0 = on time. NULL = not computable (stream never reported, or no
--    operational date). Days with no `production_schedule` row are not
--    counted: we never accuse a stream of missing a day we have no plan
--    for. (The plan is dense — 2026-01-01 → 2026-09-30, no gaps.)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_digest_stream_status
WITH (security_invoker = true) AS
WITH op AS (
  SELECT operational_date FROM public.view_digest_operational_days
)
SELECT
    r.stream,
    r.label,
    r.reports_next_day,
    agg.through_date,
    agg.prev_reported_date,
    op.operational_date,
    CASE
      WHEN agg.through_date IS NULL OR op.operational_date IS NULL THEN NULL
      ELSE (
        SELECT count(*)::int
          FROM public.production_schedule ps
         WHERE ps.shifts > 0
           AND ps.plan_date > agg.through_date
           AND ps.plan_date < op.operational_date
      )
    END AS missed_working_days,
    r.sort_order
  FROM public.view_digest_stream_registry r
  CROSS JOIN op
  LEFT JOIN LATERAL (
    -- The two most recent reported days, ranked (mirrors the ranked-CTE
    -- pattern in view_digest_operational_days).
    SELECT max(x.reported_date) FILTER (WHERE x.rn = 1) AS through_date,
           max(x.reported_date) FILTER (WHERE x.rn = 2) AS prev_reported_date
      FROM (
        SELECT s.reported_date,
               row_number() OVER (ORDER BY s.reported_date DESC) AS rn
          FROM public.view_digest_stream_reported_days s
         WHERE s.stream = r.stream
      ) x
     WHERE x.rn <= 2
  ) agg ON true
 ORDER BY r.sort_order;

-- ---------------------------------------------------------------------
-- 4. Backward-compatible projection. Same three columns, same order, same
--    types, same semantics — every existing consumer is unaffected.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_digest_stream_freshness
WITH (security_invoker = true) AS
SELECT stream, label, through_date
  FROM public.view_digest_stream_status;

REVOKE ALL ON public.view_digest_stream_registry      FROM anon;
REVOKE ALL ON public.view_digest_stream_reported_days FROM anon;
REVOKE ALL ON public.view_digest_stream_status        FROM anon;

GRANT SELECT ON public.view_digest_stream_registry      TO authenticated;
GRANT SELECT ON public.view_digest_stream_reported_days TO authenticated;
GRANT SELECT ON public.view_digest_stream_status        TO authenticated;
GRANT SELECT ON public.view_digest_stream_freshness     TO authenticated;
