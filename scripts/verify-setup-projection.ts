/**
 * verify-setup-projection.ts — framework-free proof that the production-plan projection
 * is correct, is the ONLY implementation, and reproduces the table's own history.
 *
 * The projection lives in `lib/production/setup-projection.ts` and turns a SETUP (a
 * per-shift grade mix, from `public.production_setups.grade_mix`) plus a SHIFT COUNT into
 * a day's `grades` + `projected_tons`. It is deliberately in TypeScript and NOT duplicated
 * in SQL — see that module's header for the argument.
 *
 * Asserts:
 *   1. Rule 1 — a setup is a per-shift grade mix; one shift reproduces the mix verbatim.
 *   2. Rule 2 — it scales linearly with `shifts` (the SOLID 3X50 25→50 case, live-proven).
 *   3. Rule 3 — `projectedTons` is ALWAYS the sum of `grades`' values, by construction,
 *               including under rounding and under dropped entries.
 *   4. HISTORY — every seeded setup reproduces the modal (setup, shifts) → (grades, tons)
 *               combination actually observed in `production_schedule`.
 *   5. Rest days — shifts 0 / negative / non-finite / empty mix all yield the exact shape
 *               the 56 rest-day rows hold: `{grades: null, projectedTons: 0}`.
 *   6. Rounding — whole tons, half AWAY FROM ZERO, parts rounded then summed.
 *   7. parseGradeMix — tolerant of PostgREST string numerics, strict about junk.
 *   8. Overrides — `isOnTemplate` reports the real historical overrides as off-template,
 *               which is a normal state, not an error.
 *   9. No SECOND implementation — no `.ts`/`.sql` outside this module reimplements the
 *               scaling, and the SQL side exposes no projection function.
 *
 * PURE: no DB, no network, no server context — same discipline as the other verify
 * scripts. The live-DB cross-check (seed rows match these constants) is a separate,
 * one-off proof recorded in the migration header.
 *
 * Run:  npx tsx scripts/verify-setup-projection.ts
 */
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'

import {
  parseGradeMix,
  projectSetup,
  projectSetupByCode,
  toProductionSetup,
  isOnTemplate,
  type GradeMix,
  type ProductionSetup,
} from '../lib/production/setup-projection'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

const sum = (m: GradeMix | null) =>
  m ? Object.values(m).reduce((a, b) => a + b, 0) : 0

/**
 * The seeded library, mirrored from migration 20260730080000_production_setups.sql.
 * Kept as a literal so this script fails loudly if the seed and the expectations diverge.
 */
const LIBRARY: ProductionSetup[] = [
  { code: 'SOLID 3X50', label: 'Solid 3X50', gradeMix: { '3X50': 25 }, active: true, sortOrder: 10, notes: null },
  { code: '3X50 / 6X50', label: null, gradeMix: { '3X50': 20, '6X50': 6 }, active: true, sortOrder: 20, notes: null },
  { code: '3X50 / 4X8', label: null, gradeMix: { '3X50': 21, '4X8': 5 }, active: true, sortOrder: 30, notes: null },
  { code: '3X50 / 2X6', label: null, gradeMix: { '3X50': 10, '2X6': 15 }, active: true, sortOrder: 40, notes: null },
  { code: '3X50 / 8X50', label: null, gradeMix: { '3X50': 20, '8X50': 6 }, active: true, sortOrder: 50, notes: null },
]

/**
 * The MODAL (setup, shifts) → (grades, projected_tons) combinations actually present in
 * `production_schedule` on 2026-07-30. These are observations, not aspirations.
 */
const HISTORY: Array<{
  setup: string
  shifts: number
  grades: GradeMix
  tons: number
  days: number
}> = [
  { setup: 'SOLID 3X50', shifts: 1, grades: { '3X50': 25 }, tons: 25, days: 127 },
  { setup: 'SOLID 3X50', shifts: 2, grades: { '3X50': 50 }, tons: 50, days: 14 },
  { setup: '3X50 / 6X50', shifts: 1, grades: { '3X50': 20, '6X50': 6 }, tons: 26, days: 39 },
  { setup: '3X50 / 4X8', shifts: 1, grades: { '3X50': 21, '4X8': 5 }, tons: 26, days: 16 },
  { setup: '3X50 / 2X6', shifts: 1, grades: { '3X50': 10, '2X6': 15 }, tons: 25, days: 10 },
  { setup: '3X50 / 8X50', shifts: 1, grades: { '3X50': 20, '8X50': 6 }, tons: 26, days: 6 },
]

