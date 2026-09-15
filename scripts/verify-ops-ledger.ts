/**
 * verify-ops-ledger.ts — the proofs behind the PLANT OPERATIONS LEDGER data layer.
 *
 * Run: npx tsx scripts/verify-ops-ledger.ts
 *
 * ============================================================================
 * WHY THIS SCRIPT IS PER-CAMPAIGN (the 2026-09-14 incident)
 * ============================================================================
 * The first version of this script called ONE probe, `fn_ops_ledger_verify()`,
 * which count(*)'d every `view_ops_ledger_*` view over the WHOLE of history and
 * cross-checked every fold across all 32 campaigns in a single statement. That
 * call hung the Supabase instance — most likely OOM — and took the LIVE SITE
 * down until a dashboard restart. The probe has been dropped; its unapplied
 * sibling `fn_ops_ledger_verify_groups()` (32 group-RPC calls in one statement)
 * was deleted from the migration before it ever ran.
 *
 * THE RULE THAT REPLACED IT, and it is structural rather than a convention:
 *   - `fn_ops_ledger_verify_campaign(key)` takes ONE campaign key and filters
 *     every subquery on `production_batch` + `campaign_year` (never on the
 *     computed `campaign_key`, which cannot be pushed down into the views).
 *   - `fn_ops_ledger_verify_group(keys[])` RAISES above 12 keys, so it is
 *     impossible to point it at all history.
 *   - this script loops the campaigns STRICTLY SEQUENTIALLY (`for … await`),
 *     never `Promise.all`, times every call and FAILS any call over 5,000 ms.
 * Nothing in this file may ever read the whole view stack in one go again.
 *
 * ============================================================================
 * WHAT IT PROVES, AND WHY EACH ONE IS HERE
 * ============================================================================
 * The ledger publishes a day spine with three LENSES hanging off it (grades,
 * blocks fed, blocks used), a shift EXPAND, a per-campaign EOQ row and a GROUP
 * row. Almost none of those numbers are new: they are folds of, or verbatim
 * selects from, views that already own them. So the two failure modes worth
 * testing are (1) a fold that does not add up to the headline above it, and
 * (2) a "reuse" that quietly re-derives and drifts.
 *
 *   FOLDS      Σ(grade kg)  per day == day.produced_kg
 *              Σ(block fed) per day == day.fed_kg
 *              Σ(shift produced / downtime) per day == the day's figures
 *              Σ(day fed / produced) per campaign == the campaign KPI row
 *              Σ(day waste) per campaign == the KPI row's waste_kg, AND the same
 *              per STREAM (a total can agree while two streams are swapped), AND
 *              the group's waste_kg == Σ its members' — gap_waste_kg === 0
 *   REUSE      every price / yield / coverage column on the campaign KPI row is
 *              `IS DISTINCT FROM`-identical to view_analytics_batch_cost, and
 *              every production column to view_analytics_production_by_batch
 *   GROUP      a ONE-campaign group equals that campaign's row exactly (checked
 *              once per campaign, inside that campaign's own probe call); and
 *              the Q3 2026 group's yield, fed rate and PC cost equal a direct
 *              Σproduced/Σfed, Σvalue/Σfed and Σvalue/Σproduced
 *   POSTURE    all 8 views security_invoker, authenticated SELECT, anon DENIED,
 *              service_role DENIED — and the denial is proven by a REAL READ,
 *              not by reading the grant table (the L-043 lesson: a permission
 *              claim is proven by assuming the victim's role) — plus: the two
 *              whole-history probes are GONE and stay gone, and all three
 *              replacement probes are service_role-only
 *   MONEY      the five peso-free views carry no money-named column at all, and
 *              view_ops_ledger_day carries exactly one (`fed_php_kg`)
 *
 * ============================================================================
 * WHY THE NUMBERS COME FROM AN RPC AND NOT FROM READS
 * ============================================================================
 * Every `view_ops_ledger_*` view is authenticated-only BY DESIGN — `anon` is
 * revoked and `service_role` was never granted, because the sync worker reads
 * none of them and `verify-worker-view-grants` must stay at 4 views / 0 findings.
 * So neither key this script can hold may read them, and there is no other door.
 * The three SECURITY DEFINER, service_role-only probes are that door — the same
 * idiom as `canonical_supplier_batch_probe` and `fn_audit_trigger_function_grants`.
 * They return NO ₱ VALUE: every money-derived check is published as a GAP that
 * must be exactly 0, and a zero difference says nothing about the numbers
 * underneath it.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------------------
// 1. STATIC — the migration files are the artifact a human reads. Assert they
//    still declare the posture they claim, so a later edit cannot quietly drop
//    a REVOKE or a COMMENT and still look finished.
// ---------------------------------------------------------------------------

const VIEWS = [
  'view_ops_ledger_campaign_span',
  'view_ops_ledger_shift',
  'view_ops_ledger_day',
  'view_ops_ledger_day_grade',
  'view_ops_ledger_day_block',
  'view_ops_ledger_day_blocks_used',
  'view_ops_ledger_campaign_grades',
  'view_ops_ledger_campaign_kpis',
] as const;

const VERIFY_FNS = [
  { name: 'fn_ops_ledger_verify_campaign', sig: 'text' },
  { name: 'fn_ops_ledger_verify_group', sig: 'text\\[\\]' },
  { name: 'fn_ops_ledger_verify_posture', sig: '' },
] as const;

function migrationSource(suffix: string): string {
  const dir = resolve(process.cwd(), 'supabase/migrations');
  const file = readdirSync(dir).find((f) => f.endsWith(suffix));
  assert.ok(file, `no migration file ending in ${suffix}`);
  return readFileSync(resolve(dir, file), 'utf8');
}

/**
 * Strip `--` comment lines. The ledger migration legitimately NAMES the two
 * retired probes in the note that records why they were removed, so a bare
 * `includes()` would fail on the explanation itself. What must be gone is the
 * executable SQL, so that is what is tested.
 */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .map((l) => (l.trimStart().startsWith('--') ? '' : l))
    .join('\n');
}

