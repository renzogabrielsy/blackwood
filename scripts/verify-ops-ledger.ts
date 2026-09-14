/**
 * verify-ops-ledger.ts — the proofs behind the PLANT OPERATIONS LEDGER data layer.
 *
 * Run: npx tsx scripts/verify-ops-ledger.ts
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
 *   REUSE      every price / yield / coverage column on the campaign KPI row is
 *              `IS DISTINCT FROM`-identical to view_analytics_batch_cost, and
 *              every production column to view_analytics_production_by_batch
 *   GROUP      a ONE-campaign group equals that campaign's row exactly, on all
 *              32 campaigns; and the Q3 2026 group's yield, fed rate and PC cost
 *              equal a direct Σproduced/Σfed, Σvalue/Σfed and Σvalue/Σproduced
 *   POSTURE    all 8 views security_invoker, authenticated SELECT, anon DENIED,
 *              service_role DENIED — and the denial is proven by a REAL READ,
 *              not by reading the grant table (the L-043 lesson: a permission
 *              claim is proven by assuming the victim's role)
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
 * `public.fn_ops_ledger_verify()` is that door: SECURITY DEFINER, STABLE,
 * service_role EXECUTE only — the same idiom as `canonical_supplier_batch_probe`
 * and `fn_audit_trigger_function_grants`. It returns NO ₱ VALUE: every
 * money-derived check is published as a GAP that must be exactly 0, and a zero
 * difference says nothing about the numbers underneath it.
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
// 1. STATIC — the migration file is the artifact a human reads. Assert it still
//    declares the posture it claims, so a later edit cannot quietly drop a
//    REVOKE or a COMMENT and still look finished.
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

function migrationSource(): string {
  const dir = resolve(process.cwd(), 'supabase/migrations');
  const file = readdirSync(dir).find((f) => f.endsWith('_ops_ledger.sql'));
  assert.ok(file, 'the ops_ledger migration file is missing from supabase/migrations');
  return readFileSync(resolve(dir, file), 'utf8');
}

function staticChecks(): void {
  const sql = migrationSource();

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

  check('fn_ops_ledger_verify — definer probe, service_role only, never authenticated', () => {
    assert.ok(sql.includes('create or replace function public.fn_ops_ledger_verify()'));
    assert.ok(sql.includes('security definer'), 'the probe must be SECURITY DEFINER to see the views at all');
    assert.ok(sql.includes('revoke execute on function public.fn_ops_ledger_verify() from public, anon, authenticated;'));
    assert.ok(sql.includes('grant execute on function public.fn_ops_ledger_verify() to service_role;'));
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
// 2. LIVE — the probe, plus a real read as anon and as service_role
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

type Probe = Record<string, number | boolean | null>;

async function liveChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });

  // --- the posture half, proven by assuming the role and actually reading ---
  const anonRead = await anon.from('view_ops_ledger_day').select('campaign_key').limit(1);
  check('anon CANNOT read view_ops_ledger_day (a real read, not a grant lookup)', () => {
    assert.ok(anonRead.error, 'anon was able to read the ledger — the REVOKE is gone');
  });

  const svcRead = await svc.from('view_ops_ledger_day').select('campaign_key').limit(1);
  check('service_role CANNOT read view_ops_ledger_day (the worker reads none of these)', () => {
    assert.ok(svcRead.error, 'service_role can read the ledger — an unintended grant appeared');
  });

  // --- the numbers ---
  const { data, error } = await svc.rpc('fn_ops_ledger_verify');
  assert.ok(!error, `fn_ops_ledger_verify failed: ${error?.message}`);
  const p = data as unknown as Probe;
  assert.ok(p && typeof p === 'object', 'the probe returned nothing — an empty probe is a FAILURE, not a pass');
  if (process.env.OPS_LEDGER_DUMP) {
    for (const k of Object.keys(p).sort()) console.log(`    ${k.padEnd(38)} ${p[k]}`);
  }

  const n = (k: string): number => {
    const v = p[k];
    assert.ok(v !== null && v !== undefined, `probe key ${k} is missing`);
    return Number(v);
  };

  // The probe reads ₱-bearing views. Nothing it RETURNS may be a ₱ value: the
  // only money-derived keys are gaps (0 by construction), counts of money-named
  // COLUMNS, and booleans about nullness. Anything new with a money-ish name has
  // to be added here deliberately, which is the point.
  const MONEY_NAMED_BUT_NOT_MONEY = new Set([
    'q3_gap_fed_rate',
    'q3_gap_pc_rate',
    'kpi_vs_batch_cost_mismatch',
    'kpi_without_batch_cost_row',
    'money_named_in_peso_free_views',
    'money_named_in_day_view',
    'q3_true_pc_cost_is_null',
    'q3_true_pc_cost_covered_present',
    'q3_campaigns_fully_covered',
  ]);
  check('the probe returns no ₱ VALUE — every money-named key is a gap, a count or a flag', () => {
    for (const k of Object.keys(p)) {
      if (!/php|peso|price|cost|value|amount|rate/i.test(k)) continue;
      assert.ok(MONEY_NAMED_BUT_NOT_MONEY.has(k), `probe key ${k} looks like it carries money`);
    }
    // and the gaps really are zero, so they carry no information about the values
    assert.equal(Number(p.q3_gap_fed_rate), 0);
    assert.equal(Number(p.q3_gap_pc_rate), 0);
  });

  // FOLDS
  for (const k of [
    'grade_fold_mismatch',
    'block_fold_mismatch',
    'shift_produced_mismatch',
    'shift_downtime_mismatch',
    'day_totals_vs_kpi_mismatch',
    'campaign_grade_fold_mismatch',
    'ledger_days_vs_span_mismatch',
  ]) {
    check(`fold: ${k} === 0`, () => assert.equal(n(k), 0));
  }

  // REUSE
  for (const k of [
    'kpi_vs_batch_cost_mismatch',
    'kpi_vs_production_by_batch_mismatch',
    'kpi_without_batch_cost_row',
  ]) {
    check(`reuse: ${k} === 0`, () => assert.equal(n(k), 0));
  }

  // GROUP
  check('group: a ONE-campaign group equals that campaign\'s row, on every campaign', () =>
    assert.equal(n('single_campaign_group_mismatch'), 0));
  check('group: an unknown key is REPORTED in campaigns_missing, never dropped', () =>
    assert.equal(n('unknown_key_reported'), 1));
  for (const k of ['q3_gap_yield', 'q3_gap_fed_rate', 'q3_gap_pc_rate', 'q3_gap_fed_kg', 'q3_gap_produced_kg']) {
    check(`group Q3 2026: ${k} === 0`, () => assert.equal(n(k), 0));
  }
  check('group Q3 2026: 3 campaigns, 2 of them fully covered', () => {
    assert.equal(n('q3_campaign_count'), 3);
    assert.equal(n('q3_campaigns_fully_covered'), 2);
  });
  check('group Q3 2026: TRUE PC COST is strict NULL, with the covered partial beside it', () => {
    assert.equal(p.q3_true_pc_cost_is_null, true);
    assert.equal(p.q3_true_pc_cost_covered_present, true);
  });
  check('group Q3 2026: blocks are de-duplicated (45 distinct vs 50 campaign-sum)', () => {
    assert.ok(n('q3_blocks_distinct') < n('q3_blocks_campaign_sum'),
      'the de-duplicated block count must be smaller — 5 Q3 blocks were fed by two campaigns');
    assert.equal(n('q3_blocks_distinct'), 45);
    assert.equal(n('q3_blocks_campaign_sum'), 50);
  });
  check('group Q3 2026: the changeover surplus is real (campaign-days > calendar-days)', () =>
    assert.equal(n('q3_changeover_surplus'), 2));
  check('group Q3 2026: 77 ledger days = 63 active + 14 rest', () => {
    assert.equal(n('q3_ledger_days'), 77);
    assert.equal(n('q3_active_days'), 63);
    assert.equal(n('q3_rest_days'), 14);
    assert.equal(n('q3_active_days') + n('q3_rest_days'), n('q3_ledger_days'));
  });

  // POSTURE (the catalog half — the read half is above)
  check('posture: 8 views, all security_invoker, all commented, all authenticated', () => {
    assert.equal(n('view_count'), 8);
    assert.equal(n('not_security_invoker'), 0);
    assert.equal(n('missing_authenticated_select'), 0);
    assert.equal(n('views_without_comment'), 0);
    assert.equal(n('anon_can_select'), 0);
    assert.equal(n('service_role_can_select'), 0);
  });
  check('posture: the group RPC is authenticated-only', () => {
    assert.equal(p.fn_authenticated_execute, true);
    assert.equal(p.fn_anon_execute, false);
    assert.equal(p.fn_service_role_execute, false);
  });

  // MONEY
  check('money: the five peso-free views carry NO money-named column', () =>
    assert.equal(n('money_named_in_peso_free_views'), 0));
  check('money: view_ops_ledger_day carries EXACTLY ONE (fed_php_kg)', () =>
    assert.equal(n('money_named_in_day_view'), 1));

  // SHAPE / ROW BUDGETS — recorded so a future change that blows past
  // PostgREST's 1000-row cap fails here instead of in production.
  check('row budget: no lens exceeds 1000 rows for a single campaign', () => {
    assert.ok(n('max_day_rows_per_campaign') <= 1000);
    assert.ok(n('max_day_block_rows_per_campaign') <= 1000);
    assert.ok(n('max_day_grade_rows_per_campaign') <= 1000);
  });
  check('shape: the day spine has 32 campaigns and a non-empty set of rest days', () => {
    assert.equal(n('day_campaigns'), 32);
    assert.equal(n('kpi_rows'), 32);
    assert.equal(n('span_rows'), 32);
    assert.ok(n('rest_days') > 0, 'a ledger with no rest-day rows has dropped the blank Sundays');
    assert.equal(n('ledger_days_total'), n('day_rows'));
  });

  console.log('\n  measured ------------------------------------------------------');
  for (const k of [
    'day_rows', 'rest_days', 'max_span_days', 'shift_rows', 'day_grade_rows',
    'day_block_rows', 'blocks_used_rows', 'campaign_grade_rows',
    'max_day_rows_per_campaign', 'max_day_block_rows_per_campaign', 'max_day_grade_rows_per_campaign',
  ]) {
    console.log(`    ${k.padEnd(34)} ${p[k]}`);
  }
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
