-- ═════════════════════════════════════════════════════════════════════════════════
-- BLEND PROPOSAL — OVERWRITE A SAVED VERSION IN PLACE (archive first, never lose)
--
-- Renzo, 2026-09-25: a user must be able to OVERWRITE ANY EXISTING VERSION of a saved
-- blend proposal in place — not only the latest — instead of always appending a new
-- one. "Save as v(N+1)" (fn_save_blend_proposal) is UNCHANGED; this is an ADDITIONAL
-- path. His ruling on the replaced contents: overwrite, but keep a hidden archive copy
-- so nothing is unrecoverable — the `deliveries_archive` ethos.
--
-- ═══ WHAT THIS CHANGES ABOUT "APPEND-ONLY" ═══════════════════════════════════════
-- `blend_proposal_versions` was append-only by two independent locks (no UPDATE/DELETE
-- privilege for any client role; RLS with no update/delete policy). BOTH LOCKS STAY.
-- A client role still cannot UPDATE or DELETE a version by any direct path. The ONE
-- exception is `fn_overwrite_blend_proposal_version`, a SECURITY DEFINER function
-- (owner postgres, which owns the table and so bypasses both locks) that ARCHIVES THE
-- REPLACED ROW FIRST, in the same statement, into the new append-only table
-- `blend_proposal_version_revisions`. The same "the SECURITY DEFINER function is the
-- only writer" pattern as `fn_archive_delivery` / `fn_restore_archived_delivery`.
-- So the rule becomes: versions are append-only EXCEPT via
-- fn_overwrite_blend_proposal_version, which archives first.
--
-- ═══ TWO TOKENS, AND WHY NEITHER EXISTING ONE WILL DO ════════════════════════════
-- `blend_proposals.current_version_no` guards APPENDING; `blend_proposals.row_version`
-- guards HEADER edits. An overwrite changes neither the header nor which version is
-- newest, so it gets its own per-VERSION compare-and-set token, `revision_no`, re-checked
-- INSIDE the UPDATE's own WHERE. Bumping row_version here would stale an open header
-- edit for no reason; bumping current_version_no would make an overwrite of v2 claim
-- to be a new version. Neither is touched.
--
-- ═══ THE AS-OF DATE MOVES WITH THE OVERWRITE ═════════════════════════════════════
-- A saved version is analysed "as of" its save date (fn_blend_block_facts' p_as_of,
-- fn_blend_analysis' AGE section and market month). An overwrite recomputes the snapshot
-- TODAY, so a version's as-of instant is now `coalesce(revised_at, created_at)`. That
-- ONE expression is published as `view_blend_proposal_versions.as_of_at`, and
-- fn_blend_analysis + its two verify probes are re-created below with exactly that
-- substitution and nothing else (their bodies are otherwise byte-identical to
-- migration 20260921084500).
--
-- ═══ NO UNIQUE snapshot_hash ═════════════════════════════════════════════════════
-- Measured before writing this: the only unique indexes on blend_proposal_versions are
-- the PK and (proposal_id, version_no). So an overwritten version that becomes identical
-- to a SIBLING version is legal — two versions of one proposal may describe the same
-- blend (the append path already allows it: v1 = A, v2 = B, v3 = A). Only a re-save
-- identical to THIS version's own current contents is a no-op.
-- ═════════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════════
-- 1. blend_proposal_versions — the per-version revision token + who revised it
-- ═════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.blend_proposal_versions
  ADD COLUMN IF NOT EXISTS revision_no integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS revised_at  timestamptz,
  -- No ON DELETE clause, on purpose — the created_by reasoning: a profile that revised a
  -- plan cannot be deleted out from under it. Profiles are retired, never removed.
  ADD COLUMN IF NOT EXISTS revised_by  uuid REFERENCES public.profiles(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.blend_proposal_versions'::regclass
                    AND conname = 'blend_proposal_versions_revision_no_check') THEN
    ALTER TABLE public.blend_proposal_versions
      ADD CONSTRAINT blend_proposal_versions_revision_no_check CHECK (revision_no >= 1);
  END IF;
  -- revision 1 is the row as first saved; any later revision was written by someone,
  -- at some time — the three move together.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.blend_proposal_versions'::regclass
                    AND conname = 'blend_proposal_versions_revised_iff_revision') THEN
    ALTER TABLE public.blend_proposal_versions
      ADD CONSTRAINT blend_proposal_versions_revised_iff_revision
      CHECK ((revision_no = 1) = (revised_at IS NULL)
             AND (revised_at IS NULL) = (revised_by IS NULL));
  END IF;
END
$$;

