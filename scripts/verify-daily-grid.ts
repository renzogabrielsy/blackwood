/**
 * verify-daily-grid.ts — framework-free assertions over the Production Daily v2 grid's
 * PURE save model (`app/(app)/production/daily/daily-grid-v2-save.ts`). No DB, no browser.
 *
 * Built in the idiom of `scripts/verify-rc-in-grid.ts` and `scripts/verify-qc-grid.ts`,
 * for the sibling module. It exists because the four things this grid can most easily get
 * silently WRONG are not observable from the screen:
 *
 *   1. **The routing.** A waste figure typed on a run row is a save to the SHIFT. File it
 *      against the run and it is written to the wrong thing — or to nothing.
 *   2. **The whole-block payloads.** `saveBulkDailyLedger` rebuilds a fixed object per
 *      table, so an untouched column missing from the payload is not "left alone": it is
 *      blanked. That includes three columns this sheet does not even render.
 *   3. **`shift_hrs`.** The action gates the ENTIRE downtime write on it, it is NOT NULL,
 *      and no stored row holds the 8 the sheet's PROD HRS lane assumes.
 *   4. **The door's grade list.** The database allows `4X8`; the action does not, and it
 *      validates every row in the payload.
 *
 * Several assertions read the LIVE ledger and its server action off disk, because every
 * one of those four facts is a property of files this migration may not edit — so a
 * change there has to fail HERE rather than in production.
 *
 * Run: npx tsx scripts/verify-daily-grid.ts
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ASSUMED_SHIFT_HRS,
  DAILY_EDIT_FIELDS,
  DEFAULT_CUSTOMER,
  DOWNTIME_FIELDS,
  DRAFT_PREFIX,
  IDENTITY_FIELDS,
  RUN_FIELDS,
  SAVEABLE_GRADES,
  SHIFT_CODES,
  WASTE_FIELDS,
  buildDailySavePlan,
  buildDowntimeBlock,
  buildRunBlock,
  buildWasteBlock,
  cleanPastedDailyCell,
  countDailyUnsaved,
  dailySaveFailureMessage,
  describeDailyUnsaved,
  draftFieldText,
  draftRowLabel,
  isDailyEditField,
  isDraftKey,
  isShiftOwnedField,
  laneOf,
  makeDraftIds,
  normalizeDailyField,
  parseDailyField,
  rowLabel,
  routeDailyEdits,
  savedFieldText,
  shiftKeyOf,
  storedRowFieldIsEditable,
  type DailyField,
  type DailyFieldEnv,
  type DraftDefaults,
  type RowEditMap,
} from '@/app/(app)/production/daily/daily-grid-v2-save'
import type { GridRow as LedgerRow } from '@/app/(app)/production/daily/daily-ledger-grid'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAILY = join(ROOT, 'app/(app)/production/daily')

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

const ENV: DailyFieldEnv = { contextYear: 2026 }

const DEFAULTS: DraftDefaults = {
  date: '2026-08-26',
  batch: 'AUGUST',
  shift: 'M',
  customer: DEFAULT_CUSTOMER,
}

/** A stored primary run row, with a full downtime + waste block on it. */
function row(over: Partial<LedgerRow> = {}): LedgerRow {
  const base: LedgerRow = {
    _state: 'existing',
    _shiftKey: shiftKeyOf('2026-08-01', 'AUGUST', 'M'),
    _isPrimary: true,
    _ids: { shift_id: 's1', run_id: 'r1', downtime_id: 'd1', waste_id: 'w1' },
    date: '2026-08-01',
    batch: 'AUGUST',
    shift_code: 'M',
    customer: 'CEBU',
    grade: '3X50',
    ttl_kg: '12000',
    bags: '240',
    run_remarks: 'ran clean',
    dt_hrs: '1',
    dt_mins: '30',
    dt_reason: 'belt change',
    rs1a: '10',
    rs1b: '20',
    bf: '30',
    rs23: '40',
    rs5: '50',
    trml1: '60',
    trml2: '70',
    grit: '80',
    waste_remarks: 'sifted twice',
  }
  const merged = { ...base, ...over }
  merged._shiftKey = shiftKeyOf(merged.date, merged.batch, merged.shift_code)
  return merged
}

/** The secondary grade row of the same shift — no downtime, no waste. */
function secondary(over: Partial<LedgerRow> = {}): LedgerRow {
  return row({
    _isPrimary: false,
    _ids: { shift_id: 's1', run_id: 'r2', downtime_id: 'd1', waste_id: 'w1' },
    grade: '6X50',
    ttl_kg: '3000',
    bags: '',
    run_remarks: '',
    dt_hrs: '',
    dt_mins: '',
    dt_reason: '',
    rs1a: '', rs1b: '', bf: '', rs23: '', rs5: '', trml1: '', trml2: '', grit: '',
    waste_remarks: '',
    ...over,
  })
}