function staticChecks(): void {
  const sql = migrationSource('_ops_ledger.sql');
  const verifySql = migrationSource('_ops_ledger_verify_per_campaign.sql');

  for (const v of VIEWS) {
    check(`${v} — created, commented, invoker, granted, anon revoked`, () => {
      assert.ok(sql.includes(`create or replace view public.${v} as`), `${v} is not created`);
      assert.ok(sql.includes(`comment on view public.${v} is`), `${v} has no COMMENT`);
      assert.ok(
        sql.includes(`alter view public.${v}`) && sql.includes('security_invoker = true'),
        `${v} is not security_invoker`,
      );
      assert.ok(
        new RegExp(`grant select on public\\.${v}\\s+to authenticated;`).test(sql),
        `${v} is not granted to authenticated`,
      );
      assert.ok(
        new RegExp(`revoke all on public\\.${v}\\s+from public, anon;`).test(sql),
        `${v} does not revoke anon`,
      );
      assert.ok(
        !new RegExp(`grant select on public\\.${v}[^;]*service_role`).test(sql),
        `${v} must NOT be granted to service_role — the worker reads none of these`,
      );
    });
  }

  check('fn_ops_ledger_group_kpis — invoker, search_path pinned, authenticated only', () => {
    assert.ok(sql.includes('create or replace function public.fn_ops_ledger_group_kpis(p_campaign_keys text[])'));
    assert.ok(sql.includes('security invoker'), 'the group RPC must be SECURITY INVOKER');
    assert.ok(sql.includes('set search_path = public'), 'search_path must be pinned');
    assert.ok(sql.includes('revoke execute on function public.fn_ops_ledger_group_kpis(text[]) from public, anon;'));
    assert.ok(sql.includes('grant  execute on function public.fn_ops_ledger_group_kpis(text[]) to authenticated;'));
    assert.ok(
      !/grant\s+execute on function public\.fn_ops_ledger_group_kpis\(text\[\]\) to service_role/.test(sql),
      'the group RPC must not be granted to service_role',
    );
  });

  check('the WHOLE-HISTORY probes are gone from the ledger migration (2026-09-14 incident)', () => {
    const exec = executableSql(sql);
    assert.ok(
      !/fn_ops_ledger_verify\s*\(\s*\)/.test(exec),
      'fn_ops_ledger_verify() is back in the ledger migration — it OOM-ed the instance and took the site down',
    );
    assert.ok(
      !exec.includes('fn_ops_ledger_verify_groups'),
      'fn_ops_ledger_verify_groups is back — it called the group RPC 32 times in one statement',
    );
    // …and the file still SAYS why, so a reader does not reinvent them.
    assert.ok(sql.includes('20260914064415_drop_fn_ops_ledger_verify.sql'), 'the removal note is missing');
    assert.ok(sql.includes('_ops_ledger_verify_per_campaign.sql'), 'the note does not point at the replacement');
  });

  check('the replacement probes — 3 functions, SECURITY DEFINER, service_role ONLY', () => {
    for (const { name, sig } of VERIFY_FNS) {
      assert.ok(
        new RegExp(`create or replace function public\\.${name}\\(`).test(verifySql),
        `${name} is not declared`,
      );
      assert.ok(
        new RegExp(`comment on function public\\.${name}\\(${sig}\\) is`).test(verifySql),
        `${name} has no COMMENT`,
      );
      assert.ok(
        new RegExp(`revoke execute on function public\\.${name}\\(${sig}\\)\\s+from public, anon, authenticated;`).test(verifySql),
        `${name} is not revoked from public/anon/authenticated`,
      );
      assert.ok(
        new RegExp(`grant execute on function public\\.${name}\\(${sig}\\)\\s+to service_role;`).test(verifySql),
        `${name} is not granted to service_role`,
      );
      assert.ok(
        !new RegExp(`grant execute on function public\\.${name}\\(${sig}\\)\\s+to authenticated`).test(verifySql),
        `${name} must never be granted to authenticated — it is SECURITY DEFINER over authenticated-only views`,
      );
    }
    assert.equal(
      (verifySql.match(/^security definer$/gm) ?? []).length,
      3,
      'all three probes must be SECURITY DEFINER',
    );
    assert.equal(
      (verifySql.match(/^set search_path = public$/gm) ?? []).length,
      3,
      'all three probes must pin search_path',
    );
  });

  check('the group probe is CAPPED, so it cannot be pointed at all history', () => {
    assert.ok(
      /array_length\(v_keys, 1\) > 12/.test(verifySql),
      'fn_ops_ledger_verify_group must refuse more than 12 campaign keys',
    );
    // and the per-campaign probe must filter on the two base columns, not on the
    // computed campaign_key — that pushdown is what keeps each call in the tens
    // of milliseconds.
    assert.ok(
      /where dd\.production_batch = v_batch and dd\.campaign_year = v_year/.test(verifySql),
      'the per-campaign probe must filter on production_batch + campaign_year',
    );
  });

  check('the WASTE migration re-grants the group function it DROPped (L-044)', () => {
    // A function whose RETURNS TABLE changes cannot be CREATE OR REPLACEd, so the
    // waste migration DROPs and re-CREATEs fn_ops_ledger_group_kpis — which LOSES
    // its grants. The re-grant must live in the SAME file, and the live half
    // below proves the three has_function_privilege answers for real.
    const wasteSql = migrationSource('_ops_ledger_campaign_waste.sql');
    assert.ok(
      wasteSql.includes('drop function if exists public.fn_ops_ledger_group_kpis(text[]);'),
      'the waste migration must DROP the group function before re-creating it',
    );
    assert.ok(
      wasteSql.includes('revoke execute on function public.fn_ops_ledger_group_kpis(text[]) from public, anon;'),
      'the re-created group function is not revoked from public/anon',
    );
    assert.ok(
      wasteSql.includes('grant  execute on function public.fn_ops_ledger_group_kpis(text[]) to authenticated;'),
      'the re-created group function is not granted back to authenticated',
    );
    assert.ok(
      !/grant\s+execute on function public\.fn_ops_ledger_group_kpis\(text\[\]\) to service_role/.test(wasteSql),
      'the group RPC must not be granted to service_role',
    );
    // ...and every one of the nine waste kg columns must be on BOTH grains.
    for (const col of ['trml1_kg', 'trml2_kg', 'rs1a_kg', 'rs1b_kg', 'rs23_kg', 'rs5_kg', 'bf_kg', 'grit_kg', 'waste_kg']) {
      assert.ok(wasteSql.includes(`w.${col},`), `the campaign view does not append ${col}`);
      assert.ok(wasteSql.includes(`a.${col},`), `the group function does not sum ${col}`);
    }
    assert.ok(wasteSql.includes('waste_loss_pct'), 'waste_loss_pct is missing');
    assert.ok(wasteSql.includes('waste_shift_count'), 'waste_shift_count is missing');
  });

  check('EVERY migration that CREATE OR REPLACEs a ledger view re-asserts security_invoker', () => {
    // THE TRAP, hit twice on this exact view: `CREATE OR REPLACE VIEW` keeps the
    // GRANTS but RESETS `reloptions`, so a view declared security_invoker in an
    // earlier migration silently reverts to running as its OWNER. 20260914065558
    // repaired it the first time; the waste migration knocked it off again and
    // 20260915021924 repaired it the second. A grant check cannot see this — only
    // pg_options_to_table can, which is what the live posture probe does.
    //
    // The static guard: for each migration that replaces a ledger view, that file
    // or a LATER one must set security_invoker back on for that view.
    const dir = resolve(process.cwd(), 'supabase/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const replaced: { version: string; view: string }[] = [];
    const restored: { version: string; view: string }[] = [];
    for (const f of files) {
      const body = readFileSync(resolve(dir, f), 'utf8');
      for (const v of VIEWS) {
        if (new RegExp(`create or replace view public\\.${v} as`).test(body)) {
          replaced.push({ version: f, view: v });
        }
        if (
          new RegExp(`alter view public\\.${v}\\s+set \\(security_invoker = true\\)`).test(body) ||
          new RegExp(`alter view public\\.${v} set \\(security_invoker = true\\)`).test(body)
        ) {
          restored.push({ version: f, view: v });
        }
      }
    }
    assert.ok(replaced.length > 0, 'no migration creates a ledger view — the scan is broken');
    for (const r of replaced) {
      assert.ok(
        restored.some((x) => x.view === r.view && x.version >= r.version),
        `${r.version} CREATE OR REPLACEs ${r.view} and nothing at or after it re-asserts security_invoker — ` +
          'CREATE OR REPLACE VIEW RESETS reloptions',
      );
    }
  });

  check('the ₱ columns are NAMED in the COMMENTs that carry them', () => {
    // A view that carries money must say so in its own comment, so a future
    // server action cannot claim it did not know what to null.
    for (const v of ['view_ops_ledger_day', 'view_ops_ledger_campaign_kpis']) {
      const at = sql.indexOf(`comment on view public.${v} is`);
      const body = sql.slice(at, sql.indexOf("';", at));
      assert.ok(body.includes('₱'), `${v}'s comment must name its ₱ columns`);
      assert.ok(body.includes('canViewPrices'), `${v}'s comment must name the gate`);
    }
  });

  check('the adapter strips ₱ before the payload leaves the server', () => {
    const adapter = readFileSync(resolve(process.cwd(), 'lib/operations/queries.ts'), 'utf8');
    assert.ok(adapter.includes("import 'server-only'"), 'the adapter must be server-only');
    assert.ok(adapter.includes('await canViewPrices()'), 'the adapter must resolve the canonical gate');
    // Every ₱ field must be written as `showPrices ? … : null`.
    for (const field of [
      'fedPhpKg',
      'fedValuePhp',
      'actualFedPhpKg',
      'campaignWeightedActualFedPhpKg',
      'upliftPhpKg',
      'phpPerProducedKgDelivered',
      'phpPerProducedKgTrue',
      'phpPerProducedKgTrueCovered',
    ]) {
      assert.ok(
        new RegExp(`${field}:\\s*showPrices`).test(adapter),
        `${field} is not gated on showPrices in lib/operations/queries.ts`,
      );
    }
  });

  check('the adapter does no arithmetic (CLAUDE.md: never aggregate in TypeScript)', () => {
    const adapter = readFileSync(resolve(process.cwd(), 'lib/operations/queries.ts'), 'utf8');
    const code = adapter
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n');
    assert.ok(!/\.reduce\(/.test(code), 'a reduce() in the adapter means a total moved out of SQL');
    assert.ok(!/\breturn[^\n]*\b\w+\s*\+\s*\w+/.test(code), 'no summing in the adapter');
  });
}

// ---------------------------------------------------------------------------
// 2. LIVE — the three probes, plus a real read as anon and as service_role
// ---------------------------------------------------------------------------

/** Read NEXT_PUBLIC_SUPABASE_URL / keys from env or .env.local. */
function readEnv(): { url: string; service: string; anon: string } | null {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  let service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  let anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !service || !anon) {
    try {
      const txt = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
      for (const line of txt.split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!m) continue;
        const value = m[2].replace(/^["']|["']$/g, '');
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

type Probe = Record<string, number | boolean | string | string[] | null>;

/** No probe may ever return a ₱ VALUE. Gaps, counts and flags only. */
const MONEY_NAMED_BUT_NOT_MONEY = new Set([
  'gap_fed_rate',
  'gap_pc_rate',
  'kpi_vs_batch_cost_mismatch',
  'kpi_without_batch_cost_row',
  'money_named_in_peso_free_views',
  'money_named_in_day_view',
  'true_pc_cost_is_null',
  'true_pc_cost_covered_present',
  'campaigns_fully_covered',
]);

function assertNoMoneyValue(p: Probe, where: string): void {
  for (const k of Object.keys(p)) {
    if (!/php|peso|price|cost|value|amount|rate/i.test(k)) continue;
    assert.ok(MONEY_NAMED_BUT_NOT_MONEY.has(k), `${where}: key ${k} looks like it carries money`);
  }
}

/** The per-campaign budget. A call slower than this is a FAILURE, not a slow day. */
const CAMPAIGN_MS_BUDGET = 5_000;

const CAMPAIGN_MISMATCH_KEYS = [
  'grade_fold_mismatch',
  'block_fold_mismatch',
  'shift_produced_mismatch',
  'shift_downtime_mismatch',
  'day_totals_vs_kpi_mismatch',
  'campaign_grade_fold_mismatch',
  'ledger_days_vs_span_mismatch',
  // WASTE (2026-09-15). The campaign KPI row folds view_ops_ledger_shift and the
  // day spine folds the same view, so the EOQ "Waste Loss" cell and the LOSSES
  // lens footer are one arithmetic at two grains. The per-stream key is a COUNT
  // of streams that differ (0..8), because a total can agree while two streams
  // are swapped.
  'waste_fold_mismatch',
  'waste_stream_fold_mismatch',
  'kpi_vs_batch_cost_mismatch',
  'kpi_vs_production_by_batch_mismatch',
  'kpi_without_batch_cost_row',
  'single_campaign_group_mismatch',
] as const;

async function liveChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });

  const n = (p: Probe, k: string): number => {
    const v = p[k];
    assert.ok(v !== null && v !== undefined, `probe key ${k} is missing`);
    return Number(v);
  };

  // --- (a) posture, proven by assuming the role and actually reading ---
  const anonRead = await anon.from('view_ops_ledger_day').select('campaign_key').limit(1);
  check('anon CANNOT read view_ops_ledger_day (a real read, not a grant lookup)', () => {
    assert.ok(anonRead.error, 'anon was able to read the ledger — the REVOKE is gone');
  });

  const svcRead = await svc.from('view_ops_ledger_day').select('campaign_key').limit(1);
  check('service_role CANNOT read view_ops_ledger_day (the worker reads none of these)', () => {
    assert.ok(svcRead.error, 'service_role can read the ledger — an unintended grant appeared');
  });

  // --- (b) the catalog posture probe (also hands us the campaign list) ---
  const postureRes = await svc.rpc('fn_ops_ledger_verify_posture');
  assert.ok(!postureRes.error, `fn_ops_ledger_verify_posture failed: ${postureRes.error?.message}`);
  const posture = postureRes.data as unknown as Probe;
  assert.ok(
    posture && typeof posture === 'object',
    'the posture probe returned nothing — an empty probe is a FAILURE, not a pass',
  );
  assertNoMoneyValue(posture, 'posture');

  check('posture: 8 views, all security_invoker, all commented, all authenticated', () => {
    assert.equal(n(posture, 'view_count'), 8);
    assert.equal(n(posture, 'not_security_invoker'), 0);
    assert.equal(n(posture, 'missing_authenticated_select'), 0);
    assert.equal(n(posture, 'views_without_comment'), 0);
    assert.equal(n(posture, 'anon_can_select'), 0);
    assert.equal(n(posture, 'service_role_can_select'), 0);
  });
  check('posture: the group RPC is authenticated-only', () => {
    assert.equal(posture.fn_authenticated_execute, true);
    assert.equal(posture.fn_anon_execute, false);
    assert.equal(posture.fn_service_role_execute, false);
    assert.equal(posture.fn_group_authenticated_execute, true);
    assert.equal(posture.fn_group_anon_execute, false);
    assert.equal(posture.fn_group_service_role_execute, false);
  });
  check('posture: all THREE verify probes are service_role-only (never authenticated, never anon)', () => {
    assert.equal(n(posture, 'verify_fn_count'), 3);
    assert.equal(posture.verify_fns_service_role_only, true);
  });
  check('posture: the WHOLE-HISTORY probes no longer exist in the database', () => {
    // fn_ops_ledger_verify() OOM-ed the instance on 2026-09-14 and took the live
    // site down. Zero here is what keeps it from coming back by accident.
    assert.equal(n(posture, 'legacy_verify_fn_count'), 0);
  });
  check('money: the five peso-free views carry NO money-named column', () =>
    assert.equal(n(posture, 'money_named_in_peso_free_views'), 0));
  check('money: view_ops_ledger_day carries EXACTLY ONE (fed_php_kg)', () =>
    assert.equal(n(posture, 'money_named_in_day_view'), 1));

  const campaignKeys = posture.campaign_keys as string[];
  assert.ok(Array.isArray(campaignKeys) && campaignKeys.length > 0, 'the posture probe returned no campaign keys');
  check('shape: the ledger spans 32 campaigns', () => assert.equal(campaignKeys.length, 32));

  // --- (c) ONE CAMPAIGN PER CALL, STRICTLY SEQUENTIALLY. Never Promise.all: the
  //     point of the per-campaign split is that only one of these reads is in
  //     flight at any moment.
  console.log('\n  per-campaign (one RPC call each, sequential) ------------------');
  console.log(`    ${'campaign'.padEnd(18)}${'days'.padStart(6)}${'rest'.padStart(6)}${'ms'.padStart(8)}`);
  let slowest = 0;
  let slowestKey = '';
  let totalMs = 0;
  let totalDays = 0;
  let totalRest = 0;

  for (const key of campaignKeys) {
    const t0 = Date.now();
    const res = await svc.rpc('fn_ops_ledger_verify_campaign', { p_campaign_key: key });
    const ms = Date.now() - t0;
    assert.ok(!res.error, `fn_ops_ledger_verify_campaign(${key}) failed: ${res.error?.message}`);
    const p = res.data as unknown as Probe;
    assert.ok(p && typeof p === 'object', `the probe returned nothing for ${key} — that is a FAILURE, not a pass`);
    assertNoMoneyValue(p, key);

    totalMs += ms;
    totalDays += n(p, 'day_rows');
    totalRest += n(p, 'rest_days');
    if (ms > slowest) {
      slowest = ms;
      slowestKey = key;
    }

    check(
      `${key.padEnd(18)}${String(n(p, 'day_rows')).padStart(6)}${String(n(p, 'rest_days')).padStart(6)}${String(ms).padStart(8)}`,
      () => {
        assert.equal(p.campaign_key, key, 'the probe answered about a different campaign');
        for (const k of CAMPAIGN_MISMATCH_KEYS) assert.equal(n(p, k), 0, `${key}: ${k} is not 0`);
        assert.equal(n(p, 'day_rows'), n(p, 'span_days'), `${key}: the day spine is not the campaign span`);
        assert.ok(
          ms < CAMPAIGN_MS_BUDGET,
          `${key}: the probe took ${ms} ms, over the ${CAMPAIGN_MS_BUDGET} ms budget — the 2026-09-14 shape is back`,
        );
      },
    );
  }

  console.log(
    `\n    ${campaignKeys.length} campaigns · ${totalDays} ledger days · ${totalRest} rest days · ` +
      `${totalMs} ms total · slowest ${slowestKey} ${slowest} ms`,
  );

  // --- (d) the GROUP proof, Q3 2026 ---
  console.log('\n  group -------------------------------------------------------');
  const q3Res = await svc.rpc('fn_ops_ledger_verify_group', {
    p_campaign_keys: ['JULY-2026', 'AUGUST-2026', 'SEPTEMBER-2026'],
  });
  assert.ok(!q3Res.error, `fn_ops_ledger_verify_group(Q3) failed: ${q3Res.error?.message}`);
  const q3 = q3Res.data as unknown as Probe;
  assert.ok(q3 && typeof q3 === 'object', 'the group probe returned nothing — a FAILURE, not a pass');
  assertNoMoneyValue(q3, 'Q3 2026');

  check('group Q3 2026: the probe returns no ₱ VALUE — the gaps really are zero', () => {
    assert.equal(n(q3, 'gap_fed_rate'), 0);
    assert.equal(n(q3, 'gap_pc_rate'), 0);
  });
  for (const k of ['gap_yield', 'gap_fed_rate', 'gap_pc_rate', 'gap_fed_kg', 'gap_produced_kg', 'gap_waste_kg']) {
    check(`group Q3 2026: ${k} === 0`, () => assert.equal(n(q3, k), 0));
  }
  check('group Q3 2026: WASTE is reported by every campaign, so the ratio is honest', () => {
    // waste_loss_pct is weighted by the fed kilos of the campaigns that actually
    // FILED waste, not by the group's whole fed total. When every campaign filed,
    // the two denominators coincide — which is the Q3 case, and saying so is what
    // makes the number readable rather than merely present.
    assert.equal(n(q3, 'campaigns_waste_reported'), n(q3, 'campaign_count'));
    assert.equal(q3.waste_loss_pct_present, true);
    assert.ok(n(q3, 'waste_shift_count') > 0, 'no shift filed a waste row in Q3 — that would be news');
  });
  check('group Q3 2026: 3 campaigns, 2 of them fully covered, none missing', () => {
    assert.equal(n(q3, 'campaign_count'), 3);
    assert.equal(n(q3, 'campaigns_fully_covered'), 2);
    assert.equal(n(q3, 'campaigns_missing_count'), 0);
  });
  check('group Q3 2026: TRUE PC COST is strict NULL, with the covered partial beside it', () => {
    assert.equal(q3.true_pc_cost_is_null, true);
    assert.equal(q3.true_pc_cost_covered_present, true);
  });
  check(
    `group Q3 2026: blocks are de-duplicated (${n(q3, 'blocks_distinct')} distinct vs ` +
      `${n(q3, 'blocks_campaign_sum')} campaign-sum)`,
    () => {
      // SEPTEMBER 2026 IS STILL RUNNING, so the absolute counts grow every week
      // (45/50 on 2026-09-14, 46/51 on 2026-09-15). Freezing them makes this
      // script fail on the calendar rather than on a regression, so what is
      // asserted is the STRUCTURAL fact instead: exactly 5 of Q3's blocks were
      // fed by two campaigns, so the naive sum exceeds the distinct count by 5,
      // and neither count may ever go backwards from the 2026-09-14 baseline.
      assert.ok(
        n(q3, 'blocks_distinct') < n(q3, 'blocks_campaign_sum'),
        'the de-duplicated block count must be smaller — 5 Q3 blocks were fed by two campaigns',
      );
      assert.equal(n(q3, 'blocks_campaign_sum') - n(q3, 'blocks_distinct'), 5);
      assert.ok(n(q3, 'blocks_distinct') >= 45, 'the Q3 block set shrank — blocks are never un-fed');
    },
  );
  check('group Q3 2026: the changeover surplus is real (campaign-days > calendar-days)', () =>
    assert.equal(n(q3, 'changeover_surplus'), 2));
  check(
    `group Q3 2026: ${n(q3, 'ledger_days')} ledger days = ${n(q3, 'active_days')} active + ` +
      `${n(q3, 'rest_days')} rest`,
    () => {
      // Same reason as the block counts: SEPTEMBER 2026 is open, so its span grows
      // by a day every day (77/63/14 on 2026-09-14). The INVARIANT is the split
      // being exhaustive and the span never shrinking.
      assert.equal(n(q3, 'active_days') + n(q3, 'rest_days'), n(q3, 'ledger_days'));
      assert.ok(n(q3, 'ledger_days') >= 77, 'the Q3 ledger span shrank — a campaign never loses days');
      assert.ok(n(q3, 'rest_days') >= 14, 'the Q3 rest-day count shrank');
    },
  );

  // --- (e) an unknown key is REPORTED, never silently dropped ---
  const missRes = await svc.rpc('fn_ops_ledger_verify_group', { p_campaign_keys: ['NOPE-1999'] });
  assert.ok(!missRes.error, `fn_ops_ledger_verify_group(NOPE-1999) failed: ${missRes.error?.message}`);
  const miss = missRes.data as unknown as Probe;
  check('group: an unknown key is REPORTED in campaigns_missing, never dropped', () => {
    assert.equal(n(miss, 'campaigns_missing_count'), 1);
    assert.equal(n(miss, 'campaign_count'), 0);
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('verify-ops-ledger\n');
  console.log('  static ------------------------------------------------------');
  staticChecks();

  const env = readEnv();
  if (!env) {
    console.log('\n  SKIPPED the live half — no Supabase credentials in env or .env.local.');
    console.log(`\n  ${passed} assertions passed (static only).`);
    return;
  }
  console.log('\n  live --------------------------------------------------------');
  await liveChecks(env);
  console.log(`\n  ${passed} assertions passed.`);
}

main().catch((err) => {
  console.error(`\n  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