COMMENT ON TABLE public.blend_proposal_versions IS
  'History of one Blend Proposal. APPEND-ONLY EXCEPT via fn_overwrite_blend_proposal_version, which ARCHIVES THE REPLACED CONTENTS FIRST into blend_proposal_version_revisions (2026-09-25). No client role can UPDATE or DELETE a row directly — enforced twice: no UPDATE/DELETE privilege, AND RLS with SELECT + INSERT policies and no update/delete policy at all; the SECURITY DEFINER overwrite function is the only in-place writer. New versions are written by fn_save_blend_proposal. Both compute the snapshot in SQL so a client can never store numbers the yard did not have. CARRIES PESO VALUES inside `snapshot` — every read is canViewPrices()-gated at the server action.';
COMMENT ON COLUMN public.blend_proposal_versions.revision_no IS
  'Per-VERSION compare-and-set token for an in-place overwrite. 1 = the version as first saved; fn_overwrite_blend_proposal_version re-checks it inside the UPDATE''s own WHERE and bumps it by 1. Every replaced revision is kept in blend_proposal_version_revisions, so revision_no - 1 is how many earlier contents this version has had. Deliberately separate from blend_proposals.current_version_no (appending) and row_version (header edits).';
COMMENT ON COLUMN public.blend_proposal_versions.revised_at IS
  'When this version was last overwritten in place; NULL if never. The version''s AS-OF instant is coalesce(revised_at, created_at) — published as view_blend_proposal_versions.as_of_at — because an overwrite recomputes the snapshot on that day.';
COMMENT ON COLUMN public.blend_proposal_versions.revised_by IS
  'Who last overwrote this version in place (auth.uid() at the time, verified by the database, not supplied by a caller). NULL if never.';


-- ═════════════════════════════════════════════════════════════════════════════════
-- 2. blend_proposal_version_revisions — the replaced contents (APPEND-ONLY)
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.blend_proposal_version_revisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  proposal_id        uuid    NOT NULL REFERENCES public.blend_proposals(id) ON DELETE RESTRICT,
  version_no         integer NOT NULL CHECK (version_no >= 1),
  -- The revision that was REPLACED (the live row now carries revision_no + 1).
  revision_no        integer NOT NULL CHECK (revision_no >= 1),

  blocks             jsonb NOT NULL,
  snapshot           jsonb NOT NULL,
  snapshot_hash      text  NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  change_note        text,

  -- The replaced row's own provenance, verbatim.
  created_at         timestamptz NOT NULL,
  created_by         uuid NOT NULL REFERENCES public.profiles(id),
  revised_at         timestamptz,
  revised_by         uuid REFERENCES public.profiles(id),

  -- When, and by whom, it was replaced.
  archived_at        timestamptz NOT NULL DEFAULT now(),
  archived_by        uuid NOT NULL REFERENCES public.profiles(id),

  -- A revision describes exactly one live version; it can never float free of it.
  CONSTRAINT blend_proposal_version_revisions_version_fk
    FOREIGN KEY (proposal_id, version_no)
    REFERENCES public.blend_proposal_versions (proposal_id, version_no) ON DELETE RESTRICT,
  CONSTRAINT blend_proposal_version_revisions_unique
    UNIQUE (proposal_id, version_no, revision_no)
);

COMMENT ON TABLE public.blend_proposal_version_revisions IS
  'The HIDDEN ARCHIVE of every blend-proposal version''s contents that were REPLACED by an in-place overwrite (fn_overwrite_blend_proposal_version, 2026-09-25) — the deliveries_archive ethos: overwrite, but nothing is unrecoverable. One row per replaced revision; the live row in blend_proposal_versions carries the revision after it. APPEND-ONLY with two independent locks: no INSERT/UPDATE/DELETE privilege for any client role, and RLS on with a SELECT-only policy (no insert/update/delete policy at all), so the SECURITY DEFINER overwrite function is the ONLY writer and not even a future blanket schema GRANT can forge or erase a row. Nothing is ever deleted from it. CARRIES PESO VALUES inside `snapshot` (raw_price_per_kg, product_cost_per_kg, blocks[].php_kg) — any server action that exposes it must be canViewPrices()-gated and null them before the payload leaves the server. service_role holds nothing; anon holds nothing.';
COMMENT ON COLUMN public.blend_proposal_version_revisions.revision_no IS
  'The revision that was REPLACED. Revisions 1..(live revision_no - 1) of a version are all here.';
COMMENT ON COLUMN public.blend_proposal_version_revisions.snapshot IS
  'The replaced snapshot, verbatim. CARRIES PESOS — gate every read with canViewPrices().';
COMMENT ON COLUMN public.blend_proposal_version_revisions.archived_at IS
  'When this content was replaced (= the live row''s revised_at for the next revision).';
COMMENT ON COLUMN public.blend_proposal_version_revisions.archived_by IS
  'Who replaced it (auth.uid() at the time).';

CREATE INDEX IF NOT EXISTS idx_blend_proposal_version_revisions_version
  ON public.blend_proposal_version_revisions (proposal_id, version_no, revision_no DESC);