/** The real per-day OVERRIDES in the table — legal, expected, and off-template. */
const OVERRIDES: Array<{ setup: string; shifts: number; grades: GradeMix; tons: number }> = [
  { setup: 'SOLID 3X50', shifts: 1, grades: { '3X50': 25, '4X8': 5 }, tons: 30 },
  { setup: '3X50 / 4X8', shifts: 1, grades: { '3X50': 21, '4X8': 3 }, tons: 24 },
  { setup: '3X50 / 2X6', shifts: 1, grades: { '3X50': 25 }, tons: 25 },
]

console.log('verify-setup-projection\n')

// ── 1. Rule 1 — one shift reproduces the mix verbatim ────────────────────────
check('rule 1: a setup is a per-shift grade mix (1 shift == the mix)', () => {
  for (const s of LIBRARY) {
    const p = projectSetup(s.gradeMix, 1)
    assert.deepEqual(p.grades, s.gradeMix, `${s.code} at 1 shift must equal its mix`)
  }
})

// ── 2. Rule 2 — linear scaling ───────────────────────────────────────────────
check('rule 2: scales linearly with shifts (SOLID 3X50 25 -> 50 -> 75)', () => {
  const solid = LIBRARY[0].gradeMix
  assert.deepEqual(projectSetup(solid, 1), { grades: { '3X50': 25 }, projectedTons: 25 })
  assert.deepEqual(projectSetup(solid, 2), { grades: { '3X50': 50 }, projectedTons: 50 })
  assert.deepEqual(projectSetup(solid, 3), { grades: { '3X50': 75 }, projectedTons: 75 })

  for (const s of LIBRARY) {
    for (const shifts of [1, 2, 3, 4]) {
      const p = projectSetup(s.gradeMix, shifts)
      for (const [g, perShift] of Object.entries(s.gradeMix)) {
        assert.equal(p.grades?.[g], perShift * shifts, `${s.code}/${g} at ${shifts} shifts`)
      }
    }
  }
})

// ── 3. Rule 3 — total is the sum, always ─────────────────────────────────────
check('rule 3: projectedTons is ALWAYS the sum of grades (by construction)', () => {
  const mixes: GradeMix[] = [
    ...LIBRARY.map((s) => s.gradeMix),
    { A: 12.5, B: 7.5 },
    { A: 0.4 },                 // rounds away entirely
    { A: 1, B: -3, C: 0 },      // non-positive entries dropped
    { A: 1 / 3, B: 2 / 3 },
    { A: 1e-9 },
  ]
  for (const mix of mixes) {
    for (const shifts of [1, 2, 3, 7]) {
      const p = projectSetup(mix, shifts)
      assert.equal(
        p.projectedTons,
        sum(p.grades),
        `sum(grades) must equal projectedTons for ${JSON.stringify(mix)} x${shifts}`
      )
    }
  }
})

// ── 4. History — the seeded library reproduces the real table ────────────────
check('history: every seeded setup reproduces its modal rows in production_schedule', () => {
  let coveredDays = 0
  for (const h of HISTORY) {
    const p = projectSetupByCode(LIBRARY, h.setup, h.shifts)
    assert.deepEqual(
      p.grades,
      h.grades,
      `${h.setup} @ ${h.shifts} shift(s) must project ${JSON.stringify(h.grades)}`
    )
    assert.equal(p.projectedTons, h.tons, `${h.setup} @ ${h.shifts} shift(s) tons`)
    // and the observed row itself obeys rule 3
    assert.equal(sum(h.grades), h.tons, `observed row ${h.setup} violates rule 3`)
    coveredDays += h.days
  }
  assert.equal(coveredDays, 212, 'modal rows should cover 212 of the 217 setup-bearing days')
})

