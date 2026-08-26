/**
 * verify-qc-grid.ts — framework-free assertions over the QC ledger v2 grid's PURE
 * edit + save model (`app/(app)/cenapro/qc/qc-grid-v2-save.ts`). No DB, no browser,
 * no test framework.
 *
 * Built in the idiom of `scripts/verify-rc-in-grid.ts` and
 * `scripts/verify-rc-deliveries-cells.ts`, for the third instance of that shape. It
 * exists because the four things this grid can most easily get silently WRONG are not
 * observable from the screen:
 *
 *   1. **WHICH ROW an edit is a save to.** A lab metric is displayed on a draw and
 *      belongs to that draw's SAMPLE GROUP; a weight belongs to the draw alone. Route
 *      a metric to the draw and the reading is posted with a weight RPC's arguments;
 *      route a weight to the group and every sibling draw is restated.
 *   2. **The metric MERGE.** `cenapro_save_analysis_sample` REPLACES the reading — an
 *      omitted metric is CLEARED on the UPDATE path (`actions.ts::buildArgs` says so in
 *      its own comment). So typing an ASH onto a group that already carries a BD must
 *      send the BD back too, or the BD is deleted on a successful save with no error.
 *   3. **`rowVersion`.** The group save is compare-and-set; a payload that dropped the
 *      version would either clobber someone else's reading or come back
 *      `already_exists` on a group the operator is looking at.
 *   4. **What may be FORGOTTEN.** `TableEdits.forget` works on whole rows, and one QC
 *      row can carry two changes with two independent verdicts. Forgetting a row
 *      because its GROUP saved would throw away a WT edit that came back `conflict`.
 *
 * Run: npx tsx scripts/verify-qc-grid.ts
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METRICS } from '@/lib/cenapro/ccc-analysis'
import type { MetricValues } from '@/lib/cenapro/ccc-analysis-view'
import {
  DRAFT_PREFIX,
  QC_COLUMNS,
  QC_IMPORTED_COLUMNS,
  QC_ROW_FIELDS,
  buildQcSavePlan,
  cleanPastedQcCell,
  countQcUnsaved,
  describeQcUnsaved,
  draftFromEdits,
  drawInputLabel,
  drawLabel,
  forgettableRowIds,
  groupLabel,
  hasAnyReading,
  isDraftKey,
  isImportedColumn,
  isMetricField,
  isQcField,
  machineCodes,
  makeDraftIds,
  normalizeQcField,
  overlayMetrics,
  parseQcField,
  qcDrawFailureMessage,
  qcSampleFailureMessage,
  qcWeightFailureMessage,
  routeQcEdits,
  storedRowFieldIsEditable,
  type QcFieldEnv,
  type QcSaveRow,
  type RowEditMap,
} from '@/app/(app)/cenapro/qc/qc-grid-v2-save'
import type { QcDraw, QcDrawOptions, QcGroup } from '@/app/(app)/cenapro/qc/data'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GRID = join(ROOT, 'app/(app)/cenapro/qc/qc-ledger-grid-v2.tsx')
const SAVE = join(ROOT, 'app/(app)/cenapro/qc/qc-grid-v2-save.ts')
const ACTIONS = join(ROOT, 'app/(app)/cenapro/qc/actions.ts')
/**
 * The production ledger's own column table — READ, never edited, and never re-typed here.
 *
 * The QC sheet's arrangement is supposed to BE this one (Renzo, 2026-08-25: *"exact the
 * same arrangement as the current prod ledger"*). Copying its keys into this file would
 * make the assertion agree with a snapshot instead of with the ledger, so a column added
 * or moved over there would keep passing.
 */
const PROD_SHARED = join(ROOT, 'app/(app)/cenapro/production/production-grid-v2-shared.tsx')

/**
 * Executable code only. These files' comments discuss the very identifiers the source
 * scans forbid — that is what the comments are FOR — so a scan over raw text would trip
 * on the prose explaining the rule. The `[^:]` guard keeps a `https://` inside a future
 * string from decapitating a line.
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

// ═══ Fixtures ═══════════════════════════════════════════════════════════════════

const OPTIONS: QcDrawOptions = {
  sources: ['TNK 1', 'TNK 2', 'W6', 'W7', 'FLEC'],
  crushers: ['C1', 'C2', 'C3', 'C4'],
  kilns: ['RK1', 'RK2', 'RK3', 'RK4'],
  grades: ['3X50', '2X6', '3.5', '4X8'],
  shifts: ['M', 'E', 'N'],
  warehouses: ['WHSE 1', 'WHSE 2', 'WHSE 5', 'WHSE 7'],
  sides: ['LS', 'RS'],
  error: null,
}

const ENV: QcFieldEnv = { options: OPTIONS, contextYear: 2026 }

function draw(id: string, over: Partial<QcDraw> = {}): QcDraw {
  return {
    id,
    recvDate: '2026-08-01',
    prodDate: '2026-07-31',
    shift: 'M',
    grade: '3X50',
    plant: 'W6',
    weightKg: 9583.5,
    equip: 'C1',
    flecCount: null,
    side: null,
    ...over,
  }
}

/** A group with a reading on file — BD and MC logged, ASH and GRIT still blank. */
function group(over: Partial<QcGroup> = {}): QcGroup {
  const sample: MetricValues = { bd: 0.52, ash: null, grit: null, mc: 12.5 }
  return {
    key: '2026-08-01|TNK 1|W6',
    date: '2026-08-01',
    src: 'TNK 1',
    whse: 'W6',
    isDvo: false,
    totalKg: 19167,
    sample,
    rowVersion: 7,
    draws: [],
    ...over,
  }
}

/** One group, two draws — the exact shape the two-family row model exists for. */
function twoDrawGroup(): { g: QcGroup; lead: QcSaveRow; sibling: QcSaveRow } {
  const g = group()
  const a = draw('draw-a')
  const b = draw('draw-b', { equip: 'C2', weightKg: 9583.5 })
  g.draws = [a, b]
  return {
    g,
    lead: { draw: a, group: g, isFirstOfGroup: true },
    sibling: { draw: b, group: g, isFirstOfGroup: false },
  }
}

function rowIndex(...rows: QcSaveRow[]): ReadonlyMap<string, QcSaveRow> {
  return new Map(rows.map((r) => [r.draw.id, r]))
}

/** A blank row's edits, keyed by this grid's COLUMN keys. */
function draftEdits(over: Record<string, string> = {}): Record<string, string> {
  return {
    date: '2026-08-02',
    src: 'TNK 1',
    mach: 'C1',
    grade: '3X50',
    shift: 'M',
    wt: '12000',
    ...over,
  }
}

// ═══ 1 · Routing — WHICH row does an edit save to ═══════════════════════════════

check('a metric edit on the LEAD draw patches the GROUP, never the draw', () => {
  const { g, lead, sibling } = twoDrawGroup()
  const edits: RowEditMap = { 'draw-a': { ash: '3.14' } }
  const routed = routeQcEdits(edits, ['draw-a'], rowIndex(lead, sibling))

  assert.equal(routed.weightByDraw.size, 0, 'a metric edit is not a weight write')
  assert.equal(routed.metricsByGroup.size, 1)
  const bucket = routed.metricsByGroup.get(g.key)
  assert.ok(bucket, 'the edit is filed under the GROUP key, not the draw id')
  assert.deepEqual(bucket.edits, { ash: '3.14' })
  assert.deepEqual(bucket.rowIds, ['draw-a'])
  assert.equal(routed.problems.length, 0)
  // The draw id must appear nowhere in the routing result's keys.
  assert.equal(routed.metricsByGroup.has('draw-a'), false)
})

