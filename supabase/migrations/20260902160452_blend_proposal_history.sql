-- ═════════════════════════════════════════════════════════════════════════════════
-- BLEND PROPOSAL HISTORY — saved, versioned blends on the Blocking page
--
-- Plan: .agents/plans/blend-proposal-history-plan.md (approved 2026-09-02).
--
-- WHAT EXISTS TODAY. `buildBlendProposal(blockLocs)` computes a blend on demand from
-- `view_blocking_grid` + `fn_blend_proposal()` and throws it away when the modal closes.
-- There is no record of what was ever proposed.
--
-- ═══ THE ONE FACT THAT SHAPES THIS WHOLE MIGRATION ═══════════════════════════════
-- A proposal is a STATEMENT ABOUT THE YARD ON A PARTICULAR DAY. Block balances fall
-- every day as charcoal is fed; a `block_loc` is reused (`batches.location_ref` is
-- cleared when a batch empties); lab averages move as deliveries land. So "the blend we
-- proposed on Sept 2" and "those same eight blocks recomputed today" are two different
-- numbers and BOTH are legitimately interesting. Storing only the block list would
-- silently rewrite history every time the proposal is opened; storing only the numbers
-- could never be modified. So a version stores BOTH:
--   * `blocks`   — the block list keyed by BATCH IDENTITY (`batch_id`), which is what a
--                  later "Modify" resolves against; `block_loc` is only where that batch
--                  happened to sit that day.
--   * `snapshot` — what the DATABASE computed at save time, in the exact shape the
--                  existing modal already renders.
--
-- ═══ APPEND-ONLY, WITH TWO INDEPENDENT LOCKS ═════════════════════════════════════
-- `blend_proposal_versions` is history. It is never updated and never deleted, enforced
-- twice over (the `sync_finding_acks` / `cenapro.rc_supplier_opening_balance` idiom):
--   1. no UPDATE/DELETE privilege for any client role, and
--   2. RLS on with SELECT + INSERT policies and NO update or delete policy at all,
-- so a future blanket `GRANT ... ON ALL TABLES IN SCHEMA public` still cannot rewrite
-- what was proposed. The INSERT policy is `WITH CHECK (created_by = auth.uid())`, so the
-- name on a version is a fact the database verified, not a field the caller filled in.
--
-- ═══ THE SNAPSHOT IS COMPUTED IN SQL, NEVER ACCEPTED FROM A CLIENT ═══════════════
-- `fn_save_blend_proposal` builds the snapshot itself from `view_blocking_grid` +
-- `fn_blend_proposal()`. A client cannot save a proposal claiming numbers the yard did
-- not have. That is also why the ×1.30 production-loss markup MOVES INTO SQL here
-- (`fn_blend_production_loss_pct()`): the stored product cost has to be exactly the
-- number the operator saw, and two definitions of the markup would eventually disagree.
--
-- ═══ NO HARD DELETE ══════════════════════════════════════════════════════════════
-- Archive/restore only, on the header. There is no delete RPC, no DELETE grant and no
-- DELETE policy on either table: a proposal that was made is history even if it was a
-- bad idea. `blend_proposal_versions.proposal_id` is ON DELETE RESTRICT as the backstop.
-- ═════════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. THE PRODUCTION-LOSS CONSTANT — ONE definition, and it lives here
-- ═════════════════════════════════════════════════════════════════════════════════
-- Until now `PRODUCTION_LOSS_PCT = 30` lived only in TypeScript
-- (`buildBlendProposal`). The stored snapshot has to carry the product cost the
-- operator actually saw, so the constant has to live where the snapshot is computed.
-- The TS action now reads it back from here instead of declaring its own copy.
CREATE OR REPLACE FUNCTION public.fn_blend_production_loss_pct()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $fn$
  SELECT 30::numeric;
$fn$;

COMMENT ON FUNCTION public.fn_blend_production_loss_pct() IS
  'THE production-loss percentage used by the Blend Proposal product cost: product cost = raw blended price x (1 + pct/100), i.e. x1.30 today. Chosen 2026-06. It lives in SQL because the SAVED snapshot must carry exactly the number the operator saw on screen; buildBlendProposal reads it from here rather than declaring a second copy in TypeScript.';

REVOKE EXECUTE ON FUNCTION public.fn_blend_production_loss_pct() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_blend_production_loss_pct() TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. THE HEADER — public.blend_proposals (mutable, small)
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.blend_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Renzo's explicit requirement 2026-09-02: EVERY proposal carries a title AND a
  -- remark. The title is required and cannot be blank (today's PDF label becomes it);
  -- the remark (`notes`) is free text, optional in value but first-class in the
  -- model — it is exposed by both read models and editable through the header patch.
  title               text NOT NULL CHECK (btrim(title) <> ''),
  notes               text,

  -- A deliberately small, optional lifecycle. There is NO join to rc_out: reconciling
  -- "planned to feed" against "actually fed" is real work and is out of scope, so
  -- `fed_on` is RECORDED INTENT only.
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'planned', 'fed')),
  fed_on              date,

  -- The compare-and-set token for APPENDING A VERSION. Separate from row_version so
  -- renaming a proposal never invalidates an in-flight "save as v4", and vice versa.
  current_version_no  integer NOT NULL DEFAULT 1 CHECK (current_version_no >= 1),

  -- The compare-and-set token for HEADER edits. Bumped by the touch trigger on every
  -- write, so raw DML advances it too.
  row_version         integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),

  -- SOFT archive. Restore clears both.
  archived_at         timestamptz,
  archived_by         uuid REFERENCES public.profiles(id),

  -- No ON DELETE clause on created_by, on purpose (the sync_finding_acks reasoning):
  -- the default NO ACTION refuses deleting a profile that authored a plan, so the
  -- authorship of a proposal cannot be orphaned. Profiles are retired with
  -- status = 'disabled', never removed.
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES public.profiles(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES public.profiles(id),

  -- "fed" and "fed_on" are the same statement said twice, so they move together:
  -- setting status to fed REQUIRES a date, and any other status has none.
  CONSTRAINT blend_proposals_fed_on_iff_fed
    CHECK ((status = 'fed') = (fed_on IS NOT NULL)),
  CONSTRAINT blend_proposals_archived_by_needs_at
    CHECK (archived_by IS NULL OR archived_at IS NOT NULL)
);

