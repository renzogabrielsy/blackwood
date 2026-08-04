/**
 * verify-rc-deliveries-cells.ts — framework-free assertions over the RC Deliveries
 * SINGLE-COLUMN cells (app/(app)/cenapro/deliveries/types.ts). No DB, no browser.
 *
 * The sheet has ONE supplier column and ONE warehouse column; the database has three
 * fields behind the first and two behind the second. `formatSupplierCell` /
 * `parseSupplierCell` and `formatDestinationCell` / `parseDestinationCell` are the only
 * place that split is expressed, so they are the only place it can be wrong — and a
 * silent wrongness here re-points a cheque at the wrong trader.
 *
 * The last block REPLAYS the real sheet: every one of the 991 imported receipts is
 * rendered to its Excel cell text and parsed straight back, and the recovered fields
 * must equal the stored ones. That is the assertion that matters; the unit cases below
 * only cover shapes I thought of.
 *
 * Run: npx tsx scripts/verify-rc-deliveries-cells.ts
 */
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'

import {
  formatSupplierCell,
  parseSupplierCell,
  formatDestinationCell,
  parseDestinationCell,
  weightEditText,
  priceEditText,
  sampleFieldFor,
  buildColumns,
  frozenOffsets,
  minTableWidth,
} from '@/app/(app)/cenapro/deliveries/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
   
  console.log(`  ✓ ${name}`)
}

const SUPPLIERS = [
  'ALI UNGA', 'ANDRAQUE', 'BRIX', 'DENCIO', 'NEGROS', 'NOVAL',
  'OBENZA', 'PALAWAN', 'PULVERA', 'RAGMERD', 'SEVILLA', 'ZAPANTA',
]
const DESTINATIONS = [
  'W6 PROD', 'W7 PROD', 'DRYER',
  'WHSE A', 'WHSE B', 'WHSE C', 'WHSE D',
  'WHSE 3A', 'WHSE 3C', 'WHSE 5', 'WHSE 12', 'WHSE 13',
  'WHSE 14', 'WHSE 15', 'WHSE 16', 'WHSE 17',
]

function sup(text: string) {
  const r = parseSupplierCell(text, SUPPLIERS)
  assert.ok(!('error' in r), `expected "${text}" to resolve, got: ${'error' in r ? r.error : ''}`)
  return r as Exclude<typeof r, { error: string }>
}
function dest(text: string) {
  const r = parseDestinationCell(text, DESTINATIONS)
  assert.ok(!('error' in r), `expected "${text}" to resolve, got: ${'error' in r ? r.error : ''}`)
  return r as Exclude<typeof r, { error: string }>
}

// ── Supplier ──────────────────────────────────────────────────────────────────

check('a bare trader code resolves with no origin and no permit', () => {
  const s = sup('BRIX')
  assert.equal(s.supplier_code, 'BRIX')
  assert.equal(s.supplier_origin, null)
  assert.equal(s.permit_no, null)
})

check('trader − origin splits on the sheet’s hyphen, spaced or not', () => {
  for (const text of ['BRIX - SOUTH HILONGOS', 'BRIX- SOUTH HILONGOS', 'BRIX-SOUTH HILONGOS']) {
    const s = sup(text)
    assert.equal(s.supplier_code, 'BRIX')
    assert.equal(s.supplier_origin, 'SOUTH HILONGOS')
  }
})

check('a two-word trader code is matched whole, not split at its space', () => {
  const s = sup('ALI UNGA- ZMBNGA')
  assert.equal(s.supplier_code, 'ALI UNGA')
  assert.equal(s.supplier_origin, 'ZMBNGA')
})

check('a permit is peeled off the tail, with or without an origin', () => {
  const a = sup('PALAWAN PSAU 316759-8')
  assert.equal(a.supplier_code, 'PALAWAN')
  assert.equal(a.supplier_origin, null)
  assert.equal(a.permit_no, 'PSAU 316759-8')

  const b = sup("PALAWAN BROOKE'S PSAU 200691-6")
  assert.equal(b.supplier_code, 'PALAWAN')
  assert.equal(b.supplier_origin, "BROOKE'S")
  assert.equal(b.permit_no, 'PSAU 200691-6')
})

check('a non-PSAU permit prefix is still a permit', () => {
  assert.equal(sup('PALAWAN RANDY GAOU 236366-5').permit_no, 'GAOU 236366-5')
})

