/**
 * verify-rc-formula.ts — framework-free assertions over the RC Deliveries formula cell
 * (lib/cenapro/rc-formula.ts). No DB, no browser — just the parser and the two
 * business decompositions.
 *
 * The last block REPLAYS the real sheet: if the RC 2026 extract is present it re-derives
 * gross/deduction/net and base/adjustment/price for all 991 rows straight from the
 * operator-typed formula text, and asserts the result matches the workbook's own
 * computed values. That is the assertion that actually matters — the unit cases only
 * cover shapes I thought of.
 *
 * Run: npx tsx scripts/verify-rc-formula.ts
 */
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'

import {
  evaluateFormula,
  isFormula,
  parseWeightInput,
  parsePriceInput,
  roundTo,
  formulaCellText,
  weightFormulaFrom,
  priceFormulaFrom,
  type WeightParts,
  type PriceParts,
} from '@/lib/cenapro/rc-formula'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** Narrowing helpers — the parsers return a union with an `error` branch. */
function weight(input: string): WeightParts {
  const r = parseWeightInput(input)
  assert.ok(!('error' in r), `expected ${input} to parse, got ${JSON.stringify(r)}`)
  return r as WeightParts
}
function price(input: string): PriceParts {
  const r = parsePriceInput(input)
  assert.ok(!('error' in r), `expected ${input} to parse, got ${JSON.stringify(r)}`)
  return r as PriceParts
}

// ── rounding ──────────────────────────────────────────────────────────────────
check('roundTo kills the float artefact that breaks the naive version', () => {
  // A real sheet row (ALI UNGA, `=22745*93%`) lands on the artefact.
  assert.equal(22745 * 0.93, 21152.850000000002)
  assert.equal(roundTo(22745 * 0.93, 3), 21152.85)

  // The naive form is wrong on exact halves; re-parsing the shifted decimal STRING is
  // what fixes it, because `Number('1.005e2')` is 100.5 while `1.005 * 100` is
  // 100.49999999999999.
  assert.equal(Math.round(1.005 * 100) / 100, 1)
  assert.equal(roundTo(1.005, 2), 1.01)
  assert.equal(roundTo(-1.005, 2), -1.01) // half away from zero, both directions
  assert.equal(roundTo(8.165, 2), 8.17)
  assert.equal(roundTo(0.1 + 0.2, 2), 0.3)
  assert.equal(roundTo(0, 3), 0)
})

// ── arithmetic ────────────────────────────────────────────────────────────────
check('evaluates the two shapes the sheet actually uses', () => {
  assert.deepEqual(evaluateFormula('=27045*88%'), { ok: true, value: 23799.6 })
  assert.deepEqual(evaluateFormula('=39.5+2.7', 4), { ok: true, value: 42.2 })
})

check('accepts a bare expression and a plain number (leading = is optional)', () => {
  assert.deepEqual(evaluateFormula('27045*88%'), { ok: true, value: 23799.6 })
  assert.deepEqual(evaluateFormula('21865'), { ok: true, value: 21865 })
  assert.equal(isFormula('=1+1'), true)
  assert.equal(isFormula('21865'), false)
})

check('honours precedence, parentheses and unary minus', () => {
  assert.deepEqual(evaluateFormula('=2+3*4'), { ok: true, value: 14 })
  assert.deepEqual(evaluateFormula('=(2+3)*4'), { ok: true, value: 20 })
  assert.deepEqual(evaluateFormula('=-5+2'), { ok: true, value: -3 })
  assert.deepEqual(evaluateFormula('=10/4'), { ok: true, value: 2.5 })
})

check('% is Excel postfix divide-by-100, and it stacks', () => {
  assert.deepEqual(evaluateFormula('=50%'), { ok: true, value: 0.5 })
  assert.deepEqual(evaluateFormula('=100-(100*2%)'), { ok: true, value: 98 })
  assert.deepEqual(evaluateFormula('=50%%'), { ok: true, value: 0.005 })
})

