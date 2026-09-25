-- ═════════════════════════════════════════════════════════════════════════════════
-- fn_blend_proposal_overwrite_probe — make the AS-OF switch visible
-- ═════════════════════════════════════════════════════════════════════════════════
-- Follow-up to 20260925075509. The probe's throwaway versions are created "now", so
-- created_at and revised_at fall on the same day and the as-of rule
-- (coalesce(revised_at, created_at)) could not be told apart from the old one
-- (created_at). The probe now BACKDATES both throwaway versions 30 days inside the same
-- rolled-back subtransaction, then reads fn_blend_analysis' as_of before the overwrite
-- (must be the backdated day), after it (must be today) and on the untouched v2 (must
-- stay the backdated day). Nothing else in the probe changes; it still leaves nothing
-- behind and still returns no peso value.
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

    -- Backdate both versions 30 days (rolled back with everything else) so the as-of
    -- switch is VISIBLE: v1 must move from that date to today when it is overwritten,
    -- while v2, never overwritten, must keep reading its own created_at.
    UPDATE public.blend_proposal_versions SET created_at = now() - interval '30 days'
     WHERE proposal_id = v_pid;
    v_out := v_out || jsonb_build_object(
      'backdated_to', ((now() - interval '30 days') AT TIME ZONE 'Asia/Manila')::date,
      'analysis_v1_as_of_before', public.fn_blend_analysis(v_pid, 1) ->> 'as_of',
      'view_v1_as_of_before', (SELECT x.as_of_at FROM public.view_blend_proposal_versions x
                                WHERE x.proposal_id = v_pid AND x.version_no = 1));

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
      'analysis_v1_as_of', public.fn_blend_analysis(v_pid, 1) ->> 'as_of',
      'analysis_v2_as_of', public.fn_blend_analysis(v_pid, 2) ->> 'as_of');

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
  'Read-only-in-effect verify bridge for scripts/verify-blend-proposal-overwrite.ts. Exercises fn_overwrite_blend_proposal_version end to end on ONE throwaway proposal (create v1, append v2, backdate both 30 days so the as-of switch is visible, overwrite v1, then stale / unchanged / same-as-sibling / unknown_block / no_blocks / unknown_version / unknown proposal / missing token / archived / anonymous) INSIDE a subtransaction whose last statement unconditionally raises, so every write is rolled back on every path and nothing is left behind — only the captured results survive. Also reads the catalog posture (SECURITY DEFINER, grants, RLS policies, view reloptions). Asserts nothing. Bounded: one proposal, three grid blocks. Returns no peso value. SECURITY DEFINER, service_role only; never authenticated, never anon.';

REVOKE EXECUTE ON FUNCTION public.fn_blend_proposal_overwrite_probe() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_blend_proposal_overwrite_probe() TO service_role;
