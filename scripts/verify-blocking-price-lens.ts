/**
 * verify-blocking-price-lens.ts — the proofs behind the BLOCKING PRICE LENS data layer.
 *
 * Run: npx tsx scripts/verify-blocking-price-lens.ts
 *
 * ============================================================================
 * WHAT THE FEATURE IS, AND WHAT CAN GO WRONG WITH IT
 * ============================================================================
 * Renzo, 2026-09-19: see the Blocking grid "ratio'd in highlights based on price
 * filter" — if market is 40.23 then ₱41 and up is above market. Two SQL functions
 * (migration `20260919025729_blocking_price_lens`): one says what market COSTS right
 * now, four ways; the other CLASSIFIES every occupied block against a market price it
 * is given. Almost nothing here is a new number — "market" already lives in
 * `view_analytics_rcin_monthly.market_avg_price` and a block's ₱/kg already lives in
 * `view_blocking_grid.avg_php_kg` — so the failure modes worth testing are the four
 * this codebase keeps meeting:
 *
 *   REUSE      a basis that "reads the analytics view" but quietly re-derives it, so
 *              the lens and the /analytics matrix drift apart. PROVEN by comparing the
 *              function's output against the view read directly, in the same call.
 *   FOLDS      bands that do not add up to the yard. PROVEN: Σ band block_count +
 *              unpriced = total, the same for kg with gap exactly 0, and both share
 *              families summing to 100.
 *   NULL ≠ 0   an unpriced block (`avg_php_kg` 0 — the L-008 placeholder) painted as
 *              the CHEAPEST band, which is the ₱11.01-vs-₱39.99 `avg_cost` bug in a
 *              new costume. PROVEN: it is in NO band and out of both denominators.
 *   POSTURE    a ₱-bearing function reachable by a role that may not see prices.
 *              PROVEN by ASSUMING THE VICTIM'S ROLE and really calling it (L-043's
 *              lesson), not by reading the grant table.
 *
 * ============================================================================
 * WHY THE NUMBERS COME FROM A PROBE RPC AND NOT FROM DIRECT CALLS
 * ============================================================================
 * Both functions are `authenticated`-only BY DESIGN (`anon` revoked, `service_role`
 * deliberately NOT granted so `verify-worker-view-grants` stays at 4 views / 0
 * findings), and no verify script in this repo holds a user JWT. So the only key this
 * script has cannot call them — which is the point of the grant, and is exactly the
 * situation `scripts/verify-ops-ledger.ts` solved with a SECURITY DEFINER,
 * service_role-only probe. `fn_blocking_price_lens_probe(int)` is that door.
 *
 * THE PROBE ASSERTS NOTHING. It calls the two functions a fixed number of times,
 * reads the same statistics straight from the analytics view and the grid
 * INDEPENDENTLY, and hands everything back — every assertion below is TypeScript a
 * human can read. It is deliberately NOT a whole-database verifier: the 2026-09-14
 * `fn_ops_ledger_verify()` incident (one statement cross-checking every ops-ledger
 * view over all of history) OOM-ed the instance and took the live site down. Both of
 * this probe's populations are bounded BY CONSTRUCTION — one row per occupied block
 * (168 today, 238 slots maximum) and a delivery window clamped to 400 days.
 *
 * MEASURED 2026-09-19 with `set local statement_timeout='5s'` then
 * EXPLAIN (ANALYZE, BUFFERS):
 *   view_blocking_grid alone (balance > 0, 168 rows)          2.85 ms /   451 buffers
 *   fn_blocking_price_lens(…)   before the CTE hints         85.4 ms / 1,939 buffers
 *                               after  (grid scanned once)   13.5 ms /   454-scan
 *   fn_blocking_market_bases(30) before                     330.7 ms / 1,291 buffers
 *                                after (view read once)     105.9 ms /   176-scan
 *   trailing_days at its 400-day CEILING, alone              21.9 ms /    97 buffers
 * The ceiling below is a SHAPE alarm, not a latency SLO — see PROBE_MS_BUDGET.
 *
 * ============================================================================
 * ₱ IN THIS SCRIPT'S OUTPUT
 * ============================================================================
 * The four market prices ARE the numbers under test, so they print. Nothing else
 * priced does: band bounds print as whole-peso OFFSETS from R (`[R-1, R)`), and
 * everything else printed is a count, a weight or a percentage.
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

const MIGRATION = 'supabase/migrations/20260919025729_blocking_price_lens.sql';
/**
 * 2026-09-21 — A TYPED PRICE IS THE LINE ITSELF. `fn_blocking_price_lens` gained an
 * optional `p_rounded_up_php`, which is a SIGNATURE change, so it was DROP + CREATEd and
 * its grants + COMMENT re-applied in this second file. The original migration above is
 * untouched and its assertions still read it, so a regression there still fails here.
 */
const OVERRIDE_MIGRATION =
  'supabase/migrations/20260921034512_blend_block_facts_and_price_lens_rounded_up.sql';
const ACTIONS = 'app/(app)/inventory/blocking/actions.ts';
const TYPES = 'app/(app)/inventory/blocking/types.ts';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

/**
 * A SHAPE alarm, not a performance SLO — the distinction is the whole reason it is
 * this loose. What it must catch is one call walking a whole-history population; what
 * it must NOT fire on is instance load, and the wall-clock here is round-trip
 * dominated (verify-ops-ledger records a probe costing 280 ms server-side reading
 * 4,671 ms from a laptop). The probe makes 8 lens calls plus a bases call, so ~1 s of
 * server work is the honest expectation and 15 s is ~15x that.
 */
const PROBE_MS_BUDGET = 15_000;

