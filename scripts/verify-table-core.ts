/**
 * verify-table-core.ts — framework-free assertions over the PLATFORM table core
 * (`lib/table/`). No DB, no browser, no React.
 *
 * This covers what the tenant suite structurally CANNOT: the Cenapro ledger has only
 * start-pinned columns, no undo, no tiling paste and no jump keys, so its 120 assertions
 * (which now run through this code via re-exports, and are the integration test for the
 * extraction) exercise none of the generalisations. Everything below is either a new
 * capability or a shape the first consumer cannot produce.
 *
 * Run: npx tsx scripts/verify-table-core.ts
 */
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  pinnedCounts,
  pinnedOffsets,
  pinnedEndOffsets,
  pinnedWidth,
  isPinned,
  columnOffsets,
  minTableWidth,
  columnScrollLeft,
  dragAutoScrollDelta,
  summarySpans,
  DRAG_EDGE_PX,
  DRAG_STEP_PX,
  parseClipboardTable,
  tsvEscape,
  clipboardNumber,
  planPaste,
  pasteRowTargets,
  tilePaste,
  mergeFieldEdit,
  isDirtyFieldEdits,
  countUnsavedWork,
  describeUnsavedWork,
  createJournal,
  invertStep,
  JOURNAL_LIMIT,
  clampDraftAdd,
  MAX_DRAFT_ADD,
  edgeJump,
  rowEdge,
  sheetCorner,
  pageJump,
  needsGroupSpacer,
} from '../lib/table/index'
import type { ColumnSpec, GridRow, JumpGrid, RowKind, SummaryLaneCol } from '../lib/table/index'
import { resolveColumns } from '../lib/hooks/use-table-columns'
import {
  resolveRows,
  columnAcceptsEdit,
  columnSelectable,
  createTableNavResolver,
} from '../lib/hooks/use-table-rows'
import { cellClassKey, createCellClassTable } from '../components/shared/table/cell-classes'
import type { CellClassKey } from '../components/shared/table/cell-classes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('\nBlackwood Table — the pure core\n')

// ═══ Pinned columns at BOTH ends ═══════════════════════════════════════════════

type Col = SummaryLaneCol & { key: string }

const both: Col[] = [
  { key: 'num', width: 40, pin: 'start' },
  { key: 'date', width: 90, pin: 'start' },
  { key: 'a', width: 100 },
  { key: 'b', width: 100, summaryLane: 'figure' },
  { key: 'c', width: 100 },
  { key: 'total', width: 120, summaryLane: 'total' },
  { key: 'actions', width: 60, pin: 'end' },
]

check('a pinned run is found at EACH end — the old boolean could only describe a prefix', () => {
  assert.deepEqual(pinnedCounts(both), { start: 2, end: 1 })
  assert.deepEqual(pinnedOffsets(both), [0, 40])
  assert.equal(pinnedWidth(both, 'start'), 130)
  assert.equal(pinnedWidth(both, 'end'), 60)
  assert.deepEqual(pinnedEndOffsets(both), [0])

  assert.ok(isPinned(both, 0) && isPinned(both, 1) && isPinned(both, 6))
  assert.ok(!isPinned(both, 2) && !isPinned(both, 5))

  // Two end-pinned columns stack right-to-left: the LAST column hugs the edge (right 0)
  // and the one before it sits outside it.
  const two: Col[] = [...both.slice(0, 6), { key: 'x', width: 50, pin: 'end' }, { key: 'y', width: 60, pin: 'end' }]
  assert.deepEqual(pinnedCounts(two), { start: 2, end: 2 })
  assert.deepEqual(pinnedEndOffsets(two), [60, 0])
  assert.equal(pinnedWidth(two, 'end'), 110)
})

check('a run STOPS at the first unpinned column — a stray pin in the middle is inert', () => {
  const stray: Col[] = [
    { key: 'a', width: 50, pin: 'start' },
    { key: 'b', width: 50 },
    { key: 'c', width: 50, pin: 'start' }, // orphaned: nothing to stick to
    { key: 'd', width: 50 },
  ]
  assert.deepEqual(pinnedCounts(stray), { start: 1, end: 0 })
  assert.equal(pinnedWidth(stray, 'start'), 50)
  assert.ok(!isPinned(stray, 2), 'an orphaned pin is laid out as an ordinary column')
})

check('a table with no pinned columns at all degenerates cleanly', () => {
  const plain: Col[] = [{ key: 'a', width: 10 }, { key: 'b', width: 20 }]
  assert.deepEqual(pinnedCounts(plain), { start: 0, end: 0 })
  assert.deepEqual(pinnedOffsets(plain), [])
  assert.deepEqual(pinnedEndOffsets(plain), [])
  assert.equal(pinnedWidth(plain, 'start'), 0)
  assert.equal(pinnedWidth(plain, 'end'), 0)
  assert.equal(minTableWidth(plain), 30)
  assert.deepEqual(columnOffsets(plain), [0, 10])
})

// ═══ The caret-follow, now with an END block ═══════════════════════════════════

