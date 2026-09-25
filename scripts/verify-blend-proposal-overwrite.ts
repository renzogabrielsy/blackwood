/**
 * verify-blend-proposal-overwrite.ts — the proofs behind OVERWRITING A SAVED BLEND
 * PROPOSAL VERSION IN PLACE.
 *
 * Run: npx tsx scripts/verify-blend-proposal-overwrite.ts
 *
 * ============================================================================
 * WHAT THE FEATURE IS, AND WHAT CAN GO WRONG WITH IT
 * ============================================================================
 * Saved blend versions (`blend_proposal_versions`) were APPEND-ONLY by two independent
 * locks. Renzo (2026-09-25) decided a user must be able to overwrite ANY existing
 * version in place — but keep a hidden archive copy of what was replaced, so nothing is
 * unrecoverable. Migration `20260925075509_blend_proposal_version_overwrite` adds:
 *   * `blend_proposal_versions.revision_no / revised_at / revised_by` (per-version token)
 *   * `blend_proposal_version_revisions` — the APPEND-ONLY archive of replaced contents
 *   * `fn_overwrite_blend_proposal_version(...)` — SECURITY DEFINER, the ONLY in-place
 *     writer; it archives FIRST, in the same statement, with the guard in the UPDATE's
 *     own WHERE
 *   * `view_blend_proposal_versions.as_of_at` = coalesce(revised_at, created_at), and
 *     fn_blend_analysis re-pointed to it (an overwrite recomputes the snapshot TODAY)
 *
 * The failure modes worth testing:
 *   LOSS       the overwrite replaces contents without an exact archive copy.
 *   RACE       a stale editor wins (read-then-write), or a token is optional.
 *   COLLATERAL the header's row_version / current_version_no move, staling an open
 *              rename or "Save as v(N+1)" that has nothing to do with the overwrite.
 *   ESCAPE     a client role can now UPDATE/DELETE a version or forge an archive row,
 *              or anon / service_role can reach the SECURITY DEFINER writer.
 *   AS-OF      a saved version keeps being analysed as of the day it was first saved
 *              after its snapshot was recomputed on a later day.
 *   ₱          the RPC envelope, or this script's output, carries a peso.
 *   RESIDUE    a proof leaves test rows in the live database.
 *
 * ============================================================================
 * WHY THE NUMBERS COME FROM A PROBE RPC
 * ============================================================================
 * The overwrite RPC is `authenticated`-only and service_role holds NOTHING on the blend
 * tables, so this script (service-role + anon keys only) cannot call it — which is the
 * point of the grant. `fn_blend_proposal_overwrite_probe()` (service_role only) runs the
 * whole scenario on ONE throwaway proposal INSIDE a subtransaction whose last statement
 * unconditionally raises, so every write is rolled back on every path; it returns the
 * captured results and ASSERTS NOTHING. It is bounded by construction (one proposal,
 * three grid blocks) — never a whole-history verifier (the 2026-09-14 incident).
 *
 * The real-ROLE proof (actually running as `authenticated`: direct UPDATE/DELETE on
 * both tables refused with 42501, the RPC succeeding) cannot be done from a
 * SECURITY DEFINER function (Postgres forbids SET ROLE there); it was run by hand on
 * 2026-09-25 in a rolled-back DO block and is recorded in the blocking CONTEXT.md.
 * What this script DOES prove by assuming the victim's role is the anon and
 * service_role half: both really call the RPC / read the archive and are refused.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const MIGRATION = 'supabase/migrations/20260925075509_blend_proposal_version_overwrite.sql';
const PROBE_MIGRATION = 'supabase/migrations/20260925075640_blend_proposal_overwrite_probe_as_of.sql';
const ACTIONS = 'app/(app)/inventory/blocking/actions.ts';
const DIALOG = 'app/(app)/inventory/_shared/blend-proposal-dialog.tsx';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

/** Anything whose NAME would make a reader think it carries money. */
const MONEY_KEY_RE = /php|peso|cost|price|amount/i;