COMMENT ON TABLE public.blend_proposals IS
  'One saved Blend Proposal on the Blocking page — the mutable identity (title, remark, status, archive flag). The PROPOSED NUMBERS are not here: every save appends an immutable row to blend_proposal_versions. Archive/restore only; there is no delete RPC, no DELETE grant and no DELETE policy, because a proposal that was made is history even if it was a bad idea.';
COMMENT ON COLUMN public.blend_proposals.title IS
  'The name the operator gives the proposal — required and never blank. It also becomes the default PDF label.';
COMMENT ON COLUMN public.blend_proposals.notes IS
  'The REMARK: free text about why this blend was proposed. Optional in value, first-class in the model — it appears in both read models and is editable through fn_update_blend_proposal_header. Per-version reasoning ("swapped A-3A, MC too high") belongs in blend_proposal_versions.change_note instead.';
COMMENT ON COLUMN public.blend_proposals.status IS
  'draft = still thinking. planned = we intend to feed this. fed = we fed it (fed_on records when). RECORDED INTENT ONLY — nothing here is reconciled against rc_out.';
COMMENT ON COLUMN public.blend_proposals.fed_on IS
  'The day the blend was fed, as claimed by a human. Present if and only if status = fed (enforced by CHECK). No join to rc_out, and none is implied.';
COMMENT ON COLUMN public.blend_proposals.current_version_no IS
  'The version_no of the newest version. ALSO the compare-and-set token for appending: fn_save_blend_proposal re-checks it inside the UPDATE''s own WHERE, so a save made against a stale reading is refused instead of overwriting someone else''s version.';
COMMENT ON COLUMN public.blend_proposals.row_version IS
  'Compare-and-set token for HEADER edits (title / notes / status / fed_on / archive), bumped by tr_blend_proposals_touch on every write. Deliberately separate from current_version_no so renaming and appending never invalidate each other.';
COMMENT ON COLUMN public.blend_proposals.archived_at IS
  'SOFT archive. Archived proposals still read (with archived_at set) and can be restored; a save into an archived proposal is refused until it is restored.';

CREATE INDEX IF NOT EXISTS idx_blend_proposals_live
  ON public.blend_proposals (updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blend_proposals_created_by
  ON public.blend_proposals (created_by);


-- ── Touch trigger: row_version / updated_at / frozen creation facts ───────────────
-- In a TRIGGER, not in the RPC, so EVERY write path advances the concurrency token —
-- including raw DML from a client role that holds UPDATE on the table.
CREATE OR REPLACE FUNCTION public.fn_touch_blend_proposal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := coalesce(NEW.created_by, auth.uid());
    NEW.updated_by := coalesce(NEW.updated_by, NEW.created_by);
    RETURN NEW;
  END IF;

  NEW.updated_at  := now();
  NEW.row_version := OLD.row_version + 1;
  NEW.updated_by  := coalesce(auth.uid(), NEW.updated_by, OLD.updated_by);

  -- Creation facts are frozen: a later edit can never re-attribute who made the plan.
  NEW.id         := OLD.id;
  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_touch_blend_proposal() IS
  'BEFORE INSERT/UPDATE on public.blend_proposals: on UPDATE bumps row_version + updated_at, stamps updated_by from auth.uid(), and freezes id/created_at/created_by. In a trigger so every write path advances the concurrency token, not only the save RPC.';

-- L-043: fn_touch_blend_proposal is SECURITY INVOKER and is reached BY THE TRIGGER, so
-- every role that can write blend_proposals is a calling role of it and must hold
-- EXECUTE. (Guarded by scripts/verify-trigger-grants.ts.)
REVOKE EXECUTE ON FUNCTION public.fn_touch_blend_proposal() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_touch_blend_proposal() TO authenticated, service_role;

DROP TRIGGER IF EXISTS tr_blend_proposals_touch ON public.blend_proposals;
CREATE TRIGGER tr_blend_proposals_touch
  BEFORE INSERT OR UPDATE ON public.blend_proposals
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_blend_proposal();


-- ═════════════════════════════════════════════════════════════════════════════════
-- 3. THE HISTORY — public.blend_proposal_versions (APPEND-ONLY)
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.blend_proposal_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE RESTRICT is the backstop under "no hard delete": even if a DELETE
  -- privilege were granted on the header by accident, a proposal with history cannot
  -- be removed.
  proposal_id        uuid NOT NULL REFERENCES public.blend_proposals(id) ON DELETE RESTRICT,
  version_no         integer NOT NULL CHECK (version_no >= 1),

  blocks             jsonb NOT NULL,
  snapshot           jsonb NOT NULL,
  snapshot_hash      text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),

  change_note        text,
  parent_version_no  integer CHECK (parent_version_no IS NULL OR parent_version_no >= 1),

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES public.profiles(id),

  CONSTRAINT blend_proposal_versions_no_unique UNIQUE (proposal_id, version_no)
);