check('a column is never scrolled UNDER either pinned block', () => {
  const total = minTableWidth(both) // 610
  const VIEW = 300
  const padStart = pinnedWidth(both, 'start') // 130
  const padEnd = pinnedWidth(both, 'end') // 60
  const off = columnOffsets(both)

  // A pinned column asks for nothing — it is visible at every offset.
  for (const col of [0, 1, 6]) {
    assert.equal(
      columnScrollLeft({ col, cols: both, scrollLeft: 100, clientWidth: VIEW, scrollWidth: total }),
      null,
    )
  }

  // Scrolled far right: the 'a' column is off to the left and must clear the START block.
  const toA = columnScrollLeft({ col: 2, cols: both, scrollLeft: 250, clientWidth: VIEW, scrollWidth: total })
  assert.ok(toA !== null)
  assert.ok(off[2] >= toA! + padStart, "'a' must not sit under the start block")

  // At the left: 'total' is off to the right and must clear the END block — the case
  // that did not exist before, and the one a prefix-only model gets wrong.
  const toTotal = columnScrollLeft({ col: 5, cols: both, scrollLeft: 0, clientWidth: VIEW, scrollWidth: total })
  assert.ok(toTotal !== null)
  const rightEdge = off[5] + both[5].width
  assert.ok(
    rightEdge <= toTotal! + VIEW - padEnd,
    "'total' must not sit under the end block",
  )

  // Nothing overflows ⇒ nothing scrolls, whatever is pinned.
  assert.equal(
    columnScrollLeft({ col: 3, cols: both, scrollLeft: 0, clientWidth: total, scrollWidth: total }),
    null,
  )
})

check('the drag bands are measured from the INNER edge of each pinned block', () => {
  const rect = { top: 0, bottom: 500, left: 0, right: 800 }
  const base = {
    rect, pinnedStart: 130, pinnedEnd: 60,
    scrollTop: 50, scrollLeft: 50, maxScrollTop: 999, maxScrollLeft: 999,
  }

  // Sitting ON the start block is not "near the left edge" — it is over hidden cells.
  assert.equal(dragAutoScrollDelta({ ...base, pointer: { x: 60, y: 250 } }).dx, -DRAG_STEP_PX)
  // Just inside the block's inner edge + the band still pulls…
  assert.equal(dragAutoScrollDelta({ ...base, pointer: { x: 165, y: 250 } }).dx, -DRAG_STEP_PX)
  // …and clear of it, it does not.
  assert.equal(dragAutoScrollDelta({ ...base, pointer: { x: 200, y: 250 } }).dx, 0)

  // The right band starts before the END block, for the same reason.
  assert.equal(dragAutoScrollDelta({ ...base, pointer: { x: 760, y: 250 } }).dx, DRAG_STEP_PX)
  assert.equal(dragAutoScrollDelta({ ...base, pointer: { x: 690, y: 250 } }).dx, 0)

  // The axes are independent, and each is zeroed at its wall.
  assert.deepEqual(
    dragAutoScrollDelta({ ...base, pointer: { x: 400, y: 10 } }),
    { dx: 0, dy: -DRAG_STEP_PX },
  )
  assert.equal(
    dragAutoScrollDelta({ ...base, scrollTop: 0, pointer: { x: 400, y: 10 } }).dy, 0,
  )
  assert.equal(
    dragAutoScrollDelta({ ...base, scrollLeft: 0, pointer: { x: 60, y: 250 } }).dx, 0,
  )
  assert.ok(DRAG_EDGE_PX > 0 && DRAG_STEP_PX > 0)
})

// ═══ Summary spans, driven by the lane rather than by a column key ═════════════

check('summary spans TILE any column table, for any lane arrangement', () => {
  const tiles = (cols: SummaryLaneCol[]) => {
    const s = summarySpans(cols)
    assert.equal(
      s.label + s.weight + s.note + s.total + s.trailing,
      cols.length,
      'label form must tile',
    )
    assert.equal(
      s.frozen + s.spacer + s.weight + s.note + s.total + s.trailing,
      cols.length,
      'footer form must tile',
    )
    return s
  }

  const s = tiles(both)
  assert.equal(s.frozen, pinnedCounts(both).start)
  assert.equal(s.weight, 1)
  assert.equal(s.total, 1)
  assert.equal(s.trailing, 1, 'the end-pinned actions column is covered by the filler')

  // Insert a column anywhere and the lane containing it widens on its own.
  tiles([{ key: 'extra', width: 10 } as Col, ...both])
  tiles([...both, { key: 'extra', width: 10 } as Col])
  tiles(both.slice(0, 4))

  // No lanes at all: the label swallows the row and no zero-span cell is rendered.
  const bare = summarySpans([{ width: 10 }, { width: 20 }])
  assert.equal(bare.label, 2)
  assert.equal(bare.weight, 0)
  assert.equal(bare.total, 0)
  assert.equal(bare.trailing, 0)

  // A total with no figure still tiles — the degenerate case that used to throw.
  const totalOnly = summarySpans([{ width: 10 }, { width: 20, summaryLane: 'total' }])
  assert.equal(totalOnly.weight, 0)
  assert.equal(totalOnly.total, 1)
  assert.equal(totalOnly.label + totalOnly.note + totalOnly.total + totalOnly.trailing, 2)
})

// ═══ Tiling a paste over a selection — the new v1 gesture ══════════════════════

check('ONE copied value fills the whole selected range', () => {
  const plan = tilePaste({ blockRows: 1, blockCols: 1, selRows: 5, selCols: 3 })
  assert.ok(plan.tiled)
  assert.equal(plan.rows, 5)
  assert.equal(plan.cols, 3)
  // Every target reads the single source cell.
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      assert.deepEqual(plan.source(r, c), { row: 0, col: 0 })
    }
  }
})