-- Supabase's default privileges grant ALL on a new public table to anon, authenticated
-- and service_role: REVOKE FIRST, then grant back exactly the verbs needed.
REVOKE ALL ON public.blend_proposal_version_revisions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.blend_proposal_version_revisions TO authenticated;
-- service_role gets NOTHING (the sync worker never reads blend proposals — L-044's arrow).

ALTER TABLE public.blend_proposal_version_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS blend_proposal_version_revisions_select ON public.blend_proposal_version_revisions;
CREATE POLICY blend_proposal_version_revisions_select
  ON public.blend_proposal_version_revisions FOR SELECT TO authenticated
  USING (true);
-- NO INSERT, UPDATE OR DELETE POLICY — that absence is lock #2. Do not add one.


-- ═════════════════════════════════════════════════════════════════════════════════
-- 3. fn_overwrite_blend_proposal_version — the ONLY in-place writer
-- ═════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_overwrite_blend_proposal_version(
  p_proposal_id          uuid,
  p_version_no           integer,
  p_expected_revision_no integer,
  p_block_locs           text[],
  p_change_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_locs      text[];
  v_missing   text[];
  v_snapshot  jsonb;
  v_blocks    jsonb;
  v_hash      text;
  v_prop      public.blend_proposals;
  v_ver       public.blend_proposal_versions;
  v_new_rev   integer;
  v_cur_rev   integer;
BEGIN
  -- SECURITY DEFINER bypasses both append-only locks, so the identity check is the
  -- function's own job: no identity, no write — and the archive row's archived_by is
  -- NOT NULL, so an anonymous overwrite could never leave an honest trail anyway.
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'not_authenticated',
      'message', 'You need to be signed in to overwrite a blend proposal version.');
  END IF;

  IF p_proposal_id IS NULL OR p_version_no IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'invalid',
      'message', 'Overwriting a version needs the proposal and the version number.');
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

  SELECT * INTO v_prop FROM public.blend_proposals p WHERE p.id = p_proposal_id;
  IF v_prop.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'not_found',
      'message', 'That proposal no longer exists. Reload the proposals list.');
  END IF;

  IF v_prop.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'archived',
      'proposal_id', v_prop.id, 'current_version_no', v_prop.current_version_no,
      'message', format('"%s" is archived. Restore it before changing any of its versions.', v_prop.title));
  END IF;

  SELECT * INTO v_ver
    FROM public.blend_proposal_versions v
   WHERE v.proposal_id = p_proposal_id AND v.version_no = p_version_no;
  IF v_ver.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'unknown_version',
      'proposal_id', v_prop.id, 'current_version_no', v_prop.current_version_no,
      'message', format('There is no v%s of "%s" — its latest version is v%s.',
                        p_version_no, v_prop.title, v_prop.current_version_no));
  END IF;

  -- The token is REQUIRED. Defaulting it to "whatever is current" would silently turn a
  -- stale editor into a successful overwrite — the exact failure it exists to prevent.
  IF p_expected_revision_no IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'expected_revision_required',
      'proposal_id', v_prop.id, 'version_no', p_version_no,
      'current_revision_no', v_ver.revision_no,
      'message', 'Overwriting a version needs the revision you were looking at.');
  END IF;

  IF p_expected_revision_no <> v_ver.revision_no THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'stale',
      'proposal_id', v_prop.id, 'version_no', p_version_no,
      'current_revision_no', v_ver.revision_no,
      'message', format('Someone changed v%s of "%s" while you were working on it. Reload it and try again.',
                        p_version_no, v_prop.title));
  END IF;

  -- Every named block must currently be on the grid. NAME the ones that are not.
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

  -- THE SNAPSHOT IS COMPUTED HERE, never accepted from the caller — the same builder and
  -- the same price-free hash fn_save_blend_proposal uses.
  v_snapshot := public.fn_blend_proposal_snapshot(v_locs);
  v_hash     := public.fn_blend_snapshot_hash(v_snapshot);

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

  -- Identical to THIS version's own contents: nothing to replace, nothing archived.
  -- (Price-free hash, so a price-only change is also "unchanged" — the same consequence
  -- fn_save_blend_proposal states for appending.)
  IF v_ver.snapshot_hash = v_hash THEN
    RETURN jsonb_build_object(
      'ok', true, 'outcome', 'unchanged', 'unchanged', true,
      'proposal_id', v_prop.id, 'version_no', p_version_no,
      'revision_no', v_ver.revision_no,
      'message', format('v%s already holds exactly this blend, so nothing was overwritten.', p_version_no));
  END IF;

  -- ARCHIVE, THEN OVERWRITE — ONE STATEMENT, THE GUARD IN THE UPDATE'S OWN WHERE.
  -- Every CTE reads the same pre-statement snapshot, so `old` is the row as it stood;
  -- the archive INSERT joins to `upd`, so it writes only if the guarded UPDATE matched.
  -- A concurrent overwrite that landed first moved revision_no, the UPDATE matches
  -- nothing (READ COMMITTED re-checks the WHERE against the newer row), and NEITHER
  -- write happens — reported as `stale` below from the freshly re-read value.
  WITH old AS (
    SELECT v.*
      FROM public.blend_proposal_versions v
     WHERE v.id = v_ver.id
  ),
  upd AS (
    UPDATE public.blend_proposal_versions AS t
       SET blocks        = v_blocks,
           snapshot      = v_snapshot,
           snapshot_hash = v_hash,
           change_note   = coalesce(nullif(btrim(coalesce(p_change_note, '')), ''), t.change_note),
           revision_no   = t.revision_no + 1,
           revised_at    = now(),
           revised_by    = v_uid
     WHERE t.id          = v_ver.id
       AND t.revision_no = p_expected_revision_no
    RETURNING t.id, t.revision_no
  ),
  arch AS (
    INSERT INTO public.blend_proposal_version_revisions
      (proposal_id, version_no, revision_no, blocks, snapshot, snapshot_hash, change_note,
       created_at, created_by, revised_at, revised_by, archived_at, archived_by)
    SELECT o.proposal_id, o.version_no, o.revision_no, o.blocks, o.snapshot, o.snapshot_hash,
           o.change_note, o.created_at, o.created_by, o.revised_at, o.revised_by, now(), v_uid
      FROM old o
      JOIN upd u ON u.id = o.id
     WHERE o.revision_no = p_expected_revision_no
    RETURNING 1
  )
  SELECT u.revision_no INTO v_new_rev
    FROM upd u
   WHERE (SELECT count(*) FROM arch) = 1;

  IF v_new_rev IS NULL THEN
    SELECT v.revision_no INTO v_cur_rev
      FROM public.blend_proposal_versions v WHERE v.id = v_ver.id;
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'stale',
      'proposal_id', v_prop.id, 'version_no', p_version_no,
      'current_revision_no', v_cur_rev,
      'message', 'Someone else overwrote this version while you were working on it. Reload and try again.');
  END IF;

  -- NO PESO in the return: ids, numbers of versions/revisions and an outcome only.
  RETURN jsonb_build_object(
    'ok', true, 'outcome', 'overwritten', 'unchanged', false,
    'proposal_id', v_prop.id, 'version_no', p_version_no,
    'revision_no', v_new_rev);