COMMENT ON TABLE public.blend_proposal_versions IS
  'APPEND-ONLY history of one Blend Proposal. A version is never updated and never deleted — enforced twice: no UPDATE/DELETE privilege for any client role, AND RLS with SELECT + INSERT policies and no update/delete policy at all. Every row is written by fn_save_blend_proposal, which computes the snapshot in SQL so a client can never store numbers the yard did not have. CARRIES PESO VALUES inside `snapshot` — every read is canViewPrices()-gated at the server action.';
COMMENT ON COLUMN public.blend_proposal_versions.blocks IS
  'The block list as an array of {block_loc, batch_id, batch_code}. IDENTITY IS batch_id: a later "Modify" re-selects a block only if it still holds that same batch, because block_loc is reused when a batch empties. This is the modifiable half of a version.';
COMMENT ON COLUMN public.blend_proposal_versions.snapshot IS
  'What the DATABASE computed at save time, in the exact shape the Blend Proposal modal renders: blocks[] (block_loc, batch_id, batch_code, status, balance, 7 lab stats, php_kg), block_count, total_balance, weighted{}, raw_price_per_kg, production_loss_pct, product_cost_per_kg, computed_at. This is the immutable half — what was actually proposed. It CARRIES PESOS.';
COMMENT ON COLUMN public.blend_proposal_versions.snapshot_hash IS
  'sha256 of a canonical, PRICE-STRIPPED rendering of the blocks + snapshot (see fn_blend_snapshot_hash). The idempotency key: re-saving an unchanged blend writes no row. Because it is price-free by construction, a change to PRICE ALONE does not create a new version — a version is identified by which blocks were proposed and what state they were physically in, not by what they cost.';
COMMENT ON COLUMN public.blend_proposal_versions.change_note IS
  'Why THIS version differs from the one before it ("swapped A-3A for A-5B, MC too high"). The proposal-level remark lives in blend_proposals.notes.';
COMMENT ON COLUMN public.blend_proposal_versions.parent_version_no IS
  'Which version the author was looking at when they saved. Today always version_no - 1; recorded so a fork from an older version can be added later with no migration.';

CREATE INDEX IF NOT EXISTS idx_blend_proposal_versions_proposal
  ON public.blend_proposal_versions (proposal_id, version_no DESC);


-- ═════════════════════════════════════════════════════════════════════════════════
-- 4. GRANTS + RLS
-- ═════════════════════════════════════════════════════════════════════════════════
-- Supabase's default privileges in `public` grant ALL on a new table to anon,
-- authenticated and service_role. Left alone that hands `authenticated` DELETE and
-- hands `anon` everything — so REVOKE FIRST, then grant back exactly the verbs each
-- role needs.
REVOKE ALL ON public.blend_proposals         FROM anon, authenticated, service_role;
REVOKE ALL ON public.blend_proposal_versions FROM anon, authenticated, service_role;

-- Header: read, create, edit. NO DELETE — archive is the only removal.
GRANT SELECT, INSERT, UPDATE ON public.blend_proposals TO authenticated;
-- Versions: read + append. NO UPDATE, NO DELETE — that is lock #1.
GRANT SELECT, INSERT ON public.blend_proposal_versions TO authenticated;
-- service_role gets NOTHING on either table: the sync worker neither reads nor writes
-- blend proposals, and L-044's lesson is about the roles that DO read, not symmetry.

ALTER TABLE public.blend_proposals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blend_proposal_versions ENABLE ROW LEVEL SECURITY;

-- Single-org posture (the project's standing RLS model): everyone signed in reads
-- everything, and the server actions + canViewPrices() are the enforcement layer.
DROP POLICY IF EXISTS blend_proposals_select ON public.blend_proposals;
CREATE POLICY blend_proposals_select
  ON public.blend_proposals FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS blend_proposals_insert ON public.blend_proposals;
CREATE POLICY blend_proposals_insert
  ON public.blend_proposals FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS blend_proposals_update ON public.blend_proposals;
CREATE POLICY blend_proposals_update
  ON public.blend_proposals FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- NO DELETE POLICY on the header, and NO UPDATE OR DELETE POLICY on the versions —
-- that absence is lock #2, and it is deliberate. Do not add one.
DROP POLICY IF EXISTS blend_proposal_versions_select ON public.blend_proposal_versions;
CREATE POLICY blend_proposal_versions_select
  ON public.blend_proposal_versions FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS blend_proposal_versions_insert ON public.blend_proposal_versions;
CREATE POLICY blend_proposal_versions_insert
  ON public.blend_proposal_versions FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());