interface PlanCase {
  rows: LedgerRow[]
  edits: RowEditMap
  drafts?: string[]
  shiftHrs?: [string, number][]
}

function planOf(input: PlanCase) {
  const rowsById = new Map<string, LedgerRow>()
  for (const r of input.rows) rowsById.set(r._ids.run_id ?? `${r._shiftKey}#norun`, r)
  const draftIds = input.drafts ?? []
  const dirtyRecords = new Set(Object.keys(input.edits).filter((k) => !isDraftKey(k) && rowsById.has(k)))
  const dirtyDrafts = new Set(Object.keys(input.edits).filter((k) => isDraftKey(k)))
  return buildDailySavePlan({
    edits: input.edits,
    dirtyRecords,
    dirtyDrafts,
    draftIds: draftIds.length > 0 ? draftIds : [...dirtyDrafts],
    rowsById,
    rows: input.rows,
    shiftHrsByShiftId: new Map(input.shiftHrs ?? [['s1', 9]]),
    defaults: DEFAULTS,
    env: ENV,
  })
}

function refused(verdict: ReturnType<typeof parseDailyField>): string {
  assert.equal(verdict.ok, false, 'expected a refusal')
  return verdict.ok ? '' : verdict.error
}


console.log('\nProduction Daily v2 grid — save model\n')

// ═══ The field vocabulary, and the LANE each field saves to ═════════════════════

