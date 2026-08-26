/**
 * verify-electricity-trucks-grid.ts — framework-free assertions over the PURE save models
 * behind the two production v2 sheets:
 *
 *   • `app/(app)/production/electricity/electricity-grid-v2-save.ts`
 *   • `app/(app)/production/trucks/trucks-grid-v2-save.ts`
 *
 * No DB, no browser. Built in the idiom of `scripts/verify-rc-in-grid.ts` and
 * `scripts/verify-qc-grid.ts`, and ONE script for both because the two sheets share every
 * rule that matters and differ only in shape — a rule asserted twice in two files is a
 * rule that can be fixed in one of them.
 *
 * It exists because the four things these sheets can most easily get silently WRONG are
 * not observable from the screen:
 *
 *   1. **The whole-row payload.** Both save paths hand `data` to `supabase.update()`, so
 *      an untouched field that is missing is genuinely untouched — but both actions guard
 *      their cross-field rule with `if (a !== undefined && b !== undefined)`, so a partial
 *      patch SKIPS the readable check and lands on a DB constraint instead, mid-batch.
 *   2. **A typed `meter_multiplier` of 0.** The column's CHECK is `> 0`, STRICTLY — and
 *      the live grid's `parseFloat(x) || 120` stores **120** instead, a different number
 *      from the one the operator typed, with nothing said. The v2 model refuses it by
 *      name; only a BLANK falls back to 120.
 *   3. **The natural key.** `(reading_date, meter)` and `(reading_date, plate_no)` are
 *      UNIQUE, and neither action is transactional — so a collision that reaches the
 *      database arrives half way through a batch that is already partly written.
 *   4. **A DATE edit on the trucks sheet.** One rendered row is N database rows, so
 *      moving a day has to re-file every reading on it — the live grid saves NOTHING at
 *      all in that case and leaves the row dirty forever.
 *
 * Run: npx tsx scripts/verify-electricity-trucks-grid.ts
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MULTIPLIER,
  DRAFT_METER,
  DRAFT_MULTIPLIER,
  DRAFT_PREFIX as ELEC_DRAFT_PREFIX,
  ELECTRICITY_EDIT_FIELDS,
  buildElectricityInsert,
  buildElectricitySavePlan,
  buildElectricityUpdate,
  cleanPastedElectricityCell,
  consumptionOf,
  diffKwhOf,
  draftLabel as elecDraftLabel,
  draftSeedText,
  isDraftKey as isElecDraftKey,
  isElectricityEditField,
  makeDraftIds as makeElecDraftIds,
  naturalKey as elecNaturalKey,
  normalizeElectricityField,
  parseElectricityField,
  rowLabel as elecRowLabel,
  saveFailureMessage as elecSaveFailureMessage,
  saveSuccessMessage as elecSaveSuccessMessage,
  storedFieldText as elecStoredFieldText,
  type ElectricityEnv,
  type ElectricityReadingRow,
} from '@/app/(app)/production/electricity/electricity-grid-v2-save'

import {
  DATE_KEY,
  DRAFT_PREFIX as TRUCK_DRAFT_PREFIX,
  KNOWN_PLATES,
  TRUCK_METRICS,
  buildDayRows,
  buildTrucksSavePlan,
  cleanPastedTruckCell,
  colKeyOf,
  derivePlates,
  isDraftKey as isTruckDraftKey,
  isTruckEditField,
  makeDraftIds as makeTruckDraftIds,
  normalizeTruckField,
  parseColKey,
  parseTruckField,
  saveFailureMessage as truckSaveFailureMessage,
  storedFieldText as truckStoredFieldText,
  ttlKmOf,
  type DayRow,
  type TruckReadingRow,
  type TrucksEnv,
} from '@/app/(app)/production/trucks/trucks-grid-v2-save'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Executable code only. These modules' comments discuss the very identifiers the source
 * scans forbid — that is what the comments are FOR — so a scan over raw text would trip on
 * the prose explaining the rule. The `[^:]` guard keeps a `https://` inside a future string
 * from decapitating a line.
 *
 * Every caller must then assert that something it EXPECTS is still present: a stripper
 * that ate too much would make every "must not contain" pass vacuously, which is the
 * failure mode these scans exist to prevent.
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

const ELEC_ENV: ElectricityEnv = { contextYear: 2026 }
const TRUCK_ENV: TrucksEnv = { contextYear: 2026 }

// ═══════════════════════════════════════════════════════════════════════════════════
// ELECTRICITY
// ═══════════════════════════════════════════════════════════════════════════════════

/** A stored reading — the ordinary case. */
function reading(over: Partial<ElectricityReadingRow> = {}): ElectricityReadingRow {
  return {
    id: 'e1',
    created_at: '2026-08-01T00:00:00Z',
    reading_date: '2026-08-01',
    meter: 'MAIN',
    start_kwh: 1000,
    end_kwh: 1120,
    meter_multiplier: 120,
    consumption_kwh: 14400,
    diff_kwh: 120,
    human_edited_at: null,
    human_edited_by: null,
    remarks: 'genset down 2h',
    ...over,
  } as ElectricityReadingRow
}

function okElec(built: ReturnType<typeof buildElectricityUpdate>) {
  assert.deepEqual(built.errors, [], `expected no refusals, got: ${built.errors.join(' | ')}`)
  assert.ok(built.row, 'expected a payload')
  return built.row!
}

console.log('\nElectricity v2 grid — save model\n')

