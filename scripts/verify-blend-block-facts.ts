/**
 * verify-blend-block-facts.ts — the proofs behind FN_BLEND_BLOCK_FACTS.
 *
 * Run: npx tsx scripts/verify-blend-block-facts.ts
 *
 * ============================================================================
 * WHAT THE FEATURE IS, AND WHAT CAN GO WRONG WITH IT
 * ============================================================================
 * The blend modal's "Selected blocks" table wants two things per block that it has
 * never had: WHO filled it — in the Blocking page's own vocabulary, GREEN when the whole
 * block is one supplier and ORANGE when it is mixed, naming the dominant one — and HOW
 * LONG AGO it was opened and last piled on. The modal renders in two modes, and that is
 * the whole design problem: the LIVE what-if wants "now", while a SAVED version is a
 * statement about the yard ON A PARTICULAR DAY whose `snapshot` is immutable and HASHED.
 *
 * So `fn_blend_block_facts(p_batch_ids, p_as_of)` (migration
 * `20260921034512_blend_block_facts_and_price_lens_rounded_up`) RECONSTRUCTS the answer
 * as of a date instead of adding a column to anything. Almost nothing in it is a new
 * number — supplier identity is `canonical_supplier()`, the green/orange test already
 * exists as `view_blocking_block_suppliers.supplier_count_in_block`, and the delivery
 * dates already exist on `view_batch_age_days` — so the failure modes worth testing are
 * the five this codebase keeps meeting:
 *
 *   REUSE      a "supplier picture" that quietly re-derives identity, so the blend modal
 *              and the Blocking supplier SEARCH disagree about who filled a block.
 *              PROVEN by comparing count, flag AND per-supplier kilograms against
 *              view_blocking_block_suppliers, read independently in the same call.
 *   SECOND AGE these dates becoming a rival to `view_batch_age_days.age_days` (the
 *              kg-weighted mean delivery date the Age lens reads). PROVEN: the two
 *              families agree on the dated population and on both dates, exactly.
 *   AS-OF      an "as of" parameter that does not actually narrow anything. PROVEN on a
 *              REAL block discovered live, where an earlier date flips ORANGE to GREEN.
 *   NULL ≠ 0   an undated block painted GREEN and "0 days old", which is the
 *              ₱11.01-vs-₱39.99 `avg_cost` bug in a new costume. PROVEN: every dominant
 *              field, both dates and both day counts are NULL, and `is_single_supplier`
 *              is NULL rather than false.
 *   POSTURE    a function reachable by a role that should not have it. PROVEN by
 *              ASSUMING THE VICTIM'S ROLE and really calling it (L-043's lesson), not by
 *              reading the grant table.
 *
 * ============================================================================
 * WHY THE NUMBERS COME FROM A PROBE RPC AND NOT FROM DIRECT CALLS
 * ============================================================================
 * `fn_blend_block_facts` is `authenticated`-only BY DESIGN (`anon` revoked,
 * `service_role` deliberately NOT granted so `verify-worker-view-grants` stays at 4
 * views / 0 findings), and no verify script in this repo holds a user JWT. So the only
 * key this script has cannot call it — which is the point of the grant, and is exactly
 * the situation the ops-ledger and both lens scripts solved with a SECURITY DEFINER,
 * service_role-only probe. `fn_blend_block_facts_probe()` is that door.
 *
 * THE PROBE ASSERTS NOTHING. It calls the function a fixed number of times, reads
 * `view_blocking_block_suppliers` and `view_batch_age_days` INDEPENDENTLY, discovers the
 * flip candidate live, and hands everything back — every assertion below is TypeScript a
 * human can read. It is deliberately NOT a whole-database verifier: the 2026-09-14
 * `fn_ops_ledger_verify()` incident (one statement cross-checking every ops-ledger view
 * over all of history) OOM-ed the instance and took the live site down. Every population
 * here is bounded BY CONSTRUCTION — one row per occupied block (167 today, 238 slots
 * maximum), one row per (block, supplier) pair, one row per batch code with a delivery.
 *
 * MEASURED 2026-09-21 with `set local statement_timeout='5s'` then
 * EXPLAIN (ANALYZE, BUFFERS):
 *   the query inline, all 167 grid batches                   29.7 ms /   245 buffers
 *   fn_blend_block_facts(167 ids)            warm            31.7 ms / 1,451 buffers
 *     of which the caller's own grid scan to get the ids       1.5 ms /   111 buffers
 *   fn_blend_block_facts(3 ids) — a REALISTIC blend            7.3 ms /   953 buffers
 *   first call after creation (16 ms of planning)             73.5 ms
 * The ceiling below is a SHAPE alarm, not a latency SLO — see PROBE_MS_BUDGET.
 *
 * ============================================================================
 * ₱ IN THIS SCRIPT'S OUTPUT
 * ============================================================================
 * NONE, and that is structural rather than careful: the function has no cost/price/value
 * column, `cost_basis` is never read, and the probe returns no money value of any kind.
 * Two assertions below check exactly that, one off the catalog and one off the payload.
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

const MIGRATION = 'supabase/migrations/20260921034512_blend_block_facts_and_price_lens_rounded_up.sql';
const ACTIONS = 'app/(app)/inventory/blocking/actions.ts';
const TYPES = 'app/(app)/inventory/blocking/types.ts';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

/** Anything whose NAME would make a reader think it carries money. */
const MONEY_KEY_RE = /php|peso|cost|price|value|amount/i;