check('whitespace and thousands commas are tolerated', () => {
  assert.deepEqual(evaluateFormula('= 27045 * 88 %'), { ok: true, value: 23799.6 })
  assert.deepEqual(evaluateFormula('=1,000+1'), { ok: true, value: 1001 })
})

// ── rejection: this parses operator text that is rendered back into the page ───
check('rejects anything that is not arithmetic — no eval, no identifiers', () => {
  for (const bad of [
    '=alert(1)',
    '=window.location',
    '=__proto__',
    '=constructor',
    '=1;2',
    '=fetch("/x")',
    '=`x`',
    '=SUM(A1:A2)',
    '=A1*2',
  ]) {
    const r = evaluateFormula(bad)
    assert.equal(r.ok, false, `${bad} must be rejected`)
  }
})

check('rejects malformed arithmetic with a readable reason', () => {
  const cases: [string, RegExp][] = [
    ['=', /empty/],
    ['=1+', /ends early/],
    ['=(1+2', /never closed/],
    ['=1)', /unexpected/],
    ['=1..2', /two decimal points/],
    ['=1/0', /division by zero/],
    ['=1 2', /unexpected number/],
  ]
  for (const [bad, pattern] of cases) {
    const r = evaluateFormula(bad)
    assert.equal(r.ok, false, `${bad} must be rejected`)
    assert.match((r as { error: string }).error, pattern, `${bad} -> ${JSON.stringify(r)}`)
  }
})

// ── weight decomposition ──────────────────────────────────────────────────────
check('the keep-rate shape yields gross, deduction and net', () => {
  const w = weight('=27045*88%')
  assert.equal(w.grossKg, 27045)
  assert.equal(w.deductionPct, 12) // 88% kept -> 12% removed
  assert.equal(w.netKg, 23799.6)
  assert.equal(w.formula, '=27045*88%')
})

check('the longhand subtraction shape yields the same parts', () => {
  const w = weight('=25465-(25465*2%)')
  assert.equal(w.grossKg, 25465)
  assert.equal(w.deductionPct, 2)
  assert.equal(w.netKg, 24955.7)
})

check('a plain weight has no deduction and gross === net', () => {
  const w = weight('21865')
  assert.equal(w.grossKg, 21865)
  assert.equal(w.deductionPct, null)
  assert.equal(w.netKg, 21865)
  assert.equal(w.formula, null, 'a typed number is not a formula')
})

check('arbitrary arithmetic is honoured as a value but never invents a deduction', () => {
  // `27045*0.88` is numerically identical to `*88%` but expresses no rate, so claiming
  // a 12% deduction from it would put a fabricated number in front of a cheque.
  const w = weight('=27045*0.88')
  assert.equal(w.netKg, 23799.6)
  assert.equal(w.deductionPct, null)
  assert.equal(w.grossKg, 23799.6, 'gross collapses to net when no rate was expressed')
})

check('a nonsense keep-rate is not treated as a deduction', () => {
  const w = weight('=100*150%') // >100% is not a haircut
  assert.equal(w.deductionPct, null)
  assert.equal(w.netKg, 150)
})

check('an empty weight cell is empty, not zero', () => {
  const w = weight('   ')
  assert.deepEqual(w, { grossKg: null, deductionPct: null, netKg: null, formula: null })
})

check('a broken weight formula reports an error instead of a silent zero', () => {
  assert.ok('error' in parseWeightInput('=27045*'))
  assert.ok('error' in parseWeightInput('=abc'))
})

// ── price decomposition ───────────────────────────────────────────────────────
check('base + adjustment splits, and a flat price does not', () => {
  const p = price('=39.5+2.7')
  assert.equal(p.basePhpKg, 39.5)
  assert.equal(p.adjustmentPhpKg, 2.7)
  assert.equal(p.effectivePhpKg, 42.2)

  const flat = price('43.5')
  assert.equal(flat.basePhpKg, 43.5)
  assert.equal(flat.adjustmentPhpKg, null)
  assert.equal(flat.effectivePhpKg, 43.5)
  assert.equal(flat.formula, null)
})

check('price keeps 4 decimals so the total is not rounded early', () => {
  const p = price('=38.5+2.61')
  assert.equal(p.effectivePhpKg, 41.11)
})

