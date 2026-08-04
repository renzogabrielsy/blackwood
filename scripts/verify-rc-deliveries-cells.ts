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
  parseDeliveryDate,
  mergeFieldEdit,
  isDirtyFieldEdits,
  isSelectableColumn,
  columnCalcType,
  clampDraftAdd,
  countUnsavedWork,
  describeUnsavedWork,
  hasUnsavedWork,
  duplicateBadge,
  filterSpec,
  isFilterableColumn,
  FILTER_COLUMNS,
  DEFAULT_DRAFT_ROWS,
  MAX_DRAFT_ADD,
  type FieldEdits,
} from '@/app/(app)/cenapro/deliveries/types'
import {
  activeFilterCount,
  axesKey,
  buildFilterPredicates,
  dateFilterMissesPeriod,
  describeFilter,
  filteredColumnKeys,
  filterParamName,
  filtersKey,
  parseColumnFilters,
  parseIssueLens,
  parseQuery,
  parseScope,
  resolvePeriod,
  serializeColumnFilter,
  withColumnFilter,
  type ColumnFilters,
} from '@/app/(app)/cenapro/deliveries/ledger-url'

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

// ── The DATE cell — free text in, yyyy-MM-dd out ──────────────────────────────
//
// The cell stopped being a native `<input type=date>` and became a plain text cell on
// the grid's own edit path, so this is now the ONLY thing standing between an
// operator's shorthand and a wrong date on a payment ledger.

function iso(text: string, year = 2026): string {
  const r = parseDeliveryDate(text, year)
  assert.ok(!('error' in r), `expected "${text}" to parse, got: ${'error' in r ? r.error : ''}`)
  return (r as { iso: string }).iso
}

check('a bare M/D takes the ledger’s CONTEXT year, not today’s', () => {
  assert.equal(iso('6/27', 2026), '2026-06-27')
  assert.equal(iso('6/27', 2025), '2025-06-27')
  // The separator the operators actually reach for varies; all three are one date.
  assert.equal(iso('6-27', 2026), '2026-06-27')
  assert.equal(iso('6.27', 2026), '2026-06-27')
})

check('every long form the operators type lands on the same day', () => {
  for (const text of ['6/27/26', '6/27/2026', '2026-06-27', '2026/6/27', '27 Jun 26', 'Jun 27 2026']) {
    assert.equal(iso(text), '2026-06-27', text)
  }
})

check('an explicit year always beats the context year', () => {
  assert.equal(iso('6/27/25', 2026), '2025-06-27')
})

check('unreadable text is REFUSED — never silently turned into some other day', () => {
  for (const text of ['', '   ', 'abc', '13/40/26', '2026-02-30', 'next tuesday']) {
    const r = parseDeliveryDate(text, 2026)
    assert.ok('error' in r, `"${text}" must be refused, got ${JSON.stringify(r)}`)
  }
})

// ── Dirty state — an edit that undoes itself is not an edit ───────────────────
//
// The Escape bug (item 5) in its pure form: `revertChanges` restores the pre-edit
// snapshot through the same setter a keystroke uses, so the ONLY thing that can tell
// "back to stored" from "edited" is this comparison.

check('a field typed back to its stored value leaves the edit map entirely', () => {
  const stored = 'BRIX - SOUTH HILONGOS'
  const typed = mergeFieldEdit(undefined, 'supplier', 'BRIX', stored)
  assert.deepEqual(typed, { supplier: 'BRIX' })
  // …and Escape puts the snapshot back, which must ERASE the field, not re-write it.
  const reverted = mergeFieldEdit(typed, 'supplier', stored, stored)
  assert.deepEqual(reverted, {}, 'reverting to the stored value must remove the key')
  assert.equal(isDirtyFieldEdits(reverted), false, 'the row must stop counting as unsaved')
})

check('the rule is general — it is not special-cased to Escape', () => {
  const stored = '27045'
  // Two independent fields; only the one that still differs survives.
  let e: FieldEdits = mergeFieldEdit(undefined, 'wt', '=27045*88%', stored)
  e = mergeFieldEdit(e, 'truck_no', 'ABC 123', 'ABC 123')
  assert.deepEqual(e, { wt: '=27045*88%' })
  assert.equal(isDirtyFieldEdits(e), true)
  // Typing the original number back by hand is just as clean as pressing Escape.
  e = mergeFieldEdit(e, 'wt', stored, stored)
  assert.equal(isDirtyFieldEdits(e), false)
})