-- ═════════════════════════════════════════════════════════════════════════════════
-- 5. THE SNAPSHOT BUILDER — the ONE place a proposal's numbers come from
-- ═════════════════════════════════════════════════════════════════════════════════
-- Shape is byte-for-byte the TypeScript `BlendProposal` interface, plus two additions
-- the saved form needs: `blocks[].batch_id` (the identity a later Modify resolves
-- against) and `computed_at`. `can_view_prices` is deliberately NOT stored — it is a
-- fact about the READER, not about the proposal, and the server action sets it per call.
--
-- Every weighted average is lifted verbatim from fn_blend_proposal() — no aggregation
-- is restated here, so a saved snapshot can never disagree with the live modal.
CREATE OR REPLACE FUNCTION public.fn_blend_proposal_snapshot(p_block_locs text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  WITH locs AS (
    SELECT DISTINCT btrim(l) AS block_loc
      FROM unnest(coalesce(p_block_locs, ARRAY[]::text[])) AS l
     WHERE btrim(coalesce(l, '')) <> ''
  ),
  grid_rows AS (
    SELECT g.*
      FROM public.view_blocking_grid g
      JOIN locs ON locs.block_loc = g.block_loc
  ),
  blks AS (
    SELECT coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'block_loc',  r.block_loc,
                 'batch_id',   r.batch_id,
                 'batch_code', r.batch_code,
                 'status',     r.status,
                 'balance',    coalesce(r.balance, 0),
                 'mc',         coalesce(r.avg_mc, 0),
                 'ash',        coalesce(r.avg_ash, 0),
                 'bd_astm',    coalesce(r.avg_bd_astm, 0),
                 'bd_jis',     coalesce(r.avg_bd_jis, 0),
                 'grit',       coalesce(r.avg_grit, 0),
                 'vm',         coalesce(r.avg_vm, 0),
                 'fc',         coalesce(r.avg_fc, 0),
                 'php_kg',     r.avg_php_kg
               )
               ORDER BY r.block_loc
             ),
             '[]'::jsonb
           ) AS blocks
      FROM grid_rows r
  ),
  agg AS (
    SELECT * FROM public.fn_blend_proposal(
      (SELECT coalesce(array_agg(locs.block_loc), ARRAY[]::text[]) FROM locs)
    )
  )
  SELECT jsonb_build_object(
    'blocks',              b.blocks,
    'block_count',         coalesce(a.block_count, 0),
    'total_balance',       coalesce(a.total_balance, 0),
    'weighted', jsonb_build_object(
      'mc',      coalesce(a.w_mc, 0),
      'ash',     coalesce(a.w_ash, 0),
      'bd_astm', coalesce(a.w_bd_astm, 0),
      'bd_jis',  coalesce(a.w_bd_jis, 0),
      'grit',    coalesce(a.w_grit, 0),
      'vm',      coalesce(a.w_vm, 0),
      'fc',      coalesce(a.w_fc, 0)
    ),
    'raw_price_per_kg',    a.raw_price_per_kg,
    'production_loss_pct', public.fn_blend_production_loss_pct(),
    'product_cost_per_kg',
      CASE WHEN a.raw_price_per_kg IS NULL THEN NULL
           ELSE a.raw_price_per_kg * (1 + public.fn_blend_production_loss_pct() / 100)
      END,
    'computed_at',         now()
  )
  FROM blks b CROSS JOIN agg a;
$fn$;

COMMENT ON FUNCTION public.fn_blend_proposal_snapshot(text[]) IS
  'Builds the stored Blend Proposal snapshot for a set of block_locs, in the exact shape the modal renders. Every weighted average is lifted verbatim from fn_blend_proposal() so a saved version can never disagree with the live what-if; the only arithmetic added here is the production-loss markup, taken from fn_blend_production_loss_pct(). Adds blocks[].batch_id (the identity a later Modify resolves against) and computed_at. CARRIES PESOS (raw_price_per_kg, product_cost_per_kg, blocks[].php_kg) — gate every read with canViewPrices().';

REVOKE EXECUTE ON FUNCTION public.fn_blend_proposal_snapshot(text[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_blend_proposal_snapshot(text[]) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 6. THE IDEMPOTENCY KEY — a hash that CANNOT contain a peso
-- ═════════════════════════════════════════════════════════════════════════════════
-- Built by EXPLICIT ALLOWLIST from the snapshot: only the keys named below reach the
-- digest, so `php_kg`, `raw_price_per_kg` and `product_cost_per_kg` are structurally
-- absent rather than filtered out. `computed_at` is excluded too — a clock in the hash
-- would make every re-save look different and destroy idempotency.
--
-- Numbers are rounded to 6 dp before hashing so a scale change in an upstream numeric
-- ("18827" vs "18827.00") can never masquerade as a changed blend.
--
-- CONSEQUENCE, STATED ON PURPOSE: a change to PRICE ALONE produces the same hash and
-- therefore writes no new version. A version is identified by WHICH blocks were
-- proposed and what physical/lab state they were in — not by what they cost.
CREATE OR REPLACE FUNCTION public.fn_blend_snapshot_hash(p_snapshot jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_canonical jsonb;
  v_keys      text;
BEGIN
  IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'fn_blend_snapshot_hash: a snapshot object is required';
  END IF;

  SELECT jsonb_build_object(
    'v', 1,
    'production_loss_pct', round((p_snapshot ->> 'production_loss_pct')::numeric, 6),
    'block_count',         (p_snapshot ->> 'block_count')::integer,
    'total_balance',       round((p_snapshot ->> 'total_balance')::numeric, 6),
    'weighted', (
      SELECT coalesce(jsonb_object_agg(e.key, round(e.value::numeric, 6)), '{}'::jsonb)
        FROM jsonb_each_text(p_snapshot -> 'weighted') AS e(key, value)
    ),
    'blocks', (
      SELECT coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'block_loc',  b ->> 'block_loc',
                   'batch_id',   b ->> 'batch_id',
                   'batch_code', b ->> 'batch_code',
                   'status',     b ->> 'status',
                   'balance',    round((b ->> 'balance')::numeric, 6),
                   'mc',         round((b ->> 'mc')::numeric, 6),
                   'ash',        round((b ->> 'ash')::numeric, 6),
                   'bd_astm',    round((b ->> 'bd_astm')::numeric, 6),
                   'bd_jis',     round((b ->> 'bd_jis')::numeric, 6),
                   'grit',       round((b ->> 'grit')::numeric, 6),
                   'vm',         round((b ->> 'vm')::numeric, 6),
                   'fc',         round((b ->> 'fc')::numeric, 6)
                 )
                 ORDER BY b ->> 'block_loc'
               ),
               '[]'::jsonb
             )
        FROM jsonb_array_elements(coalesce(p_snapshot -> 'blocks', '[]'::jsonb)) AS b
    )
  ) INTO v_canonical;

  -- Structural guard on the KEY NAMES only (never on the data, so a batch code can
  -- never trip it): if someone ever adds a money field to the allowlist above, hashing
  -- fails loudly instead of quietly encoding a peso.
  SELECT string_agg(k, ',') INTO v_keys
    FROM (
      SELECT jsonb_object_keys(v_canonical) AS k
      UNION ALL
      SELECT jsonb_object_keys(v_canonical -> 'weighted')
      UNION ALL
      SELECT jsonb_object_keys(elem)
        FROM jsonb_array_elements(v_canonical -> 'blocks') AS elem
    ) AS all_keys;

  IF coalesce(v_keys, '') ~* '(php|price|cost|peso|amount|value)' THEN
    RAISE EXCEPTION
      'fn_blend_snapshot_hash: refusing to hash a money-bearing key (%). The snapshot hash must stay price-free.',
      v_keys;
  END IF;

  RETURN encode(sha256(convert_to(v_canonical::text, 'UTF8')), 'hex');