END;
$fn$;

COMMENT ON FUNCTION public.fn_overwrite_blend_proposal_version(uuid, integer, integer, text[], text) IS
  'Overwrites ONE saved blend-proposal version IN PLACE — any version, not only the latest (Renzo, 2026-09-25) — ARCHIVING THE REPLACED CONTENTS FIRST into blend_proposal_version_revisions in the same statement, so nothing is ever unrecoverable. The snapshot is recomputed in SQL (fn_blend_proposal_snapshot + fn_blend_snapshot_hash), never accepted from a client. Compare-and-set on the version''s own revision_no INSIDE the UPDATE''s WHERE (never read-then-write); does NOT touch blend_proposals.row_version (the header-edit token) or current_version_no (the append token). A null/blank p_change_note keeps the old note. Refusals are jsonb {ok:false, reason, message} for a human, never a raise: not_authenticated, invalid, no_blocks, not_found, archived, unknown_version, expected_revision_required, stale (with current_revision_no), unknown_block (naming them). Identical to the version''s current contents → {ok:true, unchanged:true} and nothing written. Returns no peso value. SECURITY DEFINER (owner postgres) because it writes a table no client role may UPDATE — it is the ONLY in-place writer; EXECUTE authenticated only, PUBLIC + anon revoked, service_role not granted.';

REVOKE EXECUTE ON FUNCTION public.fn_overwrite_blend_proposal_version(uuid, integer, integer, text[], text) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.fn_overwrite_blend_proposal_version(uuid, integer, integer, text[], text) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 4. READ MODELS — append the revision facts at the END (CREATE OR REPLACE keeps
--    grants but RESETS reloptions, so security_invoker is re-asserted below)
-- ═════════════════════════════════════════════════════════════════════════════════
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
  cb.display_name                                      AS created_by_name,
  -- ── appended 2026-09-25 (in-place overwrite) ──
  v.revision_no,
  v.revised_at,
  v.revised_by,
  rb.display_name                                      AS revised_by_name,
  -- THE as-of instant of a saved version: an overwrite recomputes the snapshot on the
  -- day it happens, so the version now describes the yard on THAT day.
  coalesce(v.revised_at, v.created_at)                 AS as_of_at
FROM public.blend_proposal_versions v
JOIN public.blend_proposals p ON p.id = v.proposal_id
LEFT JOIN public.profiles cb ON cb.id = v.created_by
LEFT JOIN public.profiles rb ON rb.id = v.revised_by;

ALTER VIEW public.view_blend_proposal_versions SET (security_invoker = true);