check('a WT edit patches ONLY its own draw — no sibling, no group', () => {
  const { g, lead, sibling } = twoDrawGroup()
  const edits: RowEditMap = { 'draw-b': { wt: '10500' } }
  const routed = routeQcEdits(edits, ['draw-b'], rowIndex(lead, sibling))

  assert.equal(routed.metricsByGroup.size, 0, 'a weight is never a group write')
  assert.deepEqual([...routed.weightByDraw.keys()], ['draw-b'])
  assert.equal(routed.weightByDraw.has('draw-a'), false, 'the sibling draw is untouched')
  assert.equal(routed.weightByDraw.get('draw-b')!.row.group.key, g.key)
})

check('two draws of one group merge into ONE reading, and one save', () => {
  // Structurally the metric cells only exist on the lead draw — but routing by the
  // GROUP rather than by the row is what makes that guarantee not the only thing
  // standing between a reading and the wrong sample group.
  const { g, lead, sibling } = twoDrawGroup()
  const edits: RowEditMap = { 'draw-a': { ash: '3.14' }, 'draw-b': { grit: '1.20' } }
  const routed = routeQcEdits(edits, ['draw-a', 'draw-b'], rowIndex(lead, sibling))

  assert.equal(routed.metricsByGroup.size, 1, 'one group, one bucket')
  assert.deepEqual(routed.metricsByGroup.get(g.key)!.edits, { ash: '3.14', grit: '1.20' })
  assert.deepEqual(routed.metricsByGroup.get(g.key)!.rowIds, ['draw-a', 'draw-b'])
})

check('a field with no write path on a stored row is REFUSED BY NAME, never dropped', () => {
  const { lead } = twoDrawGroup()
  const routed = routeQcEdits({ 'draw-a': { src: 'W7' } }, ['draw-a'], rowIndex(lead))
  assert.equal(routed.metricsByGroup.size, 0)
  assert.equal(routed.weightByDraw.size, 0)
  assert.equal(routed.problems.length, 1)
  assert.match(routed.problems[0], /SRC cannot be changed on a saved draw/)
})

check('a stored row exposes exactly WT and the four metrics', () => {
  assert.equal(storedRowFieldIsEditable('wt'), true)
  for (const metric of METRICS) assert.equal(storedRowFieldIsEditable(metric), true)
  for (const field of QC_ROW_FIELDS) {
    if (field === 'wt') continue
    assert.equal(storedRowFieldIsEditable(field), false, `${field} has no write path`)
  }
})

// ═══ 2 · The MERGE — the group RPC REPLACES the reading ═════════════════════════

check('a partial metric edit carries the UNTOUCHED metrics back unchanged', () => {
  const g = group() // bd 0.52, mc 12.5, ash/grit null
  const merged = overlayMetrics(g.sample, { ash: '3.14' })
  assert.equal(merged.errors.length, 0)
  assert.equal(merged.changed, true)
  // THE assertion this file exists for. Omitting a metric CLEARS it server-side, so
  // every one of the four rides along whether it was typed into or not.
  assert.deepEqual(merged.values, { bd: 0.52, ash: 3.14, grit: null, mc: 12.5 })
})

check('the merge decision reaches the PAYLOAD, not just the helper', () => {
  const { g, lead } = twoDrawGroup()
  const plan = buildQcSavePlan({
    edits: { 'draw-a': { ash: '3.14' } },
    dirtyRecords: ['draw-a'],
    dirtyDrafts: new Set(),
    draftIds: [],
    rowsById: rowIndex(lead),
    groups: [g],
    env: ENV,
  })
  assert.equal(plan.problems.length, 0)
  assert.equal(plan.samples.length, 1)
  const s = plan.samples[0]
  assert.equal(s.key, g.key)
  assert.equal(s.bd, 0.52, 'the stored BD is re-sent — omitting it would DELETE it')
  assert.equal(s.mc, 12.5, 'the stored MC is re-sent')
  assert.equal(s.ash, 3.14)
  assert.equal(s.grit, null)
  // The natural key is the group's, verbatim from the read model.
  assert.equal(s.sampleDate, '2026-08-01')
  assert.equal(s.sourceLocationCode, 'TNK 1')
  assert.equal(s.whseKey, 'W6')
})

check('rowVersion is carried through UNCHANGED — null creates, an integer updates', () => {
  const { g, lead } = twoDrawGroup()
  const one = buildQcSavePlan({
    edits: { 'draw-a': { ash: '3.14' } },
    dirtyRecords: ['draw-a'],
    dirtyDrafts: new Set(),
    draftIds: [],
    rowsById: rowIndex(lead),
    groups: [g],
    env: ENV,
  })
  assert.equal(one.samples[0].expectedRowVersion, 7)

  const fresh = group({ sample: null, rowVersion: null })
  const draws = [draw('draw-c')]
  fresh.draws = draws
  const row: QcSaveRow = { draw: draws[0], group: fresh, isFirstOfGroup: true }
  const two = buildQcSavePlan({
    edits: { 'draw-c': { bd: '0.48' } },
    dirtyRecords: ['draw-c'],
    dirtyDrafts: new Set(),
    draftIds: [],
    rowsById: rowIndex(row),
    groups: [fresh],
    env: ENV,
  })
  assert.equal(two.samples[0].expectedRowVersion, null, 'no stored reading ⇒ INSERT')
  assert.deepEqual(
    { bd: two.samples[0].bd, ash: two.samples[0].ash, grit: two.samples[0].grit, mc: two.samples[0].mc },
    { bd: 0.48, ash: null, grit: null, mc: null },
  )
})

check('a metric CLEARED is an explicit null, and clearing them ALL is refused', () => {
  const partial = overlayMetrics(group().sample, { bd: '' })
  assert.deepEqual(partial.values, { bd: null, ash: null, grit: null, mc: 12.5 })
  assert.equal(hasAnyReading(partial.values), true)

  const emptied = overlayMetrics(group().sample, { bd: '', mc: '' })
  assert.equal(hasAnyReading(emptied.values), false)

  const { g, lead } = twoDrawGroup()
  const plan = buildQcSavePlan({
    edits: { 'draw-a': { bd: '', mc: '' } },
    dirtyRecords: ['draw-a'],
    dirtyDrafts: new Set(),
    draftIds: [],
    rowsById: rowIndex(lead),
    groups: [g],
    env: ENV,
  })
  assert.equal(plan.samples.length, 0, 'nothing is posted')
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /at least one of BD \/ ASH \/ GRIT \/ MC/)
  assert.ok(plan.problems[0].startsWith(groupLabel(g)), 'the group is named')
})

check('an unreadable metric is named, never coerced to a number', () => {
  // The live ledger's private `overlay` runs `Number.parseFloat`, which reads "1O.2" as
  // 1 and would save it. `parseMetricValue` — the RPC's own shared twin — refuses.
  const merged = overlayMetrics(group().sample, { ash: '1O.2' })
  assert.equal(merged.errors.length, 1)
  assert.match(merged.errors[0], /ASH must be a plain number/)
  assert.equal(merged.values.ash, null, 'nothing is written for a refused value')
  // And a range violation is refused too — the four CHECK constraints, client-side.
  assert.equal(overlayMetrics(null, { ash: '140' }).errors.length, 1)
  assert.equal(overlayMetrics(null, { bd: '0' }).errors.length, 1, 'BD is > 0, exclusive')
})

