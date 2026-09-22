/**
 * verify-blocking-supplier-lens.ts — the proofs behind the BLOCKING SUPPLIER LENS.
 *
 * Run: npx tsx scripts/verify-blocking-supplier-lens.ts
 *
 * ============================================================================
 * WHAT THE FEATURE IS, AND WHAT CAN GO WRONG WITH IT
 * ============================================================================
 * The THIRD lens on the Blocking grid (migration `20260922011759_blocking_supplier_lens`,
 * plus `20260922051500_blocking_supplier_lens_weighted_price`), sibling of the price and age
 * lenses: tint every occupied block by WHOSE charcoal it holds, with a ratio of the yard per
 * supplier. Bands are the top N suppliers (default 6) plus one `others` fold.
 *
 * **SINCE 2026-09-22 IT CARRIES MONEY IN EXACTLY TWO KEYS** — `kg_weighted_php_kg` and
 * `priced_dominant_kg`, per band and on `total` — because the owner found the band table's
 * last column ("SUPPLIER · 4,542,073 kg dominant") told him nothing the two columns beside it
 * had not, and asked for "average weighted price or something". That single change inverts
 * one of this script's original assertions (the gate's ABSENCE) and adds four new failure
 * modes, all listed below.
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
 *   THE WEIGHTED    the 2026-09-22 addition, and the one genuinely new arithmetic in the
 *   PRICE           feature: a band figure that is not actually the weighted mean of the
 *                   prices of the blocks on its own row — the ₱11.01-vs-₱39.99 `avg_cost`
 *                   bug's shape. PROVEN: every published `kg_weighted_php_kg` is compared,
 *                   IN EXACT DECIMAL, against an INDEPENDENT recomputation off
 *                   `view_blocking_grid`, gap required to be 0 — per band and on `total` —
 *                   and `Σ priced_dominant_kg` must fold to `total` exactly at every N.
 *   L-008 AGAIN     an unpriced block's ₱0 averaged in, which understates the figure in
 *                   proportion to how much of the band is awaiting a price. PROVEN: the
 *                   predicate is the one `fn_blocking_price_lens` uses word for word, the
 *                   price is NULL (never 0) on a band with no priced block, and
 *                   `priced_dominant_kg` publishes the weight so the coverage is visible.
 *   THE GATE        **INVERTED 2026-09-22.** This script used to assert that
 *   (WAS: MISSING)  `fetchBlockingSupplierLens` had NO `canViewPrices()` call. It now has
 *                   one, because two keys became money — but it must be a NULLING OF EXACTLY
 *                   THOSE TWO, never a refusal, because the rest of the payload is still
 *                   wanted by Production, THE ROLE THAT WALKS THE YARD. So the script asserts
 *                   the gate EXISTS, that it nulls exactly those two keys and sets
 *                   `pricesHidden`, that it fails closed, that there is no `prices_hidden`
 *                   refusal reason, and that NO OTHER money-named key exists anywhere in the
 *                   live payload. It also still asserts the AGE lens has no gate at all, so
 *                   the three-way asymmetry (refuse / null two keys / no gate) cannot be
 *                   flattened by someone tidying up.
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
 * **CHANGED 2026-09-22, and stated rather than quietly kept.** This section used to say
 * "none". The band table it prints now carries the lens's own `kg_weighted_php_kg` — one ₱/kg
 * per band plus the yard's — because a proof of a price has to be able to show the price it
 * proved. Everything else it prints is supplier names, kilograms, counts and percentages, and
 * exactly WHICH keys may carry money is itself asserted (`MONEY_KEY_RE` over every key of the
 * live payload must yield precisely the two). The PROBE's own computations remain money-free:
 * it returns gaps that must be 0, weights, counts and booleans.
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
/** The ₱-key addition (2026-09-22). CREATE OR REPLACEs the lens AND the probe, nothing else. */
const PRICE_KEYS_MIGRATION =
  'supabase/migrations/20260922051500_blocking_supplier_lens_weighted_price.sql';