/** A SHAPE alarm, not a latency SLO — the probe makes ~20 small calls. */
const PROBE_MS_BUDGET = 15_000;

const SIG = 'public.fn_overwrite_blend_proposal_version(uuid, integer, integer, text[], text)';

/** The body of one exported async function in a TS source, up to the next export. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`export async function ${name}(`);
  assert.ok(at >= 0, `${name} is not exported`);
  const next = src.indexOf('\nexport ', at + 10);
  return src.slice(at, next < 0 ? undefined : next);
}

// ---------------------------------------------------------------------------
// 1. STATIC — the migration's posture, and the action's shape
// ---------------------------------------------------------------------------
function staticChecks(): void {
  console.log('\nstatic (migrations + server action, no network) ------------------');
  const sql = read(MIGRATION);

  check('the overwrite RPC is SECURITY DEFINER and pins search_path', () => {
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_overwrite_blend_proposal_version(');
    assert.ok(at > 0);
    const head = sql.slice(at, at + 600);
    assert.ok(/\nSECURITY DEFINER\n/.test(head), 'not SECURITY DEFINER');
    assert.ok(/\nSET search_path = public\n/.test(head), 'search_path not pinned');
  });

  check('grants: authenticated only — PUBLIC, anon and service_role revoked', () => {
    assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION ${SIG} FROM PUBLIC, anon, service_role;`));
    assert.ok(sql.includes(`GRANT  EXECUTE ON FUNCTION ${SIG} TO authenticated;`));
  });

  check('the guard is INSIDE the UPDATE (revision_no = expected), archive joins the UPDATE', () => {
    assert.ok(/WHERE t\.id\s+= v_ver\.id\s+AND t\.revision_no = p_expected_revision_no/.test(sql));
    assert.ok(/FROM old o\s+JOIN upd u ON u\.id = o\.id/.test(sql), 'archive not tied to the update');
  });

  check('the RPC never touches the header tokens (row_version / current_version_no)', () => {
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_overwrite_blend_proposal_version(');
    const end = sql.indexOf('$fn$;', at);
    const body = sql.slice(at, end);
    assert.ok(!/UPDATE public\.blend_proposals\b/.test(body), 'the RPC updates the header');
  });

  check('the snapshot is computed in SQL, never taken as a parameter', () => {
    assert.ok(sql.includes('v_snapshot := public.fn_blend_proposal_snapshot(v_locs);'));
    const sigAt = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_overwrite_blend_proposal_version(');
    const params = sql.slice(sigAt, sql.indexOf(')\nRETURNS jsonb', sigAt));
    assert.ok(!/snapshot/i.test(params), 'a snapshot parameter appeared');
  });

  check('archive table: SELECT for authenticated only, SELECT policy only', () => {
    assert.ok(sql.includes('REVOKE ALL ON public.blend_proposal_version_revisions FROM PUBLIC, anon, authenticated, service_role;'));
    assert.ok(sql.includes('GRANT SELECT ON public.blend_proposal_version_revisions TO authenticated;'));
    const policies = sql.match(/CREATE POLICY \w+\s+ON public\.blend_proposal_version_revisions FOR (\w+)/g) ?? [];
    assert.deepEqual(policies.map((p) => p.split(' FOR ')[1]), ['SELECT']);
  });

  check('both replaced views re-assert security_invoker in the same file', () => {
    for (const v of ['view_blend_proposal_versions', 'view_blend_proposal_list']) {
      const cr = sql.indexOf(`CREATE OR REPLACE VIEW public.${v}`);
      const alter = sql.indexOf(`ALTER VIEW public.${v} SET (security_invoker = true);`);
      assert.ok(cr > 0 && alter > cr, `${v}: no ALTER ... security_invoker after CREATE OR REPLACE`);
    }
  });

  check('as_of_at = coalesce(revised_at, created_at) is published on the version view', () => {
    assert.ok(/coalesce\(v\.revised_at, v\.created_at\)\s+AS as_of_at/.test(sql));
  });

  check('the probe is service_role only (both migrations)', () => {
    for (const f of [MIGRATION, PROBE_MIGRATION]) {
      const s = read(f);
      assert.ok(s.includes('REVOKE EXECUTE ON FUNCTION public.fn_blend_proposal_overwrite_probe() FROM PUBLIC, anon, authenticated;'), f);
      assert.ok(s.includes('GRANT  EXECUTE ON FUNCTION public.fn_blend_proposal_overwrite_probe() TO service_role;'), f);
    }
  });

  const actions = read(ACTIONS);
  check('overwriteBlendProposalVersion calls the RPC, sends no snapshot, has no price step', () => {
    const body = fnBody(actions, 'overwriteBlendProposalVersion');
    assert.ok(body.includes(".rpc('fn_overwrite_blend_proposal_version'"));
    assert.ok(!/p_snapshot|snapshot:/.test(body), 'a snapshot is being sent from TypeScript');
    assert.ok(!/canViewPrices/.test(body), 'a price gate appeared on a peso-free write');
    assert.ok(body.includes("revalidatePath('/inventory/blocking')"));
  });

  check('fetchBlendProposalVersion reads revision_no from the SAME row as the snapshot', () => {
    const body = fnBody(actions, 'fetchBlendProposalVersion');
    assert.ok(body.includes(".select('snapshot, revision_no, revised_at')"));
    assert.ok(/canView && b\.php_kg/.test(body), 'the per-block ₱ nulling moved');
  });

  check('the version rail maps as_of_at, and the dialog asks block facts about asOfAt', () => {
    const body = fnBody(actions, 'fetchBlendProposalVersions');
    assert.ok(body.includes('as_of_at'));
    const dialog = read(DIALOG);
    assert.ok(/\?\.asOfAt \?\? null/.test(dialog), 'dialog does not read asOfAt');
    assert.ok(!/\?\.createdAt \?\? null;\s*\n\s*\/\*\* A SAVED version/.test(dialog), 'dialog still reads createdAt');
  });
}

// ---------------------------------------------------------------------------
// 2. LIVE — the probe, plus real calls as anon and as service_role
// ---------------------------------------------------------------------------
function readEnv(): { url: string; service: string; anon: string } | null {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  let service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  let anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !service || !anon) {
    try {
      const txt = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const value = m[2].replace(/^['"]|['"]$/g, '');
        if (m[1] === 'NEXT_PUBLIC_SUPABASE_URL' && !url) url = value;
        if (m[1] === 'SUPABASE_SERVICE_ROLE_KEY' && !service) service = value;
        if (m[1] === 'NEXT_PUBLIC_SUPABASE_ANON_KEY' && !anon) anon = value;
      }
    } catch {
      /* no .env.local — fall through to the skip */
    }
  }
  return url && service && anon ? { url, service, anon } : null;
}

