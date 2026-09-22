/**
 * verify-blend-analysis.ts — the proofs behind the BLEND PROPOSAL ANALYSIS pages.
 *
 * Run: npx tsx scripts/verify-blend-analysis.ts
 *
 * ============================================================================
 * WHAT THE FEATURE IS, AND WHAT CAN GO WRONG WITH IT
 * ============================================================================
 * Renzo, 2026-09-21: a saved blend proposal should carry extra pages, on screen and in
 * print, that "group and arrange blocks according to high priced and low priced and
 * average priced … a statistical way of properly grouping these as something we can
 * objectively agree to be high and low", another page for MC / ash / BD, maybe age, and
 * tables "with footers that show totals or averages when appropriate".
 *
 * `fn_blend_analysis` (migration `20260921084500_blend_analysis_natural_breaks`) answers
 * that in three sections over ONE grouping method, `fn_natural_breaks_3`. Almost nothing
 * in it is a new number — the blend's own figures come from the stored snapshot or from
 * `fn_blend_proposal_snapshot`, age comes from `view_batch_age_days`, and "above market"
 * comes from `fn_blocking_price_lens` — so the failure modes worth testing are the six
 * this codebase keeps meeting:
 *
 *   NOT OPTIMAL   a "natural breaks" that is really a heuristic, so the groups are not the
 *                 ones the method promises. PROVEN by BRUTE FORCE in TypeScript over the
 *                 returned values: no other cut pair has a lower weighted within-SS, and
 *                 the documented tie-break picks the same pair.
 *   SECOND TRUTH  a footer that disagrees with the blend the operator saved. PROVEN: the
 *                 overall weighted price and all four weighted lab stats equal the stored
 *                 snapshot's own figures with gap EXACTLY 0, and the live source equals
 *                 `fn_blend_proposal` called directly.
 *   SECOND AGE    these ages becoming a rival to `view_batch_age_days.age_days` (what the
 *                 Age lens reads). PROVEN equal on every block, gap exactly 0.
 *   SECOND LENS   "above market" meaning something different here from the Blocking grid.
 *                 PROVEN: the same blocks land in the same bands as
 *                 `fn_blocking_price_lens` for the same market price, R and edges.
 *   NULL ≠ 0      a lab reading of 0 (the COALESCE placeholder) grouped as the CLEANEST
 *                 block in the blend, or an unpriced block as the cheapest — the
 *                 ₱11.01-vs-₱39.99 `avg_cost` bug. PROVEN on a REAL block discovered live.
 *   PRICE LEAK    the price half reaching a role that may not see money. PROVEN twice:
 *                 statically, that the action DELETES the whole section rather than nulling
 *                 fields; and on the live payload, that no money-named key exists outside
 *                 it, so the deletion is sufficient rather than hopeful.
 *
 * ============================================================================
 * WHY THE NUMBERS COME FROM TWO PROBE RPCs AND NOT FROM DIRECT CALLS
 * ============================================================================
 * `fn_blend_analysis` and `fn_natural_breaks_3` are `authenticated`-only BY DESIGN (`anon`
 * revoked, `service_role` deliberately NOT granted so `verify-worker-view-grants` stays at
 * 4 views / 0 findings), and no verify script in this repo holds a user JWT. Worse,
 * `service_role` holds NOTHING AT ALL on `blend_proposals` / `blend_proposal_versions`, so
 * this script cannot even find out which saved versions exist. Two SECURITY DEFINER,
 * service_role-only bridges solve that — the same idiom as the ops-ledger and both lens
 * scripts:
 *
 *   fn_blend_analysis_probe(proposal_id, version_no)  ONE named version, both arguments
 *       required, so it is structurally impossible to point it at all of history.
 *   fn_blend_analysis_probe_cases()                   the version INDEX plus the degenerate
 *       and unmeasured cases, DISCOVERED from the grid rather than hardcoded.
 *
 * BOTH PROBES ASSERT NOTHING. Every assertion below is TypeScript a human can read. They
 * are deliberately NOT whole-database verifiers: the 2026-09-14 `fn_ops_ledger_verify()`
 * incident (one statement cross-checking every ops-ledger view over all of history) OOM-ed
 * the instance and took the live site down.
 *
 * MEASURED 2026-09-21 with `set local statement_timeout='5s'` then
 * EXPLAIN (ANALYZE, BUFFERS):
 *   fn_natural_breaks_3, 250 distinct values (31,125 candidates)      57.7 ms /   754 buf
 *   fn_natural_breaks_3, 1,000 values — the hard cap (499,500)       726.5 ms
 *   fn_blend_analysis, the owner's SAVED 24-block version             39.5 ms / 2,220 buf
 *   fn_blend_analysis, LIVE over all 170 occupied blocks             211.9 ms / 2,931 buf
 *   fn_blend_analysis, LIVE over a realistic 3 blocks                 43.2 ms / 3,023 buf
 * The ceiling below is a SHAPE alarm, not a latency SLO — see PROBE_MS_BUDGET.
 *
 * ============================================================================
 * ₱ IN THIS SCRIPT'S OUTPUT
 * ============================================================================
 * YES — the price section is money, so both probes are service_role-only and the sample
 * printed at the end carries ₱/kg. That is the opposite of verify-blocking-age-lens and
 * verify-blend-block-facts, and it is why the price half of the payload is DELETED by the
 * server action for a role that may not see it.
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

const MIGRATION = 'supabase/migrations/20260921084500_blend_analysis_natural_breaks.sql';
const ACTIONS = 'app/(app)/inventory/blocking/actions.ts';
const TYPES = 'app/(app)/inventory/blocking/types.ts';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

/**
 * Anything whose NAME would make a reader think it carries money. `value_php` rather than
 * a bare `value` is deliberate: the quality section's own reading IS called `value` (a
 * moisture percentage, an ash percentage, a bulk density) and that is not money, while
 * `value_php` — Σ kg × ₱/kg — is. The scan's job is to find money, not the word "value".
 */
const MONEY_KEY_RE = /php|peso|cost|price|value_php|amount/i;

/**
 * A SHAPE alarm, not a performance SLO — the distinction is why it is this loose. What it
 * must catch is one call walking a whole-history population; what it must NOT fire on is
 * instance load, and the wall-clock here is round-trip dominated (verify-ops-ledger records
 * a probe costing 280 ms server-side reading 4,671 ms from a laptop). The per-version probe
 * makes ~25 analysis calls plus the unit cases, so a couple of seconds of server work is the
 * honest expectation and 25 s is an order of magnitude above it.
 */
const PROBE_MS_BUDGET = 25_000;

