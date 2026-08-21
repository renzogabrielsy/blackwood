/**
 * verify-rc-in-grid.ts — framework-free assertions over the RC IN v2 grid's PURE save
 * model (`app/(app)/inventory/rc-in/rc-in-grid-v2-save.ts`). No DB, no browser.
 *
 * Built in the idiom of `scripts/verify-rc-deliveries-cells.ts`, for the sibling module.
 * It exists because the three things this grid can most easily get silently WRONG are not
 * observable from the screen:
 *
 *   1. **The lab panel.** `fn_bulk_update_deliveries` merges with `to_jsonb(d) || data`,
 *      a SHALLOW jsonb merge — so a partial `lab_results` object DELETES every key it
 *      does not mention. Six lab readings can vanish on a successful save with no error.
 *   2. **The whole-row payload.** `toDeliveryPayload` rebuilds a fixed object, so an
 *      untouched field that is missing from the payload is not "left alone" — it is
 *      cleared, nulled, or written as ₱0.
 *   3. **The price rule.** A price-blind viewer's rows carry no `cost_basis`, and the same
 *      `toDeliveryPayload` turns that into 0 — the L-008 unpriced placeholder — over a
 *      real delivered price.
 *
 * Run: npx tsx scripts/verify-rc-in-grid.ts
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DRAFT_PREFIX,
  LAB_DECIMALS,
  LAB_FIELDS,
  PRICE_BLIND_REFUSAL,
  RC_IN_EDIT_FIELDS,
  buildDeliveryInsert,
  cleanPastedRcInCell,
  draftLabel,
  buildDeliveryUpdate,
  isDraftKey,
  isLabField,
  isRcInEditField,
  labTextOf,
  labValueOf,
  makeDraftIds,
  normalizeRcInField,
  parseRcInField,
  phpTotalOf,
  rowLabel,
  saveFailureMessage,
  savedFieldText,
  storedFieldText,
  type PatchEnv,
} from '@/app/(app)/inventory/rc-in/rc-in-grid-v2-save'
import type { DeliveryHistoryRow } from '@/types/rc-in'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Executable code only. The save model's comments discuss the very identifiers the source
 * scans forbid — that is what the comments are FOR — so a scan over raw text would trip on
 * the prose explaining the rule. The `[^:]` guard keeps a `https://` inside a future string
 * from decapitating a line.
 *
 * Every caller must then assert that something it EXPECTS is still present: a stripper that
 * ate too much would make every "must not contain" pass vacuously, which is the failure
 * mode these scans exist to prevent.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++

  console.log(`  ✓ ${name}`)
}

const PRICED: PatchEnv = { canViewPrices: true, contextYear: 2026 }
const BLIND: PatchEnv = { canViewPrices: false, contextYear: 2026 }

/** A stored delivery with a FULL lab panel — the ordinary case. */
function row(over: Partial<DeliveryHistoryRow> = {}): DeliveryHistoryRow {
  return {
    id: 'd1',
    created_at: '2026-08-01T00:00:00Z',
    state: 'STORED',
    transaction_date: '2026-08-01',
    supplier: 'PAQUIBOT',
    batch_code: 'AUGUST-26-BLK1',
    block_loc: 'A-12B',
    truck_plate: 'MAV 9202',
    sacks: 471,
    weight_kg: 18827,
    cost_basis: 39.99,
    remarks: 'wet sacks pulled',
    lab_results: { mc: 12.5, ash: 3.2, bd_astm: 0.352, bd_jis: 0.341, grit: 1.1, vm: 14.8, fc: 80.9 },
    ...over,
  } as DeliveryHistoryRow
}

function okRow(built: ReturnType<typeof buildDeliveryUpdate>) {
  assert.deepEqual(built.errors, [], `expected no refusals, got: ${built.errors.join(' | ')}`)
  assert.ok(built.row, 'expected a payload')
  return built.row!
}


console.log('\nRC IN v2 grid — save model\n')

// ═══ Field vocabulary ═══════════════════════════════════════════════════════════