check('a CLEARED field is still an edit — blank ≠ unchanged', () => {
  const e = mergeFieldEdit(undefined, 'remarks', '', 'per Czarina')
  assert.deepEqual(e, { remarks: '' }, 'clearing a stored remark must survive to the patch')
})

// ── Draft rows (the blank rows at the bottom) ─────────────────────────────────

check('an untouched draft is NOT unsaved work; one typed value makes it so', () => {
  assert.equal(isDirtyFieldEdits(undefined), false)
  assert.equal(isDirtyFieldEdits({}), false)
  // Whitespace is not data — a stray space must not arm the Save button.
  assert.equal(isDirtyFieldEdits({ truck_no: '   ' }), false)
  assert.equal(isDirtyFieldEdits({ truck_no: 'ABC 123' }), true)
})

check('the seeded default date does not by itself make a draft dirty', () => {
  const seeded = '2026-06-27'
  // Re-typing the very date the row was seeded with is not an entry.
  const e = mergeFieldEdit(undefined, 'delivery_date', seeded, seeded)
  assert.deepEqual(e, {})
  assert.equal(isDirtyFieldEdits(e), false)
  // Choosing a different day is.
  assert.equal(isDirtyFieldEdits(mergeFieldEdit(undefined, 'delivery_date', '2026-06-28', seeded)), true)
})

check('the "add N more rows" count is clamped, never trusted', () => {
  assert.equal(DEFAULT_DRAFT_ROWS, 20)
  assert.equal(clampDraftAdd('20'), 20)
  assert.equal(clampDraftAdd(' 5 '), 5)
  for (const bad of ['', '0', '-3', 'abc']) assert.equal(clampDraftAdd(bad), 1, bad)
  assert.equal(clampDraftAdd('999999'), MAX_DRAFT_ADD)
})

// ── "Is there anything to lose?" — the axis-change guard's firing condition ───
//
// Changing any URL axis remounts the grid and destroys unsaved edits, so the grid
// prompts first. The prompt must fire on EXACTLY the condition that lights the Save
// button: a prompt over an empty sheet teaches the operator to click through it, and
// then it fails on the day eight hand-typed receipts are on screen.
//
// `countUnsavedWork` is the whole of that decision. It restates nothing — it counts the
// two dirty sets the grid already derives from `mergeFieldEdit` / `isDirtyFieldEdits`
// above — so these cases pin the JOIN between the two rules, not a second copy of them.

/** The two sets exactly as the grid derives them, so the composition is what is tested. */
function dirtySets(
  receiptEdits: Record<string, FieldEdits>,
  draftEdits: Record<string, FieldEdits>,
) {
  const receipts = new Set<string>()
  for (const [id, e] of Object.entries(receiptEdits)) if (Object.keys(e).length > 0) receipts.add(id)
  const drafts = new Set<string>()
  for (const [id, e] of Object.entries(draftEdits)) if (isDirtyFieldEdits(e)) drafts.add(id)
  return { receipts, drafts }
}

check('an untouched sheet has nothing to lose — the guard must not fire', () => {
  const empty = countUnsavedWork(new Set(), new Set())
  assert.deepEqual(empty, { editedReceipts: 0, newRows: 0, total: 0 })
  assert.equal(hasUnsavedWork(empty), false)

  // The realistic shape of "untouched": twenty blank rows seeded with a default date,
  // one of which was re-typed by hand with the very same date, plus a receipt cell
  // edited and Escaped back. Nothing here is work, so nothing may be prompted about.
  const seeded = '2026-06-27'
  const draftEdits: Record<string, FieldEdits> = {
    'draft-1': {},
    'draft-2': mergeFieldEdit(undefined, 'delivery_date', seeded, seeded),
    'draft-3': { truck_no: '   ' },
  }
  const receiptEdits: Record<string, FieldEdits> = {
    'rec-1': mergeFieldEdit(mergeFieldEdit(undefined, 'wt', '=27045*88%', '27045'), 'wt', '27045', '27045'),
  }
  const { receipts, drafts } = dirtySets(receiptEdits, draftEdits)
  const work = countUnsavedWork(receipts, drafts)
  assert.equal(work.total, 0, 'seeded blanks and an Escaped edit are not unsaved work')
  assert.equal(hasUnsavedWork(work), false)
})