check('the eighteen editable fields are exactly the live ledger\'s own COL_MAP set', () => {
  const src = readFileSync(join(DAILY, 'daily-ledger-grid.tsx'), 'utf8')
  const block = src.slice(src.indexOf('const COL_MAP'), src.indexOf('const COL_COUNT'))
  assert.ok(block.includes("'ttl_kg'"), 'the COL_MAP block was not found — the scan would pass vacuously')
  const live = new Set([...block.matchAll(/'([a-z0-9_]+)',\s*\/\//g)].map((m) => m[1]))
  // The live map lists 18 fields plus `null` entries for `#` and the four computed lanes.
  assert.equal(live.size, 18, `expected 18 live editable fields, found ${live.size}`)
  assert.deepEqual([...DAILY_EDIT_FIELDS].sort(), [...live].sort())
})

check('every lane routes to exactly one thing, and a computed lane routes nowhere', () => {
  for (const f of IDENTITY_FIELDS) assert.equal(laneOf(f), 'identity')
  for (const f of RUN_FIELDS) assert.equal(laneOf(f), 'run')
  for (const f of DOWNTIME_FIELDS) assert.equal(laneOf(f), 'downtime')
  for (const f of WASTE_FIELDS) assert.equal(laneOf(f), 'waste')
  for (const k of ['num', 'dt_ttl', 'prod_hrs', 'prod_loss', 'ttl_waste', 'bags', 'waste_remarks']) {
    assert.equal(laneOf(k), null, `${k} is not a typeable field`)
    assert.equal(isDailyEditField(k), false)
  }
})

check('a SHIFT-owned field is exactly downtime ∪ waste — eleven lanes', () => {
  const owned = DAILY_EDIT_FIELDS.filter(isShiftOwnedField)
  assert.deepEqual([...owned].sort(), [...DOWNTIME_FIELDS, ...WASTE_FIELDS].sort())
  assert.equal(owned.length, 11)
  assert.equal(isShiftOwnedField('ttl_kg'), false)
})

check('a SAVED row may be typed in every lane except the shift\'s identity', () => {
  for (const f of IDENTITY_FIELDS) assert.equal(storedRowFieldIsEditable(f), false)
  for (const f of [...RUN_FIELDS, ...DOWNTIME_FIELDS, ...WASTE_FIELDS]) {
    assert.equal(storedRowFieldIsEditable(f), true)
  }
  assert.equal(storedRowFieldIsEditable('prod_hrs'), false, 'a derived lane is not a field')
})

check('a draft id is a monotonic counter, never a collision', () => {
  const a = makeDraftIds(3)
  const b = makeDraftIds(3)
  assert.equal(new Set([...a, ...b]).size, 6, 'two batches of blank rows must never share an id')
  for (const id of a) assert.ok(isDraftKey(id) && id.startsWith(DRAFT_PREFIX))
  assert.equal(isDraftKey('r1'), false)
  assert.equal(isDraftKey('2026-08-01|AUGUST|M#norun'), false)
})

check('the shift key is the live ledger\'s own `date|batch|shift`', () => {
  const src = readFileSync(join(DAILY, 'daily-ledger-grid.tsx'), 'utf8')
  assert.ok(
    src.includes("const SHIFT_KEY_SEPARATOR = '|'"),
    'the live ledger no longer separates its shift key with a pipe — the two definitions have drifted',
  )
  assert.equal(shiftKeyOf('2026-08-01', 'AUGUST', 'M'), '2026-08-01|AUGUST|M')
  // And the row model agrees, which is what lets a shift-lane edit be filed by `_shiftKey`.
  assert.equal(row()._shiftKey, shiftKeyOf('2026-08-01', 'AUGUST', 'M'))
})

// ═══ ONE field, ONE verdict ═════════════════════════════════════════════════════

check('a BLANK cell is legal in every lane — clearing a cell you are retyping is not an error', () => {
  for (const f of DAILY_EDIT_FIELDS) {
    assert.equal(parseDailyField(f, '', ENV).ok, true, `${f} refused a blank`)
    assert.equal(parseDailyField(f, '   ', ENV).ok, true, `${f} refused whitespace`)
  }
})

check('a DATE takes shorthand and refuses what it cannot read, by name', () => {
  assert.equal(parseDailyField('date', '8/21', ENV).ok, true)
  assert.equal(parseDailyField('date', '2026-08-21', ENV).ok, true)
  const err = refused(parseDailyField('date', 'tuesday', ENV))
  assert.match(err, /DATE/)
  assert.match(err, /tuesday/)
})

check('SHIFT is the action\'s closed list, and the refusal LISTS it', () => {
  for (const s of SHIFT_CODES) assert.equal(parseDailyField('shift_code', s.toLowerCase(), ENV).ok, true)
  const err = refused(parseDailyField('shift_code', 'X', ENV))
  for (const s of SHIFT_CODES) assert.match(err, new RegExp(s))
})

check('GRADE 4X8 is refused BY NAME — the database allows it and the save does not', () => {
  for (const g of SAVEABLE_GRADES) assert.equal(parseDailyField('grade', g.toLowerCase(), ENV).ok, true)
  const err = refused(parseDailyField('grade', '4x8', ENV))
  assert.match(err, /4X8/, 'the refusal must name the grade the operator actually typed')
  assert.match(err, /database/i, 'and must say the row is legal — it is the DOOR that refuses it')
  for (const g of SAVEABLE_GRADES) assert.match(err, new RegExp(g))
  // An outright typo gets the plain refusal, not the 4X8 explanation.
  assert.doesNotMatch(refused(parseDailyField('grade', '9X99', ENV)), /database/i)
})

check('DT MIN is bounded by the CHECK constraint: 0 ≤ mins < 60', () => {
  assert.equal(parseDailyField('dt_mins', '59', ENV).ok, true)
  assert.equal(parseDailyField('dt_mins', '0', ENV).ok, true)
  assert.match(refused(parseDailyField('dt_mins', '60', ENV)), /less than 60/)
  assert.match(refused(parseDailyField('dt_mins', '-1', ENV)), /below 0/)
  assert.match(refused(parseDailyField('dt_mins', '90', ENV)), /DT HRS/, 'it says where the hours go')
})

check('every kg lane refuses a negative — each carries its own `>= 0` CHECK', () => {
  for (const f of [...WASTE_FIELDS, 'ttl_kg', 'dt_hrs'] as DailyField[]) {
    assert.match(refused(parseDailyField(f, '-5', ENV)), /below 0/, `${f} accepted a negative`)
    assert.equal(parseDailyField(f, '0', ENV).ok, true, `${f} refused a legitimate zero`)
  }
})

check('a figure keeps its spreadsheet formatting on the way in', () => {
  assert.equal(parseDailyField('ttl_kg', '12,000.50', ENV).ok, true)
  assert.equal(parseDailyField('rs1a', ' 1,234 ', ENV).ok, true)
  assert.match(refused(parseDailyField('ttl_kg', '12O00', ENV)), /not a number/)
})

check('free-text lanes take whatever is typed', () => {
  for (const f of ['run_remarks', 'dt_reason', 'batch', 'customer'] as DailyField[]) {
    assert.equal(parseDailyField(f, 'anything at all — 4X8, 90, ₱', ENV).ok, true)
  }
})

// ═══ Canonicalisation ═══════════════════════════════════════════════════════════

check('normalize canonicalises the five lanes the server would canonicalise anyway', () => {
  assert.equal(normalizeDailyField('date', '8/21', ENV), '2026-08-21')
  assert.equal(normalizeDailyField('batch', ' august ', ENV), 'AUGUST')
  assert.equal(normalizeDailyField('shift_code', 'm', ENV), 'M')
  assert.equal(normalizeDailyField('customer', 'cebu', ENV), 'CEBU')
  assert.equal(normalizeDailyField('grade', '3x50', ENV), '3X50')
  // Everything else is the operator's text, untouched.
  assert.equal(normalizeDailyField('run_remarks', ' belt Change ', ENV), ' belt Change ')
  assert.equal(normalizeDailyField('ttl_kg', '12,000', ENV), '12,000')
})

check('normalize may NEVER refuse — unreadable text is kept verbatim for `parse` to name', () => {
  assert.equal(normalizeDailyField('date', 'tuesday', ENV), 'tuesday')
  assert.equal(refused(parseDailyField('date', normalizeDailyField('date', 'tuesday', ENV), ENV)).length > 0, true)
})

check('a pasted cell and a typed cell can never land on two different values', () => {
  assert.equal(cleanPastedDailyCell('date', '8/21', ENV), normalizeDailyField('date', '8/21', ENV))
  assert.equal(cleanPastedDailyCell('grade', ' 3x50 ', ENV), '3X50')
  assert.equal(cleanPastedDailyCell('ttl_kg', '₱12,000', ENV), '12000')
  assert.equal(cleanPastedDailyCell('rs1a', '1,234.50', ENV), '1234.50')
})

// ═══ Routing — the thing this sheet gets silently wrong ═════════════════════════

function routeOf(rows: LedgerRow[], edits: RowEditMap, drafts: string[] = []) {
  const rowsById = new Map<string, LedgerRow>()
  for (const r of rows) rowsById.set(r._ids.run_id ?? `${r._shiftKey}#norun`, r)
  return routeDailyEdits({
    edits,
    dirtyRecords: Object.keys(edits).filter((k) => !isDraftKey(k)),
    dirtyDrafts: new Set(Object.keys(edits).filter((k) => isDraftKey(k))),
    draftIds: drafts,
    rowsById,
    defaults: DEFAULTS,
  })
}

check('a WASTE figure typed on a run row is filed against the SHIFT, not the run', () => {
  const routed = routeOf([row()], { r1: { rs1a: '99' } })
  assert.equal(routed.runs.size, 0, 'a waste edit is not a run edit')
  assert.equal(routed.shifts.size, 1)
  const bucket = routed.shifts.get(shiftKeyOf('2026-08-01', 'AUGUST', 'M'))!
  assert.equal(bucket.fields.rs1a, '99')
  assert.deepEqual(bucket.rowIds, ['r1'], 'the row is remembered so its text can be forgotten')
})

check('a DOWNTIME figure is filed against the shift too', () => {
  const routed = routeOf([row()], { r1: { dt_hrs: '2', dt_reason: 'kiln' } })
  const bucket = routed.shifts.get(shiftKeyOf('2026-08-01', 'AUGUST', 'M'))!
  assert.equal(bucket.fields.dt_hrs, '2')
  assert.equal(bucket.fields.dt_reason, 'kiln')
  assert.equal(routed.runs.size, 0)
})

check('a RUN figure is filed against its own row and touches no sibling', () => {
  const routed = routeOf([row(), secondary()], { r2: { ttl_kg: '4000' } })
  assert.equal(routed.shifts.size, 0)
  assert.deepEqual([...routed.runs.keys()], ['r2'])
  assert.equal(routed.runs.get('r2')!.fields.ttl_kg, '4000')
})

check('two rows of ONE shift disagreeing about a shift field is REFUSED, never guessed', () => {
  const routed = routeOf([row(), secondary()], { r1: { grit: '10' }, r2: { grit: '20' } })
  const bucket = routed.shifts.get(shiftKeyOf('2026-08-01', 'AUGUST', 'M'))!
  assert.equal(bucket.conflicts.length, 1)
  assert.match(bucket.conflicts[0], /GRIT/)
  assert.match(bucket.conflicts[0], /"10" and "20"/)
})

check('…and the SAME value on two rows is not a conflict', () => {
  const routed = routeOf([row(), secondary()], { r1: { grit: '10' }, r2: { grit: ' 10 ' } })
  const bucket = routed.shifts.get(shiftKeyOf('2026-08-01', 'AUGUST', 'M'))!
  assert.deepEqual(bucket.conflicts, [])
  assert.deepEqual(bucket.rowIds, ['r1', 'r2'], 'both rows are settled by the one block')
})

check('an IDENTITY edit on a saved row is named, never silently dropped', () => {
  const routed = routeOf([row()], { r1: { date: '2026-08-02' } })
  assert.equal(routed.runs.size, 0)
  assert.equal(routed.problems.length, 1)
  assert.match(routed.problems[0], /DATE cannot be changed on a saved row/)
  assert.match(routed.problems[0], /2026-08-01/, 'the refusal names the row')
})

check('a row filtered out from under an edit is skipped in silence', () => {
  const routed = routeOf([row()], { 'r-gone': { ttl_kg: '1' } })
  assert.equal(routed.runs.size, 0)
  assert.deepEqual(routed.problems, [], 'its text went with it — there is nothing to warn about')
})

// ═══ The blocks — every column, always ══════════════════════════════════════════

check('the RUN block carries `sacks_bags` back — the live grid nulls it on every save', () => {
  const { block } = buildRunBlock(row(), { ttl_kg: '13000' }, DEFAULTS)
  assert.equal(block.sacks_bags, 240, 'a bag count the sheet never shows must not be erased by it')
  assert.equal(block.ttl_kg, 13000)
  // And the live grid is still doing the thing this exists to avoid.
  const live = stripComments(readFileSync(join(DAILY, 'daily-ledger-grid.tsx'), 'utf8'))
  assert.ok(live.includes('sacks_bags: null'), 'the live grid stopped nulling the bag count — re-read this rule')
})

check('a TTL KG edit leaves CUSTOMER / GRADE / REM at their stored values', () => {
  const { block } = buildRunBlock(row(), { ttl_kg: '13000' }, DEFAULTS)
  assert.equal(block.customer, 'CEBU')
  assert.equal(block.grade, '3X50')
  assert.equal(block.remarks, 'ran clean')
})

check('an edit that undoes itself is not a change', () => {
  assert.equal(buildRunBlock(row(), { ttl_kg: '12000' }, DEFAULTS).changed, false)
  assert.equal(buildRunBlock(row(), { ttl_kg: '12000.0' }, DEFAULTS).changed, false, 'a different spelling of one number')
  assert.equal(buildRunBlock(row(), { ttl_kg: '12001' }, DEFAULTS).changed, true)
})

check('a cleared REM is a change, and it clears', () => {
  const { block, changed } = buildRunBlock(row(), { run_remarks: '' }, DEFAULTS)
  assert.equal(changed, true)
  assert.equal(block.remarks, null)
})

check('the WASTE block carries all eight streams and the remark the sheet never shows', () => {
  const { block, changed } = buildWasteBlock(row(), { rs1a: '99' })
  assert.equal(changed, true)
  assert.equal(block.rs1a_kg, 99)
  assert.deepEqual(
    [block.rs1b_kg, block.bf_kg, block.rs23_kg, block.rs5_kg, block.trml1_kg, block.trml2_kg, block.grit_kg],
    [20, 30, 40, 50, 60, 70, 80],
    'the seven streams nobody typed into must ride back unchanged',
  )
  assert.equal(block.remarks, 'sifted twice', '63 stored waste remarks the live save erases')
})

check('a cleared waste stream is zero kilograms, not a hole', () => {
  const { block, changed } = buildWasteBlock(row(), { grit: '' })
  assert.equal(changed, true)
  assert.equal(block.grit_kg, 0)
})

check('the DOWNTIME block rides back on the STORED shift length — never a fabricated 8', () => {
  const { block, shiftHrs } = buildDowntimeBlock(row(), { dt_hrs: '2' }, 9)
  assert.equal(block.shift_hrs, 9, 'measured: every stored shift_hrs is 9 or 12, and none is 8')
  assert.equal(shiftHrs, 9)
  assert.equal(block.dt_hrs, 2)
  assert.equal(block.dt_mins, 30, 'the minutes nobody typed into ride along')
  assert.equal(block.dt_reason, 'belt change')
})

check('…and 8 is used ONLY where there is no downtime row to preserve', () => {
  const fresh = row({ dt_hrs: '', dt_mins: '', dt_reason: '', _ids: { shift_id: 's9', run_id: 'r9' } })
  const { block } = buildDowntimeBlock(fresh, { dt_hrs: '1' }, null)
  assert.equal(block.shift_hrs, ASSUMED_SHIFT_HRS)
  assert.equal(ASSUMED_SHIFT_HRS, 8, 'the sheet\'s own PROD HRS arithmetic assumes it')
})

check('the downtime write is STILL gated on shift_hrs in the action this is built around', () => {
  const src = stripComments(readFileSync(join(DAILY, 'actions.ts'), 'utf8'))
  assert.ok(src.includes('const hasDowntimeData = dt.shift_hrs !== null'),
    'the action no longer gates the downtime write on shift_hrs — re-read `buildDowntimeBlock`')
  // …and the live grid still sends null there, which is why it has never written one.
  const live = stripComments(readFileSync(join(DAILY, 'daily-ledger-grid.tsx'), 'utf8'))
  assert.ok(live.includes('shift_hrs: null'), 'the live grid stopped sending a null shift length')
})

// ═══ The plan ═══════════════════════════════════════════════════════════════════

check('a waste edit posts ONE row — the primary — carrying a waste block and no downtime', () => {
  const plan = planOf({ rows: [row(), secondary()], edits: { r1: { rs1a: '99' } } })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.payload.length, 1)
  const p = plan.payload[0]
  assert.equal(p._ids?.run_id, 'r1')
  assert.equal(p.downtime, null, 'nothing was typed into the downtime lanes')
  assert.equal(p.waste!.rs1a_kg, 99)
  assert.deepEqual(plan.savedRowIds, ['r1'])
})

check('a run edit posts one row with NO shift blocks at all', () => {
  const plan = planOf({ rows: [row(), secondary()], edits: { r2: { ttl_kg: '4500' } } })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.payload.length, 1, 'the sibling row is not touched')
  assert.equal(plan.payload[0]._ids?.run_id, 'r2')
  assert.equal(plan.payload[0].downtime, null)
  assert.equal(plan.payload[0].waste, null)
  assert.equal(plan.payload[0].run.ttl_kg, 4500)
})

check('only the rows that need writing are posted — a clean sheet posts nothing', () => {
  const plan = planOf({ rows: [row(), secondary()], edits: {} })
  assert.deepEqual(plan.payload, [])
  assert.deepEqual(plan.problems, [])
})

check('a shift-lane edit typed on the primary pulls in NO other row of the shift', () => {
  const plan = planOf({ rows: [row(), secondary()], edits: { r1: { dt_hrs: '3' } } })
  assert.equal(plan.payload.length, 1)
  assert.equal(plan.payload[0].downtime!.dt_hrs, 3)
  assert.equal(plan.payload[0].downtime!.shift_hrs, 9)
})

check('a downtime longer than the shift is refused, and the shift length is NAMED', () => {
  const plan = planOf({ rows: [row()], edits: { r1: { dt_hrs: '10' } } })
  assert.equal(plan.payload.length, 0)
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /10\.50 h/)
  assert.match(plan.problems[0], /9 h/)
})