check('an origin containing digits and # is NOT mistaken for a permit', () => {
  const s = sup('SEVILLA SPECIAL #1 RED')
  assert.equal(s.supplier_code, 'SEVILLA')
  assert.equal(s.supplier_origin, 'SPECIAL #1 RED')
  assert.equal(s.permit_no, null)
})

check('an unknown trader is REFUSED, never written as an unresolved row', () => {
  const r = parseSupplierCell('HILONGOS - BRIX', SUPPLIERS)
  assert.ok('error' in r, 'a trader that is not in the dimension must error')
  assert.match((r as { error: string }).error, /not a known supplier/)
})

check('an empty supplier cell is a legal clear, not an error', () => {
  const r = parseSupplierCell('   ', SUPPLIERS)
  assert.ok(!('error' in r))
  assert.equal((r as { supplier_code: string }).supplier_code, '')
})

check('an unresolved imported row still SHOWS the operator’s original text', () => {
  assert.equal(
    formatSupplierCell({ supplier_code: null, supplier_raw: 'HILONGOS - BRIX' }),
    'HILONGOS - BRIX',
  )
})

// ── Destination ───────────────────────────────────────────────────────────────

check('a sideless yard resolves to a bare code', () => {
  const d = dest('W6 PROD')
  assert.equal(d.destination_code, 'W6 PROD')
  assert.equal(d.destination_side, null)
})

check('every side spelling in the workbook normalises to LFT / RT', () => {
  for (const [text, side] of [
    ['WHSE A- LFT', 'LFT'],
    ['WHSE A-LFT', 'LFT'],
    ['WHSE 3A LT', 'LFT'],
    ['WHSE B LEFT', 'LFT'],
    ['WHSE 3A RT', 'RT'],
    ['WHSE C- RT', 'RT'],
    ['WHSE B RIGHT', 'RT'],
  ] as const) {
    const d = dest(text)
    assert.equal(d.destination_side, side, text)
  }
})

check('a yard typed without its space still resolves', () => {
  assert.equal(dest('WHSEA- LFT').destination_code, 'WHSE A')
})

check('an unmapped yard is REFUSED', () => {
  for (const text of ['WHSE A/R#16', 'WHSEA/R#15', 'WHSE A/R 16-15']) {
    const r = parseDestinationCell(text, DESTINATIONS)
    assert.ok('error' in r, `${text} must error`)
  }
})

check('a code is never mistaken for a side (WHSE C is not WHSE + C)', () => {
  const d = dest('WHSE C')
  assert.equal(d.destination_code, 'WHSE C')
  assert.equal(d.destination_side, null)
})

// ── Column geometry ───────────────────────────────────────────────────────────

check('gating prices REMOVES two columns rather than blanking them', () => {
  const open = buildColumns(true)
  const gated = buildColumns(false)
  assert.equal(open.length - gated.length, 2)
  assert.ok(!gated.some((c) => c.key === 'php_kg' || c.key === 'ttl'))
  assert.ok(minTableWidth(gated) < minTableWidth(open))
})

check('the frozen block is exactly # · DATE · TRK# · SUPPLIER, offsets cumulative', () => {
  const cols = buildColumns(true)
  const left = frozenOffsets(cols)
  assert.equal(left.length, 4)
  assert.deepEqual(
    left,
    cols.slice(0, 4).map((_, i) => cols.slice(0, i).reduce((s, c) => s + c.width, 0)),
  )
})

check('a sample sub-row addresses only the label lane and the seven lab lanes', () => {
  const cols = buildColumns(true)
  const addressable = cols.filter((c) => sampleFieldFor(c.field) !== null).map((c) => c.key)
  assert.deepEqual(addressable, ['supplier', 'bd', 'moist', 'grit', 'ash', 'dust', 'vm', 'fc'])
  // The cells a draw does NOT have must be unreachable, or nav could rest on one.
  for (const key of ['date', 'truck', 'sacks', 'wt', 'whse', 'remarks', 'php_kg', 'ttl', 'num']) {
    const col = cols.find((c) => c.key === key)!
    assert.equal(sampleFieldFor(col.field), null, key)
  }
})

// ── Replay against the real sheet ─────────────────────────────────────────────
const EXTRACT =
  '/private/tmp/claude-501/-Users-renzosy-blackwood/' +
  '9a2b4683-9d53-4a27-8428-57b949741f1c/scratchpad/rc2026-extract.json'
