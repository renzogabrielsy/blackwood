-- ─────────────────────────────────────────────────────────────────────────────
-- Cenapro (Tenant #2) — RC DELIVERIES: raw-charcoal receipts.
--
-- WHAT THIS IS
-- The Cenapro analogue of ICTC's `public.deliveries`, sourced from the "RC 2026"
-- tab of Cenapro's RC workbook. One row per truck receipt: who supplied it, what
-- it weighed on the scale, what quality deduction was applied, the lab panel, the
-- yard it went to, and what CI owes for it. Liquidation (assigning cheques to
-- receipts) is the next feature to land on top of this.
--
-- ─── THREE DESIGN DECISIONS THAT ARE NOT NEGOTIABLE ──────────────────────────
--
-- 1. DELIVERIES SHARE ZERO DIMENSIONS WITH PRODUCTION.
--    `cenapro.warehouse` / `cenapro.source_location` / `cenapro.plant` describe
--    the FLEC/partner side of the plant — finished-goods warehouses, feed tanks,
--    crusher lines. A raw-charcoal yard is a different physical place with a
--    different code space ("WHSE A", "WHSE 13", "W6 PROD", "DRYER"). Reusing or
--    extending the production dimensions would silently marry two unrelated
--    vocabularies and make every future rename a cross-module incident. Hence the
--    `rc_`-prefixed dimension tables below. Do NOT add an FK from anything here
--    to a production dimension.
--
-- 2. MONEY IS DECOMPOSED, NEVER A SINGLE OPAQUE NUMBER.
--    The sheet's WT column is frequently a formula: `=27045*88%` — a gross scale
--    weight with a 12% quality deduction — and TTL PRICE always multiplies the
--    DISCOUNTED weight. So the payable weight and the payable total are STORED
--    GENERATED columns derived from `gross_weight_kg` + `deduction_pct` +
--    `base_price_php_kg` + `price_adjustment_php_kg`. A generated column is not
--    writable by anyone — not the app, not the importer, not a stray UPDATE — so
--    the number a cheque is cut against can never drift from its inputs.
--
--    THE POSTGRES CONSTRAINT AND HOW IT IS SOLVED
--    A generated column cannot reference another generated column ("cannot use
--    generated column X in column generation expression" — verified live on PG
--    17.6). `net_weight_kg` and `price_php_kg` each reference only base columns,
--    so they are fine. `total_price_php` would naturally be `net × price`, which
--    is exactly the forbidden shape. TWO options existed: repeat the full
--    arithmetic over the base columns, or drop the total into the read view.
--    THIS MIGRATION REPEATS THE ARITHMETIC, deliberately:
--      * liquidation will SUM and index the payable total; a view column is
--        neither summable at the table level nor indexable;
--      * a view column is only correct for callers who remember to read the view,
--        and PostgREST hands out the writable table view too;
--      * a stored generated column is the only form that is *impossible* to
--        overwrite, which is the entire point of decision 2.
--    The duplication is then made safe by `cenapro_rc_delivery_total_consistent`,
--    a CHECK constraint that asserts `total_price_php = net × price` on every
--    row. A CHECK *may* reference generated columns (also verified live), so the
--    two expressions cannot drift apart without the database refusing the write.
--
--    EXACT ARITHMETIC, NO ROUNDING. Postgres `numeric` is exact decimal, and the
--    workbook keeps fractional centavos (row 47's TTL PRICE is ₱1,027,132.875).
--    Rounding to 2 dp reproduces only 972 of 991 sheet totals; the unrounded
--    product reproduces 991 of 991. `trim_scale()` only strips the trailing zeros
--    numeric division leaves behind — it changes no value.
--
-- 3. ALL 991 SHEET ROWS LAND AS REFERENCE DATA — FLAGGED, NOT FIXED.
--    Nothing is silently corrected. The 22 suspected duplicates, the 2
--    unparseable dates, the 1 out-of-range BD, the 5 unmapped destinations and
--    the 4 unresolved suppliers are all stored and queryable, via
--    `is_suspected_duplicate`, `import_flags`, and NULL FK columns.
--    Consequences, each deliberate:
--      * `supplier_code` / `destination_code` are NULLABLE (an unmapped label
--        must not block the row) and the operator's original string is always
--        kept in `supplier_raw` / `destination_raw`.
--      * `delivery_date` is NULLABLE. THIS IS THE ONE DEVIATION FROM THE BRIEF,
--        which asked for NOT NULL. The two rows whose date cell reads "5/262026"
--        have no parseable date, and requiring one would have meant either
--        dropping them or inventing a date — both forbidden by this decision.
--        The NOT NULL *intent* is preserved by
--        `cenapro_rc_delivery_date_present`: a NULL date is legal ONLY on a
--        `sheet_import` row that carries the operator's literal text in
--        `delivery_date_raw`. An app write with no date is still refused.
--      * The lab columns carry NO range CHECK, unlike `cenapro.analysis_sample`.
--        A range CHECK would turn one operator typo into a failure of the whole
--        import, which is precisely the "silently drop it" failure mode this
--        decision exists to prevent. Flagging is the mechanism, not constraints.
--        (On the RC 2026 tab the extractor already caught the one bad BD — a
--        weight typed into the BD cell — so `bd` is NULL there and the value
--        23995.0 is preserved inside `import_flags`.)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. DIMENSIONS — `rc_`-prefixed, deliveries-only (see decision 1)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The cheque payee ─────────────────────────────────────────────────────────
-- The supplier column on the sheet is a free-text blend of trader, origin and
-- permit ("PALAWAN BROOKE'S PSAU 251889-3", "BRIX - MASBATE GLORIA"). What CI
-- actually pays is the TRADER. This table exists so the trader can be re-pointed
-- later WITHOUT a migration: if PALAWAN one day splits into RANDY and BROOKE'S,
-- you add two rows here and re-point the deliveries — the fact table never moves.
CREATE TABLE IF NOT EXISTS cenapro.rc_supplier (
  code          text PRIMARY KEY,
  display_name  text        NOT NULL,
  sort_order    integer     NOT NULL DEFAULT 0,
  active        boolean     NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cenapro_rc_supplier_code_nonblank CHECK (btrim(code) <> '')
);

COMMENT ON TABLE cenapro.rc_supplier IS
  'Raw-charcoal SUPPLIER (cheque payee) dimension for Cenapro RC deliveries. Deliberately '
  'shares nothing with the production-side dimensions — see the migration header, decision 1. '
  'Exists so a trader can be split or re-pointed without a schema change.';


-- ── The raw-charcoal yard ────────────────────────────────────────────────────
-- Where the truck tipped: a storage warehouse, a plant feed line, or the dryer.
-- `has_sides` records whether that yard is split LFT/RT on the sheet.
CREATE TABLE IF NOT EXISTS cenapro.rc_destination (
  code          text PRIMARY KEY,
  display_name  text        NOT NULL,
  kind          text        NOT NULL,
  has_sides     boolean     NOT NULL DEFAULT false,
  sort_order    integer     NOT NULL DEFAULT 0,
  active        boolean     NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cenapro_rc_destination_code_nonblank CHECK (btrim(code) <> ''),
  CONSTRAINT cenapro_rc_destination_kind_ck
    CHECK (kind IN ('warehouse', 'plant_feed', 'dryer'))
);

COMMENT ON TABLE cenapro.rc_destination IS
  'Raw-charcoal DESTINATION (yard) dimension for Cenapro RC deliveries: warehouse | plant_feed '
  '| dryer. Separate from cenapro.warehouse on purpose — a raw-charcoal yard and a finished-goods '
  'FLEC warehouse are different places with different code spaces (see the migration header).';

COMMENT ON COLUMN cenapro.rc_destination.has_sides IS
  'True when the sheet splits this yard LFT/RT. Descriptive only — it is NOT enforced against '
  'rc_delivery.destination_side, so re-classifying a yard can never invalidate historic rows.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. THE FACT TABLE — columns in the sheet's own left-to-right order
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cenapro.rc_delivery (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── date ───────────────────────────────────────────────────────────────────
  -- Nullable ONLY to let an unparseable sheet date land flagged; see decision 3
  -- and the cenapro_rc_delivery_date_present CHECK below.
  delivery_date            date,
  delivery_date_raw        text,
  delivery_year            integer GENERATED ALWAYS AS
                             (EXTRACT(YEAR FROM delivery_date)::integer) STORED,

  -- ── truck ──────────────────────────────────────────────────────────────────
  -- TEXT, not integer: a truck number is an identifier, not a quantity, and a
  -- leading zero is part of it.
  truck_no                 text,

  -- ── supplier ───────────────────────────────────────────────────────────────
  supplier_code            text REFERENCES cenapro.rc_supplier(code)
                                ON UPDATE CASCADE ON DELETE SET NULL,
  supplier_origin          text,
  permit_no                text,
  supplier_raw             text,

  -- ── quantity ───────────────────────────────────────────────────────────────
  sacks                    integer,

  -- ── weight: gross → deduction → payable (decision 2) ───────────────────────
  gross_weight_kg          numeric,
  deduction_pct            numeric,
  net_weight_kg            numeric GENERATED ALWAYS AS
                             (trim_scale(gross_weight_kg
                                         * (100 - COALESCE(deduction_pct, 0)) / 100)) STORED,
  weight_formula           text,

  -- ── lab panel (NO range CHECKs — see decision 3) ───────────────────────────
  bd                       numeric,
  moisture_pct             numeric,
  grit                     numeric,
  ash                      numeric,
  dust                     numeric,
  vm                       numeric,
  fc                       numeric,

  -- ── destination ────────────────────────────────────────────────────────────
  destination_code         text REFERENCES cenapro.rc_destination(code)
                                ON UPDATE CASCADE ON DELETE SET NULL,
  destination_side         text,
  destination_raw          text,

  -- ── remarks: ONE free-text column, deliberately not split ──────────────────
  remarks                  text,

  -- ── price: base → adjustment → payable rate → payable total (decision 2) ───
  base_price_php_kg        numeric,
  price_adjustment_php_kg  numeric,
  price_php_kg             numeric GENERATED ALWAYS AS
                             (trim_scale(base_price_php_kg
                                         + COALESCE(price_adjustment_php_kg, 0))) STORED,
  price_formula            text,

  -- The payable total. Repeats the full arithmetic over BASE columns because a
  -- generated column may not reference a generated column; kept honest by
  -- cenapro_rc_delivery_total_consistent. COALESCE(...,0) on both factors so a
  -- receipt with no weight or no price yet reads ₱0 payable rather than NULL —
  -- which is both what the workbook's own TTL PRICE cell says and what a
  -- liquidation SUM needs.
  total_price_php          numeric GENERATED ALWAYS AS
                             (trim_scale(
                                COALESCE(gross_weight_kg
                                         * (100 - COALESCE(deduction_pct, 0)) / 100, 0)
                                * COALESCE(base_price_php_kg
                                           + COALESCE(price_adjustment_php_kg, 0), 0))) STORED,

  -- ── provenance & data quality (decision 3) ─────────────────────────────────
  provenance               text        NOT NULL DEFAULT 'app',
  source_sheet             text,
  source_row               integer,
  sheet_total_php          numeric,
  is_suspected_duplicate   boolean     NOT NULL DEFAULT false,
  import_flags             jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- ── concurrency / audit ────────────────────────────────────────────────────
  row_version              integer     NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- ── constraints ────────────────────────────────────────────────────────────
  CONSTRAINT cenapro_rc_delivery_provenance_ck
    CHECK (provenance IN ('sheet_import', 'app')),

  -- The NOT NULL the brief asked for, expressed as an invariant that still lets
  -- an unparseable sheet date land: a missing date is legal ONLY on an imported
  -- row that preserves what the operator actually typed.
  CONSTRAINT cenapro_rc_delivery_date_present
    CHECK (delivery_date IS NOT NULL
           OR (provenance = 'sheet_import' AND btrim(COALESCE(delivery_date_raw, '')) <> '')),

  CONSTRAINT cenapro_rc_delivery_side_ck
    CHECK (destination_side IS NULL OR destination_side IN ('LFT', 'RT')),

  -- Shape guards, not range guards. A negative sack count or a 130% deduction is
  -- impossible rather than unusual; the lab panel deliberately has no bounds.
  CONSTRAINT cenapro_rc_delivery_sacks_ck
    CHECK (sacks IS NULL OR sacks >= 0),
  CONSTRAINT cenapro_rc_delivery_gross_ck
    CHECK (gross_weight_kg IS NULL OR gross_weight_kg >= 0),
  CONSTRAINT cenapro_rc_delivery_deduction_ck
    CHECK (deduction_pct IS NULL OR (deduction_pct >= 0 AND deduction_pct < 100)),
  CONSTRAINT cenapro_rc_delivery_base_price_ck
    CHECK (base_price_php_kg IS NULL OR base_price_php_kg >= 0),

  CONSTRAINT cenapro_rc_delivery_import_flags_is_array
    CHECK (jsonb_typeof(import_flags) = 'array'),

  -- An imported row must say which tab and line it came from; an app row must not
  -- pretend to have one. This is also what makes the import idempotent (below).
  CONSTRAINT cenapro_rc_delivery_provenance_shape
    CHECK ((provenance = 'sheet_import' AND source_sheet IS NOT NULL AND source_row IS NOT NULL)
           OR (provenance = 'app' AND source_sheet IS NULL AND source_row IS NULL)),

  -- Import idempotency key. Both columns are NULL on app rows and NULLs are
  -- distinct in a unique index, so hand-entered receipts are unconstrained while
  -- a re-run of the importer upserts instead of duplicating. A full (not partial)
  -- UNIQUE on purpose — PostgREST's `on_conflict=` cannot target a partial index.
  CONSTRAINT cenapro_rc_delivery_source_key UNIQUE (source_sheet, source_row),

  -- THE ANTI-DRIFT GUARD for decision 2. total_price_php repeats the arithmetic
  -- of net_weight_kg × price_php_kg over the base columns because a generated
  -- column cannot reference a generated column; this asserts the two forms agree
  -- on every single row, so they cannot silently diverge in a later migration.
  CONSTRAINT cenapro_rc_delivery_total_consistent
    CHECK (total_price_php = COALESCE(net_weight_kg, 0) * COALESCE(price_php_kg, 0))
);

COMMENT ON TABLE cenapro.rc_delivery IS
  'Cenapro RC DELIVERIES — one raw-charcoal truck receipt, in the RC workbook''s own column '
  'order. The Cenapro analogue of public.deliveries, sharing nothing with it. Payable weight '
  '(net_weight_kg) and payable total (total_price_php) are STORED GENERATED columns: nobody '
  'can overwrite them, which is what liquidation needs. Imported rows are reference data — '
  'flagged via import_flags / is_suspected_duplicate, never corrected.';

COMMENT ON COLUMN cenapro.rc_delivery.delivery_date IS
  'NULLABLE only so an unparseable sheet date can land flagged. cenapro_rc_delivery_date_present '
  'still refuses a dateless app write, and refuses an imported one unless delivery_date_raw '
  'preserves what the operator typed.';
COMMENT ON COLUMN cenapro.rc_delivery.delivery_date_raw IS
  'The literal date text from the sheet when it could not be parsed (e.g. "5/262026"). Same '
  'keep-the-original discipline as supplier_raw / destination_raw / weight_formula.';
COMMENT ON COLUMN cenapro.rc_delivery.delivery_year IS
  'Generated from delivery_date, for multi-year scoping (pre-2026 tabs are expected later). '
  'NULL exactly when the date is.';
COMMENT ON COLUMN cenapro.rc_delivery.truck_no IS
  'Text, not integer — an identifier, not a quantity; leading zeros are significant.';
COMMENT ON COLUMN cenapro.rc_delivery.supplier_raw IS
  'The operator''s original supplier string, ALWAYS kept, even when supplier_code resolved.';
COMMENT ON COLUMN cenapro.rc_delivery.gross_weight_kg IS
  'The scale figure, before any quality deduction. NOT the payable weight.';
COMMENT ON COLUMN cenapro.rc_delivery.deduction_pct IS
  'The percentage REMOVED, so the sheet''s "=27045*88%" is stored as 12. NULL = no deduction.';
COMMENT ON COLUMN cenapro.rc_delivery.net_weight_kg IS
  'PAYABLE weight = gross x (100 - deduction_pct)/100. GENERATED STORED — not writable by anyone.';
COMMENT ON COLUMN cenapro.rc_delivery.weight_formula IS
  'The literal formula the operator typed ("=27045*88%"), so the cell can show it back on click.';
COMMENT ON COLUMN cenapro.rc_delivery.price_php_kg IS
  'PAYABLE rate = base + COALESCE(adjustment, 0). GENERATED STORED.';
COMMENT ON COLUMN cenapro.rc_delivery.total_price_php IS
  'PAYABLE total = net_weight_kg x price_php_kg, written out over the BASE columns because a '
  'generated column may not reference a generated column. cenapro_rc_delivery_total_consistent '
  'asserts the two forms agree. Exact decimal, never rounded — the workbook keeps fractional '
  'centavos. 0 (not NULL) when weight or price is missing, matching the sheet''s own TTL PRICE.';
COMMENT ON COLUMN cenapro.rc_delivery.sheet_total_php IS
  'The workbook''s OWN printed TTL PRICE, kept as an independent witness against the computed '
  'total_price_php. Never used in any calculation. Verified equal on all 991 imported rows.';
COMMENT ON COLUMN cenapro.rc_delivery.import_flags IS
  'JSON array of {kind, detail, raw} recorded by the extractor: date_unparseable, '
  'supplier_unmapped, supplier_no_trader_prefix, destination_unmapped, bd_out_of_range, '
  'suspected_duplicate. The bad VALUE lives here when it could not be stored in its column '
  '(e.g. a weight typed into the BD cell). Query with: import_flags @> ''[{"kind":"..."}]''.';
COMMENT ON COLUMN cenapro.rc_delivery.is_suspected_duplicate IS
  'Set by the importer, cleared by a human. A duplicate is FLAGGED and kept, never dropped.';
COMMENT ON COLUMN cenapro.rc_delivery.row_version IS
  'Optimistic-concurrency token, bumped by trigger on EVERY update (including raw view DML), so '
  'a write through the accessor view cannot silently defeat cenapro_save_rc_delivery''s lock.';


-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Postgres does NOT index a foreign key automatically; both FK columns get one so
-- a supplier rename (ON UPDATE CASCADE) and the read view's joins stay cheap.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_delivery_date
  ON cenapro.rc_delivery (delivery_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_delivery_year_date
  ON cenapro.rc_delivery (delivery_year, delivery_date);
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_delivery_supplier
  ON cenapro.rc_delivery (supplier_code, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_delivery_destination
  ON cenapro.rc_delivery (destination_code, delivery_date DESC);
-- Data-quality triage: "show me everything that needs a human" must be instant.
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_delivery_flagged
  ON cenapro.rc_delivery USING gin (import_flags)
  WHERE import_flags <> '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_cenapro_rc_delivery_suspected_dup
  ON cenapro.rc_delivery (delivery_date)
  WHERE is_suspected_duplicate;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. THE MOISTURE SUB-SAMPLES
-- ═════════════════════════════════════════════════════════════════════════════
-- The "#1 / #2 / #3" rows tucked under a delivery — and also "BLUE SACKS",
-- "SACK MARKING #1", "NO MARK/SUNDRY". The labels are operator free text (39
-- distinct forms across 244 samples), so `label` is text and NOT an enum. Most
-- carry moisture only; a handful carry a full panel, so all seven lab columns are
-- present and nullable, exactly as on the parent.
CREATE TABLE IF NOT EXISTS cenapro.rc_delivery_sample (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id   uuid NOT NULL REFERENCES cenapro.rc_delivery(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  label         text,

  bd            numeric,
  moisture_pct  numeric,
  grit          numeric,
  ash           numeric,
  dust          numeric,
  vm            numeric,
  fc            numeric,

  source_row    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cenapro_rc_delivery_sample_position_ck CHECK (position >= 1),
  CONSTRAINT cenapro_rc_delivery_sample_key UNIQUE (delivery_id, position)
);

COMMENT ON TABLE cenapro.rc_delivery_sample IS
  'Per-delivery moisture sub-samples (1..6 per receipt). Child of cenapro.rc_delivery, ON DELETE '
  'CASCADE. Labels are operator free text. Same seven nullable lab columns as the parent — most '
  'rows carry moisture_pct only.';

-- The UNIQUE (delivery_id, position) index already serves the parent lookup.


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. TOUCH TRIGGER — row_version / updated_at / updated_by
-- ═════════════════════════════════════════════════════════════════════════════
-- In a TRIGGER rather than in the save RPC, so optimistic concurrency still holds
-- when someone writes through the auto-updatable accessor view instead. Same
-- reasoning (and shape) as cenapro.fn_touch_analysis_sample.
CREATE OR REPLACE FUNCTION cenapro.fn_touch_rc_delivery()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := coalesce(NEW.created_by, auth.uid());
    NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
    RETURN NEW;
  END IF;

  NEW.updated_at  := now();
  NEW.row_version := OLD.row_version + 1;
  NEW.created_at  := OLD.created_at;
  NEW.created_by  := OLD.created_by;
  -- Attribute the write when there is a logged-in user; a service-role import has
  -- no auth.uid() and must not blank out whoever last touched the row.
  NEW.updated_by  := coalesce(auth.uid(), NEW.updated_by);
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION cenapro.fn_touch_rc_delivery() IS
  'BEFORE INSERT/UPDATE on cenapro.rc_delivery: stamps created_by/updated_by from auth.uid(), '
  'and on UPDATE bumps row_version + updated_at while freezing created_at/created_by. In a '
  'trigger so EVERY write path — RPC or raw view DML — advances the concurrency token.';

REVOKE EXECUTE ON FUNCTION cenapro.fn_touch_rc_delivery() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION cenapro.fn_touch_rc_delivery() TO authenticated, service_role;

DROP TRIGGER IF EXISTS tr_cenapro_rc_delivery_touch ON cenapro.rc_delivery;
CREATE TRIGGER tr_cenapro_rc_delivery_touch
  BEFORE INSERT OR UPDATE ON cenapro.rc_delivery
  FOR EACH ROW EXECUTE FUNCTION cenapro.fn_touch_rc_delivery();


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. RLS + GRANTS — and the cenapro DEFAULT ACL trap
-- ═════════════════════════════════════════════════════════════════════════════
-- `pg_default_acl` for schema cenapro is {anon=r, authenticated=arwd,
-- service_role=arwd}: every new relation here is BORN readable by anon and
-- writable by authenticated, whatever the CREATE said. Revoke explicitly, then
-- grant back only what is intended. Posture per CLAUDE.md: single-org, so
-- authenticated = org member = broad read+write, enforcement lives in the server
-- action layer, anon gets nothing, service_role bypasses RLS.

ALTER TABLE cenapro.rc_supplier         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cenapro.rc_destination      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cenapro.rc_delivery         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cenapro.rc_delivery_sample  ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rc_supplier', 'rc_destination', 'rc_delivery', 'rc_delivery_sample']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS cenapro_%1$s_select ON cenapro.%1$I', t);
    EXECUTE format('CREATE POLICY cenapro_%1$s_select ON cenapro.%1$I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS cenapro_%1$s_insert ON cenapro.%1$I', t);
    EXECUTE format('CREATE POLICY cenapro_%1$s_insert ON cenapro.%1$I FOR INSERT TO authenticated WITH CHECK (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS cenapro_%1$s_update ON cenapro.%1$I', t);
    EXECUTE format('CREATE POLICY cenapro_%1$s_update ON cenapro.%1$I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS cenapro_%1$s_delete ON cenapro.%1$I', t);
    EXECUTE format('CREATE POLICY cenapro_%1$s_delete ON cenapro.%1$I FOR DELETE TO authenticated USING (true)', t);

    EXECUTE format('REVOKE ALL ON cenapro.%1$I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON cenapro.%1$I TO authenticated, service_role', t);
  END LOOP;
END $do$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. THE ENRICHED READ VIEW (in `cenapro`, where the business logic lives)
-- ═════════════════════════════════════════════════════════════════════════════
-- Joins the two dimensions for display, and folds in the child samples. Per
-- CLAUDE.md the aggregate belongs here, never in TypeScript.
CREATE OR REPLACE VIEW cenapro.view_rc_delivery
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
  -- Sub-sample rollup. avg() already ignores NULL moisture readings; rounded to
  -- 3 dp because the sheet records moisture to 2-3 dp.
  sm.sample_count,
  sm.sample_avg_moisture_pct,
  -- Data-quality surface (decision 3): the flags travel WITH the row.
  d.provenance,
  d.source_sheet,
  d.source_row,
  d.sheet_total_php,
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
  'sample_count / sample_avg_moisture_pct + the data-quality surface (has_import_flags, '
  'supplier_unresolved, destination_unresolved). All aggregation lives here, never in TypeScript.';

REVOKE ALL ON cenapro.view_rc_delivery FROM anon, authenticated, service_role;
GRANT SELECT ON cenapro.view_rc_delivery TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. PUBLIC ACCESSORS — the `cenapro` schema is not exposed to PostgREST
-- ═════════════════════════════════════════════════════════════════════════════
-- Same pattern as public.cenapro_production_events: a thin SINGLE-TABLE
-- projection in `public` is AUTO-UPDATABLE, so a plain GRANT lets
-- supabase.from('cenapro_rc_deliveries').insert()/.update()/.delete() rewrite
-- straight to base-table DML and fire its triggers and constraints.
--
-- NOTE FOR WRITERS: the generated columns (delivery_year, net_weight_kg,
-- price_php_kg, total_price_php) are readable through these views but must be
-- OMITTED from any INSERT/UPDATE payload — the base table rejects an explicit
-- value for a generated column. That is the intended behaviour of decision 2.

CREATE OR REPLACE VIEW public.cenapro_rc_suppliers
WITH (security_invoker = true) AS
SELECT s.code, s.display_name, s.sort_order, s.active, s.notes, s.created_at, s.updated_at
  FROM cenapro.rc_supplier s;

COMMENT ON VIEW public.cenapro_rc_suppliers IS
  'Public auto-updatable accessor for cenapro.rc_supplier (the cheque-payee dimension). Writable '
  'by authenticated so a trader can be added or re-pointed without a migration.';

CREATE OR REPLACE VIEW public.cenapro_rc_destinations
WITH (security_invoker = true) AS
SELECT d.code, d.display_name, d.kind, d.has_sides, d.sort_order, d.active, d.notes,
       d.created_at, d.updated_at
  FROM cenapro.rc_destination d;

COMMENT ON VIEW public.cenapro_rc_destinations IS
  'Public auto-updatable accessor for cenapro.rc_destination (the raw-charcoal yard dimension).';

CREATE OR REPLACE VIEW public.cenapro_rc_deliveries
WITH (security_invoker = true) AS
SELECT
  d.id,
  d.delivery_date, d.delivery_date_raw, d.delivery_year,
  d.truck_no,
  d.supplier_code, d.supplier_origin, d.permit_no, d.supplier_raw,
  d.sacks,
  d.gross_weight_kg, d.deduction_pct, d.net_weight_kg, d.weight_formula,
  d.bd, d.moisture_pct, d.grit, d.ash, d.dust, d.vm, d.fc,
  d.destination_code, d.destination_side, d.destination_raw,
  d.remarks,
  d.base_price_php_kg, d.price_adjustment_php_kg, d.price_php_kg, d.price_formula,
  d.total_price_php,
  d.provenance, d.source_sheet, d.source_row, d.sheet_total_php,
  d.is_suspected_duplicate, d.import_flags,
  d.row_version, d.created_at, d.created_by, d.updated_at, d.updated_by
FROM cenapro.rc_delivery d;

COMMENT ON VIEW public.cenapro_rc_deliveries IS
  'Public auto-updatable accessor for cenapro.rc_delivery. INSERT/UPDATE/DELETE rewrite to the '
  'base table. OMIT the generated columns (delivery_year, net_weight_kg, price_php_kg, '
  'total_price_php) from any write payload. Prefer public.cenapro_save_rc_delivery() for app '
  'saves — it enforces row_version and refuses provenance tampering.';

CREATE OR REPLACE VIEW public.cenapro_rc_delivery_samples
WITH (security_invoker = true) AS
SELECT x.id, x.delivery_id, x.position, x.label,
       x.bd, x.moisture_pct, x.grit, x.ash, x.dust, x.vm, x.fc,
       x.source_row, x.created_at
  FROM cenapro.rc_delivery_sample x;

COMMENT ON VIEW public.cenapro_rc_delivery_samples IS
  'Public auto-updatable accessor for cenapro.rc_delivery_sample. Prefer '
  'public.cenapro_save_rc_delivery_samples() — it replaces a delivery''s whole sample block '
  'atomically under the parent''s row_version.';

CREATE OR REPLACE VIEW public.cenapro_rc_delivery_rows
WITH (security_invoker = true) AS
SELECT v.* FROM cenapro.view_rc_delivery v;

COMMENT ON VIEW public.cenapro_rc_delivery_rows IS
  'Public READ-ONLY accessor for cenapro.view_rc_delivery — the enriched grid read model '
  '(display names + sample rollup + data-quality surface).';

-- Grants. `anon` gets nothing anywhere (CLAUDE.md Phase-4 posture).
REVOKE ALL ON public.cenapro_rc_suppliers        FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_destinations     FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_deliveries       FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_delivery_samples FROM anon, authenticated, service_role;
REVOKE ALL ON public.cenapro_rc_delivery_rows    FROM anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cenapro_rc_suppliers        TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cenapro_rc_destinations     TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cenapro_rc_deliveries       TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cenapro_rc_delivery_samples TO authenticated, service_role;
GRANT SELECT                         ON public.cenapro_rc_delivery_rows    TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. THE WRITE PATH — optimistic concurrency, the cenapro_save_analysis_sample
--    idiom (compare-and-set on row_version, checked in the SAME statement)
-- ═════════════════════════════════════════════════════════════════════════════
-- All three functions: SECURITY INVOKER, `SET search_path = ''` with everything
-- schema-qualified, EXECUTE revoked from PUBLIC and granted back to
-- authenticated + service_role only. The local cenapro idiom, stronger than the
-- CLAUDE.md `SET search_path = public` default.
--
-- PATCH-SHAPED, not a 26-argument signature. The UI is an Excel-like grid where
-- an operator edits one cell; a patch says exactly what moved. The allowlist is
-- what makes that safe: an unknown key REFUSES the whole call rather than being
-- ignored (the fn_apply_production_upstream rule — never smuggle a column in,
-- never silently drop one), and provenance / source_sheet / source_row /
-- sheet_total_php / import_flags are deliberately absent from it so an app write
-- can never rewrite an imported row's provenance or erase its flags.
--
-- CONCURRENCY. p_expected_row_version IS NULL  → INSERT a new receipt.
--              p_expected_row_version = n      → UPDATE ... AND row_version = n;
--              a mismatch returns version_conflict PLUS the current version, so
--              the UI can re-read. Never read-then-write, never blind-write.
-- The merge below reads the current row to fill the columns the patch does not
-- mention; that read cannot cause a lost update, because any concurrent commit
-- necessarily bumped row_version and the UPDATE's own WHERE then matches nothing.

CREATE OR REPLACE FUNCTION public.cenapro_save_rc_delivery(
  p_id                   uuid    DEFAULT NULL,
  p_expected_row_version integer DEFAULT NULL,
  p_patch                jsonb   DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  c_allowed constant text[] := ARRAY[
    'delivery_date', 'delivery_date_raw', 'truck_no',
    'supplier_code', 'supplier_origin', 'permit_no', 'supplier_raw',
    'sacks',
    'gross_weight_kg', 'deduction_pct', 'weight_formula',
    'bd', 'moisture_pct', 'grit', 'ash', 'dust', 'vm', 'fc',
    'destination_code', 'destination_side', 'destination_raw',
    'remarks',
    'base_price_php_kg', 'price_adjustment_php_kg', 'price_formula',
    'is_suspected_duplicate'
  ];
  v_bad     text[];
  v_cur     cenapro.rc_delivery;
  v_new     cenapro.rc_delivery;
  v_id      uuid;
  v_version integer;
  v_current integer;
BEGIN
  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_patch must be a JSON object of column -> value.');
  END IF;

  SELECT pg_catalog.array_agg(k)
    INTO v_bad
    FROM pg_catalog.jsonb_object_keys(p_patch) AS k
   WHERE k <> ALL (c_allowed);

  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'unsupported_field', 'fields', pg_catalog.to_jsonb(v_bad),
      'message', 'Refused: ' || pg_catalog.array_to_string(v_bad, ', ')
                 || ' is not an editable column. Generated totals, provenance and import '
                 || 'flags are not writable here.');
  END IF;

  -- ── INSERT ─────────────────────────────────────────────────────────────────
  IF p_id IS NULL THEN
    IF p_expected_row_version IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'p_expected_row_version must be NULL when creating a receipt.');
    END IF;

    v_new := pg_catalog.jsonb_populate_record(NULL::cenapro.rc_delivery, p_patch);

    IF v_new.delivery_date IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'invalid',
        'message', 'delivery_date is required on a receipt entered in the app.');
    END IF;

    INSERT INTO cenapro.rc_delivery AS t (
      delivery_date, delivery_date_raw, truck_no,
      supplier_code, supplier_origin, permit_no, supplier_raw,
      sacks, gross_weight_kg, deduction_pct, weight_formula,
      bd, moisture_pct, grit, ash, dust, vm, fc,
      destination_code, destination_side, destination_raw,
      remarks,
      base_price_php_kg, price_adjustment_php_kg, price_formula,
      is_suspected_duplicate,
      provenance, created_by, updated_by
    ) VALUES (
      v_new.delivery_date, v_new.delivery_date_raw, v_new.truck_no,
      v_new.supplier_code, v_new.supplier_origin, v_new.permit_no, v_new.supplier_raw,
      v_new.sacks, v_new.gross_weight_kg, v_new.deduction_pct, v_new.weight_formula,
      v_new.bd, v_new.moisture_pct, v_new.grit, v_new.ash, v_new.dust, v_new.vm, v_new.fc,
      v_new.destination_code, v_new.destination_side, v_new.destination_raw,
      v_new.remarks,
      v_new.base_price_php_kg, v_new.price_adjustment_php_kg, v_new.price_formula,
      coalesce(v_new.is_suspected_duplicate, false),
      'app', auth.uid(), auth.uid()
    )
    RETURNING t.id, t.row_version INTO v_id, v_version;

    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'inserted', 'id', v_id, 'row_version', v_version);
  END IF;

  -- ── UPDATE ─────────────────────────────────────────────────────────────────
  IF p_expected_row_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_expected_row_version is required when updating — a blind write is refused.');
  END IF;

  SELECT * INTO v_cur FROM cenapro.rc_delivery d WHERE d.id = p_id;
  IF v_cur.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found',
      'message', 'That receipt no longer exists — it was deleted. Reload the ledger.');
  END IF;

  -- Merge the patch over the current row, then assign the allowlisted columns.
  -- jsonb_populate_record does the text -> date / numeric / boolean coercion, so
  -- a malformed value fails loudly here instead of landing as NULL.
  v_new := pg_catalog.jsonb_populate_record(v_cur, p_patch);

  UPDATE cenapro.rc_delivery AS t
     SET delivery_date           = v_new.delivery_date,
         delivery_date_raw       = v_new.delivery_date_raw,
         truck_no                = v_new.truck_no,
         supplier_code           = v_new.supplier_code,
         supplier_origin         = v_new.supplier_origin,
         permit_no               = v_new.permit_no,
         supplier_raw            = v_new.supplier_raw,
         sacks                   = v_new.sacks,
         gross_weight_kg         = v_new.gross_weight_kg,
         deduction_pct           = v_new.deduction_pct,
         weight_formula          = v_new.weight_formula,
         bd                      = v_new.bd,
         moisture_pct            = v_new.moisture_pct,
         grit                    = v_new.grit,
         ash                     = v_new.ash,
         dust                    = v_new.dust,
         vm                      = v_new.vm,
         fc                      = v_new.fc,
         destination_code        = v_new.destination_code,
         destination_side        = v_new.destination_side,
         destination_raw         = v_new.destination_raw,
         remarks                 = v_new.remarks,
         base_price_php_kg       = v_new.base_price_php_kg,
         price_adjustment_php_kg = v_new.price_adjustment_php_kg,
         price_formula           = v_new.price_formula,
         is_suspected_duplicate  = coalesce(v_new.is_suspected_duplicate, false)
   WHERE t.id          = p_id
     AND t.row_version = p_expected_row_version
  RETURNING t.id, t.row_version INTO v_id, v_version;

  IF v_id IS NULL THEN
    SELECT d.row_version INTO v_current FROM cenapro.rc_delivery d WHERE d.id = p_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', 'That receipt no longer exists — it was deleted. Reload the ledger.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this receipt while you were editing. Reload to see '
                 || 'their values.');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'updated', 'id', v_id, 'row_version', v_version);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_save_rc_delivery(uuid, integer, jsonb) IS
  'Save one Cenapro RC receipt. p_id NULL => INSERT (provenance=app); otherwise UPDATE gated on '
  'p_expected_row_version in the same statement as the write. Patch keys are allowlisted — an '
  'unknown key refuses the call. Generated money columns, provenance and import_flags are NOT '
  'writable. Outcomes: inserted | updated | version_conflict | not_found | unsupported_field | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_save_rc_delivery(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_save_rc_delivery(uuid, integer, jsonb) TO authenticated, service_role;


