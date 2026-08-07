/**
 * verify-supplier-canon.ts — assert the TypeScript mirror
 * `workers/sync/src/reports/deliveries/supplierCanon.ts::canonicalSupplier`
 * agrees EXACTLY with the database function `public.canonical_supplier(text)`.
 *
 * Run: npx tsx scripts/verify-supplier-canon.ts
 *
 * ============================================================================
 * WHY A MIRROR NEEDS A VERIFIER
 * ============================================================================
 * The delivery price matcher compares supplier names on BOTH sides of the join
 * (ours vs Czarina's) once per candidate row. An RPC per row would be hundreds of
 * round-trips and would make the matcher DB-dependent — `enrich.ts` is pure today,
 * which is exactly what lets the tab resolver and the fallback matcher be tested
 * offline against a real workbook with no database at all. So the SQL is mirrored in
 * TypeScript, the "mirror, don't import the parity-critical table" idiom this
 * codebase already uses (see `scripts/verify-case-grouping.ts`, which asserts the
 * duplicated `TRIAGE_KIND` constants match).
 *
 * A mirror that silently drifts is worse than no mirror: `canonical_supplier` is the
 * ONE thing that makes "Paquibot/Compra" (ours) and "PAQUIBOT" (hers) the same
 * supplier. If the DB learns a new alias and this copy does not, the price match
 * quietly stops firing for that supplier — the exact shape of failure (silent,
 * cost-bearing, invisible) that un-priced every August 2026 delivery.
 *
 * ============================================================================
 * TWO LAYERS, AND WHY BOTH
 * ============================================================================
 *  1. OFFLINE (always runs, no network). A frozen corpus of `input → expected`
 *     pairs, every expectation READ FROM THE LIVE DB on 2026-08-07. This is the
 *     regression gate: it fails if someone "simplifies" the mirror.
 *  2. LIVE (runs when NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
 *     present). Calls `public.canonical_supplier` for every corpus input AND for
 *     every distinct `deliveries.supplier` in the database, and asserts the mirror
 *     agrees on all of them. This is the layer that catches DRIFT — a frozen table
 *     can only ever prove the mirror still matches what the DB said in the past.
 *
 * The live layer SKIPS (loudly, exit 0) without credentials so the check stays
 * runnable in CI or on a laptop with no keys; it is not optional when you have
 * touched either copy.
 *
 * IF THIS SCRIPT FAILS: the DB and the mirror disagree. The DB is authoritative —
 * update `supplierCanon.ts` (and the frozen corpus below) to match it, never the
 * other way round.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { canonicalSupplier, supplierAliasKey } from '../workers/sync/src/reports/deliveries/supplierCanon'

let passed = 0
function check(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  const done = () => {
    passed++
    console.log(`  ✓ ${name}`)
  }
  const r = fn()
  if (r instanceof Promise) return r.then(done)
  done()
}

// ---------------------------------------------------------------------------
// The frozen corpus. EVERY `expected` here was read from the live database on
// 2026-08-07 with:
//   SELECT s, public.canonical_supplier(s) FROM (VALUES ...) v(s);
// Do not hand-edit an expectation to make a test pass — re-read it from the DB.
// ---------------------------------------------------------------------------
const CORPUS: Array<{ input: string | null; expected: string; note?: string }> = [
  // -- the ORDERED, NON-OVERLAPPING ILIKE trap ------------------------------
  // `%mercado%ornales%` means "mercado occurs, and ornales occurs ENTIRELY AFTER it".
  // In "MERCADORNALES" the 'o' is SHARED, so SQL matches neither order and the row
  // falls through to the ELSE branch. A naive `contains(a) && contains(b)` mirror
  // would return ORNALES here and silently merge a supplier that the DB keeps apart.
  { input: 'MERCADORNALES', expected: 'MERCADORNALES', note: 'shared o — SQL matches NEITHER order' },
  { input: 'Mercado Ornales', expected: 'ORNALES' },
  { input: 'ORNALES MERCADO', expected: 'ORNALES', note: 'reverse order also written out in the SQL' },
  { input: 'Mercado / Ornales', expected: 'ORNALES' },
  { input: 'SUAREZPAQUIBOT', expected: 'PAQUIBOT', note: 'no shared letter — adjacent tokens DO match' },
  { input: 'PAQUIBOTSUAREZ', expected: 'PAQUIBOT' },

  // -- branch ORDER is load-bearing (a CASE stops at the first TRUE) --------
  // 'BAGUIO/TIPALAN' is tested BEFORE 'BAGUIO'. Swap them and every Tipalan row
  // collapses into BAGUIO.
  { input: 'Tipalan', expected: 'BAGUIO/TIPALAN', note: 'tipal wins over bagui — order matters' },
  { input: 'tiplan', expected: 'BAGUIO/TIPALAN', note: 'the tipla misspelling' },
  { input: 'Baguio Tipalan', expected: 'BAGUIO/TIPALAN' },
  { input: 'Baguio/Tipalan', expected: 'BAGUIO/TIPALAN' },
  { input: 'Bagiu/Tipalan', expected: 'BAGUIO/TIPALAN' },
  { input: 'Bagiuo/ Tipalan', expected: 'BAGUIO/TIPALAN' },
  { input: 'Baguio', expected: 'BAGUIO' },
  { input: 'bagio', expected: 'BAGUIO', note: 'the bagi misspelling' },
  { input: 'Bagiuo', expected: 'BAGUIO' },

  // -- ORNALES swallows a mercado+paquibot pair, PAQUIBOT does not ----------
  // Counter-intuitive but correct: the ORNALES branch is tested first AND it lists
  // `%mercado%paquibot%`, so "mercado paquibot" is ORNALES, not PAQUIBOT.
  { input: 'mercado paquibot', expected: 'ORNALES', note: 'ORNALES branch claims mercado+paquibot' },
  { input: 'Mercado/Paquibot', expected: 'ORNALES' },
  { input: 'Arbelera Mercado', expected: 'ORNALES' },
  { input: 'Arbelera/Mercado', expected: 'ORNALES' },
  { input: 'NAZARTE ARBELERA', expected: 'ORNALES' },
  { input: 'Nazarte/ Arbelera', expected: 'ORNALES' },
  { input: 'Arbelera', expected: 'ARBELERA', note: 'alone it is NOT collapsed' },
  { input: 'Mercado', expected: 'MERCADO', note: 'alone it is NOT collapsed' },

  // -- PAQUIBOT pairs -------------------------------------------------------
  // The real reason this mirror exists: our "Paquibot/Compra" vs Czarina's "PAQUIBOT".
  { input: 'Paquibot/Compra', expected: 'PAQUIBOT', note: 'OURS — the 2026-07-20 backfill row' },
  { input: 'PAQUIBOT', expected: 'PAQUIBOT', note: "CZARINA'S — must equal the line above" },
  { input: 'compra paquibot', expected: 'PAQUIBOT' },
  { input: 'Compra/Paquibot', expected: 'PAQUIBOT' },
  { input: 'Suarez Paquibot', expected: 'PAQUIBOT' },
  { input: 'Suarez/Paquibot', expected: 'PAQUIBOT' },
  { input: 'BARAQUEL PAQUIBOT', expected: 'PAQUIBOT' },
  { input: 'Baraquel/Paquibot', expected: 'PAQUIBOT' },
  { input: 'Suarez', expected: 'SUAREZ', note: 'alone it is NOT collapsed' },

  // -- NAZARENO -------------------------------------------------------------
  { input: 'Nazareno', expected: 'NAZARENO' },
  { input: 'nazarino', expected: 'NAZARENO' },
  { input: 'Nazarino', expected: 'NAZARENO' },
  // A substring match, so a trailing batch code does NOT stop the collapse here…
  { input: 'NAZARINO - FEB-26-BLK15', expected: 'NAZARENO', note: 'ILIKE is a substring test' },

  // -- the ELSE branch: UPPER(TRIM(x)), with '' → UNKNOWN -------------------
  { input: null, expected: 'UNKNOWN', note: 'every ILIKE against NULL is NULL, so ELSE runs' },
  { input: '', expected: 'UNKNOWN' },
  { input: '   ', expected: 'UNKNOWN', note: 'NULLIF(TRIM(...), "")' },
  { input: '  Ornales  ', expected: 'ORNALES' },
  { input: 'Ornales', expected: 'ORNALES' },
  { input: 'ORNALES', expected: 'ORNALES' },
  { input: 'Esito', expected: 'ESITO' },
  { input: 'Ecito', expected: 'ECITO', note: 'a real typo the DB does NOT collapse' },
  { input: 'Llanto', expected: 'LLANTO' },
  { input: 'Tag-at', expected: 'TAG-AT' },
  { input: 'Zzz Unknown Trader', expected: 'ZZZ UNKNOWN TRADER' },
  // …but for a NON-collapsed supplier the batch-code suffix survives, which is why
  // these are DIFFERENT canonical suppliers in the DB. Mirroring that faithfully
  // matters: "collapse them too" would be a behaviour change, not a bug fix.
  { input: 'Layupan', expected: 'LAYUPAN' },
  { input: 'Layupan - JAN-26-BLK8', expected: 'LAYUPAN - JAN-26-BLK8', note: 'NOT collapsed to LAYUPAN' },
  { input: 'Esito - NOV-25-BLK9', expected: 'ESITO - NOV-25-BLK9' },
  { input: 'SEVILLA 2022 BACKLOG', expected: 'SEVILLA 2022 BACKLOG' },
  { input: 'RECOOK(Lapayag,Bernie)', expected: 'RECOOK(LAPAYAG,BERNIE)' },
  { input: 'Re-cook/Lapayag bernie', expected: 'RE-COOK/LAPAYAG BERNIE' },
]

// ---------------------------------------------------------------------------
// 1. OFFLINE — the mirror against the frozen corpus.
// ---------------------------------------------------------------------------
console.log('supplier canon — offline (frozen corpus read from the live DB 2026-08-07)')

check(`mirror matches all ${CORPUS.length} frozen expectations`, () => {
  const bad: string[] = []
  for (const c of CORPUS) {
    const got = canonicalSupplier(c.input)
    if (got !== c.expected) {
      bad.push(`  ${JSON.stringify(c.input)} -> mirror ${JSON.stringify(got)}, DB ${JSON.stringify(c.expected)}${c.note ? `  (${c.note})` : ''}`)
    }
  }
  assert.equal(bad.length, 0, `mirror disagrees with the DB on ${bad.length} input(s):\n${bad.join('\n')}`)
})

check('the ordered/non-overlapping ILIKE trap is reproduced (MERCADORNALES stays itself)', () => {
  // Guarded explicitly, not just via the corpus loop, because this is the ONE case a
  // well-meaning refactor to `includes(a) && includes(b)` would break.
  assert.equal(canonicalSupplier('MERCADORNALES'), 'MERCADORNALES')
  assert.equal(canonicalSupplier('Mercado Ornales'), 'ORNALES')
})

check('branch order holds: BAGUIO/TIPALAN is tested before BAGUIO', () => {
  assert.equal(canonicalSupplier('Baguio Tipalan'), 'BAGUIO/TIPALAN')
  assert.notEqual(canonicalSupplier('Tipalan'), 'BAGUIO')
})

check('undefined is total (never throws, never empty)', () => {
  assert.equal(canonicalSupplier(undefined), 'UNKNOWN')
  for (const c of CORPUS) assert.ok(canonicalSupplier(c.input).length > 0)
})

check('THE match that fixes the supplier-variant class: ours === hers', () => {
  // The whole point. If this ever fails, 2026-07-20's Paquibot delivery stops matching.
  assert.equal(canonicalSupplier('Paquibot/Compra'), canonicalSupplier('PAQUIBOT'))
  assert.equal(canonicalSupplier('Paquibot/Compra'), 'PAQUIBOT')
})

// ---------------------------------------------------------------------------
// 2. `supplierAliasKey` — the OTHER key space, deliberately NOT canonical.
// ---------------------------------------------------------------------------
console.log('\nsupplier alias key — UPPER(TRIM(x)), NOT the canonical collapse')

check('alias key does NOT collapse — it is the fallback for variants canonical misses', () => {
  // `delivery_source_aliases.kind = 'supplier'` is keyed here, not on canonical output.
  // Keying it canonically would store a degenerate PAQUIBOT -> PAQUIBOT row saying nothing.
  assert.equal(supplierAliasKey('Paquibot/Compra'), 'PAQUIBOT/COMPRA')
  assert.equal(supplierAliasKey('PAQUIBOT'), 'PAQUIBOT')
  assert.notEqual(supplierAliasKey('Paquibot/Compra'), supplierAliasKey('PAQUIBOT'))
  // …and the seeded row's two sides are exactly these values.
  assert.equal(supplierAliasKey('  Paquibot/Compra  '), 'PAQUIBOT/COMPRA')
})

check('alias key is total, same UNKNOWN floor as canonical', () => {
  assert.equal(supplierAliasKey(null), 'UNKNOWN')
  assert.equal(supplierAliasKey(undefined), 'UNKNOWN')
  assert.equal(supplierAliasKey(''), 'UNKNOWN')
  assert.equal(supplierAliasKey('   '), 'UNKNOWN')
})

// ---------------------------------------------------------------------------
// 3. LIVE — the drift check. Needs credentials; skips loudly without them.
// ---------------------------------------------------------------------------

/** Read NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from env or .env.local. */
function readEnv(): { url: string; key: string } | null {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!url || !key) {
    try {
      const txt = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
      for (const raw of txt.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const k = line.slice(0, eq).trim()
        const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (k === 'NEXT_PUBLIC_SUPABASE_URL' && !url) url = v
        if (k === 'SUPABASE_SERVICE_ROLE_KEY' && !key) key = v
      }
    } catch {
      /* no .env.local — fall through to the skip */
    }
  }
  return url && key ? { url, key } : null
}