check('the editable field list is exactly the six the live grid sets', () => {
  assert.deepEqual([...ELECTRICITY_EDIT_FIELDS].sort(), [
    'end_kwh', 'meter', 'meter_multiplier', 'reading_date', 'remarks', 'start_kwh',
  ])
  // The derived lanes are NOT fields, here or ever.
  assert.equal(isElectricityEditField('diff'), false)
  assert.equal(isElectricityEditField('consumption'), false)
  assert.equal(isElectricityEditField('num'), false)
  // Neither are the two columns the DATABASE owns.
  assert.equal(isElectricityEditField('diff_kwh'), false)
  assert.equal(isElectricityEditField('consumption_kwh'), false)
})

check('draft ids are unique, monotonic and self-identifying', () => {
  const ids = makeElecDraftIds(3)
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3)
  for (const id of ids) {
    assert.ok(id.startsWith(ELEC_DRAFT_PREFIX))
    assert.equal(isElecDraftKey(id), true)
  }
  // A stored reading's uuid must never read as a draft.
  assert.equal(isElecDraftKey('7c9e6679-7425-40de-944b-e07fc1f90ae7'), false)
  // And the two sheets' drafts can never be confused for one another.
  assert.equal(isTruckDraftKey(ids[0]), false)
})

check('a blank row is seeded exactly like the live grid’s trailing input row', () => {
  assert.equal(draftSeedText('reading_date', '2026-08-26'), '2026-08-26')
  assert.equal(draftSeedText('meter', '2026-08-26'), DRAFT_METER)
  assert.equal(draftSeedText('meter_multiplier', '2026-08-26'), DRAFT_MULTIPLIER)
  assert.equal(DRAFT_METER, 'MAIN')
  assert.equal(DRAFT_MULTIPLIER, '120')
  // Everything else starts empty — a seeded value nobody typed must not reach the ledger.
  assert.equal(draftSeedText('start_kwh', '2026-08-26'), '')
  assert.equal(draftSeedText('end_kwh', '2026-08-26'), '')
  assert.equal(draftSeedText('remarks', '2026-08-26'), '')
})

check('the derivations are the live grid’s inline formulas', () => {
  assert.equal(diffKwhOf('1000', '1120'), 120)
  assert.equal(consumptionOf('1000', '1120', '120'), 14400)
  // A blank reads as 0, exactly as `parseFloat(x) || 0` does next door.
  assert.equal(diffKwhOf('', '120'), 120)
  // A backwards meter contributes NO consumption — never a negative one.
  assert.equal(diffKwhOf('1120', '1000'), -120)
  assert.equal(consumptionOf('1120', '1000', '120'), 0)
})

check('stored cell text answers for every lane, derived ones included', () => {
  const r = reading()
  assert.equal(elecStoredFieldText(r, 'reading_date'), '2026-08-01')
  assert.equal(elecStoredFieldText(r, 'meter'), 'MAIN')
  assert.equal(elecStoredFieldText(r, 'start_kwh'), '1000')
  assert.equal(elecStoredFieldText(r, 'end_kwh'), '1120')
  assert.equal(elecStoredFieldText(r, 'meter_multiplier'), '120')
  assert.equal(elecStoredFieldText(r, 'remarks'), 'genset down 2h')
  // A read-only lane still HOLDS a value — '' would make a run of computed figures read
  // as a blank gap to Ctrl+Arrow.
  assert.equal(elecStoredFieldText(r, 'diff'), '120.00')
  assert.equal(elecStoredFieldText(r, 'consumption'), '14400.00')
  // A draft has no stored row at all.
  assert.equal(elecStoredFieldText(null, 'start_kwh'), '')
})

check('a typed shorthand DATE is canonicalised at commit, in the row’s own year', () => {
  assert.equal(normalizeElectricityField('reading_date', '8/21', { contextYear: 2025 }), '2025-08-21')
  assert.equal(normalizeElectricityField('reading_date', '8/21/26', ELEC_ENV), '2026-08-21')
  assert.equal(normalizeElectricityField('reading_date', '2026-08-21', ELEC_ENV), '2026-08-21')
  // Unreadable text is KEPT VERBATIM here and REFUSED BY NAME by the parse below.
  assert.equal(normalizeElectricityField('reading_date', 'yesterday', ELEC_ENV), 'yesterday')
})

check('the METER lane is NOT case-folded — that would silently rename a meter', () => {
  // `meter` is half of the natural key. Folding it would turn an operator retyping a
  // stored mixed-case name into an edit that renames the meter and moves the row.
  assert.equal(normalizeElectricityField('meter', 'Pump', ELEC_ENV), 'Pump')
  assert.equal(normalizeElectricityField('meter', ' bunkhouse ', ELEC_ENV), ' bunkhouse ')
})

check('one cell, one verdict — the numeric lanes', () => {
  assert.deepEqual(parseElectricityField('start_kwh', '1,234', ELEC_ENV), { ok: true, value: 1234 })
  assert.deepEqual(parseElectricityField('end_kwh', ' 1240.5 ', ELEC_ENV), { ok: true, value: 1240.5 })
  assert.deepEqual(parseElectricityField('meter_multiplier', '40', ELEC_ENV), { ok: true, value: 40 })
  const bad = parseElectricityField('start_kwh', '1O24', ELEC_ENV)
  assert.equal(bad.ok, false)
  assert.match((bad as { error: string }).error, /START KWH/)
  const negative = parseElectricityField('end_kwh', '-5', ELEC_ENV)
  assert.equal(negative.ok, false)
  const negMult = parseElectricityField('meter_multiplier', '-1', ELEC_ENV)
  assert.equal(negMult.ok, false)
})