check('a metric typed back to the stored value produces NO payload', () => {
  const { g, lead } = twoDrawGroup()
  const plan = buildQcSavePlan({
    // `12.50` over a stored `12.5` — still an edit in the edit map (the text differs),
    // and nothing to write.
    edits: { 'draw-a': { mc: '12.50' } },
    dirtyRecords: ['draw-a'],
    dirtyDrafts: new Set(),
    draftIds: [],
    rowsById: rowIndex(lead),
    groups: [g],
    env: ENV,
  })
  assert.equal(plan.problems.length, 0)
  assert.equal(plan.samples.length, 0, 'an edit that undoes itself is not an edit')
})

// ═══ 3 · Weights ════════════════════════════════════════════════════════════════

check('a weight payload carries the value the operator was LOOKING AT', () => {
  const { g, lead, sibling } = twoDrawGroup()
  const plan = buildQcSavePlan({
    edits: { 'draw-b': { wt: '10,500' } },
    dirtyRecords: ['draw-b'],
    dirtyDrafts: new Set(),
    draftIds: [],
    rowsById: rowIndex(lead, sibling),
    groups: [g],
    env: ENV,
  })
  assert.equal(plan.problems.length, 0)
  assert.equal(plan.samples.length, 0, 'a weight never restates the group reading')
  assert.equal(plan.weights.length, 1)
  assert.equal(plan.weights[0].id, 'draw-b')
  assert.equal(plan.weights[0].expectedWeightKg, 9583.5, 'compare-and-set on the stored value')
  assert.equal(plan.weights[0].raw, '10,500', 'the RAW text goes to the server, which parses it')
})

check('a weight typed back to the stored value produces NO payload', () => {
  const { g, lead } = twoDrawGroup()
  const plan = buildQcSavePlan({
    edits: { 'draw-a': { wt: '9583.5' } },
    dirtyRecords: ['draw-a'],
    dirtyDrafts: new Set(),
    draftIds: [],
    rowsById: rowIndex(lead),
    groups: [g],
    env: ENV,
  })
  assert.equal(plan.weights.length, 0)
  assert.equal(plan.problems.length, 0)
})

check('an emptied or impossible WT is refused by name — nothing is written', () => {
  const { g, lead } = twoDrawGroup()
  for (const [text, pattern] of [['', /weight is required/], ['0', /positive number/], ['abc', /plain number/]] as const) {
    const plan = buildQcSavePlan({
      edits: { 'draw-a': { wt: text } },
      dirtyRecords: ['draw-a'],
      dirtyDrafts: new Set(),
      draftIds: [],
      rowsById: rowIndex(lead),
      groups: [g],
      env: ENV,
    })
    assert.equal(plan.weights.length, 0, `"${text}" must not be posted`)
    assert.equal(plan.problems.length, 1)
    assert.match(plan.problems[0], pattern)
    assert.ok(plan.problems[0].startsWith(drawLabel(lead)), 'the draw is named')
  }
})

// ═══ 4 · One verdict, shared by the cell and the save ═══════════════════════════

check('a BLANK cell commits without complaint in every lane', () => {
  for (const field of [...QC_ROW_FIELDS, ...METRICS]) {
    assert.equal(parseQcField(field, '', ENV).ok, true, `${field} blank`)
    assert.equal(parseQcField(field, '   ', ENV).ok, true, `${field} whitespace`)
  }
})

check('a closed-domain cell refuses an unknown code and LISTS the legal ones', () => {
  const bad = parseQcField('mach', 'C9', ENV)
  assert.equal(bad.ok, false)
  // The list ends in FLEC since 2026-08-26: the MACH cell now also names a BAGGING entry,
  // and a refusal that did not offer it would be telling the operator a legal row is not.
  assert.match(
    (bad as { error: string }).error,
    /MACH "C9" is not one of: C1, C2, C3, C4, RK1, RK2, RK3, RK4, FLEC\./,
  )
  // Case and spacing are the operator's business, not the matcher's.
  assert.equal(parseQcField('mach', ' c1 ', ENV).ok, true)
  assert.equal(parseQcField('src', 'tnk 1', ENV).ok, true)
  assert.equal(parseQcField('src', 'TNK  1', ENV).ok, true, 'internal whitespace collapses')
  assert.equal(parseQcField('src', 'DVO', ENV).ok, false, 'DVO is not offered — the RPC refuses it')
  assert.deepEqual(machineCodes(OPTIONS), ['C1', 'C2', 'C3', 'C4', 'RK1', 'RK2', 'RK3', 'RK4', 'FLEC'])
  // The bagging token is a LEGAL machine here, not a near-miss like `C9`.
  assert.equal(parseQcField('mach', 'FLEC', ENV).ok, true)
})

check('DATE speaks every form the operators use, and refuses a non-date', () => {
  assert.equal(parseQcField('date', '6/27', ENV).ok, true)
  assert.equal(parseQcField('date', '2026-06-27', ENV).ok, true)
  assert.equal(parseQcField('prod', '27 Jun 26', ENV).ok, true)
  const bad = parseQcField('date', '2026-02-30', ENV)
  assert.equal(bad.ok, false, 'a shape test alone would wave a non-existent day through')
  assert.match((bad as { error: string }).error, /^DATE — /)
})

check('BAGS is whole flecs', () => {
  assert.equal(parseQcField('bags', '48', ENV).ok, true)
  assert.equal(parseQcField('bags', '1,200', ENV).ok, true)
  assert.equal(parseQcField('bags', '4.5', ENV).ok, false)
})

check('normalize canonicalises and NEVER refuses', () => {
  assert.equal(normalizeQcField('date', '6/27', ENV), '2026-06-27')
  assert.equal(normalizeQcField('prod', '2026-06-27', ENV), '2026-06-27')
  assert.equal(normalizeQcField('mach', ' c1 ', ENV), 'C1')
  assert.equal(normalizeQcField('src', 'tnk  1', ENV), 'TNK 1')
  // Unreadable text is kept VERBATIM — the operator's typing is never replaced by a
  // guess, and `parseQcField` refuses it by name immediately afterwards.
  assert.equal(normalizeQcField('date', 'not a date', ENV), 'not a date')
  assert.equal(normalizeQcField('wt', '10,500', ENV), '10,500', 'a number keeps its own text')
  for (const field of [...QC_ROW_FIELDS, ...METRICS]) {
    assert.equal(typeof normalizeQcField(field, 'x', ENV), 'string')
  }
})

check('a pasted cell is cleaned per column, and a pasted date takes the SAME year', () => {
  assert.equal(cleanPastedQcCell('date', ' 6/27 ', ENV), '2026-06-27')
  assert.equal(cleanPastedQcCell('wt', ' ₱ 10,500 ', ENV), '10,500')
  assert.equal(cleanPastedQcCell('mach', ' c1\r', ENV), 'C1')
  assert.equal(cleanPastedQcCell('bd', ' 0.52 ', ENV), '0.52')
})

// ═══ 5 · Draft rows — the composer's rules, verbatim ════════════════════════════