END;
$fn$;

COMMENT ON FUNCTION public.fn_blend_snapshot_hash(jsonb) IS
  'sha256 of a canonical, PRICE-FREE rendering of a Blend Proposal snapshot — the idempotency key for fn_save_blend_proposal. Built by explicit allowlist (money keys are structurally absent, not filtered), numbers rounded to 6 dp so an upstream scale change is not mistaken for a changed blend, and computed_at excluded so the clock alone never invents a version. Consequence: a price-only change writes no new version.';

REVOKE EXECUTE ON FUNCTION public.fn_blend_snapshot_hash(jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_blend_snapshot_hash(jsonb) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 7. fn_save_blend_proposal — create a proposal, or append a version to one
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_save_blend_proposal(
  p_title               text,
  p_block_locs          text[],
  p_proposal_id         uuid    DEFAULT NULL,
  p_expected_version_no integer DEFAULT NULL,
  p_change_note         text    DEFAULT NULL,
  p_notes               text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_locs      text[];
  v_missing   text[];
  v_snapshot  jsonb;
  v_blocks    jsonb;
  v_hash      text;
  v_prev_hash text;
  v_cur       public.blend_proposals;
  v_id        uuid;
  v_version   integer;
  v_rowver    integer;
BEGIN
  -- The version INSERT policy is WITH CHECK (created_by = auth.uid()), so a caller
  -- with no identity could never satisfy it. Refuse early, with a readable message.
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'not_authenticated',
      'message', 'You need to be signed in to save a blend proposal.');
  END IF;

  IF p_title IS NULL OR btrim(p_title) = '' THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'invalid_title',
      'message', 'Give the proposal a title before saving it.');
  END IF;

  SELECT coalesce(array_agg(DISTINCT btrim(l) ORDER BY btrim(l)), ARRAY[]::text[])
    INTO v_locs
    FROM unnest(coalesce(p_block_locs, ARRAY[]::text[])) AS l
   WHERE btrim(coalesce(l, '')) <> '';

  IF array_length(v_locs, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'no_blocks',
      'message', 'A blend proposal needs at least one block.');
  END IF;

  -- Every named block must currently be on the grid. NAME the ones that are not:
  -- "some blocks are gone" is not something a person can act on.
  SELECT coalesce(array_agg(l ORDER BY l), ARRAY[]::text[])
    INTO v_missing
    FROM unnest(v_locs) AS l
   WHERE NOT EXISTS (
     SELECT 1 FROM public.view_blocking_grid g WHERE g.block_loc = l
   );

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'unknown_block',
      'blocks', to_jsonb(v_missing),
      'message', 'These blocks are not on the blocking grid right now: '
                 || array_to_string(v_missing, ', ')
                 || '. They may have been emptied since you selected them — reload the grid.');
  END IF;

  -- THE SNAPSHOT IS COMPUTED HERE, never accepted from the caller.
  v_snapshot := public.fn_blend_proposal_snapshot(v_locs);
  v_hash     := public.fn_blend_snapshot_hash(v_snapshot);

  -- The slim, modifiable block list: identity is batch_id.
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'block_loc',  b ->> 'block_loc',
               'batch_id',   b ->> 'batch_id',
               'batch_code', b ->> 'batch_code'
             )
             ORDER BY b ->> 'block_loc'
           ),
           '[]'::jsonb
         )
    INTO v_blocks
    FROM jsonb_array_elements(v_snapshot -> 'blocks') AS b;

  -- ── NEW PROPOSAL ───────────────────────────────────────────────────────────────
  IF p_proposal_id IS NULL THEN
    INSERT INTO public.blend_proposals (title, notes, current_version_no, created_by, updated_by)
    VALUES (btrim(p_title), p_notes, 1, v_uid, v_uid)
    RETURNING id, row_version INTO v_id, v_rowver;

    INSERT INTO public.blend_proposal_versions
      (proposal_id, version_no, blocks, snapshot, snapshot_hash, change_note,
       parent_version_no, created_by)
    VALUES
      (v_id, 1, v_blocks, v_snapshot, v_hash, p_change_note, NULL, v_uid);

    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'created', 'unchanged', false,
      'proposal_id', v_id, 'version_no', 1, 'row_version', v_rowver,
      'snapshot_hash', v_hash);
  END IF;

  -- ── EXISTING PROPOSAL ──────────────────────────────────────────────────────────
  SELECT * INTO v_cur FROM public.blend_proposals p WHERE p.id = p_proposal_id;

  IF v_cur.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'not_found',
      'message', 'That proposal no longer exists. Reload the proposals list.');
  END IF;

  IF v_cur.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'archived',
      'proposal_id', v_cur.id, 'current_version_no', v_cur.current_version_no,
      'message', format('"%s" is archived. Restore it before saving a new version.', v_cur.title));
  END IF;

  -- The token is REQUIRED for an existing proposal. Defaulting it to "whatever is
  -- current" would silently turn a stale editor into a successful overwrite, which is
  -- the exact failure this token exists to prevent.
  IF p_expected_version_no IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'expected_version_required',
      'current_version_no', v_cur.current_version_no,
      'message', 'Saving into an existing proposal needs the version you were looking at.');
  END IF;

  IF p_expected_version_no <> v_cur.current_version_no THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'stale',
      'proposal_id', v_cur.id, 'current_version_no', v_cur.current_version_no,
      'message', format('Someone saved v%s while you were working on v%s. Reload "%s" and try again.',
                        v_cur.current_version_no, p_expected_version_no, v_cur.title));
  END IF;

  -- Idempotent re-save: identical blend, no new version.
  SELECT v.snapshot_hash INTO v_prev_hash
    FROM public.blend_proposal_versions v
   WHERE v.proposal_id = v_cur.id
     AND v.version_no  = v_cur.current_version_no;

  IF v_prev_hash IS NOT NULL AND v_prev_hash = v_hash THEN
    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'unchanged', 'unchanged', true,
      'proposal_id', v_cur.id, 'version_no', v_cur.current_version_no,
      'row_version', v_cur.row_version, 'snapshot_hash', v_hash,
      'message', 'Nothing changed since the last version, so no new version was written.');
  END IF;

  -- THE GUARD IS IN THE UPDATE'S OWN WHERE — never a read-then-write. A concurrent save
  -- that landed between the SELECT above and this statement moved current_version_no,
  -- so this matches nothing and we report `stale` from the freshly re-read value.
  --
  -- Title and remark ride along when supplied: a "Save as v4" that also fixed a typo in
  -- the name must not silently drop the rename. Status / fed_on / archive stay with
  -- fn_update_blend_proposal_header. An omitted (NULL) p_notes leaves the remark alone.
  UPDATE public.blend_proposals AS t
     SET current_version_no = t.current_version_no + 1,
         title              = btrim(p_title),
         notes              = coalesce(p_notes, t.notes),
         updated_by         = v_uid
   WHERE t.id                 = p_proposal_id
     AND t.current_version_no = p_expected_version_no
     AND t.archived_at IS NULL
  RETURNING t.current_version_no, t.row_version INTO v_version, v_rowver;

  IF v_version IS NULL THEN
    SELECT p.current_version_no INTO v_version
      FROM public.blend_proposals p WHERE p.id = p_proposal_id;
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'stale',
      'proposal_id', p_proposal_id, 'current_version_no', v_version,
      'message', 'Someone else saved this proposal while you were working on it. Reload and try again.');
  END IF;

  INSERT INTO public.blend_proposal_versions
    (proposal_id, version_no, blocks, snapshot, snapshot_hash, change_note,
     parent_version_no, created_by)
  VALUES
    (p_proposal_id, v_version, v_blocks, v_snapshot, v_hash, p_change_note,
     p_expected_version_no, v_uid);

  RETURN jsonb_build_object(
    'ok', true, 'outcome', 'versioned', 'unchanged', false,
    'proposal_id', p_proposal_id, 'version_no', v_version, 'row_version', v_rowver,
    'snapshot_hash', v_hash);