const FALLBACK = 'scripts/cenapro/rc2026-extract.json'
const SOURCE = existsSync(EXTRACT) ? EXTRACT : existsSync(FALLBACK) ? FALLBACK : null

if (SOURCE) {
  interface Row {
    source_row: number
    supplier_code: string | null
    supplier_origin: string | null
    permit_no: string | null
    supplier_raw: string | null
    destination_code: string | null
    destination_side: string | null
    destination_raw: string | null
    weight_formula: string | null
    gross_weight_kg: number | null
    deduction_pct: number | null
    price_formula: string | null
    base_price_php_kg: number | null
    price_adjustment_php_kg: number | null
  }
  const parsed = JSON.parse(readFileSync(SOURCE, 'utf8'))
  const rows: Row[] = parsed.deliveries
  // The extract lists suppliers as bare strings and destinations as objects — take
  // whichever the file actually holds rather than assuming one shape.
  const codeOf = (v: unknown): string =>
    typeof v === 'string' ? v : ((v as { code?: string } | null)?.code ?? '')
  const supplierCodes: string[] = (parsed.suppliers ?? []).map(codeOf).filter(Boolean)
  const destCodes: string[] = (parsed.destinations ?? []).map(codeOf).filter(Boolean)
  const supList = supplierCodes.length > 0 ? supplierCodes : SUPPLIERS
  const destList = destCodes.length > 0 ? destCodes : DESTINATIONS

  check(`every resolved supplier round-trips format → parse (${rows.length} rows)`, () => {
    let checked = 0
    let withPermit = 0
    for (const r of rows) {
      if (!r.supplier_code) continue // an unresolved import is expected to refuse
      const cell = formatSupplierCell(r)
      const back = parseSupplierCell(cell, supList)
      assert.ok(!('error' in back), `row ${r.source_row}: "${cell}" → ${'error' in back ? back.error : ''}`)
      const b = back as Exclude<typeof back, { error: string }>
      assert.equal(b.supplier_code, r.supplier_code, `row ${r.source_row} code (${cell})`)
      assert.equal(b.supplier_origin, r.supplier_origin, `row ${r.source_row} origin (${cell})`)
      assert.equal(b.permit_no, r.permit_no, `row ${r.source_row} permit (${cell})`)
      if (r.permit_no) withPermit++
      checked++
    }
    assert.ok(checked > 900, `expected ~991 resolved rows, got ${checked}`)
     
    console.log(`      ${checked} receipts round-tripped, ${withPermit} carrying a PSAU permit`)
  })

  check('every resolved warehouse round-trips format → parse', () => {
    let checked = 0
    let withSide = 0
    for (const r of rows) {
      if (!r.destination_code) continue
      const cell = formatDestinationCell(r)
      const back = parseDestinationCell(cell, destList)
      assert.ok(!('error' in back), `row ${r.source_row}: "${cell}" → ${'error' in back ? back.error : ''}`)
      const b = back as Exclude<typeof back, { error: string }>
      assert.equal(b.destination_code, r.destination_code, `row ${r.source_row} code (${cell})`)
      assert.equal(b.destination_side, r.destination_side ?? null, `row ${r.source_row} side (${cell})`)
      if (r.destination_side) withSide++
      checked++
    }
     
    console.log(`      ${checked} destinations round-tripped, ${withSide} carrying a side`)
  })

  check('an IMPORTED row shows the same formula text a typed one would', () => {
    let rebuilt = 0
    for (const r of rows) {
      const wt = weightEditText(r)
      if (r.deduction_pct !== null && r.deduction_pct > 0) {
        assert.match(wt, /^=/, `row ${r.source_row} should read back as a formula, got "${wt}"`)
        rebuilt++
      } else if (r.gross_weight_kg !== null) {
        assert.equal(wt, String(r.gross_weight_kg), `row ${r.source_row} plain weight`)
      }

      const px = priceEditText(r)
      if (r.price_adjustment_php_kg !== null && r.price_adjustment_php_kg !== 0) {
        assert.match(px, /^=/, `row ${r.source_row} price should read back as a formula, got "${px}"`)
      }
    }
     
    console.log(`      ${rebuilt} imported rows present a rebuilt WT formula on focus`)
  })
} else {
   
  console.log('  · real-sheet replay SKIPPED (extract not found)')
}

 
console.log(`\n${passed} assertions passed.`)