check('a stored 4X8 run refuses EVERY cell on it, by name, before anything is posted', () => {
  const plan = planOf({ rows: [row({ grade: '4X8' })], edits: { r1: { ttl_kg: '9000' } } })
  assert.equal(plan.payload.length, 0)
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /4X8/)
  assert.match(plan.problems[0], /2026-08-01/, 'and it names the row')
})

check('a shift with no run row in the database refuses its waste rather than inventing a run', () => {
  const placeholder = row({ _ids: { shift_id: 's1' }, grade: '', ttl_kg: '' })
  const plan = planOf({ rows: [placeholder], edits: { '2026-08-01|AUGUST|M#norun': { rs1a: '5' } } })
  assert.equal(plan.payload.length, 0)
  assert.match(plan.problems.join(' '), /no run row in the database/)
})

check('an identity edit on a saved row stops the WHOLE save — nothing is posted', () => {
  const plan = planOf({ rows: [row()], edits: { r1: { shift_code: 'E', ttl_kg: '13000' } } })
  assert.ok(plan.problems.length > 0)
  assert.match(plan.problems[0], /SHIFT cannot be changed on a saved row/)
})

check('an edit that merges back to the stored value settles its row and posts nothing', () => {
  const plan = planOf({ rows: [row()], edits: { r1: { ttl_kg: '12,000' } } })
  assert.deepEqual(plan.problems, [])
  assert.deepEqual(plan.payload, [])
  assert.deepEqual(plan.savedRowIds, ['r1'], 'its text is settled, so the cell must not stay lit forever')
})