END;
$fn$;

COMMENT ON FUNCTION public.fn_save_blend_proposal(text, text[], uuid, integer, text, text) IS
  'THE only way a blend proposal is written. With no p_proposal_id it creates the header + version 1; otherwise it appends version current_version_no + 1, re-checking the expected version inside the UPDATE''s own WHERE so a stale editor is refused rather than winning. The snapshot is computed in SQL from view_blocking_grid + fn_blend_proposal(), never accepted from the caller. Refuses a blank title, an empty block list, a block that is not on the grid (naming it), an archived proposal and a stale/missing version token. Re-saving an unchanged blend returns unchanged:true and writes no row. Returns a jsonb {ok, ...} the UI can put straight into a toast; it never raises for a business refusal.';

REVOKE EXECUTE ON FUNCTION public.fn_save_blend_proposal(text, text[], uuid, integer, text, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_save_blend_proposal(text, text[], uuid, integer, text, text) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 8. fn_update_blend_proposal_header — allowlisted patch, compare-and-set
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_update_blend_proposal_header(
  p_id                   uuid,
  p_expected_row_version integer,
  p_patch                jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  c_allowed constant text[] := ARRAY['title', 'status', 'fed_on', 'notes'];
  v_bad     text[];
  v_cur     public.blend_proposals;
  v_title   text;
  v_notes   text;
  v_status  text;
  v_fed_on  date;
  v_rowver  integer;
BEGIN
  IF p_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid',
      'message', 'A proposal id is required.');
  END IF;

  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid',
      'message', 'The patch must be a JSON object of column -> value.');
  END IF;

  -- A key outside the allowlist refuses the WHOLE call — never a partial apply that
  -- silently drops half of what the caller asked for.
  SELECT array_agg(k) INTO v_bad
    FROM jsonb_object_keys(p_patch) AS k
   WHERE k <> ALL (c_allowed);

  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'unsupported_field', 'fields', to_jsonb(v_bad),
      'message', 'Refused: ' || array_to_string(v_bad, ', ')
                 || ' cannot be edited here. Editable: ' || array_to_string(c_allowed, ', ')
                 || '. The proposed blocks change by saving a new version, not by patching the header.');
  END IF;

  SELECT * INTO v_cur FROM public.blend_proposals p WHERE p.id = p_id;
  IF v_cur.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
      'message', 'That proposal no longer exists. Reload the proposals list.');
  END IF;

  v_title  := CASE WHEN p_patch ? 'title'  THEN p_patch ->> 'title'  ELSE v_cur.title  END;
  v_notes  := CASE WHEN p_patch ? 'notes'  THEN p_patch ->> 'notes'  ELSE v_cur.notes  END;
  v_status := CASE WHEN p_patch ? 'status' THEN p_patch ->> 'status' ELSE v_cur.status END;

  IF v_title IS NULL OR btrim(v_title) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_title',
      'message', 'A proposal needs a title — it cannot be blank.');
  END IF;

  IF v_status IS NULL OR v_status <> ALL (ARRAY['draft', 'planned', 'fed']) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_status',
      'message', format('"%s" is not a proposal status. Use draft, planned or fed.', v_status));
  END IF;

  -- fed and fed_on are the same statement said twice, so they move together.
  IF v_status = 'fed' THEN
    BEGIN
      v_fed_on := CASE
                    WHEN p_patch ? 'fed_on' THEN nullif(btrim(coalesce(p_patch ->> 'fed_on', '')), '')::date
                    ELSE v_cur.fed_on
                  END;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid',
        'message', format('"%s" is not a date the system can read. Use YYYY-MM-DD.',
                          p_patch ->> 'fed_on'));
    END;

    IF v_fed_on IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'fed_on_required',
        'message', 'Marking a proposal as fed needs the date it was fed.');
    END IF;
  ELSE
    -- Any status other than fed clears the date rather than leaving a stale claim.
    v_fed_on := NULL;
  END IF;

  UPDATE public.blend_proposals AS t
     SET title   = btrim(v_title),
         notes   = v_notes,
         status  = v_status,
         fed_on  = v_fed_on
   WHERE t.id          = p_id
     AND t.row_version = p_expected_row_version
  RETURNING t.row_version INTO v_rowver;

  IF v_rowver IS NULL THEN
    SELECT p.row_version INTO v_rowver FROM public.blend_proposals p WHERE p.id = p_id;
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'stale', 'row_version', v_rowver,
      'message', 'Someone else changed this proposal while you were editing it. Reload and try again.');
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'updated',
    'proposal_id', p_id, 'row_version', v_rowver);
