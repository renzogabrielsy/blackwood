-- ============================================================================
-- 20260807060000_delivery_price_enrichment.sql
--
-- Three related fixes to the RC IN delivery PRICE path, all triggered by the
-- 2026-08-07 discovery that the sync had priced ZERO August deliveries.
--
-- ROOT CAUSE (code side, fixed in workers/sync/src/reports/deliveries/):
--   the worker generated Czarina's tab name as "<FullMonth> <YYYY>" and looked it
--   up by EXACT match. Her real tabs use at least four conventions
--   ("Aug. 2026", "Feb. 2026", "Jan. 2026.", "March25", "July 2026"), so
--   February and August never matched; the whole-file load threw and a bare
--   `catch` reported it as "Price file unavailable". The file WAS available.
--   Because the price file is loaded ONCE before the row loop, one bad tab name
--   un-priced an ENTIRE run, silently. Nine truckloads (~₱7.1M of charcoal)
--   carried cost_basis = 0 for a week.
--
-- This migration covers the three DATABASE-side consequences:
--   1. avg_cost was being dragged DOWN by unpriced rows (the silent-corruption
--      half). AUGUST-26-BLK1 read ₱11.01 against a real ₱39.99.
--   2. There was no row-level "these deliveries are still unpriced" surface —
--      only a bare count in view_digest_unpriced_recent.
--   3. The three confirmed source-spelling variants (plate/supplier typos in
--      Czarina's file) had nowhere to be remembered, so the same typo would
--      have to be re-adjudicated by a human every time it appears.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. fn_recompute_batch_state — NARROW the avg_cost input set to PRICED rows.
--
-- `batches.avg_cost` still has EXACTLY ONE DEFINITION: delivery-weighted,
--   SUM(cost_basis × weight_kg) / SUM(weight_kg)
-- over the batch's deliveries, consumption ignored (BUG-018, 2026-08-04,
-- Renzo's call). THIS IS NOT A SECOND DEFINITION. The formula is byte-identical;
-- only the INPUT SET changes — a delivery whose price has not arrived yet is no
-- longer treated as a delivery that cost ₱0.
--
-- WHY: cost_basis = 0 is the L-008 UNPRICED PLACEHOLDER, not a real price
-- (apply.ts writes it, and stamps "cost_basis=0 UNPRICED PLACEHOLDER (L-008)"
-- into the audit comment). Including it added weight to the denominator and
-- nothing to the numerator, so the average fell toward zero in proportion to how
-- much of the batch was still awaiting a price:
--     AUGUST-26-BLK1  ₱11.01  (2 of 3 deliveries unpriced)   →  ₱39.99
--     AUGUST-26-BLK2  ₱22.10  (1 of 2 unpriced)
-- The figure was WRONG in a way nobody could see, and it moved every time an
-- unrelated price landed. Narrowed, avg_cost answers "what did the charcoal we
-- have a price for cost", which is the only honest answer while a price is
-- pending — and it converges on the full-batch figure as prices arrive.
--
-- A batch with NO priced delivery yet still reads 0 (COALESCE), same as before.
-- current_weight is untouched: an unpriced delivery is still physically there.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_recompute_batch_state(p_batch_code text)
RETURNS void
LANGUAGE sql
SET search_path TO 'public'
AS $function$
    UPDATE batches SET
        current_weight = COALESCE((
            SELECT SUM(weight_kg) FROM deliveries WHERE batch_code = p_batch_code
        ), 0) - COALESCE((
            SELECT SUM(r.weight_kg) FROM rc_out r
            JOIN batches b2 ON r.batch_id = b2.id
            WHERE b2.batch_code = p_batch_code
        ), 0),
        avg_cost = COALESCE((
            SELECT SUM(cost_basis * weight_kg) / NULLIF(SUM(weight_kg), 0)
            FROM deliveries
            WHERE batch_code = p_batch_code
              -- The ONLY change: exclude the L-008 unpriced placeholder from the
              -- weighted average. Same formula, narrower input set.
              AND cost_basis IS NOT NULL
              AND cost_basis > 0
        ), 0),
        updated_at = now()
    WHERE batch_code = p_batch_code;
$function$;

COMMENT ON FUNCTION public.fn_recompute_batch_state(text) IS
  'The ONE definition of a batch''s derived state. current_weight = SUM(deliveries) - SUM(rc_out). '
  'avg_cost = delivery-weighted SUM(cost_basis*weight_kg)/SUM(weight_kg) over the batch''s deliveries '
  'WHERE cost_basis > 0 (BUG-018 definition, narrowed 2026-08-07 to exclude the L-008 unpriced '
  'placeholder — one definition, narrower input set, NOT a second definition). Idempotent, so it '
  'doubles as the backfill. Called by every branch of fn_update_blackwood_state.';

-- Apply the narrowing to the batches it actually changes: those carrying at least
-- one unpriced delivery. Every other batch recomputes to the identical value, so
-- scoping here keeps the change set provable (and the audit noise at zero).
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT batch_code
    FROM deliveries
    WHERE batch_code IS NOT NULL
      AND (cost_basis IS NULL OR cost_basis <= 0)
  LOOP
    PERFORM public.fn_recompute_batch_state(r.batch_code);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'fn_recompute_batch_state: narrowed avg_cost recomputed for % batch(es).', n;
END $$;


-- ----------------------------------------------------------------------------
-- 2. Unpriced deliveries — the ROW-LEVEL surface.
--
-- `view_digest_unpriced_recent` already existed but returns a bare COUNT over a
-- trailing 30-day window, so it can say "7 deliveries awaiting price enrichment"
-- and nothing more. Renzo's rule ("prices are not supposed to lag, we liquidate
-- daily") needs the ROWS, and needs an overdue boundary.
--
-- Rather than duplicate the 30-day count logic, this adds ONE base view that owns
-- the whole unpriced question, and REWRITES the existing count as a thin
-- projection of it (same column, same type, same value — measured 7 → 7).
--
-- The anchor is `view_digest_operational_days.operational_date` (the plant's last
-- reported day, which lags the calendar) — the same anchor the count already used,
-- so "overdue" never fires on a day the plant has not reported yet.
--
-- NO ₱ COLUMN. Every row here has cost_basis = 0 by construction, so there is no
-- price to leak; weight/date/supplier/batch are not price data.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.view_digest_unpriced_deliveries
WITH (security_invoker = true) AS
WITH od AS (
  SELECT operational_date AS d FROM public.view_digest_operational_days
)
SELECT
  d.id,
  d.transaction_date,
  d.supplier,
  d.batch_code,
  d.block_loc,
  d.truck_plate,
  d.sacks,
  d.weight_kg,
  od.d                                              AS operational_date,
  (od.d - d.transaction_date)::integer              AS days_pending,
  -- Renzo's rule: a delivery still unpriced MORE THAN ONE DAY after its
  -- transaction_date is late. `> 1` (not `>= 1`) gives the price file one day
  -- to arrive, which is how Czarina actually works (she records the payment
  -- date, typically the day after delivery).
  ((od.d - d.transaction_date) > 1)                 AS is_overdue,
  -- Reproduces view_digest_unpriced_recent's window EXACTLY.
  (d.transaction_date >= (od.d - INTERVAL '30 days')
   AND d.transaction_date <= od.d)                  AS is_recent
FROM public.deliveries d
CROSS JOIN od
WHERE d.cost_basis = 0::numeric;

COMMENT ON VIEW public.view_digest_unpriced_deliveries IS
  'One row per delivery still carrying the L-008 unpriced placeholder (cost_basis = 0). Owns the '
  'ONE definition of "unpriced" and of "overdue" (is_overdue = still unpriced more than 1 day after '
  'transaction_date, measured against view_digest_operational_days.operational_date). '
  'view_digest_unpriced_recent is a thin count projection of this view. Carries no ₱ column.';

-- Same single `cnt` column, same integer type, same value — existing consumers
-- (lib/digest/queries.ts) are unaffected.
CREATE OR REPLACE VIEW public.view_digest_unpriced_recent
WITH (security_invoker = true) AS
SELECT count(*)::integer AS cnt
FROM public.view_digest_unpriced_deliveries
WHERE is_recent;

COMMENT ON VIEW public.view_digest_unpriced_recent IS
  'Count of deliveries awaiting price enrichment in the trailing 30 days. Thin projection of '
  'view_digest_unpriced_deliveries (rewritten 2026-08-07 — value unchanged); that view owns the logic.';

REVOKE ALL ON public.view_digest_unpriced_deliveries FROM anon;
GRANT SELECT ON public.view_digest_unpriced_deliveries TO authenticated, service_role;
REVOKE ALL ON public.view_digest_unpriced_recent FROM anon;
GRANT SELECT ON public.view_digest_unpriced_recent TO authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 3. delivery_source_aliases — LEARN the source-spelling variants from history.
--
-- Renzo's idea, and the most valuable part of this change: Czarina writes some
-- plates and supplier names differently from the operator's RC DELIVERIES sheet.
-- Three confirmed cases as of 2026-08-07:
--     truck_plate  ours "T138003"  vs hers "138003"   (prefix)
--     truck_plate  ours "ALA 3958" vs hers "ALA9958"  (one substitution)
--     supplier     ours "Paquibot/Compra" vs hers "PAQUIBOT"
-- Without a memory, each of those needs a human every time it appears. With one,
-- a typo seen once is known forever, and the table grows from real data instead
-- of a hardcoded rule list nobody maintains.
--
-- THE DISCIPLINE (same as the Cenapro supplier subgroups): an alias is EARNED,
-- never guessed. The worker records one ONLY after a match was already
-- corroborated some other way — a uniqueness-gated (date, weight, sacks) fallback
-- match, or a human confirmation. `evidence` is NOT NULL precisely so a row can
-- never exist without saying how it was earned. Nothing infers an alias from
-- name similarity, and nothing here is seeded beyond the three confirmed pairs.
--
-- `ours`/`theirs` hold the values ALREADY NORMALIZED the way the matcher
-- normalizes them (plates: alphanumerics only, uppercased; suppliers:
-- canonical_supplier()), so a lookup is a plain equality and can never disagree
-- with the matcher about what it is comparing. The *_raw columns keep the
-- originals for a human reading the table.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.delivery_source_aliases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('truck_plate', 'supplier')),
  ours              text NOT NULL CHECK (btrim(ours) <> ''),
  theirs            text NOT NULL CHECK (btrim(theirs) <> ''),
  -- An alias records a DIFFERENCE. Two identical values are not an alias, and a
  -- degenerate row would make the matcher's "did an alias fire" answer meaningless.
  CONSTRAINT delivery_source_aliases_distinct CHECK (btrim(ours) <> btrim(theirs)),
  ours_raw          text,
  theirs_raw        text,
  evidence          text NOT NULL CHECK (btrim(evidence) <> ''),
  confirmed_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  first_seen_on     date,
  times_seen        integer NOT NULL DEFAULT 1 CHECK (times_seen > 0),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.delivery_source_aliases IS
  'Learned spelling variants between our RC DELIVERIES sheet and Czarina''s RAW CHARCOAL PURCHASES '
  'file, so a source typo confirmed once is known forever. An alias is EARNED, never guessed: it is '
  'written only after a match was corroborated independently (a uniqueness-gated date+weight+sacks '
  'fallback, or a human confirmation), and `evidence` records how. No ₱ data.';