-- ── Delete path ──────────────────────────────────────────────────────────────
-- Same compare-and-set discipline: you may only delete the version you are
-- looking at. Sub-samples cascade.
CREATE OR REPLACE FUNCTION public.cenapro_delete_rc_delivery(
  p_id                   uuid,
  p_expected_row_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_id      uuid;
  v_current integer;
  v_samples integer;
BEGIN
  IF p_id IS NULL OR p_expected_row_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Both p_id and p_expected_row_version are required — a blind delete is refused.');
  END IF;

  SELECT count(*)::integer INTO v_samples
    FROM cenapro.rc_delivery_sample x WHERE x.delivery_id = p_id;

  DELETE FROM cenapro.rc_delivery AS t
   WHERE t.id          = p_id
     AND t.row_version = p_expected_row_version
  RETURNING t.id INTO v_id;

  IF v_id IS NULL THEN
    SELECT d.row_version INTO v_current FROM cenapro.rc_delivery d WHERE d.id = p_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', 'That receipt is already gone.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this receipt while you were looking at it. Reload before '
                 || 'deleting.');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'deleted', 'id', v_id, 'samples_deleted', v_samples);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_delete_rc_delivery(uuid, integer) IS
  'Delete one Cenapro RC receipt, gated on p_expected_row_version in the same statement. Child '
  'sub-samples cascade (count reported back). Outcomes: deleted | version_conflict | not_found | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_delete_rc_delivery(uuid, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_delete_rc_delivery(uuid, integer) TO authenticated, service_role;