END;
$fn$;

COMMENT ON FUNCTION public.fn_update_blend_proposal_header(uuid, integer, jsonb) IS
  'Edits a blend proposal''s identity — title, status, fed_on and the remark (notes) — with an allowlisted patch and compare-and-set on row_version in the same statement as the write. A key outside the allowlist refuses the whole call. status = fed requires fed_on; any other status clears it. Returns a jsonb {ok, ...} refusal the UI can toast; it never raises for a business refusal.';

REVOKE EXECUTE ON FUNCTION public.fn_update_blend_proposal_header(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_update_blend_proposal_header(uuid, integer, jsonb) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 9. ARCHIVE / RESTORE — the only removal there is
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_archive_blend_proposal(
  p_id                   uuid,
  p_expected_row_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_cur    public.blend_proposals;
  v_rowver integer;
BEGIN
  SELECT * INTO v_cur FROM public.blend_proposals p WHERE p.id = p_id;
  IF v_cur.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
      'message', 'That proposal no longer exists. Reload the proposals list.');
  END IF;

  IF v_cur.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'already_archived', 'unchanged', true,
      'proposal_id', v_cur.id, 'row_version', v_cur.row_version);
  END IF;

  UPDATE public.blend_proposals AS t
     SET archived_at = now(), archived_by = auth.uid()
   WHERE t.id = p_id
     AND (p_expected_row_version IS NULL OR t.row_version = p_expected_row_version)
     AND t.archived_at IS NULL
  RETURNING t.row_version INTO v_rowver;

  IF v_rowver IS NULL THEN
    SELECT p.row_version INTO v_rowver FROM public.blend_proposals p WHERE p.id = p_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'stale', 'row_version', v_rowver,
      'message', 'Someone else changed this proposal while you were looking at it. Reload and try again.');
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'archived', 'unchanged', false,
    'proposal_id', p_id, 'row_version', v_rowver);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_restore_blend_proposal(
  p_id                   uuid,
  p_expected_row_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_cur    public.blend_proposals;
  v_rowver integer;
BEGIN
  SELECT * INTO v_cur FROM public.blend_proposals p WHERE p.id = p_id;
  IF v_cur.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
      'message', 'That proposal no longer exists. Reload the proposals list.');
  END IF;

  IF v_cur.archived_at IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'not_archived', 'unchanged', true,
      'proposal_id', v_cur.id, 'row_version', v_cur.row_version);
  END IF;

  UPDATE public.blend_proposals AS t
     SET archived_at = NULL, archived_by = NULL
   WHERE t.id = p_id
     AND (p_expected_row_version IS NULL OR t.row_version = p_expected_row_version)
     AND t.archived_at IS NOT NULL
  RETURNING t.row_version INTO v_rowver;

  IF v_rowver IS NULL THEN
    SELECT p.row_version INTO v_rowver FROM public.blend_proposals p WHERE p.id = p_id;
    RETURN jsonb_build_object('ok', false, 'reason', 'stale', 'row_version', v_rowver,
      'message', 'Someone else changed this proposal while you were looking at it. Reload and try again.');
  END IF;

  RETURN jsonb_build_object('ok', true, 'outcome', 'restored', 'unchanged', false,
    'proposal_id', p_id, 'row_version', v_rowver);