check('a BLANK cell commits without complaint and means CLEARED', () => {
  // Refusing here would raise a persistent toast the moment you clear a cell you are
  // about to retype. The row builder decides what a cleared cell becomes.
  for (const field of ELECTRICITY_EDIT_FIELDS) {
    assert.deepEqual(parseElectricityField(field, '', ELEC_ENV), { ok: true, value: null }, field)
  }
})

check('an unreadable DATE is refused BY NAME, with the shapes that would work', () => {
  const verdict = parseElectricityField('reading_date', 'yesterday', ELEC_ENV)
  assert.equal(verdict.ok, false)
  assert.match((verdict as { error: string }).error, /DATE/)
  assert.match((verdict as { error: string }).error, /2026-08-21/)
})

check('a pasted cell is cleaned the SAME way a typed one is', () => {
  assert.equal(cleanPastedElectricityCell('reading_date', '8/21', ELEC_ENV), '2026-08-21')
  assert.equal(cleanPastedElectricityCell('start_kwh', '"1,234"', ELEC_ENV), '1234')
  assert.equal(cleanPastedElectricityCell('meter', ' MAIN ', ELEC_ENV), 'MAIN')
  assert.equal(cleanPastedElectricityCell('remarks', '  genset down  ', ELEC_ENV), 'genset down')
})

check('an update is a WHOLE row of exactly six keys, stored value unless typed over', () => {
  const row = okElec(buildElectricityUpdate(reading(), { end_kwh: '1200' }, ELEC_ENV))
  assert.deepEqual(Object.keys(row).sort(), [
    'end_kwh', 'meter', 'meter_multiplier', 'reading_date', 'remarks', 'start_kwh',
  ])
  assert.equal(row.end_kwh, 1200)
  // Untouched lanes ride back unchanged — the action's END ≥ START guard only engages
  // when BOTH halves are present.
  assert.equal(row.start_kwh, 1000)
  assert.equal(row.reading_date, '2026-08-01')
  assert.equal(row.meter, 'MAIN')
  assert.equal(row.remarks, 'genset down 2h')
})

check('the payload can never carry a generated column or a latch stamp', () => {
  const row = okElec(buildElectricityUpdate(reading(), { remarks: 'x' }, ELEC_ENV))
  for (const forbidden of ['diff_kwh', 'consumption_kwh', 'id', 'created_at', 'human_edited_at', 'human_edited_by']) {
    assert.equal(forbidden in row, false, `payload must not carry ${forbidden}`)
  }
})

check('a typed 0 multiplier is refused BY NAME, never silently rewritten to 120', () => {
  // `electricity_readings_meter_multiplier_check` is `> 0` — STRICTLY. The live grid's
  // `parseFloat(x) || 120` stores 120 instead, which is a different number from the one
  // the operator typed and nobody is told.
  const verdict = parseElectricityField('meter_multiplier', '0', ELEC_ENV)
  assert.equal(verdict.ok, false)
  assert.match((verdict as { error: string }).error, /above 0/)
  const built = buildElectricityUpdate(reading(), { meter_multiplier: '0' }, ELEC_ENV)
  assert.equal(built.row, null)
  assert.equal(built.errors.length, 1)
})

check('a CLEARED multiplier falls back to the live default; a cleared kWh saves 0', () => {
  const row = okElec(buildElectricityUpdate(reading(), { meter_multiplier: '', start_kwh: '' }, ELEC_ENV))
  assert.equal(row.meter_multiplier, DEFAULT_MULTIPLIER)
  assert.equal(DEFAULT_MULTIPLIER, 120)
  assert.equal(row.start_kwh, 0)
})

check('a CLEARED remark saves NULL, never an empty string', () => {
  const row = okElec(buildElectricityUpdate(reading(), { remarks: '' }, ELEC_ENV))
  assert.equal(row.remarks, null)
})

check('the two fields a reading cannot exist without are refused at ROW level', () => {
  const noDate = buildElectricityUpdate(reading(), { reading_date: '' }, ELEC_ENV)
  assert.equal(noDate.row, null)
  assert.match(noDate.errors.join(' '), /needs a date/)
  const noMeter = buildElectricityUpdate(reading(), { meter: '' }, ELEC_ENV)
  assert.equal(noMeter.row, null)
  assert.match(noMeter.errors.join(' '), /needs a meter/)
})

check('END below START is refused HERE, before anything is written', () => {
  // The action checks it too — but by then every row staged ahead of this one is already
  // stored, because the save path is not one transaction.
  const built = buildElectricityUpdate(reading(), { end_kwh: '900' }, ELEC_ENV)
  assert.equal(built.row, null)
  assert.match(built.errors.join(' '), /END KWH \(900\) is below START KWH \(1000\)/)
})

check('a new reading fills itself in from the seeds and needs a real reading', () => {
  const built = buildElectricityInsert({ start_kwh: '10', end_kwh: '20' }, '2026-08-26', ELEC_ENV)
  const row = okElec(built)
  assert.equal(row.reading_date, '2026-08-26')
  assert.equal(row.meter, 'MAIN')
  assert.equal(row.meter_multiplier, 120)
  assert.equal(row.remarks, null)

  // The one deliberate NARROWING over the live rule, which files a 0 → 0 reading whenever
  // `meter || start_kwh` is truthy — and the seeded meter makes that always true.
  const empty = buildElectricityInsert({ remarks: 'nothing typed' }, '2026-08-26', ELEC_ENV)
  assert.equal(empty.row, null)
  assert.match(empty.errors.join(' '), /needs a meter reading/)
})