check('the editable field list is exactly the sixteen the bulk-input dialog sets', () => {
  assert.deepEqual([...RC_IN_EDIT_FIELDS].sort(), [
    'ash', 'batch_code', 'bd_astm', 'bd_jis', 'block_loc', 'cost_basis', 'fc', 'grit',
    'mc', 'remarks', 'sacks', 'supplier', 'transaction_date', 'truck_plate', 'vm', 'weight_kg',
  ])
  // The two derived lanes are NOT fields, here or ever.
  assert.equal(isRcInEditField('state'), false)
  assert.equal(isRcInEditField('php_total'), false)
  assert.equal(isRcInEditField('whse'), false)
})

check('lab precision is CLAUDE.md\'s — MC/Grit/VM/Ash/FC 2dp, BD ASTM/JIS 3dp', () => {
  assert.deepEqual([...LAB_FIELDS], ['mc', 'grit', 'vm', 'ash', 'fc', 'bd_astm', 'bd_jis'])
  for (const f of ['mc', 'grit', 'vm', 'ash', 'fc'] as const) assert.equal(LAB_DECIMALS[f], 2)
  for (const f of ['bd_astm', 'bd_jis'] as const) assert.equal(LAB_DECIMALS[f], 3)
  assert.equal(labTextOf(row(), 'mc'), '12.50')
  assert.equal(labTextOf(row(), 'bd_astm'), '0.352')
  assert.ok(isLabField('bd_jis'))
  assert.equal(isLabField('sacks'), false)
})

check('a draft id is a monotonic counter, never a collision', () => {
  const a = makeDraftIds(3)
  const b = makeDraftIds(3)
  assert.equal(new Set([...a, ...b]).size, 6, 'two batches of blank rows must never share an id')
  for (const id of a) assert.ok(isDraftKey(id) && id.startsWith(DRAFT_PREFIX))
  assert.equal(isDraftKey('d1'), false)
})

// ═══ Canonical cell text ════════════════════════════════════════════════════════

check('a lab panel that was never filled in reads BLANK, not 0.00', () => {
  // `lab_results` is TYPED as seven required numbers and is a JSONB blob at runtime.
  const partial = row({ lab_results: { mc: 12 } as never })
  assert.equal(labValueOf(partial, 'mc'), 12)
  assert.equal(labValueOf(partial, 'fc'), null, 'a missing key is UNMEASURED, not zero')
  assert.equal(labTextOf(partial, 'fc'), '')
  assert.equal(labValueOf(row({ lab_results: { mc: '' } as never }), 'mc'), null)
  assert.equal(labValueOf(row({ lab_results: null as never }), 'mc'), null)
})

check('the derived lanes carry text so Ctrl+Arrow does not read them as a gap', () => {
  assert.equal(storedFieldText(row(), 'state'), 'STORED')
  assert.equal(storedFieldText(row({ state: undefined }), 'state'), 'STORED')
  assert.equal(storedFieldText(row(), 'php_total'), String(18827 * 39.99))
  assert.equal(phpTotalOf(row({ cost_basis: undefined })), 0, 'a withheld price totals 0, never NaN')
  assert.equal(storedFieldText(null, 'supplier'), '', 'a blank row holds nothing')
})

check('BLOCK/LOC is DISPLAYED with the batch fallback and SAVED without it', () => {
  const r = row({ block_loc: '', batches: { location_ref: 'D-4C', status: 'STORED' } } as never)
  // What the sheet shows, and therefore what an edit must return to to be non-dirty.
  assert.equal(storedFieldText(r, 'block_loc'), 'D-4C')
  // What an UNTOUCHED field contributes to a whole-row payload. Reading the fallback back
  // would write a location the operator was only being SHOWN onto the delivery itself.
  assert.equal(savedFieldText(r, 'block_loc'), '')
  // Every other lane is the same answer in both.
  for (const f of ['supplier', 'batch_code', 'truck_plate', 'remarks', 'sacks', 'weight_kg', 'mc']) {
    assert.equal(savedFieldText(r, f), storedFieldText(r, f), `${f} must not diverge`)
  }
})

check('an untouched edit of an unlocated delivery does NOT fill in its LOC', () => {
  const r = row({ block_loc: '', batches: { location_ref: 'D-4C', status: 'STORED' } } as never)
  const built = okRow(buildDeliveryUpdate(r, { remarks: 'note' }, PRICED))
  assert.equal(built.block_loc, '', 'the displayed fallback must never become stored data')
})

// ═══ DATE — normalize, then judge ═══════════════════════════════════════════════