END;
$fn$;

COMMENT ON FUNCTION public.fn_archive_blend_proposal(uuid, integer) IS
  'SOFT-archives a blend proposal (a save into an archived proposal is refused until it is restored). There is no hard delete anywhere in this feature — no delete RPC, no DELETE grant, no DELETE policy — because a proposal that was made is history even if it was a bad idea. Archiving something already archived is a no-op, not an error.';
COMMENT ON FUNCTION public.fn_restore_blend_proposal(uuid, integer) IS
  'Undoes fn_archive_blend_proposal. The pair exists together on purpose: a soft delete you cannot undo is not reversibility.';

REVOKE EXECUTE ON FUNCTION public.fn_archive_blend_proposal(uuid, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_archive_blend_proposal(uuid, integer) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_restore_blend_proposal(uuid, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_restore_blend_proposal(uuid, integer) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 10. READ MODELS — both PESO-FREE, so the list and the rail are safe for every role
-- ═════════════════════════════════════════════════════════════════════════════════
-- Prices exist only inside a version's `snapshot`, which is fetched per version by a
-- canViewPrices()-gated server action. Nothing in either view carries or implies a peso.
CREATE OR REPLACE VIEW public.view_blend_proposal_list
WITH (security_invoker = true) AS
SELECT
  p.id,
  p.title,
  p.notes,
  p.status,
  p.fed_on,
  p.current_version_no,
  p.row_version,
  (SELECT count(*)::integer FROM public.blend_proposal_versions v WHERE v.proposal_id = p.id)
                                                          AS version_count,
  (cur.snapshot ->> 'block_count')::integer               AS block_count,
  (cur.snapshot ->> 'total_balance')::numeric             AS total_balance_kg,
  (cur.snapshot -> 'weighted' ->> 'mc')::numeric          AS w_mc,
  (cur.snapshot -> 'weighted' ->> 'ash')::numeric         AS w_ash,
  (cur.snapshot -> 'weighted' ->> 'bd_astm')::numeric     AS w_bd_astm,
  (cur.snapshot ->> 'computed_at')::timestamptz           AS current_version_computed_at,
  cur.created_at                                          AS current_version_created_at,
  cur.change_note                                         AS current_version_change_note,
  p.archived_at,
  (p.archived_at IS NOT NULL)                             AS is_archived,
  p.created_at,
  p.created_by,
  cb.display_name                                         AS created_by_name,
  p.updated_at,
  p.updated_by,
  ub.display_name                                         AS updated_by_name
FROM public.blend_proposals p
LEFT JOIN public.blend_proposal_versions cur
       ON cur.proposal_id = p.id AND cur.version_no = p.current_version_no
LEFT JOIN public.profiles cb ON cb.id = p.created_by
LEFT JOIN public.profiles ub ON ub.id = p.updated_by;

COMMENT ON VIEW public.view_blend_proposal_list IS
  'One row per saved blend proposal (archived ones included — filter on is_archived), joined to its CURRENT version for the headline: block count, total balance and the three weighted lab stats the grid leads with, plus the remark (notes) and both author names. NO PESO COLUMN and none derivable, so the proposals list is safe for every role including Production; prices live only inside a version snapshot, which is fetched through a canViewPrices()-gated action.';

CREATE OR REPLACE VIEW public.view_blend_proposal_versions
WITH (security_invoker = true) AS
SELECT
  v.id,
  v.proposal_id,
  v.version_no,
  (v.version_no = p.current_version_no)                AS is_current,
  (v.snapshot ->> 'block_count')::integer              AS block_count,
  (v.snapshot ->> 'total_balance')::numeric            AS total_balance_kg,
  (v.snapshot -> 'weighted' ->> 'mc')::numeric         AS w_mc,
  (v.snapshot -> 'weighted' ->> 'ash')::numeric        AS w_ash,
  (v.snapshot -> 'weighted' ->> 'bd_astm')::numeric    AS w_bd_astm,
  (v.snapshot -> 'weighted' ->> 'bd_jis')::numeric     AS w_bd_jis,
  (v.snapshot -> 'weighted' ->> 'grit')::numeric       AS w_grit,
  (v.snapshot -> 'weighted' ->> 'vm')::numeric         AS w_vm,
  (v.snapshot -> 'weighted' ->> 'fc')::numeric         AS w_fc,
  (v.snapshot ->> 'computed_at')::timestamptz          AS computed_at,
  v.change_note,
  v.parent_version_no,
  v.snapshot_hash,
  v.created_at,
  v.created_by,
  cb.display_name                                      AS created_by_name
FROM public.blend_proposal_versions v
JOIN public.blend_proposals p ON p.id = v.proposal_id
LEFT JOIN public.profiles cb ON cb.id = v.created_by;

COMMENT ON VIEW public.view_blend_proposal_versions IS
  'One row per saved version — the version rail. Carries the peso-free headline (block count, balance, all seven weighted lab stats), the change note, the author and the snapshot hash. The snapshot itself (which DOES carry pesos) is fetched per version by a canViewPrices()-gated server action, never through this view.';

REVOKE ALL ON public.view_blend_proposal_list     FROM anon, authenticated, service_role;
REVOKE ALL ON public.view_blend_proposal_versions FROM anon, authenticated, service_role;
GRANT SELECT ON public.view_blend_proposal_list     TO authenticated;
GRANT SELECT ON public.view_blend_proposal_versions TO authenticated;
-- Not granted to service_role on purpose: the sync worker reads none of this
-- (L-044's arrow direction — a grant is for the roles that actually read).