const PRICE_MIGRATION = 'supabase/migrations/20260919025729_blocking_price_lens.sql';
/** Where `fn_blocking_price_lens.kg_weighted_php_kg` — the key this one mirrors — was added. */
const PRICE_WTD_MIGRATION = 'supabase/migrations/20260921084500_blend_analysis_natural_breaks.sql';
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

  check('the ORIGINAL migration is UNTOUCHED — it still reads no ₱ at all', () => {
    // The 2026-09-22 ₱ keys arrived in a SEPARATE file (PRICE_KEYS_MIGRATION). This file is
    // history and must stay so: an applied migration edited after the fact is a migration
    // nobody can replay. The COMMENT here legitimately names both columns in prose
    // ("cost_basis is never read, avg_php_kg is never selected"), which is exactly why
    // `executableSql` strips it.
    const code = executableSql(sql);
    assert.ok(!/cost_basis/.test(code), 'cost_basis is read by the original migration');
    assert.ok(!/avg_php_kg/.test(code), 'avg_php_kg is selected by the original migration');
    assert.ok(!/\bphp\b/i.test(code), 'a php-named identifier appears in the original executable SQL');
    // …and it does not know about the two keys that came later, in either direction.
    assert.ok(!sql.includes('kg_weighted_php_kg'), 'the original migration was edited to add the ₱ key');
    assert.ok(!sql.includes('priced_dominant_kg'), 'the original migration was edited to add the weight key');
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

  // ── the 2026-09-22 ₱-key migration ────────────────────────────────────────
  const psql = read(PRICE_KEYS_MIGRATION);
  const pcode = executableSql(psql);

  check('the ₱-key migration replaces ONLY the lens and its probe, with a CHANGED signature nowhere', () => {
    // Additive means additive. A different argument list would be a NEW function beside the
    // old one (Postgres overloads on signature), which is how a band rule gets two homes.
    assert.ok(
      psql.includes('CREATE OR REPLACE FUNCTION public.fn_blocking_supplier_lens(\n  p_top_n int DEFAULT 6\n)'),
      'the lens signature moved — that would create an OVERLOAD, not a replacement',
    );
    assert.ok(
      psql.includes('CREATE OR REPLACE FUNCTION public.fn_blocking_supplier_lens_probe()'),
      'the probe is not replaced, so the new figures have no independent witness',
    );
    // Exactly two CREATEs, and no DROP anywhere. Counted over the EXECUTABLE SQL — the header
    // and §2 legitimately discuss "CREATE OR REPLACE FUNCTION" in prose, and a rule quoted in
    // prose must not be mistaken for a statement (the same strip the identity checks need).
    const code = executableSql(psql);
    assert.equal(
      (code.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length,
      2,
      'the ₱-key migration creates something other than the lens and its probe',
    );
    assert.ok(!/DROP\s+(FUNCTION|VIEW|TABLE)/i.test(code), 'the ₱-key migration drops something');
    for (const bad of [
      'CREATE OR REPLACE VIEW',
      'ALTER VIEW',
      'CREATE OR REPLACE FUNCTION public.fn_blocking_price_lens',
      'CREATE OR REPLACE FUNCTION public.fn_blocking_age_lens',
      'CREATE OR REPLACE FUNCTION public.fn_blend_block_facts',
    ]) {
      assert.ok(!code.includes(bad), `the ₱-key migration modifies something it should not (${bad})`);
    }
  });

  check('the ₱-key migration keeps the posture and RE-STATES the grants', () => {
    // CREATE OR REPLACE FUNCTION keeps grants — but this function has just become ₱-bearing,
    // and a silent posture loss on such a function is the L-043/L-044 shape. Re-stated.
    assert.equal((psql.match(/\nSTABLE\n/g) ?? []).length, 2, 'expected 2 STABLE functions');
    assert.equal((psql.match(/\nSECURITY INVOKER\n/g) ?? []).length, 1, 'the lens is not SECURITY INVOKER');
    assert.equal((psql.match(/\nSECURITY DEFINER\n/g) ?? []).length, 1, 'the probe is not SECURITY DEFINER');
    assert.equal((psql.match(/\nSET search_path = public\n/g) ?? []).length, 2, 'search_path not pinned on both');
    const sig = 'fn_blocking_supplier_lens(int)';
    assert.ok(psql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC;`), 'PUBLIC not revoked');
    assert.ok(psql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon;`), 'anon not revoked');
    assert.ok(psql.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO authenticated;`), 'authenticated missing');
    // service_role appears for the PROBE and nowhere else — a ₱-bearing lens the worker
    // could read would break `verify-worker-view-grants`' 4-views/0-findings state.
    assert.equal((psql.match(/TO service_role/g) ?? []).length, 1, 'service_role granted beyond the probe');
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      assert.ok(
        psql.includes(`REVOKE EXECUTE ON FUNCTION public.fn_blocking_supplier_lens_probe() FROM ${role};`),
        `probe: ${role} not revoked`,
      );
    }
    // Both COMMENTs re-applied, and the lens's one NAMES the ₱ keys — a ₱-bearing function
    // whose COMMENT does not say so is how a reader learns the wrong thing.
    assert.ok(psql.includes('COMMENT ON FUNCTION public.fn_blocking_supplier_lens(int) IS'), 'no lens COMMENT');
    assert.ok(psql.includes('COMMENT ON FUNCTION public.fn_blocking_supplier_lens_probe() IS'), 'no probe COMMENT');
    const cm = psql.slice(psql.indexOf('COMMENT ON FUNCTION public.fn_blocking_supplier_lens(int) IS'));
    for (const needle of ['kg_weighted_php_kg', 'priced_dominant_kg', 'CARRIES MONEY', 'canViewPrices']) {
      assert.ok(cm.includes(needle), `the lens COMMENT does not name "${needle}"`);
    }
  });

  check('the price comes from the GRID\'S OWN column — never a second definition of cost', () => {
    // `view_blocking_grid.avg_php_kg` is the very column the Blocking cell displays. Reading
    // `deliveries.cost_basis` here would be a second "what did this block cost".
    assert.ok(/g\.avg_php_kg/.test(pcode), 'the migration does not read view_blocking_grid.avg_php_kg');
    assert.ok(!/cost_basis/.test(pcode), 'cost_basis is read — that is a second cost definition');
    // and identity is STILL owned by the view, exactly as before.
    assert.ok(!/canonical_supplier\s*\(/.test(pcode), 'canonical_supplier() is CALLED — a second identity rule');
    assert.ok(!/split_part\s*\(/.test(pcode), "the ' - ' origin strip is re-spelled here");
  });

  check('the L-008 UNPRICED predicate is the price lens\'s, word for word', () => {
    // If these two ever diverge, the two lenses disagree about which blocks have a price —
    // and a ₱0 placeholder averaged in understates the figure in proportion to how much of
    // the band is awaiting a price (the ₱11.01-vs-₱39.99 avg_cost bug).
    const PRED = '(g.avg_php_kg IS NULL OR g.avg_php_kg <= 0)';
    assert.ok(pcode.includes(PRED), `the unpriced predicate is not spelled ${PRED}`);
    assert.ok(
      read(PRICE_WTD_MIGRATION).includes(PRED),
      'fn_blocking_price_lens no longer spells the unpriced predicate this way — the reuse claim is stale',
    );
    // The mean must EXCLUDE them, not COALESCE them to 0.
    assert.ok(
      /FILTER \(WHERE NOT d\.unpriced\)/.test(pcode) && /FILTER \(WHERE NOT unpriced\)/.test(pcode),
      'the weighted mean is not FILTERed to priced blocks',
    );
    assert.ok(
      !/COALESCE\s*\(\s*g\.avg_php_kg\s*,\s*0\s*\)/.test(pcode),
      'avg_php_kg is COALESCEd to 0 — that is the L-008 placeholder treated as a real ₱0',
    );
  });

  check('NULL IS NEVER 0 on the price, and the WEIGHT is never null-preserving', () => {
    // The price divides by NULLIF(weight, 0), so an empty band yields NULL rather than a
    // division error or a fabricated 0…
    assert.ok(
      /NULLIF\(sum\(d\.block_kg\) FILTER \(WHERE NOT d\.unpriced\), 0\)/.test(pcode),
      'the band price does not guard its denominator with NULLIF',
    );
    // …and it is published WITHOUT a COALESCE, while the weight is published WITH one.
    assert.ok(
      /d\.wtd_php\s+AS kg_weighted_php_kg/.test(pcode),
      'kg_weighted_php_kg is not published NULL-preserving',
    );
    assert.ok(
      /COALESCE\(d\.priced_kg, 0\)\s+AS priced_dominant_kg/.test(pcode),
      'priced_dominant_kg is not COALESCEd to a real 0 — "zero priced kilograms" is a measurement',
    );
  });

  check('the POPULATION is the band\'s DOMINANT blocks, and the file says why', () => {
    // Weighting a block's own price by an APPORTIONED slice would put a pro-rata estimate
    // inside a money figure — and would not be the price of the kilograms on its own row.
    assert.ok(/FROM dom d\n/.test(pcode), 'the per-band aggregate does not read the dominance CTE');
    assert.ok(
      !/x_ap_kg\s*\*\s*.*avg_php_kg|avg_php_kg\s*\*\s*.*x_ap_kg|bal_kg\s*\*\s*.*avg_php_kg/.test(pcode),
      'the price is weighted by APPORTIONED kg — that weights a real price by an estimate',
    );
    // The reasoning has to survive in the file, because it is the question a future reader
    // will ask first.
    // Case-insensitive and tolerant of the doubled apostrophe, because this sentence appears
    // BOTH in the header prose and inside the SQL-quoted COMMENT body.
    assert.ok(
      /not the price of this supplier''?s charcoal/i.test(psql),
      'the migration no longer states what the figure is NOT',
    );
    assert.ok(/MEASURED RATHER THAN ESTIMATED/.test(psql), 'the migration no longer says why dominance was chosen');
  });

  check('the ₱-key migration records its measured COST and its honest buffer delta', () => {
    // The 2026-09-14 rule: EXPLAIN under a 5 s timeout BEFORE the proofs. And the number
    // that moved is reported rather than rounded away.
    assert.ok(/statement_timeout='5s'/.test(psql), 'no 5 s-timeout cost measurement is recorded');
    assert.ok(/EXPLAIN \(ANALYZE, BUFFERS\)/.test(psql), 'no EXPLAIN (ANALYZE, BUFFERS) measurement');
    assert.ok(/680 buffers/.test(psql), 'the core-query buffer figure is missing');
    assert.ok(/plpgsql PLANNING/.test(psql), 'the +120-buffer delta is not attributed');
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

  check('fetchBlockingSupplierLens GATES — by NULLING exactly two keys, never by refusing', () => {
    // INVERTED 2026-09-22. This assertion used to require the gate's ABSENCE, which was right
    // while the payload carried no money. Two keys are money now, so the gate is mandatory —
    // but it must stay a NULLING, because the rest of the payload is still wanted by
    // Production, THE ROLE THAT WALKS THE YARD, and a refusal would take the whole lens away.
    assert.ok(
      /canViewPricesGate\(\)/.test(supBody),
      'the supplier lens no longer gates — its two ₱ keys would reach a price-denied reader',
    );
    // NOT a refusal: the price lens's `prices_hidden` reason must not appear here, and the
    // action's refusal union must not have grown it (checked against the TYPES too, below).
    assert.ok(
      !/prices_hidden/.test(supBody),
      'a prices_hidden REFUSAL appeared — this lens nulls two keys and still returns the rest',
    );
    // Exactly the two keys, and both of them.
    assert.ok(
      supBody.includes('kgWeightedPhpKg: canView ? lensNumOrNull(b.kg_weighted_php_kg) : null'),
      'the band price is not nulled for a price-denied caller',
    );
    assert.ok(
      supBody.includes('pricedDominantKg: canView ? lensNumOrNull(b.priced_dominant_kg) : null'),
      'the band price WEIGHT is not nulled for a price-denied caller',
    );
    assert.ok(
      supBody.includes('kgWeightedPhpKg: canView ? lensNumOrNull(res.total?.kg_weighted_php_kg) : null'),
      "total's price is not nulled for a price-denied caller",
    );
    assert.ok(
      supBody.includes('pricedDominantKg: canView ? lensNumOrNull(res.total?.priced_dominant_kg) : null'),
      "total's price WEIGHT is not nulled for a price-denied caller",
    );
    assert.ok(supBody.includes('pricesHidden: !canView'), 'the payload does not say the prices were withheld');
    // Every `canView ?` in the body must be one of those four — i.e. the gate touches NOTHING
    // else. A fifth would mean a non-money field started depending on the reader's role.
    assert.equal((supBody.match(/canView \?/g) ?? []).length, 4, 'the gate nulls something other than the two keys');
  });

  check('the gate FAILS CLOSED, and runs after the session check', () => {
    // A throw from the gate must read as "cannot see prices", never as "can".
    assert.ok(/let canView = false;/.test(supBody), 'canView does not start false');
    assert.ok(
      /catch \{\n\s*canView = false;\n\s*\}/.test(supBody),
      'the gate does not fail closed on a throw',
    );
    // Order: session first (a signed-out caller gets a session refusal, not a price answer),
    // then the RPC, then the gate beside the payload assembly. The gate's position relative
    // to the RPC is NOT a security question here — the RPC result is nulled either way — and
    // this placement is the `fetchBlendAnalysis` idiom, which also returns a partial payload.
    // It IS a security question for fetchBlockingPriceLens, asserted separately below.
    const authAt = supBody.indexOf('auth.getUser()');
    const rpcAt = supBody.indexOf('.rpc(');
    const gateAt = supBody.indexOf('canViewPricesGate()');
    const bandsAt = supBody.indexOf('const bands:');
    assert.ok(authAt > 0 && authAt < rpcAt, 'the RPC is called BEFORE the session check');
    assert.ok(gateAt > 0 && gateAt < bandsAt, 'the gate runs AFTER the payload is assembled');
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
      ['the ₱-key migration name', '20260922051500_blocking_supplier_lens_weighted_price'],
      ['the gate, as a NULLING of two keys', 'THE PRICE GATE IS A NULLING OF EXACTLY TWO KEYS'],
      ['the band price key', 'kgWeightedPhpKg'],
      ['the price WEIGHT key', 'pricedDominantKg'],
      ['the withheld flag', 'pricesHidden'],
      ['what the price is NOT', 'NOT THE PRICE OF THIS SUPPLIER'],
      ['the L-008 unpriced rule', 'L-008'],
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

  check('the types carry the TWO ₱ keys, the pricesHidden flag, and NO prices_hidden refusal', () => {
    // The frontend builds against this file, so the whole ₱ contract has to be legible here:
    // what the figure IS, what it is NOT, and how a withheld blank differs from a measured one.
    assert.ok(types.includes('kgWeightedPhpKg: number | null'), 'the band price is not in the contract');
    assert.ok(types.includes('pricedDominantKg: number | null'), 'the price WEIGHT is not in the contract');
    assert.ok(types.includes('pricesHidden: boolean'), 'the withheld flag is not in the contract');
    // The refusal union must NOT have grown a price reason: a denied reader gets a payload.
    const unionAt = types.indexOf('export type BlockingSupplierLensRefusalReason');
    assert.ok(unionAt > 0, 'the refusal union is gone');
    const union = types.slice(unionAt, types.indexOf(';', types.indexOf('|', unionAt) + 1) + 1);
    assert.ok(
      !/prices_hidden/.test(union),
      'a prices_hidden refusal reason appeared — this lens nulls two keys instead of refusing',
    );
    // …and the two sentences that stop a UI printing the figure as something it is not.
    assert.ok(
      /NOT the price of this supplier's charcoal/i.test(types),
      'the contract no longer says what the weighted price is NOT',
    );
    assert.ok(
      /Read `pricesHidden` to tell them\s*\n?\s*\*?\s*apart/i.test(types) || /Read `pricesHidden`/.test(types),
      'the contract no longer tells a reader how to distinguish withheld from measured-absent',
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

  // --- (b) MONEY LIVES IN EXACTLY TWO KEYS, AND NOWHERE ELSE ---
  const lens = obj(probe, 'lens_default');
  /** The two keys the 2026-09-22 change added. Everything else must stay money-free. */
  const MONEY_KEYS = ['kg_weighted_php_kg', 'priced_dominant_kg'];

  check('EXACTLY TWO money-named keys in the payload — and they are the expected two', () => {
    // CHANGED 2026-09-22: this used to require ZERO. It is now an EXACT SET, which is a
    // stronger statement than either extreme — it says money arrived where it was meant to
    // and nowhere else. Scanned recursively, so a money key nested inside `bands[]`,
    // `blocks[]` or a `suppliers[]` slice could not hide.
    const keys = new Set<string>();
    collectKeys(lens, keys);
    const offenders = [...keys].filter((k) => MONEY_KEY_RE.test(k)).sort();
    assert.deepEqual(
      offenders,
      [...MONEY_KEYS].sort(),
      `the money-named keys in the supplier payload are not exactly the two expected: ${offenders.join(', ')}`,
    );
    assert.ok(keys.size > 15, 'the key scan found almost nothing — it is not actually walking the payload');
  });

  check('the two ₱ keys are on BANDS and TOTAL only — never on a block or a supplier slice', () => {
    // A per-block or per-slice price would be a DIFFERENT statistic (and a per-supplier price
    // does not exist — `rc_out` records which BATCH kilos left, never whose). It would also
    // put money on the tint map, which is what the gate deliberately leaves alone.
    for (const b of arr(lens, 'bands')) {
      for (const k of MONEY_KEYS) assert.ok(k in b, `band ${b.index} is missing ${k}`);
    }
    for (const k of MONEY_KEYS) assert.ok(k in obj(lens, 'total'), `total is missing ${k}`);
    for (const blk of arr(lens, 'blocks')) {
      const keys = new Set<string>();
      collectKeys(blk, keys);
      const offenders = [...keys].filter((k) => MONEY_KEY_RE.test(k));
      assert.deepEqual(offenders, [], `block ${blk.block_loc} carries money-named keys: ${offenders.join(', ')}`);
    }
    // `unattributed` has no price either: a block with no delivery has no price to average.
    const unattrKeys = new Set<string>();
    collectKeys(obj(lens, 'unattributed'), unattrKeys);
    assert.deepEqual([...unattrKeys].filter((k) => MONEY_KEY_RE.test(k)), [], 'unattributed carries a money key');
  });

  check('the ONLY keys that changed are those two — the band/total key SETS grew by exactly them', () => {
    // The structural form of the byte-equality measurement recorded in the migration header
    // (old payload captured before applying, compared key by key with the new keys removed:
    // 0 differing keys on N=1, 6 and 12). This is the part that keeps holding as the yard
    // moves: a THIRD key appearing in either object is a payload change nobody asked for.
    const BAND_KEYS_BEFORE = [
      'index', 'key', 'display', 'is_others', 'supplier_count', 'supplier_keys',
      'dominant_block_count', 'dominant_kg', 'apportioned_kg', 'apportioned_delivered_kg',
      'kg_share_pct', 'block_share_pct', 'mixed_block_count',
    ];
    const TOTAL_KEYS_BEFORE = [
      'block_count', 'kg', 'supplier_count', 'mixed_block_count',
      'attributed_block_count', 'attributed_kg',
    ];
    const expectBand = [...BAND_KEYS_BEFORE, ...MONEY_KEYS].sort();
    const expectTotal = [...TOTAL_KEYS_BEFORE, ...MONEY_KEYS].sort();
    for (const b of arr(lens, 'bands')) {
      assert.deepEqual(Object.keys(b).sort(), expectBand, `band ${b.index} has an unexpected key set`);
    }
    assert.deepEqual(Object.keys(obj(lens, 'total')).sort(), expectTotal, 'total has an unexpected key set');
    // and the per-block shape did not move at all
    assert.deepEqual(
      Object.keys(arr(lens, 'blocks')[0]).sort(),
      ['band_index', 'batch_code', 'batch_id', 'block_loc', 'dominant_share_pct',
       'dominant_supplier_display', 'dominant_supplier_key', 'is_mixed', 'kg', 'supplier_count', 'suppliers'],
      'the per-block shape changed',
    );
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

  // The band table's NEW last column, which is the whole point of the 2026-09-22 change. The
  // WEIGHT is printed beside the price on purpose: a price covering only part of a band is
  // exactly what `priced_dominant_kg` exists to expose, and a reader must see it.
  const php = (v: unknown): string => (v === null || v === undefined ? '—' : Number(v).toFixed(4));
  console.log('\n  the weighted price per band (₱/kg over PRICED dominant blocks) --');
  for (const b of bands) {
    const name = b.is_others === true ? `OTHERS (${b.supplier_count})` : String(b.display ?? b.key);
    const covered =
      Number(b.dominant_kg) > 0
        ? `${((Number(b.priced_dominant_kg) / Number(b.dominant_kg)) * 100).toFixed(2)}%`
        : 'n/a';
    console.log(
      `    band ${b.index}  ${name.padEnd(18)}` +
        `${php(b.kg_weighted_php_kg).padStart(9)} /kg over ` +
        `${Number(b.priced_dominant_kg).toLocaleString('en-US').padStart(11)} priced kg of ` +
        `${Number(b.dominant_kg).toLocaleString('en-US').padStart(11)}  (${covered} covered)`,
    );
  }
  console.log(
    `    TOTAL        ${''.padEnd(18)}${php(total.kg_weighted_php_kg).padStart(9)} /kg over ` +
      `${Number(total.priced_dominant_kg).toLocaleString('en-US').padStart(11)} priced kg of ` +
      `${Number(total.kg).toLocaleString('en-US').padStart(11)}  (whole yard)`,
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

  check('the PRICED WEIGHT folds to total EXACTLY, at every N (SQL, exact decimal)', () => {
    // ADDED 2026-09-22. `priced_dominant_kg` is a plain sum of balances over a partition of
    // the attributed blocks, so unlike `apportioned_kg` it can and must be exactly 0 — there
    // is no division anywhere in it.
    const folds = obj(probe, 'folds');
    for (const label of ['n1', 'n6', 'n12']) {
      const f = obj(folds, label);
      assert.equal(
        Number(f.gap_priced_dominant_kg),
        0,
        `${label}: SQL says the priced-weight fold gap is ${f.gap_priced_dominant_kg}, not 0`,
      );
    }
  });

  // --- (d2) THE WEIGHTED PRICE, AGAINST AN INDEPENDENT RECOMPUTATION ---
  const priceCheck = obj(probe, 'price_check');

  check('every band\'s kg_weighted_php_kg EQUALS Σ(balance × the grid\'s own ₱/kg) ÷ Σ(balance)', () => {
    // THE proof of the only new arithmetic in this change. The probe recomputed the mean
    // longhand off `view_blocking_grid` over the PRICED blocks of each band, in exact
    // `numeric`, and returned the GAP — so this is an agreement between two computations, not
    // a re-reading of one. A non-zero gap here means the published figure is not the weighted
    // price of the kilograms on its own row, which is the ₱11.01-vs-₱39.99 shape.
    const rows = arr(priceCheck, 'bands');
    assert.equal(rows.length, bands.length, `price_check covers ${rows.length} bands, the lens publishes ${bands.length}`);
    for (const r of rows) {
      const bothNull = r.published_wtd_is_null === true && r.independent_wtd_is_null === true;
      if (bothNull) {
        // Legitimate only when the band has no priced block at all — and then the WEIGHT must
        // read a real 0, never null.
        assert.equal(Number(r.priced_block_count), 0, `band ${r.band_index}: NULL price with priced blocks present`);
        assert.equal(Number(r.priced_kg), 0, `band ${r.band_index}: NULL price beside non-zero priced kg`);
        continue;
      }
      assert.equal(
        r.published_wtd_is_null,
        r.independent_wtd_is_null,
        `band ${r.band_index}: one side is NULL and the other is not — the populations disagree`,
      );
      assert.equal(
        Number(r.gap_wtd_php),
        0,
        `band ${r.band_index}: SQL says the weighted-price gap is ${r.gap_wtd_php}, not 0`,
      );
      assert.equal(
        Number(r.gap_priced_kg),
        0,
        `band ${r.band_index}: SQL says the priced-weight gap is ${r.gap_priced_kg}, not 0`,
      );
    }
    console.log(`    weighted price: ${rows.length} bands vs an independent recomputation, 0 gaps`);
  });

  check('total\'s weighted price and weight agree too, and Σ bands folds to it exactly', () => {
    const t = obj(priceCheck, 'total');
    assert.equal(
      t.published_wtd_is_null,
      t.independent_wtd_is_null,
      'total: one side is NULL and the other is not',
    );
    if (t.published_wtd_is_null !== true) {
      assert.equal(Number(t.gap_wtd_php), 0, `total: weighted-price gap is ${t.gap_wtd_php}, not 0`);
    }
    assert.equal(Number(t.gap_priced_kg), 0, `total: priced-weight gap is ${t.gap_priced_kg}, not 0`);
    assert.equal(
      Number(t.gap_band_fold_priced_kg),
      0,
      `Σ bands[].priced_dominant_kg misses total by ${t.gap_band_fold_priced_kg}`,
    );
  });

  check('total\'s price covers the PRICED blocks while its counts cover the WHOLE yard', () => {
    // The deliberate asymmetry `fn_blocking_price_lens` records, carried across. If
    // `priced_dominant_kg` ever equalled `total.kg` by CONSTRUCTION rather than by today's
    // data, the L-008 exclusion would have been silently dropped.
    assert.ok(
      Number(total.priced_dominant_kg) <= Number(total.kg) + 1e-6,
      'the priced weight exceeds the whole yard — the population is wrong',
    );
    assert.equal(
      Number(total.priced_dominant_kg),
      Number(grid.priced_kg),
      "total's priced weight disagrees with the grid's own priced kilograms",
    );
    // An UNATTRIBUTED block cannot carry a price (no deliveries ⇒ no avg_php_kg), which is
    // why total's attributed-only population and the yard's priced population coincide.
    // MEASURED here rather than assumed.
    assert.equal(
      n(priceCheck, 'unattributed_priced_count'),
      0,
      'an unattributed block carries a price — total\'s population would then be understated',
    );
    const unpricedKg = Number(total.kg) - Number(total.priced_dominant_kg);
    const unpricedBlocks = n(total, 'block_count') - n(grid, 'priced_count');
    if (unpricedBlocks === 0) {
      console.log(
        '      (note: all 170 blocks carry a price today — the NULL/partial-coverage branch is ' +
          'proven by the SQL text and the invariants, not by live data)',
      );
    } else {
      console.log(
        `      (${unpricedBlocks} unpriced block(s) holding ` +
          `${unpricedKg.toLocaleString('en-US')} kg are excluded from the price — L-008)`,
      );
    }
  });

  check('a band with NO priced block reads a NULL price beside a REAL 0 weight', () => {
    // NULL ≠ 0, in the one place it is expensive. Live data may not contain such a band
    // (today it does not), so the assertion is stated over whatever the data offers and the
    // SQL text is checked instead when it offers none — never silently skipped.
    const empty = arr(priceCheck, 'bands').filter((r) => Number(r.priced_block_count) === 0);
    if (empty.length === 0) {
      const pcode = executableSql(read(PRICE_KEYS_MIGRATION));
      assert.ok(
        /NULLIF\(sum\(d\.block_kg\) FILTER \(WHERE NOT d\.unpriced\), 0\)/.test(pcode),
        'no band is unpriced today AND the NULLIF guard is gone — the branch is unproven',
      );
      console.log('      (no band lacks a priced block today; the NULL branch is proven from the SQL)');
      return;
    }
    for (const r of empty) {
      const b = bands.find((x) => Number(x.index) === Number(r.band_index))!;
      assert.equal(b.kg_weighted_php_kg, null, `band ${r.band_index}: no priced block but a non-NULL price`);
      assert.equal(Number(b.priced_dominant_kg), 0, `band ${r.band_index}: no priced block but a non-zero weight`);
    }
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

  check('the AGE lens payload still carries NO money at all — the asymmetry is THREE-WAY', () => {
    // The three lenses now sit at three different points, and each is right for its own
    // payload: PRICE refuses a denied caller outright (band membership IS price), SUPPLIER
    // nulls two keys and returns the rest, AGE has no gate because it has no money. Flattening
    // any of the three is what this assertion exists to catch — in particular, the supplier
    // lens gaining a ₱ key is NOT a licence to add one here.
    const ageLens = obj(ageProbe, 'lens_default');
    const keys = new Set<string>();
    collectKeys(ageLens, keys);
    const offenders = [...keys].filter((k) => MONEY_KEY_RE.test(k));
    assert.deepEqual(offenders, [], `the age lens grew money-named keys: ${offenders.join(', ')}`);
    assert.ok(keys.size > 10, 'the age-lens key scan found almost nothing — it is not walking the payload');
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