check('an exact-multiple selection TILES the block; anything else anchors', () => {
  // 2×2 block into a 4×4 selection → repeated four times.
  const t = tilePaste({ blockRows: 2, blockCols: 2, selRows: 4, selCols: 4 })
  assert.ok(t.tiled)
  assert.deepEqual(t.source(0, 0), { row: 0, col: 0 })
  assert.deepEqual(t.source(3, 3), { row: 1, col: 1 })
  assert.deepEqual(t.source(2, 1), { row: 0, col: 1 })

  // Not a multiple ⇒ paste once from the anchor, ignoring the selection.
  const a = tilePaste({ blockRows: 2, blockCols: 2, selRows: 3, selCols: 4 })
  assert.ok(!a.tiled)
  assert.equal(a.rows, 2)
  assert.equal(a.cols, 2)
  assert.deepEqual(a.source(1, 1), { row: 1, col: 1 })

  // Selection smaller than the block ⇒ the block wins; nothing is truncated silently.
  const small = tilePaste({ blockRows: 3, blockCols: 3, selRows: 1, selCols: 1 })
  assert.ok(!small.tiled)
  assert.equal(small.rows, 3)

  // Selection EQUAL to the block is not a tiling — it is an ordinary paste.
  assert.ok(!tilePaste({ blockRows: 2, blockCols: 2, selRows: 2, selCols: 2 }).tiled)

  // A degenerate block never claims to tile.
  assert.ok(!tilePaste({ blockRows: 0, blockCols: 0, selRows: 4, selCols: 4 }).tiled)
})

// ═══ The undo journal ══════════════════════════════════════════════════════════

const cell = (rowId: string, field: string, before: string | undefined, after: string | undefined) =>
  ({ rowId, field, before, after })

check('undo and redo walk the stack, and a new gesture truncates the redo tail', () => {
  const j = createJournal()
  assert.ok(!j.canUndo() && !j.canRedo())

  j.push({ label: 'type', cells: [cell('r1', 'wt', '10', '20')] })
  j.push({ label: 'type', cells: [cell('r1', 'wt', '20', '30')] })
  assert.deepEqual(j.size(), { undo: 2, redo: 0 })

  const u1 = j.undo()
  assert.equal(u1?.cells[0].after, '30')
  assert.deepEqual(j.size(), { undo: 1, redo: 1 })
  assert.ok(j.canRedo())

  const r1 = j.redo()
  assert.equal(r1?.cells[0].after, '30')
  assert.deepEqual(j.size(), { undo: 2, redo: 0 })

  // Undo, then do something NEW: the redone future is gone, as in every editor.
  j.undo()
  j.push({ label: 'paste', cells: [cell('r2', 'sacks', undefined, '5')] })
  assert.ok(!j.canRedo(), 'a new gesture discards the redo tail')
  assert.deepEqual(j.size(), { undo: 2, redo: 0 })

  j.clear()
  assert.deepEqual(j.size(), { undo: 0, redo: 0 })
  assert.equal(j.undo(), null)
  assert.equal(j.redo(), null)
})

check('a gesture is ONE step however many cells it touched, and an empty one is not a step', () => {
  const j = createJournal()
  const many = Array.from({ length: 300 }, (_, i) => cell(`r${i}`, 'wt', '', String(i)))
  j.push({ label: 'paste', cells: many })
  assert.deepEqual(j.size(), { undo: 1, redo: 0 }, '300 cells, one Ctrl+Z')

  // A commit that re-typed the same value moved nothing and must not eat a Ctrl+Z.
  j.push({ label: 'type', cells: [] })
  assert.deepEqual(j.size(), { undo: 1, redo: 0 })

  // …but a step that only created draft rows IS undoable.
  j.push({ label: 'paste', cells: [], draftsAdded: ['d1', 'd2'] })
  assert.deepEqual(j.size(), { undo: 2, redo: 0 })
  assert.deepEqual(j.undo()?.draftsAdded, ['d1', 'd2'])
})

check('the journal is BOUNDED — it cannot grow without limit', () => {
  const j = createJournal(5)
  for (let i = 0; i < 20; i++) j.push({ label: 'type', cells: [cell('r', 'f', String(i), String(i + 1))] })
  assert.equal(j.size().undo, 5)
  // The OLDEST were dropped, so the newest gesture is still the first thing undone.
  assert.equal(j.undo()?.cells[0].after, '20')
  assert.ok(JOURNAL_LIMIT >= 50, 'the default depth is useful, not token')
})

check('invertStep swaps before/after so an undo has ONE definition', () => {
  const step = { label: 'type', cells: [cell('r1', 'wt', '10', '20'), cell('r1', 'sacks', undefined, '5')] }
  const back = invertStep(step)
  assert.equal(back.cells[0].before, '20')
  assert.equal(back.cells[0].after, '10')
  assert.equal(back.cells[1].before, '5')
  assert.equal(back.cells[1].after, undefined, 'a field that did not exist goes back to not existing')
  // Inverting twice is the original.
  assert.deepEqual(invertStep(back).cells, step.cells)
})

// ═══ Jump navigation ═══════════════════════════════════════════════════════════

/**
 * A 6×4 sheet. `#` marks a filled cell, `.` an empty one, `x` a cell the row does not
 * have at all (a child row's missing column).
 */
function gridFrom(map: string[]): JumpGrid {
  const rows = map.map((r) => r.split(''))
  return {
    rowCount: rows.length,
    colCount: rows[0].length,
    exists: (r, c) => rows[r]?.[c] !== undefined && rows[r][c] !== 'x',
    filled: (r, c) => rows[r]?.[c] === '#',
  }
}

