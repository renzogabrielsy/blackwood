/**
 * verify-blocking-age-lens.ts — the proofs behind the BLOCKING AGE LENS data layer.
 *
 * Run: npx tsx scripts/verify-blocking-age-lens.ts
 *
 * ============================================================================
 * WHAT THE FEATURE IS, AND WHAT CAN GO WRONG WITH IT
 * ============================================================================
 * The SECOND lens on the Blocking grid (migration `20260919133042_blocking_age_lens`),
 * sibling of the price lens: tint every occupied block by HOW OLD its charcoal is, with
 * a ratio of the yard per age band, cut by default at 60 / 120 / 365 days.
 *
 * Almost nothing here is a new number — "age" already lives in
 * `view_analytics_aging_watchlist.age_days` and a block's balance in
 * `view_blocking_grid` — so the failure modes worth testing are the ones this codebase
 * keeps meeting:
 *
 *   ONE DEFINITION  a lens that re-derives "age" slightly differently from the aging
 *                   views, so the Blocking page and /analytics disagree about how old
 *                   the same pile is. PROVEN by joining `view_batch_age_days` to the
 *                   watchlist and requiring a gap of EXACTLY 0 on every batch both
 *                   cover — the assertion that fails if either copy is ever edited.
 *   FOLDS           bands that do not add up to the yard. PROVEN: Σ band block_count +
 *                   undated = total, the same for kg with gap exactly 0, both share
 *                   families summing to 100, and the whole population equal to the
 *                   PRICE lens's — the two lenses must describe ONE yard.
 *   NULL ≠ 0        a block whose batch has no dated delivery painted as the FRESHEST
 *                   band, i.e. "brand new" when the truth is "we don't know". That is
 *                   the ₱11.01-vs-₱39.99 `avg_cost` bug in its third costume. PROVEN:
 *                   it is in NO band and out of both denominators and every weighted
 *                   age.
 *   POSTURE         the grants, PROVEN by ASSUMING THE VICTIM'S ROLE and really calling
 *                   the function (L-043's lesson), not by reading the grant table.
 *   THE MISSING     …and the one that is specific to this lens: somebody "fixing" the
 *   GATE            asymmetry with its price sibling by adding a `canViewPrices()` gate.
 *                   There is no money in this payload, so a gate would hide an age
 *                   figure from Production — the one role that walks the yard. This
 *                   script asserts the gate's ABSENCE, and asserts that no key anywhere
 *                   in the payload is money-named.
 *
 * ============================================================================
 * WHY THE NUMBERS COME FROM A PROBE RPC AND NOT FROM DIRECT CALLS
 * ============================================================================
 * `fn_blocking_age_lens` is `authenticated`-only BY DESIGN (`anon` revoked,
 * `service_role` deliberately NOT granted so `verify-worker-view-grants` stays at 4
 * views / 0 findings), and no verify script in this repo holds a user JWT. So the only
 * key this script has cannot call it — which is the point of the grant, and is exactly
 * what `fn_blocking_price_lens_probe` and the ops-ledger probes solved.
 * `fn_blocking_age_lens_probe()` is that door.
 *
 * THE PROBE ASSERTS NOTHING. It calls the lens a fixed number of times, recomputes the
 * grid's totals and the default band split INDEPENDENTLY, joins our age view to the
 * watchlist, and hands everything back — every assertion below is TypeScript a human
 * can read. It is deliberately NOT a whole-database verifier: the 2026-09-14
 * `fn_ops_ledger_verify()` incident OOM-ed the instance and took the live site down.
 * Every population here is bounded BY CONSTRUCTION — one row per occupied block (168
 * today, 238 slots maximum), one row per batch code with a delivery (659), 170
 * watchlist rows.
 *
 * MEASURED 2026-09-19 with `set local statement_timeout='5s'` then
 * EXPLAIN (ANALYZE, BUFFERS):
 *   the per-batch age fold alone (659 batch codes)         2.57 ms /    76 buffers
 *   view_blocking_grid alone (balance > 0, 168 rows)       2.85 ms /   451 buffers
 *   the lens's core query                                   8.05 ms /   530 buffers
 *   SELECT fn_blocking_age_lens()  (warm)                  14.3 ms / 2,095 buffers
 * 530 = 451 (ONE grid scan) + 76 (ONE age fold) + 3. The ceiling below is a SHAPE
 * alarm, not a latency SLO — see PROBE_MS_BUDGET.
 *
 * ============================================================================
 * ₱ IN THIS SCRIPT'S OUTPUT
 * ============================================================================
 * None, and that is a checked fact rather than a promise: the age payload has no
 * money-named key anywhere (asserted), so nothing this script prints is a price. It
 * prints days, kilograms, counts and percentages.
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

const MIGRATION = 'supabase/migrations/20260919133042_blocking_age_lens.sql';
const PRICE_MIGRATION = 'supabase/migrations/20260919025729_blocking_price_lens.sql';
const ACTIONS = 'app/(app)/inventory/blocking/actions.ts';
const TYPES = 'app/(app)/inventory/blocking/types.ts';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

/**
 * A SHAPE alarm, not a performance SLO — the same reasoning as the price lens's. What it
 * must catch is one call walking a whole-history population; what it must NOT fire on is
 * instance load, and the wall-clock here is round-trip dominated
 * (verify-ops-ledger records a probe costing 280 ms server-side reading 4,671 ms from a
 * laptop). The probe makes 10 lens calls plus four independent aggregations, so ~1 s of
 * server work is the honest expectation and 15 s is ~15x that.
 */