async function liveCheck(env: { url: string; key: string }): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } })

  // Every distinct supplier the database actually holds, plus the whole frozen corpus.
  // The DB rows are the important half: they are the strings the matcher will really
  // meet, including any a future operator types that nobody thought to put in a test.
  const { data: rows, error } = await sb.from('deliveries').select('supplier').limit(20000)
  if (error) throw new Error(`could not read deliveries.supplier: ${error.message}`)

  const inputs: Array<string | null> = [...CORPUS.map((c) => c.input)]
  const seen = new Set(inputs.map((i) => JSON.stringify(i)))
  for (const r of rows ?? []) {
    const s = (r as { supplier: string | null }).supplier
    const k = JSON.stringify(s)
    if (!seen.has(k)) {
      seen.add(k)
      inputs.push(s)
    }
  }

  // One round-trip: ask the DB to canonicalize the whole list at once.
  const { data: dbOut, error: rpcErr } = await sb.rpc('canonical_supplier_batch_probe', {
    p_inputs: inputs,
  })
  // No probe helper exists (and none should be created just for a test) — fall back to
  // one RPC per DISTINCT input. Slower, but exact and needs no schema change.
  let pairs: Array<{ input: string | null; db: string }>
  if (rpcErr || !Array.isArray(dbOut)) {
    pairs = await Promise.all(
      inputs.map(async (input) => {
        const { data, error: e } = await sb.rpc('canonical_supplier', { p_supplier: input })
        if (e) throw new Error(`canonical_supplier(${JSON.stringify(input)}) failed: ${e.message}`)
        return { input, db: String(data) }
      }),
    )
  } else {
    pairs = (dbOut as Array<{ input: string | null; out: string }>).map((r) => ({ input: r.input, db: String(r.out) }))
  }

  const bad: string[] = []
  for (const p of pairs) {
    const mine = canonicalSupplier(p.input)
    if (mine !== p.db) {
      bad.push(`  ${JSON.stringify(p.input)} -> mirror ${JSON.stringify(mine)}, DB ${JSON.stringify(p.db)}`)
    }
  }

  check(
    `mirror agrees with public.canonical_supplier on all ${pairs.length} live inputs ` +
      `(${CORPUS.length} corpus + ${pairs.length - CORPUS.length} distinct from deliveries)`,
    () => {
      assert.equal(
        bad.length,
        0,
        `THE MIRROR HAS DRIFTED from public.canonical_supplier on ${bad.length} input(s).\n` +
          `The DB is authoritative — fix workers/sync/src/reports/deliveries/supplierCanon.ts:\n${bad.join('\n')}`,
      )
    },
  )

  // Cross-check the frozen expectations against TODAY's DB, so a stale corpus is a
  // visible failure rather than a test that passes while proving nothing.
  const byInput = new Map(pairs.map((p) => [JSON.stringify(p.input), p.db]))
  check('the frozen corpus still matches what the DB says today (no stale expectations)', () => {
    const stale: string[] = []
    for (const c of CORPUS) {
      const db = byInput.get(JSON.stringify(c.input))
      if (db !== undefined && db !== c.expected) {
        stale.push(`  ${JSON.stringify(c.input)} -> corpus says ${JSON.stringify(c.expected)}, DB now says ${JSON.stringify(db)}`)
      }
    }
    assert.equal(stale.length, 0, `the frozen corpus is STALE on ${stale.length} input(s):\n${stale.join('\n')}`)
  })
}

async function main(): Promise<void> {
  const env = readEnv()
  if (!env) {
    console.log('\nlive DB cross-check — SKIPPED')
    console.log('  ! NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.')
    console.log('  ! The offline corpus only proves the mirror matches what the DB said on')
    console.log('  ! 2026-08-07. Run this WITH credentials after touching either copy.')
  } else {
    console.log('\nlive DB cross-check — public.canonical_supplier vs the TS mirror')
    await liveCheck(env)
  }
  console.log(`\nAll ${passed} supplier-canon checks passed.`)
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