check('a typed value overrides its seed, and a cleared seed is honoured', () => {
  const row = okElec(buildElectricityInsert(
    { meter: 'PUMP', meter_multiplier: '40', reading_date: '8/21', start_kwh: '5', end_kwh: '9' },
    '2026-08-26',
    ELEC_ENV,
  ))
  assert.equal(row.meter, 'PUMP')
  assert.equal(row.meter_multiplier, 40)
  assert.equal(row.reading_date, '2026-08-21')

  const cleared = buildElectricityInsert({ meter: '', start_kwh: '5' }, '2026-08-26', ELEC_ENV)
  assert.equal(cleared.row, null)
  assert.match(cleared.errors.join(' '), /needs a meter/)
})

check('a refusal names the row well enough to find it in the sheet', () => {
  assert.equal(elecRowLabel(reading()), '2026-08-01 · MAIN')
  assert.equal(elecDraftLabel({}, '2026-08-26'), 'new row 2026-08-26 · MAIN')
  assert.equal(elecDraftLabel({ meter: 'PUMP' }, '2026-08-26'), 'new row 2026-08-26 · PUMP')
})

// ── The plan ──────────────────────────────────────────────────────────────────────

function elecPlan(over: Partial<Parameters<typeof buildElectricitySavePlan>[0]> = {}) {
  const rows = [reading(), reading({ id: 'e2', meter: 'PUMP', start_kwh: 0, end_kwh: 10 })]
  const rowsById = new Map(rows.map((r) => [r.id, r]))
  return buildElectricitySavePlan({
    edits: {},
    dirtyRecords: new Set<string>(),
    dirtyDrafts: new Set<string>(),
    draftIds: [],
    rowsById,
    defaultDate: '2026-08-26',
    env: ELEC_ENV,
    ...over,
  })
}

