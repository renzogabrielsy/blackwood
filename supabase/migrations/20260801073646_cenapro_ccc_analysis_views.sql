-- ─────────────────────────────────────────────────────────────────────────────
-- Cenapro CCC/QC analysis — the aggregates, in SQL.
--
-- These views replace `lib/cenapro/ccc-analysis-draft.ts` (`aggregateGroups`,
-- `dayAggregates`, `buildMonthRollups`, `buildDayBreakdowns`), which computed the
-- same numbers in TypeScript under an explicit, temporary prototype exemption.
-- CLAUDE.md: aggregations, running totals and derived state belong in SQL.
--
-- THE WEIGHTED-AVERAGE RULE (reproduced exactly from the draft's TS)
--   wtd(metric) = SUM(group_kg × metric) / SUM(group_kg)
-- taken over the groups whose sample carries THAT metric non-null — PER METRIC
-- INDEPENDENTLY. A group whose sample is missing ASH still contributes its full
-- weight to the BD/GRIT/MC averages. Each metric therefore has its own
-- denominator, exposed as `wtd_<metric>_kg` so a number can be captioned with the
-- share of weight actually behind it.
--
-- THE EX-DVO FLAVOR — a `scope` COLUMN, not a frontend filter.
-- The reading page headlines ex-DVO totals; the entry ledger shows everything.
-- Rather than leave that partition to the client (where it silently drifts), the
-- daily and monthly views emit TWO rows per period: scope='all' and
-- scope='ex_dvo'. Both come from one aggregation expression, so they cannot
-- disagree. `all_kg` and `dvo_kg` are period-wide on BOTH rows, so a single
-- ex_dvo row still carries the full split (this is Draft D's `DayBreakdown`
-- shape: totalExDvoKg + dvoKg + ex-DVO weighted averages, on one row).
--
-- REGRESSION CONSTANT: May 2026 partner receipts = 1,134,070 kg;
-- May weighted averages = bd 0.5602 / ash 2.80 / grit 0.73 / mc 11.63.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The sample group — the real grain ─────────────────────────────────────
-- One row per (recv_date, source, effective warehouse) partner-receipt group,
-- LEFT JOINed to its lab sample. Partner receipts = partner_equipment_code IS
-- NOT NULL (the draws CCC physically took); everything else is CI-internal
-- bagging. Sheet samples that match no group yet do NOT appear here — read
-- `public.cenapro_analysis_samples` for the raw ledger including those.
CREATE OR REPLACE VIEW cenapro.view_ccc_sample_group
WITH (security_invoker = true)
AS
WITH grp AS (
  SELECT
    pe.recv_date                                                              AS sample_date,
    cenapro.fn_canon_token(pe.source_location_code)                           AS source_location_code,
    cenapro.fn_canon_token(coalesce(pe.warehouse_code, pe.plant_code))        AS whse_key,
    count(*)::int                                                             AS draw_count,
    sum(pe.weight_kg)                                                         AS total_kg
  FROM cenapro.production_event pe
  WHERE pe.partner_equipment_code IS NOT NULL
  GROUP BY 1, 2, 3
)
SELECT
  g.sample_date,
  g.source_location_code,
  g.whse_key,
  CASE
    WHEN g.source_location_code LIKE 'TNK%' THEN 'tanks'
    WHEN g.source_location_code = 'DVO'     THEN 'dvo'
    WHEN g.source_location_code = 'FLEC'    THEN 'flec'
    ELSE 'plant'
  END                                                          AS source_group,
  (g.source_location_code = 'DVO')                             AS is_dvo,
  g.draw_count,
  g.total_kg,
  s.id                                                         AS sample_id,
  s.bd,
  s.ash,
  s.grit,
  s.mc,
  (s.bd IS NOT NULL OR s.ash IS NOT NULL
     OR s.grit IS NOT NULL OR s.mc IS NOT NULL)                AS is_sampled,
  (s.bd IS NOT NULL AND s.ash IS NOT NULL
     AND s.grit IS NOT NULL AND s.mc IS NOT NULL)              AS is_complete,
  CASE WHEN s.id IS NULL THEN 0
       ELSE (s.bd IS NULL)::int + (s.ash IS NULL)::int
          + (s.grit IS NULL)::int + (s.mc IS NULL)::int
  END                                                          AS missing_metric_count,
  s.source                                                     AS sample_source,
  s.notes                                                      AS sample_notes,
  s.row_version                                                AS sample_row_version,
  s.updated_at                                                 AS sample_updated_at,
  s.updated_by                                                 AS sample_updated_by
FROM grp g
LEFT JOIN cenapro.analysis_sample s
       ON s.sample_date          = g.sample_date
      AND s.source_location_code = g.source_location_code
      AND s.whse_key             = g.whse_key;

COMMENT ON VIEW cenapro.view_ccc_sample_group IS
  'One row per CCC partner-receipt sample group: (recv_date, source_location_code, '
  'effective warehouse) with its summed weight and the single lab sample covering it. '
  'Effective warehouse = fn_canon_token(coalesce(warehouse_code, plant_code)) because tank '
  'and W7 draws carry a NULL warehouse_code and the sheet writes the plant there. This is '
  'the entry ledger read model (sample_row_version feeds the save RPC) and the input to the '
  'daily/monthly aggregates.';


-- ── 2. Daily ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW cenapro.view_ccc_analysis_daily
WITH (security_invoker = true)
AS
WITH day_totals AS (
  SELECT
    g.sample_date,
    sum(g.total_kg)                                          AS all_kg,
    coalesce(sum(g.total_kg) FILTER (WHERE g.is_dvo), 0)     AS dvo_kg
  FROM cenapro.view_ccc_sample_group g
  GROUP BY g.sample_date
),
scoped AS (
  SELECT g.*, 'all'::text    AS scope FROM cenapro.view_ccc_sample_group g
  UNION ALL
  SELECT g.*, 'ex_dvo'::text AS scope FROM cenapro.view_ccc_sample_group g WHERE NOT g.is_dvo
)
SELECT
  s.scope,
  s.sample_date,
  d.all_kg,
  d.dvo_kg,
  d.all_kg - d.dvo_kg                                                      AS ex_dvo_kg,
  sum(s.total_kg)                                                          AS total_kg,
  coalesce(sum(s.total_kg) FILTER (WHERE s.is_sampled), 0)                 AS sampled_kg,
  CASE WHEN sum(s.total_kg) > 0
       THEN coalesce(sum(s.total_kg) FILTER (WHERE s.is_sampled), 0) / sum(s.total_kg)
       ELSE 0 END                                                          AS coverage,
  count(*)::int                                                            AS group_count,
  count(*) FILTER (WHERE s.is_sampled)::int                                AS sampled_group_count,
  sum(s.draw_count)::int                                                   AS draw_count,
  coalesce(sum(s.missing_metric_count) FILTER (WHERE s.is_sampled), 0)::int AS missing_value_count,
  sum(s.total_kg * s.bd)   FILTER (WHERE s.bd   IS NOT NULL AND s.total_kg > 0)
    / nullif(sum(s.total_kg) FILTER (WHERE s.bd   IS NOT NULL AND s.total_kg > 0), 0) AS wtd_bd,
  sum(s.total_kg * s.ash)  FILTER (WHERE s.ash  IS NOT NULL AND s.total_kg > 0)
    / nullif(sum(s.total_kg) FILTER (WHERE s.ash  IS NOT NULL AND s.total_kg > 0), 0) AS wtd_ash,
  sum(s.total_kg * s.grit) FILTER (WHERE s.grit IS NOT NULL AND s.total_kg > 0)
    / nullif(sum(s.total_kg) FILTER (WHERE s.grit IS NOT NULL AND s.total_kg > 0), 0) AS wtd_grit,
  sum(s.total_kg * s.mc)   FILTER (WHERE s.mc   IS NOT NULL AND s.total_kg > 0)
    / nullif(sum(s.total_kg) FILTER (WHERE s.mc   IS NOT NULL AND s.total_kg > 0), 0) AS wtd_mc,
  coalesce(sum(s.total_kg) FILTER (WHERE s.bd   IS NOT NULL AND s.total_kg > 0), 0)   AS wtd_bd_kg,
  coalesce(sum(s.total_kg) FILTER (WHERE s.ash  IS NOT NULL AND s.total_kg > 0), 0)   AS wtd_ash_kg,
  coalesce(sum(s.total_kg) FILTER (WHERE s.grit IS NOT NULL AND s.total_kg > 0), 0)   AS wtd_grit_kg,
  coalesce(sum(s.total_kg) FILTER (WHERE s.mc   IS NOT NULL AND s.total_kg > 0), 0)   AS wtd_mc_kg
FROM scoped s
JOIN day_totals d ON d.sample_date = s.sample_date
GROUP BY s.scope, s.sample_date, d.all_kg, d.dvo_kg;

COMMENT ON VIEW cenapro.view_ccc_analysis_daily IS
  'CCC analysis per recv_date, TWO rows per date: scope=all and scope=ex_dvo. total_kg / '
  'sampled_kg / coverage / wtd_* are WITHIN the scope; all_kg and dvo_kg are the full day '
  'either way, so one ex_dvo row carries the whole split. wtd_<m> = SUM(kg x m)/SUM(kg) over '
  'groups carrying that metric, per metric independently; wtd_<m>_kg is that metric''s own '
  'denominator. Replaces the TypeScript dayAggregates()/buildDayBreakdowns().';


-- ── 3. Monthly ───────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW cenapro.view_ccc_analysis_monthly
WITH (security_invoker = true)
AS
WITH month_totals AS (
  SELECT
    date_trunc('month', g.sample_date)::date                 AS month_start,
    sum(g.total_kg)                                          AS all_kg,
    coalesce(sum(g.total_kg) FILTER (WHERE g.is_dvo), 0)     AS dvo_kg
  FROM cenapro.view_ccc_sample_group g
  GROUP BY 1
),
scoped AS (
  SELECT g.*, 'all'::text    AS scope FROM cenapro.view_ccc_sample_group g
  UNION ALL
  SELECT g.*, 'ex_dvo'::text AS scope FROM cenapro.view_ccc_sample_group g WHERE NOT g.is_dvo
)
SELECT
  s.scope,
  date_trunc('month', s.sample_date)::date                                 AS month_start,
  to_char(s.sample_date, 'YYYY-MM')                                        AS month_key,
  m.all_kg,
  m.dvo_kg,
  m.all_kg - m.dvo_kg                                                      AS ex_dvo_kg,
  sum(s.total_kg)                                                          AS total_kg,
  coalesce(sum(s.total_kg) FILTER (WHERE s.is_sampled), 0)                 AS sampled_kg,
  CASE WHEN sum(s.total_kg) > 0
       THEN coalesce(sum(s.total_kg) FILTER (WHERE s.is_sampled), 0) / sum(s.total_kg)
       ELSE 0 END                                                          AS coverage,
  count(*)::int                                                            AS group_count,
  count(*) FILTER (WHERE s.is_sampled)::int                                AS sampled_group_count,
  count(DISTINCT s.sample_date)::int                                       AS day_count,
  sum(s.draw_count)::int                                                   AS draw_count,
  coalesce(sum(s.missing_metric_count) FILTER (WHERE s.is_sampled), 0)::int AS missing_value_count,
  sum(s.total_kg * s.bd)   FILTER (WHERE s.bd   IS NOT NULL AND s.total_kg > 0)
    / nullif(sum(s.total_kg) FILTER (WHERE s.bd   IS NOT NULL AND s.total_kg > 0), 0) AS wtd_bd,
  sum(s.total_kg * s.ash)  FILTER (WHERE s.ash  IS NOT NULL AND s.total_kg > 0)
    / nullif(sum(s.total_kg) FILTER (WHERE s.ash  IS NOT NULL AND s.total_kg > 0), 0) AS wtd_ash,
  sum(s.total_kg * s.grit) FILTER (WHERE s.grit IS NOT NULL AND s.total_kg > 0)
    / nullif(sum(s.total_kg) FILTER (WHERE s.grit IS NOT NULL AND s.total_kg > 0), 0) AS wtd_grit,
  sum(s.total_kg * s.mc)   FILTER (WHERE s.mc   IS NOT NULL AND s.total_kg > 0)
    / nullif(sum(s.total_kg) FILTER (WHERE s.mc   IS NOT NULL AND s.total_kg > 0), 0) AS wtd_mc,
  coalesce(sum(s.total_kg) FILTER (WHERE s.bd   IS NOT NULL AND s.total_kg > 0), 0)   AS wtd_bd_kg,
  coalesce(sum(s.total_kg) FILTER (WHERE s.ash  IS NOT NULL AND s.total_kg > 0), 0)   AS wtd_ash_kg,
  coalesce(sum(s.total_kg) FILTER (WHERE s.grit IS NOT NULL AND s.total_kg > 0), 0)   AS wtd_grit_kg,
  coalesce(sum(s.total_kg) FILTER (WHERE s.mc   IS NOT NULL AND s.total_kg > 0), 0)   AS wtd_mc_kg
FROM scoped s
JOIN month_totals m ON m.month_start = date_trunc('month', s.sample_date)::date
GROUP BY s.scope, date_trunc('month', s.sample_date), to_char(s.sample_date, 'YYYY-MM'), m.all_kg, m.dvo_kg;

COMMENT ON VIEW cenapro.view_ccc_analysis_monthly IS
  'Monthly twin of cenapro.view_ccc_analysis_daily — same scope=all / scope=ex_dvo pairing '
  'and the same per-metric-independent weighted averages, keyed by month_start (date) and '
  'month_key (YYYY-MM). Replaces the TypeScript buildMonthRollups(). Regression: '
  'month_key=2026-05 scope=ex_dvo -> total_kg 1134070, wtd 0.5602 / 2.80 / 0.73 / 11.63.';


-- ── 4. Public look-through accessors ─────────────────────────────────────────
CREATE OR REPLACE VIEW public.cenapro_ccc_sample_groups
WITH (security_invoker = true)
AS SELECT * FROM cenapro.view_ccc_sample_group;

CREATE OR REPLACE VIEW public.cenapro_ccc_analysis_daily
WITH (security_invoker = true)
AS SELECT * FROM cenapro.view_ccc_analysis_daily;

CREATE OR REPLACE VIEW public.cenapro_ccc_analysis_monthly
WITH (security_invoker = true)
AS SELECT * FROM cenapro.view_ccc_analysis_monthly;

COMMENT ON VIEW public.cenapro_ccc_sample_groups IS
  'Public accessor for cenapro.view_ccc_sample_group (the cenapro schema is not exposed to '
  'PostgREST). Read-only.';
COMMENT ON VIEW public.cenapro_ccc_analysis_daily IS
  'Public accessor for cenapro.view_ccc_analysis_daily. Filter scope=ex_dvo for the reading '
  'page headline figures, scope=all for the entry ledger. Read-only.';
COMMENT ON VIEW public.cenapro_ccc_analysis_monthly IS
  'Public accessor for cenapro.view_ccc_analysis_monthly. Filter scope=ex_dvo for the '
  'reading page headline figures, scope=all for the entry ledger. Read-only.';

GRANT SELECT ON public.cenapro_ccc_sample_groups     TO authenticated, service_role;
GRANT SELECT ON public.cenapro_ccc_analysis_daily    TO authenticated, service_role;
GRANT SELECT ON public.cenapro_ccc_analysis_monthly  TO authenticated, service_role;
REVOKE ALL ON public.cenapro_ccc_sample_groups    FROM anon;
REVOKE ALL ON public.cenapro_ccc_analysis_daily   FROM anon;
REVOKE ALL ON public.cenapro_ccc_analysis_monthly FROM anon;

GRANT SELECT ON cenapro.view_ccc_sample_group      TO authenticated, service_role;
GRANT SELECT ON cenapro.view_ccc_analysis_daily    TO authenticated, service_role;
GRANT SELECT ON cenapro.view_ccc_analysis_monthly  TO authenticated, service_role;

-- TRAP — the `cenapro` schema carries a DEFAULT ACL
--   {anon=r/postgres, authenticated=arwd/postgres, service_role=arwd/postgres}
-- (set by the original create_cenapro_schema migration's ALTER DEFAULT PRIVILEGES).
-- EVERY new relation created in this schema is therefore born with anon=SELECT and
-- authenticated=INSERT/UPDATE/DELETE, silently, whatever the CREATE statement says.
-- That contradicts the Phase-4 posture ("anon has no data access") and would make a
-- read-only reporting view look writable. These REVOKEs are mandatory, not tidy-up —
-- do the same for any future cenapro object.
REVOKE ALL ON cenapro.view_ccc_sample_group     FROM anon;
REVOKE ALL ON cenapro.view_ccc_analysis_daily   FROM anon;
REVOKE ALL ON cenapro.view_ccc_analysis_monthly FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON cenapro.view_ccc_sample_group     FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON cenapro.view_ccc_analysis_daily   FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON cenapro.view_ccc_analysis_monthly FROM authenticated;