// ---------------------------------------------------------------------------
// 1. STATIC — the migration's posture and the ACTIONS' gate ordering
// ---------------------------------------------------------------------------
function staticChecks(): void {
  console.log('\nstatic (migration + server actions, no network) -----------------');

  const sql = read(MIGRATION);

  check('both public functions are STABLE, SECURITY INVOKER and pin search_path', () => {
    // Each function's header block must carry all three. Counted rather than
    // pattern-matched per function so a fourth function cannot slip in unposture'd.
    assert.equal((sql.match(/\nSTABLE\n/g) ?? []).length, 3, 'expected 3 STABLE functions');
    assert.equal((sql.match(/\nSECURITY INVOKER\n/g) ?? []).length, 2, 'expected 2 SECURITY INVOKER');
    assert.equal((sql.match(/\nSECURITY DEFINER\n/g) ?? []).length, 1, 'expected 1 SECURITY DEFINER (the probe)');
    assert.equal((sql.match(/\nSET search_path = public\n/g) ?? []).length, 3, 'search_path not pinned on all 3');
  });

  check('grants: authenticated only on both; anon + PUBLIC revoked; no service_role', () => {
    for (const sig of ['fn_blocking_market_bases(int)', 'fn_blocking_price_lens(numeric, int[])']) {
      assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC;`), `${sig}: PUBLIC not revoked`);
      assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon;`), `${sig}: anon not revoked`);
      assert.ok(sql.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO authenticated;`), `${sig}: authenticated missing`);
    }
    // service_role appears in this file for the PROBE and nowhere else.
    const svc = sql.match(/TO service_role/g) ?? [];
    assert.equal(svc.length, 1, 'service_role is granted somewhere other than the probe');
    assert.ok(
      sql.includes('GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) TO service_role;'),
      'the probe is not the thing service_role was granted',
    );
  });

  check('the probe is service_role-only — authenticated and anon are BOTH revoked', () => {
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      assert.ok(
        sql.includes(`REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens_probe(int) FROM ${role};`),
        `probe: ${role} not revoked`,
      );
    }
  });

  check('both public functions carry a COMMENT naming the ₱ sensitivity', () => {
    for (const sig of ['fn_blocking_market_bases(int)', 'fn_blocking_price_lens(numeric, int[])']) {
      const at = sql.indexOf(`COMMENT ON FUNCTION public.${sig} IS`);
      assert.ok(at > 0, `${sig}: no COMMENT`);
      const body = sql.slice(at, at + 3000);
      assert.ok(/canViewPrices/.test(body), `${sig}: the COMMENT does not name the price gate`);
    }
  });

  check('the hot CTEs are MATERIALIZED (the 85ms -> 13ms / 330ms -> 106ms fix)', () => {
    // `blk` is read by four downstream CTEs and `months` by three. Without the hint
    // the planner re-executes the whole view subtree per reference, and the
    // measurements in this file's header are what that cost.
    for (const cte of ['months AS MATERIALIZED', 'trail_window AS MATERIALIZED', 'blk AS MATERIALIZED', 'classified AS MATERIALIZED', 'bands AS MATERIALIZED']) {
      assert.ok(sql.includes(cte), `${cte} lost its MATERIALIZED hint`);
    }
  });

  const actions = read(ACTIONS);

  check('ALL FOUR ₱ actions call canViewPrices() BEFORE they create a Supabase client', () => {
    // THE central rule of this feature. Band membership alone pins a block's ₱/kg to
    // within a peso, so there is no price-free half of the payload to null out after
    // the fact — the gate has to be a refusal that never reaches the database. This
    // asserts the ORDER inside each action body, not merely that both appear.
    //
    // The two 2026-09-22 CONTEXT actions join the list for the same reason, and the reason
    // is written down rather than assumed: a nulled `fetchBlockingSupplierMarket` would
    // leave a per-supplier kilogram series with its share and count, which
    // `view_digest_rcin_supplier_daily` and `fn_blocking_supplier_lens` ALREADY publish to
    // every role — so a third half-blank copy buys a denied reader nothing and costs the
    // payload a second meaning. They follow the price lens, not the supplier lens.
    for (const fn of [
      'fetchBlockingMarketBases',
      'fetchBlockingPriceLens',
      'fetchBlockingMarketContext',
      'fetchBlockingSupplierMarket',
    ]) {
      const start = actions.indexOf(`export async function ${fn}(`);
      assert.ok(start > 0, `${fn} not found`);
      // The body ends at the next top-level `export async function`, or EOF.
      const nextExport = actions.indexOf('\nexport async function ', start + 1);
      const body = actions.slice(start, nextExport === -1 ? undefined : nextExport);

      const gateAt = body.indexOf('canViewPricesGate()');
      const clientAt = body.indexOf('createClient()');
      const rpcAt = body.indexOf('.rpc(');

      assert.ok(gateAt > 0, `${fn} does not call the canonical canViewPricesGate()`);
      assert.ok(clientAt > 0, `${fn} never creates a client`);
      assert.ok(gateAt < clientAt, `${fn} creates a Supabase client BEFORE the price gate`);
      assert.ok(gateAt < rpcAt, `${fn} calls the RPC BEFORE the price gate`);
      assert.ok(
        /prices_hidden/.test(body.slice(gateAt, clientAt)),
        `${fn} does not RETURN a prices_hidden refusal between the gate and the client`,
      );
    }
  });

  /** Comment lines stripped, so a rule quoted in prose cannot pass for a rule in code. */
  const actionsCode = actions
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  check('the refusal is a typed `prices_hidden`, never a nulled payload', () => {
    // A "lens with every band nulled" would still publish block_count per band, which
    // IS the yard's price distribution. So the shape must be a refusal.
    assert.equal(
      (actionsCode.match(/reason: 'prices_hidden'/g) ?? []).length,
      4,
      'expected exactly four prices_hidden refusals in CODE (one per ₱ action: the two lens ' +
        'actions plus fetchBlockingMarketContext / fetchBlockingSupplierMarket, 2026-09-22)',
    );
  });

  check('NULL is never coerced to 0 on a price or an open band bound', () => {
    assert.ok(
      actions.includes('marketPhpKg: lensNumOrNull(r.market_php_kg)'),
      'marketPhpKg is not NULL-preserving — a ?? 0 here would invent a ₱0 market',
    );
    for (const f of ['lowerPhp: lensNumOrNull(b.lower_php)', 'upperPhp: lensNumOrNull(b.upper_php)']) {
      assert.ok(actions.includes(f), `${f} missing — a 0 bound would be read as a real ₱0 edge`);
    }
    for (const f of ['kgSharePct: lensNumOrNull', 'blockSharePct: lensNumOrNull']) {
      assert.ok(actions.includes(f), `${f} missing — 0% and "nothing priced" are different answers`);
    }
  });

  check('the action does NO arithmetic (CLAUDE.md: never aggregate in TypeScript)', () => {
    const start = actions.indexOf('// ─── Price lens — DATA LAYER');
    assert.ok(start > 0, 'the price-lens block is not in actions.ts');
    const block = actions
      .slice(start)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n');
    assert.ok(!/\.reduce\(/.test(block), 'a reduce() means a total moved out of SQL');
    // The one loop is the block_loc -> band RE-KEY, which adds nothing up.
    assert.ok(!/\+=/.test(block), 'a += means a sum moved out of SQL');
  });

  const types = read(TYPES);

  check('the edge cap and the trailing-day bounds are ONE definition, shared with SQL', () => {
    assert.ok(types.includes('BLOCKING_PRICE_LENS_MAX_EDGES = 6'), 'edge cap constant moved');
    assert.ok(types.includes('BLOCKING_TRAILING_DAYS_MIN = 1'), 'trailing min moved');
    assert.ok(types.includes('BLOCKING_TRAILING_DAYS_MAX = 400'), 'trailing max moved');
    // and SQL agrees
    assert.ok(sql.includes('cardinality(v_offsets) > 6'), 'the SQL edge cap is not 6');
    assert.ok(sql.includes('least(greatest(COALESCE(p_trailing_days, 30), 1), 400)'), 'the SQL clamp moved');
    assert.ok(
      actions.includes('BLOCKING_PRICE_LENS_MAX_EDGES'),
      'the action re-types the cap instead of importing it',
    );
  });

  check('the R rule is written down exactly once, in SQL', () => {
    // NOTE the MEASURED rule now lives in the 2026-09-21 migration, because the signature
    // change forced a DROP + CREATE. The original file's copy is the one that was
    // replaced, so BOTH are checked: the old one so a revert is visible, the new one
    // because it is what runs.
    assert.ok(sql.includes('v_r := floor(p_market_php_kg) + 1;'), 'the R expression moved or changed');
    assert.ok(
      read(OVERRIDE_MIGRATION).includes('v_r := floor(p_market_php_kg) + 1;'),
      'the live function no longer computes the measured R',
    );
    // No TypeScript copy of it — a second copy is a second definition, and this is
    // checked against COMMENT-STRIPPED source so quoting the rule in a doc comment
    // (which `fetchBlockingPriceLens` deliberately does) is not mistaken for one.
    assert.ok(!/floor\s*\(/i.test(actionsCode), 'R is re-derived in TypeScript');
    assert.ok(!/Math\.floor|Math\.ceil|Math\.round/.test(actionsCode), 'R is re-derived in TypeScript');
  });

  // ─── THE TYPED CUT LINE (p_rounded_up_php, 2026-09-21) ─────────────────────
  //
  // `R = floor(market) + 1` is right for a MEASURED market and WRONG for a typed one: the
  // operator who types ₱41 means ₱41 and up is above market, and got a lens cut at 42.
  // The parameter that fixes it is a SIGNATURE change, so the checks below are about the
  // two things a signature change silently breaks — the GRANTS and the COMMENT that
  // `DROP FUNCTION` throws away — plus the compatibility claim itself.

  const ovr = read(OVERRIDE_MIGRATION);

  check('the override migration DROPs and re-CREATEs, in ONE file, with no overload left', () => {
    assert.ok(
      ovr.includes('DROP FUNCTION IF EXISTS public.fn_blocking_price_lens(numeric, int[]);'),
      'the old signature is not dropped — an OVERLOAD would be a second home for the band logic',
    );
    assert.ok(
      ovr.includes('CREATE FUNCTION public.fn_blocking_price_lens('),
      'the new signature is not created (a CREATE OR REPLACE cannot change an argument list)',
    );
    assert.ok(ovr.includes('p_rounded_up_php int   DEFAULT NULL'), 'the new parameter is not optional');
    // The DROP and the CREATE are in that order in the same file, so no window exists in
    // which the function is missing after the migration.
    assert.ok(
      ovr.indexOf('DROP FUNCTION IF EXISTS public.fn_blocking_price_lens') <
        ovr.indexOf('CREATE FUNCTION public.fn_blocking_price_lens('),
      'the CREATE is before the DROP',
    );
  });

  check('the GRANTS and the COMMENT a DROP discards are re-applied in the same file', () => {
    const sig = 'fn_blocking_price_lens(numeric, int[], int)';
    assert.ok(ovr.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC;`), 'PUBLIC not re-revoked');
    assert.ok(ovr.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon;`), 'anon not re-revoked');
    assert.ok(ovr.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO authenticated;`), 'authenticated not re-granted');
    assert.ok(ovr.includes(`COMMENT ON FUNCTION public.${sig} IS`), 'the COMMENT was not re-applied');
    // ...and still nothing gives it to service_role.
    assert.ok(
      !/GRANT[^;]*fn_blocking_price_lens\(numeric, int\[\], int\)[^;]*service_role/.test(ovr),
      'the lens was granted to service_role',
    );
    // The COMMENT must still name the price gate AND now the typed-price rule.
    const at = ovr.indexOf(`COMMENT ON FUNCTION public.${sig} IS`);
    const body = ovr.slice(at, at + 4000);
    assert.ok(/canViewPrices/.test(body), 'the COMMENT no longer names the price gate');
    assert.ok(/ceil\(typed price\)/.test(body), 'the COMMENT does not state the UI rule for the manual basis');
  });

  check('the probe moved WITH the signature — it names the function by argument types', () => {
    // `has_function_privilege(role, 'public.fn_blocking_price_lens(numeric, int[])', ...)`
    // RESOLVES the signature, so leaving the probe behind would have made every probe
    // call fail outright. This is why the probe is in the same migration.
    assert.ok(
      ovr.includes("'public.fn_blocking_price_lens(numeric, int[], int)', 'EXECUTE'"),
      'the probe still asks about the OLD signature',
    );
    assert.ok(ovr.includes('lens_overload_count'), 'the probe does not count the overloads');
  });

  check('SQL refuses a non-positive typed cut line, and NULL is NOT a refusal', () => {
    assert.ok(
      ovr.includes('IF p_rounded_up_php IS NOT NULL AND p_rounded_up_php < 1 THEN'),
      'the typed-cut-line guard moved — note it must test IS NOT NULL first, since NULL means "no override"',
    );
    assert.ok(ovr.includes("'reason', 'invalid_rounded_up'"), 'the invalid_rounded_up refusal is gone');
    assert.ok(ovr.includes('IF p_rounded_up_php IS NOT NULL THEN'), 'the override no longer sets R');
  });

  check('the override is enforced in the ACTION too, where integrality is decidable', () => {
    // `p_rounded_up_php` is declared `int`, so Postgres has already rounded 40.5 to 41 by
    // the time the body runs — exactly the asymmetry `p_edge_offsets` already records.
    const start = actions.indexOf('export async function fetchBlockingPriceLens(');
    const nextExport = actions.indexOf('\nexport async function ', start + 1);
    const body = actions.slice(start, nextExport === -1 ? undefined : nextExport);
    assert.ok(/roundedUpPhp\?: number \| null/.test(body), 'the action does not accept the optional override');
    assert.ok(/invalid_rounded_up/.test(body), 'the action does not reuse the SQL invalid_rounded_up reason');
    assert.ok(/Number\.isInteger\(r\)/.test(body), 'the action does not check integrality');
    assert.ok(/p_rounded_up_php: overrideR/.test(body), 'the override is not passed to the RPC');
    // The ceil() the manual basis needs is the UI's job, NOT the action's — the action
    // must stay free of arithmetic (and `actionsCode` above already forbids Math.ceil).
    assert.ok(
      types.includes('BLOCKING_ROUNDED_UP_MIN_PHP = 1'),
      'the minimum is not one shared definition',
    );
    assert.ok(
      /Math\.ceil\(typedPrice\)/.test(types),
      'the types do not state the UI rule (pass ceil(typed price) for the manual basis)',
    );
    assert.ok(
      types.includes("| 'invalid_rounded_up'"),
      'the refusal union does not carry invalid_rounded_up',
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

/**
 * A tolerance for the JSON/JavaScript-double boundary, NOT for the arithmetic.
 *
 * SQL computes every one of these in exact `numeric` and the probe's own `lab_check` reports
 * the SQL-side gaps as literal zeros. Re-summing the same numbers here in doubles leaves a
 * residue, so this is the only honest comparison a TypeScript re-computation can make — and
 * no exactness claim in this file is sourced from JavaScript.
 */
const near = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-12);

/** Bands print as OFFSETS from R so no ₱ but the market price itself is shown. */
function bandLabel(band: Json, r: number): string {
  const lo = band.lower_php === null ? null : Number(band.lower_php) - r;
  const hi = band.upper_php === null ? null : Number(band.upper_php) - r;
  const f = (d: number) => (d === 0 ? 'R' : d > 0 ? `R+${d}` : `R${d}`);
  return `[${lo === null ? '-inf' : f(lo)}, ${hi === null ? '+inf' : f(hi)})`;
}

async function liveChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });

  console.log('\nlive posture (a REAL call as each victim role) -------------------');

  // L-043's lesson: prove a permission by ASSUMING THE VICTIM'S ROLE, never by
  // reading the grant table. `anon` must be refused both functions outright.
  for (const fn of ['fn_blocking_market_bases', 'fn_blocking_price_lens'] as const) {
    const res = await anon.rpc(fn, fn === 'fn_blocking_market_bases' ? { p_trailing_days: 30 } : { p_market_php_kg: 40 });
    check(`anon CANNOT execute ${fn} (a real call, not a grant lookup)`, () => {
      assert.ok(res.error, `anon executed ${fn} — the REVOKE is gone`);
    });
  }

  // service_role must ALSO be refused: the sync worker calls neither, and a grant
  // here would show up in verify-worker-view-grants' dependency closure.
  for (const fn of ['fn_blocking_market_bases', 'fn_blocking_price_lens'] as const) {
    const res = await svc.rpc(fn, fn === 'fn_blocking_market_bases' ? { p_trailing_days: 30 } : { p_market_php_kg: 40 });
    check(`service_role CANNOT execute ${fn} (no worker reads it)`, () => {
      assert.ok(res.error, `service_role executed ${fn} — an unintended grant appeared`);
    });
  }

  const anonProbe = await anon.rpc('fn_blocking_price_lens_probe', { p_trailing_days: 30 });
  check('anon CANNOT execute the verify probe either', () => {
    assert.ok(anonProbe.error, 'anon reached the probe — it bypasses both grants');
  });

  // --- the probe itself ---
  const t0 = Date.now();
  const probeRes = await svc.rpc('fn_blocking_price_lens_probe', { p_trailing_days: 30 });
  const ms = Date.now() - t0;
  assert.ok(!probeRes.error, `fn_blocking_price_lens_probe failed: ${probeRes.error?.message}`);
  const probe = probeRes.data as unknown as Json;
  assert.ok(probe && typeof probe === 'object', 'the probe returned nothing — an empty probe is a FAILURE, not a pass');

  console.log(`\nlive (probe: ${ms} ms wall clock) --------------------------------`);

  check(`the probe stays under the ${PROBE_MS_BUDGET} ms SHAPE budget`, () => {
    assert.ok(ms < PROBE_MS_BUDGET, `probe took ${ms} ms — check it has not grown a whole-history population`);
  });

  // --- (a) POSTURE, from the catalog, as a second witness to the real calls above ---
  const posture = obj(probe, 'posture');
  check('catalog posture: authenticated yes, anon no, service_role no, on both functions', () => {
    assert.equal(posture.bases_authenticated, true);
    assert.equal(posture.bases_anon, false);
    assert.equal(posture.bases_service_role, false);
    assert.equal(posture.lens_authenticated, true);
    assert.equal(posture.lens_anon, false);
    assert.equal(posture.lens_service_role, false);
  });
  check('catalog posture: the probe is service_role-only', () => {
    assert.equal(posture.probe_service_role, true);
    assert.equal(posture.probe_authenticated, false);
    assert.equal(posture.probe_anon, false);
  });
  check('catalog posture: 2 SECURITY INVOKER, 3 STABLE, 3 search_path-pinned, 2 commented', () => {
    assert.equal(n(posture, 'invoker_count'), 2);
    assert.equal(n(posture, 'stable_count'), 3);
    assert.equal(n(posture, 'search_path_pinned'), 3);
    assert.equal(n(posture, 'commented_count'), 2);
  });
  check('catalog posture: EXACTLY ONE fn_blocking_price_lens exists — no overload', () => {
    // The 2026-09-21 signature change was a DROP + CREATE precisely so the band logic
    // keeps one home. Two functions of this name would be two places for "above market"
    // to mean something.
    assert.equal(n(posture, 'lens_overload_count'), 1);
  });

  // --- (b) THE FOUR BASES, and the REUSE proof ---
  const bases = arr(probe, 'bases');
  const byKey = new Map<string, Json>(bases.map((b) => [String(b.basis_key), b]));

  check('FIVE bases, exactly — `this_quarter` joined them 2026-09-22', () => {
    assert.deepEqual([...byKey.keys()].sort(), [
      'last_3_months',
      'last_month',
      'this_month',
      'this_quarter',
      'trailing_days',
    ]);
  });

  const thisMonth = byKey.get('this_month')!;
  const lastMonth = byKey.get('last_month')!;
  const last3 = byKey.get('last_3_months')!;
  const thisQuarter = byKey.get('this_quarter')!;
  const trailing = byKey.get('trailing_days')!;

  const rcinThis = obj(probe, 'rcin_this_month');
  const rcinLast = obj(probe, 'rcin_last_month');
  const rcin3 = obj(probe, 'rcin_last_3');

  console.log('\n  market bases (the ONE ₱ family this script prints) ------------');
  for (const b of [thisMonth, lastMonth, last3, thisQuarter, trailing]) {
    const price = b.market_php_kg === null ? '     (none)' : Number(b.market_php_kg).toFixed(4).padStart(11);
    console.log(
      `    ${String(b.basis_key).padEnd(14)}${price}  ` +
        `${Number(b.priced_kg).toLocaleString('en-US').padStart(12)} kg  ` +
        `${String(b.delivery_count).padStart(4)} dlv  ${b.from_date} -> ${b.to_date}`,
    );
  }

  check('this_month EQUALS view_analytics_rcin_monthly.market_avg_price exactly', () => {
    // THE reuse proof. If this ever fails, someone re-derived "market" instead of
    // SELECTing the statistic that already has a home — the thing the whole
    // analytics-Phase-1 comment exists to prevent.
    assert.equal(thisMonth.market_php_kg, rcinThis.php_kg, 'this_month price drifted from the analytics view');
    assert.equal(Number(thisMonth.priced_kg), Number(rcinThis.priced_kg), 'this_month priced_kg drifted');
    assert.equal(Number(thisMonth.delivery_count), Number(rcinThis.delivery_count), 'this_month count drifted');
  });

  check('last_month EQUALS view_analytics_rcin_monthly.market_avg_price exactly', () => {
    assert.equal(lastMonth.market_php_kg, rcinLast.php_kg, 'last_month price drifted from the analytics view');
    assert.equal(Number(lastMonth.priced_kg), Number(rcinLast.priced_kg), 'last_month priced_kg drifted');
    assert.equal(Number(lastMonth.delivery_count), Number(rcinLast.delivery_count), 'last_month count drifted');
  });

  check('last_3_months is SUM(money) / SUM(priced kg), never the mean of three averages', () => {
    assert.equal(last3.market_php_kg, rcin3.php_kg, 'last_3_months price is not the money-weighted figure');
    assert.equal(Number(last3.priced_kg), Number(rcin3.priced_kg), 'last_3_months priced_kg drifted');
    assert.equal(Number(last3.delivery_count), Number(rcin3.delivery_count), 'last_3_months count drifted');

    // and it is genuinely NOT the naive mean (a guard against the two coinciding)
    const naive = (Number(thisMonth.market_php_kg) + Number(lastMonth.market_php_kg)) / 2;
    assert.ok(
      Math.abs(Number(last3.market_php_kg) - naive) > 1e-9,
      'the 3-month figure happens to equal a naive mean — re-check the expression',
    );
  });

  check('the window ANCHORS are right: months are whole, trailing is N days ending today', () => {
    const today = String(probe.manila_today);
    assert.equal(thisMonth.from_date, String(probe.this_month), 'this_month does not start on the 1st');
    assert.equal(lastMonth.from_date, String(probe.last_month), 'last_month does not start on the 1st');
    assert.equal(trailing.to_date, today, 'trailing_days does not end on the Manila calendar date');
    const from = new Date(`${trailing.from_date}T00:00:00Z`).getTime();
    const to = new Date(`${today}T00:00:00Z`).getTime();
    const days = Math.round((to - from) / 86_400_000) + 1;
    assert.equal(days, n(probe, 'trailing_days'), `trailing window spans ${days} days, not the requested N`);
    // last_3_months starts two months before this month and ends with it.
    assert.equal(last3.to_date, thisMonth.to_date, 'last_3_months does not end with the current month');
  });

  check('a basis price is NULL or a positive number — never 0', () => {
    for (const b of bases) {
      if (b.market_php_kg === null) continue;
      assert.ok(Number(b.market_php_kg) > 0, `${b.basis_key} published a non-positive market price`);
    }
  });

  // --- (b2) `this_quarter` — the 2026-09-22 basis. Its REUSE proof against the analytics
  // view lives in `marketContextChecks` below, which is the probe that reads the view; what
  // is checked HERE is everything decidable from the basis row itself.
  check('this_quarter spans the CURRENT calendar quarter, bounds included', () => {
    // Derived from the probe's own Manila `this_month` rather than taken from the payload —
    // otherwise the function would be checking itself.
    const m0 = new Date(`${String(probe.this_month)}T00:00:00Z`);
    const q0 = new Date(Date.UTC(m0.getUTCFullYear(), Math.floor(m0.getUTCMonth() / 3) * 3, 1))
      .toISOString()
      .slice(0, 10);
    assert.equal(thisQuarter.from_date, q0, 'this_quarter does not start on the quarter boundary');
    // `to_date` is the QUARTER's own last day, so it is in the FUTURE for an unfinished
    // quarter — exactly as `this_month`'s already is mid-month. Asserted, not tolerated.
    const from = new Date(`${q0}T00:00:00Z`);
    const expectedTo = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 3, 0))
      .toISOString()
      .slice(0, 10);
    assert.equal(thisQuarter.to_date, expectedTo, 'this_quarter does not end on the quarter\'s last day');
    // The quarter must start in January / April / July / October.
    assert.ok([0, 3, 6, 9].includes(from.getUTCMonth()), 'this_quarter does not start a calendar quarter');
    // ...and it must CONTAIN the current month.
    assert.ok(String(probe.this_month) >= q0, 'the current month is before the quarter start');
  });

  check('this_quarter is a SUFFIX of last_3_months — never wider, and NOT a second definition', () => {
    // The whole reason it needs no extra read: the quarter to date is month 1, 2 or 3 of the
    // quarter, so it always spans at most the three months last_3_months already holds.
    assert.ok(
      Number(thisQuarter.priced_kg) <= Number(last3.priced_kg) + 1e-9,
      'this_quarter covers MORE priced kilos than last_3_months — it is reading a wider window',
    );
    assert.ok(
      String(thisQuarter.from_date) >= String(last3.from_date),
      'this_quarter starts before last_3_months',
    );
    // NOTE their `to_date`s legitimately DIFFER: last_3_months ends on the current MONTH's
    // last day, this_quarter on the QUARTER's. They coincide only in a quarter's third month.
    // In the THIRD month of a quarter the two are identical, which is correct and is the
    // reason this is an inequality rather than an equality either way. Print which it is, so
    // a reader of the log is never surprised by two rows agreeing.
    const same = String(thisQuarter.market_php_kg) === String(last3.market_php_kg);
    console.log(
      `    this_quarter ${same ? '==' : '!='} last_3_months today ` +
        `(${same ? 'the quarter to date IS the last 3 months this month' : 'they diverge'})`,
    );
  });

  // --- (c) THE R RULE ---
  const rOf = (key: string): number => n(obj(probe, key), 'rounded_up_php');
  check('R = floor(market) + 1 — 40.23 -> 41', () => assert.equal(rOf('r_40_23'), 41));
  check('R on an EXACTLY whole market price — 40.00 -> 41, so ₱40 stays "at market"', () =>
    assert.equal(rOf('r_40_00'), 41));
  check('R = floor(market) + 1 — 39.8568 -> 40', () => assert.equal(rOf('r_39_8568'), 40));

  // --- (d) THE LENS ON THE LIVE BASIS ---
  const lens = obj(probe, 'lens_live');
  const grid = obj(probe, 'grid');
  check('the live lens returned ok:true', () => assert.equal(lens.ok, true));

  const lensR = n(lens, 'rounded_up_php');
  const lensBands = arr(lens, 'bands');
  const lensBlocks = arr(lens, 'blocks');
  const lensTotal = obj(lens, 'total');
  const lensUnpriced = obj(lens, 'unpriced');

  check('the live lens was built on the this_month basis, and R follows from it', () => {
    assert.equal(lens.market_php_kg, thisMonth.market_php_kg, 'the lens used a different market price');
    assert.equal(lensR, Math.floor(Number(thisMonth.market_php_kg)) + 1, 'R does not follow from the market price');
  });

  check('the DEFAULT edge list [-1, 0] gives exactly THREE bands', () => {
    assert.deepEqual(lens.edge_offsets, [-1, 0], 'the default offsets are not [-1, 0]');
    assert.equal(lensBands.length, 3, `expected 3 bands, got ${lensBands.length}`);
  });

  check('the FIRST band is open below and the LAST is open above; the rest are closed', () => {
    assert.equal(lensBands[0].lower_php, null, 'band 0 is not open below');
    assert.equal(lensBands[lensBands.length - 1].upper_php, null, 'the last band is not open above');
    for (let i = 1; i < lensBands.length; i += 1) {
      assert.ok(lensBands[i].lower_php !== null, `band ${i} has no lower bound`);
    }
    for (let i = 0; i < lensBands.length - 1; i += 1) {
      assert.ok(lensBands[i].upper_php !== null, `band ${i} has no upper bound`);
      // contiguous: each band's upper IS the next band's lower, so no price can fall
      // between two bands and no price can be in two.
      assert.equal(
        Number(lensBands[i].upper_php),
        Number(lensBands[i + 1].lower_php),
        `bands ${i} and ${i + 1} are not contiguous`,
      );
    }
  });

  check('the bands are the edges: band i\'s lower bound is R + edge_offsets[i-1]', () => {
    const offsets = (lens.edge_offsets as number[]).map(Number);
    for (let i = 1; i < lensBands.length; i += 1) {
      assert.equal(Number(lensBands[i].lower_php), lensR + offsets[i - 1], `band ${i} lower bound is off the edge`);
    }
    // "at market" contains the market price itself, which is the whole reason R rounds
    // up on a whole number.
    const atMarket = lensBands[lensBands.length - 2];
    const price = Number(lens.market_php_kg);
    assert.ok(
      price >= Number(atMarket.lower_php) && price < Number(atMarket.upper_php),
      'the market price does not fall inside the "at market" band',
    );
  });

  console.log('\n  the lens, on this_month (bounds shown as offsets from R) ------');
  console.log(`    R = ${lensR}   (market ${Number(lens.market_php_kg).toFixed(4)})`);
  for (const b of lensBands) {
    console.log(
      `    band ${b.index}  ${bandLabel(b, lensR).padEnd(16)}` +
        `${String(b.block_count).padStart(4)} blocks  ` +
        `${Number(b.kg).toLocaleString('en-US').padStart(12)} kg  ` +
        `${Number(b.kg_share_pct).toFixed(4).padStart(9)}% kg  ` +
        `${Number(b.block_share_pct).toFixed(4).padStart(9)}% blocks`,
    );
  }
  console.log(
    `    unpriced  ${String(n(lensUnpriced, 'block_count')).padStart(4)} blocks  ` +
      `${Number(lensUnpriced.kg).toLocaleString('en-US').padStart(12)} kg   (in NO band)`,
  );
  console.log(
    `    TOTAL     ${String(n(lensTotal, 'block_count')).padStart(4)} blocks  ` +
      `${Number(lensTotal.kg).toLocaleString('en-US').padStart(12)} kg`,
  );

  // --- (e) THE FOLDS ---
  const sumBandBlocks = lensBands.reduce((s, b) => s + Number(b.block_count), 0);
  const sumBandKg = lensBands.reduce((s, b) => s + Number(b.kg), 0);

  check('Σ band block_count + unpriced = total block_count', () => {
    assert.equal(
      sumBandBlocks + n(lensUnpriced, 'block_count'),
      n(lensTotal, 'block_count'),
      'blocks went missing between the bands and the total',
    );
  });

  check('Σ band kg + unpriced kg = total kg, gap exactly 0', () => {
    const gap = sumBandKg + Number(lensUnpriced.kg) - Number(lensTotal.kg);
    assert.equal(gap, 0, `kg gap is ${gap}, not 0`);
  });

  check('the banded population IS the grid\'s priced positive-balance blocks', () => {
    // Computed in the probe straight off view_blocking_grid, independently of the
    // lens, so this is an agreement rather than a tautology.
    assert.equal(sumBandBlocks, n(grid, 'priced_block_count'), 'band block count != the grid\'s priced blocks');
    assert.equal(sumBandKg - Number(grid.priced_kg), 0, 'band kg total != Σ balance over the grid\'s priced blocks');
    assert.equal(n(lensTotal, 'block_count'), n(grid, 'block_count'), 'lens total != the grid\'s occupied blocks');
    assert.equal(Number(lensTotal.kg) - Number(grid.kg), 0, 'lens total kg != Σ balance over the grid');
  });

  check('an UNPRICED block is in NO band and out of both denominators (NULL is never ₱0)', () => {
    assert.equal(
      n(lensUnpriced, 'block_count'),
      n(grid, 'unpriced_block_count'),
      'the lens and the grid disagree about how many blocks have no price',
    );
    assert.equal(Number(lensUnpriced.kg) - Number(grid.unpriced_kg), 0, 'unpriced kg disagrees with the grid');
    // `blocks[]` is the band membership list, so an unpriced block must be absent.
    assert.equal(
      lensBlocks.length,
      n(grid, 'priced_block_count'),
      'the per-block band list does not cover exactly the priced blocks',
    );
    // ...and the two together account for everything, which is what makes "absent"
    // mean "unpriced" rather than "lost".
    assert.equal(lensBlocks.length + n(lensUnpriced, 'block_count'), n(lensTotal, 'block_count'));
  });

  check('every listed block names a band that exists', () => {
    const valid = new Set(lensBands.map((b) => Number(b.index)));
    for (const b of lensBlocks) {
      assert.ok(typeof b.block_loc === 'string' && b.block_loc.length > 0, 'a band entry has no block_loc');
      assert.ok(valid.has(Number(b.band_index)), `block ${b.block_loc} is in band ${b.band_index}, which does not exist`);
    }
    const locs = new Set(lensBlocks.map((b) => String(b.block_loc)));
    assert.equal(locs.size, lensBlocks.length, 'a block_loc appears twice — the grid key is not unique');
  });

  // --- (f) THE SHARES ---
  check('Σ kg_share_pct = 100 (±1e-9) and Σ block_share_pct = 100 (±1e-9)', () => {
    const kgShare = lensBands.reduce((s, b) => s + Number(b.kg_share_pct), 0);
    const blockShare = lensBands.reduce((s, b) => s + Number(b.block_share_pct), 0);
    assert.ok(Math.abs(kgShare - 100) < 1e-9, `kg shares sum to ${kgShare}`);
    assert.ok(Math.abs(blockShare - 100) < 1e-9, `block shares sum to ${blockShare}`);
  });

  check('each band\'s shares are that band\'s own numbers over the PRICED population', () => {
    for (const b of lensBands) {
      const expectKg = (Number(b.kg) * 100) / Number(grid.priced_kg);
      const expectBlocks = (Number(b.block_count) * 100) / n(grid, 'priced_block_count');
      assert.ok(Math.abs(Number(b.kg_share_pct) - expectKg) < 1e-9, `band ${b.index} kg share is not kg / priced kg`);
      assert.ok(
        Math.abs(Number(b.block_share_pct) - expectBlocks) < 1e-9,
        `band ${b.index} block share is not blocks / priced blocks`,
      );
    }
  });

  // --- (g) MORE EDGES ---
  const wide = obj(probe, 'lens_wide');
  check('extra edges [-10, -1, 0, 5] give FIVE bands, still folding to the same yard', () => {
    assert.equal(wide.ok, true);
    assert.deepEqual(wide.edge_offsets, [-10, -1, 0, 5]);
    const wb = arr(wide, 'bands');
    assert.equal(wb.length, 5, `expected 5 bands, got ${wb.length}`);
    // the yard does not change because the legend did
    assert.equal(
      wb.reduce((s, b) => s + Number(b.block_count), 0) + n(obj(wide, 'unpriced'), 'block_count'),
      n(obj(wide, 'total'), 'block_count'),
      'the wider lens lost blocks',
    );
    assert.equal(
      wb.reduce((s, b) => s + Number(b.kg), 0) + Number(obj(wide, 'unpriced').kg) - Number(obj(wide, 'total').kg),
      0,
      'the wider lens lost kilograms',
    );
    const share = wb.reduce((s, b) => s + Number(b.kg_share_pct), 0);
    assert.ok(Math.abs(share - 100) < 1e-9, `wide kg shares sum to ${share}`);
    // and the yard total is identical to the default lens's
    assert.equal(Number(obj(wide, 'total').kg), Number(lensTotal.kg), 'the two lenses describe different yards');
  });

  console.log(
    `    wider lens: ${arr(wide, 'bands').map((b) => `${bandLabel(b, n(wide, 'rounded_up_php'))}=${b.block_count}`).join('  ')}`,
  );

  // --- (h) THE REFUSALS ---
  const refusals: Array<[string, string]> = [
    ['refusal_null_price', 'no_market_price'],
    ['refusal_zero_price', 'invalid_market_price'],
    ['refusal_nan_price', 'invalid_market_price'],
    ['refusal_too_many_edges', 'too_many_edges'],
    ['refusal_null_edge', 'invalid_edge'],
    ['refusal_no_edges', 'no_edges'],
  ];
  for (const [key, reason] of refusals) {
    check(`refusal: ${key} -> ok:false, reason '${reason}', with a human message`, () => {
      const r = obj(probe, key);
      assert.equal(r.ok, false, `${key} did not refuse`);
      assert.equal(r.reason, reason, `${key} gave reason ${r.reason}`);
      assert.ok(typeof r.message === 'string' && r.message.length > 20, `${key} has no human message`);
      // A refusal is DATA, so it must carry nothing else — in particular no partial
      // band list a caller might render.
      assert.equal(r.bands, undefined, `${key} leaked a band list into a refusal`);
      assert.equal(r.blocks, undefined, `${key} leaked a block list into a refusal`);
    });
  }

  // --- (i) THE TYPED CUT LINE (p_rounded_up_php, 2026-09-21) ---
  const overrideNull = obj(probe, 'override_null');
  const override41 = obj(probe, 'override_41_market_41');
  const measured41 = obj(probe, 'r_41_no_override');

  check('OVERRIDE = NULL is BYTE-IDENTICAL to no override at all — the whole compatibility claim', () => {
    // `lens_live` is fn_blocking_price_lens(price); `override_null` is
    // fn_blocking_price_lens(price, ARRAY[-1,0], NULL). Every existing caller, the four
    // computed bases and the whole stored UI configuration take the second path now, so
    // the two payloads must be the same jsonb — not merely the same R.
    assert.deepEqual(overrideNull, lens, 'passing an explicit NULL override changed the payload');
  });

  check('A TYPED PRICE IS THE LINE ITSELF: market 41 with override 41 gives R = 41, cut at 40 / 41', () => {
    assert.equal(override41.ok, true, 'the override call refused');
    assert.equal(n(override41, 'rounded_up_php'), 41, 'the given cut line was not used as R');
    const b = arr(override41, 'bands');
    assert.equal(b.length, 3, `expected 3 bands, got ${b.length}`);
    assert.equal(b[0].lower_php, null, 'band 0 is not open below');
    assert.equal(Number(b[0].upper_php), 40, 'band 0 does not end at R-1 = 40');
    assert.equal(Number(b[1].lower_php), 40, 'the at-market band does not start at 40');
    assert.equal(Number(b[1].upper_php), 41, 'the at-market band does not end at 41');
    assert.equal(Number(b[2].lower_php), 41, 'above market does not start at 41');
    assert.equal(b[2].upper_php, null, 'the last band is not open above');
    // AND the point of the whole change: ₱41 is now ABOVE market, not at market.
    assert.ok(Number(b[2].lower_php) <= 41, '₱41 does not fall in the above-market band');
  });

  check('...while the MEASURED rule on the same number still reads R = 42, unchanged', () => {
    // This is the bug the owner reported, preserved as the correct behaviour for a
    // measured market: the two sit side by side so the one-peso difference is visible.
    assert.equal(n(measured41, 'rounded_up_php'), 42, 'the measured rule changed');
    assert.equal(Number(arr(measured41, 'bands')[1].lower_php), 41, 'the at-market band moved');
  });

  check('the same yard, either way — an override changes the LEGEND, never the blocks', () => {
    for (const [label, l] of [['override 41', override41], ['measured 41', measured41]] as const) {
      const bands = arr(l, 'bands');
      const totals = obj(l, 'total');
      const unp = obj(l, 'unpriced');
      assert.equal(
        bands.reduce((s, b) => s + Number(b.block_count), 0) + n(unp, 'block_count'),
        n(totals, 'block_count'),
        `${label}: blocks went missing`,
      );
      assert.equal(Number(totals.kg), Number(lensTotal.kg), `${label}: describes a different yard`);
    }
  });

  console.log(
    `    typed vs measured on ₱41: R=${n(override41, 'rounded_up_php')} ` +
      `(${arr(override41, 'bands').map((b) => b.block_count).join('/')}) ` +
      `vs R=${n(measured41, 'rounded_up_php')} ` +
      `(${arr(measured41, 'bands').map((b) => b.block_count).join('/')})  [below/at/above]`,
  );

  for (const [key, label] of [
    ['refusal_override_zero', 'a typed cut line of 0'],
    ['refusal_override_negative', 'a negative typed cut line'],
  ] as const) {
    check(`refusal: ${label} -> ok:false, reason 'invalid_rounded_up', with a human message`, () => {
      const r = obj(probe, key);
      assert.equal(r.ok, false, `${key} did not refuse`);
      assert.equal(r.reason, 'invalid_rounded_up', `${key} gave reason ${r.reason}`);
      assert.ok(typeof r.message === 'string' && r.message.length > 20, `${key} has no human message`);
      assert.equal(r.bands, undefined, `${key} leaked a band list into a refusal`);
      assert.equal(r.rounded_up_php, undefined, `${key} leaked an R into a refusal`);
    });
  }

  check('NaN and Infinity are refused, not silently treated as "greater than everything"', () => {
    // In numeric comparison both are > 0, so a bare `> 0` guard would let them
    // through and every block would land in one band.
    assert.equal(obj(probe, 'refusal_nan_price').reason, 'invalid_market_price');
    assert.ok(read(MIGRATION).includes("p_market_php_kg = 'NaN'::numeric"), 'the NaN guard is gone');
    assert.ok(read(MIGRATION).includes("'Infinity'::numeric"), 'the Infinity guard is gone');
  });

  // --- (j) kg_weighted_php_kg (added 2026-09-21, migration 20260921084500) ------
  // The lens could say how many blocks and how many kilograms were in each band, but not
  // what those kilograms COST — so a lens print had to re-weight the band in TypeScript,
  // which CLAUDE.md forbids. One key per band and one on `total`, and nothing else moved.
  //
  // The grid is read DIRECTLY here (service_role holds SELECT on it, 170 rows, far under
  // PostgREST's cap) rather than through a new probe key, so the existing probe is
  // untouched and the recomputation is genuinely independent of the function under test.
  const ANALYSIS_MIGRATION = 'supabase/migrations/20260921084500_blend_analysis_natural_breaks.sql';

  check('the NEW migration is where kg_weighted_php_kg comes from, and it is ADDITIVE', () => {
    const sql = read(ANALYSIS_MIGRATION);
    assert.ok(
      sql.includes('CREATE OR REPLACE FUNCTION public.fn_blocking_price_lens('),
      'the lens is not replaced by the analysis migration',
    );
    // A signature change would mean DROP + CREATE, which discards the grants.
    assert.ok(!/DROP FUNCTION[^;]*fn_blocking_price_lens/.test(sql), 'the lens was dropped, losing its grants');
    assert.ok(sql.includes("'kg_weighted_php_kg', br.wtd_php"), 'the per-band key is not emitted');
    assert.ok(
      sql.includes("'kg_weighted_php_kg', (SELECT p.wtd_php FROM priced p)"),
      "the total's key is not weighted over the PRICED population",
    );
    // ...and the grants and COMMENT are re-stated in the same file anyway.
    assert.ok(
      sql.includes('GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) TO authenticated;'),
      'the grant is not re-applied',
    );
  });

  const gridRes = await svc
    .from('view_blocking_grid')
    .select('block_loc,balance,avg_php_kg')
    .gt('balance', 0);
  assert.ok(!gridRes.error, `reading view_blocking_grid failed: ${gridRes.error?.message}`);
  const gridRows = (gridRes.data ?? []) as Array<{ block_loc: string; balance: number; avg_php_kg: number }>;
  assert.ok(gridRows.length > 0, 'the grid read came back empty — an empty read is a FAILURE, not a pass');
  assert.ok(gridRows.length < 1000, `the grid returned ${gridRows.length} rows — PostgREST may have truncated`);
  const gridByLoc = new Map(gridRows.map((r) => [r.block_loc, r]));

  check("every band's kg_weighted_php_kg IS Σ(kg × ₱/kg) ÷ Σkg over the grid's own blocks", () => {
    // The tolerance is the JSON float boundary, NOT the arithmetic: SQL computes this in
    // exact numeric and a direct SQL comparison measured a gap of exactly 0 on every band.
    const sumKg = new Map<number, number>();
    const sumVal = new Map<number, number>();
    for (const b of arr(lens, 'blocks')) {
      const loc = String(b.block_loc);
      const g = gridByLoc.get(loc);
      assert.ok(g, `the lens classified ${loc}, which is not an occupied grid block`);
      const bi = Number(b.band_index);
      sumKg.set(bi, (sumKg.get(bi) ?? 0) + Number(g!.balance));
      sumVal.set(bi, (sumVal.get(bi) ?? 0) + Number(g!.balance) * Number(g!.avg_php_kg));
    }
    let nonEmpty = 0;
    for (const band of arr(lens, 'bands')) {
      const bi = Number(band.index);
      const kg = sumKg.get(bi) ?? 0;
      if (kg === 0) {
        // NULL, never 0, on an EMPTY band — no charcoal there means no price there.
        assert.equal(band.kg_weighted_php_kg, null, `empty band ${bi} published a price instead of null`);
        assert.equal(Number(band.block_count), 0, `band ${bi} has blocks but no kilograms`);
        continue;
      }
      const mine = (sumVal.get(bi) ?? 0) / kg;
      const theirs = Number(band.kg_weighted_php_kg);
      assert.ok(
        Math.abs(theirs - mine) <= Math.max(1e-9, Math.abs(mine) * 1e-12),
        `band ${bi}: published ₱${theirs} against a recomputed ₱${mine}`,
      );
      nonEmpty += 1;
    }
    assert.ok(nonEmpty >= 2, `only ${nonEmpty} non-empty bands — too few to have proven anything`);
  });

  check("total.kg_weighted_php_kg is weighted over the PRICED blocks, not over every block", () => {
    // The asymmetry is deliberate and is the L-008 rule again: an unpriced block's ₱0 is a
    // placeholder, so averaging it in would drag the figure down the way batches.avg_cost
    // once read ₱11.01 against a real ₱39.99. The counts still cover the whole yard.
    const priced = gridRows.filter((r) => Number(r.avg_php_kg) > 0);
    const kg = priced.reduce((s, r) => s + Number(r.balance), 0);
    const val = priced.reduce((s, r) => s + Number(r.balance) * Number(r.avg_php_kg), 0);
    const mine = kg > 0 ? val / kg : null;
    const theirs = lensTotal.kg_weighted_php_kg;
    assert.ok(theirs !== undefined, 'total.kg_weighted_php_kg is missing');
    if (mine === null) {
      assert.equal(theirs, null, 'nothing is priced yet the total published a price');
    } else {
      assert.ok(
        Math.abs(Number(theirs) - mine) <= Math.max(1e-9, Math.abs(mine) * 1e-12),
        `total: published ₱${String(theirs)} against a recomputed ₱${mine}`,
      );
      // ...and it is NOT the average over every block, whenever those differ.
      const allKg = gridRows.reduce((s, r) => s + Number(r.balance), 0);
      const allVal = gridRows.reduce((s, r) => s + Number(r.balance) * Number(r.avg_php_kg), 0);
      if (Math.abs(allKg - kg) > 1e-9) {
        const naive = allVal / allKg;
        assert.ok(
          Math.abs(Number(theirs) - naive) > 1e-9,
          'the total matches the whole-yard average — an unpriced ₱0 is being averaged in',
        );
      }
    }
    console.log(
      `    weighted price: ${arr(lens, 'bands')
        .map((b) => (b.kg_weighted_php_kg === null ? '—' : `₱${Number(b.kg_weighted_php_kg).toFixed(4)}`))
        .join(' / ')}  ·  total ₱${theirs === null ? '—' : Number(theirs).toFixed(4)}` +
        `  (${priced.length} of ${gridRows.length} blocks priced)`,
    );
  });

  // ── (h) WAREHOUSE SUBTOTALS + THE SEVEN WEIGHTED LAB MEANS (2026-09-22) ──────
  //
  // `fn_blocking_price_lens` gained four per-block keys, a `warehouse_subtotals[]` array and
  // the seven kg-weighted lab means on every band and on `total` (migration
  // `20260922093000`). It exists because the print's warehouse subtotal row printed SEVEN
  // BLANK CELLS, and those blanks were deliberate: `lens/lens-summary-model.ts` makes exactly
  // ONE sum and refuses to make a weighted average, because that would be a second definition
  // of a lab average living in TypeScript. So SQL now computes the partition.
  //
  // Everything below is recomputed LONGHAND from `probe.grid_blocks` — the raw
  // `view_blocking_grid` rows — so the proof is an agreement, not a restatement.
  const WHSE_MIGRATION = 'supabase/migrations/20260922093000_blocking_price_lens_warehouse_subtotals.sql';

  check('the warehouse/lab migration is ADDITIVE and re-states the posture it could lose', () => {
    const sql = read(WHSE_MIGRATION);
    assert.ok(
      sql.includes('CREATE OR REPLACE FUNCTION public.fn_blocking_price_lens('),
      'the lens is not replaced by the warehouse migration',
    );
    // A signature change would mean DROP + CREATE, which discards the grants.
    assert.ok(!/DROP FUNCTION[^;]*fn_blocking_price_lens/.test(sql), 'the lens was dropped, losing its grants');
    assert.ok(
      sql.includes('GRANT  EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) TO authenticated;'),
      'the grant is not re-applied on a ₱-bearing function',
    );
    for (const role of ['PUBLIC', 'anon']) {
      assert.ok(
        sql.includes(`REVOKE EXECUTE ON FUNCTION public.fn_blocking_price_lens(numeric, int[], int) FROM ${role};`),
        `${role} is not re-revoked`,
      );
    }
    assert.ok(!/TO service_role/.test(sql.replace(/_probe\(int\) TO service_role/g, '')),
      'service_role is granted something other than the probe');
    // The new `sup` CTE must be MATERIALIZED like its siblings — see the migration's §G.
    assert.ok(sql.includes('sup AS MATERIALIZED'), 'the new supplier CTE lost its MATERIALIZED hint');
    // A lab reading of 0 is NO READING. The predicate must be `> 0`, never a COALESCE to 0.
    assert.ok(sql.includes('CASE WHEN g.avg_mc      > 0 THEN g.avg_mc      END'),
      'the "0 means no reading" predicate moved — a 0 would be averaged in');
  });

  // The SQL `warehouse` rule and the grid's own warehouse ORDER, IMPORTED from the page
  // rather than re-implemented here — which is the whole point of the comparison below.
  const { warehouseOfBlockLoc } = await import(
    '../app/(app)/inventory/blocking/lens/lens-summary-model'
  );
  const { WAREHOUSES: WAREHOUSES_FOR_ORDER } = await import('../app/(app)/inventory/blocking/constants');

  const gridBlocks = arr(probe, 'grid_blocks');
  const gridBlockByLoc = new Map(gridBlocks.map((g) => [String(g.block_loc), g]));

  check('grid_blocks is the whole occupied yard — an empty read is a FAILURE, not a pass', () => {
    assert.ok(gridBlocks.length > 0, 'the probe returned no grid blocks');
    assert.equal(gridBlocks.length, n(obj(probe, 'grid'), 'block_count'), 'grid_blocks is not the grid');
    assert.ok(gridBlocks.length < 300, `${gridBlocks.length} blocks — the grid has 238 slots maximum`);
  });

  check('SQL\'s `warehouse` EQUALS the page\'s own warehouseOfBlockLoc on EVERY block', () => {
    // THE duplication guard. `WAREHOUSES` lives in TypeScript (the grid's geometry belongs
    // there) and the six keys are repeated in SQL, because a SQL function cannot import a TS
    // constant. So the two are compared block by block: adding warehouse E to the grid fails
    // HERE rather than quietly filing every E block under `-`.
    const seen = new Map<string, number>();
    for (const b of arr(lens, 'blocks')) {
      const loc = String(b.block_loc);
      const mine = warehouseOfBlockLoc(loc);
      assert.equal(b.warehouse, mine, `${loc}: SQL says ${String(b.warehouse)}, the page says ${mine}`);
      seen.set(mine, (seen.get(mine) ?? 0) + 1);
    }
    assert.ok(seen.size >= 2, `only ${seen.size} warehouse(s) present — too few to have proven anything`);
    console.log(
      `    warehouses: ${[...seen.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    );
  });

  check('every block names a supplier or a real NULL — is_mixed is NEVER false without one', () => {
    const facts = new Map(
      arr(probe, 'facts_rows').map((f) => [String(f.batch_id), f]),
    );
    const viewByBlock = new Map<string, Json[]>();
    for (const v of arr(probe, 'view_rows')) {
      const loc = String(v.block_loc);
      viewByBlock.set(loc, [...(viewByBlock.get(loc) ?? []), v]);
    }
    let withSupplier = 0;
    let mixed = 0;
    for (const b of arr(lens, 'blocks')) {
      const loc = String(b.block_loc);
      const rows = viewByBlock.get(loc) ?? [];
      if (rows.length === 0) {
        // No delivery row at all: all three supplier fields must be NULL, never false/0.
        assert.equal(b.dominant_supplier_display, null, `${loc}: a display without a supplier`);
        assert.equal(b.dominant_share_pct, null, `${loc}: a share without a supplier`);
        assert.equal(b.is_mixed, null, `${loc}: is_mixed is not NULL on a supplier-less block`);
        continue;
      }
      withSupplier += 1;
      // THE ALL/SOME rule is the view's own column, carried — never a list length.
      const count = Number(rows[0].supplier_count_in_block);
      assert.equal(b.is_mixed, count > 1, `${loc}: is_mixed disagrees with supplier_count_in_block`);
      if (count > 1) mixed += 1;
      // DOMINANCE is fn_blend_block_facts' rule, reused. Proven against that function.
      const g = gridBlockByLoc.get(loc);
      assert.ok(g, `${loc} is not an occupied grid block`);
      const f = facts.get(String(g!.batch_id));
      assert.ok(f, `${loc}: fn_blend_block_facts has no row for its batch`);
      assert.equal(
        b.dominant_supplier_display,
        f!.dominant_supplier_display,
        `${loc}: the lens and fn_blend_block_facts name different dominant suppliers`,
      );
      assert.equal(
        String(b.dominant_share_pct),
        String(f!.dominant_share_pct),
        `${loc}: the dominant share drifted from fn_blend_block_facts`,
      );
      assert.equal(b.is_mixed, f!.is_single_supplier === false, `${loc}: is_mixed contradicts is_single_supplier`);
    }
    assert.ok(withSupplier > 0, 'not one block has a supplier — the join is broken');
    console.log(`    suppliers: ${withSupplier} blocks attributed, ${mixed} mixed`);
  });

  /** Σ(kg × stat) ÷ Σ(kg) over the rows that HAVE that stat — 0 read as "no reading". */
  function labOf(rows: Json[], key: string): { mean: number | null; kg: number } {
    let kg = 0;
    let val = 0;
    for (const r of rows) {
      const v = r[key] === null || r[key] === undefined ? 0 : Number(r[key]);
      if (!(v > 0)) continue;
      const w = Number(r.kg);
      kg += w;
      val += w * v;
    }
    return { mean: kg > 0 ? val / kg : null, kg };
  }

  const LAB_KEYS = ['mc', 'ash', 'bd_astm', 'bd_jis', 'grit', 'vm', 'fc'] as const;

  check('every BAND\'s seven weighted lab means are Σ(kg × stat) ÷ Σ(kg) over its own blocks', () => {
    const byBand = new Map<number, Json[]>();
    for (const b of arr(lens, 'blocks')) {
      const g = gridBlockByLoc.get(String(b.block_loc));
      assert.ok(g, `${String(b.block_loc)} is not an occupied grid block`);
      const bi = Number(b.band_index);
      byBand.set(bi, [...(byBand.get(bi) ?? []), g!]);
    }
    let proven = 0;
    for (const band of arr(lens, 'bands')) {
      const rows = byBand.get(Number(band.index)) ?? [];
      for (const k of LAB_KEYS) {
        const { mean, kg } = labOf(rows, k);
        const pubMean = band[`w_${k}`];
        const pubKg = Number(band[`${k}_kg`]);
        // The WEIGHT is a real 0 when nothing is measured; the MEAN is NULL, never 0.
        assert.ok(near(pubKg, kg), `band ${String(band.index)} ${k}_kg: ${pubKg} vs ${kg}`);
        if (mean === null) {
          assert.equal(pubMean, null, `band ${String(band.index)}: w_${k} is not NULL with no reading`);
          continue;
        }
        assert.ok(pubMean !== null, `band ${String(band.index)}: w_${k} is NULL but ${kg} kg carry a reading`);
        assert.ok(near(Number(pubMean), mean), `band ${String(band.index)} w_${k}: ${String(pubMean)} vs ${mean}`);
        proven += 1;
      }
    }
    assert.ok(proven >= 7, `only ${proven} (band, stat) pairs proven — too few to have proven anything`);
  });

  check('the seven COVERAGES genuinely DIFFER — one shared "lab kg" would have been wrong', () => {
    // MEASURED 2026-09-22: all 170 blocks carry MC while 11 read 0 on the other six, so
    // total.mc_kg is 10,575,183 kg against 9,805,452 for ash/bd/grit/vm/fc. If this ever
    // collapses to one number, either the yard changed or a stat stopped being filtered.
    const kgs = LAB_KEYS.map((k) => Number(lensTotal[`${k}_kg`]));
    const distinct = new Set(kgs.map((v) => v.toFixed(3)));
    console.log(
      `    lab coverage: ${LAB_KEYS.map((k, i) => `${k} ${Math.round(kgs[i]).toLocaleString('en-US')}`).join(' · ')}`,
    );
    assert.ok(
      distinct.size >= 2,
      'every stat covers the same kilograms — the per-stat FILTERs may have collapsed into one',
    );
  });

  check('total\'s lab means are over the PRICED population, so Σ bands[].<stat>_kg folds exactly', () => {
    // The SAME asymmetry kg_weighted_php_kg carries, and the fold is why it is the right
    // trade: a total over a different population could not equal the sum of its bands.
    const labCheck = obj(probe, 'lab_check');
    for (const label of ['default', 'wide']) {
      const c = obj(labCheck, label);
      for (const k of LAB_KEYS) {
        assert.equal(Number(c[`gap_${k}_kg`]), 0, `${label}: Σ bands[].${k}_kg != total.${k}_kg`);
      }
    }
    // ...and recomputed here too, from the grid, over the priced blocks only.
    const priced = gridBlocks.filter((g) => g.unpriced !== true);
    for (const k of LAB_KEYS) {
      const { mean, kg } = labOf(priced, k);
      assert.ok(near(Number(lensTotal[`${k}_kg`]), kg), `total ${k}_kg: ${String(lensTotal[`${k}_kg`])} vs ${kg}`);
      if (mean === null) assert.equal(lensTotal[`w_${k}`], null, `total w_${k} is not NULL with no reading`);
      else assert.ok(near(Number(lensTotal[`w_${k}`]), mean), `total w_${k}: ${String(lensTotal[`w_${k}`])} vs ${mean}`);
    }
  });

  check('warehouse subtotals FOLD to each band exactly, in the grid\'s own warehouse order', () => {
    const labCheck = obj(probe, 'lab_check');
    for (const label of ['default', 'wide']) {
      const c = obj(labCheck, label);
      // Computed in EXACT decimal by the probe — a JS re-sum could only assert "< epsilon".
      assert.equal(Number(c.gap_whse_block_count), 0, `${label}: Σ subtotal blocks != Σ band blocks`);
      assert.equal(Number(c.gap_whse_kg), 0, `${label}: Σ subtotal kg != Σ band kg`);
      assert.ok(Number(c.whse_row_count) > 0, `${label}: no warehouse rows at all`);
    }

    const subs = arr(lens, 'warehouse_subtotals');
    assert.ok(subs.length > 0, 'the live lens published no warehouse subtotals');

    // PER BAND, not merely in total — a total can tie while two bands swap blocks.
    const bandKg = new Map<number, number>();
    const bandCount = new Map<number, number>();
    for (const s of subs) {
      const bi = Number(s.band_index);
      bandKg.set(bi, (bandKg.get(bi) ?? 0) + Number(s.kg));
      bandCount.set(bi, (bandCount.get(bi) ?? 0) + Number(s.block_count));
    }
    for (const band of arr(lens, 'bands')) {
      const bi = Number(band.index);
      const kg = bandKg.get(bi) ?? 0;
      const cnt = bandCount.get(bi) ?? 0;
      assert.ok(near(kg, Number(band.kg)), `band ${bi}: subtotals sum to ${kg} kg, the band says ${String(band.kg)}`);
      assert.equal(cnt, Number(band.block_count), `band ${bi}: subtotals count ${cnt}, the band says ${String(band.block_count)}`);
      // An EMPTY band contributes NO rows — the one place this lens omits a group.
      if (Number(band.block_count) === 0) {
        assert.equal(subs.filter((s) => Number(s.band_index) === bi).length, 0,
          `empty band ${bi} still got a warehouse row`);
      }
    }

    // ORDER: band ascending, then the grid's own warehouse order with `-` last.
    const order = [...Object.keys(WAREHOUSES_FOR_ORDER), '-'];
    let prev = -1;
    for (const s of subs) {
      const bi = Number(s.band_index);
      const wi = order.indexOf(String(s.warehouse));
      assert.ok(wi >= 0, `unknown warehouse ${String(s.warehouse)} — not one of the grid's, nor the "-" bucket`);
      const rank = bi * 100 + wi;
      assert.ok(rank > prev, `warehouse subtotals are out of order at band ${bi} / ${String(s.warehouse)}`);
      prev = rank;
    }

    // and each row's own arithmetic, longhand off the grid.
    let provenRows = 0;
    for (const s of subs) {
      const rows = arr(lens, 'blocks')
        .filter((b) => Number(b.band_index) === Number(s.band_index) && b.warehouse === s.warehouse)
        .map((b) => gridBlockByLoc.get(String(b.block_loc))!)
        .filter(Boolean);
      assert.equal(rows.length, Number(s.block_count), `${String(s.warehouse)}/${String(s.band_index)}: block count`);
      let kg = 0;
      let val = 0;
      for (const r of rows) {
        kg += Number(r.kg);
        val += Number(r.kg) * Number(r.avg_php_kg);
      }
      assert.ok(near(Number(s.kg), kg), `${String(s.warehouse)}/${String(s.band_index)}: kg`);
      assert.ok(near(Number(s.kg_weighted_php_kg), val / kg), `${String(s.warehouse)}/${String(s.band_index)}: ₱/kg`);
      for (const k of LAB_KEYS) {
        const { mean, kg: lkg } = labOf(rows, k);
        assert.ok(near(Number(s[`${k}_kg`]), lkg), `${String(s.warehouse)}/${String(s.band_index)}: ${k}_kg`);
        if (mean === null) assert.equal(s[`w_${k}`], null, `${String(s.warehouse)}: w_${k} is not NULL`);
        else assert.ok(near(Number(s[`w_${k}`]), mean), `${String(s.warehouse)}/${String(s.band_index)}: w_${k}`);
      }
      provenRows += 1;
    }
    assert.ok(provenRows >= 2, `only ${provenRows} warehouse rows proven`);
    console.log(
      `    warehouse subtotals: ${subs.length} rows over ${arr(lens, 'bands').length} bands ` +
        `(${[...new Set(subs.map((s) => String(s.warehouse)))].join(', ')})`,
    );
  });

  check('NOTHING ELSE IN THE PAYLOAD MOVED — the key sets are exactly what they were, plus the new', () => {
    const LAB_FIELDS = LAB_KEYS.flatMap((k) => [`w_${k}`, `${k}_kg`]);
    assert.deepEqual(
      Object.keys(lens).sort(),
      [
        'bands',
        'blocks',
        'edge_offsets',
        'market_php_kg',
        'ok',
        'rounded_up_php',
        'total',
        'unpriced',
        'warehouse_subtotals',
      ],
      'the top-level key set changed beyond warehouse_subtotals',
    );
    for (const b of arr(lens, 'bands')) {
      assert.deepEqual(
        Object.keys(b).sort(),
        [
          'block_count',
          'block_share_pct',
          'index',
          'kg',
          'kg_share_pct',
          'kg_weighted_php_kg',
          'lower_php',
          'upper_php',
          ...LAB_FIELDS,
        ].sort(),
        'a band gained or lost a key beyond the weighted lab family',
      );
    }
    assert.deepEqual(
      Object.keys(obj(lens, 'total')).sort(),
      ['block_count', 'kg', 'kg_weighted_php_kg', ...LAB_FIELDS].sort(),
      'the total key set is not the old three plus the lab family',
    );
    assert.deepEqual(Object.keys(obj(lens, 'unpriced')).sort(), ['block_count', 'kg'],
      'the unpriced bucket changed — it has no price and no lab reading to publish');
    for (const b of arr(lens, 'blocks')) {
      assert.deepEqual(
        Object.keys(b).sort(),
        ['band_index', 'block_loc', 'dominant_share_pct', 'dominant_supplier_display', 'is_mixed', 'warehouse'],
        'a per-block row changed shape beyond the four additive keys',
      );
    }
    for (const s of arr(lens, 'warehouse_subtotals')) {
      assert.deepEqual(
        Object.keys(s).sort(),
        ['band_index', 'block_count', 'kg', 'kg_weighted_php_kg', 'warehouse', ...LAB_FIELDS].sort(),
        'a warehouse subtotal row changed shape',
      );
    }
  });

  await marketContextChecks(env);
}

