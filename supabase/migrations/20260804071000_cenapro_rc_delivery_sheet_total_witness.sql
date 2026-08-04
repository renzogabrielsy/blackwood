-- ─────────────────────────────────────────────────────────────────────────────
-- Cenapro RC DELIVERIES — surface the sheet-vs-computed money agreement on the
-- read model.
--
-- WHY
-- `cenapro.rc_delivery` keeps TWO opinions about what a receipt is worth:
--   * `total_price_php`  — GENERATED, computed by the database from gross weight,
--                          deduction, base price and adjustment. The truth.
--   * `sheet_total_php`  — what the RC workbook itself printed in TTL PRICE. An
--                          independent witness, never used in a calculation.
-- They agree on all 991 imported rows today. The point of keeping the second
-- witness is to notice the day they stop agreeing — a re-import against an edited
-- workbook, or an operator correcting a weight without re-deriving the total.
--
-- Expressing that agreement as a COLUMN rather than leaving it to each caller is
-- deliberate: PostgREST cannot filter one column against another, so without it
-- every consumer (and the importer's own self-check) would have to pull all 991
-- rows and re-do exact decimal arithmetic in JavaScript — precisely the floating
-- point round trip this schema exists to avoid. `IS NOT DISTINCT FROM` so a row
-- with no sheet witness at all (an app-entered receipt) reads FALSE-for-"differs"
-- via sheet_total_php IS NULL rather than NULL-propagating.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the new column belongs next to
-- sheet_total_php, and CREATE OR REPLACE VIEW can only append at the end.
-- ─────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS public.cenapro_rc_delivery_rows;
DROP VIEW IF EXISTS cenapro.view_rc_delivery;

CREATE VIEW cenapro.view_rc_delivery
WITH (security_invoker = true)
AS
SELECT
  d.id,
  d.delivery_date,
  d.delivery_date_raw,
  d.delivery_year,
  d.truck_no,
  d.supplier_code,
  s.display_name                                    AS supplier_name,
  d.supplier_origin,
  d.permit_no,
  d.supplier_raw,
  d.sacks,
  d.gross_weight_kg,
  d.deduction_pct,
  d.net_weight_kg,
  d.weight_formula,
  d.bd,
  d.moisture_pct,
  d.grit,
  d.ash,
  d.dust,
  d.vm,
  d.fc,
  d.destination_code,
  dst.display_name                                  AS destination_name,
  dst.kind                                          AS destination_kind,
  dst.has_sides                                     AS destination_has_sides,
  d.destination_side,
  d.destination_raw,
  d.remarks,
  d.base_price_php_kg,
  d.price_adjustment_php_kg,
  d.price_php_kg,
  d.price_formula,
  d.total_price_php,
  d.sheet_total_php,
  -- TRUE  = the database's computed total matches the workbook's printed one.
  -- FALSE = they disagree, or the row carries no sheet witness (an app entry).
  (d.total_price_php IS NOT DISTINCT FROM d.sheet_total_php)
                                                    AS sheet_total_matches,
  sm.sample_count,
  sm.sample_avg_moisture_pct,
  d.provenance,
  d.source_sheet,
  d.source_row,
  d.is_suspected_duplicate,
  d.import_flags,
  jsonb_array_length(d.import_flags)                AS import_flag_count,
  (d.import_flags <> '[]'::jsonb)                   AS has_import_flags,
  (d.supplier_code IS NULL)                         AS supplier_unresolved,
  (d.destination_code IS NULL AND d.destination_raw IS NOT NULL)
                                                    AS destination_unresolved,
  d.row_version,
  d.created_at,
  d.created_by,
  d.updated_at,
  d.updated_by
FROM cenapro.rc_delivery d
LEFT JOIN cenapro.rc_supplier    s   ON s.code   = d.supplier_code
LEFT JOIN cenapro.rc_destination dst ON dst.code = d.destination_code
LEFT JOIN LATERAL (
  SELECT count(*)::integer                AS sample_count,
         round(avg(x.moisture_pct), 3)    AS sample_avg_moisture_pct
    FROM cenapro.rc_delivery_sample x
   WHERE x.delivery_id = d.id
) sm ON true;

COMMENT ON VIEW cenapro.view_rc_delivery IS
  'Read model for Cenapro RC deliveries: the fact row + supplier/destination display names + '
  'sample_count / sample_avg_moisture_pct + the data-quality surface (sheet_total_matches, '
  'has_import_flags, supplier_unresolved, destination_unresolved). All aggregation lives here, '
  'never in TypeScript.';

COMMENT ON COLUMN cenapro.view_rc_delivery.sheet_total_matches IS
  'Does the database''s computed total_price_php equal the workbook''s printed sheet_total_php? '
  'TRUE on all 991 imported rows. FALSE also when there is no sheet witness (app-entered row).';

REVOKE ALL ON cenapro.view_rc_delivery FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_delivery TO authenticated, service_role;

CREATE VIEW public.cenapro_rc_delivery_rows
WITH (security_invoker = true) AS
SELECT v.* FROM cenapro.view_rc_delivery v;

COMMENT ON VIEW public.cenapro_rc_delivery_rows IS
  'Public READ-ONLY accessor for cenapro.view_rc_delivery — the enriched grid read model '
  '(display names + sample rollup + data-quality surface incl. sheet_total_matches).';

REVOKE ALL  ON public.cenapro_rc_delivery_rows FROM anon, authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_delivery_rows TO authenticated, service_role;
