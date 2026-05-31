-- Make view_blocking_grid.balance self-correcting (compute from transactions).
--
-- Background (AUDIT_FINDINGS AF-001 / LEARNING_LEDGER L-005):
-- The previous view sourced `balance` directly from `batches.current_weight`. That
-- column is a trigger-maintained cache that had drifted +phantom on several batches
-- because a delivery-ingestion run applied an imperative `current_weight += weight`
-- ON TOP of the trigger's own increment (the L-001 family race — NOT a trigger bug).
-- The app therefore rendered ~54 t of phantom inventory while the underlying
-- transaction rows were correct all along.
--
-- Fix: compute `balance` as SUM(deliveries.weight_kg) - SUM(rc_out.weight_kg) so the
-- grid is correct even if `current_weight` drifts again. `balance` now always equals
-- the view's own `total_in` minus realized usage.
--
-- IMPORTANT implementation note: the deliveries LEFT JOIN fans out one row per
-- delivery. The rc_out total is therefore pulled via a correlated subquery (evaluated
-- once per batch, OUTSIDE the GROUP BY) so it is not multiplied by the delivery count.
--
-- Column names, filters, DISTINCT ON dedup, SECURITY INVOKER, and grants are all
-- preserved exactly — only the source of `balance` changes. Drop + recreate is used
-- (not CREATE OR REPLACE) so the definition is unambiguous.

DROP VIEW IF EXISTS view_blocking_grid;

CREATE VIEW view_blocking_grid
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (b.location_ref)
    b.id AS batch_id,
    b.batch_code,
    b.location_ref AS block_loc,
    b.status::text AS status,
    -- Self-correcting balance: total delivered minus total used, straight from the
    -- transaction tables. No longer trusts batches.current_weight.
    (
        COALESCE(SUM(d.weight_kg), 0::numeric)
        - COALESCE((
            SELECT SUM(r.weight_kg) FROM rc_out r WHERE r.batch_id = b.id
        ), 0::numeric)
    ) AS balance,
    COALESCE(sum(d.cost_basis * d.weight_kg) / NULLIF(sum(d.weight_kg), 0::numeric), 0::numeric) AS avg_php_kg,
    COALESCE(sum(d.weight_kg), 0::numeric) AS total_in,
    COALESCE(sum(((d.lab_results ->> 'bd_astm'::text)::numeric) * d.weight_kg) / NULLIF(sum(
        CASE
            WHEN (d.lab_results ->> 'bd_astm'::text) IS NOT NULL THEN d.weight_kg
            ELSE NULL::numeric
        END), 0::numeric), 0::numeric) AS avg_bd_astm,
    COALESCE(sum(((d.lab_results ->> 'bd_jis'::text)::numeric) * d.weight_kg) / NULLIF(sum(
        CASE
            WHEN (d.lab_results ->> 'bd_jis'::text) IS NOT NULL THEN d.weight_kg
            ELSE NULL::numeric
        END), 0::numeric), 0::numeric) AS avg_bd_jis,
    COALESCE(sum(((d.lab_results ->> 'ash'::text)::numeric) * d.weight_kg) / NULLIF(sum(
        CASE
            WHEN (d.lab_results ->> 'ash'::text) IS NOT NULL THEN d.weight_kg
            ELSE NULL::numeric
        END), 0::numeric), 0::numeric) AS avg_ash,
    COALESCE(sum(((d.lab_results ->> 'mc'::text)::numeric) * d.weight_kg) / NULLIF(sum(
        CASE
            WHEN (d.lab_results ->> 'mc'::text) IS NOT NULL THEN d.weight_kg
            ELSE NULL::numeric
        END), 0::numeric), 0::numeric) AS avg_mc,
    COALESCE(sum(((d.lab_results ->> 'grit'::text)::numeric) * d.weight_kg) / NULLIF(sum(
        CASE
            WHEN (d.lab_results ->> 'grit'::text) IS NOT NULL THEN d.weight_kg
            ELSE NULL::numeric
        END), 0::numeric), 0::numeric) AS avg_grit,
    COALESCE(sum(((d.lab_results ->> 'vm'::text)::numeric) * d.weight_kg) / NULLIF(sum(
        CASE
            WHEN (d.lab_results ->> 'vm'::text) IS NOT NULL THEN d.weight_kg
            ELSE NULL::numeric
        END), 0::numeric), 0::numeric) AS avg_vm,
    COALESCE(sum(((d.lab_results ->> 'fc'::text)::numeric) * d.weight_kg) / NULLIF(sum(
        CASE
            WHEN (d.lab_results ->> 'fc'::text) IS NOT NULL THEN d.weight_kg
            ELSE NULL::numeric
        END), 0::numeric), 0::numeric) AS avg_fc
   FROM batches b
     LEFT JOIN deliveries d ON d.batch_code = b.batch_code
  WHERE (b.status = ANY (ARRAY['STORED'::batch_status, 'IN-USE'::batch_status, 'SUNDRYING'::batch_status, 'SUNDRIED'::batch_status]))
    AND b.location_ref IS NOT NULL
    AND b.location_ref <> ''::text
  GROUP BY b.id, b.batch_code, b.location_ref, b.status
  ORDER BY b.location_ref, b.current_weight DESC;

-- Restore grants (matching prior migrations restore_blocking_view_grants / grant_view_blocking_grid_access)
GRANT SELECT ON view_blocking_grid TO anon, authenticated, service_role;