check('the guard counts the two KINDS apart, and its total is the Save button’s', () => {
  const receiptEdits: Record<string, FieldEdits> = {
    'rec-1': mergeFieldEdit(undefined, 'remarks', 'per Czarina', ''),
    'rec-2': mergeFieldEdit(undefined, 'truck_no', 'ABC 123', 'XYZ 000'),
    // Cleared, not blank-and-unchanged: erasing a stored remark IS an edit.
    'rec-3': mergeFieldEdit(undefined, 'remarks', '', 'per Czarina'),
  }
  const draftEdits: Record<string, FieldEdits> = {
    'draft-1': mergeFieldEdit(undefined, 'supplier', 'BRIX', ''),
    'draft-2': mergeFieldEdit(undefined, 'sacks', '420', ''),
    'draft-3': {}, // never typed into
  }
  const { receipts, drafts } = dirtySets(receiptEdits, draftEdits)
  const work = countUnsavedWork(receipts, drafts)
  assert.equal(work.editedReceipts, 3)
  assert.equal(work.newRows, 2)
  // The invariant the whole guard rests on: ONE number for the chip, the Save button's
  // `disabled`, and the prompt's firing condition.
  assert.equal(work.total, work.editedReceipts + work.newRows)
  assert.equal(work.total, receipts.size + drafts.size)
  assert.equal(hasUnsavedWork(work), true)
})

check('a moisture-draw change alone is unsaved work, with no field edit at all', () => {
  // The grid folds `sampleDrafts` keys into the same receipt set; a draw edited and put
  // back matches the stored block and never enters it. Both directions must hold.
  const withDraw = countUnsavedWork(new Set(['rec-1']), new Set())
  assert.equal(withDraw.editedReceipts, 1)
  assert.equal(hasUnsavedWork(withDraw), true)
  assert.equal(hasUnsavedWork(countUnsavedWork(new Set(), new Set())), false)
})

// The other half of the firing condition: the guard is defined on the AXES KEY, not on
// the query string, because the key is what remounts the grid and destroys the work.
// This is the grid's `axesKeyOf` in its pure form — the same parsers `page.tsx` uses.
const MONTHS = ['2026-02', '2026-03', '2026-04']
function axesKeyOf(qs: string): string {
  const p = Object.fromEntries(new URLSearchParams(qs).entries())
  return axesKey({
    scope: parseScope(p.scope),
    period: resolvePeriod(MONTHS, p.year, p.month),
    issue: parseIssueLens(p.issue),
    query: parseQuery(p.q),
    filters: parseColumnFilters(p),
  })
}

check('a URL write that does NOT move the axes key must never raise the prompt', () => {
  // The focus scope resolves an absent month to the newest one with data, so writing
  // that same month explicitly changes the QUERY STRING and nothing else: React keeps
  // the component instance, every edit survives, and prompting would be crying wolf.
  assert.equal(axesKeyOf('scope=focus'), axesKeyOf('scope=focus&year=2026&month=4'))
  // Junk that resolves to the same axes is the same view, however it is spelled.
  assert.equal(axesKeyOf(''), axesKeyOf('year=1999&month=13'))
  assert.equal(axesKeyOf('q=brix'), axesKeyOf('q=%20brix%20'))
  assert.equal(axesKeyOf('issue=nonsense'), axesKeyOf(''))
  assert.equal(axesKeyOf('f_php_kg=30..40'), axesKeyOf(''), 'an unfilterable column has nowhere to land')
})