check('Ctrl+Arrow jumps to the edge of the data BLOCK, Sheets-style', () => {
  const g = gridFrom([
    '####',
    '##..',
    '....',
    '###.',
    '....',
    '..#.',
  ])

  // On a filled cell with a filled neighbour → the last filled cell of the block.
  assert.deepEqual(edgeJump(g, { row: 0, col: 0 }, 'right'), { row: 0, col: 3 })
  // Down column 0: rows 0,1 filled, row 2 blank → stop at row 1.
  assert.deepEqual(edgeJump(g, { row: 0, col: 0 }, 'down'), { row: 1, col: 0 })
  // At a block edge (next cell blank) → skip the gap to the next filled cell.
  assert.deepEqual(edgeJump(g, { row: 1, col: 0 }, 'down'), { row: 3, col: 0 })
  // From a BLANK cell → the NEXT filled cell, however near. Column 2 reads
  // `# . . # . #`, so from the blank at row 2 the answer is row 3, not the far end.
  assert.deepEqual(edgeJump(g, { row: 2, col: 2 }, 'down'), { row: 3, col: 2 })
  // …and from the blank at row 4, the next one down is row 5.
  assert.deepEqual(edgeJump(g, { row: 4, col: 2 }, 'down'), { row: 5, col: 2 })
  // Nothing filled that way → the far edge.
  assert.deepEqual(edgeJump(g, { row: 0, col: 3 }, 'down'), { row: 5, col: 3 })
  // At the boundary → null, so the key is a no-op rather than a re-render.
  assert.equal(edgeJump(g, { row: 0, col: 0 }, 'up'), null)
  assert.equal(edgeJump(g, { row: 0, col: 0 }, 'left'), null)
})

check('a jump steps OVER coordinates the row does not have', () => {
  // Row 1 is a child row: it has no column 0 or 1.
  const g = gridFrom([
    '####',
    'xx##',
    '####',
  ])
  // Down column 0 from row 0: row 1 has no cell there, so the run continues to row 2.
  assert.deepEqual(edgeJump(g, { row: 0, col: 0 }, 'down'), { row: 2, col: 0 })
})

check('Home / End / Ctrl+Home / Ctrl+End land on real cells only', () => {
  const g = gridFrom([
    'x###',
    '####',
    '###x',
  ])
  assert.deepEqual(rowEdge(g, { row: 0, col: 2 }, 'start'), { row: 0, col: 1 }, 'skips the missing cell')
  assert.deepEqual(rowEdge(g, { row: 2, col: 0 }, 'end'), { row: 2, col: 2 })
  assert.equal(rowEdge(g, { row: 0, col: 1 }, 'start'), null, 'already there ⇒ no move')

  assert.deepEqual(sheetCorner(g, 'start'), { row: 0, col: 1 })
  assert.deepEqual(sheetCorner(g, 'end'), { row: 2, col: 2 })
})

check('PageUp/PageDown move a VIEWPORT, measured in real row heights', () => {
  // Mixed heights, as a sheet with child rows and spacers actually has.
  const heights = [32, 26, 26, 32, 32, 26, 32, 32, 32, 32]
  // 100px of viewport from row 0: 26+26+32 = 84, +32 = 116 ≥ 100 → row 4.
  assert.equal(pageJump({ rowHeights: heights, viewportHeight: 100, from: 0, dir: 'down' }), 4)
  // Upwards from row 9: 32+32+32 = 96 is still inside the viewport, +26 = 122 crosses it.
  assert.equal(pageJump({ rowHeights: heights, viewportHeight: 100, from: 9, dir: 'up' }), 5)
  // Clamped at the ends, and never a silent no-op when there is a row to move to.
  assert.equal(pageJump({ rowHeights: heights, viewportHeight: 10_000, from: 0, dir: 'down' }), 9)
  assert.equal(pageJump({ rowHeights: heights, viewportHeight: 10_000, from: 5, dir: 'up' }), 0)
  assert.equal(pageJump({ rowHeights: heights, viewportHeight: 1, from: 3, dir: 'down' }), 4)
  assert.equal(pageJump({ rowHeights: heights, viewportHeight: 100, from: 9, dir: 'down' }), 9)
  assert.equal(pageJump({ rowHeights: [], viewportHeight: 100, from: 0, dir: 'down' }), 0)
})

// ═══ The pieces that moved, still behaving ═════════════════════════════════════

