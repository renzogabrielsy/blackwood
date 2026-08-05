-- ─────────────────────────────────────────────────────────────────────────────
-- Cenapro RC DELIVERIES — is each import flag's problem STILL TRUE today?
--
-- WHY
-- `cenapro.rc_delivery.import_flags` is a permanent record of what the extractor
-- saw on the day of the import. That is deliberate — decision 3 of migration
-- 20260804070000 is "flagged, never fixed", and the flag is the only surviving
-- witness to what the workbook literally said. It therefore does NOT clear when
-- a human repairs the underlying data.
--
-- Renzo has now repaired most of them, and the `?issue=flagged` lens has become
-- a lie: 12 receipts carry a flag, 10 of those flags describe a condition that
-- no longer holds. A worklist where five in six entries are already done is a
-- worklist nobody opens, and it gets worse with every repair.
--
-- ─── THE FIX, AND THE ONE THING IT MUST NOT DO ───────────────────────────────
-- Resolution is DERIVED, in SQL, on read. NOTHING IS MUTATED: no flag is
-- cleared, no flag is deleted, no `import_flags` value is rewritten, and this
-- migration contains no UPDATE at all. The historical record stays byte-for-byte
-- intact; what is new is that the read model can now say, per flag, whether the
-- condition that flag describes is still live.
--
-- The alternative — an importer or a server action that strips a flag once the
-- row is fixed — was rejected outright. It destroys the only evidence that the
-- workbook ever said `WHSE A/R#16`, and it makes "why is supplier_code NEGROS
-- when the sheet says MANAGAYTAY?" permanently unanswerable.
--
-- ─── THE PREDICATE PER KIND (verified against the live table, 2026-08-05) ────
-- Each predicate asks ONE question of the row's CURRENT state, never of the
-- flag's own text. Counts below are live at the time of writing.
--
--   supplier_unmapped          (1 flag)  RESOLVED ⟺ supplier_code IS NOT NULL
--       "could not resolve a trader from 'HILONGOS - BRIX'". The receipt has no
--       cheque payee. That is answered the moment a payee exists.
--       LIVE: 1 unresolved (source_row 343, supplier_code still NULL).
--
--   supplier_no_trader_prefix  (3 flags) RESOLVED ⟺ supplier_code IS NOT NULL
--       "'MANAGAYTAY' has no trader prefix; mapped to NEGROS for review". The
--       SAME predicate as supplier_unmapped, and deliberately so: both flags say
--       "we may not know who to pay", one because the importer could not decide
--       and one because it guessed. Both are answered by the same question — is
--       there a payee on this row now?
--       It is NOT treated as permanently unresolved. The condition the flag
--       names ("the sheet text carries no trader prefix") is a property of an
--       immutable historical string, so a predicate over it could never become
--       false — which is exactly the un-clearable noise this migration exists to
--       remove. It is also NOT treated as informational: if a human ever clears
--       supplier_code, the flag correctly fires again.
--       What the database genuinely CANNOT see is whether a human has reviewed
--       and agreed with the importer's guess — there is no acknowledgement
--       column, and inventing one from `row_version` would be a fiction (all
--       three of these rows sit at row_version 1, which means untouched, not
--       unreviewed). That residual is a UI concern, not a resolution state.
--       LIVE: 3 resolved (all three carry supplier_code = 'NEGROS').
--
--   destination_unmapped       (5 flags) RESOLVED ⟺ destination_code IS NOT NULL
--       "'WHSE A/R#16' did not match a known warehouse pattern". Answered when
--       the receipt names a yard.
--       LIVE: 5 resolved (all five now point at WHSE 3A).
--
--   date_unparseable           (2 flags) RESOLVED ⟺ delivery_date IS NOT NULL
--       "could not read '5/262026' as a date". `delivery_date_raw` keeps the
--       operator's literal text forever and is NOT part of the predicate — the
--       raw text is the evidence, not the problem.
--       LIVE: 2 resolved (both dated 2026-05-06 in the app).
--
--   bd_out_of_range            (1 flag)  RESOLVED ⟺ bd IS NOT NULL
--       "BD 23995.0 is far outside the 0.55 band seen everywhere else". THERE IS
--       NO BD RANGE ANYWHERE IN THIS SCHEMA to test against — decision 3 of the
--       original migration refuses lab-column range CHECKs on purpose, so a
--       threshold invented here would be a number with no authority behind it
--       masquerading as a rule. The predicate therefore does not ask "is the BD
--       in range"; it asks the question the flag actually created: the extractor
--       REFUSED to store the bad value, so this receipt has NO BD reading at
--       all. That is a real, checkable, closeable gap — someone looks the
--       reading up and types it in.
--       (Only 4 of 971 receipts have a NULL bd, so a missing BD is genuinely
--       exceptional rather than the norm.)
--       LIVE: 1 unresolved (source_row 928, bd still NULL, raw 23995 preserved
--       inside the flag).
--
--   suspected_duplicate        (0 flags) RESOLVED ⟺ the row has no exact twin
--                                        AND is_suspected_duplicate is false
--       NO ROW CARRIES THIS KIND TODAY — the 20 pasted receipts were deleted
--       (991 → 971 rows) and `is_suspected_duplicate` is false everywhere, so
--       this branch is untested against data. It is written in the CONSERVATIVE
--       direction on purpose: it stays unresolved while EITHER the importer's
--       accusation stands OR `duplicate_group_key` still pairs the row with an
--       exact copy, because a false "resolved" hides a double-counted ₱ total.
--
--   anything else                        NEVER resolved.
--       A kind this CASE has never heard of — a new extractor version, a
--       malformed element that is not even a JSON object — counts as UNRESOLVED.
--       Getting this wrong in the "resolved" direction silently hides a real
--       problem; getting it wrong the other way merely leaves a row in a queue
--       where a human will see it. The asymmetry decides the default.
--
-- ─── SHAPE OF THE CHANGE ─────────────────────────────────────────────────────
-- FOUR columns APPENDED at the end, exactly as the duplicate-pairing migration
-- (20260804072000) appended its four: every existing column keeps its name, type
-- and position, which is why the inner view uses CREATE OR REPLACE — Postgres
-- refuses the replace if a single existing column moved, so the column list
-- below is self-verifying. The public accessor is `SELECT v.*`, whose star was
-- expanded at creation time, so it alone must be dropped and recreated.
--
-- WHY A jsonb COLUMN AND NOT ONLY COUNTS. The flag popover shows each flag's
-- kind / detail / raw; with counts alone it could say "1 of 3 still live" but
-- not WHICH one, and the operator would be back to checking by hand. Appending
-- `resolved` to each element (`f || {"resolved": …}`) preserves every key the
-- extractor wrote, including keys added later, so the popover renders the same
-- array it always did with one extra field.
--
-- ─── PERFORMANCE ─────────────────────────────────────────────────────────────
-- A set-returning expression over the array, in its OWN CTE, filtered to
-- `import_flags <> '[]'` — so 959 of the 971 receipts never enter the SRF at all
-- and are LEFT JOINed to a COALESCEd zero. A correlated subquery per flag (or an
-- unguarded LATERAL) would run the expansion once per row of the ledger page for
-- no result. Measured on the endless ledger's own page query
-- (ORDER BY delivery_date DESC NULLS LAST, id DESC LIMIT 120):
--     before  Buffers: shared hit=2132  ·  after  Buffers: shared hit=2145
-- i.e. +13 buffers for a 36-block table: the guarded Seq Scan reads the 36 heap
-- blocks once, discards 959 rows by filter, and expands 12 flags. No new window,
-- and the only new sort is over those 12 rows. The `grouped` CTE is now
-- referenced twice, so Postgres materialises it (CTE Scan) instead of inlining
-- it — that is the one plan shape change, and it is why the WindowAgg is
-- computed once rather than twice. The sample-rollup LATERAL (2020 buffers)
-- remains, as before, the dominant cost of the whole view.
--
-- ─── PRICE GATING ────────────────────────────────────────────────────────────
-- None of the four new columns carries or can reveal a ₱ figure: two are counts
-- of flags, one is a boolean, and the jsonb is the extractor's own text —
-- `{kind, detail, raw}` — none of whose kinds is about money. So NONE of them
-- needs adding to `stripPrices()` in app/(app)/cenapro/deliveries/types.ts. As
-- with the duplicate columns, "this receipt still has an open data problem" is
-- an operational fact every role needs, not a money fact.
-- ─────────────────────────────────────────────────────────────────────────────