check('every axis a control can write DOES move the key — so the guard fires', () => {
  const base = axesKeyOf('')
  for (const qs of [
    'scope=focus',                       // the scope toggle
    'issue=duplicate',                   // an issue lens
    'q=czarina',                         // the search box
    'f_supplier=BRIX',                   // a set filter
    'f_remarks=czarina',                 // a text filter
    'f_moist=8..12',                     // a range filter
    'f_date=2026-04-01..2026-04-30',     // the date-range filter
  ]) {
    assert.notEqual(axesKeyOf(qs), base, `?${qs} must remount, so it must be guarded`)
  }
  // The month picker only exists in focus, where a DIFFERENT month is a real move.
  assert.notEqual(axesKeyOf('scope=focus&year=2026&month=3'), axesKeyOf('scope=focus&year=2026&month=4'))
  // Clearing filters is an axis change in the other direction, and just as destructive.
  assert.notEqual(axesKeyOf('f_supplier=BRIX&f_moist=8..12'), axesKeyOf('f_supplier=BRIX'))
})

check('the prompt names the stakes, and never names a kind that is zero', () => {
  assert.equal(
    describeUnsavedWork(countUnsavedWork(new Set(['a', 'b', 'c']), new Set(['d', 'e']))),
    '3 edited receipts and 2 typed new rows',
  )
  // Singulars, because "1 edited receipts" is how an operator learns to distrust a UI.
  assert.equal(describeUnsavedWork(countUnsavedWork(new Set(['a']), new Set(['b']))), '1 edited receipt and 1 typed new row')
  // Only the kind that exists — "and 0 typed new rows" buries the number that matters.
  assert.equal(describeUnsavedWork(countUnsavedWork(new Set(['a', 'b']), new Set())), '2 edited receipts')
  assert.equal(describeUnsavedWork(countUnsavedWork(new Set(), new Set(['a']))), '1 typed new row')
  assert.equal(describeUnsavedWork(countUnsavedWork(new Set(), new Set())), 'nothing unsaved')
})

// ── The selection pill (item 10) ──────────────────────────────────────────────

check('a range may cover TTL PRICE, which the keyboard may not', () => {
  const cols = buildColumns(true)
  const ttl = cols.find((c) => c.key === 'ttl')!
  const num = cols.find((c) => c.key === 'num')!
  assert.equal(ttl.field, null, 'TTL PRICE must stay unaddressable — it is DB-generated')
  assert.equal(isSelectableColumn(ttl), true, 'but it must be summable, or the pill is pointless')
  assert.equal(isSelectableColumn(num), false, 'a row ordinal has no arithmetic meaning')
})

check('a gated viewer’s selection space contains NO ₱ column at all', () => {
  const gated = buildColumns(false)
  const selectable = gated.filter(isSelectableColumn).map((c) => c.key)
  assert.ok(!selectable.includes('php_kg'))
  assert.ok(!selectable.includes('ttl'))
  // …and nothing left in it defaults to a peso aggregate, because none is present.
  assert.deepEqual(
    gated.filter((c) => columnCalcType(c.key) !== null).map((c) => c.key),
    ['sacks', 'wt', 'bd', 'moist', 'grit', 'ash', 'dust', 'vm', 'fc'],
  )
})

check('weights, sacks and the peso TOTAL add up; lab values and the ₱/kg RATE average', () => {
  for (const key of ['sacks', 'wt', 'ttl']) assert.equal(columnCalcType(key), 'SUM', key)
  for (const key of ['bd', 'moist', 'grit', 'ash', 'dust', 'vm', 'fc', 'php_kg']) {
    assert.equal(columnCalcType(key), 'AVERAGE', key)
  }
  // A date, a truck plate or a remark is not arithmetic.
  for (const key of ['num', 'date', 'truck', 'supplier', 'whse', 'remarks']) {
    assert.equal(columnCalcType(key), null, key)
  }
})

check('a sample sub-row contributes ONLY its lab lanes to a range', () => {
  const cols = buildColumns(true)
  // The asymmetry the pill has to respect: a range dragged across a receipt and the
  // draws beneath it covers coordinates where a draw simply has no cell.
  const onDraw = cols.filter((c) => sampleFieldFor(c.field) !== null).map((c) => c.key)
  const summableOnDraw = onDraw.filter((k) => columnCalcType(k) !== null)
  assert.deepEqual(summableOnDraw, ['bd', 'moist', 'grit', 'ash', 'dust', 'vm', 'fc'])
  // A draw has no weight, no sacks and no money — those must never join a total.
  for (const key of ['sacks', 'wt', 'php_kg', 'ttl']) {
    assert.equal(sampleFieldFor(cols.find((c) => c.key === key)!.field), null, key)
  }
})