check('the moved helpers kept their contracts', () => {
  // Clipboard round trip over the cell that used to shred a row.
  const nasty = 'line one\nline two'
  assert.equal(parseClipboardTable(`a\t${tsvEscape(nasty)}\tb`)[0][1], nasty)
  assert.deepEqual(parseClipboardTable('1\t2\r\n3\t4\r\n'), [['1', '2'], ['3', '4']])
  // A DB decimal string is emitted VERBATIM — no float round trip.
  assert.equal(clipboardNumber('6940123.45'), '6940123.45')
  assert.equal(clipboardNumber('0.4800'), '0.4800')
  assert.equal(clipboardNumber(null), '')

  // Dirty rules.
  assert.deepEqual(mergeFieldEdit(undefined, 'wt', '10', '10'), {})
  assert.deepEqual(mergeFieldEdit({ wt: '9' }, 'wt', '10', '10'), {})
  assert.deepEqual(mergeFieldEdit(undefined, 'wt', '', '10'), { wt: '' })
  assert.ok(!isDirtyFieldEdits({ wt: '   ' }))
  assert.ok(isDirtyFieldEdits({ wt: '1' }))

  // Counting + the configurable nouns.
  const work = countUnsavedWork(new Set(['a', 'b']), new Set(['d']))
  assert.deepEqual(work, { editedRecords: 2, newRows: 1, total: 3 })
  assert.equal(describeUnsavedWork(work), '2 edited rows and 1 typed new row')
  assert.equal(
    describeUnsavedWork(work, { record: 'edited receipt' }),
    '2 edited receipts and 1 typed new row',
  )
  assert.equal(describeUnsavedWork(countUnsavedWork(new Set(), new Set())), 'nothing unsaved')

  // Draft ceiling.
  assert.equal(clampDraftAdd('0'), 1)
  assert.equal(clampDraftAdd('abc'), 1)
  assert.equal(clampDraftAdd('99999'), MAX_DRAFT_ADD)

  // Paste plan + family targeting.
  assert.deepEqual(
    planPaste({ startRow: 0, startCol: 0, blockRows: 30, blockCols: 2, navRowCount: 20, colCount: 5, canCreateRows: true, maxNewRows: 500 }),
    { newRows: 10, droppedRows: 0, droppedCols: 0 },
  )
  const kinds = ['record', 'child', 'child', 'record', 'draft'] as const
  const t = pasteRowTargets({ kinds: [...kinds], anchorRow: 0, blockRows: 3 })
  assert.deepEqual(t.targets, [0, 3, 4])
  assert.equal(t.skipped, 2)

  // Group spacer.
  assert.equal(needsGroupSpacer(undefined, '2026-08-01'), false)
  assert.equal(needsGroupSpacer('2026-08-01', '2026-08-01'), false)
  assert.equal(needsGroupSpacer('2026-08-01', '2026-08-02'), true)
  assert.equal(needsGroupSpacer('', '2026-08-01'), true, 'ungrouped → first group is a boundary')
})

// ═══ Column resolution — visibility, then order, then widths ═══════════════════

check('a hidden column is ABSENT, so the coordinate space has no unreachable holes', () => {
  type Ctx = { prices: boolean }
  const specs: ColumnSpec<unknown, Ctx>[] = [
    { key: 'num', label: '#', width: 40, pin: 'start', format: () => null, hideable: false },
    { key: 'a', label: 'A', width: 100, format: () => null },
    { key: 'php', label: '₱', width: 100, format: () => null, visible: (c) => c.prices },
  ]

  const shown = resolveColumns(specs, { prices: true })
  assert.deepEqual(shown.cols.map((c) => c.key), ['num', 'a', 'php'])
  assert.equal(shown.minWidth, 240)

  const gated = resolveColumns(specs, { prices: false })
  assert.deepEqual(gated.cols.map((c) => c.key), ['num', 'a'])
  assert.equal(gated.minWidth, 140, 'the min-width follows the columns that exist')
  assert.equal(gated.indexByKey.has('php'), false, 'nothing can address a hidden column')

  // A saved layout cannot hide a column the spec says is not hideable.
  const forced = resolveColumns(specs, { prices: true }, { hidden: ['num', 'a'] })
  assert.deepEqual(forced.cols.map((c) => c.key), ['num', 'php'])
})

check('a saved order is honoured, but never across a PIN boundary', () => {
  const specs: ColumnSpec<unknown, unknown>[] = [
    { key: 'p1', label: 'P1', width: 40, pin: 'start', format: () => null },
    { key: 'p2', label: 'P2', width: 40, pin: 'start', format: () => null },
    { key: 'a', label: 'A', width: 60, format: () => null },
    { key: 'b', label: 'B', width: 60, format: () => null },
    { key: 'z', label: 'Z', width: 50, pin: 'end', format: () => null },
  ]

  // Reordering within the scrolling group is honoured.
  assert.deepEqual(
    resolveColumns(specs, {}, { order: ['p1', 'p2', 'b', 'a', 'z'] }).cols.map((c) => c.key),
    ['p1', 'p2', 'b', 'a', 'z'],
  )
  // Swapping the pinned pair is honoured — it stays inside the group.
  assert.deepEqual(
    resolveColumns(specs, {}, { order: ['p2', 'p1', 'a', 'b', 'z'] }).cols.map((c) => c.key),
    ['p2', 'p1', 'a', 'b', 'z'],
  )
  // Dragging a pinned column into the middle is CORRECTED, not honoured: a pinned run
  // must stay contiguous or `position: sticky` cannot paint it, and its width is
  // subtracted by the caret-follow and the drag auto-scroll.
  const smuggled = resolveColumns(specs, {}, { order: ['a', 'p1', 'z', 'b', 'p2'] })
  assert.deepEqual(smuggled.cols.map((c) => c.key), ['p1', 'p2', 'a', 'b', 'z'])
  assert.deepEqual(smuggled.pinned, { start: 2, end: 1 })

  // A stale order naming a dead column, and one missing a new column, both survive.
  assert.deepEqual(
    resolveColumns(specs, {}, { order: ['gone', 'p2', 'p1'] }).cols.map((c) => c.key),
    ['p2', 'p1', 'a', 'b', 'z'],
  )
})

check('a saved width moves the geometry with it', () => {
  const specs: ColumnSpec<unknown, unknown>[] = [
    { key: 'p', label: 'P', width: 40, pin: 'start', format: () => null },
    { key: 'a', label: 'A', width: 60, format: () => null },
    { key: 'fixed', label: 'F', width: 60, format: () => null, resizable: false },
  ]
  const r = resolveColumns(specs, {}, { widths: { p: 90, a: 100, fixed: 999 } })
  assert.equal(r.cols[0].width, 90)
  assert.equal(r.cols[1].width, 100)
  assert.equal(r.cols[2].width, 60, 'a column that refuses resizing keeps its declared width')
  assert.equal(r.minWidth, 250)
  assert.equal(r.pinnedWidths.start, 90, 'the pinned wall moves with the resize')
  assert.deepEqual(r.offsets, [0, 90, 190])
  // A nonsense width is ignored rather than collapsing the column.
  assert.equal(resolveColumns(specs, {}, { widths: { a: 0 } }).cols[1].width, 60)
})