check('a draft row maps this grid COLUMN KEYS onto the composer interface', () => {
  const d = draftFromEdits('qcdraft:1', { ...draftEdits(), prod: '2026-08-01', bd: '0.5', plant: 'W7' })
  assert.equal(d.id, 'qcdraft:1')
  assert.equal(d.anchorDate, null, 'the pool is layout only, never a date')
  assert.equal(d.recvDate, '2026-08-02')
  assert.equal(d.prodDate, '2026-08-01')
  assert.equal(d.src, 'TNK 1')
  assert.equal(d.mach, 'C1')
  assert.equal(d.wt, '12000')
  assert.equal(d.plant, 'W7')
  assert.deepEqual(d.metrics, { bd: '0.5', ash: '', grit: '', mc: '' })
  assert.equal(d.status, 'draft')
})

check('a legal draft becomes ONE AddQcDrawRow, dates already normalised', () => {
  const plan = buildQcSavePlan({
    edits: { 'qcdraft:9': draftEdits({ date: '8/2', bd: '0.51' }) },
    dirtyRecords: [],
    dirtyDrafts: new Set(['qcdraft:9']),
    draftIds: ['qcdraft:9'],
    rowsById: new Map(),
    groups: [],
    env: ENV,
  })
  assert.equal(plan.problems.length, 0)
  assert.equal(plan.draws.length, 1)
  assert.equal(plan.draws[0].rowId, 'qcdraft:9')
  assert.equal(plan.draws[0].input.recvDate, '2026-08-02', 'a bare 8/2 takes the focused year')
  assert.equal(plan.draws[0].input.sourceLocationCode, 'TNK 1')
  assert.deepEqual(plan.draws[0].metrics, { bd: '0.51' })
  // The reading rides with the row and the SERVER files it against whichever sample
  // group the insert actually reported. Nothing here derives a group key for it.
  assert.equal('sampleGroup' in plan.draws[0], false)
})

check('FLEC needs a warehouse and a bag count; nothing else may carry them', () => {
  const flecOk = buildQcSavePlan({
    edits: { 'qcdraft:1': draftEdits({ src: 'FLEC', whse: 'WHSE 7', bags: '48', side: 'LS' }) },
    dirtyRecords: [],
    dirtyDrafts: new Set(['qcdraft:1']),
    draftIds: ['qcdraft:1'],
    rowsById: new Map(),
    groups: [],
    env: ENV,
  })
  assert.equal(flecOk.problems.length, 0)
  assert.equal(flecOk.draws.length, 1)
  assert.equal(flecOk.draws[0].input.warehouseCode, 'WHSE 7')
  assert.equal(flecOk.draws[0].input.flecCountRaw, '48')
  assert.equal(flecOk.draws[0].input.whseSide, 'LS')

  const noBags = buildQcSavePlan({
    edits: { 'qcdraft:1': draftEdits({ src: 'FLEC', whse: 'WHSE 7' }) },
    dirtyRecords: [], dirtyDrafts: new Set(['qcdraft:1']), draftIds: ['qcdraft:1'],
    rowsById: new Map(), groups: [], env: ENV,
  })
  assert.equal(noBags.draws.length, 0)
  assert.match(noBags.problems[0], /a FLEC draw needs a bag count/)

  const noWhse = buildQcSavePlan({
    edits: { 'qcdraft:1': draftEdits({ src: 'FLEC', bags: '48' }) },
    dirtyRecords: [], dirtyDrafts: new Set(['qcdraft:1']), draftIds: ['qcdraft:1'],
    rowsById: new Map(), groups: [], env: ENV,
  })
  assert.equal(noWhse.draws.length, 0)
  assert.match(noWhse.problems[0], /a FLEC draw needs a warehouse/)

  const tankWithBags = buildQcSavePlan({
    edits: { 'qcdraft:1': draftEdits({ src: 'TNK 1', bags: '48' }) },
    dirtyRecords: [], dirtyDrafts: new Set(['qcdraft:1']), draftIds: ['qcdraft:1'],
    rowsById: new Map(), groups: [], env: ENV,
  })
  assert.equal(tankWithBags.draws.length, 0)
  assert.match(tankWithBags.problems[0], /carries no warehouse, bags or side/)

  const tankWithSide = buildQcSavePlan({
    edits: { 'qcdraft:1': draftEdits({ src: 'W7', side: 'RS' }) },
    dirtyRecords: [], dirtyDrafts: new Set(['qcdraft:1']), draftIds: ['qcdraft:1'],
    rowsById: new Map(), groups: [], env: ENV,
  })
  assert.equal(tankWithSide.draws.length, 0)
  assert.match(tankWithSide.problems[0], /carries no warehouse, bags or side/)
})

check('every missing required field is named, and the row is named with it', () => {
  for (const [drop, pattern] of [
    ['date', /needs a date/],
    ['src', /needs a source/],
    ['mach', /needs a machine/],
    ['grade', /needs a grade/],
    ['shift', /needs a shift/],
    ['wt', /needs a weight/],
  ] as const) {
    const e = draftEdits()
    delete (e as Record<string, string>)[drop]
    const plan = buildQcSavePlan({
      edits: { 'qcdraft:1': e },
      dirtyRecords: [], dirtyDrafts: new Set(['qcdraft:1']), draftIds: ['qcdraft:1'],
      rowsById: new Map(), groups: [], env: ENV,
    })
    assert.equal(plan.draws.length, 0, `a row with no ${drop} must not be sent`)
    assert.equal(plan.problems.length, 1)
    assert.match(plan.problems[0], pattern)
    assert.match(plan.problems[0], /^new draw /, 'the blank row names itself')
  }
})

check('a PLANT override is sent; a blank PLANT means FOLLOW SRC and sends nothing', () => {
  const derived = buildQcSavePlan({
    edits: { 'qcdraft:1': draftEdits() },
    dirtyRecords: [], dirtyDrafts: new Set(['qcdraft:1']), draftIds: ['qcdraft:1'],
    rowsById: new Map(), groups: [], env: ENV,
  })
  assert.equal(derived.draws[0].input.plant, undefined, 'a derived value is never echoed back as supplied')

  const overridden = buildQcSavePlan({
    edits: { 'qcdraft:1': draftEdits({ plant: 'W7' }) },
    dirtyRecords: [], dirtyDrafts: new Set(['qcdraft:1']), draftIds: ['qcdraft:1'],
    rowsById: new Map(), groups: [], env: ENV,
  })
  assert.equal(overridden.draws[0].input.plant, 'W7')
})

check('two drafts landing in one sample group with different readings are REFUSED', () => {
  const plan = buildQcSavePlan({
    edits: {
      'qcdraft:1': draftEdits({ bd: '0.50' }),
      'qcdraft:2': draftEdits({ mach: 'C2', bd: '0.60' }),
    },
    dirtyRecords: [],
    dirtyDrafts: new Set(['qcdraft:1', 'qcdraft:2']),
    draftIds: ['qcdraft:1', 'qcdraft:2'],
    rowsById: new Map(),
    groups: [],
    env: ENV,
  })
  assert.equal(plan.problems.length, 1)
  assert.match(plan.problems[0], /2 new draws land in the sample group/)
  assert.match(plan.problems[0], /BD as 0\.50 and 0\.60/)
})