// ---------------------------------------------------------------------------
// 1. STATIC — the migration's posture and reuse, and the ACTION's price gate
// ---------------------------------------------------------------------------
function staticChecks(): void {
  console.log('\nstatic (migration + server action + types, no network) ------------');

  const sql = read(MIGRATION);

  check('fn_natural_breaks_3 is IMMUTABLE, PARALLEL SAFE and pins search_path', () => {
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_natural_breaks_3(');
    assert.ok(at > 0, 'the function is not in the migration');
    const head = sql.slice(at, at + 600);
    assert.ok(/\nLANGUAGE plpgsql\n/.test(head), 'not LANGUAGE plpgsql');
    assert.ok(/\nIMMUTABLE\n/.test(head), 'not IMMUTABLE');
    assert.ok(/\nPARALLEL SAFE\n/.test(head), 'not PARALLEL SAFE');
    assert.ok(/\nSET search_path = public\n/.test(head), 'search_path not pinned');
  });

  /** The bodies, comment lines stripped, so a rule quoted in prose cannot pass for code. */
  function bodyOf(marker: string): string {
    const at = sql.indexOf(marker);
    assert.ok(at > 0, `${marker} not found`);
    const start = sql.indexOf('AS $$', at);
    const end = sql.indexOf('\n$$;', start);
    assert.ok(start > 0 && end > start, `could not isolate the body after ${marker}`);
    return sql
      .slice(start, end)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
  }

  const nbBody = bodyOf('CREATE OR REPLACE FUNCTION public.fn_natural_breaks_3(');

  check('fn_natural_breaks_3 touches NO TABLE — it is pure maths', () => {
    // IMMUTABLE is a promise about tables as much as about the clock. generate_series and
    // unnest are the only relations it may read from.
    assert.ok(!/\bFROM\s+public\./i.test(nbBody), 'it reads a public relation');
    assert.ok(!/\bview_/i.test(nbBody), 'it reads a view');
    assert.ok(!/\bnow\s*\(/i.test(nbBody), 'it reads the clock — that is not IMMUTABLE');
  });

  check('the OPTIMAL search enumerates every legal cut PAIR (not a heuristic)', () => {
    assert.ok(
      /FROM unnest\(v_bp\) AS ba\(p\) CROSS JOIN unnest\(v_bp\) AS bb\(p\)/.test(nbBody),
      'the pairwise enumeration moved — this may no longer be exact',
    );
    assert.ok(/WHERE ba\.p < bb\.p/.test(nbBody), 'the a < b constraint is gone');
  });

  check('THE TIE-BREAK is in the ORDER BY, and it is (score, a, b)', () => {
    assert.ok(
      /ORDER BY c\.w_ss ASC, c\.a ASC, c\.b ASC/.test(nbBody),
      'the documented tie-break moved — two calls on identical data could now disagree',
    );
  });

  check('cut positions sit only BETWEEN TWO DISTINCT ADJACENT VALUES', () => {
    assert.ok(
      /WHERE v_x\[g\.p\] < v_x\[g\.p \+ 1\]/.test(nbBody),
      'the breakpoint rule moved — a cut could now split a tie',
    );
  });

  check('the SEARCH runs on float8 prefix sums and the REPORTED figures on numeric', () => {
    // A numeric[] element is varlena, so arr[k] walks the array and "O(1) per candidate"
    // is false: MEASURED 279 ms at 250 values on numeric against 57.7 ms on float8.
    assert.ok(/v_fw\s+double precision\[\]/.test(sql), 'the float8 prefix arrays are gone');
    assert.ok(/v_fq\[ba\.p\+1\]/.test(nbBody), 'the search no longer reads the float8 arrays');
    assert.ok(/v_gss := greatest\(v_gq - v_gs \* v_gs \/ v_gw, 0\)/.test(nbBody),
      'the per-group figures are no longer recomputed in exact numeric');
  });

  check('gvf is NULL — never 0 — when there is no variance to explain', () => {
    assert.ok(
      /'gvf', CASE WHEN v_total_ss > 0 THEN 1 - v_within \/ v_total_ss END/.test(nbBody),
      'the gvf guard moved — a single-valued blend would read 0 instead of blank',
    );
  });

  check('the label vocabulary is CLOSED to low / mid / high', () => {
    assert.ok(/ARRAY\['low','mid','high'\]/.test(nbBody), 'the 3-group labels moved');
    assert.ok(/ARRAY\['low','high'\]/.test(nbBody), 'the 2-group labels moved');
    assert.ok(/ELSE 'mid' END/.test(nbBody), 'the single-group label moved');
  });

  const anBody = bodyOf('CREATE OR REPLACE FUNCTION public.fn_blend_analysis(');

  check('fn_blend_analysis is STABLE, SECURITY INVOKER and pins search_path', () => {
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_blend_analysis(');
    const head = sql.slice(at, at + 1200);
    assert.ok(/\nLANGUAGE plpgsql\n/.test(head), 'not LANGUAGE plpgsql');
    assert.ok(/\nSTABLE\n/.test(head), 'not STABLE');
    assert.ok(/\nSECURITY INVOKER\n/.test(head), 'not SECURITY INVOKER');
    assert.ok(/\nSET search_path = public\n/.test(head), 'search_path not pinned');
  });

  check('the migration does NOT touch the SAVED proposal feature', () => {
    // THE decision this whole job turns on: a stored snapshot is immutable and HASHED, so
    // the analysis is RECONSTRUCTED from it rather than added to it.
    for (const bad of [
      'CREATE OR REPLACE FUNCTION public.fn_blend_proposal_snapshot',
      'CREATE OR REPLACE FUNCTION public.fn_blend_snapshot_hash',
      'CREATE OR REPLACE FUNCTION public.fn_save_blend_proposal',
      'ALTER TABLE public.blend_proposal_versions',
      'ALTER TABLE public.blend_proposals',
      'UPDATE public.blend_proposal_versions',
      'UPDATE blend_proposal_versions',
      'DROP FUNCTION',
    ]) {
      assert.ok(!sql.includes(bad), `the migration modifies something it must not (${bad})`);
    }
  });

  check('the LIVE source calls the ONE existing builder, and restates none of it', () => {
    assert.ok(
      anBody.includes('public.fn_blend_proposal_snapshot(v_locs)'),
      'the live path no longer goes through fn_blend_proposal_snapshot',
    );
    // ...and the blend's own weighted stats / raw price are LIFTED from the snapshot, never
    // recomputed as a rival definition.
    assert.ok(anBody.includes("(v_snapshot ->> 'raw_price_per_kg')::numeric"), 'the raw price is not lifted');
    assert.ok(anBody.includes("(v_snapshot -> 'weighted' ->> v_metric)::numeric"), 'the weighted stats are not lifted');
  });

  check('AGE is view_batch_age_days’ own expression, narrowed to the as-of date', () => {
    assert.ok(anBody.includes("'2000-01-01'::date)::numeric"), 'the day-number epoch moved');
    assert.ok(
      anBody.includes('/ NULLIF(sum(d.weight_kg), 0::numeric) AS mean_daynum'),
      'the kg-weighted-mean-delivery-date denominator moved',
    );
    assert.ok(anBody.includes('d.transaction_date <= v_as_of'), 'the as-of window is not <= the date');
    assert.ok(anBody.includes('d.transaction_date IS NOT NULL'), 'an undated delivery is no longer excluded');
  });

  check('THE AS-OF DATE is the version’s own created_at in Asia/Manila', () => {
    assert.ok(
      anBody.includes("(v_created_at AT TIME ZONE 'Asia/Manila')::date"),
      'the saved as-of clock moved',
    );
    assert.ok(
      anBody.includes("(now() AT TIME ZONE 'Asia/Manila')::date"),
      'the live as-of clock moved',
    );
  });

  check('an ARCHIVED proposal can still be READ (only writing to one is refused)', () => {
    assert.ok(
      !/archived_at IS NOT NULL/.test(anBody),
      'the analysis refuses an archived proposal — the proposals list shows archived rows',
    );
  });

  check('MARKET is read for the AS-OF MONTH from the ONE definition', () => {
    assert.ok(
      anBody.includes('NULLIF(v.market_avg_price, 0) INTO v_market'),
      'the market statistic is no longer view_analytics_rcin_monthly.market_avg_price',
    );
    assert.ok(
      anBody.includes("date_trunc('month', v_as_of)::date"),
      'market is no longer read for the blend’s own month',
    );
    // A given price IS R; otherwise the measured rule, the same one the price lens uses.
    assert.ok(
      anBody.includes('COALESCE(p_rounded_up_php::numeric, floor(v_market) + 1)'),
      'the R rule moved',
    );
  });

  check('AGE band membership is "how many cut lines has this age passed"', () => {
    // Total by construction, so a NEGATIVE age lands in band 0 instead of matching nothing.
    assert.ok(
      anBody.includes('(SELECT count(*)::int FROM cut WHERE src.age_days >= cut.e) AS bi'),
      'the age membership test moved — a negative age could now vanish from the folds',
    );
  });

  check('the UNMEASURED rule is "NULL or <= 0", on every metric', () => {
    const occurrences = anBody.match(/IS NOT NULL AND src\.val > 0 AND src\.kg > 0/g) ?? [];
    assert.ok(occurrences.length >= 2, `the measured predicate appears ${occurrences.length} times, expected >= 2`);
    assert.ok(
      anBody.includes("count(*) FILTER (WHERE val IS NULL OR val <= 0)::int AS no_value"),
      'the no-value split is gone',
    );
  });

  check('grants: authenticated only on both functions; anon + PUBLIC revoked; no service_role', () => {
    for (const sig of [
      'fn_natural_breaks_3(numeric[], numeric[])',
      'fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int)',
    ]) {
      assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC;`), `${sig}: PUBLIC not revoked`);
      assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon;`), `${sig}: anon not revoked`);
      assert.ok(sql.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO authenticated;`), `${sig}: authenticated missing`);
      assert.ok(
        !new RegExp(`GRANT[^;]*${sig.replace(/[()[\]]/g, '\\$&')}[^;]*service_role`).test(sql),
        `${sig} is granted to service_role — verify-worker-view-grants would grow a finding`,
      );
    }
  });

  check('both probes are service_role-only — authenticated and anon are BOTH revoked', () => {
    for (const sig of ['fn_blend_analysis_probe(uuid, int)', 'fn_blend_analysis_probe_cases()']) {
      for (const role of ['PUBLIC', 'anon', 'authenticated']) {
        assert.ok(
          sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM ${role};`),
          `${sig}: ${role} not revoked`,
        );
      }
      assert.ok(
        sql.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO service_role;`),
        `${sig} is not granted to service_role`,
      );
    }
  });

  check('both functions carry a COMMENT naming the method, the as-of rule and the ₱ split', () => {
    const nbAt = sql.indexOf('COMMENT ON FUNCTION public.fn_natural_breaks_3(numeric[], numeric[]) IS');
    assert.ok(nbAt > 0, 'no COMMENT on fn_natural_breaks_3');
    const nbc = sql.slice(nbAt, nbAt + 8000);
    assert.ok(/natural breaks/i.test(nbc), 'the COMMENT does not name the method');
    assert.ok(/TIE-BREAK IS PART OF THE CONTRACT/.test(nbc), 'the COMMENT does not state the tie-break');
    assert.ok(/gvf/.test(nbc), 'the COMMENT does not explain gvf');

    const anAt = sql.indexOf(
      'COMMENT ON FUNCTION public.fn_blend_analysis(uuid, int, text[], int[], int[], numeric, int) IS',
    );
    assert.ok(anAt > 0, 'no COMMENT on fn_blend_analysis');
    const anc = sql.slice(anAt, anAt + 12000);
    assert.ok(/EXACTLY ONE SOURCE/.test(anc), 'the COMMENT does not state the one-source rule');
    assert.ok(/AS-OF DATE/.test(anc), 'the COMMENT does not explain the as-of rule');
    assert.ok(/NULL IS NEVER 0/.test(anc), 'the COMMENT does not state the NULL rule');
    assert.ok(/MONEY LIVES IN sections\.price ONLY/.test(anc), 'the COMMENT does not state the ₱ boundary');
  });

  // ── §4, the price lens's additive change ──────────────────────────────────
  check('the price lens keeps its 3-arg SIGNATURE and is replaced, never dropped', () => {
    assert.ok(
      sql.includes('CREATE OR REPLACE FUNCTION public.fn_blocking_price_lens(\n  p_market_php_kg  numeric,\n  p_edge_offsets   int[] DEFAULT ARRAY[-1, 0],\n  p_rounded_up_php int   DEFAULT NULL\n)'),
      'the lens signature moved — every existing caller would break',
    );
    assert.ok(!/DROP FUNCTION[^;]*fn_blocking_price_lens/.test(sql), 'the lens is dropped, which discards its grants');
  });

  check('the lens gained kg_weighted_php_kg per BAND and on TOTAL, additive keys only', () => {
    assert.ok(
      sql.includes("sum(c.kg * c.avg_php_kg) / NULLIF(sum(c.kg), 0) AS wtd_php"),
      'the per-band weighted price is not computed',
    );
    assert.ok(sql.includes("'kg_weighted_php_kg', br.wtd_php"), 'the per-band key is not emitted');
    assert.ok(
      sql.includes("'kg_weighted_php_kg', (SELECT p.wtd_php FROM priced p)"),
      'the total key is not weighted over the PRICED population',
    );
    // ...and the `priced` CTE is what defines that population, the same one the two share
    // denominators already use.
    assert.ok(
      /priced AS \(SELECT count\(\*\)::int AS block_count, COALESCE\(sum\(kg\), 0\) AS kg,\s*\n\s*sum\(kg \* avg_php_kg\) \/ NULLIF\(sum\(kg\), 0\) AS wtd_php/.test(sql),
      'the priced CTE no longer carries the weighted price',
    );
  });

  check('the lens’s COMMENT and GRANTS are re-stated in the same file', () => {
    assert.ok(
      sql.includes('COMMENT ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) IS'),
      'the lens COMMENT is not re-applied',
    );
    assert.ok(
      sql.includes('GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) TO authenticated;'),
      'the lens grant is not re-applied',
    );
    const at = sql.indexOf('COMMENT ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) IS');
    const body = sql.slice(at, at + 12000);
    assert.ok(/kg_weighted_php_kg/.test(body), 'the COMMENT does not mention the new key');
    assert.ok(/PRICED population only/.test(body), 'the COMMENT does not state the total’s population');
  });

  // ── the server action ─────────────────────────────────────────────────────
  const actions = read(ACTIONS);
  const anStart = actions.indexOf('export async function fetchBlendAnalysis(');
  assert.ok(anStart > 0, 'fetchBlendAnalysis not found in actions.ts');
  const anAction = actions.slice(anStart);

  check('fetchBlendAnalysis calls the CANONICAL canViewPrices() and fails CLOSED', () => {
    assert.ok(/canViewPricesGate\(\)/.test(anAction), 'no canViewPrices() call — the price half is ungated');
    assert.ok(/let canView = false;/.test(anAction), 'the gate does not default to DENIED');
    assert.ok(/} catch \{\s*\n\s*canView = false;/.test(anAction), 'the gate does not fail closed on an error');
    // It must NOT re-derive visibility from a role lookup (that ignores impersonation).
    assert.ok(!/profiles'\)[\s\S]{0,200}select\('role'\)/.test(anAction), 'a role lookup replaced the helper');
  });

  check('THE GATE IS A DELETION of the whole price section — not a nulling pass', () => {
    const gateAt = anAction.indexOf('canViewPricesGate()');
    const priceAt = anAction.indexOf('const price: BlendAnalysisPriceSection | null = canView');
    const returnAt = anAction.indexOf('return { ok: true, analysis };');
    assert.ok(gateAt > 0 && priceAt > 0 && returnAt > 0, 'the gate, the price branch or the return is missing');
    assert.ok(gateAt < priceAt, 'the price section is built BEFORE the gate runs');
    assert.ok(priceAt < returnAt, 'the price section is assembled after the payload is returned');
    assert.ok(/\n      : null;/.test(anAction.slice(priceAt, priceAt + 700)), 'the denied branch is not `null`');
    assert.ok(/pricesHidden: !canView,/.test(anAction), 'pricesHidden does not follow the gate');
  });

  check('a price-denied caller STILL gets quality and age — no refusal, no second gate', () => {
    // The price lens must REFUSE such a caller because its whole payload is price. This
    // one must not: quality and age carry no money and hiding them would blind the one
    // role that walks the yard.
    assert.ok(!/prices_hidden/.test(anAction), 'a prices_hidden refusal appeared — this read must not refuse');
    const ternaries = anAction.match(/canView\s*\n?\s*\?/g) ?? [];
    assert.equal(ternaries.length, 1, `the gate branches ${ternaries.length} times, expected exactly 1`);
    assert.ok(/age: mapAgeSection\(sections\.age\),/.test(anAction), 'the age section is not returned unconditionally');
    assert.ok(/quality,\n/.test(anAction), 'the quality section is not returned unconditionally');
  });

  check('fetchBlendAnalysis requires a signed-in user BEFORE the RPC', () => {
    assert.ok(/auth\.getUser\(\)/.test(anAction), 'no auth.getUser() — the action does not require a session');
    assert.ok(/not_signed_in/.test(anAction), 'no typed not_signed_in refusal');
    const authAt = anAction.indexOf('auth.getUser()');
    const rpcAt = anAction.indexOf(".rpc('fn_blend_analysis'");
    assert.ok(authAt > 0 && rpcAt > 0 && authAt < rpcAt, 'the RPC is called BEFORE the session check');
  });

  /** Comment lines stripped, so a rule quoted in prose cannot pass for a rule in code. */
  const anCode = anAction
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  check('the action does NO arithmetic (CLAUDE.md: never aggregate in TypeScript)', () => {
    assert.ok(!/\.reduce\(/.test(anCode), 'a reduce() means a total moved out of SQL');
    assert.ok(!/\+=/.test(anCode), 'a += means a sum moved out of SQL');
    assert.ok(!/Math\.(floor|ceil|round)/.test(anCode), 'rounding moved out of SQL');
    // `.sort()` is legitimate ONLY on the edge lists, which SQL also sorts; the payload's
    // own orders (dearest first, oldest first) are decided in SQL.
    const sorts = anCode.match(/\.sort\(/g) ?? [];
    assert.equal(sorts.length, 0, 'a sort() appeared in fetchBlendAnalysis — SQL decides every order');
  });

  check('the EDGE normalizers refuse what SQL refuses, and check integrality HERE', () => {
    const at = actions.indexOf('function normalizeAnalysisEdges(');
    assert.ok(at > 0, 'normalizeAnalysisEdges is missing');
    const fn = actions.slice(at, actions.indexOf('\n}', actions.indexOf('return { ok: true, edges };', at)));
    // int[] means Postgres rounds 1.5 to 2 before the body runs, so this is the only place
    // a fractional edge is decidable.
    assert.ok(/Number\.isInteger\(e\)/.test(fn), 'integrality is not checked in TypeScript');
    assert.ok(/Array\.from\(new Set\(raw\)\)\.sort/.test(fn), 'the list is not de-duplicated before the cap');
    assert.ok(/BLOCKING_PRICE_LENS_MAX_EDGES/.test(fn) && /BLOCKING_AGE_LENS_MAX_EDGES/.test(fn),
      'the caps are re-typed instead of imported');
  });

  check('the caps and defaults are ONE definition, imported rather than re-typed', () => {
    const types = read(TYPES);
    assert.ok(types.includes('BLEND_ANALYSIS_MAX_BLOCKS = 250'), 'the block cap constant moved');
    assert.ok(types.includes("BLEND_ANALYSIS_DEFAULT_PRICE_EDGES: readonly number[] = [-1, 0]"), 'the price default moved');
    assert.ok(types.includes('BLEND_ANALYSIS_DEFAULT_AGE_EDGES: readonly number[] = [60, 120, 365]'), 'the age default moved');
    for (const c of [
      'BLEND_ANALYSIS_MAX_BLOCKS',
      'BLEND_ANALYSIS_DEFAULT_PRICE_EDGES',
      'BLEND_ANALYSIS_DEFAULT_AGE_EDGES',
      'BLEND_ANALYSIS_QUALITY_METRICS',
    ]) {
      assert.ok(actions.includes(c), `the action re-types ${c}`);
    }
    // ...and SQL agrees on all three.
    assert.ok(sql.includes('ARRAY[-1, 0]'), 'the SQL price default moved');
    assert.ok(sql.includes('ARRAY[60, 120, 365]'), 'the SQL age default moved');
    assert.ok(sql.includes('> 250 THEN'), 'the SQL block cap moved');
  });

  check('fetchBlockingPriceLens passes the new kg_weighted_php_kg through', () => {
    const at = actions.indexOf('export async function fetchBlockingPriceLens(');
    assert.ok(at > 0, 'fetchBlockingPriceLens not found');
    const body = actions.slice(at, actions.indexOf('\n}\n', at));
    assert.ok(
      body.includes('kgWeightedPhpKg: lensNumOrNull(b.kg_weighted_php_kg)'),
      'the per-band weighted price is dropped by the mapper',
    );
    // NOTE the expression moved on 2026-09-22 from `res.total?.…` to `total.…`: the warehouse/
    // lab migration gave `total` FOURTEEN more keys, so the mapper hoists it into a local
    // (`const total = res.total ?? {}`) and spreads `mapLensLabStats(total)` beside it rather
    // than repeating `res.total?.` fifteen times. Same source, same null-preserving read.
    assert.ok(
      body.includes('kgWeightedPhpKg: lensNumOrNull(total.kg_weighted_php_kg)'),
      'the total weighted price is dropped by the mapper',
    );
    assert.ok(
      body.includes('const total = res.total ?? {}'),
      'the hoisted `total` local is gone — check what the weighted price is now read from',
    );
    // lensNumOrNull, never `?? 0` — an empty band has no price, and 0 would be a real ₱0.
    assert.ok(!/kgWeightedPhpKg: lensNum\(/.test(body), 'the weighted price is coerced to 0');
  });

  check('the TYPES state the contract where a UI will read it', () => {
    const types = read(TYPES);
    assert.ok(types.includes("export type BlendNaturalGroupLabel = 'low' | 'mid' | 'high';"), 'the label union moved');
    assert.ok(types.includes('gvf: number | null'), 'gvf is not nullable in the type');
    assert.ok(types.includes('pricesHidden: boolean'), 'pricesHidden is missing from the type');
    assert.ok(types.includes('price: BlendAnalysisPriceSection | null'), 'the price section is not nullable');
    assert.ok(/Never re-derive membership from it/.test(types), 'the type does not forbid using the cut midpoint as the test');
    assert.ok(/Render it un-lensed/.test(types), 'the type does not state the unmeasured UI rule');
    assert.ok(types.includes('kgWeightedPhpKg: number | null'), 'the lens band type did not gain the new field');
  });

  check('NOT ONE money-named key is emitted outside sections.price, in the SQL', () => {
    // Measured off the migration text, as a first witness; the live half scans a real
    // payload. The quality/age halves of the builder are the two spans between the
    // section markers.
    const qStart = anBody.indexOf("FOREACH v_metric IN ARRAY");
    const aEnd = anBody.indexOf("'sections', jsonb_build_object");
    assert.ok(qStart > 0 && aEnd > qStart, 'could not isolate the quality + age builders');
    const span = anBody.slice(qStart, aEnd);
    const keys = [...span.matchAll(/'([a-z_]+)',/g)].map((m) => m[1]);
    assert.ok(keys.length > 20, `only found ${keys.length} emitted keys — the scan is not working`);
    const offenders = [...new Set(keys.filter((k) => MONEY_KEY_RE.test(k)))];
    assert.deepEqual(offenders, [], `money-named keys in the quality/age builders: ${offenders.join(', ')}`);
  });
}

// ---------------------------------------------------------------------------
// 2. THE BRUTE-FORCE ORACLE — allowed HERE because it is a proof, not product maths
// ---------------------------------------------------------------------------
// CLAUDE.md forbids computing a weighted average in TypeScript for the APPLICATION. This
// is a test oracle: it deliberately re-implements the objective function the SQL minimises
// so the two can be compared. If they ever disagree, one of them is wrong and the script
// says which pair SQL chose and which pair scored lower.
type Item = { x: number; w: number };

function partitionCost(items: Item[], cuts: number[]): number {
  // cuts are 1-based positions: group boundaries after items[cut-1].
  const bounds = [0, ...cuts, items.length];
  let total = 0;
  for (let g = 0; g + 1 < bounds.length; g += 1) {
    let W = 0;
    let S = 0;
    let Q = 0;
    for (let i = bounds[g]; i < bounds[g + 1]; i += 1) {
      const { x, w } = items[i];
      W += w;
      S += w * x;
      Q += w * x * x;
    }
    if (W > 0) total += Q - (S * S) / W;
  }
  return total;
}

function legalBreakpoints(items: Item[]): number[] {
  const out: number[] = [];
  for (let p = 1; p < items.length; p += 1) if (items[p - 1].x < items[p].x) out.push(p);
  return out;
}

/** The exhaustive search, with the SAME documented tie-break: lowest a, then lowest b. */
function bestPair(items: Item[]): { a: number; b: number; cost: number; ties: number } {
  const bp = legalBreakpoints(items);
  let best = { a: -1, b: -1, cost: Number.POSITIVE_INFINITY, ties: 0 };
  for (let i = 0; i < bp.length; i += 1) {
    for (let j = i + 1; j < bp.length; j += 1) {
      const cost = partitionCost(items, [bp[i], bp[j]]);
      if (cost < best.cost - 1e-9) best = { a: bp[i], b: bp[j], cost, ties: 1 };
      else if (Math.abs(cost - best.cost) <= 1e-9) best.ties += 1;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3. LIVE — the two probes, plus real calls as anon and as service_role
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

const num = (o: Json, k: string): number => {
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
const at = (o: unknown, path: string[]): unknown => {
  let cur: unknown = o;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[p];
  }
  return cur;
};

/** Every key name appearing anywhere under a jsonb value, objects and arrays alike. */
function allKeys(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) allKeys(v, into);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Json)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

const QUALITY_METRICS = ['mc', 'ash', 'bd_astm', 'bd_jis'] as const;

async function liveChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });

  console.log('\nlive posture (a REAL call as each victim role) -------------------');

  // L-043's lesson: prove a permission by ASSUMING THE VICTIM'S ROLE, never by reading the
  // grant table.
  const anonNb = await anon.rpc('fn_natural_breaks_3', { p_values: [1, 2, 3] });
  check('anon CANNOT execute fn_natural_breaks_3 (a real call, not a grant lookup)', () => {
    assert.ok(anonNb.error, 'anon executed the maths function — the REVOKE is gone');
  });
  const svcNb = await svc.rpc('fn_natural_breaks_3', { p_values: [1, 2, 3] });
  check('service_role CANNOT execute fn_natural_breaks_3 (no worker reads it)', () => {
    assert.ok(svcNb.error, 'service_role executed it — an unintended grant appeared');
  });

  const anonAn = await anon.rpc('fn_blend_analysis', { p_block_locs: ['A-1A'] });
  check('anon CANNOT execute fn_blend_analysis', () => {
    assert.ok(anonAn.error, 'anon executed the analysis — the REVOKE is gone');
  });
  const svcAn = await svc.rpc('fn_blend_analysis', { p_block_locs: ['A-1A'] });
  check('service_role CANNOT execute fn_blend_analysis', () => {
    assert.ok(svcAn.error, 'service_role executed it — an unintended grant appeared');
  });

  const anonProbe = await anon.rpc('fn_blend_analysis_probe_cases');
  check('anon CANNOT execute the verify probes either', () => {
    assert.ok(anonProbe.error, 'anon reached a probe — it bypasses the grant');
  });

  // ── the discovery probe ───────────────────────────────────────────────────
  const t0 = Date.now();
  const casesRes = await svc.rpc('fn_blend_analysis_probe_cases');
  assert.ok(!casesRes.error, `fn_blend_analysis_probe_cases failed: ${casesRes.error?.message}`);
  const cases = casesRes.data as unknown as Json;
  assert.ok(cases && typeof cases === 'object', 'the discovery probe returned nothing — an empty probe is a FAILURE');

  const versions = arr(cases, 'versions');
  assert.ok(versions.length > 0, 'no saved blend proposal versions exist — nothing to verify against');

  // THE MAIN CASE: the saved version with the most blocks (the owner's real proposal).
  const main = [...versions].sort(
    (a, b) => Number(b.block_count) - Number(a.block_count) || String(a.as_of).localeCompare(String(b.as_of)),
  )[0];
  // THE AS-OF CASE: a version whose blend has a delivery AFTER its own as-of date.
  const asOfCase = versions.find((v) => Number(v.deliveries_after_as_of) > 0) ?? null;

  const mainRes = await svc.rpc('fn_blend_analysis_probe', {
    p_proposal_id: String(main.proposal_id),
    p_version_no: Number(main.version_no),
  });
  const ms = Date.now() - t0;
  assert.ok(!mainRes.error, `fn_blend_analysis_probe failed: ${mainRes.error?.message}`);
  const probe = mainRes.data as unknown as Json;
  assert.equal(probe.found, true, 'the probe could not find the version it was pointed at');

  console.log(`\nlive (both probes: ${ms} ms wall clock) ---------------------------`);
  console.log(
    `  main case: "${String(main.title)}" v${String(main.version_no)} · ` +
      `${String(main.block_count)} blocks · as of ${String(main.as_of)}`,
  );

  check(`both probes stay under the ${PROBE_MS_BUDGET} ms SHAPE budget`, () => {
    assert.ok(ms < PROBE_MS_BUDGET, `probes took ${ms} ms — check they have not grown a whole-history population`);
  });

  // ── (a) POSTURE from the catalog, a second witness to the real calls above ─
  const posture = obj(probe, 'posture');
  check('catalog posture: authenticated yes, anon no, service_role no, on all three functions', () => {
    for (const k of ['nb', 'analysis', 'lens']) {
      assert.equal(posture[`${k}_authenticated`], true, `${k}: authenticated cannot execute`);
      assert.equal(posture[`${k}_anon`], false, `${k}: anon CAN execute`);
      assert.equal(posture[`${k}_service_role`], false, `${k}: service_role CAN execute`);
    }
  });
  check('catalog posture: the per-version probe is service_role-only', () => {
    assert.equal(posture.probe_service_role, true);
    assert.equal(posture.probe_authenticated, false);
    assert.equal(posture.probe_anon, false);
  });
  check('catalog posture: no OVERLOADS, all SECURITY INVOKER, volatility + search_path + COMMENTs', () => {
    assert.equal(num(posture, 'nb_overload_count'), 1, 'fn_natural_breaks_3 has an overload');
    assert.equal(num(posture, 'analysis_overload_count'), 1, 'fn_blend_analysis has an overload');
    assert.equal(num(posture, 'lens_overload_count'), 1, 'fn_blocking_price_lens has an overload');
    assert.equal(num(posture, 'invoker_count'), 3, 'one of the three is not SECURITY INVOKER');
    assert.equal(num(posture, 'nb_immutable'), 1, 'fn_natural_breaks_3 is not IMMUTABLE');
    assert.equal(num(posture, 'analysis_stable'), 1, 'fn_blend_analysis is not STABLE');
    assert.equal(num(posture, 'search_path_pinned'), 3, 'a function does not pin search_path');
    assert.equal(num(posture, 'commented_count'), 3, 'a function has no COMMENT');
  });

  // ── (b) THE HAND-CHECKABLE NATURAL-BREAKS UNIT CASES ──────────────────────
  const nb = obj(probe, 'nb_cases');

  check('natural breaks: [1,2,3,10,11,12,20,21,22] equal weights cuts at 3|10 and 12|20', () => {
    const c = obj(nb, 'classic');
    assert.equal(c.ok, true);
    assert.equal(num(c, 'group_count'), 3);
    assert.equal(num(c, 'distinct_count'), 9);
    const cuts = arr(c, 'cuts');
    assert.equal(cuts.length, 2);
    assert.equal(num(cuts[0], 'below'), 3);
    assert.equal(num(cuts[0], 'above'), 10);
    assert.equal(num(cuts[0], 'value'), 6.5, 'the midpoint is not (3 + 10) / 2');
    assert.equal(num(cuts[1], 'below'), 12);
    assert.equal(num(cuts[1], 'above'), 20);
    assert.equal(num(cuts[1], 'value'), 16);
    const g = arr(c, 'groups');
    assert.deepEqual(g.map((x) => x.label), ['low', 'mid', 'high']);
    assert.deepEqual(g.map((x) => Number(x.weighted_mean)), [2, 11, 21]);
    assert.deepEqual(g.map((x) => Number(x.within_ss)), [2, 2, 2]);
    // total_ss 548, within 6 -> gvf 1 - 6/548
    assert.equal(num(c, 'within_ss'), 6);
    assert.equal(num(c, 'total_ss'), 548);
    assert.ok(Math.abs(num(c, 'gvf') - (1 - 6 / 548)) < 1e-12, 'gvf is not 1 - within/total');
    assert.equal(num(c, 'candidates_considered'), 28, '8 breakpoints give C(8,2) = 28 pairs');
  });

  check('natural breaks: a HEAVY WEIGHT moves a cut (same values, different weights)', () => {
    const eq = arr(obj(nb, 'equal_four'), 'cuts').map((c) => [Number(c.below), Number(c.above)]);
    const hv = arr(obj(nb, 'heavy_top'), 'cuts').map((c) => [Number(c.below), Number(c.above)]);
    // [1,2,3,4] equal weights ties three ways at within-SS 0.5, so the tie-break takes the
    // lowest pair: 1|2 and 2|3. Put weight 10 on the 4 and the best pair becomes 1|2, 3|4.
    assert.deepEqual(eq, [[1, 2], [2, 3]], 'the equal-weight tie-break moved');
    assert.deepEqual(hv, [[1, 2], [3, 4]], 'a heavy weight no longer moves the cut');
    assert.notDeepEqual(eq, hv, 'the weights had no effect at all — the split is not weighted');
  });

  check('natural breaks: 2 distinct values give 2 groups (low / high), 1 gives 1 (mid)', () => {
    const two = obj(nb, 'two_distinct');
    assert.equal(num(two, 'group_count'), 2);
    assert.deepEqual(arr(two, 'groups').map((g) => g.label), ['low', 'high']);
    assert.equal(arr(two, 'cuts').length, 1, 'two distinct values need exactly one cut');
    assert.equal(num(two, 'gvf'), 1, 'two single-valued groups explain all the variance');

    const one = obj(nb, 'one_distinct');
    assert.equal(num(one, 'group_count'), 1);
    assert.deepEqual(arr(one, 'groups').map((g) => g.label), ['mid'], 'a single group must be `mid`');
    assert.equal(arr(one, 'cuts').length, 0, 'a cut was fabricated where there is no gap');
    assert.equal(one.gvf, null, 'gvf is not NULL on a single distinct value — 0 would be a lie');
  });

  check('natural breaks: NOTHING MEASURABLE gives 0 groups and NULL statistics, not zeroes', () => {
    for (const key of ['all_null', 'null_array']) {
      const c = obj(nb, key);
      assert.equal(c.ok, true, `${key} refused instead of answering`);
      assert.equal(num(c, 'group_count'), 0, `${key}: groups were invented`);
      assert.equal(arr(c, 'groups').length, 0);
      assert.equal(arr(c, 'cuts').length, 0);
      assert.equal(c.gvf, null, `${key}: gvf is not NULL`);
      assert.equal(c.weighted_mean, null, `${key}: a mean was invented`);
      assert.equal(c.total_ss, null, `${key}: total_ss is not NULL`);
    }
    assert.equal(num(obj(nb, 'all_null'), 'excluded_count'), 2, 'the excluded NULLs were not counted');
  });

  check('natural breaks: a NON-POSITIVE weight and a NaN value are EXCLUDED and counted', () => {
    const zw = obj(nb, 'zero_weight');
    assert.equal(num(zw, 'n'), 2, 'the zero-weight item was not excluded');
    assert.equal(num(zw, 'excluded_count'), 1, 'the exclusion was not counted');
    const nan = obj(nb, 'nan_value');
    assert.equal(num(nan, 'n'), 3, 'the NaN was not excluded — NaN = NaN is TRUE for numeric');
    assert.equal(num(nan, 'excluded_count'), 1);
  });

  check('natural breaks: the two refusals are jsonb written for a human', () => {
    const lm = obj(nb, 'length_mismatch');
    assert.equal(lm.ok, false);
    assert.equal(lm.reason, 'length_mismatch');
    assert.ok(String(lm.message).length > 20, 'the refusal has no human message');
    const tm = obj(nb, 'too_many');
    assert.equal(tm.ok, false);
    assert.equal(tm.reason, 'too_many_values');
    assert.ok(/1,000/.test(String(tm.message)), 'the refusal does not name the cap');
  });

  // ── (c) THE OPTIMALITY PROOF, by brute force over the live values ──────────
  const saved = obj(probe, 'saved');
  assert.equal(saved.ok, true, `the saved analysis refused: ${String(saved.message)}`);
  const savedPriceNat = obj(obj(obj(saved, 'sections'), 'price'), 'natural');

  /** The MEASURED population, rebuilt from the groups the DB returned. */
  function itemsFromPriceGroups(natural: Json): Item[] {
    const out: Item[] = [];
    for (const g of arr(natural, 'groups')) {
      for (const b of arr(g, 'blocks')) out.push({ x: Number(b.php_kg), w: Number(b.kg) });
    }
    out.sort((a, b) => a.x - b.x || a.w - b.w);
    return out;
  }

  /** A published cut's POSITION in the sorted item list. */
  function positionOf(items: Item[], below: number): number {
    let p = 0;
    for (const it of items) if (it.x <= below) p += 1;
    return p;
  }

  check('PRICE: the chosen cut pair is OPTIMAL — no other pair has a lower within-SS', () => {
    const items = itemsFromPriceGroups(savedPriceNat);
    assert.ok(items.length >= 4, `only ${items.length} measured blocks — too few to prove optimality`);
    const cuts = arr(savedPriceNat, 'cuts');
    assert.equal(cuts.length, 2, 'the owner’s proposal did not produce two cuts');
    const a = positionOf(items, Number(cuts[0].below));
    const b = positionOf(items, Number(cuts[1].below));
    const chosen = partitionCost(items, [a, b]);
    const best = bestPair(items);
    assert.ok(
      chosen <= best.cost + 1e-6,
      `SQL chose (${a},${b}) costing ${chosen} but (${best.a},${best.b}) costs ${best.cost}`,
    );
    // ...and the DOCUMENTED tie-break picks the same pair, not merely an equally good one.
    assert.equal(a, best.a, `tie-break: SQL’s first cut ${a} is not the lowest optimal ${best.a}`);
    assert.equal(b, best.b, `tie-break: SQL’s second cut ${b} is not the lowest optimal ${best.b}`);
    // ...and the published within_ss is that objective value.
    const published = Number(obj(savedPriceNat, 'stats').within_ss);
    assert.ok(
      Math.abs(published - chosen) < Math.max(1e-6, Math.abs(chosen) * 1e-12),
      `published within_ss ${published} != the oracle’s ${chosen}`,
    );
    console.log(
      `    optimality: ${items.length} blocks · ${arr(savedPriceNat, 'cuts').length} cuts · ` +
        `within-SS ${chosen.toFixed(3)} · ${best.ties} optimal pair(s)`,
    );
  });

  check('QUALITY: every metric’s cut pair is OPTIMAL too', () => {
    const quality = obj(obj(saved, 'sections'), 'quality');
    let checked = 0;
    for (const m of QUALITY_METRICS) {
      const nat = obj(quality, m);
      const items: Item[] = [];
      for (const g of arr(nat, 'groups')) {
        for (const bl of arr(g, 'blocks')) items.push({ x: Number(bl.value), w: Number(bl.kg) });
      }
      items.sort((x, y) => x.x - y.x || x.w - y.w);
      const cuts = arr(nat, 'cuts');
      if (cuts.length !== 2 || items.length < 4) continue;
      const a = positionOf(items, Number(cuts[0].below));
      const b = positionOf(items, Number(cuts[1].below));
      const best = bestPair(items);
      assert.equal(a, best.a, `${m}: first cut ${a} is not the optimal ${best.a}`);
      assert.equal(b, best.b, `${m}: second cut ${b} is not the optimal ${best.b}`);
      checked += 1;
    }
    assert.ok(checked >= 3, `only ${checked} quality metrics were provable — expected at least 3`);
  });

  // ── (d) THE REUSE PROOFS — the footers agree with the blend itself ─────────
  check('PRICE footer EQUALS the stored snapshot’s own raw blend price, gap exactly 0', () => {
    const o = obj(savedPriceNat, 'overall');
    const snapshotRaw = num(probe, 'snapshot_raw_price');
    assert.equal(num(o, 'snapshot_php_kg'), snapshotRaw, 'the footer quotes a different snapshot price');
    assert.equal(num(obj(savedPriceNat, 'unmeasured'), 'block_count'), 0,
      'this blend has unmeasured blocks, so the strict equality below could not be tested');
    assert.equal(Number(o.snapshot_gap), 0, `the gap is ${o.snapshot_gap}, not 0`);
    assert.equal(o.equals_snapshot, true, 'equals_snapshot is not true');
    assert.equal(num(o, 'kg_weighted_php_kg'), snapshotRaw, 'the recomputed price differs from the snapshot');
  });

  check('QUALITY footers EQUAL the stored snapshot’s own weighted stats, gap exactly 0', () => {
    const quality = obj(obj(saved, 'sections'), 'quality');
    const snap = obj(probe, 'snapshot_weighted');
    for (const m of QUALITY_METRICS) {
      const o = obj(obj(quality, m), 'overall');
      assert.equal(num(o, 'snapshot_value'), Number(snap[m]), `${m}: the footer quotes a different stored stat`);
      assert.equal(num(obj(obj(quality, m), 'unmeasured'), 'block_count'), 0, `${m}: has unmeasured blocks`);
      assert.equal(Number(o.snapshot_gap), 0, `${m}: gap is ${o.snapshot_gap}, not 0`);
      assert.equal(o.equals_snapshot, true, `${m}: equals_snapshot is not true`);
    }
  });

  const live = obj(probe, 'live');
  assert.equal(live.ok, true, `the live analysis refused: ${String(live.message)}`);
  const livePriceNat = obj(obj(obj(live, 'sections'), 'price'), 'natural');

  check('the LIVE source EQUALS fn_blend_proposal called directly, on every figure', () => {
    const direct = obj(probe, 'blend_proposal_direct');
    const o = obj(livePriceNat, 'overall');
    assert.equal(num(o, 'kg_weighted_php_kg'), Number(direct.raw_price_per_kg),
      'the live footer disagrees with fn_blend_proposal’s raw price');
    assert.equal(num(live, 'total_kg'), Number(direct.total_balance), 'total_kg disagrees with total_balance');
    assert.equal(num(live, 'block_count'), Number(direct.block_count), 'block_count disagrees');
    const quality = obj(obj(live, 'sections'), 'quality');
    for (const m of QUALITY_METRICS) {
      const q = obj(obj(quality, m), 'overall');
      assert.equal(num(q, 'kg_weighted_value'), Number(direct[`w_${m}`]), `${m}: disagrees with fn_blend_proposal`);
    }
  });

  check('AGE equals view_batch_age_days EXACTLY (gap 0) for as_of = today, and so do the dates', () => {
    const todayAnalysis = String(live.as_of) === String(probe.manila_today) ? live : saved;
    assert.equal(String(todayAnalysis.as_of), String(probe.manila_today),
      'neither source is dated today — the exact age comparison could not be made');
    const ageView = new Map<string, Json>();
    for (const r of arr(probe, 'age_view_rows')) ageView.set(String(r.batch_code), r);
    let compared = 0;
    for (const band of arr(obj(obj(todayAnalysis, 'sections'), 'age'), 'bands')) {
      for (const b of arr(band, 'blocks')) {
        const v = ageView.get(String(b.batch_code));
        assert.ok(v, `view_batch_age_days has no row for ${String(b.batch_code)}`);
        assert.equal(String(v!.as_of_date), String(probe.manila_today), 'the view is dated differently');
        assert.equal(
          Number(b.age_days),
          Number(v!.age_days),
          `${String(b.batch_code)}: age ${String(b.age_days)} != the view’s ${String(v!.age_days)}`,
        );
        assert.equal(String(b.first_delivery_date), String(v!.first_delivery_date), 'first delivery date differs');
        assert.equal(String(b.last_delivery_date), String(v!.last_delivery_date), 'last delivery date differs');
        compared += 1;
      }
    }
    assert.ok(compared > 0, 'no dated blocks were compared — the check is vacuous');
    console.log(`    age reuse: ${compared} blocks, 0 mismatches, max gap 0`);
  });

  check('VS MARKET classifies exactly as fn_blocking_price_lens does, on the same blocks', () => {
    const vs = obj(obj(obj(live, 'sections'), 'price'), 'vs_market');
    const lens = obj(probe, 'lens');
    assert.equal(lens.ok, true, 'the lens refused the market price the analysis used');
    assert.equal(num(lens, 'rounded_up_php'), num(vs, 'rounded_up_php'), 'the two disagree about R');
    assert.equal(num(lens, 'market_php_kg'), num(vs, 'market_php_kg'), 'the two disagree about market');
    const lensBand = new Map<string, number>();
    for (const b of arr(lens, 'blocks')) lensBand.set(String(b.block_loc), Number(b.band_index));
    let compared = 0;
    for (const band of arr(vs, 'bands')) {
      for (const b of arr(band, 'blocks')) {
        const loc = String(b.block_loc);
        assert.ok(lensBand.has(loc), `the lens does not classify ${loc}`);
        assert.equal(
          Number(band.index),
          lensBand.get(loc),
          `${loc}: analysis band ${String(band.index)} != lens band ${String(lensBand.get(loc))}`,
        );
        compared += 1;
      }
    }
    assert.ok(compared > 0, 'no blocks were compared against the lens');
    console.log(`    lens agreement: ${compared} blocks, 0 mismatches`);
  });

  check('the LENS’s new kg_weighted_php_kg is a real weighted average of the grid', () => {
    const lens = obj(probe, 'lens');
    const gridPrices = obj(probe, 'grid_prices');
    // Recompute each band's price from the grid's own avg_php_kg and the analysis's kg.
    // (Only the blend's blocks are in `grid_prices`, so this checks the SHAPE of the key:
    // present, numeric on a non-empty band, null on an empty one.)
    let nonEmpty = 0;
    for (const b of arr(lens, 'bands')) {
      if (Number(b.block_count) > 0) {
        assert.ok(b.kg_weighted_php_kg !== null && b.kg_weighted_php_kg !== undefined,
          `band ${String(b.index)} has blocks but no weighted price`);
        assert.ok(Number(b.kg_weighted_php_kg) > 0, `band ${String(b.index)} has a non-positive weighted price`);
        nonEmpty += 1;
      } else {
        assert.equal(b.kg_weighted_php_kg, null, `an EMPTY band ${String(b.index)} published a price instead of null`);
      }
    }
    assert.ok(nonEmpty >= 2, `only ${nonEmpty} non-empty bands — too few to check`);
    const total = obj(lens, 'total');
    assert.ok(total.kg_weighted_php_kg !== null && total.kg_weighted_php_kg !== undefined,
      'total.kg_weighted_php_kg is missing');
    assert.ok(Object.keys(gridPrices).length > 0, 'the probe returned no grid prices');
  });

  // ── (e) CONSERVATION AND SHARES, in every section ─────────────────────────
  function conservation(label: string, analysis: Json): void {
    const totalKg = Number(analysis.total_kg);
    const totalBlocks = Number(analysis.block_count);
    const sections = obj(analysis, 'sections');

    const checkNatural = (name: string, nat: Json, kgKey: string) => {
      const groups = arr(nat, 'groups');
      const unm = obj(nat, 'unmeasured');
      const gKg = groups.reduce((s, g) => s + Number(g.kg), 0);
      const gN = groups.reduce((s, g) => s + Number(g.block_count), 0);
      assert.ok(
        Math.abs(gKg + Number(unm.kg) - totalKg) < 1e-6,
        `${label}/${name}: group kg ${gKg} + unmeasured ${String(unm.kg)} != total ${totalKg}`,
      );
      assert.equal(gN + Number(unm.block_count), totalBlocks, `${label}/${name}: block counts do not add up`);
      // Shares sum to 100 over the MEASURED population, or are all null when none is.
      const measuredKg = Number(obj(nat, 'overall').kg);
      if (measuredKg > 0) {
        const kgShare = groups.reduce((s, g) => s + Number(g.kg_share_pct), 0);
        const blkShare = groups.reduce((s, g) => s + Number(g.block_share_pct), 0);
        assert.ok(Math.abs(kgShare - 100) < 1e-9, `${label}/${name}: kg shares sum to ${kgShare}`);
        assert.ok(Math.abs(blkShare - 100) < 1e-9, `${label}/${name}: block shares sum to ${blkShare}`);
      } else {
        for (const g of groups) assert.equal(g.kg_share_pct, null, `${label}/${name}: a share is not null`);
      }
      // `groupCount` is authoritative, not the array length of a caller's guess.
      assert.equal(Number(nat.group_count), groups.length, `${label}/${name}: group_count != groups.length`);
      // An empty group publishes NULL, never 0, for its weighted figure.
      for (const g of groups) {
        if (Number(g.block_count) === 0) {
          assert.equal(g[kgKey], null, `${label}/${name}: an EMPTY group published a weighted value`);
        }
      }
    };

    const price = sections.price as Json | null;
    if (price) {
      checkNatural('price.natural', obj(price, 'natural'), 'kg_weighted_php_kg');
      const vs = price.vs_market as Json | null;
      if (vs) {
        const bands = arr(vs, 'bands');
        const unm = obj(vs, 'unmeasured');
        const bKg = bands.reduce((s, b) => s + Number(b.kg), 0);
        assert.ok(
          Math.abs(bKg + Number(unm.kg) - totalKg) < 1e-6,
          `${label}/vs_market: band kg + unmeasured != total`,
        );
        const share = bands.reduce((s, b) => s + Number(b.kg_share_pct ?? 0), 0);
        if (Number(obj(vs, 'overall').kg) > 0) {
          assert.ok(Math.abs(share - 100) < 1e-9, `${label}/vs_market: kg shares sum to ${share}`);
        }
        // Band 0 is OPEN below and the last is OPEN above — null means open, never ₱0.
        assert.equal(bands[0].lower_php, null, `${label}/vs_market: the first band is not open below`);
        assert.equal(bands[bands.length - 1].upper_php, null, `${label}/vs_market: the last band is not open above`);
      }
    }

    const quality = obj(sections, 'quality');
    for (const m of QUALITY_METRICS) checkNatural(`quality.${m}`, obj(quality, m), 'kg_weighted_value');

    const age = obj(sections, 'age');
    const bands = arr(age, 'bands');
    const und = obj(age, 'undated');
    const aKg = bands.reduce((s, b) => s + Number(b.kg), 0);
    assert.ok(
      Math.abs(aKg + Number(und.kg) - totalKg) < 1e-6,
      `${label}/age: band kg ${aKg} + undated ${String(und.kg)} != total ${totalKg}`,
    );
    assert.equal(
      bands.reduce((s, b) => s + Number(b.block_count), 0) + Number(und.block_count),
      totalBlocks,
      `${label}/age: block counts do not add up`,
    );
    if (Number(obj(age, 'overall').kg) > 0) {
      const share = bands.reduce((s, b) => s + Number(b.kg_share_pct ?? 0), 0);
      assert.ok(Math.abs(share - 100) < 1e-9, `${label}/age: kg shares sum to ${share}`);
    }
    assert.equal(Number(bands[0].lower_days), 0, `${label}/age: band 0 does not start at day 0`);
    assert.equal(bands[bands.length - 1].upper_days, null, `${label}/age: the last band is not open above`);
  }

  check('CONSERVATION and SHARES hold in every section, on the SAVED source', () => {
    conservation('saved', saved);
  });
  check('CONSERVATION and SHARES hold in every section, on the LIVE source', () => {
    conservation('live', live);
  });

  // ── (f) THE AS-OF RULE, on live data, with nothing written ─────────────────
  if (asOfCase) {
    const asOfRes = await svc.rpc('fn_blend_analysis_probe', {
      p_proposal_id: String(asOfCase.proposal_id),
      p_version_no: Number(asOfCase.version_no),
    });
    assert.ok(!asOfRes.error, `the as-of probe failed: ${asOfRes.error?.message}`);
    const p2 = asOfRes.data as unknown as Json;
    const s2 = obj(p2, 'saved');
    const l2 = obj(p2, 'live');

    check('A SAVED ANALYSIS IS STABLE UNDER A LATER DELIVERY (proven on live data)', () => {
      assert.equal(s2.ok, true, 'the saved analysis of the as-of case refused');
      assert.equal(l2.ok, true, 'the live analysis of the as-of case refused');
      assert.equal(String(s2.as_of), String(asOfCase.as_of), 'the saved as-of is not the version’s own date');
      assert.equal(String(l2.as_of), String(p2.manila_today), 'the live as-of is not today');
      assert.notEqual(String(s2.as_of), String(l2.as_of), 'the two sources share an as-of — nothing to prove');

      const dateOf = (a: Json): Map<string, { last: string; n: number; age: number }> => {
        const m = new Map<string, { last: string; n: number; age: number }>();
        for (const band of arr(obj(obj(a, 'sections'), 'age'), 'bands')) {
          for (const b of arr(band, 'blocks')) {
            m.set(String(b.batch_code), {
              last: String(b.last_delivery_date),
              n: Number(b.delivery_count),
              age: Number(b.age_days),
            });
          }
        }
        return m;
      };
      const sd = dateOf(s2);
      const ld = dateOf(l2);
      const after = new Set(
        (Array.isArray(at(p2, ['deliveries_after_as_of', 'batch_codes']))
          ? (at(p2, ['deliveries_after_as_of', 'batch_codes']) as unknown[])
          : []
        ).map((x) => String(x)),
      );
      assert.ok(after.size > 0, 'the probe found no batch with a later delivery');
      let proven = 0;
      for (const code of after) {
        const s = sd.get(code);
        const l = ld.get(code);
        if (!s || !l) continue;
        assert.ok(s.last <= String(asOfCase.as_of), `${code}: the saved last delivery ${s.last} is after the as-of date`);
        assert.ok(l.last > s.last, `${code}: the live last delivery ${l.last} is not later than the saved ${s.last}`);
        assert.ok(l.n > s.n, `${code}: the live delivery count ${l.n} did not grow past the saved ${s.n}`);
        proven += 1;
        console.log(
          `    as-of: ${code} — saved(${String(asOfCase.as_of)}) last ${s.last}, ${s.n} deliveries; ` +
            `live(${String(p2.manila_today)}) last ${l.last}, ${l.n}`,
        );
      }
      assert.ok(proven > 0, 'the later-delivery batch is in neither analysis — the narrowing is unproven');
    });

    check('EVERY OTHER BLOCK’s dates are untouched by the as-of — only its age shifts', () => {
      // The as-of moves the measuring day, so an unchanged pile's age moves by exactly the
      // number of days between the two, and its dates and count do not move at all.
      const days =
        (Date.parse(`${String(p2.manila_today)}T00:00:00Z`) -
          Date.parse(`${String(asOfCase.as_of)}T00:00:00Z`)) /
        86_400_000;
      assert.ok(days > 0, 'the live as-of is not later than the saved one');
      const pick = (a: Json) => {
        const m = new Map<string, { last: string; n: number; age: number }>();
        for (const band of arr(obj(obj(a, 'sections'), 'age'), 'bands')) {
          for (const b of arr(band, 'blocks')) {
            m.set(String(b.batch_code), {
              last: String(b.last_delivery_date),
              n: Number(b.delivery_count),
              age: Number(b.age_days),
            });
          }
        }
        return m;
      };
      const sd = pick(s2);
      const ld = pick(l2);
      let unchanged = 0;
      for (const [code, s] of sd) {
        const l = ld.get(code);
        if (!l || l.n !== s.n) continue;
        assert.equal(l.last, s.last, `${code}: an unchanged pile’s last delivery date moved`);
        assert.ok(
          Math.abs(l.age - s.age - days) < 1e-9,
          `${code}: age moved by ${l.age - s.age} days, not the ${days} between the two as-of dates`,
        );
        unchanged += 1;
      }
      assert.ok(unchanged > 0, 'no block was unchanged — the check is vacuous');
    });
  } else {
    console.log(
      '\n  ! NOT PROVEN ON LIVE DATA: no saved version has a delivery dated after its own',
    );
    console.log(
      '    as-of date, so the narrowing could not be exercised. The static assertions above',
    );
    console.log('    pin the `transaction_date <= v_as_of` predicate; this is not a pass.');
  }

  // ── (g) THE DEGENERATE AND UNMEASURED CASES, discovered live ───────────────
  const single = cases.single_value as Json | null;
  const two = cases.two_value as Json | null;
  const zero = cases.zero_lab as Json | null;
  const zeroCounts = obj(cases, 'grid_zero_counts');

  check('DEGENERATE: a blend whose blocks share ONE price returns ONE group, gvf NULL', () => {
    assert.ok(single, 'no two occupied blocks share a price today — this case is unproven');
    const nat = obj(obj(obj(obj(single!, 'analysis'), 'sections'), 'price'), 'natural');
    assert.equal(num(nat, 'group_count'), 1, 'a single distinct price did not give one group');
    assert.deepEqual(arr(nat, 'groups').map((g) => g.label), ['mid'], 'the single group is not `mid`');
    assert.equal(arr(nat, 'cuts').length, 0, 'a cut was fabricated');
    assert.equal(nat.gvf, null, 'gvf is not NULL — 0 would claim the split explained nothing');
    conservation('single_value', obj(single!, 'analysis'));
  });

  check('DEGENERATE: TWO distinct prices return TWO groups, low / high', () => {
    assert.ok(two, 'could not build a two-price blend from the grid — this case is unproven');
    const nat = obj(obj(obj(obj(two!, 'analysis'), 'sections'), 'price'), 'natural');
    assert.equal(num(nat, 'group_count'), 2, 'two distinct prices did not give two groups');
    assert.deepEqual(arr(nat, 'groups').map((g) => g.label), ['low', 'high']);
    assert.equal(arr(nat, 'cuts').length, 1);
    conservation('two_value', obj(two!, 'analysis'));
  });

  check('NULL ≠ 0: a lab reading of exactly 0 is UNMEASURED, not the cleanest block', () => {
    assert.ok(Number(zeroCounts.ash) > 0, 'no occupied block reads 0 on ash today — this case is unproven');
    assert.ok(zero, 'the probe could not build a zero-lab blend');
    const analysis = obj(zero!, 'analysis');
    const q = obj(obj(analysis, 'sections'), 'quality');
    const ash = obj(q, 'ash');
    const unm = obj(ash, 'unmeasured');
    assert.equal(num(unm, 'block_count'), 1, 'the zero-ash block is not in `unmeasured`');
    assert.equal(num(unm, 'no_value_count'), 1, 'the exclusion is not attributed to a missing value');
    assert.ok(Number(unm.kg) > 0, 'the unmeasured kilograms are 0 — the block vanished');
    const blocks = arr(unm, 'blocks');
    assert.equal(String(blocks[0].block_loc), String(zero!.zero_block_loc), 'a different block was excluded');
    // ...and it is in NO group.
    for (const g of arr(ash, 'groups')) {
      for (const b of arr(g, 'blocks')) {
        assert.notEqual(String(b.block_loc), String(zero!.zero_block_loc), 'the zero-ash block landed in a group');
      }
    }
    // ...but it still counts in the yard, so conservation still holds.
    conservation('zero_lab', analysis);
    // ...and THIS is the one live case where the honest footer legitimately differs from
    // the snapshot's own weighted stat, because that stat averaged the 0 in.
    const o = obj(ash, 'overall');
    assert.equal(o.equals_snapshot, false, 'the footer matched a snapshot stat that averaged a 0 in');
    assert.ok(Number(o.kg_weighted_value) > Number(o.snapshot_value),
      'the honest ash figure is not higher than the zero-dragged snapshot figure');
    console.log(
      `    unmeasured: ${String(zero!.zero_block_loc)} reads ash 0 → honest ` +
        `${Number(o.kg_weighted_value).toFixed(4)} vs the snapshot’s ${Number(o.snapshot_value).toFixed(4)}`,
    );
  });

  check('mc and ₱/kg read 0 on NO occupied block today, which is why the price proof is exact', () => {
    assert.equal(num(zeroCounts, 'php_kg'), 0, 'an unpriced block exists — the exact price equality may fail');
    assert.equal(num(zeroCounts, 'mc'), 0, 'a zero-mc block exists');
    console.log(
      `    grid zeros: ${String(zeroCounts.blocks)} blocks — php ${String(zeroCounts.php_kg)}, ` +
        `mc ${String(zeroCounts.mc)}, ash ${String(zeroCounts.ash)}, ` +
        `bd_astm ${String(zeroCounts.bd_astm)}, bd_jis ${String(zeroCounts.bd_jis)}`,
    );
  });

  // ── (h) DETERMINISM, THE OVERRIDE, AND THE REFUSALS ───────────────────────
  check('two identical calls return BYTE-IDENTICAL output (the tie-break is a contract)', () => {
    const again = obj(probe, 'saved_again');
    // `computed_at` is the clock and is expected to move; everything else must not.
    const strip = (o: Json) => {
      const c = { ...o };
      delete c.computed_at;
      return JSON.stringify(c);
    };
    assert.equal(strip(saved), strip(again), 'two identical calls disagreed');
  });

  check('A TYPED PRICE IS THE CUT LINE ITSELF — the override sets R, absence keeps floor+1', () => {
    const withOverride = obj(probe, 'given_market_41');
    const without = obj(probe, 'given_market_41_no_override');
    assert.equal(withOverride.ok, true);
    assert.equal(without.ok, true);
    assert.equal(Number(at(withOverride, ['sections', 'price', 'vs_market', 'rounded_up_php'])), 41,
      'a typed 41 did not set R to 41');
    assert.equal(Number(at(without, ['sections', 'price', 'vs_market', 'rounded_up_php'])), 42,
      'the measured rule no longer gives 42 for a market of 41');
    assert.equal(String(at(withOverride, ['sections', 'price', 'vs_market', 'market_basis'])), 'given',
      'a typed market price is not reported as `given`');
    assert.equal(at(withOverride, ['sections', 'price', 'vs_market', 'market_basis_month']), null,
      'a typed market price reported a basis month');
  });

  check('the AS-OF-MONTH market basis names the month it read', () => {
    const vs = obj(obj(obj(saved, 'sections'), 'price'), 'vs_market');
    assert.equal(String(vs.market_basis), 'as_of_month', 'the default basis is not the as-of month');
    assert.equal(String(vs.market_basis_month), `${String(saved.as_of).slice(0, 7)}-01`,
      'the basis month is not the first of the blend’s own month');
    assert.ok(Number(vs.market_php_kg) > 0, 'the market price is not positive');
  });

  check('EVERY refusal is jsonb {ok:false, reason, message} with the right reason', () => {
    const refusals = obj(probe, 'refusals');
    const expected: Record<string, string> = {
      both_sources: 'both_sources',
      no_source: 'no_source',
      version_no_alone: 'no_source',
      unknown_proposal: 'unknown_proposal',
      unknown_version: 'unknown_version',
      no_blocks: 'no_blocks',
      unknown_block_loc: 'unknown_block_loc',
      invalid_price_edge: 'invalid_price_edge',
      no_price_edges: 'no_price_edges',
      too_many_price_edges: 'too_many_price_edges',
      invalid_age_edge_null: 'invalid_age_edge',
      invalid_age_edge_zero: 'invalid_age_edge',
      invalid_age_edge_huge: 'invalid_age_edge',
      no_age_edges: 'no_age_edges',
      too_many_age_edges: 'too_many_age_edges',
      invalid_rounded_up: 'invalid_rounded_up',
      invalid_market_zero: 'invalid_market_price',
      invalid_market_nan: 'invalid_market_price',
    };
    for (const [key, reason] of Object.entries(expected)) {
      const r = obj(refusals, key);
      assert.equal(r.ok, false, `${key} did not refuse`);
      assert.equal(r.reason, reason, `${key} refused with ${String(r.reason)}, expected ${reason}`);
      assert.ok(String(r.message).length > 15, `${key} has no human message`);
      // A refusal must never RAISE, and must never carry a payload.
      assert.equal(r.sections, undefined, `${key} returned sections beside a refusal`);
    }
    assert.ok(
      /ZZ|"|\bv\d/.test(String(obj(refusals, 'unknown_version').message)),
      'the unknown_version refusal does not name the version or the proposal',
    );
    assert.ok(
      /ZZ-99Z/.test(String(obj(refusals, 'unknown_block_loc').message)),
      'the unknown_block_loc refusal does not NAME the block',
    );
  });

  check('a WIDE edge list is honoured and de-duplicated into k+1 bands', () => {
    const wide = obj(probe, 'wide_edges');
    assert.equal(wide.ok, true);
    const vs = obj(obj(obj(wide, 'sections'), 'price'), 'vs_market');
    assert.deepEqual(vs.edge_offsets, [-10, -1, 0, 5], 'the edge list did not survive intact');
    assert.equal(arr(vs, 'bands').length, 5, '4 edges did not give 5 bands');
    conservation('wide_edges', wide);
  });

  // ── (i) THE ₱ BOUNDARY, on a real payload ─────────────────────────────────
  check('NOT ONE money-named key exists outside sections.price, on the LIVE payload', () => {
    const sections = obj(saved, 'sections');
    const keys = new Set<string>();
    allKeys(sections.quality, keys);
    allKeys(sections.age, keys);
    assert.ok(keys.size >= 25, `only ${keys.size} keys seen — the scan is not working`);
    const offenders = [...keys].filter((k) => MONEY_KEY_RE.test(k));
    assert.deepEqual(offenders, [], `money-named keys outside sections.price: ${offenders.join(', ')}`);
    // ...and the price section DOES carry them, so the scan is not vacuous.
    const priceKeys = allKeys(sections.price);
    assert.ok(
      [...priceKeys].some((k) => MONEY_KEY_RE.test(k)),
      'the price section carries no money-named key — the scan above proves nothing',
    );
  });

  check('the top-level payload carries no money-named key either', () => {
    const top = Object.keys(saved).filter((k) => k !== 'sections');
    const offenders = top.filter((k) => MONEY_KEY_RE.test(k));
    assert.deepEqual(offenders, [], `money-named top-level keys: ${offenders.join(', ')}`);
  });

  // ── a readable sample, which is what the print will show ──────────────────
  console.log('\n  sample — the PRICE page of the owner’s own proposal ------------');
  const cuts = arr(savedPriceNat, 'cuts');
  console.log(
    `    "${String(main.title)}" v${String(main.version_no)} · ${String(saved.block_count)} blocks · ` +
      `${Number(saved.total_kg).toLocaleString('en-US')} kg · as of ${String(saved.as_of)}`,
  );
  console.log(
    `    cuts at ${cuts
      .map((c) => `₱${Number(c.below).toFixed(4)} | ₱${Number(c.above).toFixed(4)}`)
      .join('   and   ')}` + `   ·   gvf ${Number(savedPriceNat.gvf).toFixed(4)}`,
  );
  for (const g of arr(savedPriceNat, 'groups')) {
    console.log(
      `      ${String(g.label).padEnd(5)} ₱${Number(g.range_min).toFixed(4)}–₱${Number(g.range_max).toFixed(4)}  ` +
        `${String(g.block_count).padStart(3)} blocks  ${Number(g.kg).toLocaleString('en-US').padStart(11)} kg  ` +
        `${Number(g.kg_share_pct).toFixed(2).padStart(6)}%  ₱${Number(g.kg_weighted_php_kg).toFixed(4)}`,
    );
  }
  const o = obj(savedPriceNat, 'overall');
  console.log(
    `      TOTAL                     ${String(o.block_count).padStart(3)} blocks  ` +
      `${Number(o.kg).toLocaleString('en-US').padStart(11)} kg          ₱${Number(o.kg_weighted_php_kg).toFixed(4)}`,
  );
  const vs = obj(obj(obj(saved, 'sections'), 'price'), 'vs_market');
  console.log(
    `    vs market ₱${Number(vs.market_php_kg).toFixed(4)} (R = ${String(vs.rounded_up_php)}): ` +
      arr(vs, 'bands')
        .map((b) => `${String(b.block_count)} ${b.lower_php === null ? 'below' : b.upper_php === null ? 'above' : 'at'}`)
        .join(' / '),
  );
  const quality = obj(obj(saved, 'sections'), 'quality');
  for (const m of QUALITY_METRICS) {
    const nat = obj(quality, m);
    console.log(
      `    ${m.padEnd(8)} ${arr(nat, 'groups')
        .map((g) => `${String(g.label)} ${Number(g.range_min).toFixed(3)}–${Number(g.range_max).toFixed(3)} (${String(g.block_count)})`)
        .join('  ')}   gvf ${nat.gvf === null ? '—' : Number(nat.gvf).toFixed(4)}`,
    );
  }
  const age = obj(obj(saved, 'sections'), 'age');
  const ao = obj(age, 'overall');
  console.log(
    `    age      ${arr(age, 'bands')
      .map((b) => `${String(b.lower_days)}${b.upper_days === null ? '+' : `–${String(b.upper_days)}`}d:${String(b.block_count)}`)
      .join('  ')}   wtd ${Number(ao.kg_weighted_age_days).toFixed(1)}d  ` +
      `oldest ${String(ao.oldest_block_loc)} ${Number(ao.oldest_age_days).toFixed(1)}d`,
  );
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('verify-blend-analysis — the blend proposal ANALYSIS data layer');
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