check('every row whose text rode into a shift block is settled by that block', () => {
  const plan = planOf({ rows: [row(), secondary()], edits: { r1: { grit: '11' }, r2: { grit: '11' } } })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.payload.length, 1)
  assert.deepEqual(plan.savedRowIds.sort(), ['r1', 'r2'], 'r2 typed into r1\'s payload and must be forgotten with it')
})

check('a refused carrier settles nobody', () => {
  const plan = planOf({ rows: [row({ grade: '4X8' }), secondary()], edits: { r1: { grit: '11' } } })
  assert.ok(plan.problems.length > 0)
  assert.deepEqual(plan.savedRowIds, [])
})

// ═══ Blank rows ═════════════════════════════════════════════════════════════════

const D1 = 'dailydraft:test-1'
const D2 = 'dailydraft:test-2'

check('a blank row starts with the live ledger\'s own four seeds', () => {
  assert.equal(draftFieldText('date', DEFAULTS), '2026-08-26')
  assert.equal(draftFieldText('shift_code', DEFAULTS), 'M')
  assert.equal(draftFieldText('customer', DEFAULTS), DEFAULT_CUSTOMER)
  assert.equal(DEFAULT_CUSTOMER, 'CEBU')
  assert.equal(draftFieldText('grade', DEFAULTS), '', 'a grade is never guessed')
  assert.equal(draftFieldText('rs1a', DEFAULTS), '')
})