check('a UNION across two drafts in one group is NOT a conflict', () => {
  const plan = buildQcSavePlan({
    edits: {
      'qcdraft:1': draftEdits({ bd: '0.50' }),
      'qcdraft:2': draftEdits({ mach: 'C2', mc: '11.0' }),
    },
    dirtyRecords: [],
    dirtyDrafts: new Set(['qcdraft:1', 'qcdraft:2']),
    draftIds: ['qcdraft:1', 'qcdraft:2'],
    rowsById: new Map(),
    groups: [],
    env: ENV,
  })
  assert.equal(plan.problems.length, 0, 'a slip that splits its analysis across lines is legal')
  assert.equal(plan.draws.length, 2)
})

check('an UNTOUCHED blank row is scaffolding — never a payload, never a refusal', () => {
  const plan = buildQcSavePlan({
    edits: {},
    dirtyRecords: [],
    dirtyDrafts: new Set(),
    draftIds: makeDraftIds(10),
    rowsById: new Map(),
    groups: [],
    env: ENV,
  })
  assert.equal(plan.draws.length, 0)
  assert.equal(plan.problems.length, 0)
})

check('every group on screen contributes its version to groupVersions', () => {
  const a = group()
  const b = group({ key: '2026-08-01|W7|W7', src: 'W7', whse: 'W7', rowVersion: null })
  const plan = buildQcSavePlan({
    edits: { 'qcdraft:1': draftEdits() },
    dirtyRecords: [], dirtyDrafts: new Set(['qcdraft:1']), draftIds: ['qcdraft:1'],
    rowsById: new Map(), groups: [a, b], env: ENV,
  })
  // A new draw joining an EXISTING group whose reading is logged must UPDATE it against
  // that version, or the RPC answers `already_exists` on a group the operator can see.
  assert.deepEqual(plan.groupVersions, { '2026-08-01|TNK 1|W6': 7, '2026-08-01|W7|W7': null })
})

// ═══ 6 · Nothing is written unless EVERY dirty row is legal ═════════════════════

check('one illegal row keeps the LEGAL ones out of the payload too', () => {
  const { g, lead, sibling } = twoDrawGroup()
  const plan = buildQcSavePlan({
    edits: {
      'draw-a': { ash: '3.14' }, // legal
      'draw-b': { wt: 'abc' },   // not
      'qcdraft:1': draftEdits({ mach: '' }), // not
    },
    dirtyRecords: ['draw-a', 'draw-b'],
    dirtyDrafts: new Set(['qcdraft:1']),
    draftIds: ['qcdraft:1'],
    rowsById: rowIndex(lead, sibling),
    groups: [g],
    env: ENV,
  })
  assert.equal(plan.problems.length, 2, 'both refusals are named')
  // The plan still builds the legal halves — the ADAPTER is what refuses the whole
  // batch on a non-empty `problems`, and the grid source scan below pins that.
  assert.equal(plan.samples.length, 1)
  assert.equal(plan.weights.length, 0)
})

// ═══ 7 · What may be FORGOTTEN ══════════════════════════════════════════════════

check('a row is forgotten only when EVERY change on it landed', () => {
  const { g, lead } = twoDrawGroup()
  const edits: RowEditMap = { 'draw-a': { ash: '3.14', wt: '10500' } }
  const base = {
    edits,
    dirtyRecords: ['draw-a'],
    rowsById: rowIndex(lead),
    sentGroupKeys: new Set([g.key]),
    sentDrawIds: new Set(['draw-a']),
  }

  // Both landed.
  assert.deepEqual(
    forgettableRowIds({ ...base, savedGroupKeys: new Set([g.key]), savedDrawIds: new Set(['draw-a']) }),
    ['draw-a'],
  )
  // The reading landed, the weight conflicted — the row KEEPS its typing, or the
  // operator's WT is gone on a save that reported a failure they can no longer act on.
  assert.deepEqual(
    forgettableRowIds({ ...base, savedGroupKeys: new Set([g.key]), savedDrawIds: new Set() }),
    [],
  )
  // And the mirror image.
  assert.deepEqual(
    forgettableRowIds({ ...base, savedGroupKeys: new Set(), savedDrawIds: new Set(['draw-a']) }),
    [],
  )
})

check('a field that produced NO payload counts as settled', () => {
  const { g, lead } = twoDrawGroup()
  // `12.50` over a stored `12.5`: an edit in the map, nothing to write. Without this
  // clause the row could never stop counting as unsaved.
  assert.deepEqual(
    forgettableRowIds({
      edits: { 'draw-a': { mc: '12.50' } },
      dirtyRecords: ['draw-a'],
      rowsById: rowIndex(lead),
      sentGroupKeys: new Set(),
      savedGroupKeys: new Set(),
      sentDrawIds: new Set(),
      savedDrawIds: new Set(),
    }),
    ['draw-a'],
  )
  assert.equal(g.key.includes('|'), true)
})

check('a saved GROUP forgets every row that typed into it, not just the lead', () => {
  const { g, lead, sibling } = twoDrawGroup()
  assert.deepEqual(
    forgettableRowIds({
      edits: { 'draw-a': { ash: '3.14' }, 'draw-b': { grit: '1.2' } },
      dirtyRecords: ['draw-a', 'draw-b'],
      rowsById: rowIndex(lead, sibling),
      sentGroupKeys: new Set([g.key]),
      savedGroupKeys: new Set([g.key]),
      sentDrawIds: new Set(),
      savedDrawIds: new Set(),
    }),
    ['draw-a', 'draw-b'],
  )
})

// ═══ 8 · Counting, naming, and the verdict sentences ═══════════════════════════

check('unsaved work is counted the way it will be SAVED', () => {
  const { lead, sibling } = twoDrawGroup()
  const work = countQcUnsaved(
    { 'draw-a': { ash: '3.14', wt: '1' }, 'draw-b': { grit: '1.2' }, 'qcdraft:1': { date: 'x' } },
    ['draw-a', 'draw-b'],
    new Set(['qcdraft:1']),
    rowIndex(lead, sibling),
  )
  // Four metric cells across two rows of ONE group are ONE reading and one save.
  assert.deepEqual(work, { readings: 1, weights: 1, draws: 1, total: 3 })
  assert.equal(describeQcUnsaved(work), '1 edited reading, 1 edited weight and 1 new draw')
  assert.equal(
    describeQcUnsaved({ readings: 2, weights: 0, draws: 0, total: 2 }),
    '2 edited readings',
    'a kind that is zero is never printed',
  )
  assert.equal(describeQcUnsaved({ readings: 0, weights: 0, draws: 0, total: 0 }), 'nothing unsaved')
})

check('every refusal names something the operator can find in the sheet', () => {
  const { g, lead } = twoDrawGroup()
  assert.equal(groupLabel(g), '2026-08-01 · TNK 1 · W6')
  assert.equal(drawLabel(lead), '2026-08-01 · TNK 1 · W6 · C1')
  assert.equal(
    drawInputLabel({ recvDate: '2026-08-02', sourceLocationCode: 'FLEC', partnerEquipmentCode: 'RK2' }),
    'new draw 2026-08-02 · FLEC · RK2',
  )
})

check("the database's own sentence is APPENDED, never swallowed", () => {
  assert.match(
    qcSampleFailureMessage('invalid_key', 'whse_key was blank'),
    /could not identify this sample group\. whse_key was blank/,
  )
  assert.match(qcWeightFailureMessage('conflict', 'now 9,600'), /now 9,600/)
  assert.match(qcDrawFailureMessage('invalid_key', 'no such grade'), /no such grade/)
  // A conflict is explained, never retried or force-written.
  assert.match(qcSampleFailureMessage('version_conflict', null), /nothing was written/)
  assert.match(qcWeightFailureMessage('conflict', null), /nothing was written/)
  // A duplicate is the operator's call and is NOT confirmed silently.
  assert.match(qcDrawFailureMessage('duplicate_warning', null), /nothing was written/)
})