check('a clean batch plans one update and one insert, and nothing else', () => {
  const plan = elecPlan({
    edits: { e1: { end_kwh: '1200' }, 'elecdraft:99': { meter: 'PUMP', start_kwh: '1', end_kwh: '2' } },
    dirtyRecords: new Set(['e1']),
    dirtyDrafts: new Set(['elecdraft:99']),
    draftIds: ['elecdraft:99'],
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.updates.length, 1)
  assert.equal(plan.updates[0].id, 'e1')
  assert.equal(plan.updates[0].data.end_kwh, 1200)
  assert.equal(plan.inserts.length, 1)
  assert.deepEqual(plan.updatedRowIds, ['e1'])
  assert.deepEqual(plan.insertedDraftIds, ['elecdraft:99'])
})

check('ONE illegal row refuses the whole save — nothing partial is planned', () => {
  const plan = elecPlan({
    edits: { e1: { end_kwh: '900' }, e2: { end_kwh: '20' } },
    dirtyRecords: new Set(['e1', 'e2']),
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /^2026-08-01 · MAIN: /)
  // The legal row is still PLANNED — the caller refuses the batch on `problems`, which is
  // what keeps "nothing is written unless every dirty row is legal" one rule in one place.
  assert.equal(plan.updates.some((u) => u.id === 'e1'), false)
})

check('a NEW row landing on an existing (date, meter) is refused by name', () => {
  const plan = elecPlan({
    edits: { 'elecdraft:1': { reading_date: '2026-08-01', meter: 'MAIN', start_kwh: '1', end_kwh: '2' } },
    dirtyDrafts: new Set(['elecdraft:1']),
    draftIds: ['elecdraft:1'],
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /already exists \(2026-08-01 · MAIN\)/)
  assert.equal(plan.inserts.length, 0)
})

check('two NEW rows claiming one (date, meter) are refused too', () => {
  const one = { reading_date: '2026-08-26', meter: 'PUMP', start_kwh: '1', end_kwh: '2' }
  const plan = elecPlan({
    edits: { 'elecdraft:1': one, 'elecdraft:2': { ...one } },
    dirtyDrafts: new Set(['elecdraft:1', 'elecdraft:2']),
    draftIds: ['elecdraft:1', 'elecdraft:2'],
  })
  assert.equal(plan.problems.length, 1)
  assert.equal(plan.inserts.length, 1)
})

check('an EDIT that moves a row onto another row’s key is refused', () => {
  // e2 is PUMP on 2026-08-01; renaming it to MAIN would collide with e1.
  const plan = elecPlan({
    edits: { e2: { meter: 'MAIN' } },
    dirtyRecords: new Set(['e2']),
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /already exists/)
})

check('an edit that does NOT move the key never collides with itself', () => {
  const plan = elecPlan({
    edits: { e1: { start_kwh: '900' } },
    dirtyRecords: new Set(['e1']),
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.updates.length, 1)
})

check('a dirty row that vanished from the period is skipped silently', () => {
  const plan = elecPlan({
    edits: { gone: { end_kwh: '1' } },
    dirtyRecords: new Set(['gone']),
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.updates.length, 0)
})

check('the natural key is spelled in exactly one place', () => {
  assert.equal(elecNaturalKey('2026-08-01', 'MAIN'), '2026-08-01 MAIN')
})

check('a failure says the PARTIAL truth and never claims a rollback', () => {
  const msg = elecSaveFailureMessage({ updates: 2, inserts: 1 }, 'duplicate key value violates unique constraint')
  assert.match(msg, /1 new reading and 2 edited readings/)
  assert.match(msg, /NOT one transaction/)
  assert.match(msg, /already stored/)
  assert.match(msg, /duplicate key value/)
  // The words a transactional path would use, and this one may never borrow.
  assert.equal(/rolled back|nothing was written/.test(msg), false)
})

check('the success line counts what landed', () => {
  assert.equal(elecSaveSuccessMessage({ updates: 2, inserts: 1 }), 'Saved — 1 added, 2 updated')
  assert.equal(elecSaveSuccessMessage({ updates: 0, inserts: 3 }), 'Saved — 3 added')
})

// ═══════════════════════════════════════════════════════════════════════════════════
// TRUCKS
// ═══════════════════════════════════════════════════════════════════════════════════

function truckRow(over: Partial<TruckReadingRow> = {}): TruckReadingRow {
  return {
    id: 't1',
    created_at: '2026-08-01T00:00:00Z',
    reading_date: '2026-08-01',
    plate_no: 'AAV 6111',
    start_km: 10000,
    end_km: 10120,
    ttl_km: 120,
    fuel_liters: 40,
    remarks: 'oil change',
    human_edited_at: null,
    human_edited_by: null,
    ...over,
  } as TruckReadingRow
}

const PLATES = [...KNOWN_PLATES]

console.log('\nTrucks v2 grid — pivot + save model\n')

check('a column key round-trips, including a plate with a space in it', () => {
  for (const plate of PLATES) {
    for (const metric of TRUCK_METRICS) {
      const key = colKeyOf(plate, metric)
      assert.deepEqual(parseColKey(key), { kind: 'metric', plate, metric })
    }
    assert.deepEqual(parseColKey(colKeyOf(plate, 'ttl_km')), { kind: 'ttl', plate })
  }
  assert.deepEqual(parseColKey(DATE_KEY), { kind: 'date' })
  assert.equal(parseColKey('num'), null)
  assert.equal(parseColKey('AAV 6111::odometer'), null)
  assert.equal(parseColKey('::start_km'), null)
})

check('only the DATE and the three metric lanes are typeable', () => {
  assert.equal(isTruckEditField(DATE_KEY), true)
  assert.equal(isTruckEditField(colKeyOf('KCA 378', 'fuel_liters')), true)
  assert.equal(isTruckEditField(colKeyOf('KCA 378', 'ttl_km')), false)
  assert.equal(isTruckEditField('anything else'), false)
})

check('the plate set is the canonical three, then extras, sorted', () => {
  const plates = derivePlates([
    truckRow({ plate_no: 'ZZZ 111' }),
    truckRow({ plate_no: 'BBB 222' }),
    truckRow({ plate_no: 'AAV 6111' }),
    truckRow({ plate_no: '  ' }),
  ])
  assert.deepEqual(plates, ['AAV 6111', 'KCA 378', 'FORKLIFT', 'BBB 222', 'ZZZ 111'])
})

check('the pivot keeps the stored id and the remark the sheet never shows', () => {
  const rows = buildDayRows([truckRow(), truckRow({ id: 't2', plate_no: 'KCA 378', start_km: 1, end_km: 2 })], PLATES)
  assert.equal(rows.length, 1)
  const day = rows[0]
  assert.equal(day.reading_date, '2026-08-01')
  assert.equal(day.cells['AAV 6111'].id, 't1')
  assert.equal(day.cells['AAV 6111'].remarks, 'oil change')
  assert.equal(day.cells['KCA 378'].id, 't2')
  // A truck with no reading that day is an EMPTY cell, never an absent one.
  assert.equal(day.cells.FORKLIFT.id, undefined)
  assert.equal(day.cells.FORKLIFT.start_km, '')
})

check('the pivot preserves the server’s order and drops a dateless reading', () => {
  const rows = buildDayRows([
    truckRow({ id: 'a', reading_date: '2026-08-03' }),
    truckRow({ id: 'b', reading_date: '2026-08-01' }),
    truckRow({ id: 'c', reading_date: '' }),
  ], PLATES)
  assert.deepEqual(rows.map((r) => r.reading_date), ['2026-08-03', '2026-08-01'])
})

check('stored cell text answers for the DATE, the metrics and the computed TTL', () => {
  const day = buildDayRows([truckRow()], PLATES)[0]
  assert.equal(truckStoredFieldText(day, DATE_KEY), '2026-08-01')
  assert.equal(truckStoredFieldText(day, colKeyOf('AAV 6111', 'start_km')), '10000')
  assert.equal(truckStoredFieldText(day, colKeyOf('AAV 6111', 'fuel_liters')), '40')
  assert.equal(truckStoredFieldText(day, colKeyOf('AAV 6111', 'ttl_km')), '120')
  assert.equal(truckStoredFieldText(day, colKeyOf('FORKLIFT', 'ttl_km')), '')
  assert.equal(truckStoredFieldText(null, DATE_KEY), '')
  assert.equal(ttlKmOf('10000', '10120'), 120)
})

check('a truck cell’s verdicts, and the TTL lane refuses to be typed into at all', () => {
  const key = colKeyOf('AAV 6111', 'start_km')
  assert.deepEqual(parseTruckField(key, '10,500', TRUCK_ENV), { ok: true, value: 10500 })
  assert.deepEqual(parseTruckField(key, '', TRUCK_ENV), { ok: true, value: null })
  const bad = parseTruckField(key, 'abc', TRUCK_ENV)
  assert.equal(bad.ok, false)
  assert.match((bad as { error: string }).error, /AAV 6111 START KM/)
  const ttl = parseTruckField(colKeyOf('AAV 6111', 'ttl_km'), '5', TRUCK_ENV)
  assert.equal(ttl.ok, false)
  assert.deepEqual(parseTruckField(DATE_KEY, '8/21', TRUCK_ENV), { ok: true, value: '2026-08-21' })
})

check('a truck DATE is canonicalised and a pasted cell is cleaned the same way', () => {
  assert.equal(normalizeTruckField(DATE_KEY, '8/21', { contextYear: 2025 }), '2025-08-21')
  assert.equal(normalizeTruckField(colKeyOf('AAV 6111', 'start_km'), '10,500', TRUCK_ENV), '10,500')
  assert.equal(cleanPastedTruckCell(DATE_KEY, '8/21', TRUCK_ENV), '2026-08-21')
  assert.equal(cleanPastedTruckCell(colKeyOf('AAV 6111', 'end_km'), '"10,500"', TRUCK_ENV), '10500')
})

// ── The plan ──────────────────────────────────────────────────────────────────────

const TRUCK_DATA = [
  truckRow(),
  truckRow({ id: 't2', plate_no: 'KCA 378', start_km: 500, end_km: 560, fuel_liters: null, remarks: null }),
  truckRow({ id: 't3', reading_date: '2026-08-02', start_km: 10120, end_km: 10200, fuel_liters: null, remarks: null }),
]

function truckPlan(over: Partial<Parameters<typeof buildTrucksSavePlan>[0]> = {}) {
  const dayRows: DayRow[] = buildDayRows(TRUCK_DATA, PLATES)
  return buildTrucksSavePlan({
    edits: {},
    dirtyRecords: new Set<string>(),
    dirtyDrafts: new Set<string>(),
    draftIds: [],
    dayRows,
    plates: PLATES,
    defaultDate: '2026-08-26',
    env: TRUCK_ENV,
    ...over,
  })
}

check('one touched metric plans ONE update, of exactly six keys', () => {
  const plan = truckPlan({
    edits: { '2026-08-01': { [colKeyOf('AAV 6111', 'end_km')]: '10200' } },
    dirtyRecords: new Set(['2026-08-01']),
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.updates.length, 1)
  const { id, data } = plan.updates[0]
  assert.equal(id, 't1')
  assert.deepEqual(Object.keys(data).sort(), [
    'end_km', 'fuel_liters', 'plate_no', 'reading_date', 'remarks', 'start_km',
  ])
  assert.equal(data.end_km, 10200)
  assert.equal(data.start_km, 10000)
  assert.equal(data.plate_no, 'AAV 6111')
  assert.equal(data.reading_date, '2026-08-01')
  // The remark the matrix has no column for is CARRIED, never blanked.
  assert.equal(data.remarks, 'oil change')
  assert.equal('ttl_km' in data, false)
  // The other truck on the same day was not touched and is not posted.
  assert.equal(plan.inserts.length, 0)
})

check('editing the DATE re-files EVERY reading on that day', () => {
  // The live grid saves NOTHING in this case — it only updates cells whose own value was
  // touched — so a date correction leaves the row dirty forever and the readings wrong.
  const plan = truckPlan({
    edits: { '2026-08-01': { [DATE_KEY]: '2026-08-05' } },
    dirtyRecords: new Set(['2026-08-01']),
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.updates.length, 2)
  assert.deepEqual(plan.updates.map((u) => u.id).sort(), ['t1', 't2'])
  for (const u of plan.updates) assert.equal(u.data.reading_date, '2026-08-05')
  // And nothing else about those readings moved.
  const moved = plan.updates.find((u) => u.id === 't1')!
  assert.equal(moved.data.start_km, 10000)
  assert.equal(moved.data.end_km, 10120)
  assert.equal(moved.data.fuel_liters, 40)
})

check('moving a day onto an occupied (date, plate) is refused by name', () => {
  const plan = truckPlan({
    edits: { '2026-08-01': { [DATE_KEY]: '2026-08-02' } },
    dirtyRecords: new Set(['2026-08-01']),
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /2026-08-02 · AAV 6111/)
  assert.match(plan.problems[0], /already has a reading on this date/)
})

check('typing into a truck with no reading that day plans an INSERT', () => {
  const plan = truckPlan({
    edits: {
      '2026-08-01': {
        [colKeyOf('FORKLIFT', 'start_km')]: '10',
        [colKeyOf('FORKLIFT', 'end_km')]: '25',
      },
    },
    dirtyRecords: new Set(['2026-08-01']),
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.updates.length, 0)
  assert.equal(plan.inserts.length, 1)
  assert.deepEqual(plan.inserts[0], {
    reading_date: '2026-08-01',
    plate_no: 'FORKLIFT',
    start_km: 10,
    end_km: 25,
    // "not recorded" is not "no fuel".
    fuel_liters: null,
    remarks: null,
  })
})

check('a CLEARED fuel cell saves NULL, and a cleared odometer saves 0', () => {
  const plan = truckPlan({
    edits: {
      '2026-08-01': {
        [colKeyOf('AAV 6111', 'fuel_liters')]: '',
        [colKeyOf('AAV 6111', 'start_km')]: '',
      },
    },
    dirtyRecords: new Set(['2026-08-01']),
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.updates[0].data.fuel_liters, null)
  assert.equal(plan.updates[0].data.start_km, 0)
})

check('END below START refuses the whole DAY, not just the cell', () => {
  const plan = truckPlan({
    edits: {
      '2026-08-01': {
        [colKeyOf('AAV 6111', 'end_km')]: '9000',
        [colKeyOf('KCA 378', 'end_km')]: '600',
      },
    },
    dirtyRecords: new Set(['2026-08-01']),
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /END KM \(9000\) is below START KM \(10000\)/)
  // The legal sibling cell on the same row is NOT posted — a half-saved day is not
  // representable even before the run-wide rule applies.
  assert.equal(plan.updates.length, 0)
})

check('an unreadable figure refuses the day and names the truck and the lane', () => {
  const plan = truckPlan({
    edits: { '2026-08-01': { [colKeyOf('KCA 378', 'fuel_liters')]: '4O' } },
    dirtyRecords: new Set(['2026-08-01']),
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /KCA 378 FUEL/)
  assert.equal(plan.updates.length, 0)
})

check('a blank DAY row plans one insert per truck that was typed into', () => {
  const plan = truckPlan({
    edits: {
      'truckdraft:1': {
        [DATE_KEY]: '2026-08-20',
        [colKeyOf('AAV 6111', 'start_km')]: '1',
        [colKeyOf('AAV 6111', 'end_km')]: '9',
        [colKeyOf('KCA 378', 'fuel_liters')]: '30',
      },
    },
    dirtyDrafts: new Set(['truckdraft:1']),
    draftIds: ['truckdraft:1'],
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.inserts.length, 2)
  assert.deepEqual(plan.insertedDraftIds, ['truckdraft:1'])
  const fuelOnly = plan.inserts.find((i) => i.plate_no === 'KCA 378')!
  assert.equal(fuelOnly.reading_date, '2026-08-20')
  assert.equal(fuelOnly.fuel_liters, 30)
  assert.equal(fuelOnly.start_km, 0)
})

check('a blank DAY row falls back to the seeded date', () => {
  const plan = truckPlan({
    edits: { 'truckdraft:1': { [colKeyOf('FORKLIFT', 'end_km')]: '5' } },
    dirtyDrafts: new Set(['truckdraft:1']),
    draftIds: ['truckdraft:1'],
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.inserts[0].reading_date, '2026-08-26')
})

check('a blank DAY row with no readings at all is refused by name', () => {
  const plan = truckPlan({
    edits: { 'truckdraft:1': { [DATE_KEY]: '2026-08-20' } },
    dirtyDrafts: new Set(['truckdraft:1']),
    draftIds: ['truckdraft:1'],
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /needs at least one truck reading/)
  assert.equal(plan.inserts.length, 0)
})

check('a blank DAY row landing on an existing (date, plate) is refused', () => {
  const plan = truckPlan({
    edits: {
      'truckdraft:1': {
        [DATE_KEY]: '2026-08-01',
        [colKeyOf('AAV 6111', 'start_km')]: '1',
        [colKeyOf('AAV 6111', 'end_km')]: '2',
      },
    },
    dirtyDrafts: new Set(['truckdraft:1']),
    draftIds: ['truckdraft:1'],
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /already has a reading on this date/)
})

check('a blank DAY row on a date that exists but a TRUCK that does not is fine', () => {
  const plan = truckPlan({
    edits: {
      'truckdraft:1': {
        [DATE_KEY]: '2026-08-01',
        [colKeyOf('FORKLIFT', 'start_km')]: '1',
        [colKeyOf('FORKLIFT', 'end_km')]: '2',
      },
    },
    dirtyDrafts: new Set(['truckdraft:1']),
    draftIds: ['truckdraft:1'],
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.inserts.length, 1)
})

check('a truck draft id is unique and self-identifying', () => {
  const ids = makeTruckDraftIds(2)
  assert.equal(new Set(ids).size, 2)
  assert.ok(ids[0].startsWith(TRUCK_DRAFT_PREFIX))
  assert.equal(isTruckDraftKey(ids[0]), true)
  assert.equal(isElecDraftKey(ids[0]), false)
})

check('the trucks failure message counts READINGS and never claims a rollback', () => {
  const msg = truckSaveFailureMessage({ updates: 3, inserts: 0 }, 'violates check constraint')
  assert.match(msg, /3 edited readings/)
  assert.match(msg, /NOT one transaction/)
  assert.match(msg, /violates check constraint/)
  assert.equal(/rolled back|nothing was written/.test(msg), false)
})

// ═══════════════════════════════════════════════════════════════════════════════════
// SOURCE SCANS — what these files may not contain
// ═══════════════════════════════════════════════════════════════════════════════════

const ELEC_SAVE = readFileSync(join(ROOT, 'app/(app)/production/electricity/electricity-grid-v2-save.ts'), 'utf8')
const TRUCK_SAVE = readFileSync(join(ROOT, 'app/(app)/production/trucks/trucks-grid-v2-save.ts'), 'utf8')
const ELEC_GRID = readFileSync(join(ROOT, 'app/(app)/production/electricity/electricity-grid-v2.tsx'), 'utf8')
const TRUCK_GRID = readFileSync(join(ROOT, 'app/(app)/production/trucks/trucks-grid-v2.tsx'), 'utf8')

console.log('\nSource scans\n')

check('the save models are PURE — no React, no Supabase, no server action', () => {
  for (const [name, src] of [['electricity', ELEC_SAVE], ['trucks', TRUCK_SAVE]] as const) {
    const code = stripComments(src)
    // The scan is only meaningful if the stripper left the module intact.
    assert.match(code, /export function/, `${name}: the comment stripper ate the module`)
    assert.equal(/from 'react'/.test(code), false, `${name} must not import React`)
    assert.equal(/@\/lib\/supabase/.test(code), false, `${name} must not reach the database`)
    assert.equal(/from '\.\/actions'/.test(code), false, `${name} must not import the server action`)
    assert.equal(/use client/.test(code), false, `${name} is not a client module`)
  }
})

check('neither grid declares a server action of its own', () => {
  for (const [name, src] of [['electricity', ELEC_GRID], ['trucks', TRUCK_GRID]] as const) {
    const code = stripComments(src)
    assert.match(code, /BlackwoodTable/, `${name}: the comment stripper ate the component`)
    assert.equal(/'use server'/.test(code), false, `${name} must not declare a server action`)
    assert.equal(/@\/lib\/supabase/.test(code), false, `${name} must not query Supabase directly`)
  }
})

check('each grid calls exactly ONE existing bulk-save action, with no deletes', () => {
  const elec = stripComments(ELEC_GRID)
  assert.match(elec, /import \{ saveBulkElectricity \} from '\.\/actions'/)
  assert.match(elec, /deletes: \[\]/)
  const trucks = stripComments(TRUCK_GRID)
  assert.match(trucks, /import \{ saveBulkTrucks \} from '\.\/actions'/)
  assert.match(trucks, /deletes: \[\]/)
})

check('every error surface is the persistent `errorToast`, never a raw toast.error', () => {
  for (const [name, src] of [['electricity', ELEC_GRID], ['trucks', TRUCK_GRID]] as const) {
    const code = stripComments(src)
    assert.match(code, /errorToast\(/, `${name}: no error surface found at all`)
    assert.equal(/toast\.error\(/.test(code), false, `${name} must use errorToast (HARD RULE)`)
  }
})

check('a failed save FORGETS NOTHING — the edits stay on screen', () => {
  for (const [name, src] of [['electricity', ELEC_GRID], ['trucks', TRUCK_GRID]] as const) {
    const code = stripComments(src)
    // One `forget`, and it is downstream of the `!res.ok` early return.
    const forgets = code.match(/edits\.forget\(/g) ?? []
    assert.equal(forgets.length, 1, `${name} should forget in exactly one place`)
    const refusal = code.indexOf('if (!res.ok)')
    const forget = code.indexOf('edits.forget(')
    assert.ok(refusal >= 0 && forget > refusal, `${name}: forget must sit after the refusal branch`)
  }
})

check('the derived lanes preview unsaved edits — and the pill genuinely cannot', () => {
  // DIFF, TTL KWH and TTL KM read `ctx.cellText`, which is what makes a typed END move
  // them immediately, exactly as the live grids' inline arithmetic over their edit buffer
  // does. Two calls for DIFF, three for TTL KWH.
  const elec = stripComments(ELEC_GRID)
  assert.equal((elec.match(/ctx\.cellText\(/g) ?? []).length, 5)
  const trucks = stripComments(TRUCK_GRID)
  assert.equal((trucks.match(/ctx\.cellText\(/g) ?? []).length, 2)
  // `numericValue` and `clipboardValue` take the ROW and nothing else — the platform
  // documents the clipboard as "the STORED value, never the edit text", so a preview
  // there is not merely unwise, it is unreachable. If this ever compiles with a ctx, the
  // decision has to be made again on purpose.
  for (const [name, code] of [['electricity', elec], ['trucks', trucks]] as const) {
    assert.equal(/numericValue: \(\w+, ctx\)/.test(code), false, `${name}`)
    assert.equal(/clipboardValue: \(\w+, ctx\)/.test(code), false, `${name}`)
  }
})

check('each grid reloads through its HOST, because the tab holds rows in client state', () => {
  // `router.refresh()` re-renders the server tree; it cannot refetch a row the lazy tab
  // pulled into `useState`. `onSaveSuccess` is the only path that can, so both grids call
  // it, and both say so out loud when a caller has not threaded it.
  for (const [name, src] of [['electricity', ELEC_GRID], ['trucks', TRUCK_GRID]] as const) {
    const code = stripComments(src)
    assert.match(code, /await onSaveSuccess\?\.\(\)/, `${name} must call its host's refetch`)
    assert.match(code, /if \(!onSaveSuccess\)/, `${name} must say so when it cannot reload`)
    assert.match(code, /router\.refresh\(\)/, `${name} should still revalidate the server tree`)
  }
})

check('no file carries a stray control character', () => {
  // A single NUL byte reached a template literal in this very changeset and turned the
  // natural key into `2026-08-01\0MAIN` — which nothing on screen would ever have shown.
  const files: [string, string][] = [
    ['electricity save', ELEC_SAVE], ['trucks save', TRUCK_SAVE],
    ['electricity grid', ELEC_GRID], ['trucks grid', TRUCK_GRID],
  ]
  for (const [name, src] of files) {
    const bad = src.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)
    assert.equal(bad, null, `${name} contains a control character`)
  }
})

check('the two live grids are untouched by this pass', () => {
  // The strangler-fig rule: the v2 sheets are built BESIDE the live ones, which stay
  // byte-identical so `?grid=v1` remains a true escape hatch.
  const live = [
    'app/(app)/production/electricity/electricity-grid.tsx',
    'app/(app)/production/trucks/trucks-grid.tsx',
  ]
  for (const path of live) {
    const src = readFileSync(join(ROOT, path), 'utf8')
    assert.equal(/grid-v2-save/.test(src), false, `${path} must not import the v2 save model`)
    assert.match(src, /useCellSelection/, `${path} should still be the Classic grid`)
  }
})

console.log(`\n${passed} assertions passed\n`)