-- ── Sub-sample block, replaced atomically under the PARENT's version ─────────
-- The samples of one receipt are edited as a block (add #4, fix #2's moisture),
-- so the whole block is replaced in one call. There is no separate version token
-- on the child: gating on the parent's row_version is both simpler and stricter —
-- it also catches "someone edited the receipt while I was retyping its samples".
-- The parent UPDATE is FIRST, so it row-locks the receipt and its version check
-- fires before a single child row is touched.
CREATE OR REPLACE FUNCTION public.cenapro_save_rc_delivery_samples(
  p_delivery_id          uuid,
  p_expected_row_version integer,
  p_samples              jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  c_allowed constant text[] := ARRAY[
    'position', 'label', 'bd', 'moisture_pct', 'grit', 'ash', 'dust', 'vm', 'fc'
  ];
  v_bad     text[];
  v_id      uuid;
  v_version integer;
  v_current integer;
  v_count   integer;
BEGIN
  IF p_delivery_id IS NULL OR p_expected_row_version IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'Both p_delivery_id and p_expected_row_version are required.');
  END IF;

  IF p_samples IS NULL OR pg_catalog.jsonb_typeof(p_samples) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'invalid',
      'message', 'p_samples must be a JSON array (pass [] to clear the block).');
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT k)
    INTO v_bad
    FROM pg_catalog.jsonb_array_elements(p_samples) AS e,
         pg_catalog.jsonb_object_keys(e) AS k
   WHERE k <> ALL (c_allowed);

  IF v_bad IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'unsupported_field', 'fields', pg_catalog.to_jsonb(v_bad),
      'message', 'Refused: ' || pg_catalog.array_to_string(v_bad, ', ')
                 || ' is not an editable sub-sample column.');
  END IF;

  -- The gate. Bumping the parent (via its touch trigger) is what makes a
  -- sample-block edit visible to another editor's optimistic lock.
  UPDATE cenapro.rc_delivery AS t
     SET updated_by = coalesce(auth.uid(), t.updated_by)
   WHERE t.id          = p_delivery_id
     AND t.row_version = p_expected_row_version
  RETURNING t.id, t.row_version INTO v_id, v_version;

  IF v_id IS NULL THEN
    SELECT d.row_version INTO v_current FROM cenapro.rc_delivery d WHERE d.id = p_delivery_id;
    IF v_current IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'not_found',
        'message', 'That receipt no longer exists. Reload the ledger.');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'version_conflict', 'row_version', v_current,
      'message', 'Someone else changed this receipt while you were editing its samples. Reload.');
  END IF;

  DELETE FROM cenapro.rc_delivery_sample x WHERE x.delivery_id = p_delivery_id;

  INSERT INTO cenapro.rc_delivery_sample
    (delivery_id, position, label, bd, moisture_pct, grit, ash, dust, vm, fc)
  SELECT p_delivery_id,
         coalesce(r.position, (row_number() OVER ())::integer),
         r.label, r.bd, r.moisture_pct, r.grit, r.ash, r.dust, r.vm, r.fc
    FROM pg_catalog.jsonb_to_recordset(p_samples) AS r(
           position integer, label text,
           bd numeric, moisture_pct numeric, grit numeric,
           ash numeric, dust numeric, vm numeric, fc numeric);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'saved', 'delivery_id', v_id,
    'row_version', v_version, 'sample_count', v_count);