// ═══ The cell class table ══════════════════════════════════════════════════════

const baseKey: CellClassKey = {
  pin: null, edge: false, rowKind: 'record', exists: true,
  active: false, selected: false, invalid: false, dirty: false,
  numeric: false, editable: true,
}

check('a cell gets exactly ONE background, by an explicit precedence', () => {
  const t = createCellClassTable()
  const bgCount = (s: string) => (s.match(/(?:^|\s)bg-[^\s]+/g) ?? []).length

  // Every combination of the three tint states, and none may stack.
  for (const invalid of [false, true]) {
    for (const selected of [false, true]) {
      for (const dirty of [false, true]) {
        const { inner } = t.get({ ...baseKey, invalid, selected, dirty })
        assert.ok(bgCount(inner) <= 1, `stacked backgrounds for i=${invalid} s=${selected} d=${dirty}`)
      }
    }
  }

  // Precedence: invalid outranks selected outranks dirty.
  assert.match(t.get({ ...baseKey, invalid: true, selected: true, dirty: true }).inner, /bg-destructive/)
  assert.match(t.get({ ...baseKey, selected: true, dirty: true }).inner, /bg-primary/)
  assert.match(t.get({ ...baseKey, dirty: true }).inner, /bg-amber/)
})

check('a pinned cell is OPAQUE, and its tint rides on the inner layer', () => {
  const t = createCellClassTable()
  const pinned = t.get({ ...baseKey, pin: 'start', selected: true })
  // The `<td>` carries a SOLID token — any alpha and scrolling rows bleed through it.
  assert.match(pinned.td, /\bbg-background\b/)
  assert.ok(!/bg-\w+\/\d/.test(pinned.td), 'a pinned cell must never carry a translucent background')
  assert.ok(!/backdrop-blur/.test(pinned.td), 'frozen surfaces are never glass')
  assert.match(pinned.td, /frozen-col/)
  // The state tint is on the INNER layer, above the opaque base.
  assert.match(pinned.inner, /bg-primary/)

  // The seam sits on the edge column only.
  assert.match(t.get({ ...baseKey, pin: 'start', edge: true }).td, /frozen-edge/)
  assert.ok(!/frozen-edge/.test(t.get({ ...baseKey, pin: 'start', edge: false }).td))

  // A scrolling cell needs its own containing block; a pinned one already has one
  // (`position: sticky`) and must not be given a second.
  assert.match(t.get(baseKey).td, /\brelative\b/)
  assert.ok(!/\brelative\b/.test(pinned.td))
})

check('the interactive layer fills the CELL, never its text', () => {
  const t = createCellClassTable()
  // `absolute inset-0`, not `h-full`: a percentage height against a cell the browser has
  // not sized collapses onto the text, which shipped as both a mis-drawn active ring and
  // an empty cell with no hit area at all.
  assert.match(t.get(baseKey).inner, /absolute inset-0/)
  assert.ok(!/h-full/.test(t.get(baseKey).inner))
  // The ring clears a pinned cell's stacking context.
  assert.match(t.get({ ...baseKey, active: true }).inner, /z-20/)
  assert.match(t.get({ ...baseKey, active: true }).inner, /ring-2/)
  // No animation on cells, ever.
  for (const k of [baseKey, { ...baseKey, active: true }, { ...baseKey, selected: true }]) {
    assert.ok(!/transition|animate-/.test(t.get(k).inner), 'cell selection is never animated')
  }
  // A cell the row does not have is inert.
  const missing = t.get({ ...baseKey, exists: false })
  assert.match(missing.inner, /pointer-events-none/)
  assert.ok(!/cursor-cell/.test(missing.inner))
  assert.match(t.get({ ...baseKey, editable: false }).inner, /cursor-default/)
})

check('the class table CACHES — that is the whole point of it', () => {
  const t = createCellClassTable()
  const a = t.get(baseKey)
  const b = t.get({ ...baseKey })
  assert.equal(a, b, 'the same key must return the identical object, not an equal one')
  assert.equal(t.size(), 1)

  // A realistic sheet: 18 columns × 3 row families × a handful of states resolves to a
  // few dozen entries, not thousands — measured here so a future field that explodes the
  // key space is caught.
  for (const rowKind of ['record', 'child', 'draft']) {
    for (const pin of [null, 'start', 'end'] as const) {
      for (const active of [false, true]) {
        for (const selected of [false, true]) {
          t.get({ ...baseKey, rowKind, pin, active, selected })
        }
      }
    }
  }
  assert.ok(t.size() <= 40, `class table grew to ${t.size()} entries`)

  // Distinct keys never collide.
  assert.notEqual(cellClassKey(baseKey), cellClassKey({ ...baseKey, active: true }))
  assert.notEqual(cellClassKey({ ...baseKey, pin: 'start' }), cellClassKey({ ...baseKey, pin: 'end' }))
  assert.notEqual(cellClassKey({ ...baseKey, rowKind: 'record' }), cellClassKey({ ...baseKey, rowKind: 'child' }))
})

// ═══ Row resolution — the coordinate space, and the two predicates ═════════════

type PRow = { id: string; n: number }