COMMENT ON COLUMN public.delivery_source_aliases.ours IS
  'OUR value, already normalized the way the matcher normalizes it (plates: alphanumerics only, '
  'uppercased; suppliers: canonical_supplier()). Lookup is plain equality.';
COMMENT ON COLUMN public.delivery_source_aliases.theirs IS 'Czarina''s value, same normalization as `ours`.';
COMMENT ON COLUMN public.delivery_source_aliases.evidence IS
  'How this pair was corroborated. NOT NULL so an alias can never exist without saying why.';
COMMENT ON COLUMN public.delivery_source_aliases.times_seen IS
  'How many runs have re-confirmed this pair. Bumped by fn_record_delivery_source_alias; a pair seen '
  'many times is the strongest evidence the table holds.';

-- One live pair per (kind, ours, theirs). A retired alias keeps its row
-- (active = false) so the history of what was once believed survives.
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_source_aliases_pair
  ON public.delivery_source_aliases (kind, ours, theirs);
-- The matcher's read path: "what does Czarina call OUR value".
CREATE INDEX IF NOT EXISTS idx_delivery_source_aliases_lookup
  ON public.delivery_source_aliases (kind, ours) WHERE active;
-- The reverse path: "whose row is this of hers".
CREATE INDEX IF NOT EXISTS idx_delivery_source_aliases_reverse
  ON public.delivery_source_aliases (kind, theirs) WHERE active;