END;
$fn$;

COMMENT ON FUNCTION public.cenapro_save_rc_delivery_samples(uuid, integer, jsonb) IS
  'Replace a receipt''s whole moisture sub-sample block in one call, gated on the PARENT''s '
  'row_version (checked in the same statement as the parent bump, before any child row moves). '
  'Pass [] to clear. Outcomes: saved | version_conflict | not_found | unsupported_field | invalid.';

REVOKE EXECUTE ON FUNCTION public.cenapro_save_rc_delivery_samples(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cenapro_save_rc_delivery_samples(uuid, integer, jsonb) TO authenticated, service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. DIMENSION SEED — the 12 suppliers and 16 destinations found on RC 2026
-- ═════════════════════════════════════════════════════════════════════════════
-- Idempotent: ON CONFLICT DO NOTHING, so a re-run never overwrites a name or an
-- active flag a human has since edited.
INSERT INTO cenapro.rc_supplier (code, display_name, sort_order) VALUES
  ('ALI UNGA',  'ALI UNGA',   10),
  ('ANDRAQUE',  'ANDRAQUE',   20),
  ('BRIX',      'BRIX',       30),
  ('DENCIO',    'DENCIO',     40),
  ('NEGROS',    'NEGROS',     50),
  ('NOVAL',     'NOVAL',      60),
  ('OBENZA',    'OBENZA',     70),
  ('PALAWAN',   'PALAWAN',    80),
  ('PULVERA',   'PULVERA',    90),
  ('RAGMERD',   'RAGMERD',   100),
  ('SEVILLA',   'SEVILLA',   110),
  ('ZAPANTA',   'ZAPANTA',   120)
ON CONFLICT (code) DO NOTHING;

-- sort_order follows observed volume on the RC 2026 tab (most-used first); it is
-- data, not structure — re-order it in the app without a migration.
INSERT INTO cenapro.rc_destination (code, display_name, kind, has_sides, sort_order) VALUES
  ('W6 PROD',  'W6 PROD',  'plant_feed', false,  10),
  ('WHSE A',   'WHSE A',   'warehouse',  true,   20),
  ('WHSE 13',  'WHSE 13',  'warehouse',  false,  30),
  ('WHSE D',   'WHSE D',   'warehouse',  false,  40),
  ('W7 PROD',  'W7 PROD',  'plant_feed', false,  50),
  ('WHSE B',   'WHSE B',   'warehouse',  true,   60),
  ('DRYER',    'DRYER',    'dryer',      false,  70),
  ('WHSE C',   'WHSE C',   'warehouse',  true,   80),
  ('WHSE 5',   'WHSE 5',   'warehouse',  true,   90),
  ('WHSE 3A',  'WHSE 3A',  'warehouse',  true,  100),
  ('WHSE 15',  'WHSE 15',  'warehouse',  true,  110),
  ('WHSE 12',  'WHSE 12',  'warehouse',  true,  120),
  ('WHSE 16',  'WHSE 16',  'warehouse',  true,  130),
  ('WHSE 14',  'WHSE 14',  'warehouse',  false, 140),
  ('WHSE 17',  'WHSE 17',  'warehouse',  false, 150),
  ('WHSE 3C',  'WHSE 3C',  'warehouse',  true,  160)
ON CONFLICT (code) DO NOTHING;