check('a typed blank row becomes a NEW run, with no ids and the seeded identity', () => {
  const plan = planOf({
    rows: [row()],
    edits: { [D1]: { grade: '6X50', ttl_kg: '7000' } },
    drafts: [D1],
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.payload.length, 1)
  const p = plan.payload[0]
  assert.equal(p._state, 'new')
  assert.deepEqual(p._ids, {})
  assert.deepEqual(p.shift, { transaction_date: '2026-08-26', production_batch: 'AUGUST', shift: 'M' })
  assert.equal(p.run.customer, 'CEBU')
  assert.equal(p.run.grade, '6X50')
  assert.equal(p.run.ttl_kg, 7000)
  assert.equal(p.run.sacks_bags, null, 'a new run has no bag count to preserve')
  assert.deepEqual(plan.savedDraftIds, [D1])
  assert.equal(plan.counts.newRuns, 1)
})

check('a new run needs a GRADE and a TTL KG — neither is defaulted into existence', () => {
  const noGrade = planOf({ rows: [row()], edits: { [D1]: { ttl_kg: '7000' } }, drafts: [D1] })
  assert.match(noGrade.problems.join(' '), /GRADE must be one of/)
  const noKg = planOf({ rows: [row()], edits: { [D1]: { grade: '6X50' } }, drafts: [D1] })
  assert.match(noKg.problems.join(' '), /needs a TTL KG/)
  assert.match(noKg.problems.join(' '), /type 0/, 'and it says how to mean zero on purpose')
})

check('a new run with no BATCH is refused rather than booked against a guess', () => {
  const plan = buildDailySavePlan({
    edits: { [D1]: { grade: '6X50', ttl_kg: '7000' } },
    dirtyRecords: [],
    dirtyDrafts: new Set([D1]),
    draftIds: [D1],
    rowsById: new Map(),
    rows: [],
    shiftHrsByShiftId: new Map(),
    // The sheet spans two batches, so no batch is seeded.
    defaults: { ...DEFAULTS, batch: '' },
    env: ENV,
  })
  assert.equal(plan.payload.length, 0)
  assert.match(plan.problems.join(' '), /needs a BATCH/)
})

check('a blank row may open a NEW shift and carry its downtime and waste', () => {
  const plan = planOf({
    rows: [],
    edits: { [D1]: { date: '2026-08-27', grade: '3X50', ttl_kg: '9000', rs1a: '12', dt_hrs: '1' } },
    drafts: [D1],
  })
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.payload.length, 1)
  assert.equal(plan.payload[0].waste!.rs1a_kg, 12)
  assert.equal(plan.payload[0].downtime!.dt_hrs, 1)
  assert.equal(plan.payload[0].downtime!.shift_hrs, ASSUMED_SHIFT_HRS, 'a brand-new shift has no stored length')
})