// ── 5. Rest days ─────────────────────────────────────────────────────────────
check('rest days: shifts 0/negative/NaN and empty mixes give {grades:null, tons:0}', () => {
  const REST = { grades: null, projectedTons: 0 }
  const solid = LIBRARY[0].gradeMix
  assert.deepEqual(projectSetup(solid, 0), REST)
  assert.deepEqual(projectSetup(solid, -1), REST)
  assert.deepEqual(projectSetup(solid, Number.NaN), REST)
  assert.deepEqual(projectSetup(solid, Number.POSITIVE_INFINITY), REST)
  assert.deepEqual(projectSetup({}, 1), REST)
  assert.deepEqual(projectSetup({ A: 0.4 }, 1), REST, 'a mix that rounds to nothing is a rest day')
  assert.deepEqual(projectSetupByCode(LIBRARY, null, 1), REST)
  assert.deepEqual(projectSetupByCode(LIBRARY, 'NOT A SETUP', 1), REST, 'legacy free-text setup')
})

// ── 6. Rounding ──────────────────────────────────────────────────────────────
check('rounding: whole tons, half away from zero, parts rounded THEN summed', () => {
  assert.deepEqual(projectSetup({ A: 12.5 }, 1), { grades: { A: 13 }, projectedTons: 13 })
  assert.deepEqual(projectSetup({ A: 0.5 }, 1), { grades: { A: 1 }, projectedTons: 1 })
  assert.deepEqual(projectSetup({ A: 1.5, B: 1.5 }, 1), { grades: { A: 2, B: 2 }, projectedTons: 4 })
  // round-then-sum: 1.4+1.4 = 2.8, but the PARTS round to 1+1 = 2. The total tracks the
  // parts, never a separately-rounded 3.
  assert.deepEqual(projectSetup({ A: 1.4, B: 1.4 }, 1), { grades: { A: 1, B: 1 }, projectedTons: 2 })
  // no float dust on the whole-number data that actually exists
  for (const s of LIBRARY) {
    for (const shifts of [1, 2, 3]) {
      for (const v of Object.values(projectSetup(s.gradeMix, shifts).grades ?? {})) {
        assert.equal(Number.isInteger(v), true, `${s.code} must project whole tons`)
      }
    }
  }
})

// ── 7. parseGradeMix ─────────────────────────────────────────────────────────
check('parseGradeMix: tolerant of PostgREST strings, strict about junk', () => {
  assert.deepEqual(parseGradeMix({ '3X50': '20', '6X50': 6 }), { '3X50': 20, '6X50': 6 })
  assert.deepEqual(parseGradeMix(null), {})
  assert.deepEqual(parseGradeMix(undefined), {})
  assert.deepEqual(parseGradeMix('{"A":1}'), {}, 'a JSON STRING is not a parsed object')
  assert.deepEqual(parseGradeMix([1, 2]), {})
  assert.deepEqual(parseGradeMix({ A: 0, B: -1, C: 'x', D: '', '  ': 5 }), {})
  assert.deepEqual(parseGradeMix({ '  3X50  ': 4 }), { '3X50': 4 }, 'keys trimmed')

  const mapped = toProductionSetup({
    code: '3X50 / 6X50',
    label: null,
    grade_mix: { '3X50': '20', '6X50': '6' },
    active: null,
    sort_order: null,
    notes: null,
  })
  assert.deepEqual(mapped.gradeMix, { '3X50': 20, '6X50': 6 })
  assert.equal(mapped.active, true)
  assert.equal(mapped.sortOrder, 100)
})

// ── 8. Overrides are off-template, and that is FINE ──────────────────────────
check('overrides: the real per-day overrides read as off-template, not as errors', () => {
  for (const o of OVERRIDES) {
    const p = projectSetupByCode(LIBRARY, o.setup, o.shifts)
    assert.equal(
      isOnTemplate(p, o.grades, o.tons),
      false,
      `${o.setup} override ${JSON.stringify(o.grades)} should be off-template`
    )
    assert.equal(sum(o.grades), o.tons, `override ${o.setup} still obeys rule 3`)
  }
  for (const h of HISTORY) {
    const p = projectSetupByCode(LIBRARY, h.setup, h.shifts)
    assert.equal(isOnTemplate(p, h.grades, h.tons), true, `${h.setup} modal row is on-template`)
  }
  // tolerant of PostgREST numeric-as-string round-tripping
  const p = projectSetupByCode(LIBRARY, '3X50 / 6X50', 1)
  assert.equal(isOnTemplate(p, { '3X50': '20', '6X50': '6' }, 26), true)
})

