/**
 * verify-blocking-supplier-lens.ts — the proofs behind the BLOCKING SUPPLIER LENS.
 *
 * Run: npx tsx scripts/verify-blocking-supplier-lens.ts
 *
 * ============================================================================
 * WHAT THE FEATURE IS, AND WHAT CAN GO WRONG WITH IT
 * ============================================================================
 * The THIRD lens on the Blocking grid (migration `20260922011759_blocking_supplier_lens`),
 * sibling of the price and age lenses: tint every occupied block by WHOSE charcoal it
 * holds, with a ratio of the yard per supplier. Bands are the top N suppliers (default 6)
 * plus one `others` fold.
 *
 * Almost nothing here is a new number — supplier identity and the ALL/SOME rule live in
 * `view_blocking_block_suppliers`, dominance lives in `fn_blend_block_facts`, and a
 * block's balance in `view_blocking_grid` — so the failure modes worth testing are the
 * ones this codebase keeps meeting:
 *
 *   ONE DEFINITION  a lens that re-derives "who a supplier is", "is this block mixed" or
 *                   "which supplier is the biggest" slightly differently from the
 *                   relations that own those rules, so the grid tint, the supplier SEARCH
 *                   and the blend modal's green/orange disagree about the same block.
 *                   PROVEN three ways: per-block supplier kilograms and shares against
 *                   the view on EVERY block, `isMixed` against the view's own
 *                   `supplier_count_in_block > 1`, and the dominant supplier against
 *                   `fn_blend_block_facts` on EVERY batch — each requiring 0 mismatches.
 *   FOLDS           bands that do not add up to the yard. PROVEN: Σ dominantBlockCount +
 *                   unattributed = total, Σ dominantKg + unattributed = total.kg with gap
 *                   exactly 0, Σ apportionedKg likewise, both share families summing to
 *                   100, and the whole population equal to the PRICE and AGE lenses' —
 *                   the three lenses must describe ONE yard.
 *   TWO KILOGRAM    the genuinely new hazard here. `dominantKg` (what the TINT shows) and
 *   FAMILIES        `apportionedKg` (what the RATIO BAR shows) are different numbers, and
 *                   a UI that mixes them would misreport the yard. PROVEN: both fold to
 *                   total.kg independently, `apportionedDeliveredKg` folds to the grid's
 *                   `total_in` instead, and a supplier that dominates NOTHING is shown to
 *                   carry real apportioned kilos beside a dominant 0.
 *   NULL ≠ 0        an unattributed block folded into `others`, which would assert a
 *                   supplier we do not have. PROVEN: it is in NO band, out of both
 *                   denominators, and absent from both per-cell maps.
 *   POSTURE         the grants, PROVEN by ASSUMING THE VICTIM'S ROLE and really calling
 *                   the function (L-043's lesson), not by reading the grant table.
 *   THE MISSING     …and the one that is specific to the non-price lenses: somebody
 *   GATE            "fixing" the asymmetry with the price lens by adding a
 *                   `canViewPrices()` gate. There is no money in this payload, so a gate
 *                   would hide a supplier figure from Production — the one role that walks
 *                   the yard. This script asserts the gate's ABSENCE, and asserts that no
 *                   key anywhere in the payload is money-named.
 *
 * ============================================================================
 * WHY THE NUMBERS COME FROM A PROBE RPC AND NOT FROM DIRECT CALLS
 * ============================================================================
 * `fn_blocking_supplier_lens` is `authenticated`-only BY DESIGN (`anon` revoked,
 * `service_role` deliberately NOT granted so `verify-worker-view-grants` stays at 4 views
 * / 0 findings), and no verify script in this repo holds a user JWT. So the only key this
 * script has cannot call it — which is the point of the grant, and is exactly what
 * `fn_blocking_price_lens_probe`, `fn_blocking_age_lens_probe` and
 * `fn_blend_block_facts_probe` solved. `fn_blocking_supplier_lens_probe()` is that door.
 *
 * THE PROBE ASSERTS NOTHING. It calls the lens a fixed number of times, recomputes the
 * grid's totals and the per-supplier yard aggregation INDEPENDENTLY, reads
 * `view_blocking_block_suppliers` and `fn_blend_block_facts`, and hands everything back —
 * every assertion below is TypeScript a human can read. It is deliberately NOT a
 * whole-database verifier: the 2026-09-14 `fn_ops_ledger_verify()` incident OOM-ed the
 * instance and took the live site down. Every population here is bounded BY CONSTRUCTION —
 * one row per occupied block (170 today, 238 slots maximum), one row per (block, supplier)
 * pair (203), one row per supplier (17).
 *
 * MEASURED 2026-09-22 with `set local statement_timeout='5s'` then
 * EXPLAIN (ANALYZE, BUFFERS):
 *   view_blocking_block_suppliers alone (203 rows, warm)   36.7 ms /   239 buffers
 *   view_blocking_grid alone (balance > 0, 170 rows)        2.4 ms /   455 buffers
 *   the lens's core query                                  29.7 ms /   679 buffers
 *   SELECT fn_blocking_supplier_lens(6)  (warm)            48.0 ms / 2,174 buffers
 * 679 = 455 (ONE grid scan) + 221 (ONE supplier-view scan) + 3. The ceiling below is a
 * SHAPE alarm, not a latency SLO — see PROBE_MS_BUDGET.
 *
 * ============================================================================
 * ₱ IN THIS SCRIPT'S OUTPUT
 * ============================================================================
 * None, and that is a checked fact rather than a promise: the supplier payload has no
 * money-named key anywhere (asserted), so nothing this script prints is a price. It prints
 * supplier names, kilograms, counts and percentages.
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

const MIGRATION = 'supabase/migrations/20260922011759_blocking_supplier_lens.sql';
const PRICE_MIGRATION = 'supabase/migrations/20260919025729_blocking_price_lens.sql';
const AGE_MIGRATION = 'supabase/migrations/20260919133042_blocking_age_lens.sql';
const SUPPLIER_VIEW_MIGRATION = 'supabase/migrations/20260902145145_blocking_block_suppliers.sql';
const FACTS_MIGRATION = 'supabase/migrations/20260921034512_blend_block_facts_and_price_lens_rounded_up.sql';
const ACTIONS = 'app/(app)/inventory/blocking/actions.ts';
const TYPES = 'app/(app)/inventory/blocking/types.ts';
const CONTEXT = 'app/(app)/inventory/blocking/CONTEXT.md';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

/**
 * The migration's EXECUTABLE SQL only — `--` comment lines AND the bodies of
 * `COMMENT ON FUNCTION … IS '…'` removed.
 *
 * Both strips are load-bearing. Several assertions below test that something is NOT
 * spelled in this migration (`canonical_supplier`, `split_part`, `cost_basis`,
 * `avg_php_kg`), and the header prose and the function COMMENT both legitimately NAME those
 * very things while explaining why they are absent from the code. Testing the raw file
 * would therefore fail on its own documentation — a rule quoted in prose must not be
 * mistaken for a rule in code, in either direction.
 */
const executableSql = (sql: string): string =>
  sql
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      // `--` comment lines, the `COMMENT ON FUNCTION … IS` line, and the quoted COMMENT
      // body that follows it on its own line (this file's formatting).
      return !t.startsWith('--') && !t.startsWith('COMMENT ON FUNCTION') && !t.startsWith("'");
    })
    .join('\n');

/**
 * A SHAPE alarm, not a performance SLO — the same reasoning as the price and age lenses'.
 * What it must catch is one call walking a whole-history population; what it must NOT fire
 * on is instance load, and the wall-clock here is round-trip dominated
 * (verify-ops-ledger records a probe costing 280 ms server-side reading 4,671 ms from a
 * laptop). The probe makes 8 lens calls plus four independent aggregations, so ~1 s of
 * server work is the honest expectation and 20 s is ~20x that.
 */