// ── Per-column filters (item 7) ───────────────────────────────────────────────
//
// The filter grammar is pure by design, precisely so it can be asserted here rather
// than clicked through a grid. Two things matter more than the rest:
//
//   • what CANNOT be filtered — the four money/quantity columns, and the ₱ pair in
//     particular, because a filter on a price is a price ORACLE for a gated viewer:
//     binary-searching `?f_php_kg=…` against the row count would read out the number
//     the whole boundary exists to hide;
//   • that a filter is a plain conjunct on the UNCHANGED `(delivery_date, id)` order,
//     which is what leaves keyset paging correct underneath it.

check('exactly the twelve columns Renzo asked for are filterable', () => {
  assert.deepEqual(
    FILTER_COLUMNS.map((c) => c.key),
    ['date', 'truck', 'supplier', 'bd', 'moist', 'grit', 'ash', 'dust', 'vm', 'fc', 'whse', 'remarks'],
  )
  // "except weight, price and ttl price and sks".
  for (const key of ['sacks', 'wt', 'php_kg', 'ttl', 'num']) {
    assert.equal(filterSpec(key), undefined, key)
  }
  // Every spec carries BOTH halves — a kind with no column would silently no-op.
  for (const c of FILTER_COLUMNS) assert.equal(isFilterableColumn(c), true, c.key)
})

check('a ₱ column can never be filtered, however the URL is hand-crafted', () => {
  // The two ₱ columns live in PRICE_COLS, which `FILTER_COLUMNS` never consults — so
  // this holds for an UNGATED viewer too, and there is no code path to gate.
  const forged = parseColumnFilters({
    f_php_kg: '30..40',
    f_ttl: '0..1000000',
    f_wt: '0..1',
    f_sacks: '1..2',
  })
  assert.deepEqual(forged, {}, 'a forged ₱/weight/sacks filter must be dropped, not honoured')
  assert.deepEqual(buildFilterPredicates(forged), [])
  // …and a hand-built filter object naming a ₱ column produces no predicate either.
  assert.deepEqual(
    buildFilterPredicates({ php_kg: { kind: 'range', min: 30, max: 40 } } as ColumnFilters),
    [],
  )
})

check('each filter kind becomes the predicate its column expects', () => {
  const filters = parseColumnFilters({
    f_supplier: 'BRIX,PALAWAN',
    f_whse: 'WHSE A,W6 PROD',
    f_truck: 'abc',
    f_remarks: 'czarina',
    f_date: '2026-04-01..2026-04-30',
    f_moist: '8..12',
    f_bd: '0.4..',
    f_fc: '..70',
  })
  assert.deepEqual(buildFilterPredicates(filters), [
    { op: 'gte', column: 'delivery_date', value: '2026-04-01' },
    { op: 'lte', column: 'delivery_date', value: '2026-04-30' },
    { op: 'ilike', column: 'truck_no', pattern: '*abc*' },
    { op: 'in', column: 'supplier_code', values: ['BRIX', 'PALAWAN'] },
    { op: 'gte', column: 'bd', value: 0.4 },
    { op: 'gte', column: 'moisture_pct', value: 8 },
    { op: 'lte', column: 'moisture_pct', value: 12 },
    { op: 'lte', column: 'fc', value: 70 },
    { op: 'in', column: 'destination_code', values: ['WHSE A', 'W6 PROD'] },
    { op: 'ilike', column: 'remarks', pattern: '*czarina*' },
  ])
})

check('the predicate list is ordered by COLUMN, so the same filters are one request', () => {
  const a = parseColumnFilters({ f_remarks: 'x', f_supplier: 'BRIX', f_moist: '1..2' })
  const b = parseColumnFilters({ f_moist: '1..2', f_supplier: 'BRIX', f_remarks: 'x' })
  assert.deepEqual(buildFilterPredicates(a), buildFilterPredicates(b))
  assert.equal(filtersKey(a), filtersKey(b))
})