// ── 9. Exactly ONE implementation ────────────────────────────────────────────
check('single implementation: nothing else scales a grade mix by shifts', () => {
  // (a) No SQL projection function exists — the argument in the module header is that SQL
  //     would be a second implementation with no caller. Prove none was added.
  const sqlHits = execSync(
    "grep -rlniE 'fn_project_setup|project_setup|fn_setup_projection' supabase/ || true",
    { encoding: 'utf8' }
  ).trim()
  assert.equal(sqlHits, '', `a SQL projection appeared — second implementation: ${sqlHits}`)

  // (b) No other TS/TSX module does its own grade-mix math. Every consumer routes
  //     through this module.
  //
  //     This used to assert that NOTHING outside the module so much as mentions
  //     `grade_mix` — which was vacuously true only because the feature had no
  //     consumers yet. It cannot survive a real one: reading the library is a
  //     PostgREST `.select('code, label, grade_mix, …')` and writing it is an
  //     `.insert({ grade_mix })`, so the column name MUST appear at the edges. A
  //     guard that fires on the correct implementation is a guard that gets
  //     deleted, so it is replaced here by two checks of the actual invariant —
  //     strictly more than the one it replaces, not less.
  const mixFiles = execSync(
    "grep -rlE 'grade_mix' --include='*.ts' --include='*.tsx' app components lib workers scripts " +
      '| grep -v "lib/production/setup-projection.ts" ' +
      '| grep -v "scripts/verify-setup-projection.ts" ' +
      '| grep -v "types/supabase.ts" || true',
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(Boolean)

  // b1. ROUTED: every file that touches the column also imports this module, so the
  //     raw JSON is coerced by `parseGradeMix`/`toProductionSetup` and never by hand.
  const unrouted = mixFiles.filter(
    (f) =>
      execSync(`grep -cE "lib/production/setup-projection" '${f}' || true`, {
        encoding: 'utf8',
      }).trim() === '0'
  )
  assert.deepEqual(
    unrouted,
    [],
    `these touch grade_mix without importing the projection module — route them through it: ${unrouted.join(', ')}`
  )

  // b2. NO SECOND MATH: scaling a mix by a shift count is what this module owns.
  //     Nothing outside it may multiply by `shifts` at all.
  //
  //     Both halves of the alternation require a real OPERAND against the `*`
  //     (identifier / number / closing bracket), so a JSDoc `/** shifts > 0 …`
  //     is not mistaken for a multiplication — `perShift * shifts` still is.
  //
  //     TWO grep landmines this regex is written around, both of which make a
  //     check SILENTLY VACUOUS rather than noisy, so neither is self-announcing:
  //       • `execSync` runs under `/bin/sh` → the REAL BSD grep, not whatever the
  //         interactive shell aliases `grep` to. **BSD ERE has no `\b`.** A word
  //         boundary written that way never matches and the check quietly passes
  //         forever; the boundaries below are explicit character classes instead.
  //       • Inside a POSIX bracket expression a backslash is NOT an escape, so
  //         `[…)\]]` means "… ) or \" followed by a literal `]`. A literal `]` in
  //         a class must come FIRST — hence `[]A-Za-z0-9_)]`.
  //     `npx tsx scripts/verify-setup-projection.ts` after adding a probe line
  //     like `const bad = perShift * shifts` is the only way to know it still bites.
  const scalingHits = execSync(
    'grep -rnE \'[]A-Za-z0-9_)][[:space:]]*\\*[[:space:]]*shifts([^A-Za-z0-9_]|$)|(^|[^A-Za-z0-9_])shifts[[:space:]]*\\*[[:space:]]*[A-Za-z0-9_(]\' ' +
      "--include='*.ts' --include='*.tsx' app components lib workers scripts " +
      '| grep -v "lib/production/setup-projection.ts" ' +
      '| grep -v "scripts/verify-setup-projection.ts" || true',
    { encoding: 'utf8' }
  ).trim()
  assert.equal(
    scalingHits,
    '',
    `something outside the projection module scales by shifts — second implementation: ${scalingHits}`
  )
})

console.log(`\n${passed}/9 checks passed`)