/** Every key anywhere in a JSON value. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

type Env = Record<string, unknown>;

async function liveChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });
  console.log('\nlive (probe + real anon / service_role calls) ---------------------');

  const args = {
    p_proposal_id: '00000000-0000-4000-8000-000000000000',
    p_version_no: 1,
    p_expected_revision_no: 1,
    p_block_locs: ['A-1A'],
  };
  const anonCall = await anon.rpc('fn_overwrite_blend_proposal_version', args);
  check('anon CANNOT execute the overwrite RPC (a real call)', () => {
    assert.ok(anonCall.error, 'anon executed the SECURITY DEFINER writer');
  });
  const svcCall = await svc.rpc('fn_overwrite_blend_proposal_version', args);
  check('service_role CANNOT execute the overwrite RPC (not granted, on purpose)', () => {
    assert.ok(svcCall.error, 'service_role executed the writer');
  });
  const svcRead = await svc.from('blend_proposal_version_revisions').select('id').limit(1);
  check('service_role CANNOT read the archive (it carries pesos; nothing server-side needs it)', () => {
    assert.ok(svcRead.error, 'service_role read the archive');
  });
  const anonProbe = await anon.rpc('fn_blend_proposal_overwrite_probe');
  check('anon CANNOT execute the verify probe', () => {
    assert.ok(anonProbe.error, 'anon reached the probe');
  });

  const t0 = Date.now();
  const probeRes = await svc.rpc('fn_blend_proposal_overwrite_probe');
  const ms = Date.now() - t0;
  check(`the probe answers (${ms} ms, budget ${PROBE_MS_BUDGET} ms)`, () => {
    assert.equal(probeRes.error, null, probeRes.error?.message);
    assert.ok(ms < PROBE_MS_BUDGET, `probe took ${ms} ms`);
  });
  const p = probeRes.data as Env;
  if (p.skipped) {
    console.log(`  ! probe SKIPPED its scenario: ${String(p.why)} — the live half is NOT proven.`);
    process.exitCode = 1;
    return;
  }
  const o = (k: string) => p[k] as Env;

  check('RESIDUE: every write was rolled back (row counts unchanged, probe proposal gone)', () => {
    assert.equal(p.rolled_back_by, 'blend_overwrite_probe_rollback', `unexpected error: ${String(p.rolled_back_by)}`);
    assert.equal(p.revisions_rows_after, p.revisions_rows_before);
    assert.equal(p.versions_rows_after, p.versions_rows_before);
    assert.equal(p.proposals_rows_after, p.proposals_rows_before);
    assert.equal(p.probe_proposal_survived, 0);
  });

  check('setup: v1 created, v2 appended by the unchanged save path', () => {
    assert.equal(o('save_v1').ok, true);
    assert.equal(o('save_v2').outcome, 'versioned');
    assert.equal(o('save_v2').version_no, 2);
  });

  check('overwriting v1 (NOT the latest) succeeds and bumps revision_no 1 → 2', () => {
    assert.deepEqual(
      { ok: o('overwrite').ok, outcome: o('overwrite').outcome, rev: o('overwrite').revision_no },
      { ok: true, outcome: 'overwritten', rev: 2 },
    );
    const after = o('v1_after');
    assert.equal(after.revision_no, 2);
    assert.ok(after.revised_at, 'revised_at not set');
    assert.ok(after.revised_by, 'revised_by not set');
    assert.equal(after.change_note, 'overwritten note');
    assert.equal(after.snapshot_hash, p.expected_hash, 'stored hash is not the SQL-computed one');
    const locs = p.block_locs as string[];
    assert.deepEqual(after.block_locs, [locs[0], locs[2]].sort());
  });

  check('LOSS: exactly one archive row holds the replaced contents, field for field', () => {
    const rows = p.archive_rows as Env[];
    assert.equal(rows.length, 1);
    const r = rows[0];
    for (const k of Object.keys(r).filter((k) => k.startsWith('eq_') || k === 'archived_by_is_caller')) {
      assert.equal(r[k], true, `archive mismatch on ${k}`);
    }
    assert.equal(r.revision_no, 1);
    assert.equal(r.snapshot_hash, (o('v1_before') as Env).snapshot_hash);
  });

  check('COLLATERAL: header row_version / current_version_no untouched; v2 untouched', () => {
    assert.equal(o('header_after').row_version, o('header_before').row_version);
    assert.equal(o('header_after').current_version_no, o('header_before').current_version_no);
    assert.equal(o('v2_after').revision_no, 1);
    assert.equal(o('v2_after').revised_at, null);
  });

  check('RACE: the old token is refused as stale, naming the current revision', () => {
    assert.equal(o('stale').ok, false);
    assert.equal(o('stale').reason, 'stale');
    assert.equal(o('stale').current_revision_no, 2);
    assert.equal(o('missing_token').reason, 'expected_revision_required');
  });

  check('an identical re-save is `unchanged` and writes nothing (no archive row, no bump)', () => {
    assert.equal(o('unchanged').ok, true);
    assert.equal(o('unchanged').unchanged, true);
    assert.equal(p.archive_rows_after_unchanged, 1);
    assert.equal(o('v1_after_unchanged').revision_no, 2);
    assert.equal(o('v1_after_unchanged').change_note, 'overwritten note', 'note changed on a no-op');
  });

  check('identical to a SIBLING version is legal (no unique hash) — overwritten, rev 3', () => {
    assert.equal(o('same_as_sibling').outcome, 'overwritten');
    assert.equal(o('same_as_sibling').revision_no, 3);
  });

  check('refusals are human jsonb, never a raise — and unknown_block NAMES the block', () => {
    assert.equal(o('unknown_block').reason, 'unknown_block');
    assert.deepEqual(o('unknown_block').blocks, ['ZZ-NOPE-9']);
    assert.ok(String(o('unknown_block').message).includes('ZZ-NOPE-9'));
    assert.equal(o('no_blocks').reason, 'no_blocks');
    assert.equal(o('unknown_version').reason, 'unknown_version');
    assert.equal(o('unknown_proposal').reason, 'not_found');
    assert.equal(o('archived').reason, 'archived');
    assert.equal(o('anonymous').reason, 'not_authenticated');
    for (const k of ['stale', 'unknown_block', 'no_blocks', 'unknown_version', 'archived', 'anonymous']) {
      assert.ok(String(o(k).message).length > 20, `${k} has no human message`);
    }
  });

  check('AS-OF: a backdated v1 reads its created day, then TODAY once overwritten; v2 keeps its day', () => {
    assert.equal(p.analysis_v1_as_of_before, p.backdated_to);
    assert.equal(p.analysis_v1_as_of, p.manila_today);
    assert.equal(p.analysis_v2_as_of, p.backdated_to);
    const view = o('view_v1');
    assert.equal(view.as_of_at, view.revised_at, 'as_of_at is not revised_at after an overwrite');
    assert.equal(view.revision_no, 2);
    assert.ok(view.revised_by_name, 'revised_by_name not joined');
  });

  check('the list view reports the CURRENT version\'s revision (v2 = 1, never revised)', () => {
    assert.equal(o('list_row').current_version_revision_no, 1);
    assert.equal(o('list_row').current_version_revised_at, null);
  });

  check('ESCAPE (catalog): no client role can UPDATE/DELETE either table or write the archive', () => {
    const s = o('posture');
    assert.equal(s.fn_secdef, true);
    assert.equal(s.fn_owner, 'postgres');
    assert.equal(s.fn_search_path, 'search_path=public');
    assert.equal(s.fn_authenticated, true);
    assert.equal(s.fn_anon, false);
    assert.equal(s.fn_service_role, false);
    assert.equal(s.fn_public, false);
    assert.equal(s.versions_auth_update, false);
    assert.equal(s.versions_auth_delete, false);
    assert.equal(s.revisions_auth_select, true);
    assert.equal(s.revisions_auth_insert, false);
    assert.equal(s.revisions_auth_update, false);
    assert.equal(s.revisions_auth_delete, false);
    assert.equal(s.revisions_anon_any, false);
    assert.equal(s.revisions_service_any, false);
    assert.equal(s.revisions_rls, true);
    assert.equal(s.versions_rls, true);
    assert.deepEqual(s.revisions_policies, ['SELECT']);
    assert.deepEqual(s.versions_policies, ['INSERT', 'SELECT']);
  });

  check('both views are still security_invoker, authenticated-readable, anon-blind', () => {
    const s = o('posture');
    assert.deepEqual(s.view_options, {
      view_blend_proposal_list: 'security_invoker=true',
      view_blend_proposal_versions: 'security_invoker=true',
    });
    assert.equal(s.views_auth_select, true);
    assert.equal(s.views_anon_select, false);
  });

  check('₱: no money-named key anywhere in the RPC envelopes or the probe output', () => {
    const bad = allKeys(p).filter((k) => MONEY_KEY_RE.test(k));
    assert.deepEqual(bad, [], `money-named keys: ${bad.join(', ')}`);
  });
}

async function main(): Promise<void> {
  staticChecks();
  const env = readEnv();
  if (!env) {
    console.log('\n  ! SKIPPING the live half: no NEXT_PUBLIC_SUPABASE_URL / keys found.');
  } else {
    await liveChecks(env);
  }
  console.log(`\n${passed} assertions passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