// ── round-tripping the cell ───────────────────────────────────────────────────
check('the cell shows the formula back on focus, else the number', () => {
  assert.equal(formulaCellText('=27045*88%', 23799.6), '=27045*88%')
  assert.equal(formulaCellText(null, 21865), '21865')
  assert.equal(formulaCellText(null, null), '')
})

check('imported rows rebuild a formula indistinguishable from a typed one', () => {
  assert.equal(weightFormulaFrom(27045, 12), '=27045*88%')
  assert.equal(weightFormulaFrom(21865, null), null)
  assert.equal(weightFormulaFrom(21865, 0), null)
  assert.equal(priceFormulaFrom(39.5, 2.7), '=39.5+2.7')
  assert.equal(priceFormulaFrom(43.5, null), null)

  // The rebuilt text must re-parse to the parts it came from.
  const rebuilt = weightFormulaFrom(27045, 12)!
  const w = weight(rebuilt)
  assert.equal(w.grossKg, 27045)
  assert.equal(w.deductionPct, 12)
  assert.equal(w.netKg, 23799.6)
})

// ── replay against the real sheet ─────────────────────────────────────────────
const EXTRACT =
  '/private/tmp/claude-501/-Users-renzosy-blackwood/' +
  '9a2b4683-9d53-4a27-8428-57b949741f1c/scratchpad/rc2026-extract.json'

if (existsSync(EXTRACT)) {
  interface Row {
    source_row: number
    weight_formula: string | null
    gross_weight_kg: number | null
    deduction_pct: number | null
    net_weight_kg: number | null
    price_formula: string | null
    base_price_php_kg: number | null
    price_adjustment_php_kg: number | null
    price_php_kg: number | null
    sheet_total_php: number | null
  }
  const rows: Row[] = JSON.parse(readFileSync(EXTRACT, 'utf8')).deliveries

  check(`replays every WT formula in the real sheet (${rows.length} rows)`, () => {
    let withDeduction = 0
    for (const r of rows) {
      if (!r.weight_formula) continue
      const w = weight(r.weight_formula)
      assert.equal(w.netKg, r.net_weight_kg, `row ${r.source_row} net`)
      assert.equal(w.grossKg, r.gross_weight_kg, `row ${r.source_row} gross`)
      assert.equal(w.deductionPct, r.deduction_pct, `row ${r.source_row} deduction`)
      if (w.deductionPct !== null) withDeduction++
    }
    assert.equal(withDeduction, 142, 'the sheet has 142 deducted rows')
  })

  check('replays every PHP/KG formula in the real sheet', () => {
    let withAdjustment = 0
    for (const r of rows) {
      if (!r.price_formula) continue
      const p = price(r.price_formula)
      assert.equal(p.effectivePhpKg, r.price_php_kg, `row ${r.source_row} price`)
      assert.equal(p.basePhpKg, r.base_price_php_kg, `row ${r.source_row} base`)
      assert.equal(p.adjustmentPhpKg, r.price_adjustment_php_kg, `row ${r.source_row} adj`)
      if (p.adjustmentPhpKg !== null) withAdjustment++
    }
    assert.equal(withAdjustment, 12, 'the sheet has 12 price-adjusted rows')
  })

  check('net x price reproduces the workbook TTL PRICE on every priced row', () => {
    let compared = 0
    for (const r of rows) {
      if (r.net_weight_kg == null || r.price_php_kg == null || r.sheet_total_php == null) continue
      const total = roundTo(r.net_weight_kg * r.price_php_kg, 2)
      assert.ok(
        Math.abs(total - r.sheet_total_php) <= 0.05,
        `row ${r.source_row}: computed ${total} vs sheet ${r.sheet_total_php}`,
      )
      compared++
    }
    assert.ok(compared > 950, `expected to compare most rows, compared ${compared}`)
    console.log(`      ${compared} priced rows reconciled against the workbook`)
  })
} else {
  console.log('  · real-sheet replay skipped (extract not present)')
}

console.log(`\n${passed} assertions passed.\n`)