check('filter text cannot smuggle PostgREST syntax into the query string', () => {
  // `*` and `%` are ilike wildcards; `,` `(` `)` separate an or() list. A remark that
  // contained any of them would otherwise change the SHAPE of the filter, not its value.
  const f = parseColumnFilters({ f_remarks: 'a,b(c)*d%e\\f' })
  const preds = buildFilterPredicates(f)
  assert.equal(preds.length, 1)
  const p = preds[0] as { pattern: string }
  assert.equal(p.pattern, '*a b c d e f*')
  assert.ok(!/[,()%\\]/.test(p.pattern.slice(1, -1)))
})

check('an inverted range is read the only way it could have been meant', () => {
  assert.deepEqual(parseColumnFilters({ f_moist: '12..8' }).moist, { kind: 'range', min: 8, max: 12 })
  assert.deepEqual(parseColumnFilters({ f_date: '2026-04-30..2026-04-01' }).date, {
    kind: 'dateRange',
    from: '2026-04-01',
    to: '2026-04-30',
  })
})

check('a filter that says nothing is dropped rather than sent as a no-op', () => {
  for (const params of [
    { f_moist: '' },
    { f_moist: '..' },
    { f_moist: 'abc..def' },
    { f_moist: '8' }, // no `..` at all — not a range
    { f_supplier: ' , , ' },
    { f_remarks: '   ' },
    { f_date: '2026-02-30..' }, // an ISO SHAPE that is not a day
    { f_date: 'yesterday..today' },
  ]) {
    assert.deepEqual(parseColumnFilters(params), {}, JSON.stringify(params))
  }
})

check('a set filter dedupes and is capped', () => {
  assert.deepEqual(parseColumnFilters({ f_supplier: 'BRIX,BRIX, BRIX ' }).supplier, {
    kind: 'set',
    values: ['BRIX'],
  })
  const many = Array.from({ length: 500 }, (_, i) => `S${i}`).join(',')
  const parsed = parseColumnFilters({ f_supplier: many }).supplier as { values: string[] }
  assert.ok(parsed.values.length <= 64, `expected the set to be capped, got ${parsed.values.length}`)
})

check('parse → serialize → parse is a fixed point (a chip’s X cannot corrupt its neighbours)', () => {
  const params: Record<string, string> = {
    f_supplier: 'BRIX,PALAWAN',
    f_truck: 'abc',
    f_date: '2026-04-01..2026-04-30',
    f_moist: '8..12',
    f_bd: '0.4..',
  }
  const first = parseColumnFilters(params)
  const round: Record<string, string> = {}
  for (const key of filteredColumnKeys(first)) {
    const v = serializeColumnFilter(first[key])
    assert.ok(v !== null, key)
    round[filterParamName(key)] = v as string
  }
  assert.deepEqual(parseColumnFilters(round), first)
  assert.equal(activeFilterCount(first), 5)

  // Clearing ONE column leaves the other four byte-identical.
  const minusTruck = withColumnFilter(first, 'truck', null)
  // …and the survivors come back in the SHEET's column order, not insertion order.
  assert.deepEqual(filteredColumnKeys(minusTruck), ['date', 'supplier', 'bd', 'moist'])
  assert.equal(serializeColumnFilter(minusTruck.date), '2026-04-01..2026-04-30')
})

check('a filter change moves the axes key, so the client remounts on a server-fetched window', () => {
  const base = { scope: 'endless' as const, period: null, issue: null, query: '' }
  const none = axesKey({ ...base, filters: {} })
  const one = axesKey({ ...base, filters: parseColumnFilters({ f_moist: '8..12' }) })
  const two = axesKey({ ...base, filters: parseColumnFilters({ f_moist: '8..13' }) })
  assert.notEqual(none, one, 'adding a filter must change the key')
  assert.notEqual(one, two, 'changing a bound must change the key')
  assert.equal(one, axesKey({ ...base, filters: parseColumnFilters({ f_moist: '8..12' }) }))
})

check('a DATE filter outside the focused month is EXPLAINED, not left as an empty sheet', () => {
  const april = { year: 2026, month: 4 }
  const after = parseColumnFilters({ f_date: '2026-05-01..2026-05-31' })
  const before = parseColumnFilters({ f_date: '2026-01-01..2026-02-01' })
  const overlapping = parseColumnFilters({ f_date: '2026-04-06..2026-04-08' })
  assert.equal(dateFilterMissesPeriod(after, april), true)
  assert.equal(dateFilterMissesPeriod(before, april), true)
  assert.equal(dateFilterMissesPeriod(overlapping, april), false)
  // An open-ended range that reaches the month is fine; so is no period at all.
  assert.equal(dateFilterMissesPeriod(parseColumnFilters({ f_date: '..2026-04-30' }), april), false)
  assert.equal(dateFilterMissesPeriod(overlapping, null), false)
})

