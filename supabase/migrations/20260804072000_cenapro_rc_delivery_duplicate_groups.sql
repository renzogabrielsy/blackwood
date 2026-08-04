-- ─────────────────────────────────────────────────────────────────────────────
-- Cenapro RC DELIVERIES — pair each suspected duplicate with the row it copies.
--
-- WHY
-- `cenapro.rc_delivery.is_suspected_duplicate` is a bare boolean. 22 rows carry
-- it, across three consecutive days (2026-04-06 / 04-07 / 04-08, ₱17,185,939),
-- and the UI can badge them `DUP` — but it cannot show WHICH row each one is a
-- copy of, which is the only thing that makes the badge actionable.
--
-- The boolean can never do that by itself, because THE ORIGINAL IS NOT FLAGGED.
-- The importer flagged only the second occurrence of each receipt, so a query
-- over `is_suspected_duplicate` returns 22 orphans with no partners. Pairing
-- them up requires re-deriving the duplication signature from the DATA.
--
-- ─── THE SIGNATURE, AND THE EVIDENCE FOR IT ──────────────────────────────────
-- Established empirically against all 991 live rows, not assumed. Three tuples
-- were tested:
--
--   A. NARROW receipt identity — date, truck, supplier, gross, deduction, base
--      price.                                   → 25 pairs. WRONG: 3 FALSE ones.
--   B. A + supplier detail, sacks, destination, price adjustment.
--                                               → 22 pairs, exactly the flagged.
--   C. B + the full lab panel + remarks.        → 22 pairs, exactly the flagged.
--
-- B and C disagree on ZERO of the 991 rows. A's three extra pairs are each a
-- genuinely distinct receipt, and each one names a field the signature must
-- therefore carry:
--
--   * rows 1321/1322 (2026-07-14 SEVILLA, remarks 'SAMPLE') — no truck, no
--     weight, no price. They differ ONLY in their lab readings (moisture
--     15.06 vs 11.93, ash 2.76 vs 2.55). Two different lab samples.
--     → THE LAB PANEL IS PART OF THE IDENTITY.
--   * rows 907/908 (2026-05-08 PALAWAN, truck 6202) — same weight, same price,
--     but destination_side LFT vs RT and remarks NULL vs 'BLK 1'. One load
--     split across two sides of WHSE A.
--     → destination_side AND remarks ARE PART OF THE IDENTITY.
--   * rows 1422/1423 (2026-08-04 BRIX) — differ only in destination_code
--     (WHSE 13 vs WHSE D).
--     → destination_code IS PART OF THE IDENTITY.
--
-- C is adopted: it is the strictest of the two correct tuples, and it is what
-- was actually asked for — "so that we know it's actually a dupe with an exact
-- copy of a row". Under C the claim the UI makes is literally true: every
-- business field an operator can see on the grid agrees. Under B the UI could
-- pair two receipts whose lab panels differ, and the claim would be a lie.
--
-- The trade-off, stated plainly: because the lab panel and `remarks` are in the
-- signature, editing EITHER copy un-pairs the group. That is correct behaviour,
-- not a bug — once a value differs the two rows are no longer exact copies, and
-- continuing to call them a pair would be the actual error. `is_suspected_
-- duplicate` is untouched by any of this and keeps flagging the row until a
-- human clears it.
--
-- WHAT IS DELIBERATELY *OUT* OF THE SIGNATURE, and why:
--   * `is_suspected_duplicate` / `import_flags` — THE WHOLE POINT. The grouping
--     must be independent of the importer's opinion, or the unflagged original
--     could never join its own group.
--   * `provenance` / `source_sheet` / `source_row` — these are exactly what
--     DIFFERS between an original and its paste (639 vs 664). Including them
--     would make every row unique and the feature a no-op.
--   * `net_weight_kg` / `price_php_kg` / `total_price_php` / `sheet_total_php` —
--     all functions of base columns already in the tuple. Redundant.
--   * `weight_formula` / `price_formula` — how a number was TYPED, not what it
--     is. `=27045*88%` and a plain 27045 + 12% are the same receipt; an
--     imported row often has no formula where a hand-typed one does.
--   * `delivery_date_raw` — a fallback for an unparseable date, not a value.
--   * `row_version` / `created_at|by` / `updated_at|by` — bookkeeping.
--   * the child `rc_delivery_sample` block — no row on any of the three
--     duplicate days carries a single sub-sample (verified live), so folding the
--     children in would add cost and change nothing. The receipt's OWN lab panel
--     is in the tuple, which is the reading that matters.
--
-- NUMERIC NORMALISATION. Every numeric goes through `trim_scale()` before
-- hashing, so 20725 and 20725.00 — the same weight typed with a different scale
-- — produce the same digest. `numeric_out` renders trailing zeros, so without
-- this a re-import at a different scale would silently un-pair a real duplicate.
--
-- NULLs. The digest is built with `ROW(...)::text`, whose record output renders
-- NULL as empty and '' as `""` — so a NULL truck and an empty-string truck hash
-- DIFFERENTLY, and two NULLs hash the SAME. That is exactly the `GROUP BY`
-- semantics wanted here (a row with no truck number can still be duplicated).
-- A `concat_ws`/`||` digest would have collapsed NULL vs '' or NULL-propagated
-- the whole key away.
--
-- ─── WHY THE DIGEST IS COMPUTED IN THE VIEW AND NOT STORED ───────────────────
-- The obvious alternative — a STORED GENERATED signature column on the fact
-- table plus a btree index — IS NOT AVAILABLE: `md5(ROW(...)::text)` is not
-- IMMUTABLE (record output depends on per-session type-output settings), and
-- Postgres refuses it outright ("generation expression is not immutable",
-- verified live on this database). Hand-rolling an immutable variant and
-- labelling it IMMUTABLE would be a lie that silently corrupts any index built
-- on it the day DateStyle changes.
--
-- It would also buy nothing. `count(*) OVER (PARTITION BY sig)` has to see EVERY
-- row of the partition set regardless of how the key is stored, so no index can
-- prune it. The cost is one WindowAgg over a narrow projection, which is why the
-- CTE below carries only (id, delivery_date, source_row, created_at, sig) and
-- joins the 52 wide columns back afterwards — the sort payload stays tiny as the
-- table grows.
--
-- ─── ONE WINDOW, THREE FUNCTIONS ─────────────────────────────────────────────
-- A single named WINDOW drives all three, which is what keeps them consistent:
--   PARTITION BY sig
--   ORDER BY delivery_date, source_row NULLS LAST, created_at, id
--   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
--
-- The explicit unbounded frame is load-bearing. `count(*)` and `array_agg()` are
-- aggregates used as window functions, so an ORDER BY without a frame would give
-- them the default RANGE …CURRENT ROW — a RUNNING count and a RUNNING array,
-- i.e. every row would report a different group size. The unbounded frame makes
-- both see the whole partition while `row_number()` (which ignores frames) still
-- reads the ORDER BY. Aggregate-level `array_agg(id ORDER BY …)` is not an
-- option — Postgres does not implement aggregate ORDER BY for window functions —
-- so the window's own ORDER BY is what makes `duplicate_peer_ids` deterministic.
--
-- ORDERING WITHIN A GROUP. `delivery_date` is IN the signature, so it is
-- constant inside any group; `source_row` is the real discriminator, and it puts
-- the EARLIEST-TRANSCRIBED row at ordinal 1. That makes ordinal 1 the original
-- and ordinal 2 the paste — verified: all 22 flagged rows land at ordinal 2 and
-- all 22 unflagged peers at ordinal 1, so "copy 2 of 2" reads true rather than
-- being a uuid coin-flip. `created_at` then `id` are deterministic tiebreakers
-- for app-entered rows, which have no `source_row`.
--
-- ─── PRICE GATING ────────────────────────────────────────────────────────────
-- `base_price_php_kg` and `price_adjustment_php_kg` are INPUTS to the digest,
-- but `duplicate_group_key` is an md5 over 22 fields — one-way, and it discloses
-- only that two rows are equal, never what either is worth. NO NEW COLUMN HERE
-- CARRIES A ₱ FIGURE, so none of the four needs adding to `stripPrices()` in
-- app/(app)/cenapro/deliveries/types.ts. A gated viewer sees the same grouping
-- an ungated one does, which is the point — "this receipt is duplicated" is an
-- operational fact, not a money fact.
--
-- ─── SHAPE OF THE CHANGE ─────────────────────────────────────────────────────
-- The four columns are APPENDED at the end, so the existing 52 keep their exact
-- names, types and ORDER — several consumers `select('*')`. That is also why the
-- inner view uses CREATE OR REPLACE rather than DROP + CREATE: Postgres will
-- refuse the replace if a single existing column moved, renamed or changed type,
-- which makes the column list below self-verifying. The public accessor is
-- `SELECT v.*`, whose star was expanded at creation time, so it alone must be
-- dropped and recreated to see the new columns.
-- ─────────────────────────────────────────────────────────────────────────────