// ---------------------------------------------------------------------------
// 3. THE MARKET CONTEXT (`fn_blocking_market_context`, 2026-09-22)
//
// The price lens says what the yard looks like TODAY against ONE number. This says what that
// number has been doing, so a print can tell a reader whether ₱39.88 is high or low. The
// failure modes are the same four the lens has, plus one of its own:
//
//   REUSE      a series that "reads the analytics view" and quietly re-derives it. PROVEN by
//              comparing every month, quarter, YTD and trailing figure against the view read
//              INDEPENDENTLY in the same probe call.
//   SPINE      the last N CALENDAR months instead of the last N months that HAVE a row —
//              which would invent ₱0 months, the L-008 mistake with a calendar.
//   NULL ≠ 0   a window with no priced kilos publishing ₱0.
//   POSTURE    a ₱-bearing function reachable by a role that may not see prices. PROVEN by
//              ASSUMING THE VICTIM'S ROLE and really calling it (L-043's lesson).
//   PARTIAL    a quarter at the window edge reading as a full one. PROVEN: `month_count`.
// ---------------------------------------------------------------------------
async function marketContextChecks(env: { url: string; service: string; anon: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const svc = createClient(env.url, env.service, { auth: { persistSession: false } });
  const anon = createClient(env.url, env.anon, { auth: { persistSession: false } });

  console.log('\nlive — market CONTEXT (fn_blocking_market_context) ----------------');

  const CTX_MIGRATION =
    'supabase/migrations/20260922094500_blocking_market_context_and_supplier_market.sql';

  check('the context migration pins the posture and reads the analytics view ONCE', () => {
    const sql = read(CTX_MIGRATION);
    for (const sig of ['fn_blocking_market_context(int)', 'fn_blocking_supplier_market(int, text[])']) {
      assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC;`), `${sig}: PUBLIC not revoked`);
      assert.ok(sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM anon;`), `${sig}: anon not revoked`);
      assert.ok(sql.includes(`GRANT  EXECUTE ON FUNCTION public.${sig} TO authenticated;`), `${sig}: no grant`);
      const at = sql.indexOf(`COMMENT ON FUNCTION public.${sig} IS`);
      assert.ok(at > 0, `${sig}: no COMMENT`);
      assert.ok(/canViewPrices/.test(sql.slice(at, at + 12_000)), `${sig}: the COMMENT does not name the gate`);
    }
    // The expensive view must be read exactly once per function. Matched with the opening
    // paren so the three PROSE mentions of the hint in the header and the two COMMENTs do not
    // count as code — a comment claiming a hint is exactly what this must not accept.
    assert.equal(
      (sql.match(/\n {2}src AS MATERIALIZED \(/g) ?? []).length,
      2,
      'a src CTE lost its MATERIALIZED hint (expected one per new function)',
    );
    // ...and the supplier one must NOT filter by key, or the month SPINE collapses under a
    // key filter — the bug an unknown key exposed on the first live test.
    assert.ok(
      sql.includes('sel AS MATERIALIZED'),
      'fn_blocking_supplier_market lost its `sel` CTE — the key filter may be back on `src`, which empties the spine',
    );
    assert.ok(
      sql.includes('SELECT DISTINCT s.month_start FROM src s'),
      'the month spine is no longer taken from the UNFILTERED window',
    );
    // The bases function keeps its own hints AND gains the quarter without a new read.
    assert.ok(sql.includes('months AS MATERIALIZED'), 'the bases months CTE lost its hint');
    assert.ok(sql.includes("'this_quarter'::text"), 'the this_quarter basis row is gone');
    assert.ok(
      sql.includes('FILTER (WHERE v.month_start >= a.q0)'),
      'this_quarter no longer FILTERs the existing months CTE — it may have grown a second read',
    );
    // 1..36, REFUSED not clamped, in BOTH new functions.
    assert.equal((sql.match(/p_months < 1 OR p_months > 36/g) ?? []).length, 2, 'the month bounds moved');
    assert.equal((sql.match(/'reason', 'invalid_months'/g) ?? []).length, 4, 'a month refusal went missing');
  });

  check('the TS bounds are ONE definition with SQL, and the action refuses rather than clamps', () => {
    const types = read(TYPES);
    assert.ok(types.includes('BLOCKING_MARKET_CONTEXT_MIN_MONTHS = 1'), 'context min moved');
    assert.ok(types.includes('BLOCKING_MARKET_CONTEXT_MAX_MONTHS = 36'), 'context max moved');
    assert.ok(types.includes('BLOCKING_SUPPLIER_MARKET_MAX_SUPPLIERS = 40'), 'supplier cap moved');
    const actions = read(ACTIONS);
    assert.ok(actions.includes('BLOCKING_MARKET_CONTEXT_MAX_MONTHS'), 'the action re-types the month cap');
    assert.ok(actions.includes('BLOCKING_SUPPLIER_MARKET_MAX_SUPPLIERS'), 'the action re-types the supplier cap');
    // `this_quarter` must be a real member of the basis union AND of the UI's label map, or
    // the select silently cannot offer it.
    assert.ok(types.includes("| 'this_quarter'"), 'this_quarter is not in BlockingMarketBasisKey');
    const settings = read('app/(app)/inventory/blocking/lens/price-lens-settings.ts');
    // RESTATED 2026-09-22 (the UI pass), and it is a STRING, not a rule. This asserted the
    // literal `'This quarter to date'` — the wording the data layer proposed while the select
    // did not yet offer the basis at all. The shipped label is **`This quarter's deliveries`**,
    // which is what the owner asked for and what makes the select read as ONE list
    // (`This month's deliveries · Last month's deliveries · … · This quarter's deliveries`)
    // rather than as four windows and an odd one out. What this check exists to catch is a
    // basis the select CANNOT OFFER, so it is pinned to the KEY having a non-blank label
    // rather than to one spelling of it — a label is copy, and copy is the panel's to own.
    assert.ok(
      /this_quarter: ["'][^"']{4,}["']/.test(settings),
      'the basis has no human label — the select cannot offer it',
    );
    assert.ok(
      (settings.match(/'this_quarter',/g) ?? []).length >= 2,
      'this_quarter is missing from BASIS_KEYS or PRICE_LENS_BASIS_ORDER',
    );
  });

  // L-043's lesson: prove a permission by ASSUMING THE VICTIM'S ROLE, never by reading grants.
  for (const fn of ['fn_blocking_market_context', 'fn_blocking_supplier_market'] as const) {
    const res = await anon.rpc(fn, { p_months: 12 });
    check(`anon CANNOT execute ${fn} (a real call, not a grant lookup)`, () => {
      assert.ok(res.error, `anon executed ${fn} — the REVOKE is gone`);
    });
    const svcRes = await svc.rpc(fn, { p_months: 12 });
    check(`service_role CANNOT execute ${fn} (no worker reads it)`, () => {
      assert.ok(svcRes.error, `service_role executed ${fn} — an unintended grant appeared`);
    });
  }
  const anonProbe = await anon.rpc('fn_blocking_market_context_probe');
  check('anon CANNOT execute the market-context probe either', () => {
    assert.ok(anonProbe.error, 'anon reached the probe — it bypasses both grants');
  });

  const t0 = Date.now();
  const probeRes = await svc.rpc('fn_blocking_market_context_probe');
  const ms = Date.now() - t0;
  assert.ok(!probeRes.error, `fn_blocking_market_context_probe failed: ${probeRes.error?.message}`);
  const probe = probeRes.data as unknown as Json;
  assert.ok(probe && typeof probe === 'object', 'the probe returned nothing — an empty probe is a FAILURE');
  console.log(`  (probe: ${ms} ms wall clock)`);

  check(`the context probe stays under the ${PROBE_MS_BUDGET} ms SHAPE budget`, () => {
    // It is SPLIT from the supplier probe precisely because one function holding both halves
    // timed out at 20 s server-side — see the migration's §J.
    assert.ok(ms < PROBE_MS_BUDGET, `probe took ${ms} ms — check it has not grown a whole-history population`);
  });

  check('catalog posture: authenticated yes, anon no, service_role no; probe service_role only', () => {
    // NOTE this probe covers the MARKET half only — `fn_blocking_supplier_market`'s catalog
    // posture is asserted by `verify-blocking-supplier-lens.ts` against its own probe. The
    // two probes are separate because ONE holding both halves timed out at 20 s server-side.
    const p = obj(probe, 'posture');
    assert.equal(p.context_authenticated, true);
    assert.equal(p.context_anon, false);
    assert.equal(p.context_service_role, false);
    assert.equal(p.bases_authenticated, true);
    assert.equal(p.bases_anon, false);
    assert.equal(p.bases_service_role, false);
    assert.equal(p.probe_service_role, true);
    assert.equal(p.probe_authenticated, false);
    assert.equal(p.probe_anon, false);
    assert.equal(n(p, 'invoker_count'), 2, 'a public function is not SECURITY INVOKER');
    assert.equal(n(p, 'stable_count'), 3, 'a function is not STABLE');
    assert.equal(n(p, 'search_path_pinned'), 3, 'search_path is not pinned everywhere');
    assert.equal(n(p, 'commented_count'), 2, 'a public function lost its COMMENT');
    // ...and the grants on the SUPPLIER half, proven by the real calls above rather than
    // read from this probe's catalog (which no longer carries them).
    assert.equal(n(p, 'bases_overloads'), 1);
    // An OVERLOAD would be a second home for the same logic.
    assert.equal(n(p, 'bases_overloads'), 1, 'fn_blocking_market_bases has an overload');
    assert.equal(n(p, 'context_overloads'), 1, 'fn_blocking_market_context has an overload');
  });

  const rcinRows = arr(probe, 'rcin_rows');
  const ctx = obj(probe, 'context_12');

  check('the analytics view read came back NON-empty — an empty read is a FAILURE', () => {
    assert.ok(rcinRows.length > 0, 'view_analytics_rcin_monthly returned nothing');
    assert.ok(rcinRows.length < 1000, `${rcinRows.length} rows — PostgREST may have truncated`);
    assert.equal(ctx.ok, true, 'fn_blocking_market_context(12) did not return ok:true');
  });

  check('months[] IS the view\'s own last-N rows, ASCENDING — not the last N calendar months', () => {
    const months = arr(ctx, 'months');
    const available = n(ctx, 'months_available');
    assert.equal(available, rcinRows.length, 'months_available is not the view\'s row count');
    assert.equal(n(ctx, 'months_returned'), months.length, 'months_returned disagrees with months.length');
    assert.equal(months.length, Math.min(12, available), 'months is not min(N, available)');

    // THE REUSE PROOF, field for field, against the view read independently.
    const byMonth = new Map(rcinRows.map((r) => [String(r.month), r]));
    let prev = '';
    for (const m of months) {
      const key = String(m.month);
      assert.ok(key > prev, `months is not ascending at ${key}`);
      prev = key;
      const v = byMonth.get(key);
      assert.ok(v, `${key} is not a row of view_analytics_rcin_monthly`);
      assert.equal(String(m.market_php_kg), String(v!.market_php_kg), `${key}: price drifted from the view`);
      assert.equal(String(m.market_kg), String(v!.market_kg), `${key}: kg drifted`);
      assert.equal(String(m.market_priced_kg), String(v!.market_priced_kg), `${key}: priced_kg drifted`);
      assert.equal(Number(m.delivery_count), Number(v!.delivery_count), `${key}: count drifted`);
      assert.equal(Number(m.active_suppliers), Number(v!.active_suppliers), `${key}: supplier count drifted`);
      // NULL, never 0.
      if (m.market_php_kg !== null) assert.ok(Number(m.market_php_kg) > 0, `${key}: a non-positive market price`);
    }
    // ...and they are the LAST N by date, not the first.
    const newest = [...byMonth.keys()].sort().slice(-months.length);
    assert.deepEqual(months.map((m) => String(m.month)), newest, 'months is not the NEWEST N rows');
    console.log(
      `    months: ${months.length} of ${available}, ${String(months[0].month)} -> ` +
        `${String(months[months.length - 1].month)}  ` +
        `(₱${Number(months[0].market_php_kg).toFixed(4)} -> ₱${Number(months[months.length - 1].market_php_kg).toFixed(4)})`,
    );
  });

  check('N = 1 and N = 36 both honour the bound, and neither invents a month', () => {
    const c1 = obj(probe, 'context_1');
    const c36 = obj(probe, 'context_36');
    const available = n(ctx, 'months_available');
    assert.equal(arr(c1, 'months').length, 1, 'N = 1 did not return exactly one month');
    assert.equal(arr(c36, 'months').length, Math.min(36, available), 'N = 36 is not min(36, available)');
    // The newest month is the same whatever N is — the window grows backwards only.
    const last = (c: Json): string => String(arr(c, 'months').slice(-1)[0].month);
    assert.equal(last(c1), last(ctx), 'N = 1 and N = 12 disagree about the newest month');
    assert.equal(last(c36), last(ctx), 'N = 36 and N = 12 disagree about the newest month');
  });

  check('every quarter figure is Σ money ÷ Σ priced kg over ITS OWN months in the window', () => {
    const months = arr(ctx, 'months');
    const byMonth = new Map(rcinRows.map((r) => [String(r.month), r]));
    const groups = new Map<string, Json[]>();
    for (const m of months) {
      const d = new Date(`${String(m.month)}T00:00:00Z`);
      const q = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
      groups.set(q, [...(groups.get(q) ?? []), byMonth.get(String(m.month))!]);
    }
    const quarters = arr(ctx, 'quarters');
    assert.equal(quarters.length, groups.size, 'the quarter count disagrees with the months');
    let prev = '';
    for (const q of quarters) {
      const key = String(q.quarter_key);
      assert.ok(key > prev, `quarters is not ascending at ${key}`);
      prev = key;
      const rows = groups.get(key);
      assert.ok(rows, `${key} is not a quarter the months span`);
      // month_count is what makes a PARTIAL quarter visible — asserted, not hoped for.
      assert.equal(Number(q.month_count), rows!.length, `${key}: month_count is not its months in the window`);
      const kg = rows!.reduce((s, r) => s + Number(r.market_priced_kg), 0);
      const money = rows!.reduce((s, r) => s + Number(r.market_php_total), 0);
      const mine = kg > 0 ? money / kg : null;
      if (mine === null) assert.equal(q.market_php_kg, null, `${key}: a price with no priced kilos`);
      else assert.ok(near(Number(q.market_php_kg), mine), `${key}: ₱${String(q.market_php_kg)} vs ₱${mine}`);
      // ...and NOT the naive mean of its months' prices, whenever those differ.
      if (rows!.length > 1 && kg > 0) {
        const naive = rows!.reduce((s, r) => s + Number(r.market_php_kg), 0) / rows!.length;
        if (Math.abs(naive - mine!) > 1e-9) {
          assert.ok(
            Math.abs(Number(q.market_php_kg) - naive) > 1e-9,
            `${key} equals the naive mean of its months — the weighting is gone`,
          );
        }
      }
    }
    const current = quarters.filter((q) => q.is_current === true);
    assert.equal(current.length, 1, `expected exactly one is_current quarter, got ${current.length}`);
    console.log(
      `    quarters: ${quarters
        .map((q) => `${String(q.label)} ₱${q.market_php_kg === null ? '—' : Number(q.market_php_kg).toFixed(4)}` +
          `${Number(q.month_count) < 3 ? ` (${String(q.month_count)}m PARTIAL)` : ''}${q.is_current ? ' *' : ''}`)
        .join(' · ')}`,
    );
  });

  check('this_quarter IS Σ money ÷ Σ priced kg over the analytics view, read independently', () => {
    // THE reuse proof for the new basis, the same one the four older ones already carry: the
    // probe read this figure STRAIGHT from view_analytics_rcin_monthly, so a re-derivation
    // shows up here rather than as a quiet drift against /analytics.
    const rcinQuarter = obj(probe, 'rcin_this_quarter');
    const basis = arr(probe, 'bases').find((b) => String(b.basis_key) === 'this_quarter');
    assert.ok(basis, 'the this_quarter basis row is missing');
    assert.equal(basis!.market_php_kg, rcinQuarter.php_kg, 'this_quarter price is not the view\'s figure');
    assert.equal(Number(basis!.priced_kg), Number(rcinQuarter.priced_kg), 'this_quarter priced_kg drifted');
    assert.equal(
      Number(basis!.delivery_count),
      Number(rcinQuarter.delivery_count),
      'this_quarter delivery_count drifted',
    );
    // ...and it is NOT the naive mean of the quarter's monthly prices, whenever those differ.
    const months = rcinRows.filter(
      (r) => String(r.month) >= String(probe.this_quarter) && String(r.month) <= String(probe.this_month),
    );
    assert.equal(months.length, Number(rcinQuarter.month_count), 'the quarter covers the wrong months');
    if (months.length > 1) {
      const naive = months.reduce((s, r) => s + Number(r.market_php_kg), 0) / months.length;
      if (Math.abs(naive - Number(basis!.market_php_kg)) < 1e-12) {
        // Legitimate only if the months really are equal-weighted; say so rather than pass.
        const kgs = new Set(months.map((r) => String(r.market_priced_kg)));
        assert.equal(kgs.size, 1, 'this_quarter equals the naive mean of its months — the weighting is gone');
      }
    }
  });

  check('the CURRENT quarter EQUALS the `this_quarter` BASIS — one number, two surfaces', () => {
    // THE cross-function agreement. If these ever differ, one of them re-derived the quarter.
    const bases = arr(probe, 'bases');
    const basis = bases.find((b) => String(b.basis_key) === 'this_quarter');
    assert.ok(basis, 'the bases row is missing from this probe');
    const current = arr(ctx, 'quarters').find((q) => q.is_current === true);
    assert.ok(current, 'no current quarter in the context');
    assert.equal(
      String(current!.market_php_kg),
      String(basis!.market_php_kg),
      'the context quarter and the lens basis disagree about this quarter',
    );
    assert.equal(String(current!.market_priced_kg), String(basis!.priced_kg), 'their priced kilos disagree');
    assert.equal(Number(current!.delivery_count), Number(basis!.delivery_count), 'their counts disagree');
    assert.equal(String(current!.quarter_start), String(basis!.from_date), 'their quarter starts disagree');
  });

  check('year_to_date and trailing_12m are DIRECT aggregations, with month-END anchors', () => {
    const m0 = String(probe.this_month);
    const y0 = String(probe.this_year);
    const monthEnd = (iso: string): string => {
      const d = new Date(`${iso}T00:00:00Z`);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    };
    const shift = (iso: string, months: number): string => {
      const d = new Date(`${iso}T00:00:00Z`);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)).toISOString().slice(0, 10);
    };
    const span = (from: string, to: string): { price: number | null; kg: number; n: number; months: number } => {
      const rows = rcinRows.filter((r) => String(r.month) >= from && String(r.month) <= to);
      const kg = rows.reduce((s, r) => s + Number(r.market_priced_kg), 0);
      const money = rows.reduce((s, r) => s + Number(r.market_php_total), 0);
      return {
        price: kg > 0 ? money / kg : null,
        kg,
        n: rows.reduce((s, r) => s + Number(r.delivery_count), 0),
        months: rows.length,
      };
    };

    const ytd = obj(ctx, 'year_to_date');
    assert.equal(String(ytd.from_date), y0, 'YTD does not start on 1 January');
    // The rows are whole months, so the anchor is the END of the current month — never today.
    assert.equal(String(ytd.to_date), monthEnd(m0), 'YTD does not end on the current month\'s last day');
    const y = span(y0, m0);
    assert.equal(Number(ytd.month_count), y.months, 'YTD month_count drifted');
    if (y.price === null) assert.equal(ytd.market_php_kg, null, 'YTD published a price with no priced kilos');
    else assert.ok(near(Number(ytd.market_php_kg), y.price), `YTD: ₱${String(ytd.market_php_kg)} vs ₱${y.price}`);
    assert.ok(near(Number(ytd.market_priced_kg), y.kg), 'YTD priced_kg drifted');
    assert.equal(Number(ytd.delivery_count), y.n, 'YTD delivery_count drifted');

    const t12 = obj(ctx, 'trailing_12m');
    assert.equal(String(t12.from_date), shift(m0, -11), 'trailing_12m does not start 11 months back');
    assert.equal(String(t12.to_date), monthEnd(m0), 'trailing_12m does not end on the current month\'s last day');
    const t = span(shift(m0, -11), m0);
    assert.equal(Number(t12.month_count), t.months, 'trailing_12m month_count drifted');
    if (t.price === null) assert.equal(t12.market_php_kg, null, 'trailing_12m published a price with no kilos');
    else assert.ok(near(Number(t12.market_php_kg), t.price), `t12: ₱${String(t12.market_php_kg)} vs ₱${t.price}`);
    console.log(
      `    YTD ₱${ytd.market_php_kg === null ? '—' : Number(ytd.market_php_kg).toFixed(4)} over ` +
        `${Number(ytd.month_count)}m  ·  trailing 12m ₱` +
        `${t12.market_php_kg === null ? '—' : Number(t12.market_php_kg).toFixed(4)} over ${Number(t12.month_count)}m`,
    );
  });

  check('latest_month is the view\'s NEWEST row, and says whether it is the current month', () => {
    const latest = obj(ctx, 'latest_month');
    const newest = [...rcinRows].sort((a, b) => String(a.month).localeCompare(String(b.month))).slice(-1)[0];
    assert.equal(String(latest.month), String(newest.month), 'latest_month is not the newest row');
    assert.equal(String(latest.market_php_kg), String(newest.market_php_kg), 'latest_month price drifted');
    // The flag is what stops a UI labelling a stale month "this month".
    assert.equal(
      latest.is_current_month,
      String(newest.month) === String(probe.this_month),
      'is_current_month does not describe the newest row',
    );
  });

  for (const [key, reason] of [
    ['refusal_context_null', 'invalid_months'],
    ['refusal_context_zero', 'invalid_months'],
    ['refusal_context_big', 'invalid_months'],
  ] as const) {
    check(`refusal: ${key} -> ok:false, reason '${reason}', with a human message`, () => {
      const r = obj(probe, key);
      assert.equal(r.ok, false, `${key} did not refuse`);
      assert.equal(r.reason, reason, `${key} gave the wrong reason`);
      assert.ok(typeof r.message === 'string' && r.message.length > 20, `${key}: no human message`);
      assert.ok(!/SQLSTATE|ERROR:/i.test(String(r.message)), `${key}: the message reads like a raise`);
    });
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('verify-blocking-price-lens — the Blocking price lens data layer');
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