check('two blank rows of one new shift disagreeing about a waste stream are refused', () => {
  const plan = planOf({
    rows: [],
    edits: {
      [D1]: { date: '2026-08-27', grade: '3X50', ttl_kg: '1', rs1a: '5' },
      [D2]: { date: '2026-08-27', grade: '6X50', ttl_kg: '2', rs1a: '9' },
    },
    drafts: [D1, D2],
  })
  assert.equal(plan.payload.length, 0)
  assert.match(plan.problems.join(' '), /RS1A as "5" and "9"/)
})

check('an untouched blank row is scaffolding, not unsaved work', () => {
  const plan = planOf({ rows: [row()], edits: {}, drafts: [D1, D2] })
  assert.deepEqual(plan.payload, [])
  assert.deepEqual(plan.savedDraftIds, [])
})

// ═══ Counting and naming ════════════════════════════════════════════════════════

check('unsaved work is counted the way it will be SAVED, not by row', () => {
  const rowsById = new Map<string, LedgerRow>([['r1', row()], ['r2', secondary()]])
  const work = countDailyUnsaved({
    edits: { r1: { grit: '1' }, r2: { grit: '1', ttl_kg: '5' }, [D1]: { grade: '3X50' } },
    dirtyRecords: ['r1', 'r2'],
    dirtyDrafts: new Set([D1]),
    draftIds: [D1],
    rowsById,
    defaults: DEFAULTS,
  })
  assert.equal(work.shifts, 1, 'one waste figure across two rows is ONE save')
  assert.equal(work.runs, 1, 'only r2 carries run-lane text')
  assert.equal(work.newRuns, 1)
  assert.equal(work.total, 3)
})

check('the unsaved chip never names a kind that is zero', () => {
  assert.equal(describeDailyUnsaved({ runs: 0, shifts: 0, newRuns: 0, total: 0 }), 'nothing unsaved')
  assert.equal(describeDailyUnsaved({ runs: 1, shifts: 0, newRuns: 0, total: 1 }), '1 edited run')
  assert.equal(
    describeDailyUnsaved({ runs: 2, shifts: 1, newRuns: 3, total: 6 }),
    '2 edited runs, 1 edited shift and 3 new runs',
  )
})

check('a row is named well enough to be found in the sheet', () => {
  assert.equal(rowLabel(row()), '2026-08-01 · AUGUST · M · 3X50')
  assert.equal(rowLabel(row({ date: '', batch: '', grade: '' })), 'undated · no batch · M')
  assert.equal(draftRowLabel({ grade: '6X50' }, DEFAULTS), 'new run 2026-08-26 · AUGUST · M · 6X50')
})