const spec = (key: string, extra: Partial<ColumnSpec<PRow, unknown>> = {}): ColumnSpec<PRow, unknown> =>
  ({ key, label: key.toUpperCase(), width: 80, format: () => null, ...extra })

const ROW_COLS: ColumnSpec<PRow, unknown>[] = [
  spec('num', { cellKind: 'derived' }),
  spec('a', { parse: () => ({ ok: true, patch: {} }) }),
  spec('b', { parse: () => ({ ok: true, patch: {} }) }),
]

/** A record has all three lanes; a child has only `b`; a spacer has none and is inert. */
const ROW_KINDS = new Map<string, RowKind<PRow>>([
  ['record', {
    kind: 'record', height: 32, addressable: true,
    occupies: (k) =>
      k === 'num' ? { field: 'num', editable: false }
      : k === 'a' || k === 'b' ? { field: k, editable: true }
      : null,
  }],
  ['child', {
    kind: 'child', height: 26, addressable: true,
    occupies: (k) => (k === 'b' ? { field: 'b', editable: true } : null),
  }],
  ['spacer', { kind: 'spacer', height: 32, addressable: false, occupies: () => null }],
])

const ROW_ITEMS: GridRow<PRow>[] = [
  { kind: 'record', id: 'r1', data: { id: 'r1', n: 1 } },
  { kind: 'child', id: 'c1', data: { id: 'c1', n: 2 } },
  { kind: 'spacer', key: 'sp' },
  { kind: 'record', id: 'r2', data: { id: 'r2', n: 3 } },
  { kind: 'draft', id: 'd1' },
]

check('a NON-ADDRESSABLE row never enters the nav space, but is still MEASURED', () => {
  // 'draft' is deliberately absent from the map here — an item whose family nobody
  // described must fail CLOSED rather than becoming a cell the caret can land on.
  const r = resolveRows({ items: ROW_ITEMS, kinds: ROW_KINDS, cols: ROW_COLS })

  assert.deepEqual(r.navRows.map((n) => n.rowId), ['r1', 'c1', 'r2'])
  assert.deepEqual(r.unknownKinds, ['draft'])

  // Heights cover EVERY item — a virtualiser has to size the rows it may not visit.
  assert.deepEqual(r.rowHeights, [32, 26, 32, 32, 0])
  assert.deepEqual(r.navRowHeights, [32, 26, 32])

  // The two index spaces are inverses of each other on the rows they share.
  assert.equal(r.navIndexOfItem.get(3), 2)
  assert.equal(r.itemIndexOfNav.get(2), 3)
  assert.equal(r.navIndexOfItem.get(2), undefined, 'a spacer has no nav row')
  assert.deepEqual(r.placeById.get('r2'), { navRow: 2, index: 3 })

  // Adding the missing family adds exactly one nav row, and moves nothing else.
  const withDraft = resolveRows({
    items: ROW_ITEMS,
    kinds: new Map([
      ...ROW_KINDS,
      ['draft', { kind: 'draft', height: 32, addressable: true, occupies: (k: string) => (k === 'num' ? null : { field: k, editable: true }) }],
    ]),
    cols: ROW_COLS,
  })
  assert.deepEqual(withDraft.navRows.map((n) => n.rowId), ['r1', 'c1', 'r2', 'd1'])
  assert.deepEqual(withDraft.unknownKinds, [])
  assert.deepEqual(
    withDraft.navRows.slice(0, 3).map((n) => n.rowId),
    ['r1', 'c1', 'r2'],
    'the nav space is byte-identical above the new row',
  )
})

check('cellExists / cellEditable are per CELL, not per column', () => {
  const r = resolveRows({ items: ROW_ITEMS, kinds: ROW_KINDS, cols: ROW_COLS })

  // A record has every lane; a child has only `b`. That single disagreement is what the
  // keyboard, the paste, the pill and the tint all read.
  assert.ok(r.cellExists(0, 0) && r.cellExists(0, 1) && r.cellExists(0, 2))
  assert.ok(!r.cellExists(1, 0) && !r.cellExists(1, 1) && r.cellExists(1, 2))

  // Existing is not editable: a row ordinal is addressable and unwritable.
  assert.ok(!r.cellEditable(0, 0))
  assert.ok(r.cellEditable(0, 1))
  assert.ok(r.cellEditable(1, 2))

  // Out of bounds is a clean `false`, never a throw on a render path.
  assert.ok(!r.cellExists(99, 0) && !r.cellExists(0, 99) && !r.cellEditable(-1, 0))
})

check('the COLUMN has its own say, and it is a different question', () => {
  // A column with no `parse` is read-only by construction: nothing could turn typed text
  // into a patch, so an editor on it could only discard what it collected.
  assert.ok(!columnAcceptsEdit(spec('x'), null, {}))
  assert.ok(columnAcceptsEdit(spec('x', { parse: () => ({ ok: true, patch: {} }) }), null, {}))
  assert.ok(!columnAcceptsEdit(spec('x', { cellKind: 'readonly', parse: () => ({ ok: true, patch: {} }) }), null, {}))
  assert.ok(!columnAcceptsEdit(spec('x', { cellKind: 'derived', parse: () => ({ ok: true, patch: {} }) }), null, {}))
  // An explicit predicate outranks the default, and sees the row and the context.
  assert.ok(!columnAcceptsEdit(spec('x', { parse: () => ({ ok: true, patch: {} }), editable: (row) => row !== null }), null, {}))

  // Selectable defaults to "yes unless the column is a pure ornament" — and a read-only
  // column may deliberately opt IN, because a run of computed totals is the most useful
  // thing on a sheet to add up.
  assert.ok(columnSelectable(spec('x')))
  assert.ok(!columnSelectable(spec('x', { cellKind: 'derived' })))
  assert.ok(columnSelectable(spec('x', { cellKind: 'readonly', selectable: true })))
  assert.ok(!columnSelectable(spec('x', { selectable: false })))
})

