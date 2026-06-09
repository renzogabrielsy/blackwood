-- Add SHIFT (production_shifts.shift, M/E/N) to view_digest_grades so the
-- "Production by grade" digest chart can break each day's grade output down
-- by shift. Existing columns (date, grade, kg) are preserved unchanged; the
-- grouping is widened from (date, grade) to (date, grade, shift). Same
-- trailing 120-day window (anchored to the operational date) and ordering.
--
-- All aggregation remains in SQL (CLAUDE.md hard rule).
--
-- DROP + CREATE (not CREATE OR REPLACE): the new column `shift` is inserted
-- before the existing trailing `kg` column, which CREATE OR REPLACE forbids
-- (it only allows appending new columns at the very end of the SELECT list).

DROP VIEW IF EXISTS public.view_digest_grades;

CREATE VIEW public.view_digest_grades AS
WITH bounds AS (
  SELECT (
    (SELECT view_digest_operational_days.operational_date
       FROM view_digest_operational_days) - '120 days'::interval
  )::date AS start_d
)
SELECT
  ps.transaction_date AS date,
  pr.grade,
  ps.shift,
  sum(pr.ttl_kg) AS kg
FROM production_runs pr
  JOIN production_shifts ps ON ps.id = pr.shift_id,
  bounds
WHERE ps.transaction_date >= bounds.start_d
GROUP BY ps.transaction_date, pr.grade, ps.shift
ORDER BY ps.transaction_date, pr.grade, ps.shift;

-- DROP VIEW removes the prior GRANTs, so re-grant SELECT to the app roles to
-- match the sibling digest views — otherwise the anon/authenticated client
-- reads zero rows and the chart renders empty.
GRANT SELECT ON public.view_digest_grades TO authenticated;
GRANT SELECT ON public.view_digest_grades TO anon;