COMMENT ON VIEW public.view_blend_proposal_versions IS
  'One row per saved version — the version rail. Carries the peso-free headline (block count, balance, all seven weighted lab stats), the change note, the author, the snapshot hash, and (2026-09-25) the in-place overwrite facts: revision_no (the compare-and-set token fn_overwrite_blend_proposal_version needs), revised_at, revised_by_name, and as_of_at = coalesce(revised_at, created_at) — THE as-of instant for fn_blend_block_facts / fn_blend_analysis on a saved version. The snapshot itself (which DOES carry pesos) is fetched per version by a canViewPrices()-gated server action, never through this view. NO PESO COLUMN.';

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
  ub.display_name                                         AS updated_by_name,
  -- ── appended 2026-09-25 (in-place overwrite) ──
  cur.revision_no                                         AS current_version_revision_no,
  cur.revised_at                                          AS current_version_revised_at
FROM public.blend_proposals p
LEFT JOIN public.blend_proposal_versions cur
       ON cur.proposal_id = p.id AND cur.version_no = p.current_version_no
LEFT JOIN public.profiles cb ON cb.id = p.created_by
LEFT JOIN public.profiles ub ON ub.id = p.updated_by;

ALTER VIEW public.view_blend_proposal_list SET (security_invoker = true);

-- Grants are kept by CREATE OR REPLACE; re-stated so this file alone describes the posture.
REVOKE ALL ON public.view_blend_proposal_list     FROM anon, service_role;
REVOKE ALL ON public.view_blend_proposal_versions FROM anon, service_role;
GRANT SELECT ON public.view_blend_proposal_list     TO authenticated;
GRANT SELECT ON public.view_blend_proposal_versions TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 5. THE AS-OF DATE OF A SAVED VERSION = coalesce(revised_at, created_at)
-- ═════════════════════════════════════════════════════════════════════════════════
-- fn_blend_analysis and its two verify probes (migration 20260921084500) read a saved
-- version's as-of instant from `bv.created_at`. An in-place overwrite recomputes the
-- snapshot on the day it happens, so it becomes `coalesce(bv.revised_at, bv.created_at)`
-- (= view_blend_proposal_versions.as_of_at). For a version never overwritten
-- (revised_at NULL) the result is identical to before.
--
-- HOW: each function is re-created FROM ITS OWN LIVE DEFINITION (pg_get_functiondef)
-- with exactly that textual substitution, and the block REFUSES TO RUN unless the
-- expected text occurs exactly the expected number of times. Re-typing ~900 lines of
-- plpgsql to change three expressions would be the riskier edit; this cannot alter
-- anything else in the bodies. (Measured before writing this: the live prosrc md5 of
-- all three equalled the bodies in 20260921084500, so "live definition" == that file.)
-- pg_get_functiondef emits CREATE OR REPLACE with the original SECURITY / volatility /
-- search_path, and CREATE OR REPLACE keeps owner and grants.
DO $as_of$
DECLARE
  c_old  constant text := $t$(bv.created_at AT TIME ZONE 'Asia/Manila')::date$t$;
  c_new  constant text := $t$(coalesce(bv.revised_at, bv.created_at) AT TIME ZONE 'Asia/Manila')::date$t$;
  c_old1 constant text := $t$SELECT bv.snapshot, bv.created_at INTO v_snapshot, v_created_at$t$;
  c_new1 constant text := $t$SELECT bv.snapshot, coalesce(bv.revised_at, bv.created_at) INTO v_snapshot, v_created_at$t$;
  v_def  text;
  v_n    int;
  r      record;
BEGIN
  -- fn_blend_analysis: ONE occurrence of the saved-version as-of read.
  v_def := pg_get_functiondef('public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int)'::regprocedure);
  v_n := (length(v_def) - length(replace(v_def, c_old1, ''))) / length(c_old1);
  IF v_n = 1 THEN
    EXECUTE replace(v_def, c_old1, c_new1);
  ELSIF position(c_new1 in v_def) = 0 THEN
    RAISE EXCEPTION 'fn_blend_analysis: expected exactly 1 occurrence of the as-of read, found %', v_n;
  END IF;  -- already migrated: nothing to do

  -- The two service_role verify probes: 1 and 2 occurrences respectively.
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_blend_analysis_probe(uuid, int)', 1),
      ('public.fn_blend_analysis_probe_cases()',    2)) AS x(sig, expected)
  LOOP
    v_def := pg_get_functiondef(r.sig::regprocedure);
    v_n := (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old);
    IF v_n = r.expected THEN
      EXECUTE replace(v_def, c_old, c_new);
    ELSIF v_n <> 0 OR position(c_new in v_def) = 0 THEN
      RAISE EXCEPTION '%: expected % occurrence(s) of the as-of expression, found %', r.sig, r.expected, v_n;
    END IF;
  END LOOP;

  -- fn_blend_analysis' COMMENT states the as-of rule; keep it true.
  v_def := obj_description('public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int)'::regprocedure, 'pg_proc');
  IF position('own created_at (saved)' in v_def) > 0 THEN
    EXECUTE format('COMMENT ON FUNCTION public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int) IS %L',
      replace(v_def, 'own created_at (saved)',
        'own coalesce(revised_at, created_at) - its save date, or the day it was last overwritten in place by fn_overwrite_blend_proposal_version (saved)'));
  END IF;