check('the nav resolver steps OVER coordinates a row does not have', () => {
  const r = resolveRows({ items: ROW_ITEMS, kinds: ROW_KINDS, cols: ROW_COLS })
  const nav = createTableNavResolver({
    rowCount: r.navRows.length,
    colCount: ROW_COLS.length,
    exists: r.cellExists,
    editable: r.cellEditable,
  })

  // Column `b` exists on the child, so ArrowDown walks into it…
  assert.deepEqual(nav.resolve({ row: 0, col: 2 }, { kind: 'arrow', dir: 'down' }), { row: 1, col: 2 })
  // …while column `a` does not, so the same key in that lane steps over it entirely.
  assert.deepEqual(nav.resolve({ row: 0, col: 1 }, { kind: 'arrow', dir: 'down' }), { row: 2, col: 1 })

  // Reading order for Tab: across the row, then on to the next, skipping inert cells.
  assert.deepEqual(nav.resolve({ row: 0, col: 2 }, { kind: 'tab', shift: false }), { row: 1, col: 2 })
  assert.deepEqual(nav.resolve({ row: 1, col: 2 }, { kind: 'tab', shift: true }), { row: 0, col: 2 })

  // A boundary returns null (stay put) rather than clamping onto a cell that is not there.
  assert.equal(nav.resolve({ row: 0, col: 0 }, { kind: 'arrow', dir: 'up' }), null)
  assert.equal(nav.resolve({ row: 0, col: 0 }, { kind: 'arrow', dir: 'left' }), null)
  assert.equal(nav.resolve({ row: 2, col: 2 }, { kind: 'tab', shift: false }), null)

  // The Enter-anchor's lane may not exist in the next row; the caret still advances.
  const inRow = nav.resolveInRow
  assert.ok(inRow, 'the Enter-after-a-Tab-run anchor needs an in-row resolver')
  assert.deepEqual(inRow({ row: 0, col: 2 }, 1, 1), { row: 2, col: 1 })
  assert.deepEqual(inRow({ row: 0, col: 2 }, 2, 1), { row: 1, col: 2 })

  assert.equal(nav.laneOf({ row: 0, col: 2 }), 2)
  assert.ok(nav.isEditable({ row: 0, col: 1 }) && !nav.isEditable({ row: 0, col: 0 }))

  // A sheet where NOTHING is addressable cannot spin the Tab walk.
  const dead = createTableNavResolver({ rowCount: 5, colCount: 4, exists: () => false, editable: () => false })
  assert.equal(dead.resolve({ row: 0, col: 0 }, { kind: 'tab', shift: false }), null)
})

// ═══ Purity — the layer rule, enforced ═════════════════════════════════════════

check('lib/table is PURE: no React, no Next, no Supabase, no app/ or tenant imports', () => {
  const dir = join(ROOT, 'lib/table')
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length >= 6, 'the core should have its modules; this scan would be vacuous')

  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
    // Every content check runs against the CODE, not the prose. These files talk about
    // React and about the tenants they were extracted from — saying "pure, no React" in
    // a header must not fail a purity scan.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.ok(code.includes('export'), `${f}: comment-stripping ate the source`)

    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    for (const spec of imports) {
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        `${f} imports "${spec}" — the pure core may only import its own siblings`,
      )
    }
    assert.ok(!/'use client'/.test(code), `${f} must not be a client module`)
    assert.ok(!/\bReact\b/.test(code), `${f} must not reference React in code`)
    // The layer rule from CLAUDE.md, stated as a test rather than as a docstring.
    for (const word of ['charcoal', 'supplier', 'batch_code', 'peso', 'cenapro', 'moisture']) {
      assert.ok(
        !new RegExp(`\\b${word}\\b`, 'i').test(code),
        `${f} names "${word}" in CODE — the platform layer carries no tenant knowledge`,
      )
    }
  }
})

check('the REACT half is tenant-neutral too: no app/ imports, no domain vocabulary', () => {
  // The pure core's scan above also refuses React. This one cannot — these files ARE
  // React — so it enforces the half of the layer rule that still applies: **platform code
  // carries zero tenant knowledge, and the dependency arrow never points at `app/`.**
  const targets = [
    ...readdirSync(join(ROOT, 'components/shared/table'))
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map((f) => join('components/shared/table', f)),
    'lib/hooks/use-table-columns.ts',
    'lib/hooks/use-table-rows.ts',
    'lib/hooks/use-table-edits.ts',
    'lib/hooks/use-table-interaction.ts',
  ]
  assert.ok(targets.length >= 9, 'the React half should have its modules; this scan would be vacuous')

  for (const rel of targets) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.ok(code.includes('export'), `${rel}: comment-stripping ate the source`)

    for (const m of code.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(
        !m[1].startsWith('@/app/') && !m[1].includes('(app)'),
        `${rel} imports "${m[1]}" — the platform layer may never depend on a page`,
      )
    }
    for (const word of ['charcoal', 'supplier', 'batch_code', 'peso', 'cenapro', 'moisture']) {
      assert.ok(
        !new RegExp(`\\b${word}\\b`, 'i').test(code),
        `${rel} names "${word}" in CODE — the platform layer carries no tenant knowledge`,
      )
    }
  }
})

console.log(`\n${passed} assertions passed.`)