const PROBE_MS_BUDGET = 20_000;

/** The one definition of "looks like money", mirroring the Excel report's `isCostKey`. */
const MONEY_KEY_RE = /php|peso|cost|price|value|amount/i;

// ---------------------------------------------------------------------------
// 1. STATIC — the migration's posture, the shared constants, the ABSENT gate
// ---------------------------------------------------------------------------
function staticChecks(): void {
  console.log('\nstatic (migration + server action + types, no network) ----------');

  const sql = read(MIGRATION);

  check('the lens is STABLE + SECURITY INVOKER + search_path-pinned; the probe is DEFINER', () => {
    // Counted rather than matched per function, so a third function cannot slip in
    // unposture'd.
    assert.equal((sql.match(/\nSTABLE\n/g) ?? []).length, 2, 'expected 2 STABLE functions');
    assert.equal((sql.match(/\nSECURITY INVOKER\n/g) ?? []).length, 1, 'expected 1 SECURITY INVOKER');
    assert.equal((sql.match(/\nSECURITY DEFINER\n/g) ?? []).length, 1, 'expected 1 SECURITY DEFINER (the probe)');
    assert.equal((sql.match(/\nSET search_path = public\n/g) ?? []).length, 2, 'search_path not pinned on both');
  });

  check('grants: authenticated only on the lens; anon + PUBLIC revoked; no service_role', () => {
    const sig = 'fn_blocking_supplier_lens(int)';
    assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC;`), 'PUBLIC not revoked');
    assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon;`), 'anon not revoked');
    assert.ok(sql.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO authenticated;`), 'authenticated missing');
    // service_role appears in this file for the PROBE and nowhere else.
    const svc = sql.match(/TO service_role/g) ?? [];
    assert.equal(svc.length, 1, 'service_role is granted somewhere other than the probe');
    assert.ok(
      sql.includes('GRANT  EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() TO service_role;'),
      'the probe is not the thing service_role was granted',
    );
  });

  check('the probe is service_role-only — authenticated and anon are BOTH revoked', () => {
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      assert.ok(
        sql.includes(`REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() FROM ${role};`),
        `probe: ${role} not revoked`,
      );
    }
  });

  check('the lens function carries a COMMENT', () => {
    assert.ok(sql.includes('COMMENT ON FUNCTION public.fn_blocking_supplier_lens(int) IS'), 'no function COMMENT');
    assert.ok(
      sql.includes('COMMENT ON FUNCTION public.fn_blocking_supplier_lens_probe() IS'),
      'no probe COMMENT',
    );
  });

  check('SUPPLIER IDENTITY is READ from the view, never re-spelled in this migration', () => {
    // THE one-definition decision of this file. `canonical_supplier` and the ' - ' origin
    // strip belong to view_blocking_block_suppliers; if either appears HERE, a second
    // identity rule has been born and the two can drift.
    assert.ok(
      sql.includes('public.view_blocking_block_suppliers'),
      'the migration does not read the view that owns supplier identity',
    );
    const code = executableSql(sql);
    assert.ok(
      !/canonical_supplier\s*\(/.test(code),
      'canonical_supplier() is CALLED in this migration — that is a second identity definition',
    );
    assert.ok(
      !/split_part\s*\(/.test(code),
      "the ' - ' origin strip is re-spelled in this migration — read it from the view instead",
    );
    // …and the view it reads really is the one that owns it.
    const viewSql = read(SUPPLIER_VIEW_MIGRATION);
    assert.ok(
      viewSql.includes("canonical_supplier(split_part(d.supplier, ' - ', 1))"),
      'view_blocking_block_suppliers no longer owns the identity expression',
    );
  });

  check('the ALL/SOME rule is the view\'s COLUMN, not a re-derivation from a list length', () => {
    const code = executableSql(sql);
    assert.ok(
      code.includes('supplier_count_in_block > 1'),
      'is_mixed is not computed from the view\'s supplier_count_in_block column',
    );
    // A length-based test would be the drift this column exists to prevent.
    assert.ok(
      !/jsonb_array_length\s*\(\s*[a-z_.]*suppliers/i.test(code),
      'is_mixed looks derived from the suppliers array length — use supplier_count_in_block',
    );
  });

  check('DOMINANCE reuses fn_blend_block_facts\' tie rule, verbatim', () => {
    const code = executableSql(sql);
    // The order is the whole rule: biggest delivered kg first, alphabetically-first
    // canonical key on a tie.
    assert.ok(
      /ORDER BY sup\.block_loc, sup\.delivered_kg DESC, sup\.supplier_key ASC/.test(code),
      'the dominance order is not (kg DESC, supplier_key ASC)',
    );
    // and the function it is lifted from still spells it the same way
    const facts = read(FACTS_MIGRATION);
    assert.ok(
      /ORDER BY sup\.x_kg DESC, sup\.x_key ASC/.test(facts),
      'fn_blend_block_facts no longer orders by (kg DESC, key ASC) — the reuse claim is stale',
    );
  });

  check('the hot CTEs carry their MATERIALIZED hints', () => {
    for (const cte of [
      'src AS MATERIALIZED',
      'sup AS MATERIALIZED',
      'dom AS MATERIALIZED',
      'ranked AS MATERIALIZED',
      'banded AS MATERIALIZED',
    ]) {
      assert.ok(sql.includes(cte), `${cte} lost its MATERIALIZED hint`);
    }
    // ...and the migration is HONEST about what they bought, because the measurement did
    // not say what was expected (Postgres already materializes a multiply-referenced CTE).
    assert.ok(/EXPLICIT INSURANCE/.test(sql), 'the header no longer states what the hints actually buy');
    assert.ok(
      /do NOT claim they\n-- bought the current number/.test(sql),
      'the header no longer carries the honest no-win note',
    );
  });

  check('NO ₱ is read anywhere in the migration — cost_basis and avg_php_kg are absent', () => {
    // This is what licenses the missing price gate on the SQL side. The COMMENT
    // legitimately names both columns in prose ("cost_basis is never read, avg_php_kg is
    // never selected"), which is exactly why `executableSql` strips it.
    const code = executableSql(sql);
    assert.ok(!/cost_basis/.test(code), 'cost_basis is read by the migration');
    assert.ok(!/avg_php_kg/.test(code), 'avg_php_kg is selected by the migration');
    assert.ok(!/\bphp\b/i.test(code), 'a php-named identifier appears in the executable SQL');
  });

  check('the migration does NOT touch the price lens, the age lens or the suppliers view', () => {
    // Additive only. Each of these is a live object another screen reads, and
    // CREATE OR REPLACE VIEW resets `reloptions` (the trap that bit
    // view_ops_ledger_campaign_kpis twice), so a silent replacement here would be a
    // posture change nobody asked for.
    for (const bad of [
      'CREATE OR REPLACE VIEW public.view_blocking_block_suppliers',
      'DROP VIEW public.view_blocking_block_suppliers',
      'ALTER VIEW public.view_blocking_block_suppliers',
      'CREATE OR REPLACE FUNCTION public.fn_blocking_price_lens',
      'CREATE OR REPLACE FUNCTION public.fn_blocking_age_lens',
      'CREATE OR REPLACE FUNCTION public.fn_blend_block_facts',
      'DROP FUNCTION',
    ]) {
      assert.ok(!sql.includes(bad), `the migration modifies something it should not (${bad})`);
    }
    // and the sibling migrations are themselves untouched by this change
    assert.ok(read(PRICE_MIGRATION).includes('fn_blocking_price_lens_probe'), 'the price probe is gone');
    assert.ok(read(AGE_MIGRATION).includes('fn_blocking_age_lens_probe'), 'the age probe is gone');
    assert.ok(!read(AGE_MIGRATION).includes('supplier_lens'), 'the supplier lens leaked into the age migration');
    assert.ok(!read(PRICE_MIGRATION).includes('supplier_lens'), 'the supplier lens leaked into the price migration');
  });

  const actions = read(ACTIONS);
  const supStart = actions.indexOf('export async function fetchBlockingSupplierLens(');
  assert.ok(supStart > 0, 'fetchBlockingSupplierLens not found');
  // BOUNDED AT THE NEXT SECTION DIVIDER (the file's own `// ─── <name> ───` convention),
  // not at end-of-file — `fetchBlendAnalysis` further down legitimately carries a price
  // gate AND names `canViewPrices()` in prose, so an unbounded slice would read ITS gate
  // as this one's. The age lens's verify script records the same trap.
  const supEnd = [
    actions.indexOf('\n// ─── ', supStart + 1),
    actions.indexOf('\nexport async function ', supStart + 1),
  ]
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  const supBody = actions.slice(supStart, supEnd ?? undefined);
  assert.ok(supBody.includes("'fn_blocking_supplier_lens'"), 'the isolated body is not the supplier lens action');
  assert.ok(!supBody.includes('fetchBlendBlockFacts'), 'the slice leaked into the next section');

  check('fetchBlockingSupplierLens has NO canViewPrices gate — and that is the point', () => {
    // THE central rule of this lens, shared with the age lens. Nothing in the payload is
    // money and none is derivable, so a gate here would hide a supplier figure from
    // Production, the one role that walks the yard. The price lens refuses such a caller
    // BEFORE the database; this one must not.
    assert.ok(!/canViewPrices/.test(supBody), 'a canViewPrices gate appeared in fetchBlockingSupplierLens');
    assert.ok(!/canViewPricesGate/.test(supBody), 'a canViewPricesGate call appeared in fetchBlockingSupplierLens');
    assert.ok(!/prices_hidden/.test(supBody), 'a prices_hidden refusal appeared — this lens has no price gate');
  });

  check('fetchBlockingSupplierLens DOES require a signed-in user, like its non-price siblings', () => {
    assert.ok(/auth\.getUser\(\)/.test(supBody), 'no auth.getUser() — the action does not require a session');
    assert.ok(/not_signed_in/.test(supBody), 'no typed not_signed_in refusal');
    const authAt = supBody.indexOf('auth.getUser()');
    const rpcAt = supBody.indexOf('.rpc(');
    assert.ok(authAt > 0 && rpcAt > 0 && authAt < rpcAt, 'the RPC is called BEFORE the session check');
  });

  check('BOTH price actions still gate — this change did not weaken the sibling', () => {
    for (const fn of ['fetchBlockingMarketBases', 'fetchBlockingPriceLens']) {
      const start = actions.indexOf(`export async function ${fn}(`);
      assert.ok(start > 0, `${fn} not found`);
      const nextExport = actions.indexOf('\nexport async function ', start + 1);
      const body = actions.slice(start, nextExport === -1 ? undefined : nextExport);
      const gateAt = body.indexOf('canViewPricesGate()');
      const clientAt = body.indexOf('createClient()');
      assert.ok(gateAt > 0, `${fn} lost its canViewPricesGate()`);
      assert.ok(gateAt < clientAt, `${fn} creates a Supabase client BEFORE the price gate`);
    }
  });

  check('the AGE lens action still has no gate either — the asymmetry is intact both ways', () => {
    const ageStart = actions.indexOf('export async function fetchBlockingAgeLens(');
    assert.ok(ageStart > 0, 'fetchBlockingAgeLens not found');
    const ageEnd = [
      actions.indexOf('\n// ─── ', ageStart + 1),
      actions.indexOf('\nexport async function ', ageStart + 1),
    ]
      .filter((i) => i > 0)
      .sort((a, b) => a - b)[0];
    const ageBody = actions.slice(ageStart, ageEnd ?? undefined);
    assert.ok(!/canViewPrices/.test(ageBody), 'a canViewPrices gate appeared in fetchBlockingAgeLens');
  });

  /** Comment lines stripped, so a rule quoted in prose cannot pass for a rule in code. */
  const supCode = supBody
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  check('the action does NO arithmetic (CLAUDE.md: never aggregate in TypeScript)', () => {
    assert.ok(!/\.reduce\(/.test(supCode), 'a reduce() means a total moved out of SQL');
    assert.ok(!/\+=/.test(supCode), 'a += means a sum moved out of SQL');
    assert.ok(!/Math\.(floor|ceil|round)/.test(supCode), 'rounding moved out of SQL');
    assert.ok(!/\.sort\(/.test(supCode), 'a sort() means the band order moved out of SQL');
  });

  check('NULL is preserved on a share; a DOMINANT zero is NOT null-preserving', () => {
    // Shares are null when nothing is attributed — "we cannot say", not 0%.
    for (const f of ['kgSharePct: lensNumOrNull(b.kg_share_pct)', 'blockSharePct: lensNumOrNull(b.block_share_pct)']) {
      assert.ok(supBody.includes(f), `${f} missing — a 0 here would read as a real 0%`);
    }
    // …but "this supplier dominates nothing" IS a measurement, so these are plain numbers.
    for (const f of ['dominantBlockCount: lensNum(b.dominant_block_count)', 'dominantKg: lensNum(b.dominant_kg)']) {
      assert.ok(supBody.includes(f), `${f} missing or null-preserving — a dominant 0 is a real answer`);
    }
    assert.ok(
      supBody.includes('dominantSharePct: lensNumOrNull(b.dominant_share_pct)'),
      'dominantSharePct should be null-preserving',
    );
  });

  check('the ALL/SOME flag is carried, not re-derived from suppliers.length', () => {
    assert.ok(supBody.includes('isMixed: b.is_mixed === true'), 'isMixed is not carried straight from the payload');
    assert.ok(
      !/suppliers\.length\s*>\s*1/.test(supCode),
      'isMixed looks derived from suppliers.length — that is the drift the column prevents',
    );
  });

  const types = read(TYPES);

  check('the top-N bounds are ONE definition, shared with SQL', () => {
    assert.ok(types.includes('BLOCKING_SUPPLIER_LENS_MIN_TOP_N = 1'), 'min top-N constant moved');
    assert.ok(types.includes('BLOCKING_SUPPLIER_LENS_MAX_TOP_N = 12'), 'max top-N constant moved');
    assert.ok(types.includes('BLOCKING_SUPPLIER_LENS_DEFAULT_TOP_N = 6'), 'default top-N constant moved');
    // and SQL agrees, digit for digit
    assert.ok(sql.includes('p_top_n int DEFAULT 6'), 'the SQL default top-N is not 6');
    assert.ok(sql.includes('p_top_n < 1 OR p_top_n > 12'), 'the SQL top-N bounds are not 1..12');
    // the action imports them rather than re-typing them
    for (const c of [
      'BLOCKING_SUPPLIER_LENS_DEFAULT_TOP_N',
      'BLOCKING_SUPPLIER_LENS_MIN_TOP_N',
      'BLOCKING_SUPPLIER_LENS_MAX_TOP_N',
    ]) {
      assert.ok(actions.includes(c), `the action re-types ${c} instead of importing it`);
    }
  });

  check('INTEGRALITY is enforced in the action, where it is decidable (int rounds first)', () => {
    assert.ok(/Number\.isInteger\(topN\)/.test(supCode), 'no integrality check on topN');
    // the same reasoning the price and age lenses recorded, and the same reason vocabulary
    assert.ok(/invalid_top_n/.test(supBody), 'the action does not reuse the SQL invalid_top_n reason');
  });

  check('CONTEXT.md carries the CONTRACT a frontend pass builds against', () => {
    // The frontend agent continues from the CONTEXT, not from this migration, so the
    // load-bearing rules have to be THERE. Each string below is a rule that, if missing,
    // would let a UI ship a wrong number rather than merely an ugly one.
    const ctx = read(CONTEXT);
    const at = ctx.indexOf('### Supplier lens — DATA LAYER');
    assert.ok(at > 0, 'CONTEXT.md has no "Supplier lens — DATA LAYER" section');
    const end = ctx.indexOf('\n### ', at + 1);
    const section = ctx.slice(at, end === -1 ? undefined : end);
    for (const [what, needle] of [
      ['the signature', 'fetchBlockingSupplierLens(topN = 6)'],
      ['the migration name', '20260922011759_blocking_supplier_lens'],
      ['the absent price gate', 'THERE IS NO PRICE GATE'],
      ['canShow for the registry', 'canShow: () => true'],
      ['the TWO attributions warning', 'TWO** KILOGRAM ATTRIBUTIONS'],
      ['which figure the ratio bar uses', 'RATIO BAR'],
      ['which figure the tint uses', 'the grid TINT'],
      ['the delivered third number', 'apportionedDeliveredKg'],
      ['the apportionment caveat', 'NOT A MEASUREMENT'],
      ['the not-bit-exact warning', 'NOT BIT-EXACT'],
      ['the unattributed rule', 'THE UNATTRIBUTED RULE'],
      ['the others-iff rule', 'total.supplierCount > topN'],
      ['the tie rules', 'supplierKey` ASC'],
      ['the refusal table', 'invalid_top_n'],
      ['the settings module key', "module = 'blocking_lens_supplier'"],
    ] as const) {
      assert.ok(section.includes(needle), `CONTEXT.md is missing ${what} (looked for "${needle}")`);
    }
  });

  check('the types spell out the two kilogram families and which one each UI element uses', () => {
    // The contract the frontend reads. If these sentences vanish, the next reader has no
    // way to know a ratio bar must not be sized from dominantKg.
    assert.ok(types.includes('apportionedKg'), 'apportionedKg is not in the contract');
    assert.ok(types.includes('apportionedDeliveredKg'), 'apportionedDeliveredKg is not in the contract');
    assert.ok(types.includes('dominantKg'), 'dominantKg is not in the contract');
    assert.ok(/RATIO BAR/.test(types), 'the contract no longer says which figure the ratio bar uses');
    assert.ok(/TINT/.test(types), 'the contract no longer says which figure the tint uses');
    assert.ok(
      /never re-derive it/i.test(types),
      'the contract no longer forbids re-deriving the ALL/SOME rule',
    );
  });
}

// ---------------------------------------------------------------------------
// 2. LIVE — the probe, plus real reads as anon and as service_role
// ---------------------------------------------------------------------------
type Json = Record<string, unknown>;

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

const n = (o: Json, k: string): number => {
  const v = o[k];
  assert.ok(v !== null && v !== undefined, `key ${k} is missing`);
  return Number(v);
};
const obj = (o: Json, k: string): Json => {
  const v = o[k];
  assert.ok(v && typeof v === 'object', `key ${k} is missing or not an object`);
  return v as Json;
};
const arr = (o: Json, k: string): Json[] => {
  const v = o[k];
  assert.ok(Array.isArray(v), `key ${k} is missing or not an array`);
  return v as Json[];
};

/** Every KEY anywhere in a jsonb payload, however deeply nested. */
function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
}

/** Shared fold proof, so every N gets it. */
function assertFolds(lens: Json, label: string): void {
  const bands = arr(lens, 'bands');
  const total = obj(lens, 'total');
  const unattr = obj(lens, 'unattributed');
  const blocks = arr(lens, 'blocks');

  const sumDomBlocks = bands.reduce((s, b) => s + Number(b.dominant_block_count), 0);
  const sumDomKg = bands.reduce((s, b) => s + Number(b.dominant_kg), 0);
  const sumApKg = bands.reduce((s, b) => s + Number(b.apportioned_kg), 0);

  // THE THREE FOLDS, re-summed here in JAVASCRIPT. Each is measured against `total`, which
  // the probe also recomputes straight off the grid, so these are agreements rather than
  // tautologies.
  //
  // NOTE THE TOLERANCES, and that they are NOT a way of avoiding an inconvenient result.
  // Counts are integers and fold EXACTLY. `dominantKg` is a plain sum of balances, so it
  // folds exactly in SQL — but the payload has been through JSON and IEEE-754 doubles by
  // the time it reaches here, so a `===` on a ten-million-kilogram sum is a test of
  // floating-point luck, not of the data. `apportionedKg` additionally carries `numeric`
  // division residue from `share_pct` (MEASURED in SQL: 5.9e-14 kg; in JS: −1.9e-9 kg).
  // THE EXACTNESS CLAIM IS SOURCED FROM SQL INSTEAD — see the `folds` assertions below,
  // which read gaps the probe computed in exact decimal. What THIS function checks is the
  // SHAPE of every band for every N.
  const KG_EPS = 1e-6;
  assert.equal(
    sumDomBlocks + n(unattr, 'block_count'),
    n(total, 'block_count'),
    `${label}: blocks went missing between the bands and the total`,
  );
  const domGap = sumDomKg + Number(unattr.kg) - Number(total.kg);
  assert.ok(Math.abs(domGap) < KG_EPS, `${label}: dominant kg gap is ${domGap}`);
  const apGap = sumApKg + Number(unattr.kg) - Number(total.kg);
  assert.ok(Math.abs(apGap) < KG_EPS, `${label}: apportioned kg gap is ${apGap}`);

  // …and the attributed half agrees with itself.
  assert.equal(
    n(total, 'attributed_block_count') + n(unattr, 'block_count'),
    n(total, 'block_count'),
    `${label}: attributed + unattributed != total blocks`,
  );
  assert.equal(
    Number(total.attributed_kg) + Number(unattr.kg) - Number(total.kg),
    0,
    `${label}: attributed + unattributed != total kg`,
  );

  // BAND SHAPE. Indices are 0..k contiguous, `others` is LAST and appears at most once.
  const idx = bands.map((b) => Number(b.index));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `${label}: bands are not in index order`);
  for (let i = 0; i < idx.length; i += 1) {
    assert.equal(idx[i], i, `${label}: band index ${idx[i]} is not contiguous from 0`);
  }
  const others = bands.filter((b) => b.is_others === true);
  assert.ok(others.length <= 1, `${label}: ${others.length} others bands — there may be at most one`);
  if (others.length === 1) {
    assert.equal(
      Number(others[0].index),
      bands.length - 1,
      `${label}: the others band is not last`,
    );
    // `others` IS the fold: it must exist exactly when the yard has more suppliers than N.
    assert.ok(
      n(total, 'supplier_count') > Number(lens.top_n),
      `${label}: an others band exists although supplier_count <= top_n`,
    );
    assert.equal(others[0].key, null, `${label}: the others band carries a supplier key`);
    assert.equal(others[0].display, null, `${label}: the others band carries a display name`);
    assert.ok(Array.isArray(others[0].supplier_keys), `${label}: the others band has no supplier_keys list`);
    assert.equal(
      (others[0].supplier_keys as unknown[]).length,
      Number(others[0].supplier_count),
      `${label}: the others band's supplier_keys length != its supplier_count`,
    );
  } else {
    assert.ok(
      n(total, 'supplier_count') <= Number(lens.top_n),
      `${label}: no others band although supplier_count > top_n`,
    );
  }

  // A NAMED band names exactly ONE supplier and publishes no list.
  for (const b of bands.filter((x) => x.is_others !== true)) {
    assert.equal(Number(b.supplier_count), 1, `${label}: named band ${b.index} folds more than one supplier`);
    assert.ok(typeof b.key === 'string' && (b.key as string).length > 0, `${label}: named band ${b.index} has no key`);
    assert.equal(b.supplier_keys, null, `${label}: named band ${b.index} publishes a supplier_keys list`);
  }

  // Named bands must be DISTINCT suppliers, and the named+folded count must be the yard's.
  const namedKeys = bands.filter((b) => b.is_others !== true).map((b) => String(b.key));
  assert.equal(new Set(namedKeys).size, namedKeys.length, `${label}: a supplier is named in two bands`);
  const foldedKeys = others.length === 1 ? (others[0].supplier_keys as string[]) : [];
  const allKeys = [...namedKeys, ...foldedKeys.map(String)];
  assert.equal(new Set(allKeys).size, allKeys.length, `${label}: a supplier is both named and folded`);
  assert.equal(
    allKeys.length,
    n(total, 'supplier_count'),
    `${label}: bands cover ${allKeys.length} suppliers but the yard has ${n(total, 'supplier_count')}`,
  );
  assert.equal(
    namedKeys.length,
    Math.min(Number(lens.top_n), n(total, 'supplier_count')),
    `${label}: the wrong number of suppliers is named`,
  );

  // RANKING: bands descend by apportioned kg — the metric the ratio bar draws.
  const named = bands.filter((b) => b.is_others !== true);
  for (let i = 0; i < named.length - 1; i += 1) {
    assert.ok(
      Number(named[i].apportioned_kg) >= Number(named[i + 1].apportioned_kg),
      `${label}: band ${i} has less apportioned kg than band ${i + 1} — the ranking is not by apportioned kg`,
    );
  }

  // SHARES over the ATTRIBUTED population.
  if (n(total, 'attributed_block_count') > 0) {
    const kgShare = bands.reduce((s, b) => s + Number(b.kg_share_pct), 0);
    const blockShare = bands.reduce((s, b) => s + Number(b.block_share_pct), 0);
    assert.ok(Math.abs(kgShare - 100) < 1e-9, `${label}: kg shares sum to ${kgShare}`);
    assert.ok(Math.abs(blockShare - 100) < 1e-9, `${label}: block shares sum to ${blockShare}`);
  }

  // Every block names a band that exists, no loc repeats, and the list covers exactly the
  // attributed blocks.
  const valid = new Set(bands.map((b) => Number(b.index)));
  const seen = new Set<string>();
  let mixedSeen = 0;
  for (const b of blocks) {
    const loc = String(b.block_loc);
    assert.ok(loc.length > 0, `${label}: a block entry has no block_loc`);
    assert.ok(!seen.has(loc), `${label}: block_loc ${loc} appears twice — the grid key is not unique`);
    seen.add(loc);
    assert.ok(valid.has(Number(b.band_index)), `${label}: block ${loc} is in band ${b.band_index}, which does not exist`);
    // THE ALL/SOME RULE, per block: is_mixed IS supplier_count > 1, with no third case.
    assert.equal(
      b.is_mixed,
      Number(b.supplier_count) > 1,
      `${label}: ${loc} reports is_mixed=${b.is_mixed} with supplier_count=${b.supplier_count}`,
    );
    if (b.is_mixed === true) mixedSeen += 1;
    // A block's own supplier slices must fold back to the block.
    const slices = b.suppliers as Json[];
    assert.ok(Array.isArray(slices) && slices.length > 0, `${label}: ${loc} has no supplier slices`);
    assert.equal(slices.length, Number(b.supplier_count), `${label}: ${loc} slice count != supplier_count`);
    const sliceShare = slices.reduce((s, x) => s + Number(x.share_pct), 0);
    assert.ok(Math.abs(sliceShare - 100) < 1e-6, `${label}: ${loc} slice shares sum to ${sliceShare}`);
    const sliceBal = slices.reduce((s, x) => s + Number(x.balance_kg), 0);
    assert.ok(
      Math.abs(sliceBal - Number(b.kg)) < 1e-6,
      `${label}: ${loc} slice balance_kg sums to ${sliceBal}, not the block's ${b.kg}`,
    );
    // The dominant supplier IS the biggest slice by delivered kg.
    const top = [...slices].sort(
      (x, y) => Number(y.kg) - Number(x.kg) || String(x.key).localeCompare(String(y.key)),
    )[0];
    assert.equal(
      String(b.dominant_supplier_key),
      String(top.key),
      `${label}: ${loc} names ${b.dominant_supplier_key} dominant but the biggest slice is ${top.key}`,
    );
  }
  assert.equal(
    blocks.length,
    n(total, 'attributed_block_count'),
    `${label}: the per-block list does not cover exactly the attributed blocks`,
  );
  assert.equal(mixedSeen, n(total, 'mixed_block_count'), `${label}: the mixed-block count disagrees with the list`);
  // and the per-band mixed counts fold to the same number
  const sumMixed = bands.reduce((s, b) => s + Number(b.mixed_block_count), 0);
  assert.equal(sumMixed, n(total, 'mixed_block_count'), `${label}: per-band mixed counts do not fold to the total`);
}

async function liveChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });

  console.log('\nlive posture (a REAL call as each victim role) -------------------');

  // L-043's lesson: prove a permission by ASSUMING THE VICTIM'S ROLE, never by reading the
  // grant table.
  const anonLens = await anon.rpc('fn_blocking_supplier_lens', { p_top_n: 6 });
  check('anon CANNOT execute fn_blocking_supplier_lens (a real call, not a grant lookup)', () => {
    assert.ok(anonLens.error, 'anon executed the supplier lens — the REVOKE is gone');
  });

  const svcLens = await svc.rpc('fn_blocking_supplier_lens', { p_top_n: 6 });
  check('service_role CANNOT execute fn_blocking_supplier_lens (no worker reads it)', () => {
    assert.ok(svcLens.error, 'service_role executed the supplier lens — an unintended grant appeared');
  });

  const anonProbe = await anon.rpc('fn_blocking_supplier_lens_probe');
  check('anon CANNOT execute the verify probe either', () => {
    assert.ok(anonProbe.error, 'anon reached the probe — it bypasses the grant');
  });

  // --- the probe itself ---
  const t0 = Date.now();
  const probeRes = await svc.rpc('fn_blocking_supplier_lens_probe');
  const ms = Date.now() - t0;
  assert.ok(!probeRes.error, `fn_blocking_supplier_lens_probe failed: ${probeRes.error?.message}`);
  const probe = probeRes.data as unknown as Json;
  assert.ok(
    probe && typeof probe === 'object',
    'the probe returned nothing — an empty probe is a FAILURE, not a pass',
  );

  console.log(`\nlive (probe: ${ms} ms wall clock) --------------------------------`);

  check(`the probe stays under the ${PROBE_MS_BUDGET} ms SHAPE budget`, () => {
    assert.ok(ms < PROBE_MS_BUDGET, `probe took ${ms} ms — check it has not grown a whole-history population`);
  });

  // --- (a) POSTURE from the catalog, as a second witness to the real calls above ---
  const posture = obj(probe, 'posture');
  check('catalog posture: lens authenticated yes, anon no, service_role no', () => {
    assert.equal(posture.lens_authenticated, true);
    assert.equal(posture.lens_anon, false);
    assert.equal(posture.lens_service_role, false);
  });
  check('catalog posture: the probe is service_role-only', () => {
    assert.equal(posture.probe_service_role, true);
    assert.equal(posture.probe_authenticated, false);
    assert.equal(posture.probe_anon, false);
  });
  check('catalog posture: 1 SECURITY INVOKER, no overload, 2 STABLE, 2 pinned, 1 commented', () => {
    assert.equal(n(posture, 'lens_invoker'), 1);
    // An OVERLOAD would be a second home for the band logic.
    assert.equal(n(posture, 'lens_overload_count'), 1, 'fn_blocking_supplier_lens is overloaded');
    assert.equal(n(posture, 'stable_count'), 2);
    assert.equal(n(posture, 'search_path_pinned'), 2);
    assert.equal(n(posture, 'commented'), 1);
  });
  check('catalog posture: view_blocking_block_suppliers is authenticated-only AND security_invoker', () => {
    // The lens READS its identity rule from this view, so the view's posture is part of
    // this feature's posture. CREATE OR REPLACE VIEW RESETS reloptions — the trap that bit
    // view_ops_ledger_campaign_kpis twice. This is the live guard for it.
    assert.equal(posture.view_authenticated, true);
    assert.equal(posture.view_anon, false);
    assert.equal(posture.view_service_role, false);
    assert.equal(n(posture, 'view_security_invoker'), 1, 'the suppliers view is NOT security_invoker on the live DB');
  });

  // --- (b) NO MONEY ANYWHERE IN THE PAYLOAD ---
  const lens = obj(probe, 'lens_default');
  check('NOT ONE money-named key anywhere in the supplier payload', () => {
    // This is what licenses the missing price gate. Scanned recursively, so a money key
    // nested inside `bands[]`, `blocks[]` or a `suppliers[]` slice could not hide.
    const keys = new Set<string>();
    collectKeys(lens, keys);
    const offenders = [...keys].filter((k) => MONEY_KEY_RE.test(k));
    assert.deepEqual(offenders, [], `money-named keys in the supplier payload: ${offenders.join(', ')}`);
    assert.ok(keys.size > 15, 'the key scan found almost nothing — it is not actually walking the payload');
  });

  // --- (c) THE DEFAULT LENS ---
  const grid = obj(probe, 'grid');
  check('the default lens returned ok:true and defaults to SIX named suppliers', () => {
    assert.equal(lens.ok, true);
    assert.equal(n(lens, 'top_n'), 6, 'the default top_n is not 6');
    // …and passing 6 explicitly gives byte-identical bands, so the default is not a
    // second code path.
    assert.deepEqual(arr(lens, 'bands'), arr(obj(probe, 'lens_6'), 'bands'), 'default != explicit 6');
  });

  const bands = arr(lens, 'bands');
  const total = obj(lens, 'total');
  const unattr = obj(lens, 'unattributed');

  console.log('\n  the supplier lens, top 6 --------------------------------------');
  for (const b of bands) {
    const name = b.is_others === true ? `OTHERS (${b.supplier_count})` : String(b.display ?? b.key);
    console.log(
      `    band ${b.index}  ${name.padEnd(18)}` +
        `${String(b.dominant_block_count).padStart(4)} blk  ` +
        `dom ${Number(b.dominant_kg).toLocaleString('en-US').padStart(11)} kg  ` +
        `apn ${Math.round(Number(b.apportioned_kg)).toLocaleString('en-US').padStart(11)} kg  ` +
        `${Number(b.kg_share_pct).toFixed(4).padStart(9)}% kg  ` +
        `${Number(b.block_share_pct).toFixed(4).padStart(9)}% blk  ` +
        `${String(b.mixed_block_count).padStart(3)} mixed`,
    );
  }
  console.log(
    `    unattributed ${String(n(unattr, 'block_count')).padStart(4)} blocks  ` +
      `${Number(unattr.kg).toLocaleString('en-US').padStart(12)} kg   (in NO band)`,
  );
  console.log(
    `    TOTAL        ${String(n(total, 'block_count')).padStart(4)} blocks  ` +
      `${Number(total.kg).toLocaleString('en-US').padStart(12)} kg  ` +
      `${n(total, 'supplier_count')} suppliers  ${n(total, 'mixed_block_count')} mixed`,
  );

  // --- (d) THE FOLDS ---
  check('default lens: three folds add up, shares = 100, bands contiguous, others last', () => {
    assertFolds(lens, 'default');
  });

  check('THE FOLD GAPS, SUMMED IN EXACT DECIMAL BY SQL — 0 wherever 0 is deliverable', () => {
    // This is where the "gap 0" claim actually lives. The probe summed the published bands
    // in `numeric`, so there is no float in the path at all.
    //
    // WHICH GAPS CAN BE EXACTLY ZERO, AND WHY THE OTHERS CANNOT:
    //   dominant_kg          a plain SUM OF BALANCES -> exactly 0.
    //   block counts         integers -> exactly 0.
    //   delivered vs total_in a plain sum of the view's own kg -> exactly 0.
    //   apportioned_kg       balance x share_pct, and share_pct is a `numeric` DIVISION
    //                        truncated at a finite scale, so the slices cannot re-sum to
    //                        the balance bit-exactly. MEASURED 5.896e-14 kg on a 10.5
    //                        million kg yard. Bounded, never asserted to be 0 — and if it
    //                        ever grows past 1e-6 kg that is a REAL bug, not rounding.
    //   the two share sums   same reason, against 100.
    const folds = obj(probe, 'folds');
    for (const label of ['n1', 'n6', 'n12']) {
      const f = obj(folds, label);
      assert.equal(Number(f.gap_dominant_kg), 0, `${label}: SQL says dominant kg gap is ${f.gap_dominant_kg}, not 0`);
      assert.equal(Number(f.gap_block_count), 0, `${label}: SQL says block-count gap is ${f.gap_block_count}, not 0`);
      assert.equal(
        Number(f.gap_mixed_block_count),
        0,
        `${label}: SQL says mixed-count gap is ${f.gap_mixed_block_count}, not 0`,
      );
      assert.equal(
        Number(f.gap_delivered_vs_total_in),
        0,
        `${label}: SQL says the delivered fold misses the grid's total_in by ${f.gap_delivered_vs_total_in}`,
      );
      assert.ok(
        Math.abs(Number(f.gap_apportioned_kg)) < 1e-6,
        `${label}: SQL says apportioned kg gap is ${f.gap_apportioned_kg} — beyond numeric-division residue`,
      );
      assert.ok(
        Math.abs(Number(f.gap_kg_share_pct)) < 1e-9,
        `${label}: SQL says kg shares miss 100 by ${f.gap_kg_share_pct}`,
      );
      assert.ok(
        Math.abs(Number(f.gap_block_share_pct)) < 1e-9,
        `${label}: SQL says block shares miss 100 by ${f.gap_block_share_pct}`,
      );
    }
    const f6 = obj(folds, 'n6');
    console.log(
      `    exact folds:    dominant kg ${f6.gap_dominant_kg} · blocks ${f6.gap_block_count} · ` +
        `delivered ${f6.gap_delivered_vs_total_in} · apportioned ${f6.gap_apportioned_kg} (numeric residue)`,
    );
  });

  check('the banded population IS the grid\'s positive-balance blocks', () => {
    // Computed in the probe straight off view_blocking_grid, independently of the lens, so
    // this is an agreement rather than a tautology.
    assert.equal(n(total, 'block_count'), n(grid, 'block_count'), "lens total != the grid's occupied blocks");
    assert.equal(Number(total.kg) - Number(grid.kg), 0, 'lens total kg != Σ balance over the grid');
  });

  check('an UNATTRIBUTED block is in NO band and NOT folded into others', () => {
    assert.equal(
      n(unattr, 'block_count'),
      n(grid, 'unattributed_count'),
      'the lens and the grid disagree about how many blocks have no supplier',
    );
    assert.equal(Number(unattr.kg) - Number(grid.unattributed_kg), 0, 'unattributed kg disagrees with the grid');
    // `blocks[]` is the band membership list, so an unattributed block must be absent…
    assert.equal(
      arr(lens, 'blocks').length,
      n(grid, 'block_count') - n(grid, 'unattributed_count'),
      'the per-block band list does not cover exactly the attributed blocks',
    );
    // …and the two together account for everything, which is what makes "absent" mean
    // "unattributed" rather than "lost".
    assert.equal(arr(lens, 'blocks').length + n(unattr, 'block_count'), n(total, 'block_count'));
    if (n(unattr, 'block_count') === 0) {
      console.log('      (note: 0 unattributed blocks live today — the branch is proven by the invariants)');
    }
  });

  // --- (e) THE ONE-DEFINITION PROOFS ---
  const viewRows = arr(probe, 'view_rows');
  check('per-block supplier KILOGRAMS, SHARES and the ALL/SOME count equal the VIEW on every block', () => {
    // THE proof that this lens did not grow a second supplier-identity rule. The probe read
    // view_blocking_block_suppliers independently; every (block, supplier) pair must match.
    assert.ok(viewRows.length > 0, 'the view read covered no rows — an empty proof is a FAILURE');
    const mine = new Map<string, Json>();
    for (const b of arr(lens, 'blocks')) {
      for (const s of b.suppliers as Json[]) {
        mine.set(`${b.block_loc} ${s.key}`, { ...s, block_loc: b.block_loc, sc: b.supplier_count });
      }
    }
    assert.equal(mine.size, viewRows.length, `lens has ${mine.size} (block, supplier) pairs, view has ${viewRows.length}`);
    let kgMismatch = 0;
    let shareMismatch = 0;
    let countMismatch = 0;
    for (const v of viewRows) {
      const k = `${v.block_loc} ${v.supplier_key}`;
      const m = mine.get(k);
      assert.ok(m, `the lens is missing (${v.block_loc}, ${v.supplier_key})`);
      if (Number(m!.kg) !== Number(v.kg)) kgMismatch += 1;
      if (Math.abs(Number(m!.share_pct) - Number(v.share_pct)) > 1e-9) shareMismatch += 1;
      if (Number(m!.sc) !== Number(v.supplier_count_in_block)) countMismatch += 1;
    }
    assert.equal(kgMismatch, 0, `${kgMismatch} blocks disagree with the view about a supplier's kilograms`);
    assert.equal(shareMismatch, 0, `${shareMismatch} blocks disagree with the view about a supplier's share`);
    assert.equal(countMismatch, 0, `${countMismatch} blocks disagree with the view about the supplier COUNT`);
    console.log(`    one-definition: ${viewRows.length} (block, supplier) pairs vs view_blocking_block_suppliers, 0 mismatches`);
  });

  const factsRows = arr(probe, 'facts_rows');
  check('the DOMINANT supplier equals fn_blend_block_facts on every batch', () => {
    // THE proof that this lens did not invent a THIRD dominance rule. If this fails, the
    // grid tint and the blend modal's green/orange have drifted — fix whichever moved, do
    // not relax the comparison.
    assert.ok(factsRows.length > 0, 'the facts read covered no batches — an empty proof is a FAILURE');
    const byBatch = new Map(arr(lens, 'blocks').map((b) => [String(b.batch_id), b]));
    let domMismatch = 0;
    let countMismatch = 0;
    let flagMismatch = 0;
    let compared = 0;
    for (const f of factsRows) {
      const b = byBatch.get(String(f.batch_id));
      if (!b) continue; // an unattributed batch has no lens row; covered by the fold proofs
      compared += 1;
      if (String(b.dominant_supplier_key) !== String(f.dominant_supplier_key)) domMismatch += 1;
      if (Number(b.supplier_count) !== Number(f.supplier_count)) countMismatch += 1;
      // is_single_supplier is the same fact as is_mixed, inverted.
      if (b.is_mixed !== !f.is_single_supplier) flagMismatch += 1;
    }
    assert.ok(compared > 0, 'no batch was actually compared against fn_blend_block_facts');
    assert.equal(domMismatch, 0, `${domMismatch} batches disagree with fn_blend_block_facts about the dominant supplier`);
    assert.equal(countMismatch, 0, `${countMismatch} batches disagree about the supplier count`);
    assert.equal(flagMismatch, 0, `${flagMismatch} batches disagree about single-vs-mixed`);
    console.log(`    one-definition: ${compared} batches vs fn_blend_block_facts dominance, 0 mismatches`);
  });

  const supplierTotals = arr(probe, 'supplier_totals');
  check('per-supplier APPORTIONED and DELIVERED kilos match an INDEPENDENT aggregation', () => {
    // The probe aggregated the yard per supplier longhand off the view + the grid. Every
    // named band must equal its supplier's row, and the `others` band must equal the sum of
    // the rest — which is what proves the fold is a fold and not a re-derivation.
    assert.equal(supplierTotals.length, n(total, 'supplier_count'), 'the yard has a different supplier count');
    const byKey = new Map(supplierTotals.map((s) => [String(s.supplier_key), s]));
    for (const b of bands.filter((x) => x.is_others !== true)) {
      const s = byKey.get(String(b.key));
      assert.ok(s, `band ${b.index} names ${b.key}, which the independent aggregation does not have`);
      assert.ok(
        Math.abs(Number(b.apportioned_kg) - Number(s!.apportioned_kg)) < 1e-6,
        `${b.key}: band apportioned ${b.apportioned_kg} vs independent ${s!.apportioned_kg}`,
      );
      assert.equal(
        Number(b.apportioned_delivered_kg),
        Number(s!.delivered_kg),
        `${b.key}: band delivered ${b.apportioned_delivered_kg} vs independent ${s!.delivered_kg}`,
      );
    }
    const others = bands.find((x) => x.is_others === true);
    if (others) {
      const folded = (others.supplier_keys as string[]).map((k) => byKey.get(String(k))!);
      const apSum = folded.reduce((s, x) => s + Number(x.apportioned_kg), 0);
      const delSum = folded.reduce((s, x) => s + Number(x.delivered_kg), 0);
      assert.ok(
        Math.abs(Number(others.apportioned_kg) - apSum) < 1e-6,
        `others apportioned ${others.apportioned_kg} != Σ its members ${apSum}`,
      );
      assert.ok(
        Math.abs(Number(others.apportioned_delivered_kg) - delSum) < 1e-6,
        `others delivered ${others.apportioned_delivered_kg} != Σ its members ${delSum}`,
      );
    }
  });

  check('Σ apportionedDeliveredKg folds to the GRID\'S total_in, not to its balance', () => {
    // THE proof that the two kilogram families are genuinely two. The delivered column is
    // kilograms ARRIVED, so it must fold to `total_in`; the apportioned column is a slice
    // of the BALANCE, so it must fold to `kg`. If these two ever fold to the same number,
    // one of them has been quietly redefined. (Both gaps are asserted EXACTLY in SQL above;
    // these are the JS-side shape checks, hence the tolerance.)
    const sumDel = bands.reduce((s, b) => s + Number(b.apportioned_delivered_kg), 0);
    assert.ok(
      Math.abs(sumDel - Number(grid.total_in_kg)) < 1e-6,
      `Σ delivered ${sumDel} != the grid's total_in ${grid.total_in_kg}`,
    );
    const sumAp = bands.reduce((s, b) => s + Number(b.apportioned_kg), 0);
    assert.ok(Math.abs(sumAp - Number(total.kg)) < 1e-6, `Σ apportioned ${sumAp} != total.kg ${total.kg}`);
    // …and they really do differ, which is the whole reason both exist.
    const gap = Number(grid.total_in_kg) - Number(total.kg);
    assert.ok(gap >= 0, 'delivered is BELOW balance — impossible unless the grid changed mid-read');
    console.log(
      `    two families:   delivered ${Number(grid.total_in_kg).toLocaleString('en-US')} kg vs balance ` +
        `${Number(total.kg).toLocaleString('en-US')} kg — a ${gap.toLocaleString('en-US')} kg gap (fed out)`,
    );
  });

  check('a supplier that DOMINATES NOTHING still carries real apportioned kilos', () => {
    // The measured case that forced both attributions to be published (MERCADO today: in
    // 11 blocks, dominates none). It lives inside `others` at N=6, so this reads the
    // independent aggregation and the lens's own dominance list rather than a band.
    const dominators = new Set(arr(lens, 'blocks').map((b) => String(b.dominant_supplier_key)));
    const nonDominators = supplierTotals.filter((s) => !dominators.has(String(s.supplier_key)));
    if (nonDominators.length === 0) {
      console.log('      (skipped: every supplier in the yard dominates at least one block today)');
      return;
    }
    for (const s of nonDominators) {
      assert.ok(
        Number(s.apportioned_kg) > 0,
        `${s.supplier_key} dominates nothing AND has no apportioned kilos — it should not be in the yard at all`,
      );
    }
    console.log(
      `    dominates none: ${nonDominators
        .map((s) => `${s.supplier_key} (${Number(s.blocks_present)} blocks, ${Math.round(Number(s.apportioned_kg)).toLocaleString('en-US')} kg)`)
        .join(', ')}`,
    );
  });

  // --- (f) ONE YARD, THREE LENSES ---
  const ageProbeRes = await svc.rpc('fn_blocking_age_lens_probe');
  assert.ok(!ageProbeRes.error, `fn_blocking_age_lens_probe failed: ${ageProbeRes.error?.message}`);
  const ageProbe = ageProbeRes.data as unknown as Json;
  const priceProbeRes = await svc.rpc('fn_blocking_price_lens_probe', { p_trailing_days: 30 });
  assert.ok(!priceProbeRes.error, `fn_blocking_price_lens_probe failed: ${priceProbeRes.error?.message}`);
  const priceProbe = priceProbeRes.data as unknown as Json;

  check('the SUPPLIER, AGE and PRICE lenses describe ONE yard', () => {
    // Each probe recomputes the grid's totals for its own proofs, so these are three
    // independent witnesses to the same population.
    const ageGrid = obj(ageProbe, 'grid');
    const priceGrid = obj(priceProbe, 'grid');
    assert.equal(
      n(total, 'block_count'),
      n(ageGrid, 'block_count'),
      'the supplier and age lenses disagree about how many blocks are occupied',
    );
    assert.equal(
      Number(total.kg) - Number(ageGrid.kg),
      0,
      'the supplier and age lenses disagree about how many kilograms are in the yard',
    );
    assert.equal(
      n(total, 'block_count'),
      n(priceGrid, 'block_count'),
      'the supplier and price lenses disagree about how many blocks are occupied',
    );
    assert.equal(
      Number(total.kg) - Number(priceGrid.kg),
      0,
      'the supplier and price lenses disagree about how many kilograms are in the yard',
    );
    // The three lenses bucket DIFFERENT blocks out (unattributed vs undated vs unpriced),
    // so those need not match — but each must be a subset of the shared total.
    const ageLens = obj(ageProbe, 'lens_default');
    assert.ok(
      n(obj(ageLens, 'undated'), 'block_count') <= n(total, 'block_count'),
      'the age lens reports more undated blocks than the yard has',
    );
    assert.ok(
      n(unattr, 'block_count') <= n(total, 'block_count'),
      'the supplier lens reports more unattributed blocks than the yard has',
    );
  });

  // --- (g) MORE / FEWER NAMED SUPPLIERS ---
  const one = obj(probe, 'lens_1');
  check('N = 1 names ONE supplier and folds everyone else, still folding to the same yard', () => {
    assert.equal(one.ok, true);
    assert.equal(n(one, 'top_n'), 1);
    assertFolds(one, 'N=1');
    // the yard does not change because the legend did
    assert.equal(Number(obj(one, 'total').kg), Number(total.kg), 'the N=1 lens describes a different yard');
    assert.equal(n(obj(one, 'total'), 'block_count'), n(total, 'block_count'));
    // the one named supplier is the SAME one band 0 names at N=6
    assert.equal(arr(one, 'bands')[0].key, bands[0].key, 'N=1 names a different top supplier than N=6 does');
  });

  const twelve = obj(probe, 'lens_12');
  check('N = 12 names twelve and still folds to the same yard', () => {
    assert.equal(twelve.ok, true);
    assert.equal(n(twelve, 'top_n'), 12);
    assertFolds(twelve, 'N=12');
    assert.equal(Number(obj(twelve, 'total').kg), Number(total.kg), 'the N=12 lens describes a different yard');
    // the first six named suppliers are the same six, in the same order — the ranking does
    // not depend on N
    const namedTwelve = arr(twelve, 'bands').filter((b) => b.is_others !== true).map((b) => b.key);
    const namedSix = bands.filter((b) => b.is_others !== true).map((b) => b.key);
    assert.deepEqual(namedTwelve.slice(0, namedSix.length), namedSix, 'the ranking changed with N');
  });
  console.log(
    `    N=1 -> ${arr(one, 'bands').length} bands · N=6 -> ${bands.length} · N=12 -> ${arr(twelve, 'bands').length} ` +
      `(yard has ${n(total, 'supplier_count')} suppliers)`,
  );

  // --- (h) THE REFUSALS ---
  const refusals: Array<[string, string]> = [
    ['refusal_null_top_n', 'invalid_top_n'],
    ['refusal_zero_top_n', 'invalid_top_n'],
    ['refusal_neg_top_n', 'invalid_top_n'],
    ['refusal_big_top_n', 'invalid_top_n'],
  ];
  for (const [key, reason] of refusals) {
    check(`refusal: ${key} -> ok:false, reason '${reason}', with a human message`, () => {
      const r = obj(probe, key);
      assert.equal(r.ok, false, `${key} did not refuse`);
      assert.equal(r.reason, reason, `${key} gave reason ${r.reason}`);
      assert.ok(typeof r.message === 'string' && r.message.length > 20, `${key} has no human message`);
      // A refusal is DATA, so it must carry nothing else — in particular no partial band
      // list a caller might render.
      assert.equal(r.bands, undefined, `${key} leaked a band list into a refusal`);
      assert.equal(r.blocks, undefined, `${key} leaked a block list into a refusal`);
      assert.equal(r.total, undefined, `${key} leaked totals into a refusal`);
      assert.equal(r.top_n, undefined, `${key} leaked a top_n into a refusal`);
    });
  }

  check('a NULL top_n is REFUSED, never silently defaulted to 6', () => {
    // A caller that passed NULL meant something; substituting the default would answer a
    // question nobody asked. Omitting the argument entirely still gets the DEFAULT — which
    // is the `lens_default` case proven above.
    assert.equal(obj(probe, 'refusal_null_top_n').reason, 'invalid_top_n');
    assert.equal(obj(probe, 'lens_default').ok, true, 'omitting the argument stopped working');
  });
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('verify-blocking-supplier-lens — the Blocking supplier lens data layer');
  staticChecks();

  const env = readEnv();
  if (!env) {
    console.log('\n  ! SKIPPING the live half: no NEXT_PUBLIC_SUPABASE_URL / keys found.');
    console.log('    The static half passed, but nothing about the live functions was proven.');
  } else {
    await liveChecks(env);
  }

  console.log(`\n${passed} assertions passed.`);
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