check('a typed shorthand date is canonicalised at commit, with the row\'s year', () => {
  assert.equal(normalizeRcInField('transaction_date', '8/21', PRICED), '2026-08-21')
  assert.equal(normalizeRcInField('transaction_date', '8/21', { ...PRICED, contextYear: 2025 }), '2025-08-21')
  assert.equal(normalizeRcInField('transaction_date', '8/21/24', PRICED), '2024-08-21')
  assert.equal(normalizeRcInField('transaction_date', '2026-08-21', PRICED), '2026-08-21')
  // Unreadable text is returned VERBATIM — never guessed at — and refused by name next.
  assert.equal(normalizeRcInField('transaction_date', 'yesterday', PRICED), 'yesterday')
  const v = parseRcInField('transaction_date', 'yesterday', PRICED)
  assert.equal(v.ok, false)
  assert.match((v as { error: string }).error, /not a date I can read/)
})

check('a typed date and the SAME text pasted land on the same day', () => {
  for (const text of ['8/21', '8/21/26', '2026-08-21', '08-21']) {
    assert.equal(
      cleanPastedRcInCell('transaction_date', text, PRICED),
      normalizeRcInField('transaction_date', text, PRICED),
      `"${text}" must not have two spellings`,
    )
  }
})

check('normalize may not refuse — it never blanks the operator\'s characters', () => {
  for (const field of RC_IN_EDIT_FIELDS) {
    assert.equal(normalizeRcInField(field, '   ', PRICED), '   ', `${field} must pass whitespace through`)
    const out = normalizeRcInField(field, 'qqq', PRICED)
    assert.equal(typeof out, 'string')
    assert.notEqual(out, '', `${field} must never erase text`)
  }
})

// ═══ BLOCK/LOC ═════════════════════════════════════════════════════════════════

check('BLOCK/LOC is uppercased at commit and judged by the SHARED validator', () => {
  assert.equal(normalizeRcInField('block_loc', 'a-12b', PRICED), 'A-12B')
  const good = parseRcInField('block_loc', 'a-12b', PRICED)
  assert.deepEqual(good, { ok: true, value: 'A-12B' })
  // The same predicate `actions.ts` runs, asked at the cell instead of after Save.
  const bad = parseRcInField('block_loc', 'Z-99Z', PRICED)
  assert.equal(bad.ok, false)
  assert.match((bad as { error: string }).error, /the LOC cell/)
  // PCA/PCB are three-character prefixes, not a single letter.
  assert.deepEqual(parseRcInField('block_loc', 'pca-15a', PRICED), { ok: true, value: 'PCA-15A' })
  // A cleared location is legal — a delivery may sit nowhere in particular.
  assert.deepEqual(parseRcInField('block_loc', '', PRICED), { ok: true, value: null })
})

// ═══ Numbers ═══════════════════════════════════════════════════════════════════

check('a numeric cell strips ₱ and commas, and refuses text by NAME', () => {
  assert.deepEqual(parseRcInField('weight_kg', '18,827', PRICED), { ok: true, value: 18827 })
  assert.deepEqual(parseRcInField('cost_basis', '₱39.99', PRICED), { ok: true, value: 39.99 })
  assert.deepEqual(parseRcInField('sacks', '470.6', PRICED), { ok: true, value: 471 }, 'sacks are counted, not measured')
  for (const [field, text, needle] of [
    ['weight_kg', '1O.2', /WEIGHT "1O.2" is not a weight/],
    ['sacks', 'many', /SKS "many" is not a sack count/],
    ['mc', '1O.2', /MC "1O.2" is not a number/],
    ['bd_astm', 'x', /BD ASTM "x" is not a number/],
    ['cost_basis', '-1', /PHP\/KG "-1" is not a price/],
  ] as const) {
    const v = parseRcInField(field, text, PRICED)
    assert.equal(v.ok, false, `${field} "${text}" should be refused`)
    assert.match((v as { error: string }).error, needle)
  }
})

// ═══ THE LAB PANEL — the shallow-merge trap ════════════════════════════════════

check('a PARTIAL lab edit sends the FULL panel, so the merge cannot delete the rest', () => {
  const built = okRow(buildDeliveryUpdate(row(), { mc: '13.75' }, PRICED))
  assert.deepEqual(built.lab_results, {
    mc: 13.75, ash: 3.2, bd_astm: 0.352, bd_jis: 0.341, grit: 1.1, vm: 14.8, fc: 80.9,
  }, 'every untouched reading must ride back or `to_jsonb(d) || data` deletes it')
})