/**
 * A SHAPE alarm, not a performance SLO — the distinction is the whole reason it is this
 * loose. What it must catch is one call walking a whole-history population; what it must
 * NOT fire on is instance load, and the wall-clock here is round-trip dominated
 * (verify-ops-ledger records a probe costing 280 ms server-side reading 4,671 ms from a
 * laptop). The probe makes 4 function calls plus three bounded reads, so a few hundred ms
 * of server work is the honest expectation and 15 s is orders of magnitude above it.
 */
const PROBE_MS_BUDGET = 15_000;

// ---------------------------------------------------------------------------
// 1. STATIC — the migration's posture, and the ACTION's shape
// ---------------------------------------------------------------------------
function staticChecks(): void {
  console.log('\nstatic (migration + server action, no network) -------------------');

  const sql = read(MIGRATION);

  check('fn_blend_block_facts is STABLE, SECURITY INVOKER and pins search_path', () => {
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_blend_block_facts(');
    assert.ok(at > 0, 'the function is not in the migration');
    const head = sql.slice(at, at + 2000);
    assert.ok(/\nLANGUAGE sql\n/.test(head), 'not LANGUAGE sql');
    assert.ok(/\nSTABLE\n/.test(head), 'not STABLE');
    assert.ok(/\nSECURITY INVOKER\n/.test(head), 'not SECURITY INVOKER');
    assert.ok(/\nSET search_path = public\n/.test(head), 'search_path not pinned');
  });

  check('the probe is the only SECURITY DEFINER thing the facts half adds', () => {
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_blend_block_facts_probe()');
    assert.ok(at > 0, 'the probe is not in the migration');
    const head = sql.slice(at, at + 400);
    assert.ok(/\nSECURITY DEFINER\n/.test(head), 'the probe is not SECURITY DEFINER');
    assert.ok(/\nSTABLE\n/.test(head), 'the probe is not STABLE');
  });

  check('grants: authenticated only on the function; anon + PUBLIC revoked; no service_role', () => {
    const sig = 'fn_blend_block_facts(uuid[], date)';
    assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC;`), 'PUBLIC not revoked');
    assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon;`), 'anon not revoked');
    assert.ok(sql.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO authenticated;`), 'authenticated missing');
    assert.ok(
      !new RegExp(`GRANT[^;]*${sig.replace(/[()[\]]/g, '\\$&')}[^;]*service_role`).test(sql),
      'the function is granted to service_role — verify-worker-view-grants would grow a finding',
    );
  });

  check('the facts probe is service_role-only — authenticated and anon are BOTH revoked', () => {
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      assert.ok(
        sql.includes(`REVOKE EXECUTE ON FUNCTION public.fn_blend_block_facts_probe() FROM ${role};`),
        `probe: ${role} not revoked`,
      );
    }
    assert.ok(
      sql.includes('GRANT  EXECUTE ON FUNCTION public.fn_blend_block_facts_probe() TO service_role;'),
      'the probe is not granted to service_role',
    );
  });

  check('the function carries a COMMENT that names the green/orange column and the as-of rule', () => {
    const at = sql.indexOf('COMMENT ON FUNCTION public.fn_blend_block_facts(uuid[], date) IS');
    assert.ok(at > 0, 'no COMMENT on the function');
    const body = sql.slice(at, at + 6000);
    assert.ok(/is_single_supplier/.test(body), 'the COMMENT does not name the green/orange column');
    assert.ok(/p_as_of/.test(body), 'the COMMENT does not explain the as-of parameter');
    assert.ok(/NULL IS NEVER 0/.test(body), 'the COMMENT does not state the NULL rule');
  });

  check('SUPPLIER IDENTITY is the ONE definition, written in SQL and nowhere else', () => {
    // The same expression view_blocking_block_suppliers uses, including the origin strip
    // and the UNKNOWN fallback. If this moves, the blend modal and the supplier search
    // start naming suppliers differently.
    assert.ok(
      sql.includes("public.canonical_supplier(split_part(d.supplier, ' - ', 1))"),
      'the canonical supplier expression moved or changed',
    );
    assert.ok(sql.includes("'UNKNOWN'"), 'the UNKNOWN fallback is gone');
    const actions = read(ACTIONS);
    assert.ok(!/canonical_supplier/.test(actions), 'a TypeScript port of canonical_supplier appeared');
    assert.ok(!/split_part/.test(actions), 'the origin strip was re-implemented in TypeScript');
  });

  check('the AS-OF CLOCK is named exactly once, in SQL', () => {
    assert.ok(
      sql.includes("COALESCE(p_as_of, (now() AT TIME ZONE 'Asia/Manila')::date)"),
      'the "NULL as-of means today in Manila" expression moved',
    );
    // ...and the delivery window is a plain `<=`, so a delivery ON the as-of date counts.
    assert.ok(sql.includes('d.transaction_date <= a.x_as_of'), 'the as-of window is not <= the date');
    assert.ok(sql.includes('d.transaction_date IS NOT NULL'), 'an undated delivery is no longer excluded');
  });

  check('the DOMINANT supplier is decided deterministically, in SQL', () => {
    assert.ok(
      sql.includes('ORDER BY sup.x_kg DESC, sup.x_key ASC'),
      'the kg tie-break moved — two equally large suppliers could now swap between calls',
    );
  });

  check('the migration does NOT touch the SAVED proposal feature', () => {
    // THE decision this job turns on: a stored snapshot is immutable and HASHED, so the
    // supplier picture is RECONSTRUCTED rather than added to it. If someone later does
    // change one of these, this assertion is the place to say so deliberately.
    for (const bad of [
      'CREATE OR REPLACE FUNCTION public.fn_blend_proposal_snapshot',
      'CREATE OR REPLACE FUNCTION public.fn_blend_snapshot_hash',
      'ALTER TABLE public.blend_proposal_versions',
      'ALTER TABLE public.blend_proposals',
      'UPDATE public.blend_proposal_versions',
      'UPDATE blend_proposal_versions',
    ]) {
      assert.ok(!sql.includes(bad), `the migration modifies the saved feature (${bad})`);
    }
  });

  check('the hot CTEs carry their MATERIALIZED hints (explicit insurance, see the header)', () => {
    for (const cte of ['tgt AS MATERIALIZED', 'del AS MATERIALIZED', 'sup AS MATERIALIZED']) {
      assert.ok(sql.includes(cte), `${cte} lost its MATERIALIZED hint`);
    }
  });

  check('NOT ONE published column is money-named', () => {
    // Read off the migration's own RETURNS TABLE, because service_role holds no grant on
    // the function (by design) — a "no money columns found" built on a failed call would
    // be a vacuous pass. The live half checks the catalog too.
    const at = sql.indexOf('RETURNS TABLE (');
    assert.ok(at > 0, 'the RETURNS TABLE list is not in the migration');
    const body = sql.slice(at, sql.indexOf(')\nLANGUAGE sql', at));
    const cols = [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\s+/gm)].map((m) => m[1]);
    assert.ok(cols.length >= 12, `only found ${cols.length} column names — the scan is not working`);
    const offenders = cols.filter((c) => MONEY_KEY_RE.test(c));
    assert.deepEqual(offenders, [], `money-named columns: ${offenders.join(', ')}`);
    // ...and `cost_basis` is never READ, which is why there is nothing to gate. Checked
    // against the function BODY with comment lines stripped, so the header's prose
    // ("cost_basis is never read") cannot pass for a reference to the column.
    const bodyStart = sql.indexOf('AS $$', at);
    const bodyEnd = sql.indexOf('\n$$;', bodyStart);
    assert.ok(bodyStart > 0 && bodyEnd > bodyStart, 'could not isolate the function body');
    const code = sql
      .slice(bodyStart, bodyEnd)
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    assert.ok(!/cost_basis/.test(code), 'cost_basis is read by the function');
    assert.ok(!MONEY_KEY_RE.test(code.replace(/x_kg|weight_kg|\bkg\b/g, '')), 'a money-named identifier is in the body');
  });

  const actions = read(ACTIONS);
  const factsStart = actions.indexOf('export async function fetchBlendBlockFacts(');
  assert.ok(factsStart > 0, 'fetchBlendBlockFacts not found in actions.ts');
  // BOUNDED AT THE NEXT SECTION DIVIDER (the file's own `// ─── <name> ───` convention),
  // not at end-of-file. Slicing to the end used to work only because this was the last
  // action in the file; `fetchBlendAnalysis` (2026-09-21) follows it and legitimately DOES
  // carry a price gate — and its own block comment names `canViewPrices()` in prose — so an
  // unbounded slice would have read ITS gate as this one's. Bounding at the divider rather
  // than at the next `export` is what keeps that neighbouring PROSE out too. This is
  // strictly MORE precise than the old slice, never weaker.
  const factsEnd = [
    actions.indexOf('\n// ─── ', factsStart + 1),
    actions.indexOf('\nexport async function ', factsStart + 1),
  ]
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  const factsBody = actions.slice(factsStart, factsEnd ?? undefined);
  assert.ok(factsBody.includes("'fn_blend_block_facts'"), 'the isolated body is not the block-facts action');
  assert.ok(!factsBody.includes('fetchBlendAnalysis'), 'the slice leaked into the next section');

  check('fetchBlendBlockFacts has NO canViewPrices gate — and that is the point', () => {
    // Nothing in the payload is money and none is derivable, so a gate here would hide a
    // supplier name and a date from Production, the one role that walks the yard. The
    // price lens REFUSES such a caller before the database; this one must not.
    assert.ok(!/canViewPrices/.test(factsBody), 'a canViewPrices gate appeared in fetchBlendBlockFacts');
    assert.ok(!/prices_hidden/.test(factsBody), 'a prices_hidden refusal appeared — this read has no price gate');
  });

  check('fetchBlendBlockFacts DOES require a signed-in user, like its non-price siblings', () => {
    assert.ok(/auth\.getUser\(\)/.test(factsBody), 'no auth.getUser() — the action does not require a session');
    assert.ok(/not_signed_in/.test(factsBody), 'no typed not_signed_in refusal');
    const authAt = factsBody.indexOf('auth.getUser()');
    const rpcAt = factsBody.indexOf('.rpc(');
    assert.ok(authAt > 0 && rpcAt > 0 && authAt < rpcAt, 'the RPC is called BEFORE the session check');
  });

  /** Comment lines stripped, so a rule quoted in prose cannot pass for a rule in code. */
  const factsCode = factsBody
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  check('the action does NO arithmetic (CLAUDE.md: never aggregate in TypeScript)', () => {
    assert.ok(!/\.reduce\(/.test(factsCode), 'a reduce() means a total moved out of SQL');
    assert.ok(!/\+=/.test(factsCode), 'a += means a sum moved out of SQL');
    assert.ok(!/Math\.(floor|ceil|round)/.test(factsCode), 'rounding moved out of SQL');
    assert.ok(!/\.sort\(/.test(factsCode), 'the supplier order is re-decided in TypeScript');
  });

  check('NULL is never coerced to 0 on a share, a date or a day count', () => {
    for (const f of [
      'sharePct: lensNumOrNull(s.share_pct)',
      'dominantSharePct: lensNumOrNull(row.dominant_share_pct)',
      'daysSinceOpened: lensNumOrNull(row.days_since_opened)',
      'daysSinceLastPiled: lensNumOrNull(row.days_since_last_piled)',
    ]) {
      assert.ok(factsBody.includes(f), `${f} missing — a 0 here would be read as a real answer`);
    }
    // ...and the flag is NULL, never false: an undated block is neither green nor orange.
    assert.ok(
      factsBody.includes('isSingleSupplier: row.is_single_supplier ?? null'),
      'is_single_supplier is coerced — false would paint an undated block ORANGE',
    );
  });

  check('THE FUTURE CHECK is measured in Asia/Manila, not UTC', () => {
    // PH is UTC+8, so between 16:00 and midnight UTC the Manila calendar date is already
    // "tomorrow" by UTC's reckoning and a UTC-based test would refuse an ordinary today.
    // Same reasoning the cenapro opening-balance writer records.
    assert.ok(/timeZone: 'Asia\/Manila'/.test(factsBody), 'the future check does not use the Manila clock');
    assert.ok(/invalid_as_of/.test(factsBody), 'no typed invalid_as_of refusal');
  });

  const types = read(TYPES);

  check('the id cap is ONE definition, imported rather than re-typed', () => {
    assert.ok(types.includes('BLEND_BLOCK_FACTS_MAX_BATCH_IDS = 250'), 'the cap constant moved');
    assert.ok(actions.includes('BLEND_BLOCK_FACTS_MAX_BATCH_IDS'), 'the action re-types the cap');
  });

  check('the TYPES state the green/orange rule and the NULL rule where a UI will read them', () => {
    assert.ok(types.includes('isSingleSupplier: boolean | null'), 'the flag is not nullable in the type');
    assert.ok(
      /never re-derive it from `suppliers\.length`/i.test(types),
      'the type does not forbid re-deriving the flag from the supplier list',
    );
    assert.ok(types.includes('asOf: string | null'), 'asOf is not nullable in the result type');
  });
}

// ---------------------------------------------------------------------------
// 2. LIVE — the probe, plus real calls as anon and as service_role
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

async function liveChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });

  console.log('\nlive posture (a REAL call as each victim role) -------------------');

  const probeArgs = { p_batch_ids: ['00000000-0000-0000-0000-000000000000'] };

  // L-043's lesson: prove a permission by ASSUMING THE VICTIM'S ROLE, never by reading
  // the grant table.
  const anonCall = await anon.rpc('fn_blend_block_facts', probeArgs);
  check('anon CANNOT execute fn_blend_block_facts (a real call, not a grant lookup)', () => {
    assert.ok(anonCall.error, 'anon executed the function — the REVOKE is gone');
  });

  const svcCall = await svc.rpc('fn_blend_block_facts', probeArgs);
  check('service_role CANNOT execute fn_blend_block_facts (no worker reads it)', () => {
    assert.ok(svcCall.error, 'service_role executed the function — an unintended grant appeared');
  });

  const anonProbe = await anon.rpc('fn_blend_block_facts_probe');
  check('anon CANNOT execute the verify probe either', () => {
    assert.ok(anonProbe.error, 'anon reached the probe — it bypasses the grant');
  });

  // --- the probe itself ---
  const t0 = Date.now();
  const probeRes = await svc.rpc('fn_blend_block_facts_probe');
  const ms = Date.now() - t0;
  assert.ok(!probeRes.error, `fn_blend_block_facts_probe failed: ${probeRes.error?.message}`);
  const probe = probeRes.data as unknown as Json;
  assert.ok(
    probe && typeof probe === 'object',
    'the probe returned nothing — an empty probe is a FAILURE, not a pass',
  );

  console.log(`\nlive (probe: ${ms} ms wall clock) --------------------------------`);

  check(`the probe stays under the ${PROBE_MS_BUDGET} ms SHAPE budget`, () => {
    assert.ok(ms < PROBE_MS_BUDGET, `probe took ${ms} ms — check it has not grown a whole-history population`);
  });

  // --- (a) POSTURE, from the catalog, as a second witness to the real calls above ---
  const posture = obj(probe, 'posture');
  check('catalog posture: authenticated yes, anon no, service_role no', () => {
    assert.equal(posture.facts_authenticated, true);
    assert.equal(posture.facts_anon, false);
    assert.equal(posture.facts_service_role, false);
  });
  check('catalog posture: the probe is service_role-only', () => {
    assert.equal(posture.probe_service_role, true);
    assert.equal(posture.probe_authenticated, false);
    assert.equal(posture.probe_anon, false);
  });
  check('catalog posture: SECURITY INVOKER, both STABLE, both search_path-pinned, commented', () => {
    assert.equal(n(posture, 'facts_invoker'), 1);
    assert.equal(n(posture, 'stable_count'), 2);
    assert.equal(n(posture, 'search_path_pinned'), 2);
    assert.equal(n(posture, 'commented'), 1);
  });

  check('the CATALOG agrees: no money-named argument or column on the function', () => {
    const cols = posture.facts_columns;
    assert.ok(Array.isArray(cols) && cols.length >= 14, 'the catalog column list is missing');
    const offenders = (cols as string[]).filter((c) => MONEY_KEY_RE.test(c));
    assert.deepEqual(offenders, [], `money-named names on the function: ${offenders.join(', ')}`);
  });

  // --- (b) THE POPULATION, and the precondition for an EXACT as_of = today equality ---
  const facts = arr(probe, 'facts_today');
  const viewRows = arr(probe, 'view_rows');
  const ageRows = arr(probe, 'age_view_rows');
  const gridCount = n(probe, 'grid_batch_count');
  const today = String(probe.manila_today);
  const outOfWindow = obj(probe, 'out_of_window');

  console.log(
    `\n  population: ${gridCount} grid batches · ${facts.length} fact rows · ` +
      `${viewRows.length} (block, supplier) view rows · ${ageRows.length} age-view rows · as of ${today}`,
  );

  check('one fact row per batch asked about, and every row dated as of the Manila date', () => {
    assert.equal(facts.length, gridCount, 'the function did not answer for every grid batch');
    const ids = new Set(facts.map((f) => String(f.batch_id)));
    assert.equal(ids.size, facts.length, 'a batch_id appears twice — the key is not unique');
    for (const f of facts) assert.equal(String(f.as_of), today, `row ${f.batch_code} is dated ${f.as_of}`);
  });

  check('the as_of = today equality has NO out-of-window deliveries hiding behind it', () => {
    // A future-dated or undated delivery would legitimately make the equalities below
    // disagree with view_blocking_block_suppliers, which applies no date filter at all.
    // It is 0 / 0 today; if it stops being 0 THIS is what explains a failure.
    assert.equal(n(outOfWindow, 'future_dated'), 0, 'a future-dated delivery exists — read the header');
    assert.equal(n(outOfWindow, 'null_dated'), 0, 'an undated delivery exists — read the header');
  });

  // --- (c) THE REUSE PROOF against view_blocking_block_suppliers ---
  const viewByBatch = new Map<string, { count: number; flagCount: number; kg: Map<string, number> }>();
  for (const r of viewRows) {
    const id = String(r.batch_id);
    let bucket = viewByBatch.get(id);
    if (!bucket) {
      bucket = { count: 0, flagCount: Number(r.supplier_count_in_block), kg: new Map() };
      viewByBatch.set(id, bucket);
    }
    bucket.count += 1;
    bucket.kg.set(String(r.supplier_key), Number(r.kg));
  }

  check('supplier_count EQUALS view_blocking_block_suppliers, on every batch', () => {
    let mismatches = 0;
    for (const f of facts) {
      const v = viewByBatch.get(String(f.batch_id));
      if (!v) {
        mismatches += 1;
        continue;
      }
      if (Number(f.supplier_count) !== v.count) mismatches += 1;
    }
    assert.equal(mismatches, 0, `${mismatches} batches disagree with the view about how many suppliers filled them`);
  });

  check('is_single_supplier IS the view\'s supplier_count_in_block = 1 — the green/orange rule', () => {
    // THE one-definition proof for the flag the UI colours from. If this fails, the blend
    // modal and the Blocking supplier search have started disagreeing about a block.
    let mismatches = 0;
    for (const f of facts) {
      const v = viewByBatch.get(String(f.batch_id));
      if (!v) continue;
      if (f.is_single_supplier !== (v.flagCount === 1)) mismatches += 1;
    }
    assert.equal(mismatches, 0, `${mismatches} batches disagree about ALL-vs-SOME`);
  });

  check('the per-supplier KILOGRAMS equal the view\'s, gap exactly 0, and the pair sets match', () => {
    let pairGap = 0;
    let maxGap = 0;
    for (const f of facts) {
      const v = viewByBatch.get(String(f.batch_id));
      const ours = Array.isArray(f.suppliers) ? (f.suppliers as Json[]) : [];
      if (!v) {
        pairGap += ours.length;
        continue;
      }
      const seen = new Set<string>();
      for (const s of ours) {
        const key = String(s.key);
        seen.add(key);
        const theirs = v.kg.get(key);
        if (theirs === undefined) {
          pairGap += 1;
          continue;
        }
        maxGap = Math.max(maxGap, Math.abs(Number(s.kg) - theirs));
      }
      for (const key of v.kg.keys()) if (!seen.has(key)) pairGap += 1;
    }
    assert.equal(pairGap, 0, `${pairGap} (batch, supplier) pairs exist on one side only`);
    assert.equal(maxGap, 0, `max kg gap is ${maxGap}, not 0`);
  });

  // --- (d) THE SHARES, and the DOMINANT supplier ---
  check('Σ share_pct = 100 per batch (±1e-9), over the batch\'s own kilograms', () => {
    for (const f of facts) {
      const ours = Array.isArray(f.suppliers) ? (f.suppliers as Json[]) : [];
      if (ours.length === 0) continue;
      const sum = ours.reduce((s, x) => s + Number(x.share_pct), 0);
      assert.ok(Math.abs(sum - 100) < 1e-9, `${f.batch_code}: shares sum to ${sum}`);
    }
  });

  check('the DOMINANT supplier is the largest, and its share is its own kg over the batch', () => {
    for (const f of facts) {
      const ours = Array.isArray(f.suppliers) ? (f.suppliers as Json[]) : [];
      if (ours.length === 0) {
        assert.equal(f.dominant_supplier_key, null, `${f.batch_code} names a dominant supplier with no suppliers`);
        continue;
      }
      // the list itself is ordered biggest first, and the dominant fields are that row
      for (let i = 1; i < ours.length; i += 1) {
        assert.ok(
          Number(ours[i - 1].kg) >= Number(ours[i].kg),
          `${f.batch_code}: suppliers are not ordered by kg descending`,
        );
      }
      assert.equal(f.dominant_supplier_key, ours[0].key, `${f.batch_code}: dominant is not the biggest supplier`);
      assert.equal(f.dominant_supplier_display, ours[0].display, `${f.batch_code}: dominant display mismatched`);
      assert.equal(
        Number(f.dominant_share_pct),
        Number(ours[0].share_pct),
        `${f.batch_code}: dominant share is not the biggest supplier's own share`,
      );
    }
  });

  check('a kg TIE breaks on the alphabetically-first canonical key — deterministically', () => {
    let ties = 0;
    for (const f of facts) {
      const ours = Array.isArray(f.suppliers) ? (f.suppliers as Json[]) : [];
      for (let i = 1; i < ours.length; i += 1) {
        if (Number(ours[i - 1].kg) !== Number(ours[i].kg)) continue;
        ties += 1;
        assert.ok(
          String(ours[i - 1].key) < String(ours[i].key),
          `${f.batch_code}: an equal-kg pair is not in key order`,
        );
      }
    }
    console.log(`      (${ties} equal-kg supplier pairs in today's yard)`);
  });

  // --- (e) THE DATES, reconciled with view_batch_age_days ---
  const ageByCode = new Map<string, { first: string | null; last: string | null }>(
    ageRows.map((a) => [
      String(a.batch_code),
      { first: (a.first_delivery_date as string | null) ?? null, last: (a.last_delivery_date as string | null) ?? null },
    ]),
  );

  check('first/last_delivery_date EQUAL view_batch_age_days\' own columns of the same name', () => {
    // These dates must never become a rival to view_batch_age_days.age_days (the
    // kg-weighted mean delivery date the AGE LENS reads). Proving them equal to that
    // view's own date columns is what keeps them a different FACT rather than a second
    // definition of the same one.
    let mismatches = 0;
    let both = 0;
    for (const f of facts) {
      const a = ageByCode.get(String(f.batch_code));
      if (!a) continue;
      both += 1;
      if ((f.first_delivery_date ?? null) !== a.first) mismatches += 1;
      if ((f.last_delivery_date ?? null) !== a.last) mismatches += 1;
    }
    assert.ok(both > 0, 'no batch is covered by both — the comparison did nothing');
    assert.equal(mismatches, 0, `${mismatches} date disagreements against view_batch_age_days`);
  });

  check('the DATED populations are the same SET', () => {
    const oursDated = new Set(facts.filter((f) => f.first_delivery_date !== null).map((f) => String(f.batch_code)));
    const theirsDated = new Set(
      facts.filter((f) => ageByCode.has(String(f.batch_code))).map((f) => String(f.batch_code)),
    );
    assert.equal(oursDated.size, theirsDated.size, 'the two dated populations are different sizes');
    for (const c of oursDated) assert.ok(theirsDated.has(c), `${c} is dated here but absent from view_batch_age_days`);
  });

  check('the DAY COUNTS are exactly as_of minus the date, and last <= first is impossible', () => {
    const dayOf = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
    for (const f of facts) {
      if (f.first_delivery_date === null) {
        assert.equal(f.days_since_opened, null, `${f.batch_code}: undated but carries days_since_opened`);
        continue;
      }
      const asOf = dayOf(String(f.as_of));
      assert.equal(
        Number(f.days_since_opened),
        asOf - dayOf(String(f.first_delivery_date)),
        `${f.batch_code}: days_since_opened is not as_of - first_delivery_date`,
      );
      assert.equal(
        Number(f.days_since_last_piled),
        asOf - dayOf(String(f.last_delivery_date)),
        `${f.batch_code}: days_since_last_piled is not as_of - last_delivery_date`,
      );
      assert.ok(
        Number(f.days_since_opened) >= Number(f.days_since_last_piled),
        `${f.batch_code}: last piled BEFORE opened`,
      );
    }
  });

  // --- (f) THE AS-OF RULE, on a REAL block ---
  const flip = probe.flip_candidate as Json | null;
  if (flip && typeof flip === 'object') {
    const nowRow = obj(flip, 'today');
    const cutRow = obj(flip, 'at_cut');
    const cut = String(flip.cut_date);

    console.log(
      `\n  as-of flip on a REAL block: ${nowRow.batch_code} — ` +
        `today ${nowRow.supplier_count} suppliers (${nowRow.dominant_supplier_display} ` +
        `${Number(nowRow.dominant_share_pct).toFixed(2)}%), as of ${cut} ${cutRow.supplier_count} ` +
        `(${cutRow.dominant_supplier_display} ${Number(cutRow.dominant_share_pct).toFixed(2)}%)`,
    );

    check('AS-OF WORKS: an earlier date flips a MIXED block (orange) to SINGLE-supplier (green)', () => {
      assert.equal(nowRow.batch_code, cutRow.batch_code, 'the two rows describe different batches');
      assert.equal(cutRow.as_of, cut, 'the earlier call did not use the date it was given');
      assert.ok(Number(nowRow.supplier_count) > 1, 'the candidate is not mixed today');
      assert.equal(nowRow.is_single_supplier, false, 'a mixed block does not read ORANGE today');
      assert.equal(Number(cutRow.supplier_count), 1, 'the earlier date did not narrow to one supplier');
      assert.equal(cutRow.is_single_supplier, true, 'the narrowed block does not read GREEN');
      assert.equal(Number(cutRow.dominant_share_pct), 100, 'a single-supplier block is not 100%');
    });

    check('the earlier date can only SHRINK the block — fewer deliveries, no later arrival', () => {
      assert.ok(
        Number(cutRow.delivery_count) < Number(nowRow.delivery_count),
        'the earlier date counted as many deliveries as today',
      );
      assert.ok(
        String(cutRow.last_delivery_date) <= cut,
        'the earlier date returned a delivery dated after it',
      );
      assert.equal(
        cutRow.first_delivery_date,
        nowRow.first_delivery_date,
        'the date the block was OPENED moved — only later arrivals should drop out',
      );
      assert.ok(
        Number(cutRow.days_since_opened) < Number(nowRow.days_since_opened),
        'the as-of date did not move the day count',
      );
    });
  } else {
    console.log(
      "\n  ! NOTE: today's yard holds no block whose second supplier arrived later, so the\n" +
        '    orange -> green flip could not be exercised on live data. The as-of rule is still\n' +
        '    proven by the undated case below, but this is a WEAKER run, not a passing one.',
    );
  }

  // --- (g) NULL IS NEVER 0 ---
  const undated = obj(probe, 'undated_case');
  const undatedRow = obj(undated, 'row');

  check('NULL IS NEVER 0: a block with no delivery as of that date reads blank, not green and fresh', () => {
    assert.equal(undatedRow.as_of, '2000-01-01', 'the undated probe did not use the early date');
    assert.ok(String(undatedRow.batch_code).length > 0, 'the row lost its batch_code');
    assert.equal(Number(undatedRow.supplier_count), 0, 'supplier_count is not 0');
    assert.equal(Number(undatedRow.delivery_count), 0, 'delivery_count is not 0');
    assert.deepEqual(undatedRow.suppliers, [], 'suppliers is not an EMPTY ARRAY');
    // The five NULLs, and the flag is the one that matters most: `false` would paint a
    // pile nobody has delivered into as MIXED.
    assert.equal(undatedRow.is_single_supplier, null, 'is_single_supplier is not NULL — it must not be false');
    assert.equal(undatedRow.dominant_supplier_key, null, 'a dominant supplier was invented');
    assert.equal(undatedRow.dominant_supplier_display, null, 'a dominant display was invented');
    assert.equal(undatedRow.dominant_share_pct, null, 'a dominant share was invented');
    assert.equal(undatedRow.first_delivery_date, null, 'an opening date was invented');
    assert.equal(undatedRow.last_delivery_date, null, 'a last-piled date was invented');
    assert.equal(undatedRow.days_since_opened, null, 'days_since_opened is not NULL — 0 would mean "opened today"');
    assert.equal(undatedRow.days_since_last_piled, null, 'days_since_last_piled is not NULL');
  });

  check('an id that is NOT a batch returns NO ROW — never a zero-filled one', () => {
    assert.equal(n(probe, 'unknown_id_row_count'), 0, 'an unknown uuid produced a row');
    assert.equal(n(probe, 'empty_input_row_count'), 0, 'an empty id list produced rows');
    assert.equal(n(probe, 'null_input_row_count'), 0, 'a NULL id list produced rows');
  });

  check('NOT ONE money-named key appears anywhere in a fact row', () => {
    const keys = new Set<string>();
    for (const f of facts) {
      for (const k of Object.keys(f)) keys.add(k);
      const ours = Array.isArray(f.suppliers) ? (f.suppliers as Json[]) : [];
      for (const s of ours) for (const k of Object.keys(s)) keys.add(`suppliers.${k}`);
    }
    assert.ok(keys.size >= 14, `only ${keys.size} keys seen — the scan is not working`);
    const offenders = [...keys].filter((k) => MONEY_KEY_RE.test(k));
    assert.deepEqual(offenders, [], `money-named keys in the payload: ${offenders.join(', ')}`);
  });

  // A small readable sample: one green block, one orange block.
  const green = facts.find((f) => f.is_single_supplier === true);
  const orange = facts.find((f) => f.is_single_supplier === false);
  console.log('\n  sample (what the "Selected blocks" table will show) -------------');
  for (const [label, f] of [['GREEN ', green], ['ORANGE', orange]] as const) {
    if (!f) continue;
    console.log(
      `    ${label} ${String(f.batch_code).padEnd(16)} ${String(f.supplier_count)} supplier(s)  ` +
        `${String(f.dominant_supplier_display).padEnd(12)} ${Number(f.dominant_share_pct).toFixed(2).padStart(6)}%  ` +
        `opened ${f.first_delivery_date} (${f.days_since_opened}d)  ` +
        `last piled ${f.last_delivery_date} (${f.days_since_last_piled}d)  ` +
        `${f.delivery_count} deliveries`,
    );
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('verify-blend-block-facts — the blend-modal block facts data layer');
  staticChecks();

  const env = readEnv();
  if (!env) {
    console.log('\n  ! SKIPPING the live half: no NEXT_PUBLIC_SUPABASE_URL / keys found.');
    console.log('    The static half passed, but nothing about the live function was proven.');
  } else {
    await liveChecks(env);
  }

  console.log(`\n${passed} assertions passed.`);
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