ALTER TABLE public.delivery_source_aliases ENABLE ROW LEVEL SECURITY;

-- Single-org RLS posture (CLAUDE.md): `authenticated` = org member = read.
-- WRITES are service-role only (the sync worker bypasses RLS) or via the RPC
-- below — an alias is a claim about which two records are the same truckload, so
-- it is not something an ordinary session should be able to invent by hand.
DROP POLICY IF EXISTS delivery_source_aliases_select ON public.delivery_source_aliases;
CREATE POLICY delivery_source_aliases_select
  ON public.delivery_source_aliases FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.delivery_source_aliases FROM anon;
REVOKE ALL ON public.delivery_source_aliases FROM authenticated;
GRANT SELECT ON public.delivery_source_aliases TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.delivery_source_aliases TO service_role;


-- fn_record_delivery_source_alias — the idempotent write path.
-- First sighting INSERTs; a repeat sighting bumps `times_seen` + `last_seen_at`
-- and re-activates a retired pair (the source started using it again), but never
-- rewrites the original `evidence` — the first corroboration is the one that
-- earned the row. Returns the alias id.
CREATE OR REPLACE FUNCTION public.fn_record_delivery_source_alias(
  p_kind        text,
  p_ours        text,
  p_theirs      text,
  p_evidence    text,
  p_ours_raw    text DEFAULT NULL,
  p_theirs_raw  text DEFAULT NULL,
  p_seen_on     date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF p_kind NOT IN ('truck_plate', 'supplier') THEN
    RAISE EXCEPTION 'fn_record_delivery_source_alias: kind must be truck_plate or supplier, got %', p_kind;
  END IF;
  IF p_ours IS NULL OR btrim(p_ours) = '' OR p_theirs IS NULL OR btrim(p_theirs) = '' THEN
    RAISE EXCEPTION 'fn_record_delivery_source_alias: both ours and theirs are required';
  END IF;
  IF p_evidence IS NULL OR btrim(p_evidence) = '' THEN
    RAISE EXCEPTION 'fn_record_delivery_source_alias: evidence is required — an alias is earned, never guessed';
  END IF;
  -- Identical values are not an alias.
  IF btrim(p_ours) = btrim(p_theirs) THEN
    RAISE EXCEPTION 'fn_record_delivery_source_alias: ours and theirs are the same value (%) — not an alias', p_ours;
  END IF;

  INSERT INTO public.delivery_source_aliases
    (kind, ours, theirs, ours_raw, theirs_raw, evidence, first_seen_on)
  VALUES
    (p_kind, btrim(p_ours), btrim(p_theirs), p_ours_raw, p_theirs_raw, p_evidence, p_seen_on)
  ON CONFLICT (kind, ours, theirs) DO UPDATE
    SET times_seen    = delivery_source_aliases.times_seen + 1,
        last_seen_at  = now(),
        active        = true,
        -- LEAST ignores NULLs, so a first_seen_on that was never known gets filled.
        first_seen_on = LEAST(delivery_source_aliases.first_seen_on, EXCLUDED.first_seen_on)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_record_delivery_source_alias(text, text, text, text, text, text, date) IS
  'Idempotent write path for public.delivery_source_aliases. First sighting inserts; a repeat bumps '
  'times_seen/last_seen_at and re-activates a retired pair, but never rewrites the original evidence. '
  'service_role only — the sync worker calls it after a uniqueness-gated fallback match corroborated '
  'the pair. Refuses a missing evidence string and refuses ours = theirs.';

REVOKE EXECUTE ON FUNCTION public.fn_record_delivery_source_alias(text, text, text, text, text, text, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_record_delivery_source_alias(text, text, text, text, text, text, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_delivery_source_alias(text, text, text, text, text, text, date) TO service_role;


-- Seed: the THREE pairs Renzo confirmed against Czarina's workbook on 2026-08-07.
-- Nothing else is seeded — every future row must be earned the same way.
INSERT INTO public.delivery_source_aliases
  (kind, ours, theirs, ours_raw, theirs_raw, evidence, first_seen_on)
VALUES
  ('truck_plate', 'T138003', '138003', 'T138003', '138003',
   'Human-confirmed by Renzo 2026-08-07 while backfilling 10 prices: RC DELIVERIES 2026-07-23 Ornales '
   '19,010 kg batch JULY-26-BLK9 is the same truckload as Czarina "July 2026" row 45 (same supplier, '
   'same date, same net weight, plate differs only by our leading "T").',
   '2026-07-23'),
  ('truck_plate', 'ALA3958', 'ALA9958', 'ALA 3958', 'ALA9958',
   'Human-confirmed by Renzo 2026-08-07 while backfilling 10 prices: RC DELIVERIES 2026-07-02 Llanto '
   '23,930 kg batch JULY-26-BLK2 is the same truckload as Czarina "July 2026" row 9 (same supplier, '
   'same net weight, plate differs by a single character — our 3 vs her 9).',
   '2026-07-02'),
  -- Supplier aliases are keyed on the UPPERCASE-TRIMMED source spellings, NOT on
  -- canonical_supplier() output — because the matcher's FIRST supplier test is
  -- already canonical_supplier(ours) = canonical_supplier(theirs), and this table is
  -- the fallback for variants that function does NOT collapse. Storing the collapsed
  -- form here would produce a degenerate PAQUIBOT→PAQUIBOT row that says nothing.
  ('supplier', 'PAQUIBOT/COMPRA', 'PAQUIBOT', 'Paquibot/Compra', 'PAQUIBOT',
   'Human-confirmed by Renzo 2026-08-07: our "Paquibot/Compra" and Czarina''s "PAQUIBOT" are the same '
   'supplier (RC DELIVERIES 2026-07-20, 18,695 kg, batch JULY-26-BLK5 = Czarina "July 2026" row 34). '
   'canonical_supplier() ALREADY maps both to PAQUIBOT, so the matcher does not need this row to make '
   'the match — it is recorded so the variant is documented as seen and adjudicated, not re-litigated.',
   '2026-07-20')
ON CONFLICT (kind, ours, theirs) DO NOTHING;