check('draft ids are prefixed, unique and recognisable', () => {
  const ids = makeDraftIds(3)
  assert.equal(new Set(ids).size, 3)
  for (const id of ids) {
    assert.ok(id.startsWith(DRAFT_PREFIX))
    assert.equal(isDraftKey(id), true)
  }
  assert.equal(isDraftKey('7b3f2c5e-0000-4000-8000-000000000000'), false)
  assert.equal(isQcField('wt'), true)
  assert.equal(isQcField('bd'), true)
  assert.equal(isQcField('nonsense'), false)
  assert.equal(isMetricField('bd'), true)
  assert.equal(isMetricField('wt'), false)
})

// ═══ 8b · The ARRANGEMENT (2026-08-25) ═════════════════════════════════════════
//
// Renzo asked for the QC sheet's columns to be laid out exactly like the Cenapro
// PRODUCTION ledger's, so an operator who types production rows all day can type a QC row
// without re-learning the order — and for the production columns QC lacks to be imported
// rather than dropped, so the shape stays recognisable.
//
// Two things could go silently wrong, and neither is visible from the save model alone:
// the two arrangements drifting apart (a column moved on the production side would never
// be noticed here), and the reorder quietly changing WHAT AN EDIT SAVES TO. The first is
// answered by reading the production ledger's own column table off disk; the second by
// running the same edits through the router twice, with the fields presented in the OLD
// order and the NEW one, and requiring identical payloads.