check('a lab panel with a HOLE keeps its hole — a partial edit invents no readings', () => {
  const partial = row({ lab_results: { mc: 12, ash: 3 } as never })
  const built = okRow(buildDeliveryUpdate(partial, { ash: '4' }, PRICED))
  assert.deepEqual(built.lab_results, { mc: 12, ash: 4 } as never,
    'a never-measured lane must not become a fabricated 0.00 reading')
})

check('an edit that touches NO lab cell says nothing about the panel at all', () => {
  const r = row()
  const built = okRow(buildDeliveryUpdate(r, { remarks: 'note' }, PRICED))
  assert.equal(built.lab_results, r.lab_results, 'the stored object, by reference — identical bytes')

  // And a delivery whose panel is NULL keeps a null: `{}` would be a write, not a no-op,
  // and `undefined` is dropped by JSON.stringify so the merge leaves the column alone.
  const none = row({ lab_results: null as never })
  const built2 = okRow(buildDeliveryUpdate(none, { remarks: 'note' }, PRICED))
  assert.equal(built2.lab_results, undefined)
  assert.equal(JSON.stringify({ data: built2 }).includes('lab_results'), false)
})

check('CLEARING a lab cell deletes the key rather than storing 0', () => {
  const built = okRow(buildDeliveryUpdate(row(), { grit: '' }, PRICED))
  assert.equal('grit' in (built.lab_results as object), false,
    'a 0 in a lab lane is a READING; "we never measured it" is a different fact')
  assert.equal((built.lab_results as Record<string, number>).mc, 12.5)
})

check('a refused lab value refuses the ROW — it is never silently nulled', () => {
  const built = buildDeliveryUpdate(row(), { vm: '1O.2' }, PRICED)
  assert.equal(built.row, null, 'nothing may be written while a value is unreadable')
  assert.equal(built.errors.length, 1)
  assert.match(built.errors[0], /VM "1O.2" is not a number/)
})

// ═══ THE WHOLE-ROW PAYLOAD ═════════════════════════════════════════════════════

check('an untouched field rides back at its stored value, in every lane', () => {
  const r = row()
  const built = okRow(buildDeliveryUpdate(r, { supplier: 'BRIX' }, PRICED))
  assert.equal(built.supplier, 'BRIX')
  // Everything `toDeliveryPayload` rebuilds must be present and unchanged, or it is
  // cleared / nulled / written as ₱0 on the way to the database.
  assert.equal(built.transaction_date, '2026-08-01')
  assert.equal(built.batch_code, 'AUGUST-26-BLK1')
  assert.equal(built.block_loc, 'A-12B')
  assert.equal(built.truck_plate, 'MAV 9202')
  assert.equal(built.sacks, 471)
  assert.equal(built.weight_kg, 18827)
  assert.equal(built.cost_basis, 39.99)
  assert.equal(built.remarks, 'wet sacks pulled')
  // Every key `DeliveryRow` declares is present — a missing one is a silent clear.
  for (const k of ['transaction_date', 'supplier', 'batch_code', 'block_loc', 'truck_plate',
    'sacks', 'weight_kg', 'cost_basis', 'remarks', 'lab_results']) {
    assert.ok(k in built, `${k} must be in every payload`)
  }
})

check('the two fields a delivery cannot exist without are refused when CLEARED', () => {
  const noDate = buildDeliveryUpdate(row(), { transaction_date: '' }, PRICED)
  assert.equal(noDate.row, null)
  assert.match(noDate.errors[0], /needs a date/)

  const noBatch = buildDeliveryUpdate(row(), { batch_code: '  ' }, PRICED)
  assert.equal(noBatch.row, null)
  assert.match(noBatch.errors[0], /needs a batch code/)

  // But a cleared supplier / truck / remark is an ordinary clear.
  const cleared = okRow(buildDeliveryUpdate(row(), { supplier: '', truck_plate: '', remarks: '' }, PRICED))
  assert.equal(cleared.supplier, '')
  assert.equal(cleared.truck_plate, '')
  assert.equal(cleared.remarks, '')
})