check('every chip says which column it is filtering', () => {
  const f = parseColumnFilters({
    f_supplier: 'BRIX,PALAWAN',
    f_truck: 'abc',
    f_moist: '8..12',
    f_bd: '0.4..',
    f_fc: '..70',
    f_date: '2026-04-01..2026-04-30',
  })
  const say = (key: string) => describeFilter(filterSpec(key)!, f[key])
  assert.equal(say('supplier'), 'SUPPLIER: BRIX, PALAWAN')
  assert.equal(say('truck'), 'TRK# contains “abc”')
  assert.equal(say('moist'), 'MOIST 8–12')
  assert.equal(say('bd'), 'BD ≥ 0.4')
  assert.equal(say('fc'), 'FC ≤ 70')
  assert.equal(say('date'), 'DATE 2026-04-01 → 2026-04-30')
})

// ── Duplicate pairing (item 9) ────────────────────────────────────────────────
//
// `is_suspected_duplicate` (22 rows, the importer's accusation against the SECOND
// copy) and `duplicate_group_key` (44 rows, the data's own statement that an exact
// twin exists) are DIFFERENT FACTS. Conflating them is what made the old lens useless:
// it showed 22 orphans and hid the 22 originals they were pasted from.

check('the flagged copy and its unflagged original get DIFFERENT badges', () => {
  const key = 'e3f2…'
  const copy = duplicateBadge({
    is_suspected_duplicate: true,
    duplicate_group_key: key,
    duplicate_group_size: 2,
    duplicate_group_ordinal: 2,
    duplicate_peer_ids: ['orig-id'],
  })!
  const original = duplicateBadge({
    is_suspected_duplicate: false,
    duplicate_group_key: key,
    duplicate_group_size: 2,
    duplicate_group_ordinal: 1,
    duplicate_peer_ids: ['copy-id'],
  })!
  assert.equal(copy.role, 'copy')
  assert.equal(copy.label, 'DUP 2/2')
  assert.deepEqual(copy.peerIds, ['orig-id'])
  assert.equal(original.role, 'twin')
  assert.equal(original.label, 'TWIN 1/2')
  assert.deepEqual(original.peerIds, ['copy-id'])
  // The original must NOT read as clean, and must NOT read as accused either.
  assert.notEqual(original.label, copy.label)
  assert.match(original.title, /flagged the other one/)
})

check('a receipt with no twin and no flag wears nothing at all', () => {
  assert.equal(
    duplicateBadge({
      is_suspected_duplicate: false,
      duplicate_group_key: null,
      duplicate_group_size: 1,
      duplicate_group_ordinal: 1,
      duplicate_peer_ids: null,
    }),
    null,
  )
  // A "group" of one is not a group — a partially-populated row must not read `1 of 1`.
  assert.equal(
    duplicateBadge({ duplicate_group_key: 'k', duplicate_group_size: 1, duplicate_group_ordinal: 1 }),
    null,
  )
})

check('a flag whose twin was edited away still says so, without inventing a peer', () => {
  // Editing either copy changes the signature, so the pair dissolves — the importer's
  // flag survives it and must not silently disappear with the group.
  const b = duplicateBadge({ is_suspected_duplicate: true, duplicate_group_key: null })!
  assert.equal(b.role, 'copy')
  assert.equal(b.label, 'DUP')
  assert.equal(b.ordinal, null)
  assert.deepEqual(b.peerIds, [], 'there is nobody to jump to — the popover must offer no peer')
  assert.match(b.title, /no exact twin/)
})

check('a NULL peer array never becomes a dangling jump target', () => {
  const b = duplicateBadge({
    is_suspected_duplicate: true,
    duplicate_group_key: 'k',
    duplicate_group_size: 2,
    duplicate_group_ordinal: 2,
    duplicate_peer_ids: null,
  })!
  assert.deepEqual(b.peerIds, [])
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