check('stored text is ONE function — what a cell compares against IS what the save reads', () => {
  assert.equal(savedFieldText(row(), 'ttl_kg'), '12000')
  assert.equal(savedFieldText(row(), 'waste_remarks'), 'sifted twice')
  assert.equal(savedFieldText(null, 'ttl_kg'), '')
  assert.equal(savedFieldText(row({ run_remarks: '' }), 'run_remarks'), '')
})

// ═══ What the server said ═══════════════════════════════════════════════════════

check('the failure message does NOT claim nothing was written — this action is not transactional', () => {
  const msg = dailySaveFailureMessage({ editedRuns: 2, editedShifts: 1, newRuns: 0 }, 'Invalid grade.')
  assert.doesNotMatch(msg, /nothing was written/i, 'RC IN can say that; this action applies shift by shift')
  assert.match(msg, /NOT rolled back/)
  assert.match(msg, /reload/i)
  assert.match(msg, /Invalid grade\./, 'the database\'s own sentence is appended, never swallowed')
  assert.match(msg, /2 edited runs/)
})

check('the action really does apply shift by shift, with no transaction around it', () => {
  const src = stripComments(readFileSync(join(DAILY, 'actions.ts'), 'utf8'))
  assert.ok(src.includes('for (const [, group] of shiftGroups)'), 'the shift-group loop moved — re-read the failure message')
  assert.ok(!/\bbegin\b|\brpc\('fn_bulk/i.test(src), 'the action grew a transaction — the refusal wording can now be stronger')
})

// ═══ Source scans ═══════════════════════════════════════════════════════════════

check('the save model is PURE — no React, no Supabase, no server action call', () => {
  const src = stripComments(readFileSync(join(DAILY, 'daily-grid-v2-save.ts'), 'utf8'))
  assert.ok(src.includes('export function buildDailySavePlan'), 'the strip ate the file — every scan below would pass vacuously')
  assert.ok(!src.includes("from 'react'"), 'a pure module must not import React')
  assert.ok(!src.includes('use client'), 'a pure module is not a client component')
  assert.ok(!src.includes('createClient'), 'a pure module must not reach the database')
  // The only two imports from the live ledger and the action are TYPE-only, so nothing
  // this module pulls in can execute.
  assert.match(src, /import type \{ LedgerRowPayload \} from '\.\/actions'/)
  assert.match(src, /import type \{ GridRow as LedgerRow \} from '\.\/daily-ledger-grid'/)
})

check('the grid builds NO payload of its own — the plan is the single source', () => {
  const src = stripComments(readFileSync(join(DAILY, 'daily-grid-v2.tsx'), 'utf8'))
  assert.ok(src.includes('buildDailySavePlan'), 'the grid no longer uses the plan builder')
  assert.ok(!src.includes('_state:'), 'a payload assembled in the grid would be a second definition of the save')
  assert.ok(!src.includes('shift_hrs:'), 'the shift length is the plan builder\'s business')
  assert.equal(
    (src.match(/saveBulkDailyLedger\(/g) ?? []).length,
    1,
    'there must be exactly one call site for the server action',
  )
})

check('every error surface in the grid is the persistent, copyable one', () => {
  const src = stripComments(readFileSync(join(DAILY, 'daily-grid-v2.tsx'), 'utf8'))
  assert.ok(src.includes('errorToast('), 'the HARD RULE: an error must persist and be copyable')
  assert.ok(!src.includes('toast.error('), 'sonner\'s auto-dismissing error toast is forbidden')
})

check('the live ledger, its action and the mobile cards are untouched by this pass', () => {
  // Not a diff — a property. This grid must not have grown an import INTO the live files,
  // and the live ledger must still export the row model this one renders.
  const live = readFileSync(join(DAILY, 'daily-ledger-grid.tsx'), 'utf8')
  assert.ok(live.includes('export function buildGridRows'), 'the row model is imported, never restated')
  assert.ok(!live.includes('daily-grid-v2'), 'the live ledger must know nothing about the migration')
  const cards = readFileSync(join(DAILY, 'daily-cards-mobile.tsx'), 'utf8')
  assert.ok(!cards.includes('daily-grid-v2'), 'the phone card list is not part of this pass')
})

check('the row families use the save model\'s OWN editability rule, not a second copy', () => {
  const src = stripComments(readFileSync(join(DAILY, 'daily-grid-v2.tsx'), 'utf8'))
  assert.ok(src.includes('storedRowFieldIsEditable(colKey)'), 'the stored-row rule must come from the save model')
  assert.ok(src.includes('isDailyEditField(colKey)'), 'and so must the field vocabulary')
  assert.ok(!/const EDITABLE_FIELDS/.test(src), 'the local field set was replaced by the shared one')
})


console.log(`\n${passed} assertions passed.\n`)