check('every refusal in a row is reported, not just the first', () => {
  const built = buildDeliveryUpdate(row(), { weight_kg: 'x', sacks: 'y', mc: 'z' }, PRICED)
  assert.equal(built.row, null)
  assert.equal(built.errors.length, 3, 'an operator fixing one problem at a time is a bad afternoon')
})

// ═══ INSERTS ═══════════════════════════════════════════════════════════════════

check('a new delivery needs a batch code and a weight above 0 — the dialog\'s own rule', () => {
  const nothing = buildDeliveryInsert({ supplier: 'BRIX' }, '2026-08-21', PRICED)
  assert.equal(nothing.row, null)
  assert.equal(nothing.errors.length, 2)
  assert.match(nothing.errors.join(' '), /needs a batch code/)
  assert.match(nothing.errors.join(' '), /weight above 0/)

  const zero = buildDeliveryInsert({ batch_code: 'X', weight_kg: '0' }, '2026-08-21', PRICED)
  assert.equal(zero.row, null)
  assert.match(zero.errors.join(' '), /weight above 0/)
})

check('a new delivery takes the sheet\'s seeded date when the operator typed none', () => {
  const built = buildDeliveryInsert({ batch_code: 'AUG-26-FEED1', weight_kg: '12000' }, '2026-08-21', PRICED)
  assert.deepEqual(built.errors, [])
  assert.equal(built.row!.transaction_date, '2026-08-21')
  assert.equal(built.row!.state, 'STORED')
  // A typed shorthand still wins, and still normalises.
  const typed = buildDeliveryInsert(
    { batch_code: 'AUG-26-FEED1', weight_kg: '12000', transaction_date: '7/4' },
    '2026-08-21', PRICED,
  )
  assert.equal(typed.row!.transaction_date, '2026-07-04')
})

check('a NEW delivery gets the dialog\'s full seven-zero lab panel', () => {
  const built = buildDeliveryInsert({ batch_code: 'X', weight_kg: '1', mc: '11.5' }, '2026-08-21', PRICED)
  assert.deepEqual(built.row!.lab_results, {
    mc: 11.5, grit: 0, vm: 0, ash: 0, fc: 0, bd_astm: 0, bd_jis: 0,
  }, 'there is no stored panel to preserve, so shape parity with the dialog wins')
})

// ═══ THE PRICE RULE ════════════════════════════════════════════════════════════

check('a price-blind role cannot type into the PHP/KG cell', () => {
  const v = parseRcInField('cost_basis', '40', BLIND)
  assert.equal(v.ok, false)
  assert.match((v as { error: string }).error, /cannot edit price data/)
})

check('a price-blind role cannot build ANY payload — the whole door is shut', () => {
  // The reason is structural, not squeamish: `page.tsx` sends `cost_basis: undefined` to
  // such a viewer, and `toDeliveryPayload` turns that into 0 — the L-008 unpriced
  // placeholder — over a real delivered price, on every row they touched.
  const blindRow = row({ cost_basis: undefined })
  const upd = buildDeliveryUpdate(blindRow, { remarks: 'harmless note' }, BLIND)
  assert.equal(upd.row, null, 'a remark edit must not be able to zero the price')
  assert.deepEqual(upd.errors, [PRICE_BLIND_REFUSAL])

  const ins = buildDeliveryInsert({ batch_code: 'X', weight_kg: '1' }, '2026-08-21', BLIND)
  assert.equal(ins.row, null)
  assert.deepEqual(ins.errors, [PRICE_BLIND_REFUSAL])
})

check('no payload a price-blind role could produce contains a ₱ key — there is none', () => {
  // Exhaustive over every field: none of them yields a row at all.
  for (const field of RC_IN_EDIT_FIELDS) {
    const built = buildDeliveryUpdate(row(), { [field]: '1' }, BLIND)
    assert.equal(built.row, null, `${field} must not open a door for a price-blind role`)
  }
})

check('a PRICED role writes the real price back on an unrelated edit', () => {
  const built = okRow(buildDeliveryUpdate(row(), { remarks: 'note' }, PRICED))
  assert.equal(built.cost_basis, 39.99, 'the stored price must survive a save that never mentioned it')
})

// ═══ Naming things ═════════════════════════════════════════════════════════════