END
$as_of$;

-- Posture re-stated (CREATE OR REPLACE kept it; this file alone should describe it).
REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis_probe(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blend_analysis_probe(uuid, int) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fn_blend_analysis_probe_cases() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blend_analysis_probe_cases() TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════════
-- 6. THE VERIFY PROBE — fn_blend_proposal_overwrite_probe() (service_role only)
-- ═════════════════════════════════════════════════════════════════════════════════
-- scripts/verify-blend-proposal-overwrite.ts holds only the service-role and anon keys,
-- and service_role holds NOTHING on the blend tables or the overwrite RPC — by design.
-- So, like fn_blend_analysis_probe, the proof runs through a SECURITY DEFINER,
-- service_role-only probe.
--
-- IT LEAVES NOTHING BEHIND, STRUCTURALLY. Every write it makes happens inside ONE
-- plpgsql BEGIN … EXCEPTION block whose LAST statement unconditionally RAISEs, so the
-- whole subtransaction — the throwaway proposal, both versions, the overwrite, the
-- archive row — is rolled back on every path (a normal finish is impossible; an
-- unexpected error rolls back the same way and is reported). Only the plpgsql variables
-- holding the RESULTS survive. It asserts nothing; the TypeScript does.
--
-- BOUNDED: it touches one throwaway proposal and three grid blocks; the catalog reads
-- are single-object lookups. It RETURNS NO PESO (every RPC payload it echoes is the
-- overwrite/save envelope, which carries none — the script asserts that too).
CREATE OR REPLACE FUNCTION public.fn_blend_proposal_overwrite_probe()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_sig      constant text := 'public.fn_overwrite_blend_proposal_version(uuid, integer, integer, text[], text)';
  v_uid      uuid;
  v_locs     text[];
  v_out      jsonb := '{}'::jsonb;
  v_pid      uuid;
  v_r        jsonb;
  v_before   jsonb;
  v_hdr      jsonb;
  v_arch     jsonb;
  v_after    jsonb;
  v_count    int;
  v_err      text;
BEGIN
  SELECT p.id INTO v_uid FROM public.profiles p ORDER BY p.created_at LIMIT 1;
  SELECT array_agg(g.block_loc ORDER BY g.block_loc) INTO v_locs
    FROM (SELECT block_loc FROM public.view_blocking_grid
           WHERE balance > 0 ORDER BY block_loc LIMIT 3) g;

  v_out := v_out || jsonb_build_object(
    'block_locs', to_jsonb(v_locs),
    'manila_today', (now() AT TIME ZONE 'Asia/Manila')::date,
    'revisions_rows_before', (SELECT count(*) FROM public.blend_proposal_version_revisions),
    'versions_rows_before',  (SELECT count(*) FROM public.blend_proposal_versions),
    'proposals_rows_before', (SELECT count(*) FROM public.blend_proposals));

  IF v_uid IS NULL OR coalesce(array_length(v_locs, 1), 0) < 3 THEN
    RETURN v_out || jsonb_build_object('skipped', true,
      'why', 'need at least one profile and three occupied grid blocks');
  END IF;

  BEGIN
    -- ── as nobody ──
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    v_out := v_out || jsonb_build_object('anonymous',
      public.fn_overwrite_blend_proposal_version(gen_random_uuid(), 1, 1, v_locs[1:2]));

    -- ── as a signed-in user ──
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);

    v_r := public.fn_save_blend_proposal('ZZ OVERWRITE PROBE (rolled back)', v_locs[1:2]);
    v_pid := (v_r ->> 'proposal_id')::uuid;
    v_out := v_out || jsonb_build_object('save_v1', v_r);
    v_out := v_out || jsonb_build_object('save_v2',
      public.fn_save_blend_proposal('ZZ OVERWRITE PROBE (rolled back)', v_locs[1:3], v_pid, 1, 'v2 note'));

    SELECT to_jsonb(p) INTO v_hdr FROM public.blend_proposals p WHERE p.id = v_pid;
    -- v_before keeps the FULL row (snapshot included) for the in-SQL exactness test;
    -- only the peso-free remainder is echoed.
    SELECT to_jsonb(v) INTO v_before FROM public.blend_proposal_versions v
     WHERE v.proposal_id = v_pid AND v.version_no = 1;
    v_out := v_out || jsonb_build_object('header_before', v_hdr,
      'v1_before', v_before - 'snapshot' - 'blocks');

    -- Overwrite v1 — NOT the latest — with a different blend.
    v_r := public.fn_overwrite_blend_proposal_version(v_pid, 1, 1, ARRAY[v_locs[1], v_locs[3]], 'overwritten note');
    v_out := v_out || jsonb_build_object('overwrite', v_r);

    SELECT to_jsonb(v) - 'snapshot' - 'blocks'
             || jsonb_build_object('computed_at', v.snapshot ->> 'computed_at',
                                   'block_locs', (SELECT jsonb_agg(b ->> 'block_loc' ORDER BY b ->> 'block_loc')
                                                    FROM jsonb_array_elements(v.blocks) b))
      INTO v_after FROM public.blend_proposal_versions v
     WHERE v.proposal_id = v_pid AND v.version_no = 1;
    -- The archive row, peso-free, plus a FIELD-BY-FIELD exactness verdict computed here
    -- against the full pre-overwrite row (so the snapshot itself never leaves SQL).
    SELECT jsonb_agg(
             (to_jsonb(r) - 'snapshot' - 'blocks')
             || jsonb_build_object(
                  'eq_blocks',        r.blocks        = v_before -> 'blocks',
                  'eq_snapshot',      r.snapshot      = v_before -> 'snapshot',
                  'eq_snapshot_hash', r.snapshot_hash = v_before ->> 'snapshot_hash',
                  'eq_change_note',   r.change_note IS NOT DISTINCT FROM (v_before ->> 'change_note'),
                  'eq_created_at',    r.created_at    = (v_before ->> 'created_at')::timestamptz,
                  'eq_created_by',    r.created_by    = (v_before ->> 'created_by')::uuid,
                  'eq_revision_no',   r.revision_no   = (v_before ->> 'revision_no')::int,
                  'eq_revised_at',    r.revised_at IS NOT DISTINCT FROM (v_before ->> 'revised_at')::timestamptz,
                  'eq_revised_by',    r.revised_by IS NOT DISTINCT FROM (v_before ->> 'revised_by')::uuid,
                  'archived_by_is_caller', r.archived_by = v_uid))
      INTO v_arch FROM public.blend_proposal_version_revisions r
     WHERE r.proposal_id = v_pid;
    v_out := v_out || jsonb_build_object(
      'v1_after', v_after,
      'archive_rows', coalesce(v_arch, '[]'::jsonb),
      'header_after', (SELECT to_jsonb(p) FROM public.blend_proposals p WHERE p.id = v_pid),
      'v2_after', (SELECT to_jsonb(v) - 'snapshot' - 'blocks' FROM public.blend_proposal_versions v
                    WHERE v.proposal_id = v_pid AND v.version_no = 2),
      'expected_hash', public.fn_blend_snapshot_hash(
                         public.fn_blend_proposal_snapshot(ARRAY[v_locs[1], v_locs[3]])),
      'view_v1', (SELECT to_jsonb(x) FROM public.view_blend_proposal_versions x
                   WHERE x.proposal_id = v_pid AND x.version_no = 1),
      'list_row', (SELECT to_jsonb(x) FROM public.view_blend_proposal_list x WHERE x.id = v_pid),
      'analysis_v1_as_of', public.fn_blend_analysis(v_pid, 1) ->> 'as_of');

    -- The token the caller held is now stale.
    v_out := v_out || jsonb_build_object('stale',
      public.fn_overwrite_blend_proposal_version(v_pid, 1, 1, v_locs[1:2]));

    -- Identical to what v1 now holds → unchanged, zero rows written.
    v_out := v_out || jsonb_build_object('unchanged',
      public.fn_overwrite_blend_proposal_version(v_pid, 1, 2, ARRAY[v_locs[3], v_locs[1]], 'ignored'));
    SELECT count(*) INTO v_count FROM public.blend_proposal_version_revisions r WHERE r.proposal_id = v_pid;
    v_out := v_out || jsonb_build_object(
      'archive_rows_after_unchanged', v_count,
      'v1_after_unchanged', (SELECT to_jsonb(v) - 'snapshot' - 'blocks' FROM public.blend_proposal_versions v
                              WHERE v.proposal_id = v_pid AND v.version_no = 1));

    -- Identical to a SIBLING (v2) is legal — no unique hash.
    v_out := v_out || jsonb_build_object('same_as_sibling',
      public.fn_overwrite_blend_proposal_version(v_pid, 1, 2, v_locs[1:3]));

    v_out := v_out || jsonb_build_object(
      'unknown_block',   public.fn_overwrite_blend_proposal_version(v_pid, 2, 1, ARRAY[v_locs[1], 'ZZ-NOPE-9']),
      'no_blocks',       public.fn_overwrite_blend_proposal_version(v_pid, 2, 1, ARRAY['  ']::text[]),
      'unknown_version', public.fn_overwrite_blend_proposal_version(v_pid, 99, 1, v_locs[1:2]),
      'unknown_proposal',public.fn_overwrite_blend_proposal_version(gen_random_uuid(), 1, 1, v_locs[1:2]),
      'missing_token',   public.fn_overwrite_blend_proposal_version(v_pid, 2, NULL, v_locs[1:2]));

    PERFORM public.fn_archive_blend_proposal(v_pid);
    v_out := v_out || jsonb_build_object('archived',
      public.fn_overwrite_blend_proposal_version(v_pid, 2, 1, v_locs[1:2]));

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'blend_overwrite_probe_rollback';
  EXCEPTION
    WHEN OTHERS THEN
      v_err := SQLERRM;
  END;

  v_out := v_out || jsonb_build_object(
    'rolled_back_by', v_err,
    'revisions_rows_after', (SELECT count(*) FROM public.blend_proposal_version_revisions),
    'versions_rows_after',  (SELECT count(*) FROM public.blend_proposal_versions),
    'proposals_rows_after', (SELECT count(*) FROM public.blend_proposals),
    'probe_proposal_survived', (SELECT count(*) FROM public.blend_proposals WHERE id = v_pid),

    'posture', jsonb_build_object(
      'fn_secdef',           (SELECT prosecdef FROM pg_proc WHERE oid = c_sig::regprocedure),
      'fn_owner',            (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = c_sig::regprocedure),
      'fn_search_path',      (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = c_sig::regprocedure),
      'fn_authenticated',    has_function_privilege('authenticated', c_sig, 'EXECUTE'),
      'fn_anon',             has_function_privilege('anon', c_sig, 'EXECUTE'),
      'fn_service_role',     has_function_privilege('service_role', c_sig, 'EXECUTE'),
      'fn_public',           EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                      WHERE p.oid = c_sig::regprocedure AND a.grantee = 0),
      'versions_auth_update', has_table_privilege('authenticated', 'public.blend_proposal_versions', 'UPDATE'),
      'versions_auth_delete', has_table_privilege('authenticated', 'public.blend_proposal_versions', 'DELETE'),
      'revisions_auth_select', has_table_privilege('authenticated', 'public.blend_proposal_version_revisions', 'SELECT'),
      'revisions_auth_insert', has_table_privilege('authenticated', 'public.blend_proposal_version_revisions', 'INSERT'),
      'revisions_auth_update', has_table_privilege('authenticated', 'public.blend_proposal_version_revisions', 'UPDATE'),
      'revisions_auth_delete', has_table_privilege('authenticated', 'public.blend_proposal_version_revisions', 'DELETE'),
      'revisions_anon_any',   has_table_privilege('anon', 'public.blend_proposal_version_revisions', 'SELECT,INSERT,UPDATE,DELETE'),
      'revisions_service_any', has_table_privilege('service_role', 'public.blend_proposal_version_revisions', 'SELECT,INSERT,UPDATE,DELETE'),
      'revisions_rls',        (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.blend_proposal_version_revisions'::regclass),
      'versions_rls',         (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.blend_proposal_versions'::regclass),
      'revisions_policies',   (SELECT coalesce(jsonb_agg(cmd ORDER BY cmd), '[]'::jsonb) FROM pg_policies
                                WHERE schemaname = 'public' AND tablename = 'blend_proposal_version_revisions'),
      'versions_policies',    (SELECT coalesce(jsonb_agg(cmd ORDER BY cmd), '[]'::jsonb) FROM pg_policies
                                WHERE schemaname = 'public' AND tablename = 'blend_proposal_versions'),
      'view_options',         (SELECT jsonb_object_agg(c.relname, coalesce(array_to_string(c.reloptions, ','), ''))
                                FROM pg_class c WHERE c.oid IN ('public.view_blend_proposal_versions'::regclass,
                                                                'public.view_blend_proposal_list'::regclass)),
      'views_auth_select',    has_table_privilege('authenticated', 'public.view_blend_proposal_versions', 'SELECT')
                              AND has_table_privilege('authenticated', 'public.view_blend_proposal_list', 'SELECT'),
      'views_anon_select',    has_table_privilege('anon', 'public.view_blend_proposal_versions', 'SELECT')
                              OR has_table_privilege('anon', 'public.view_blend_proposal_list', 'SELECT')
    ));

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.fn_blend_proposal_overwrite_probe() IS
  'Read-only-in-effect verify bridge for scripts/verify-blend-proposal-overwrite.ts. Exercises fn_overwrite_blend_proposal_version end to end on ONE throwaway proposal (create v1, append v2, overwrite v1, then stale / unchanged / same-as-sibling / unknown_block / no_blocks / unknown_version / unknown proposal / missing token / archived / anonymous) INSIDE a subtransaction whose last statement unconditionally raises, so every write is rolled back on every path and nothing is left behind — only the captured results survive. Also reads the catalog posture (SECURITY DEFINER, grants, RLS policies, view reloptions). Asserts nothing. Bounded: one proposal, three grid blocks. Returns no peso value. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blend_proposal_overwrite_probe() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blend_proposal_overwrite_probe() TO service_role;