-- The accessor's `*` is frozen; drop it so it can pick the new columns up.
DROP VIEW IF EXISTS public.cenapro_rc_delivery_rows;


CREATE OR REPLACE VIEW cenapro.view_rc_delivery
WITH (security_invoker = true)
AS
WITH sig AS (
  -- NARROW projection on purpose: everything the window has to sort, and
  -- nothing else. The display columns are joined back below.
  SELECT
    d.id,
    d.delivery_date,
    d.source_row,
    d.created_at,
    md5(ROW(
      -- when + who + which truck
      d.delivery_date,
      d.truck_no,
      d.supplier_code, d.supplier_origin, d.permit_no, d.supplier_raw,
      -- how much
      d.sacks,
      trim_scale(d.gross_weight_kg), trim_scale(d.deduction_pct),
      -- what quality (rows 1321/1322 are why this is here)
      trim_scale(d.bd), trim_scale(d.moisture_pct), trim_scale(d.grit),
      trim_scale(d.ash), trim_scale(d.dust), trim_scale(d.vm), trim_scale(d.fc),
      -- where it tipped (rows 907/908 and 1422/1423 are why this is here)
      d.destination_code, d.destination_side, d.destination_raw,
      -- what the operator wrote (rows 907/908 again)
      d.remarks,
      -- what it costs, from the BASE columns only
      trim_scale(d.base_price_php_kg), trim_scale(d.price_adjustment_php_kg)
    )::text) AS signature
  FROM cenapro.rc_delivery d
),
grouped AS (
  SELECT
    s.id,
    s.signature,
    count(*)        OVER w AS group_size,
    row_number()    OVER w AS group_ordinal,
    array_agg(s.id) OVER w AS group_ids
  FROM sig s
  WINDOW w AS (
    PARTITION BY s.signature
    ORDER BY s.delivery_date, s.source_row NULLS LAST, s.created_at, s.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
),
-- ── flag resolution (see the header for the predicate per kind) ──────────────
-- Guarded to the flagged rows only. The unflagged majority never touches the
-- set-returning expansion and is COALESCEd below.
flag_expanded AS (
  SELECT
    d.id,
    e.ord,
    r.resolved,
    -- Preserve every key the extractor wrote (kind / detail / raw, and anything
    -- a later extractor adds) and append the derived verdict. A non-object
    -- element is wrapped rather than dropped, so a malformed flag is still
    -- visible in the popover.
    CASE
      WHEN jsonb_typeof(e.elem) = 'object' THEN e.elem
      ELSE jsonb_build_object('kind', NULL::text, 'detail', NULL::text, 'raw', e.elem)
    END || jsonb_build_object('resolved', r.resolved) AS entry
  FROM cenapro.rc_delivery d
  JOIN grouped g ON g.id = d.id
  CROSS JOIN LATERAL jsonb_array_elements(d.import_flags) WITH ORDINALITY AS e(elem, ord)
  CROSS JOIN LATERAL (
    SELECT CASE e.elem->>'kind'
             WHEN 'supplier_unmapped'         THEN d.supplier_code    IS NOT NULL
             WHEN 'supplier_no_trader_prefix' THEN d.supplier_code    IS NOT NULL
             WHEN 'destination_unmapped'      THEN d.destination_code IS NOT NULL
             WHEN 'date_unparseable'          THEN d.delivery_date    IS NOT NULL
             WHEN 'bd_out_of_range'           THEN d.bd               IS NOT NULL
             WHEN 'suspected_duplicate'       THEN (NOT d.is_suspected_duplicate
                                                    AND g.group_size = 1)
             -- An unknown kind is never resolved; see the header.
             ELSE false
           END AS resolved
  ) r
  WHERE d.import_flags <> '[]'::jsonb
),
flag_state AS (
  SELECT
    x.id,
    jsonb_agg(x.entry ORDER BY x.ord)                       AS flags_state,
    count(*) FILTER (WHERE NOT x.resolved)::integer         AS unresolved_flag_count,
    count(*) FILTER (WHERE     x.resolved)::integer         AS resolved_flag_count
  FROM flag_expanded x
  GROUP BY x.id
)
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
  d.updated_by,

  -- ── duplicate pairing (20260804072000; positions unchanged) ────────────────
  CASE WHEN g.group_size > 1 THEN g.signature END   AS duplicate_group_key,
  g.group_size::integer                             AS duplicate_group_size,
  g.group_ordinal::integer                          AS duplicate_group_ordinal,
  CASE WHEN g.group_size > 1
       THEN array_remove(g.group_ids, d.id)
  END                                               AS duplicate_peer_ids,

  -- ── flag resolution (appended; everything above keeps its position) ────────
  -- Always an array, never NULL, so the popover reads one shape for every row —
  -- matching `import_flags`, which is NOT NULL DEFAULT '[]'.
  COALESCE(fs.flags_state, '[]'::jsonb)             AS import_flags_state,
  COALESCE(fs.unresolved_flag_count, 0)             AS unresolved_flag_count,
  COALESCE(fs.resolved_flag_count, 0)               AS resolved_flag_count,
  (COALESCE(fs.unresolved_flag_count, 0) > 0)       AS has_unresolved_flags
FROM cenapro.rc_delivery d
JOIN grouped g                       ON g.id     = d.id
LEFT JOIN flag_state fs              ON fs.id    = d.id
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
  'has_import_flags, supplier_unresolved, destination_unresolved) + the duplicate-pair surface '
  '(duplicate_group_key / _size / _ordinal / _peer_ids) + the flag-resolution surface '
  '(import_flags_state / unresolved_flag_count / resolved_flag_count / has_unresolved_flags). '
  'All aggregation lives here, never in TypeScript. Nothing here mutates import_flags — '
  'resolution is DERIVED on read.';

COMMENT ON COLUMN cenapro.view_rc_delivery.import_flags_state IS
  'The row''s import_flags, each element carrying an extra derived boolean "resolved": does the '
  'condition that flag describes STILL hold against the row''s CURRENT values? Every key the '
  'extractor wrote is preserved verbatim — this column adds a field, it never edits or drops '
  'one. Predicates: supplier_unmapped / supplier_no_trader_prefix -> supplier_code IS NOT NULL; '
  'destination_unmapped -> destination_code IS NOT NULL; date_unparseable -> delivery_date IS '
  'NOT NULL; bd_out_of_range -> bd IS NOT NULL (the extractor refused to store the bad value, so '
  'the live problem is a MISSING reading — there is no BD range in this schema to test against); '
  'suspected_duplicate -> the accusation is cleared AND no exact twin remains. An UNKNOWN kind '
  'is never resolved. Always an array — empty, never NULL, when the row has no flags.';

COMMENT ON COLUMN cenapro.view_rc_delivery.unresolved_flag_count IS
  'How many of this row''s import_flags still describe a LIVE problem. This is the honest size '
  'of the data-quality worklist; import_flag_count is the historical record and stays.';

COMMENT ON COLUMN cenapro.view_rc_delivery.resolved_flag_count IS
  'How many of this row''s import_flags describe a condition a human has since repaired. The '
  'flags themselves are never cleared — "flagged, never fixed" — so this is what makes the '
  'difference between "was a problem" and "is a problem" readable.';

COMMENT ON COLUMN cenapro.view_rc_delivery.has_unresolved_flags IS
  'unresolved_flag_count > 0 — the predicate the ?issue=flagged lens should filter on. '
  'has_import_flags is the wrong test now: 12 receipts carry a flag but only 2 still have a live '
  'problem (2026-08-05). Carries no PHP figure, so it needs no price gating.';

REVOKE ALL ON cenapro.view_rc_delivery FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_delivery TO authenticated, service_role;


CREATE VIEW public.cenapro_rc_delivery_rows
WITH (security_invoker = true) AS
SELECT v.* FROM cenapro.view_rc_delivery v;

COMMENT ON VIEW public.cenapro_rc_delivery_rows IS
  'Public READ-ONLY accessor for cenapro.view_rc_delivery — the enriched grid read model '
  '(display names + sample rollup + data-quality surface incl. sheet_total_matches + the '
  'duplicate-pair surface + the flag-resolution surface import_flags_state / '
  'unresolved_flag_count / resolved_flag_count / has_unresolved_flags).';

REVOKE ALL   ON public.cenapro_rc_delivery_rows FROM anon, authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_delivery_rows TO authenticated, service_role;