check('a refusal names the row well enough to find it in the sheet', () => {
  assert.equal(rowLabel(row()), '2026-08-01 · PAQUIBOT · AUGUST-26-BLK1 · MAV 9202')
  assert.equal(
    rowLabel(row({ transaction_date: '', supplier: '', batch_code: '', truck_plate: '' })),
    'undated · unknown supplier',
  )
  assert.equal(
    draftLabel({ supplier: 'BRIX', batch_code: 'AUG-26-BLK2' }, '2026-08-21'),
    'new row 2026-08-21 · BRIX · AUG-26-BLK2',
  )
  assert.equal(draftLabel({}, '2026-08-21'), 'new row 2026-08-21 · no supplier')
})

check('a batch refusal says NOTHING WAS WRITTEN, because nothing was', () => {
  // `fn_bulk_update_deliveries` is transactional and the action returns one verdict for
  // the whole batch — there is no partial-success state, so none is rendered.
  const m = saveFailureMessage('update', 3, 'Row 2: Location A-1A is occupied by batch JULY-26-BLK9')
  assert.match(m, /3 edited deliveries/)
  assert.match(m, /rolled back/)
  assert.match(m, /nothing was written/)
  assert.match(m, /Location A-1A is occupied/, 'the database\'s own words must survive')
  assert.match(saveFailureMessage('insert', 1, null), /1 new delivery/)
  assert.equal(saveFailureMessage('insert', 1, '   ').includes('\n'), false, 'a blank detail adds no dangling gap')
})

// ═══ Source scans — the rules that live in files this module may not edit ═══════

check('actions.ts still rebuilds a FIXED payload, which is why a patch cannot be partial', () => {
  const src = stripComments(readFileSync(join(ROOT, 'app/(app)/inventory/rc-in/actions.ts'), 'utf8'))
  assert.ok(src.includes('function toDeliveryPayload'), 'the scan target must still exist')
  // These four lines ARE the reason `buildDeliveryUpdate` sends a whole row. If any of
  // them changes, this file's central decision needs revisiting.
  assert.match(src, /weight_kg:\s*Number\(row\.weight_kg\)/)
  assert.match(src, /sacks:\s*Number\(row\.sacks\)/)
  assert.match(src, /cost_basis:[\s\S]*?\?\s*0\s*:\s*Number\(row\.cost_basis\)/)
  assert.match(src, /block_loc:\s*row\.block_loc\s*\?/)
  // And no derived warehouse is ever part of the payload — `calculateWhse` is display-only.
  assert.equal(/whse/i.test(src.slice(src.indexOf('function toDeliveryPayload'), src.indexOf('export async function submitBulkDeliveries'))), false)
})

check('the RPC merge is still SHALLOW, which is why the lab panel is sent whole', () => {
  const sql = readFileSync(
    join(ROOT, 'supabase/migrations/20260703022707_fn_bulk_update_transactional.sql'), 'utf8')
  assert.ok(sql.includes('fn_bulk_update_deliveries'), 'the scan target must still exist')
  assert.match(sql, /to_jsonb\(d\)\s*\|\|\s*v_data/,
    'a `||` on jsonb replaces a nested object wholesale — a partial lab panel would delete the rest')
})

check('the grid declares no second definition of the price boundary', () => {
  const src = stripComments(
    readFileSync(join(ROOT, 'app/(app)/inventory/rc-in/delivery-grid-v2.tsx'), 'utf8'))
  assert.ok(src.includes('canViewPrices'), 'the scan target must still exist')
  // The SERVER decides. A grid that re-derived the role would ignore the impersonation
  // cookie, which is the exact bug `canViewPrices()` exists to prevent.
  assert.equal(src.includes('hasPermission'), false, 'the price gate is a prop, never re-derived here')
  assert.equal(src.includes('useAuth'), false)
  assert.equal(src.includes('roleCanViewPrices'), false)
  // The edit gate IS the price gate — see the header note.
  assert.match(src, /canEdit:\s*canViewPrices/)
})

check('every error surface in the grid is the persistent, copyable one', () => {
  const src = stripComments(
    readFileSync(join(ROOT, 'app/(app)/inventory/rc-in/delivery-grid-v2.tsx'), 'utf8'))
  assert.ok(src.includes('errorToast('), 'the scan target must still exist')
  // HARD RULE: errors persist until dismissed and carry a Copy button.
  assert.equal(/\btoast\.error\s*\(/.test(src), false, 'sonner toast.error is forbidden — use errorToast')
})


console.log(`\n${passed} assertions passed.`)