/** The production ledger's column keys, left to right, parsed from its own `COLS`. */
function productionColumnKeys(): string[] {
  const src = readFileSync(PROD_SHARED, 'utf8')
  const block = /const COLS: readonly ProdCol\[\] = \[([\s\S]*?)\n\];/.exec(src)
  assert.ok(block, 'the production ledger column table must still be findable')
  const keys = [...block[1].matchAll(/\{\s*key: '([^']+)'/g)].map((m) => m[1])
  assert.ok(keys.length >= 10, 'an empty extraction is a FAILURE, never a vacuous pass')
  return keys
}

/**
 * The four lanes the two screens spell differently and mean identically.
 *
 * `recv` is the receipt date; `source` is the source location; `ccc` is the production
 * ledger's merged `CCC/FLEC` label, whose content is the partner machine QC calls `mach`
 * (the machine ALONE decides the disposition — `actions.ts` says so); `flec` is the bag
 * count QC calls `bags`.
 */
const PROD_TO_QC: Readonly<Record<string, string>> = {
  recv: 'date',
  source: 'src',
  ccc: 'mach',
  flec: 'bags',
}

check('the QC arrangement IS the production ledger\'s, column for column', () => {
  const prod = productionColumnKeys()
  const expected = prod.map((k) => PROD_TO_QC[k] ?? k)
  assert.deepEqual(
    [...QC_COLUMNS].slice(0, expected.length),
    expected,
    'QC_COLUMNS must open with the production ledger\'s own order, under QC\'s names',
  )
  // And the four lab lanes are what QC adds where the production ledger runs out.
  assert.deepEqual([...QC_COLUMNS].slice(expected.length), [...METRICS])
})

check('every QC column is either a typeable field or one of the two IMPORTED lanes', () => {
  for (const key of QC_COLUMNS) {
    if (isImportedColumn(key)) {
      // THE rule for an imported lane: it must not accept text, and the way that is made
      // structural is that no field of that name exists for a `parse` to be built from.
      assert.equal(isQcField(key), false, `${key} must never be a QcField`)
      continue
    }
    assert.equal(isQcField(key), true, `${key} must be a field the save model knows`)
  }
  assert.deepEqual([...QC_IMPORTED_COLUMNS], ['num', 'batch'])
  // The arrangement carries every typeable field exactly once — nothing was dropped in
  // the reorder, and nothing was added that the save model cannot answer for.
  const typeable = QC_COLUMNS.filter((k) => !isImportedColumn(k))
  assert.equal(typeable.length, QC_ROW_FIELDS.length + METRICS.length)
  assert.deepEqual([...typeable].sort(), [...QC_ROW_FIELDS, ...METRICS].sort())
})

check('the REORDER cannot change what an edit saves to', () => {
  const { g, lead, sibling } = twoDrawGroup()
  const rows = rowIndex(lead, sibling)

  // The SAME edits, with the fields presented in the order the sheet used BEFORE the
  // 2026-08-25 rearrangement and in the order it uses now. A payload that depended on
  // column order would differ; one routed by field name cannot.
  const OLD_ORDER = ['date', 'prod', 'shift', 'grade', 'plant', 'whse', 'side', 'bags', 'src', 'mach', 'wt']
  const NEW_ORDER = [...QC_ROW_FIELDS]
  assert.notDeepEqual(OLD_ORDER, NEW_ORDER, 'the two orders must actually differ, or this proves nothing')

  const typed: Record<string, string> = { wt: '4321', ash: '3.14' }
  const inOrder = (order: readonly string[]) => {
    const out: Record<string, string> = {}
    for (const field of [...order, ...METRICS]) {
      if (typed[field] !== undefined) out[field] = typed[field]
    }
    return out
  }

  const build = (order: readonly string[]) =>
    buildQcSavePlan({
      edits: { 'draw-a': inOrder(order) } as RowEditMap,
      dirtyRecords: ['draw-a'],
      dirtyDrafts: new Set<string>(),
      draftIds: [],
      rowsById: rows,
      groups: [g],
      env: ENV,
    })

  const before = build(OLD_ORDER)
  const after = build(NEW_ORDER)
  assert.deepEqual(after.samples, before.samples)
  assert.deepEqual(after.weights, before.weights)
  assert.deepEqual(after.draws, before.draws)
  assert.deepEqual(after.problems, before.problems)
  // …and it is not vacuous: both really did build the two payloads.
  assert.equal(after.problems.length, 0)
  assert.equal(after.weights.length, 1)
  assert.equal(after.weights[0].id, 'draw-a')
  assert.equal(after.samples.length, 1)
  assert.equal(after.samples[0].key, g.key)
  assert.equal(after.samples[0].bd, 0.52, 'the untouched stored BD still rides back')
})

check('a draft still maps every typeable lane onto the composer\'s own interface', () => {
  // The reorder moved SIDE / BAGS to the end of the row lanes and pulled SRC / WT
  // forward. `draftFromEdits` reads by NAME, so the mapping is unchanged — asserted
  // rather than assumed, because a positional mapping would have broken silently here.
  const d = draftFromEdits('qcdraft:9', {
    date: '2026-08-01',
    prod: '2026-07-31',
    shift: 'M',
    grade: '3X50',
    plant: 'W6',
    whse: 'WHSE 1',
    src: 'FLEC',
    wt: '9583.5',
    mach: 'C1',
    bags: '12',
    side: 'LS',
    bd: '0.52',
  })
  assert.equal(d.recvDate, '2026-08-01')
  assert.equal(d.prodDate, '2026-07-31')
  assert.equal(d.src, 'FLEC')
  assert.equal(d.mach, 'C1')
  assert.equal(d.wt, '9583.5')
  assert.equal(d.bags, '12')
  assert.equal(d.side, 'LS')
  assert.equal(d.whse, 'WHSE 1')
  assert.equal(d.metrics.bd, '0.52')
})

// ═══ 9 · Source scans ══════════════════════════════════════════════════════════

check('the grid holds no second definition of a cell verdict', () => {
  const src = stripComments(readFileSync(GRID, 'utf8'))
  assert.ok(src.includes('parseQcField'), 'the scan target must still exist')
  // Every `parse` / `normalize` / `cleanPasted` goes through the save module, so a
  // value typed and the same value refused at save cannot disagree.
  assert.equal(src.includes('parseMetricValue'), false, 'the grid never parses a metric itself')
  assert.equal(src.includes('parseWeightKg'), false, 'the grid never parses a weight itself')
  assert.equal(src.includes('parseQcDate'), false, 'the grid never parses a date itself')
})

check('the grid RENDERS from QC_COLUMNS — the arrangement is not a description', () => {
  const src = stripComments(readFileSync(GRID, 'utf8'))
  assert.ok(src.includes('QC_COLUMNS'), 'the scan target must still exist')
  // The column table is ONE spec per key, laid out by the shared constant. A second
  // literal ordering in this file would make `QC_COLUMNS` — and every assertion above
  // that reads it — a comment about the sheet rather than the sheet itself.
  assert.match(
    src,
    /const SPECS: readonly ColumnSpec<QcRow, Ctx>\[\] = QC_COLUMNS\.map\(/,
    'SPECS must be QC_COLUMNS mapped through the per-key table',
  )
  assert.match(src, /const SPEC_BY_KEY: Record<QcColumnKey, ColumnSpec<QcRow, Ctx>>/)

  // The frozen identity block is the production ledger's: four start-pinned columns.
  // (`SIDE` is deliberately NOT end-pinned here — an end-pinned run must be the table's
  // trailing columns, and QC's four lab lanes sit to its right.)
  const prodSrc = readFileSync(PROD_SHARED, 'utf8')
  const prodBlock = /const COLS: readonly ProdCol\[\] = \[([\s\S]*?)\n\];/.exec(prodSrc)
  assert.ok(prodBlock, 'the production ledger column table must still be findable')
  const prodStartPins = [...prodBlock[1].matchAll(/pin: 'start'/g)].length
  const qcStartPins = [...src.matchAll(/pin: 'start'/g)].length
  assert.equal(prodStartPins, 4, 'the production ledger pins # · Recv · Prod · Batch')
  assert.equal(qcStartPins, prodStartPins, 'QC must freeze the same identity block')
  assert.equal(src.includes("pin: 'end'"), false, 'nothing may be end-pinned ahead of the lab lanes')
})

check('the grid refuses the WHOLE batch when any dirty row is illegal', () => {
  const src = stripComments(readFileSync(GRID, 'utf8'))
  assert.ok(src.includes('plan.problems'), 'the scan target must still exist')
  assert.match(
    src,
    /if \(plan\.problems\.length > 0\) \{[\s\S]{0,400}?return;/,
    'a non-empty problems list must return before any action is called',
  )
})

check('every error surface in the grid is the persistent, copyable one', () => {
  const src = stripComments(readFileSync(GRID, 'utf8'))
  assert.ok(src.includes('errorToast('), 'the scan target must still exist')
  // HARD RULE: errors persist until dismissed and carry a Copy button.
  assert.equal(/\btoast\.error\s*\(/.test(src), false, 'sonner toast.error is forbidden — use errorToast')
})

check('no animation was added to a row, a cell or a selection', () => {
  const src = stripComments(readFileSync(GRID, 'utf8'))
  assert.ok(src.includes('BlackwoodTable'), 'the scan target must still exist')
  for (const banned of ['animate-fade-up', 'animate-fade-in', 'animate-scale-in', 'stagger-children', 'hover-lift']) {
    assert.equal(src.includes(banned), false, `${banned} must not appear — this sheet renders 100+ rows`)
  }
})

check('the save model is PURE — no React, no Supabase, no server action call', () => {
  const src = stripComments(readFileSync(SAVE, 'utf8'))
  assert.ok(src.includes('buildQcSavePlan'), 'the scan target must still exist')
  assert.equal(/from 'react'/.test(src), false)
  assert.equal(src.includes('@/lib/supabase'), false)
  // The three actions are TYPE-only imports here; the adapter is what calls them.
  assert.match(src, /import type \{[\s\S]*?\} from '\.\/actions';/)
  assert.equal(/^import \{[^}]*\} from '\.\/actions';/m.test(src), false, 'no value import from a server module')
})

check('no new server action was written, and the three RPC callers are unchanged', () => {
  const actions = stripComments(readFileSync(ACTIONS, 'utf8'))
  // The exact three the live ledger uses, and nothing added for v2.
  for (const fn of ['saveQcSamples', 'saveQcWeights', 'addQcDraws']) {
    assert.ok(actions.includes(`export async function ${fn}`), `${fn} must still exist`)
  }
  const grid = stripComments(readFileSync(GRID, 'utf8'))
  assert.match(grid, /from '\.\/actions'/)
  assert.equal(grid.includes('createClient'), false, 'the grid never touches Supabase')
  assert.equal(grid.includes("'use server'"), false)
})

check('there is no save-time reason dialog, because no EDIT path takes a comment', () => {
  const actions = stripComments(readFileSync(ACTIONS, 'utf8'))
  assert.ok(actions.includes('cenapro_save_analysis_sample'), 'the scan target must still exist')
  assert.ok(actions.includes('cenapro_update_event_weight'), 'the scan target must still exist')

  // RC IN has a reason dialog because `bulkUpdateDeliveries` takes a `comment` the RPC
  // glues onto the row's latest `audit_logs` entry. Neither QC EDIT path has anything
  // like it: the two argument builders below carry the key, the four metrics / the two
  // weights, and nothing else. A dialog collecting a sentence with nowhere to put it
  // would be a lie about what was recorded.
  for (const arg of ['p_comment', 'p_reason', 'p_audit_note', 'p_edit_reason']) {
    assert.equal(actions.includes(arg), false, `${arg} would change the reason-dialog decision`)
  }

  // `p_notes` DOES exist — and it is not a counter-example. It belongs to
  // `cenapro_add_partner_draw` alone and is a COLUMN ON THE NEW ROW (the slip's own
  // remark), not an explanation of a change; the live composer does not offer it either
  // (`DraftDraw` has no notes field, so `draftToInput` never sets one). If it ever
  // migrates onto an edit path, the two assertions below fail together.
  assert.ok(actions.includes('p_notes'), 'the add path keeps its row-level notes column')
  assert.match(
    actions,
    /if \(notes\) args\.p_notes = notes;/,
    'p_notes is set from the ADD input only',
  )

  const grid = stripComments(readFileSync(GRID, 'utf8'))
  assert.equal(grid.includes('DialogContent'), false, 'no dialog collects a sentence with nowhere to go')
})

// ═══ 10 · A BLANK ROW'S EVERY TYPEABLE LANE (2026-08-26 regression) ════════════
//
// Renzo, driving the rearranged sheet: *"there are some columns I can't seem to
// manipulate/edit (specifically the empty ones below where we add entries)."*
//
// Measured in a browser against the real component: the fifteen typeable lanes all open
// an editor on a blank row, and the two IMPORTED ones refuse — which is the contract. The
// two that read as broken are `#` and `BATCH`, and the reason is a RENDERING rule rather
// than a verdict one: the module calls `format` only where there is row data, so on a
// blank row those two paint NOTHING and are pixel-identical to the empty cells beside
// them, while a click parked a caret on them and every keystroke then did nothing.
//
// Three things are pinned here, because each of them is a way the fix silently rots.

check('a BLANK row is editable in every lane except the two imported ones', () => {
  const src = stripComments(readFileSync(GRID, 'utf8'))
  assert.ok(src.includes('draftSlotFor'), 'the scan target must still exist')

  // THE draft-row verdict, both halves. The column's half must branch on `row === null`
  // FIRST — a draft consulting `storedRowFieldIsEditable` would refuse every dimension
  // lane on a blank row and leave only WT + the four metrics, which is exactly the shape
  // of the bug this section exists to prevent.
  assert.match(
    src,
    /editable: \(row: QcRow \| null, ctx: Ctx\) =>\s*\n?\s*ctx\.canEdit && \(row === null \|\| storedRowFieldIsEditable\(field\)\)/,
    'the column half must let a draft (row === null) through before it asks about a stored row',
  )
  // The row family's half: every non-imported lane, live.
  assert.match(
    src,
    /function draftSlotFor\(colKey: string\): CellSlot \| null \{\s*\n\s*if \(isImportedColumn\(colKey\)\) return importedSlot\(colKey\);\s*\n\s*return \{ field: colKey, editable: true \};/,
    'the draft family must return an editable slot for every column that is not imported',
  )

  // The two halves are ANDed by the module, so this is the whole set of typeable lanes on
  // a blank row — asserted against the arrangement rather than against a list typed here.
  const typeable = QC_COLUMNS.filter((key) => !isImportedColumn(key))
  assert.equal(typeable.length, 15, 'fifteen lanes are typeable on a blank row')
  for (const key of typeable) {
    assert.ok(isQcField(key), `${key} must be a QcField, or nothing could parse or save it`)
  }
  // …and `draftFromEdits` must actually carry every one of them onto the RPC's input. A
  // lane that is typeable and unmapped accepts text and then discards it, which is the
  // one behaviour worse than a lane that refuses.
  const draft = draftFromEdits('qcdraft:1', Object.fromEntries(typeable.map((k) => [k, 'x'])))
  const carried = new Set<string>([
    ...Object.entries(draft)
      .filter(([k, v]) => v === 'x' && k !== 'id' && k !== 'status')
      .map(([k]) => k),
    ...Object.entries(draft.metrics).filter(([, v]) => v === 'x').map(([k]) => k),
  ])
  assert.equal(carried.size, 15, 'every typeable lane reaches DraftDraw')
})

check('the two IMPORTED lanes SAY they are not inputs, on a blank row too', () => {
  const src = stripComments(readFileSync(GRID, 'utf8'))
  assert.ok(src.includes('importedCellClass'), 'the scan target must still exist')

  // `format` cannot run on a draft (the module passes it a non-null row by type), so the
  // ONLY seam that can paint a blank row is `cellClass` — which the module documents as
  // receiving `row === null` there. Both imported columns must use it.
  assert.equal(
    (src.match(/cellClass: importedCellClass/g) ?? []).length,
    QC_IMPORTED_COLUMNS.length,
    'every imported column declares the reference-lane paint',
  )
  // Gated on the DRAFT row, deliberately: on a stored row the ordinal and the dash already
  // carry the message, and the `—` here would double the one `format` renders.
  assert.match(
    src,
    /function importedCellClass\(row: QcRow \| null\): string \| undefined \{\s*\n\s*return row === null/,
    'the wash is applied to a blank row only',
  )

  // And the un-typeable rule itself is UNWEAKENED — no parse can exist for either key.
  for (const key of QC_IMPORTED_COLUMNS) {
    assert.equal(isQcField(key), false, `${key} must never become a QcField`)
  }
  assert.match(src, /const IMPORTED_SLOT: CellSlot = \{ field: '', editable: false, addressable: false \}/)
})

// ═══ 11 · The paint is the PRODUCTION ledger's, and there is one copy of it ═════

check('PLANT and MACH are the production ledger badges, imported not re-typed', () => {
  const src = stripComments(readFileSync(GRID, 'utf8'))
  assert.ok(src.includes('BADGE_BASE'), 'the scan target must still exist')

  // ONE definition of each colour scheme lives in the pure `../badges` module. The QC
  // PLANT dropdown has read it since 2026-08-04; the sheet now reads the same one.
  assert.match(src, /import \{ BADGE_BASE, cccFlecBadgeClass, plantBadgeClass \} from '\.\.\/badges';/)
  assert.match(src, /format: \(r\) => badge\(r\.draw\.plant, plantBadgeClass\)/)
  assert.match(src, /format: \(r\) => badge\(r\.draw\.equip, cccFlecBadgeClass\)/)

  // A second colour map in this file is the failure the shared module exists to prevent.
  for (const colour of ['emerald', 'amber-500/2', 'rose-500', 'teal-500', 'indigo-500', 'slate-500']) {
    assert.equal(src.includes(colour), false, `${colour} must come from ../badges, never from here`)
  }

  // DISPLAY ONLY. The module's own `<input>` is never wrapped, so typing and paste are
  // untouched — the idiom `badges.ts` documents in its own header.
  assert.equal(src.includes('renderEditor'), false, 'the grid declares no editor of its own')

  // And a blank value gets the dash, never an empty chip.
  assert.match(
    src,
    /function badge\(v: string \| null \| undefined, classOf: \(raw: string\) => string\): React\.ReactNode \{\s*\n\s*return v \? /,
    'a badge is rendered only when there is a value',
  )
})

check('QC badges exactly the lanes the production ledger badges', () => {
  // Read off disk, never a snapshot: a lane that gains or loses a badge over there is a
  // failing assertion here rather than a silent divergence — the same discipline the
  // ARRANGEMENT check above uses on the same file.
  const prod = stripComments(readFileSync(PROD_SHARED, 'utf8'))
  assert.ok(prod.includes('cccFlecBadgeClass'), 'the scan target must still exist')

  // Which production `case` blocks paint a badge.
  const badged = new Set<string>()
  for (const m of prod.matchAll(/case '([a-z]+)':([\s\S]*?)(?=\n        case '|\n        \/\/ Shift)/g)) {
    if (m[2].includes('BADGE_BASE')) badged.add(m[1])
  }
  assert.deepEqual([...badged].sort(), ['ccc', 'plant'], 'the production ledger badges exactly PLANT and CCC/FLEC')

  // …under the lane mapping the 2026-08-25 arrangement established.
  const LANE: Record<string, string> = { ccc: 'mach', plant: 'plant' }
  const qc = stripComments(readFileSync(GRID, 'utf8'))
  const qcBadged = new Set([...qc.matchAll(/format: \(r\) => badge\(r\.draw\.(\w+),/g)].map((m) => m[1]))
  // `equip` is what QC's row model calls the partner machine; `mach` is its column key.
  assert.deepEqual([...qcBadged].sort(), ['equip', 'plant'])
  assert.deepEqual([...badged].map((k) => LANE[k]).sort(), ['mach', 'plant'])
})

check('every metric key the sheet knows is covered above', () => {
  assert.deepEqual([...METRICS], ['bd', 'ash', 'grit', 'mc'])
})


console.log(`\n${passed} assertions passed.`)