-- The accessor's `*` is frozen; drop it so it can pick the new columns up.
DROP VIEW IF EXISTS public.cenapro_rc_delivery_rows;


CREATE OR REPLACE VIEW cenapro.view_rc_delivery
WITH (security_invoker = true)
AS
WITH sig AS (
  -- NARROW projection on purpose: everything the window has to sort, and
  -- nothing else. The 52 display columns are joined back below.
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

  -- ── duplicate pairing (appended; everything above keeps its position) ──────
  -- NULL rather than the digest on a group of one, so `duplicate_group_key IS
  -- NOT NULL` is the single honest test for "this receipt has a twin". Leaving
  -- a live key on every unique row would make the column look like an identity
  -- and invite a JOIN on it.
  CASE WHEN g.group_size > 1 THEN g.signature END   AS duplicate_group_key,
  g.group_size::integer                             AS duplicate_group_size,
  g.group_ordinal::integer                          AS duplicate_group_ordinal,
  -- The OTHER receipts, self removed, in the window's order. NULL (not '{}')
  -- on a singleton so all three "no twin" signals agree: key NULL, peers NULL,
  -- size 1.
  CASE WHEN g.group_size > 1
       THEN array_remove(g.group_ids, d.id)
  END                                               AS duplicate_peer_ids
FROM cenapro.rc_delivery d
JOIN grouped g                       ON g.id     = d.id
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
  '(duplicate_group_key / _size / _ordinal / _peer_ids). All aggregation lives here, never in '
  'TypeScript.';

COMMENT ON COLUMN cenapro.view_rc_delivery.sheet_total_matches IS
  'Does the database''s computed total_price_php equal the workbook''s printed sheet_total_php? '
  'TRUE on all 991 imported rows. FALSE also when there is no sheet witness (app-entered row).';

COMMENT ON COLUMN cenapro.view_rc_delivery.duplicate_group_key IS
  'md5 digest of the exact-copy signature — delivery_date, truck_no, the four supplier fields, '
  'sacks, gross_weight_kg, deduction_pct, the seven lab values, the three destination fields, '
  'remarks, base_price_php_kg, price_adjustment_php_kg (numerics trim_scale-normalised). NULL '
  'when the receipt has no twin. Computed from DATA ONLY and deliberately independent of '
  'is_suspected_duplicate, because the importer flagged only the SECOND copy — the original is '
  'unflagged and could not otherwise join its own group. Carries no ₱ figure: a one-way digest '
  'discloses equality, never value, so it needs no price gating.';

COMMENT ON COLUMN cenapro.view_rc_delivery.duplicate_group_size IS
  'How many receipts share this row''s exact-copy signature. 1 = unique. All 22 groups found in '
  'the 991 imported rows are of size 2.';

COMMENT ON COLUMN cenapro.view_rc_delivery.duplicate_group_ordinal IS
  'This row''s 1-based position within its group, ordered delivery_date, source_row NULLS LAST, '
  'created_at, id — so ordinal 1 is the EARLIEST-transcribed row (the original) and 2 is the '
  'paste. Verified: all 22 is_suspected_duplicate rows sit at ordinal 2. Always 1 on a singleton.';

COMMENT ON COLUMN cenapro.view_rc_delivery.duplicate_peer_ids IS
  'The OTHER receipt ids sharing this row''s signature, self excluded, in duplicate_group_ordinal '
  'order. This is what lets the grid link a DUP badge to the row it copies. NULL (not an empty '
  'array) when there is no twin, matching duplicate_group_key.';

REVOKE ALL ON cenapro.view_rc_delivery FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_delivery TO authenticated, service_role;


CREATE VIEW public.cenapro_rc_delivery_rows
WITH (security_invoker = true) AS
SELECT v.* FROM cenapro.view_rc_delivery v;

COMMENT ON VIEW public.cenapro_rc_delivery_rows IS
  'Public READ-ONLY accessor for cenapro.view_rc_delivery — the enriched grid read model '
  '(display names + sample rollup + data-quality surface incl. sheet_total_matches + the '
  'duplicate-pair surface duplicate_group_key / _size / _ordinal / _peer_ids).';

REVOKE ALL  ON public.cenapro_rc_delivery_rows FROM anon, authenticated, service_role;
GRANT SELECT ON public.cenapro_rc_delivery_rows TO authenticated, service_role;