const PROBE_MS_BUDGET = 15_000;

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
    const sig = 'fn_blocking_age_lens(int[])';
    assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC;`), 'PUBLIC not revoked');
    assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon;`), 'anon not revoked');
    assert.ok(sql.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO authenticated;`), 'authenticated missing');
    // service_role appears in this file for the PROBE and nowhere else.
    const svc = sql.match(/TO service_role/g) ?? [];
    assert.equal(svc.length, 1, 'service_role is granted somewhere other than the probe');
    assert.ok(
      sql.includes('GRANT  EXECUTE ON FUNCTION public.fn_blocking_age_lens_probe() TO service_role;'),
      'the probe is not the thing service_role was granted',
    );
  });

  check('the probe is service_role-only — authenticated and anon are BOTH revoked', () => {
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      assert.ok(
        sql.includes(`REVOKE EXECUTE ON FUNCTION public.fn_blocking_age_lens_probe() FROM ${role};`),
        `probe: ${role} not revoked`,
      );
    }
  });

  check('view_batch_age_days: security_invoker, authenticated SELECT, anon revoked, no service_role', () => {
    assert.ok(
      sql.includes('ALTER VIEW public.view_batch_age_days SET (security_invoker = true);'),
      'security_invoker not asserted — CREATE OR REPLACE VIEW RESETS reloptions',
    );
    assert.ok(sql.includes('REVOKE ALL     ON public.view_batch_age_days FROM anon;'), 'anon not revoked on the view');
    assert.ok(sql.includes('GRANT  SELECT  ON public.view_batch_age_days TO authenticated;'), 'authenticated SELECT missing');
    assert.ok(
      !/GRANT[^;]*ON public\.view_batch_age_days[^;]*service_role/.test(sql),
      'the view is granted to service_role — verify-worker-view-grants would grow a finding',
    );
  });

  check('view_batch_age_days declares NOT ONE money-named column', () => {
    // Read off the migration's own SELECT list rather than from a live row, because
    // service_role holds no grant on the view (by design) — a "no money columns found"
    // built on a failed read would be a vacuous pass, which is worse than no check.
    const at = sql.indexOf('CREATE OR REPLACE VIEW public.view_batch_age_days AS');
    assert.ok(at > 0, 'the view definition is not in the migration');
    const body = sql.slice(at, sql.indexOf('\nALTER VIEW public.view_batch_age_days', at));
    // Every `AS <alias>` in the published SELECT list, plus the bare `del.<col>` passthroughs.
    const aliases = [...body.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
    const passthrough = [...body.matchAll(/\bdel\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
    const cols = [...new Set([...aliases, ...passthrough])];
    assert.ok(cols.length >= 8, `only found ${cols.length} column names — the scan is not working`);
    const offenders = cols.filter((c) => MONEY_KEY_RE.test(c));
    assert.deepEqual(offenders, [], `money-named columns on view_batch_age_days: ${offenders.join(', ')}`);
  });

  check('the lens function and the view both carry a COMMENT', () => {
    assert.ok(sql.includes('COMMENT ON FUNCTION public.fn_blocking_age_lens(int[]) IS'), 'no function COMMENT');
    assert.ok(sql.includes('COMMENT ON VIEW public.view_batch_age_days IS'), 'no view COMMENT');
  });

  check('the migration does NOT touch view_analytics_aging_watchlist', () => {
    // THE decision this feature turns on. Re-pointing a ₱-bearing analytics view the
    // /analytics page reads live — with the `reloptions` reset trap in the way — was
    // rejected in favour of proving the two ages equal on every run (see `age_reuse`
    // below). If someone later does re-point it, this assertion is the place to say so
    // deliberately rather than discovering it in a diff.
    for (const bad of [
      'CREATE OR REPLACE VIEW public.view_analytics_aging_watchlist',
      'DROP VIEW public.view_analytics_aging_watchlist',
      'ALTER VIEW public.view_analytics_aging_watchlist',
    ]) {
      assert.ok(!sql.includes(bad), `the migration modifies the watchlist (${bad})`);
    }
  });

  check('the hot CTEs carry their MATERIALIZED hints (explicit insurance, see the header)', () => {
    for (const cte of ['bands AS MATERIALIZED', 'src AS MATERIALIZED', 'classified AS MATERIALIZED']) {
      assert.ok(sql.includes(cte), `${cte} lost its MATERIALIZED hint`);
    }
    // ...and the migration is HONEST about what they bought, because the measurement did
    // not say what was expected (Postgres already materializes a multiply-referenced CTE).
    assert.ok(/EXPLICIT INSURANCE/.test(sql), 'the header no longer states what the hints actually buy');
  });

  check('the AGE EXPRESSION is written in SQL only — never re-derived in TypeScript', () => {
    // The day-number epoch is the tell: if '2000-01-01' or a weight×date product ever
    // appears in the app, a second definition of age has been born.
    assert.ok(sql.includes("'2000-01-01'::date"), 'the epoch moved out of the migration');
    const actions = read(ACTIONS);
    assert.ok(!actions.includes('2000-01-01'), 'the age epoch appears in actions.ts — a second definition');
    assert.ok(!/weight_kg\s*\*/.test(actions), 'a weight-times-something product appears in actions.ts');
  });

  const actions = read(ACTIONS);
  const ageStart = actions.indexOf('export async function fetchBlockingAgeLens(');
  assert.ok(ageStart > 0, 'fetchBlockingAgeLens not found');
  // BOUNDED AT THE NEXT SECTION DIVIDER (the file's own `// ─── <name> ───` convention),
  // not at end-of-file. Slicing to the end used to work only because nothing after this
  // action carried a price gate; `fetchBlendAnalysis` (2026-09-21) legitimately does — and
  // its own block comment names `canViewPrices()` in prose — so an unbounded slice would
  // have read ITS gate as this one's. Bounding at the divider rather than at the next
  // `export` is what keeps that neighbouring PROSE out too. Strictly MORE precise, never
  // weaker.
  const ageEnd = [
    actions.indexOf('\n// ─── ', ageStart + 1),
    actions.indexOf('\nexport async function ', ageStart + 1),
  ]
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  const ageBody = actions.slice(ageStart, ageEnd ?? undefined);
  assert.ok(ageBody.includes("'fn_blocking_age_lens'"), 'the isolated body is not the age lens action');
  assert.ok(!ageBody.includes('fetchBlendBlockFacts'), 'the slice leaked into the next section');

  check('fetchBlockingAgeLens has NO canViewPrices gate — and that is the point', () => {
    // THE central rule of this lens. Nothing in the payload is money and none is
    // derivable, so a gate here would hide an age figure from Production, the one role
    // that walks the yard. Its price sibling refuses such a caller BEFORE the database;
    // this one must not.
    assert.ok(!/canViewPrices/.test(ageBody), 'a canViewPrices gate appeared in fetchBlockingAgeLens');
    assert.ok(!/canViewPricesGate/.test(ageBody), 'a canViewPricesGate call appeared in fetchBlockingAgeLens');
    assert.ok(!/prices_hidden/.test(ageBody), "a prices_hidden refusal appeared — this lens has no price gate");
  });

  check('fetchBlockingAgeLens DOES require a signed-in user, like its non-price siblings', () => {
    assert.ok(/auth\.getUser\(\)/.test(ageBody), 'no auth.getUser() — the action does not require a session');
    assert.ok(/not_signed_in/.test(ageBody), 'no typed not_signed_in refusal');
    const authAt = ageBody.indexOf('auth.getUser()');
    const rpcAt = ageBody.indexOf('.rpc(');
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

  /** Comment lines stripped, so a rule quoted in prose cannot pass for a rule in code. */
  const ageCode = ageBody
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  check('the action does NO arithmetic (CLAUDE.md: never aggregate in TypeScript)', () => {
    assert.ok(!/\.reduce\(/.test(ageCode), 'a reduce() means a total moved out of SQL');
    assert.ok(!/\+=/.test(ageCode), 'a += means a sum moved out of SQL');
    assert.ok(!/Math\.(floor|ceil|round)/.test(ageCode), 'rounding moved out of SQL');
  });

  check('NULL is never coerced to 0 on an open bound, a share or a weighted age', () => {
    for (const f of [
      'upperDays: lensNumOrNull(b.upper_days)',
      'kgSharePct: lensNumOrNull(b.kg_share_pct)',
      'blockSharePct: lensNumOrNull(b.block_share_pct)',
      'kgWeightedAgeDays: lensNumOrNull(b.kg_weighted_age_days)',
    ]) {
      assert.ok(ageBody.includes(f), `${f} missing — a 0 here would be read as a real answer`);
    }
    // ...and lowerDays is the deliberate exception: age has a FLOOR, so band 0 starts at
    // a literal 0 rather than an open NULL.
    assert.ok(ageBody.includes('lowerDays: lensNum(b.lower_days)'), 'lowerDays should NOT be null-preserving');
  });

  const types = read(TYPES);

  check('the cut-line cap and day bounds are ONE definition, shared with SQL', () => {
    assert.ok(types.includes('BLOCKING_AGE_LENS_MAX_EDGES = 6'), 'edge cap constant moved');
    assert.ok(types.includes('BLOCKING_AGE_EDGE_MIN_DAYS = 1'), 'min-day constant moved');
    assert.ok(types.includes('BLOCKING_AGE_EDGE_MAX_DAYS = 5000'), 'max-day constant moved');
    assert.ok(
      types.includes('BLOCKING_AGE_LENS_DEFAULT_EDGES: readonly number[] = [60, 120, 365]'),
      'the default cut lines moved',
    );
    // and SQL agrees, digit for digit
    assert.ok(sql.includes('cardinality(v_edges) > 6'), 'the SQL cut-line cap is not 6');
    assert.ok(sql.includes('WHERE e > 5000'), 'the SQL day ceiling is not 5000');
    assert.ok(sql.includes('WHERE e <= 0'), 'the SQL positivity guard moved');
    assert.ok(sql.includes('ARRAY[60, 120, 365]'), 'the SQL default cut lines moved');
    // the action imports them rather than re-typing them
    for (const c of [
      'BLOCKING_AGE_LENS_DEFAULT_EDGES',
      'BLOCKING_AGE_LENS_MAX_EDGES',
      'BLOCKING_AGE_EDGE_MIN_DAYS',
      'BLOCKING_AGE_EDGE_MAX_DAYS',
    ]) {
      assert.ok(actions.includes(c), `the action re-types ${c} instead of importing it`);
    }
  });

  check('INTEGRALITY is enforced in the action, where it is decidable (int[] rounds first)', () => {
    assert.ok(/Number\.isInteger\(e\)/.test(actions), 'no integrality check on a cut line');
    // the same reasoning the price lens recorded, and the same `invalid_edge` reason
    assert.ok(/invalid_edge/.test(ageBody), 'the action does not reuse the SQL invalid_edge reason');
  });

  check('the price lens migration is untouched by this change', () => {
    const price = read(PRICE_MIGRATION);
    assert.ok(price.includes('fn_blocking_price_lens_probe'), 'the price probe is gone');
    assert.ok(!price.includes('age_lens'), 'the age lens leaked into the price migration');
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

function bandLabel(band: Json): string {
  const lo = Number(band.lower_days);
  const hi = band.upper_days === null ? null : Number(band.upper_days);
  return `[${lo}, ${hi === null ? '+inf' : hi})d`;
}

/** Shared fold/contiguity proof, so the wide and single lenses get it too. */
function assertFolds(lens: Json, label: string): void {
  const bands = arr(lens, 'bands');
  const total = obj(lens, 'total');
  const undated = obj(lens, 'undated');

  const sumBlocks = bands.reduce((s, b) => s + Number(b.block_count), 0);
  const sumKg = bands.reduce((s, b) => s + Number(b.kg), 0);

  assert.equal(
    sumBlocks + n(undated, 'block_count'),
    n(total, 'block_count'),
    `${label}: blocks went missing between the bands and the total`,
  );
  const gap = sumKg + Number(undated.kg) - Number(total.kg);
  assert.equal(gap, 0, `${label}: kg gap is ${gap}, not 0`);

  // contiguity: band 0 starts at 0, each band's upper IS the next band's lower, last open
  assert.equal(Number(bands[0].lower_days), 0, `${label}: band 0 does not start at day 0`);
  assert.equal(bands[bands.length - 1].upper_days, null, `${label}: the last band is not open above`);
  for (let i = 0; i < bands.length - 1; i += 1) {
    assert.ok(bands[i].upper_days !== null, `${label}: band ${i} has no upper bound`);
    assert.equal(
      Number(bands[i].upper_days),
      Number(bands[i + 1].lower_days),
      `${label}: bands ${i} and ${i + 1} are not contiguous`,
    );
  }
  // and the bounds ARE the cut lines
  const edges = (lens.edge_days as number[]).map(Number);
  assert.equal(bands.length, edges.length + 1, `${label}: k edges did not give k+1 bands`);
  for (let i = 1; i < bands.length; i += 1) {
    assert.equal(Number(bands[i].lower_days), edges[i - 1], `${label}: band ${i} lower bound is off the cut line`);
  }

  // shares over the DATED population
  const datedBlocks = sumBlocks;
  if (datedBlocks > 0) {
    const kgShare = bands.reduce((s, b) => s + Number(b.kg_share_pct), 0);
    const blockShare = bands.reduce((s, b) => s + Number(b.block_share_pct), 0);
    assert.ok(Math.abs(kgShare - 100) < 1e-9, `${label}: kg shares sum to ${kgShare}`);
    assert.ok(Math.abs(blockShare - 100) < 1e-9, `${label}: block shares sum to ${blockShare}`);
  }

  // every block names a band that exists, its age sits inside it, and no loc repeats
  const blocks = arr(lens, 'blocks');
  const valid = new Map(bands.map((b) => [Number(b.index), b]));
  const seen = new Set<string>();
  for (const b of blocks) {
    const loc = String(b.block_loc);
    assert.ok(loc.length > 0, `${label}: a block entry has no block_loc`);
    assert.ok(!seen.has(loc), `${label}: block_loc ${loc} appears twice — the grid key is not unique`);
    seen.add(loc);
    const band = valid.get(Number(b.band_index));
    assert.ok(band, `${label}: block ${loc} is in band ${b.band_index}, which does not exist`);
    // The band was decided on the EXACT age while `age_days` is rounded to 1 dp, so a
    // block within 0.05 days of a cut line may display the cut value. Hence the 0.05
    // slack — anything larger would be a genuine misclassification.
    const age = Number(b.age_days);
    assert.ok(age >= Number(band!.lower_days) - 0.05, `${label}: ${loc} (${age}d) is below band ${b.band_index}`);
    if (band!.upper_days !== null) {
      assert.ok(age < Number(band!.upper_days) + 0.05, `${label}: ${loc} (${age}d) is above band ${b.band_index}`);
    }
  }
  assert.equal(blocks.length, sumBlocks, `${label}: the per-block list does not cover exactly the banded blocks`);

  // a band with no blocks reports NULL, never 0 days
  for (const b of bands) {
    if (Number(b.block_count) === 0) {
      assert.equal(b.kg_weighted_age_days, null, `${label}: empty band ${b.index} reports an age instead of null`);
      assert.equal(Number(b.kg), 0, `${label}: empty band ${b.index} carries kilograms`);
    } else {
      assert.ok(b.kg_weighted_age_days !== null, `${label}: band ${b.index} holds blocks but no weighted age`);
      // the band's own weighted age lies inside the band (same 0.05 rounding slack)
      const w = Number(b.kg_weighted_age_days);
      assert.ok(w >= Number(b.lower_days) - 0.05, `${label}: band ${b.index} weighted age is below its own floor`);
      if (b.upper_days !== null) {
        assert.ok(w < Number(b.upper_days) + 0.05, `${label}: band ${b.index} weighted age is above its own ceiling`);
      }
    }
  }
}

async function liveChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });

  console.log('\nlive posture (a REAL call as each victim role) -------------------');

  // L-043's lesson: prove a permission by ASSUMING THE VICTIM'S ROLE, never by reading
  // the grant table.
  const anonLens = await anon.rpc('fn_blocking_age_lens', { p_edge_days: [60, 120, 365] });
  check('anon CANNOT execute fn_blocking_age_lens (a real call, not a grant lookup)', () => {
    assert.ok(anonLens.error, 'anon executed the age lens — the REVOKE is gone');
  });

  const svcLens = await svc.rpc('fn_blocking_age_lens', { p_edge_days: [60, 120, 365] });
  check('service_role CANNOT execute fn_blocking_age_lens (no worker reads it)', () => {
    assert.ok(svcLens.error, 'service_role executed the age lens — an unintended grant appeared');
  });

  const anonView = await anon.from('view_batch_age_days').select('batch_code').limit(1);
  check('anon CANNOT read view_batch_age_days', () => {
    assert.ok(anonView.error, 'anon read the age view — the REVOKE is gone');
  });

  const anonProbe = await anon.rpc('fn_blocking_age_lens_probe');
  check('anon CANNOT execute the verify probe either', () => {
    assert.ok(anonProbe.error, 'anon reached the probe — it bypasses the grant');
  });

  // --- the probe itself ---
  const t0 = Date.now();
  const probeRes = await svc.rpc('fn_blocking_age_lens_probe');
  const ms = Date.now() - t0;
  assert.ok(!probeRes.error, `fn_blocking_age_lens_probe failed: ${probeRes.error?.message}`);
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
  check('catalog posture: view_batch_age_days is authenticated-only AND security_invoker', () => {
    assert.equal(posture.view_authenticated, true);
    assert.equal(posture.view_anon, false);
    assert.equal(posture.view_service_role, false);
    // CREATE OR REPLACE VIEW RESETS reloptions — the trap that bit
    // view_ops_ledger_campaign_kpis twice. This is the live guard for it.
    assert.equal(n(posture, 'view_security_invoker'), 1, 'the view is NOT security_invoker on the live DB');
  });
  check('catalog posture: 1 SECURITY INVOKER, 2 STABLE, 2 search_path-pinned, 1 commented', () => {
    assert.equal(n(posture, 'lens_invoker'), 1);
    assert.equal(n(posture, 'stable_count'), 2);
    assert.equal(n(posture, 'search_path_pinned'), 2);
    assert.equal(n(posture, 'commented'), 1);
  });

  // --- (b) NO MONEY ANYWHERE IN THE PAYLOAD ---
  const lens = obj(probe, 'lens_default');
  check('NOT ONE money-named key anywhere in the age payload', () => {
    // This is what licenses the missing price gate. Scanned recursively, so a money key
    // nested inside `bands[]` or `total` could not hide.
    const keys = new Set<string>();
    collectKeys(lens, keys);
    const offenders = [...keys].filter((k) => MONEY_KEY_RE.test(k));
    assert.deepEqual(offenders, [], `money-named keys in the age payload: ${offenders.join(', ')}`);
    assert.ok(keys.size > 10, 'the key scan found almost nothing — it is not actually walking the payload');
  });

  // --- (c) THE DEFAULT LENS ---
  const grid = obj(probe, 'grid');
  check('the default lens returned ok:true', () => assert.equal(lens.ok, true));

  const bands = arr(lens, 'bands');
  const lensTotal = obj(lens, 'total');
  const lensUndated = obj(lens, 'undated');

  check('the DEFAULT cut lines [60, 120, 365] give exactly FOUR bands', () => {
    assert.deepEqual(lens.edge_days, [60, 120, 365], 'the default cut lines are not [60, 120, 365]');
    assert.equal(bands.length, 4, `expected 4 bands, got ${bands.length}`);
  });

  check('as_of is the Asia/Manila calendar date', () => {
    assert.equal(String(lens.as_of), String(probe.manila_today), 'the lens measured ages against another date');
  });

  console.log('\n  the age lens, default cut lines --------------------------------');
  console.log(`    as of ${lens.as_of}`);
  for (const b of bands) {
    console.log(
      `    band ${b.index}  ${bandLabel(b).padEnd(16)}` +
        `${String(b.block_count).padStart(4)} blocks  ` +
        `${Number(b.kg).toLocaleString('en-US').padStart(12)} kg  ` +
        `${Number(b.kg_share_pct).toFixed(4).padStart(9)}% kg  ` +
        `${Number(b.block_share_pct).toFixed(4).padStart(9)}% blocks  ` +
        `wtd ${Number(b.kg_weighted_age_days).toFixed(2).padStart(8)} d`,
    );
  }
  console.log(
    `    undated   ${String(n(lensUndated, 'block_count')).padStart(4)} blocks  ` +
      `${Number(lensUndated.kg).toLocaleString('en-US').padStart(12)} kg   (in NO band)`,
  );
  console.log(
    `    TOTAL     ${String(n(lensTotal, 'block_count')).padStart(4)} blocks  ` +
      `${Number(lensTotal.kg).toLocaleString('en-US').padStart(12)} kg  ` +
      `wtd ${Number(lensTotal.kg_weighted_age_days).toFixed(4)} d  ` +
      `oldest ${lensTotal.oldest_age_days} d at ${lensTotal.oldest_block_loc}`,
  );

  // --- (d) THE FOLDS, on all four lenses ---
  check('default lens: bands contiguous from 0, last open, folds add up, shares = 100', () => {
    assertFolds(lens, 'default');
  });

  check('the banded population IS the grid\'s DATED positive-balance blocks', () => {
    // Computed in the probe straight off view_blocking_grid + view_batch_age_days,
    // independently of the lens, so this is an agreement rather than a tautology.
    const sumBlocks = bands.reduce((s, b) => s + Number(b.block_count), 0);
    const sumKg = bands.reduce((s, b) => s + Number(b.kg), 0);
    assert.equal(sumBlocks, n(grid, 'dated_block_count'), "band block count != the grid's dated blocks");
    assert.equal(sumKg - Number(grid.dated_kg), 0, 'band kg total != Σ balance over the dated blocks');
    assert.equal(n(lensTotal, 'block_count'), n(grid, 'block_count'), "lens total != the grid's occupied blocks");
    assert.equal(Number(lensTotal.kg) - Number(grid.kg), 0, 'lens total kg != Σ balance over the grid');
  });

  check('an UNDATED block is in NO band and out of both denominators (NULL is never 0 days)', () => {
    assert.equal(
      n(lensUndated, 'block_count'),
      n(grid, 'undated_block_count'),
      'the lens and the grid disagree about how many blocks have no age',
    );
    assert.equal(Number(lensUndated.kg) - Number(grid.undated_kg), 0, 'undated kg disagrees with the grid');
    // `blocks[]` is the band membership list, so an undated block must be absent…
    assert.equal(
      arr(lens, 'blocks').length,
      n(grid, 'dated_block_count'),
      'the per-block band list does not cover exactly the dated blocks',
    );
    // …and the two together account for everything, which is what makes "absent" mean
    // "undated" rather than "lost".
    assert.equal(arr(lens, 'blocks').length + n(lensUndated, 'block_count'), n(lensTotal, 'block_count'));
  });

  check('the weighted ages are the grid\'s own, and the oldest block agrees', () => {
    assert.equal(
      Number(lensTotal.kg_weighted_age_days) - Number(grid.kg_weighted_age_days),
      0,
      "the total weighted age != Σ(kg × age) / Σ kg over the grid's dated blocks",
    );
    // oldest_age_days is rounded to 1 dp, so compare within half a tenth
    assert.ok(
      Math.abs(Number(lensTotal.oldest_age_days) - Number(grid.oldest_age_days)) <= 0.05,
      'the published oldest age disagrees with the grid',
    );
    // and it IS the maximum of the per-block list
    const maxBlock = Math.max(...arr(lens, 'blocks').map((b) => Number(b.age_days)));
    assert.ok(
      Math.abs(maxBlock - Number(lensTotal.oldest_age_days)) <= 0.05,
      'oldest_age_days is not the oldest block in the list',
    );
    const oldestLoc = String(lensTotal.oldest_block_loc);
    const claimed = arr(lens, 'blocks').find((b) => String(b.block_loc) === oldestLoc);
    assert.ok(claimed, `oldest_block_loc ${oldestLoc} is not in the block list`);
    assert.ok(
      Math.abs(Number(claimed!.age_days) - maxBlock) <= 0.05,
      'oldest_block_loc does not name the oldest block',
    );
  });

  check('the per-band split matches an INDEPENDENT longhand aggregation, band for band', () => {
    const independent = arr(probe, 'grid_bands_default');
    const byIndex = new Map(independent.map((b) => [Number(b.index), b]));
    for (const b of bands) {
      const mine = byIndex.get(Number(b.index));
      if (Number(b.block_count) === 0) {
        assert.ok(!mine, `band ${b.index} is empty in the lens but present independently`);
        continue;
      }
      assert.ok(mine, `band ${b.index} holds blocks but is absent from the independent split`);
      assert.equal(Number(b.block_count), n(mine!, 'block_count'), `band ${b.index} block count disagrees`);
      assert.equal(Number(b.kg) - Number(mine!.kg), 0, `band ${b.index} kg disagrees`);
      assert.equal(
        Number(b.kg_weighted_age_days) - Number(mine!.kg_weighted_age_days),
        0,
        `band ${b.index} weighted age disagrees`,
      );
    }
  });

  // --- (e) THE ONE-DEFINITION PROOF ---
  const reuse = obj(probe, 'age_reuse');
  check('age EQUALS view_analytics_aging_watchlist.age_days on every batch both cover', () => {
    // THE assertion this whole design turns on. If it ever fails, the two copies of the
    // kg-weighted-mean-delivery-date expression have drifted — fix whichever one moved,
    // do not relax the tolerance.
    assert.ok(n(reuse, 'both_cover') > 0, 'the comparison covered no batches — an empty proof is a FAILURE');
    assert.equal(n(reuse, 'mismatches'), 0, 'our age disagrees with the aging watchlist on some batch');
    assert.equal(Number(reuse.max_gap), 0, `max gap is ${reuse.max_gap}, not exactly 0`);
  });
  console.log(
    `    one-definition: ${n(reuse, 'both_cover')} batches compared to view_analytics_aging_watchlist, ` +
      `${n(reuse, 'mismatches')} mismatches, max gap ${reuse.max_gap}`,
  );

  const coverage = obj(probe, 'coverage');
  check('the coverage gap that justifies NOT reading age straight from the watchlist', () => {
    // The watchlist floors at current_weight > 1000 kg; the grid floors at balance > 0.
    // Today they coincide, which is exactly why this has to be recorded rather than
    // relied on: a block fed down under a tonne would drop out of the watchlist while
    // staying on the grid, and reading age from there would call it UNDATED.
    assert.equal(n(coverage, 'grid_blocks'), n(grid, 'block_count'), 'the coverage read describes another population');
    assert.ok(
      n(coverage, 'in_watchlist') <= n(coverage, 'grid_blocks'),
      'more watchlist matches than grid blocks — the join is wrong',
    );
  });
  console.log(
    `    coverage:       ${n(coverage, 'in_watchlist')} of ${n(coverage, 'grid_blocks')} grid blocks are watchlist ` +
      `rows; ${n(coverage, 'grid_blocks_under_1t')} sit at or under the watchlist's 1t floor ` +
      `(min grid balance ${Number(coverage.min_grid_balance_kg).toLocaleString('en-US')} kg)`,
  );

  // --- (f) ONE YARD, TWO LENSES ---
  // The price probe recomputes the grid's totals off `view_blocking_grid` for its own
  // proofs, so it is an independent witness to the population this lens describes. Its
  // `grid` read needs no market price to exist, which is why the comparison hangs off
  // that rather than off `lens_live`.
  const priceProbeRes = await svc.rpc('fn_blocking_price_lens_probe', { p_trailing_days: 30 });
  assert.ok(!priceProbeRes.error, `fn_blocking_price_lens_probe failed: ${priceProbeRes.error?.message}`);
  const priceProbe = priceProbeRes.data as unknown as Json;
  const priceGrid = obj(priceProbe, 'grid');

  check('the AGE lens and the PRICE lens describe ONE yard', () => {
    assert.equal(
      n(lensTotal, 'block_count'),
      n(priceGrid, 'block_count'),
      'the two lenses disagree about how many blocks are occupied',
    );
    assert.equal(
      Number(lensTotal.kg) - Number(priceGrid.kg),
      0,
      'the two lenses disagree about how many kilograms are in the yard',
    );
  });

  const priceLens = priceProbe['lens_live'] as Json | undefined;
  check('…and where the price lens has a live basis, its own total agrees too', () => {
    if (!priceLens || priceLens.ok !== true) {
      // A basis with no priced market kilos is a legitimate answer (the 1st of a month),
      // so this arm is skipped rather than failed — the grid comparison above already
      // proved the shared population.
      console.log('      (skipped: the price lens has no live market basis right now)');
      return;
    }
    const pt = obj(priceLens, 'total');
    assert.equal(n(lensTotal, 'block_count'), n(pt, 'block_count'), 'block counts differ from the price lens total');
    assert.equal(Number(lensTotal.kg) - Number(pt.kg), 0, 'kilograms differ from the price lens total');
    // The two lenses bucket DIFFERENT blocks out (unpriced vs undated), so those two
    // numbers need not match — but each must be a subset of the shared total.
    assert.ok(
      n(obj(priceLens, 'unpriced'), 'block_count') <= n(pt, 'block_count'),
      'the price lens reports more unpriced blocks than it has blocks',
    );
    assert.ok(
      n(lensUndated, 'block_count') <= n(lensTotal, 'block_count'),
      'the age lens reports more undated blocks than it has blocks',
    );
  });

  // --- (g) MORE / FEWER CUT LINES ---
  const wide = obj(probe, 'lens_wide');
  check('six cut lines [30,60,90,120,180,365] give SEVEN bands, still folding to the same yard', () => {
    assert.equal(wide.ok, true);
    assert.deepEqual(wide.edge_days, [30, 60, 90, 120, 180, 365]);
    assert.equal(arr(wide, 'bands').length, 7, `expected 7 bands, got ${arr(wide, 'bands').length}`);
    assertFolds(wide, 'wide');
    // the yard does not change because the legend did
    assert.equal(Number(obj(wide, 'total').kg), Number(lensTotal.kg), 'the two lenses describe different yards');
    assert.equal(n(obj(wide, 'total'), 'block_count'), n(lensTotal, 'block_count'));
  });
  console.log(
    `    wider lens:  ${arr(wide, 'bands').map((b) => `${bandLabel(b)}=${b.block_count}`).join('  ')}`,
  );

  const single = obj(probe, 'lens_single');
  check('ONE cut line [365] gives TWO bands and still folds', () => {
    assert.equal(single.ok, true);
    assert.deepEqual(single.edge_days, [365]);
    assert.equal(arr(single, 'bands').length, 2, `expected 2 bands, got ${arr(single, 'bands').length}`);
    assertFolds(single, 'single');
    assert.equal(Number(obj(single, 'total').kg), Number(lensTotal.kg), 'the single-cut lens describes another yard');
  });

  const dupes = obj(probe, 'lens_dupes');
  check('duplicates and disorder collapse to the SAME lens as the default', () => {
    // [365, 60, 120, 60, 365] is five raw cut lines but three real ones, and the cap is
    // measured after the collapse — the same rule as the price lens's offsets.
    assert.equal(dupes.ok, true);
    assert.deepEqual(dupes.edge_days, [60, 120, 365], 'the cut lines were not de-duplicated and sorted');
    assert.deepEqual(arr(dupes, 'bands'), bands, 'a re-ordered duplicate list produced a different lens');
  });

  // --- (h) THE REFUSALS ---
  const refusals: Array<[string, string]> = [
    ['refusal_no_edges', 'no_edges'],
    ['refusal_too_many_edges', 'too_many_edges'],
    ['refusal_null_edge', 'invalid_edge'],
    ['refusal_zero_edge', 'invalid_edge'],
    ['refusal_negative_edge', 'invalid_edge'],
    ['refusal_huge_edge', 'invalid_edge'],
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
    });
  }

  check('a NON-POSITIVE cut line is refused, not silently absorbed into band 0', () => {
    // Band 0 already starts at day 0 and already catches a negative age, so a cut line
    // at 0 or below would carve nothing off and publish a band no block can occupy.
    assert.equal(obj(probe, 'refusal_zero_edge').reason, 'invalid_edge');
    assert.equal(obj(probe, 'refusal_negative_edge').reason, 'invalid_edge');
    assert.ok(read(MIGRATION).includes('WHERE e <= 0'), 'the positivity guard is gone from SQL');
  });
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('verify-blocking-age-lens — the Blocking age lens data layer');
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
