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
  forgetRows,
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
  shiftFirstItemIndex,
  DEFAULT_FIRST_ITEM_INDEX,
  rangeRowEdge,
  cellRangeEdges,
  NO_RANGE_EDGES,
  defaultTableMenu,
  rowCopyColumns,
  applyTableView,
  nextSortDirection,
  isColumnFilterActive,
  activeFilterCount,
  columnSortable,
  columnFilterable,
  NO_FILTERS,
  GRID_PARAM,
  GRID_V1,
  GRID_V2,
  parseGrid,
  resolveGrid,
  isGridV2,
  withGrid,
  gridHref,
} from '../lib/table/index'
import type { ColumnSpec, GridRow, JumpGrid, RowKind, SummaryLaneCol } from '../lib/table/index'
import { resolveColumns } from '../lib/hooks/use-table-columns'
import {
  resolveRows,
  columnAcceptsEdit,
  columnSelectable,
  createTableNavResolver,
} from '../lib/hooks/use-table-rows'
import type { ResolvedRows } from '../lib/hooks/use-table-rows'
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

// ═══ The bidirectional pager's PUBLIC index base ═══════════════════════════════

check('a prepend rebases by the ITEMS added, never by the RECORDS fetched', () => {
  // The case the playground actually produces: 10 older records arrive, and the flat array
  // grows by 12 — their group heading, plus the spacer the old leading group never needed.
  // Decrementing by 10 would leave the viewport 2 rows out; this is why the helper takes
  // the two ARRAY lengths and does the subtraction itself.
  assert.equal(
    shiftFirstItemIndex({
      firstItemIndex: DEFAULT_FIRST_ITEM_INDEX,
      previousItemCount: 156,
      nextItemCount: 168,
    }),
    DEFAULT_FIRST_ITEM_INDEX - 12,
  )

  // Nothing prepended ⇒ nothing rebased, so calling it on a no-op page is harmless.
  assert.equal(
    shiftFirstItemIndex({ firstItemIndex: 1_000, previousItemCount: 40, nextItemCount: 40 }),
    1_000,
  )

  // A list that got SHORTER never RAISES the base: `firstItemIndex` is specified for
  // inverse infinite scrolling and is only ever decreased, so un-shifting it would drag
  // the viewport instead of leaving it alone.
  assert.equal(
    shiftFirstItemIndex({ firstItemIndex: 1_000, previousItemCount: 40, nextItemCount: 9 }),
    1_000,
  )

  // And it never hands the virtualiser a negative base, which it refuses.
  assert.equal(
    shiftFirstItemIndex({ firstItemIndex: 5, previousItemCount: 0, nextItemCount: 12 }),
    0,
  )
  assert.equal(
    shiftFirstItemIndex({ firstItemIndex: 0, previousItemCount: 0, nextItemCount: 999 }),
    0,
  )

  // Successive pages compose: the base walks down by the items each one added.
  let base = DEFAULT_FIRST_ITEM_INDEX
  for (const [before, after] of [[156, 168], [168, 180], [180, 192]] as const) {
    base = shiftFirstItemIndex({ firstItemIndex: base, previousItemCount: before, nextItemCount: after })
  }
  assert.equal(base, DEFAULT_FIRST_ITEM_INDEX - 36)
  assert.ok(DEFAULT_FIRST_ITEM_INDEX > 1_000, 'the default base must leave a pager real headroom')
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
  edgeTop: false, edgeRight: false, edgeBottom: false, edgeLeft: false,
  boxed: false,
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

check('a CHROME row is MEASURED, tiles the lanes, and is still not a coordinate', () => {
  // The family a `renderChromeRow` consumer declares: a group heading. It is exactly a
  // spacer as far as the axis is concerned — the renderer changes what it PAINTS, never
  // whether the caret may land on it.
  const kinds = new Map<string, RowKind<PRow>>([
    ...ROW_KINDS,
    ['group-header', { kind: 'group-header', height: 28, addressable: false, occupies: () => null }],
  ])
  const items: GridRow<PRow>[] = [{ kind: 'group-header', key: 'gh:a' }, ...ROW_ITEMS]
  const r = resolveRows({ items, kinds, cols: ROW_COLS })

  // A real row of the sheet: it keeps its family's declared height, and every item is
  // measured because a virtualiser has to size the rows it may not visit.
  assert.equal(r.rowHeights[0], 28)
  assert.equal(r.rowHeights.length, items.length)

  // …and it is not a coordinate. The nav space is byte-identical with and without it.
  assert.deepEqual(r.navRows.map((n) => n.rowId), ['r1', 'c1', 'r2'])
  assert.equal(r.navIndexOfItem.get(0), undefined, 'a heading has no nav row')
  assert.equal(r.placeById.has('gh:a'), false)
  assert.equal(r.itemIndexOfNav.get(0), 1, 'nav 0 is the record BELOW the heading')
  assert.ok(r.cellExists(0, 0), 'nav 0 still resolves against the record, not the heading')

  // What the renderer is handed. The lanes tile the column table exactly once, so a
  // heading built from them covers every column and none twice — and a lane of span 0
  // must render NO cell, because `colSpan={0}` is "to the end of the column group".
  const bare = summarySpans(ROW_COLS)
  assert.equal(
    bare.frozen + bare.spacer + bare.weight + bare.note + bare.total + bare.trailing,
    ROW_COLS.length,
  )
  assert.equal(bare.frozen, 0, 'no pinned block ⇒ no pinned cell on the chrome row at all')

  const pinnedSpans = summarySpans(both)
  assert.equal(pinnedSpans.frozen, 2)
  assert.equal(
    pinnedSpans.frozen + (both.length - pinnedSpans.frozen),
    both.length,
    'the pinned block plus everything right of it IS the row',
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
    addressable: r.cellAddressable,
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
  const dead = createTableNavResolver({ rowCount: 5, colCount: 4, addressable: () => false, editable: () => false })
  assert.equal(dead.resolve({ row: 0, col: 0 }, { kind: 'tab', shift: false }), null)
})

// ═══ "renders content here" ≠ "the caret may land here" ════════════════════════
//
// The FOURTH seam, found the same way the first three were: by the first real migration
// slice, which could not say what it needed with the API it had. `occupies()` answered
// both questions with one value — a slot RENDERS and is a keyboard stop, `null` is neither
// — so a column carrying a row ordinal, a database-computed total or a derived status
// badge could either be blank or be a dead stop in every Tab run, and nothing else.
//
// `CellSlot.addressable` is the middle answer, and it DEFAULTS TO TRUE. The first check
// below is the whole additivity claim: on a table where nothing declares it, the new
// predicate is byte-identical with the old one.

/**
 * The shape the migration actually produced: an ordinal lane both families paint and
 * neither may be typed in, plus a computed lane the CHILD shows read-only while its parent
 * owns it. `record` and `child` both keep an ordinary editable lane, so the caret still has
 * somewhere to be.
 */
const SEAM_KINDS = new Map<string, RowKind<PRow>>([
  ['record', {
    kind: 'record', height: 32, addressable: true,
    occupies: (k) =>
      k === 'num' ? { field: 'num', editable: false, addressable: false }
      : k === 'a' || k === 'b' ? { field: k, editable: true }
      : null,
  }],
  ['child', {
    kind: 'child', height: 26, addressable: true,
    occupies: (k) =>
      k === 'num' ? { field: 'num', editable: false, addressable: false }
      : k === 'a' ? { field: 'a', editable: true }
      // Content, no coordinate: the child shows the figure its parent owns.
      : k === 'b' ? { field: 'b', editable: false, addressable: false }
      : null,
  }],
])

const SEAM_ITEMS: GridRow<PRow>[] = [
  { kind: 'record', id: 'r1', data: { id: 'r1', n: 1 } },
  { kind: 'child', id: 'c1', data: { id: 'c1', n: 2 } },
  { kind: 'record', id: 'r2', data: { id: 'r2', n: 3 } },
]

const seamResolver = (rows: ResolvedRows<PRow>, probe: 'addressable' | 'exists') =>
  createTableNavResolver({
    rowCount: rows.navRows.length,
    colCount: ROW_COLS.length,
    addressable: probe === 'addressable' ? rows.cellAddressable : rows.cellExists,
    editable: rows.cellEditable,
  })

/** The same fixture as `ROW_KINDS`, with the family it deliberately leaves out. */
const ROW_KINDS_WITH_DRAFT = new Map<string, RowKind<PRow>>([
  ...ROW_KINDS,
  ['draft', {
    kind: 'draft', height: 32, addressable: true,
    occupies: (k) => (k === 'num' ? null : { field: k, editable: true }),
  }],
])

check('addressable DEFAULTS to true — a row family that omits it behaves exactly as before', () => {
  // Every fixture above this line predates the field and mentions it nowhere. On all of
  // them the two predicates must agree at EVERY coordinate, in bounds and out of it —
  // which is the entire "purely additive" claim, asserted rather than asserted-to.
  for (const kinds of [ROW_KINDS, ROW_KINDS_WITH_DRAFT]) {
    const r = resolveRows({ items: ROW_ITEMS, kinds, cols: ROW_COLS })
    for (let row = -1; row <= r.navRows.length; row++) {
      for (let col = -1; col <= ROW_COLS.length; col++) {
        assert.equal(
          r.cellAddressable(row, col),
          r.cellExists(row, col),
          `cellAddressable diverged from cellExists at ${row},${col} with nothing declaring it`,
        )
      }
    }
  }

  // …and the nav resolver built on either predicate resolves identically there. Same
  // moves as the check above, same answers.
  const r = resolveRows({ items: ROW_ITEMS, kinds: ROW_KINDS, cols: ROW_COLS })
  const byAddressable = seamResolver(r, 'addressable')
  const byExists = seamResolver(r, 'exists')
  for (const from of [{ row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 2 }, { row: 2, col: 0 }]) {
    for (const move of [
      { kind: 'arrow', dir: 'down' }, { kind: 'arrow', dir: 'up' },
      { kind: 'arrow', dir: 'left' }, { kind: 'arrow', dir: 'right' },
      { kind: 'tab', shift: false }, { kind: 'tab', shift: true },
      { kind: 'enter', shift: false },
    ] as const) {
      assert.deepEqual(byAddressable.resolve(from, move), byExists.resolve(from, move))
    }
  }
})

check('a non-addressable cell still EXISTS — it renders, it is never a coordinate', () => {
  const r = resolveRows({ items: SEAM_ITEMS, kinds: SEAM_KINDS, cols: ROW_COLS })

  // The ordinal lane: present on both families, so the cell is painted, tinted, copied and
  // sweepable — and the caret may not land on it.
  for (const row of [0, 1, 2]) {
    assert.ok(r.cellExists(row, 0), 'the ordinal cell must RENDER')
    assert.ok(!r.cellAddressable(row, 0), 'the caret must not land on the ordinal')
    assert.ok(!r.cellEditable(row, 0))
  }

  // The computed lane, non-addressable on the CHILD only — the two answers differ per
  // cell, not per column and not per row.
  assert.ok(r.cellExists(1, 2) && !r.cellAddressable(1, 2), 'the child shows the figure it may not visit')
  assert.ok(r.cellExists(0, 2) && r.cellAddressable(0, 2), 'the parent owns it and may')

  // A lane neither family has stays absent on BOTH counts — `addressable` narrows
  // `cellExists`, it never widens it.
  const narrow = resolveRows({
    items: SEAM_ITEMS,
    kinds: new Map<string, RowKind<PRow>>([
      ...SEAM_KINDS,
      ['child', { kind: 'child', height: 26, addressable: true, occupies: (k) => (k === 'a' ? { field: 'a', editable: true } : null) }],
    ]),
    cols: ROW_COLS,
  })
  assert.ok(!narrow.cellExists(1, 0) && !narrow.cellAddressable(1, 0))

  // Out of bounds is a clean false on the new predicate too, never a throw on a render path.
  assert.ok(!r.cellAddressable(99, 0) && !r.cellAddressable(0, 99) && !r.cellAddressable(-1, -1))
})

check('the nav resolver SKIPS a non-addressable cell, and a vertical run steps over it', () => {
  const r = resolveRows({ items: SEAM_ITEMS, kinds: SEAM_KINDS, cols: ROW_COLS })
  const nav = seamResolver(r, 'addressable')
  const old = seamResolver(r, 'exists')

  // A VERTICAL run over a cell that renders but is not a coordinate: down column `b` from
  // the first record, the child's read-only copy is stepped over entirely.
  assert.deepEqual(nav.resolve({ row: 0, col: 2 }, { kind: 'arrow', dir: 'down' }), { row: 2, col: 2 })
  assert.deepEqual(old.resolve({ row: 0, col: 2 }, { kind: 'arrow', dir: 'down' }), { row: 1, col: 2 },
    'the old predicate stopped on it — this is the regression the seam removes')
  // …and back up again, symmetrically.
  assert.deepEqual(nav.resolve({ row: 2, col: 2 }, { kind: 'arrow', dir: 'up' }), { row: 0, col: 2 })

  // A TAB RUN never visits the ordinal. Wrapping off the end of a row lands on the first
  // addressable lane of the next, not on column 0.
  assert.deepEqual(nav.resolve({ row: 0, col: 2 }, { kind: 'tab', shift: false }), { row: 1, col: 1 })
  assert.deepEqual(old.resolve({ row: 0, col: 2 }, { kind: 'tab', shift: false }), { row: 1, col: 0 },
    'three dead stops per row is exactly what the old answer bought')
  // Shift+Tab off the FRONT of a row skips the ordinal on the way back up.
  assert.deepEqual(nav.resolve({ row: 1, col: 1 }, { kind: 'tab', shift: true }), { row: 0, col: 2 })
  // And the ordinal column is not reachable sideways either.
  assert.equal(nav.resolve({ row: 0, col: 1 }, { kind: 'arrow', dir: 'left' }), null)

  // Enter walks the same rule as ArrowDown, and the Tab-run anchor's fallback obeys it too:
  // asked for lane 2 on a child that only SHOWS lane 2, it lands past the child.
  assert.deepEqual(nav.resolve({ row: 0, col: 2 }, { kind: 'enter', shift: false }), { row: 2, col: 2 })
  const inRow = nav.resolveInRow
  assert.ok(inRow, 'the Enter-after-a-Tab-run anchor needs an in-row resolver')
  assert.deepEqual(inRow({ row: 0, col: 2 }, 2, 1), { row: 2, col: 2 })

  // A lane nothing may land in cannot be walked at all — no move, rather than a wrong one.
  assert.equal(nav.resolve({ row: 0, col: 0 }, { kind: 'arrow', dir: 'down' }), null)
  assert.equal(nav.resolve({ row: 0, col: 0 }, { kind: 'arrow', dir: 'up' }), null)

  // The jump keys read the same probe, so they cannot land where the arrows refuse to go.
  // (`filled` is only consulted where `exists` is true, so narrowing one narrows both.)
  const jump: JumpGrid = {
    rowCount: r.navRows.length,
    colCount: ROW_COLS.length,
    exists: r.cellAddressable,
    filled: () => true,
  }
  assert.deepEqual(rowEdge(jump, { row: 0, col: 2 }, 'start'), { row: 0, col: 1 }, 'Home skips the ordinal')
  assert.deepEqual(sheetCorner(jump, 'start'), { row: 0, col: 1 })
  assert.deepEqual(edgeJump(jump, { row: 0, col: 2 }, 'down'), { row: 2, col: 2 })
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

// ── The imperative seam — "go to row N", and giving the caret back ────────────
//
// The third seam a real consumer needs, found the same way the first two were: by a
// migration that could not express something without it. `onStateChange` /
// `onSelectionChange` let a surface outside the grid REACT to it; nothing let one ACT on
// it, and two behaviours the Cenapro ledger must keep are exactly that —
//
//   • a duplicate-peer popover's "Go to row N" (move the caret + scroll + take focus),
//   • `onCloseAutoFocus={() => api.focus()}` on every dialog the grid opens, because Radix
//     restores focus to a context-menu item that has already unmounted, dropping the caret
//     on `<body>` where the next keystroke goes nowhere.
//
// Both live entirely inside `BlackwoodTable`. Scanned rather than modelled, because what
// is being asserted is which index space the API speaks — the same class of bug as the
// `firstItemIndex` rebase, and it cannot be caught by a pure function test.

check('the imperative API is addressed by ROW ID, never by a nav-row index', () => {
  const src = readFileSync(join(ROOT, 'components/shared/table/BlackwoodTable.tsx'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('useImperativeHandle'), 'comment-stripping ate the source; this scan would be vacuous')

  // ADDITIVE: a consumer that omits `apiRef` behaves exactly as it did before the seam.
  assert.match(code, /apiRef\?:\s*React\.Ref<BlackwoodTableApi>/, 'the prop must be optional')

  // Both row-addressed methods take a ROW ID. The consumer builds `items` but does NOT
  // own `navRows` — that axis is resolved in `useTableRows`, and a consumer computing an
  // index from `items` would be a second definition of it.
  assert.match(code, /goToRow\(rowId: string, colKey\?: string\): boolean/)
  assert.match(code, /scrollToRow\(rowId: string\): boolean/)
  const handle = code.slice(code.indexOf('React.useImperativeHandle'), code.indexOf('// ── The editor'))
  assert.ok(handle.length > 300, 'expected the imperative handle body')
  assert.equal(
    (handle.match(/rows\.placeById\.get\(rowId\)/g) ?? []).length,
    2,
    'both row-addressed methods must resolve through the ONE row axis',
  )
  // …and a row outside the loaded window is REPORTED, never a silent no-op.
  assert.equal((handle.match(/return false;/g) ?? []).length, 3, 'every refusal returns false')
})

check('goToRow can never park the caret on a cell the row does not occupy', () => {
  const src = readFileSync(join(ROOT, 'components/shared/table/BlackwoodTable.tsx'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const handle = code.slice(code.indexOf('React.useImperativeHandle'), code.indexOf('// ── The editor'))
  assert.ok(handle.includes('goToRow'), 'this scan would be vacuous')

  // Every candidate lane is tested with `cellAddressable` — the row family's own answer to
  // the CARET's question. A child row is narrower than its parent, so the column a caller
  // asks for (or the one the caret happens to be in) may simply not be there; and a lane
  // that renders content without being a coordinate is refused for the same reason the
  // keyboard refuses it. An API that can put the caret where no key can reach is the same
  // defect wearing the other hat.
  assert.ok(
    (handle.match(/rows\.cellAddressable\(place\.navRow,/g) ?? []).length >= 2,
    'the asked-for lane AND the fallback sweep must both go through cellAddressable',
  )
  assert.ok(
    !/rows\.cellExists\(place\.navRow/.test(handle),
    'goToRow must not read the RENDER predicate — it places the caret',
  )
  // The caret is only moved once a lane has been found.
  const set = handle.indexOf('setActiveCell({ row: place.navRow, col })')
  const guard = handle.indexOf('if (col < 0) return false;')
  assert.ok(guard > 0 && guard < set, 'the "no lane" refusal must come BEFORE the caret moves')
  // And the whole gesture is what "go to row N" means — not merely a scroll.
  assert.ok(set < handle.indexOf('scrollTo(place.navRow);\n                scrollToCol(col);'))
  assert.match(handle, /focusGrid\(\);\s*\n\s*return true;/, 'it must take focus, or the next keystroke goes nowhere')
})

check('every CARET path reads cellAddressable; every RENDER path still reads cellExists', () => {
  // The seam is only worth having if it is wired to all of the caret and none of the rest,
  // and that is a WIRING fact rather than a pure-function one — the two predicates have
  // identical signatures, so swapping them is a silent behaviour change that no type and
  // no unit test can catch. Scanned, for the same reason the imperative handle is.
  const src = readFileSync(join(ROOT, 'lib/hooks/use-table-interaction.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('createTableNavResolver'), 'comment-stripping ate the source')

  // The keyboard: the resolver, and the four jump gestures (which all end in `placeCaret`).
  assert.match(code, /addressable:\s*rows\.cellAddressable/, 'the nav resolver takes the caret predicate')
  assert.match(code, /exists:\s*rows\.cellAddressable/, 'the jump grid takes it too')
  // Two for PageUp/PageDown's landing site (`snapToExisting`, on both of its passes), and
  // two for the mouse's DEAD-CELL clause below — never fewer, and never as the mouse's
  // only gate.
  assert.equal(
    (code.match(/rows\.cellAddressable\(/g) ?? []).length,
    4,
    "PageUp/PageDown's landing site (`snapToExisting`) must snap to an addressable cell, on both of its passes",
  )

  // …and the MOUSE deliberately does not GATE on it. A drag has to be able to start on a
  // content-bearing, caret-free cell — a run of computed totals is the most useful thing on
  // a sheet to sweep — so `onCellMouseDown` and the context menu keep the render predicate
  // as their first question. This is the one place the two are meant to disagree, so it is
  // asserted rather than left to be re-litigated.
  assert.equal(
    (code.match(/rows\.cellExists\(navRow, col\)/g) ?? []).length,
    2,
    'the mousedown gate and the context-menu gate both stay on cellExists',
  )

  // ── The DEAD-CELL clause (2026-08-26) ─────────────────────────────────────────
  //
  // A cell that is neither addressable NOR selectable has no argument behind it at all:
  // nothing can be typed there, no rectangle may cover it, nothing totals it. Parking the
  // caret on one handed the operator a ring and then silence, AND broke the module's own
  // "exactly one rectangle on screen" invariant — `useCellSelection.handleCellMouseDown`
  // refuses a non-selectable column, so the caret moved while the selection tint stayed
  // where it was, which is where Delete and Ctrl/Cmd+C kept acting. Measured on the
  // Cenapro QC sheet, whose imported `#` and `BATCH` lanes are exactly that combination
  // and render NOTHING on a blank draft row.
  //
  // It is asserted as a CONJUNCTION, and that is the whole point: `cellAddressable` alone
  // would take the drag-start away from `selectable: true, addressable: false` (RC
  // Deliveries' `TTL PRICE`), which is the case the asymmetry above exists for.
  assert.match(
    code,
    /if \(!rows\.cellAddressable\(navRow, col\) && !selectableCol\(col\)\) \{\s*\n\s*focus\(\);\s*\n\s*return;/,
    'the mousedown refuses a cell that is neither addressable nor selectable — as a conjunction',
  )
  assert.match(
    code,
    /rows\.cellExists\(navRow, col\) &&\s*\n?\s*\(rows\.cellAddressable\(navRow, col\) \|\| selectableCol\(col\)\)/,
    'the context menu applies the same rule before it moves the caret',
  )
  // And the caret never moves without its 1×1 selection: a column a rectangle may not
  // cover CLEARS the selection instead of leaving it lit on another cell.
  assert.match(
    code,
    /if \(selectableCol\(col\)\) handleCellMouseDown\(navRow, col, e\);\s*\n\s*else clearSelection\(\);/,
    'a non-selectable column clears the selection rather than stranding it',
  )
})

check('a consumer can reach HeaderCell.filterSlot, and omitting it changes nothing', () => {
  // `HeaderCell` has carried `filterSlot` since it was written and `BlackwoodTable` built
  // its header row internally, passing nothing — so twelve column-filter popovers had
  // nowhere to hang. One prop, one wire, no filter UI in the platform layer.
  const table = readFileSync(join(ROOT, 'components/shared/table/BlackwoodTable.tsx'), 'utf8')
  const code = table.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('headerRow'), 'comment-stripping ate the source; this scan would be vacuous')

  // ADDITIVE: optional prop, and it resolves to `undefined` when absent — which is exactly
  // what `HeaderCell` received before the seam existed.
  assert.match(code, /renderHeaderSlot\?\(spec: ColumnSpec<Row, Ctx>, index: number\): React\.ReactNode/)
  assert.match(code, /filterSlot=\{renderHeaderSlot \? renderHeaderSlot\(spec, i\) : undefined\}/)

  // It is a dependency of every header cell, so the memo has to see it or a consumer's
  // popover state would be frozen at the identity it had on first render.
  const memo = code.slice(code.indexOf('const headerRow'), code.indexOf('const fixedHeaderContent'))
  assert.ok(memo.includes('renderHeaderSlot'), 'the header memo must depend on the slot renderer')
  assert.match(memo, /onResizeColumn, renderHeaderSlot,?[\s\S]{0,200}\],\s*\);/)

  // The header cell renders NO slot element at all when it is handed nothing — not an
  // empty wrapper, which would still occupy the gap beside every label.
  const header = readFileSync(join(ROOT, 'components/shared/table/HeaderCell.tsx'), 'utf8')
  assert.match(header, /\{filterSlot \? \(/)
  assert.match(header, /data-grid-chrome/, 'the slot is chrome: a keystroke inside it is not a grid gesture')
})

// ═══ Slice 2's three seams — a partial save, a per-cell verdict, a canonical commit ═══
//
// All three were found the same way as the five before them: by a real consumer that
// could not say something. Each is additive, defaulted, and asserted here.

check('forgetRows drops ONLY the named rows, and returns the SAME object when it owes nothing', () => {
  const before = {
    a: { supplier: 'BRIX' },
    'a#s1': { moisture_pct: '12.4' },
    b: { remarks: 'wet' },
  }

  // A batch save is per ROW, so its outcome is per row: `a` and its draw landed, `b` came
  // back `version_conflict` and must keep every character the operator typed.
  const after = forgetRows(before, ['a', 'a#s1'])
  assert.deepEqual(Object.keys(after).sort(), ['b'])
  assert.deepEqual(after.b, { remarks: 'wet' })
  assert.notEqual(after, before, 'a real removal must produce a new object or React sees nothing')

  // The input is never mutated — the caller still holds the pre-save map while the save is
  // in flight, and a mutation here would rewrite it under them.
  assert.deepEqual(Object.keys(before).sort(), ['a', 'a#s1', 'b'])

  // …and REFERENTIAL EQUALITY when nothing named was held, so a save of a clean sheet (or
  // a verdict naming a row that was never dirty) does not re-render it.
  assert.equal(forgetRows(before, []), before)
  assert.equal(forgetRows(before, ['nobody', 'c#s9']), before)

  // It is NOT `reset`: forgetting everything by name leaves an empty map, not the original.
  assert.deepEqual(forgetRows(before, ['a', 'a#s1', 'b']), {})
})

check('TableEdits.forget clears the JOURNAL, because an undo past a save would un-write the DB', () => {
  const src = readFileSync(join(ROOT, 'lib/hooks/use-table-edits.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('applyEdits'), 'comment-stripping ate the source; this scan would be vacuous')

  // The pure projection above is the whole of "which rows", so there is no second copy of
  // the removal living in the hook.
  assert.match(code, /forgetRows\(editsRef\.current, rowIds\)/)

  const body = code.slice(code.indexOf('const forget ='), code.indexOf('const reset ='))
  assert.ok(body.length > 0, 'forget must be defined before reset; this slice would be vacuous')
  // Cleared, never filtered: ONE gesture can touch a saved row and an unsaved one — a paste
  // across three receipts is one step — so no step survives a save.
  assert.match(body, /journal\.clear\(\)/)
  // And it must not churn: no named row held anything AND no journal ⇒ no state write.
  assert.match(body, /if \(!changed && !hadJournal\) return/)

  // Both doors still exist and mean different things.
  assert.match(code, /forget\(rowIds: readonly string\[\]\): void/)
  assert.match(code, /reset\(\): void/)
})

check('parse is told WHICH cell it is judging — a column is not one thing on every family', () => {
  const src = readFileSync(join(ROOT, 'lib/hooks/use-table-interaction.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('validateOnCommit'), 'comment-stripping ate the source')

  // The context is built from the SLOT, so `field` is the one `occupies()` named and the
  // one every edit is filed under — never the column key, which is what makes a child
  // lane distinguishable from its parent's at all.
  assert.match(code, /field: at\.field,/)
  assert.match(code, /kind: at\.nav\.kind\.kind,/)
  assert.match(code, /rowId: at\.nav\.rowId,/)
  assert.match(code, /row: at\.nav\.data,/)
  assert.match(code, /at\.spec\.parse\(text, ctx, cellContextOf\(at\)\)/)

  // ADDITIVE: the argument is optional on the port, so a `parse` written before it existed
  // still typechecks and still behaves identically.
  const types = readFileSync(join(ROOT, 'lib/table/types.ts'), 'utf8')
  assert.match(types, /parse\?\(text: string, ctx: Ctx, cell\?: CellContext<Row>\): ColumnParseResult/)
  assert.match(types, /export interface CellContext<Row>/)
})

check('normalize runs INSIDE the single writer, before the write, on every commit path', () => {
  const src = readFileSync(join(ROOT, 'lib/hooks/use-table-interaction.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  const body = code.slice(code.indexOf('const commitEdit ='), code.indexOf('const revertEdit ='))
  assert.ok(body.includes('commit()'), 'commitEdit body not found; this scan would be vacuous')

  // Enter, Tab, a click on another cell (which preventDefaults the mousedown, so the editor
  // never blurs), a blur out of the grid and an arrow that commits all funnel through this
  // one function. Normalising in the EDITOR would cover some of them and silently miss the
  // rest; normalising AFTER the write would cost a second journal step.
  assert.match(body, /at\?\.spec\.normalize/)
  assert.ok(
    body.indexOf('normalize') < body.indexOf('setCellText'),
    'the canonical text must be produced BEFORE the single write, not corrected after it',
  )
  // Omitted ⇒ the operator's own text, byte-identical with before the seam existed.
  assert.match(body, /: draft\.text;/)
  // It may not refuse — `parse` runs on whatever it produced, which is what keeps an
  // unreadable value both KEPT and REFUSED BY NAME.
  assert.ok(body.indexOf('setCellText') < body.indexOf('commit()'))

  const types = readFileSync(join(ROOT, 'lib/table/types.ts'), 'utf8')
  assert.match(types, /normalize\?\(text: string, ctx: Ctx, cell\?: CellContext<Row>\): string/)
})

check('formatEdited renders an unsaved DERIVED value, and its absence is the raw text', () => {
  const src = readFileSync(join(ROOT, 'components/shared/table/Row.tsx'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('TableCellsInner'), 'comment-stripping ate the source')

  // A dirty cell cannot render through `format` (that reads the STORED row), so it renders
  // the raw text — right for most columns, wrong for any lane whose stored form is a
  // DERIVATION of what is typed: `=27045*88%` in a right-aligned figure column.
  assert.match(code, /col\.formatEdited\s*\n?\s*\?\s*col\.formatEdited\(rowEdits\[slot\.field\] as string, ctx\)/)
  // ADDITIVE: absent ⇒ the raw text, exactly as before.
  assert.match(code, /:\s*rowEdits\[slot\.field\]/)

  // It takes the TEXT and the ctx, and deliberately no cell context: it runs on the row
  // render path, and an object per dirty cell per render would buy an answer no derivation
  // needs.
  const types = readFileSync(join(ROOT, 'lib/table/types.ts'), 'utf8')
  assert.match(types, /formatEdited\?\(text: string, ctx: Ctx\): React_Node/)
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

// ═══ The selection RECTANGLE — one box, no inner borders ══════════════════════
//
// Renzo, on the shipped behaviour: *"highlighting and selecting multiple cells keeps the
// border only on the first selected cell and never grows to the rest of the selection
// (only highlight does)."* The geometry that fixes it is pure, so it is asserted here
// rather than inferred from a screenshot.

check('rangeRowEdge names a row\'s place in the rectangle, and only rows inside it', () => {
  assert.equal(rangeRowEdge(3, 7, 2), 'none')
  assert.equal(rangeRowEdge(3, 7, 8), 'none')
  assert.equal(rangeRowEdge(3, 7, 3), 'top')
  assert.equal(rangeRowEdge(3, 7, 5), 'middle')
  assert.equal(rangeRowEdge(3, 7, 7), 'bottom')
  // A ONE-ROW rectangle is both edges at once — the case a pair of "is first"/"is last"
  // booleans gets right and a single "which edge" enum would get wrong.
  assert.equal(rangeRowEdge(4, 4, 4), 'both')
})

check('a swept block paints its PERIMETER and nothing inside it', () => {
  // Rows 2..4 × columns 1..3. Walk every cell of the rectangle and its surroundings.
  const at = (navRow: number, col: number) =>
    cellRangeEdges({ rowEdge: rangeRowEdge(2, 4, navRow), fromCol: 1, toCol: 3, col })

  // The four corners carry two edges each.
  assert.deepEqual(at(2, 1), { top: true, right: false, bottom: false, left: true })
  assert.deepEqual(at(2, 3), { top: true, right: true, bottom: false, left: false })
  assert.deepEqual(at(4, 1), { top: false, right: false, bottom: true, left: true })
  assert.deepEqual(at(4, 3), { top: false, right: true, bottom: true, left: false })

  // The sides carry one.
  assert.deepEqual(at(2, 2), { top: true, right: false, bottom: false, left: false })
  assert.deepEqual(at(3, 1), { top: false, right: false, bottom: false, left: true })
  assert.deepEqual(at(3, 3), { top: false, right: true, bottom: false, left: false })
  assert.deepEqual(at(4, 2), { top: false, right: false, bottom: true, left: false })

  // THE WHOLE POINT: an interior cell paints NOTHING — no inner borders — and it is handed
  // the shared instance, so an interior cell allocates nothing on the render path.
  assert.equal(at(3, 2), NO_RANGE_EDGES)

  // Outside the rectangle in either axis: nothing.
  assert.equal(at(1, 2), NO_RANGE_EDGES)
  assert.equal(at(5, 2), NO_RANGE_EDGES)
  assert.equal(at(3, 0), NO_RANGE_EDGES)
  assert.equal(at(3, 4), NO_RANGE_EDGES)
})

check('a 1x1 selection paints NO box — the caret ring is the whole answer', () => {
  // A plain click seeds a 1x1 selection, so this is the DEFAULT state of the sheet: it
  // has to be byte-identical with the behaviour before the box existed, or every click
  // grows a second rectangle a pixel inside the ring.
  assert.equal(cellRangeEdges({ rowEdge: 'both', fromCol: 4, toCol: 4, col: 4 }), NO_RANGE_EDGES)

  // One row and MORE than one column is not that case, and does get a box.
  assert.deepEqual(cellRangeEdges({ rowEdge: 'both', fromCol: 4, toCol: 5, col: 4 }), {
    top: true, right: false, bottom: true, left: true,
  })
  // Neither is one column and more than one row.
  assert.deepEqual(cellRangeEdges({ rowEdge: 'top', fromCol: 4, toCol: 4, col: 4 }), {
    top: true, right: true, bottom: false, left: true,
  })
})

check('the class key includes the four edge flags, and each one changes the paint', () => {
  // The cache is only sound if the key names everything that changes the string. Omitting
  // the edges would serve whichever combination the cache saw FIRST to every cell of the
  // rectangle — one cell's worth of borders painted on all of them.
  const t = createCellClassTable()
  const base = t.get(baseKey)
  assert.equal(t.size(), 1)

  const flags = ['edgeTop', 'edgeRight', 'edgeBottom', 'edgeLeft'] as const
  const seen = new Set<string>([cellClassKey(baseKey)])
  for (const flag of flags) {
    const key = { ...baseKey, [flag]: true }
    const k = cellClassKey(key)
    assert.ok(!seen.has(k), `${flag} does not reach the cache key`)
    seen.add(k)
    assert.notEqual(t.get(key).inner, base.inner, `${flag} does not change the class string`)
  }
  assert.equal(t.size(), 5, 'each distinct key built exactly one entry')

  // ALL FOUR SIDES ARE ALWAYS DECLARED — transparent off an edge, primary on one — so no
  // two of them can land in the same tailwind-merge group at different specificities and
  // let the stylesheet decide which wins.
  for (const key of [baseKey, { ...baseKey, edgeTop: true, edgeLeft: true }]) {
    const inner = t.get(key).inner
    for (const side of ['t', 'r', 'b', 'l']) {
      assert.equal(
        (inner.match(new RegExp(`(?:^|\\s)border-${side}-[^\\s]+`, 'g')) ?? []).length,
        1,
        `exactly one border-${side}-* class`,
      )
    }
  }
  assert.match(t.get({ ...baseKey, edgeTop: true }).inner, /border-t-primary/)
  assert.match(t.get(baseKey).inner, /border-t-transparent/)
})

check('a cell CLIPS: no spill into the neighbour, no wrap onto a second line', () => {
  // Measured on the QC sheet: a `yyyy-MM-dd` in a 62px column painted over the cell beside
  // it, and `WHSE 3` wrapped to two lines inside a row whose height its family declared.
  // Neither reads as a width problem, which is why neither got fixed by widening.
  const t = createCellClassTable()
  for (const exists of [true, false]) {
    const inner = t.get({ ...baseKey, exists }).inner
    assert.match(inner, /(?:^|\s)overflow-hidden(?:\s|$)/, 'a cell must clip its own content')
    assert.match(inner, /(?:^|\s)whitespace-nowrap(?:\s|$)/, 'a cell is one line')
    // Even a cell the row does not have reserves the border gutter, or its neighbours'
    // text sits a pixel off from every other row.
    assert.match(inner, /(?:^|\s)border(?:\s|$)/)
  }
  // True ellipsis for the element children a `format` returns — a flex container is not a
  // block container, so `text-overflow` on the cell itself would do nothing for them.
  assert.match(t.get(baseKey).inner, /\[&>\*\]:text-ellipsis/)
  assert.match(t.get(baseKey).inner, /\[&>\*\]:min-w-0/)
})

// ═══ The built-in right-click menu ════════════════════════════════════════════

check('the default menu is a pure function of the cell — mutating items only where an edit lands', () => {
  const readOnly = defaultTableMenu({ editable: false, hasRow: true, hasSelection: true })
  const editable = defaultTableMenu({ editable: true, hasRow: true, hasSelection: true })

  const actions = (items: { action: string }[]) => items.map((i) => i.action)

  // A READ-ONLY grid — which is what all ten migrated grids are, structurally, since none
  // of their columns declares a `parse` — is offered nothing that could ask it to change.
  assert.deepEqual(actions(readOnly), [
    'copy', 'copy-with-headers', 'copy-row', 'select-row', 'select-column', 'clear-selection',
  ])
  for (const item of readOnly) assert.ok(!item.mutates, `${item.action} must not be offered on a read-only cell`)

  // The mutating three are ADDED, and the read-only six are unchanged and in the same
  // order — the menu grows, it never rearranges itself under the operator.
  assert.deepEqual(actions(editable), [
    'copy', 'copy-with-headers', 'copy-row',
    'clear-contents', 'paste', 'fill-down',
    'select-row', 'select-column', 'clear-selection',
  ])
  assert.deepEqual(
    editable.filter((i) => i.mutates).map((i) => i.action),
    ['clear-contents', 'paste', 'fill-down'],
  )

  // A click that landed on CHROME has no row to copy and no row to select.
  assert.deepEqual(actions(defaultTableMenu({ editable: false, hasRow: false, hasSelection: false })), [
    'copy', 'copy-with-headers', 'select-column',
  ])
  // "Clear selection" is offered only when there IS one.
  assert.ok(!actions(defaultTableMenu({ editable: true, hasRow: true, hasSelection: false }))
    .includes('clear-selection'))

  // PURE: same input, same output, and never the same object twice (a caller mutating the
  // list must not poison the next menu).
  const a = defaultTableMenu({ editable: true, hasRow: true, hasSelection: true })
  const b = defaultTableMenu({ editable: true, hasRow: true, hasSelection: true })
  assert.deepEqual(a, b)
  assert.notEqual(a, b)
})

check('the menu is rendered for EVERY grid, and each action is the gesture that already existed', () => {
  const table = readFileSync(join(ROOT, 'components/shared/table/BlackwoodTable.tsx'), 'utf8')
  const code = table.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('defaultTableMenu'), 'comment-stripping ate the source')

  // BEFORE: `if (!contextMenuItems) return;` — a grid that supplied no items had no menu,
  // which is nine of the ten migrated screens. The gate is now the explicit opt-OUT.
  assert.match(code, /if \(disableDefaultContextMenu && !contextMenuItems\) return;/)

  // Every action maps onto the interaction hook's own callback, so "Copy" in the menu and
  // Ctrl/Cmd+C cannot mean two different things.
  for (const wire of [
    'copy: menuActions.copy',
    "'copy-with-headers': menuActions.copyWithHeaders",
    'menuActions.copyRow(cell.row)',
    'menuActions.selectRow(cell.row)',
    'menuActions.selectColumn(cell.col)',
    "'clear-selection': menuActions.clearSelection",
    "'clear-contents': menuActions.clearContents",
    'paste: menuActions.paste',
    "'fill-down': menuActions.fillDown",
  ]) {
    assert.ok(code.includes(wire), `the menu does not wire ${wire}`)
  }

  // BOTH halves of the editability verdict, exactly as `useTableInteraction` combines
  // them: the row family's `editable` AND the column's `columnAcceptsEdit`.
  assert.match(code, /slot\.editable/)
  assert.match(code, /columnAcceptsEdit\(spec, nav\?\.data \?\? null, ctx\)/)

  // It REUSES the shared popover rather than growing a third hand-rolled one.
  assert.match(code, /<GridContextMenu/)
  assert.match(code, /useGridContextMenu</)

  // Closing hands the caret back — a menu item has already unmounted when focus would be
  // restored to it, so focus lands on <body> and the sheet reads as dead.
  assert.match(code, /closeMenu\(\);\s*\n\s*focusGrid\(\);/)
})

// ═══ Resize, the summary pill, and the per-cell class — default-ON, not props ══

check('a column resizes WITHOUT a consumer that persists widths', () => {
  const table = readFileSync(join(ROOT, 'components/shared/table/BlackwoodTable.tsx'), 'utf8')
  const code = table.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('onResizeColumn'), 'comment-stripping ate the source')

  // BEFORE: `onResize={onSettingsChange ? onResizeColumn : undefined}` — so `HeaderCell`'s
  // `resizable` was false and no handle rendered at all on any grid that had not wired
  // per-user settings. Which was nine of ten, and reads exactly like a missing feature.
  assert.match(code, /onResize=\{onResizeColumn\}/)
  assert.ok(
    !/onResize=\{onSettingsChange \?/.test(code),
    'the handle must not be gated on the persistence prop',
  )
  // Delegate when there is somewhere to delegate to; keep it for the session otherwise.
  assert.match(code, /if \(onSettingsChange\) \{/)
  assert.match(code, /setLocalWidths\(/)
  // ADDITIVE: `undefined` while nothing has been dragged, so an unmanaged grid resolves
  // its columns from exactly the object it did before — identity included, which is what
  // the column memo compares.
  assert.match(code, /if \(onSettingsChange \|\| Object\.keys\(localWidths\)\.length === 0\) return settings\?\.widths;/)

  // The column's own opt-out is untouched: the spec still decides.
  const header = readFileSync(join(ROOT, 'components/shared/table/HeaderCell.tsx'), 'utf8')
  assert.match(header, /spec\.resizable !== false && onResize !== undefined/)
  // And the handle ANNOUNCES itself, which is the difference between a feature and a
  // feature nobody found.
  assert.match(header, /group-hover\/th:opacity-100/)
})

check('the selection aggregates leave the table by themselves', () => {
  const table = readFileSync(join(ROOT, 'components/shared/table/BlackwoodTable.tsx'), 'utf8')
  const code = table.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('useOptionalStatusBar'), 'comment-stripping ate the source')

  // The numbers were computed on every gesture and DISCARDED, and a consumer could not
  // recompute them: the rectangle is in nav-row coordinates it does not own. Published
  // from inside the table, so a consumer wires nothing at all.
  assert.match(code, /setCellSelectionCount\?\.\(selectionSize\)/)
  assert.match(code, /setCellAggregates\?\.\(aggregates\)/)
  // OPTIONAL provider: the grid mounts outside the app shell (the playground does), and a
  // shared primitive that throws over a missing ambient provider is not shared.
  const provider = readFileSync(join(ROOT, 'components/providers/status-bar-context.tsx'), 'utf8')
  assert.match(provider, /export function useOptionalStatusBar\(\)/)
  assert.ok(
    !/useOptionalStatusBar[\s\S]{0,200}throw/.test(provider),
    'the optional reader must never throw',
  )

  // The clear is its OWN effect over the two STABLE setters, so it runs on unmount and at
  // no other time — folded into the cleanup above it would fire a "0 cells" between every
  // two selections and the pill would flicker empty on every drag.
  const clear = code.slice(code.indexOf('React.useEffect(\n        () => () => {'))
  assert.match(clear.slice(0, 300), /setCellSelectionCount\?\.\(0\)/)
  assert.match(clear.slice(0, 400), /\[setCellSelectionCount, setCellAggregates\],/)

  // And the range still goes out with its numbers attached, for a consumer that wants
  // them somewhere other than the pill.
  const hook = readFileSync(join(ROOT, 'lib/hooks/use-table-interaction.ts'), 'utf8')
  assert.match(hook, /onSelectionChange\?\(range: CellRange \| null, meta\?: SelectionMeta\): void/)
  assert.match(hook, /selectionChangeRef\.current\?\.\(selectionRange, \{ size: selectionSize, aggregates \}\)/)
})

check('cellClass tints a WHOLE cell and layers UNDER the states the operator navigates by', () => {
  const row = readFileSync(join(ROOT, 'components/shared/table/Row.tsx'), 'utf8')
  const code = row.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('TableCellsInner'), 'comment-stripping ate the source')

  // PRECEDENCE, and it is the whole safety property: the consumer's classes are merged
  // FIRST, so `selected` / `active` / `invalid` / `dirty` win. A consumer cannot hide the
  // states the operator navigates by, however loud its tint.
  assert.match(code, /cn\(extra, cls\.inner\)/)
  assert.ok(!/cn\(cls\.inner, extra\)/.test(code), 'the cached string must win, not the tint')
  // ADDITIVE: a column that declares nothing gets the cached string with no merge at all,
  // so the cost is paid only by the cells that use it.
  assert.match(code, /extra \? cn\(extra, cls\.inner\) : cls\.inner/)
  // Never asked for a cell the row does not have.
  assert.match(code, /exists \? col\.cellClass\?\.\(data, ctx\) : undefined/)

  const types = readFileSync(join(ROOT, 'lib/table/types.ts'), 'utf8')
  assert.match(types, /cellClass\?\(row: Row \| null, ctx: Ctx\): string \| undefined/)
})

check('a header may WRAP or carry a NODE, and label stays the string three things read', () => {
  const types = readFileSync(join(ROOT, 'lib/table/types.ts'), 'utf8')
  assert.match(types, /label: string;/, 'label stays a plain required string')
  assert.match(types, /labelNode\?: React_Node;/)
  assert.match(types, /headerWrap\?: boolean;/)

  const header = readFileSync(join(ROOT, 'components/shared/table/HeaderCell.tsx'), 'utf8')
  // DEFAULT IS TODAY'S BEHAVIOUR: one line, truncated. Wrapping is bounded at two lines,
  // because the whole header row grows to its tallest cell.
  assert.match(header, /spec\.headerWrap\s*\n?\s*\?\s*'whitespace-normal break-words leading-tight line-clamp-2'\s*\n?\s*:\s*'truncate'/)
  assert.match(header, /\{spec\.labelNode \?\? spec\.label\}/)
  // The three text readers keep reading the STRING — a node cannot be a tooltip, an
  // aria-label or a clipboard header.
  assert.match(header, /title=\{spec\.title \?\? spec\.label\}/)
  assert.match(header, /aria-label=\{`Resize \$\{spec\.label\}`\}/)
  const hook = readFileSync(join(ROOT, 'lib/hooks/use-table-interaction.ts'), 'utf8')
  assert.match(hook, /tsvEscape\(cols\[c\]\?\.label \?\? ''\)/)
})

// ═══ THE ANCHOR'S RING, INSIDE A BOX ══════════════════════════════════════════
//
// Renzo, on a swept range: the perimeter painted correctly and the cell the sweep started
// from still carried its own full ring — "two nested boxes", "not intended behavior".

check('a multi-cell selection has ONE rectangle: the anchor loses its ring', () => {
  const t = createCellClassTable()

  // A cell inside a box that is actually drawn: no ring.
  const boxedAnchor = t.get({ ...baseKey, active: true, selected: true, boxed: true })
  assert.ok(!/ring-2/.test(boxedAnchor.inner), 'the anchor must not draw a second rectangle')
  assert.ok(!/z-20/.test(boxedAnchor.inner), 'the ring is gone, so its stacking bump goes with it')
  // …and it is still visibly SELECTED. Suppressing the ring may not cost the tint.
  assert.match(boxedAnchor.inner, /bg-primary/)

  // A plain click — 1×1, no box — is byte-identical with before.
  const lone = t.get({ ...baseKey, active: true, selected: true, boxed: false })
  assert.match(lone.inner, /ring-2 ring-primary ring-inset/)
  assert.match(lone.inner, /z-20/)

  // A caret parked OUTSIDE the rectangle (what a header click's column sweep leaves)
  // keeps its ring — which is why `boxed` is not simply "a multi-cell selection exists".
  assert.match(t.get({ ...baseKey, active: true, selected: false, boxed: false }).inner, /ring-2/)

  // IN THE CACHE KEY, or the first combination seen would decide the ring for every cell
  // after it — the same failure the four edge flags were added to the key to prevent.
  assert.notEqual(
    cellClassKey({ ...baseKey, active: true, selected: true, boxed: true }),
    cellClassKey({ ...baseKey, active: true, selected: true, boxed: false }),
  )
  assert.notEqual(boxedAnchor, lone)
})

check('the ROW derives `boxed` from the geometry it already has, not from a new prop', () => {
  const row = readFileSync(join(ROOT, 'components/shared/table/Row.tsx'), 'utf8')
  const code = row
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('boxedSelection'), 'comment-stripping ate the source')

  // The 1×1 test is the SAME one `cellRangeEdges` uses to decline to paint, so the box
  // and the ring can never both be absent or both be present.
  assert.match(code, /selectionRowEdge === 'both' && selectionBand\[0\] === selectionBand\[1\]/)
  assert.match(code, /boxed: selected && boxedSelection/)

  // And the pure helper still agrees: a 1×1 range paints nothing.
  assert.equal(cellRangeEdges({ rowEdge: 'both', fromCol: 3, toCol: 3, col: 3 }), NO_RANGE_EDGES)
  assert.notEqual(cellRangeEdges({ rowEdge: 'both', fromCol: 3, toCol: 5, col: 3 }), NO_RANGE_EDGES)
})

// ═══ `rowCopy` — a column that is not part of the record ══════════════════════

check('Copy row skips a column that opted out; a swept rectangle does not', () => {
  const cols = [
    { key: 'state' as const, rowCopy: false },
    { key: 'date' as const },
    { key: 'supplier' as const },
    { key: 'actions' as const, rowCopy: false },
  ]
  assert.deepEqual(rowCopyColumns(cols), [1, 2], 'the opted-out columns are absent, not blank')
  // ADDITIVE by default: a column list that says nothing copies whole.
  assert.deepEqual(rowCopyColumns([{ key: 'a' }, { key: 'b' }, { key: 'c' }]), [0, 1, 2])
  // `rowCopy: true` is the same as omitting it — never `=== false`, always `!== false`.
  assert.deepEqual(rowCopyColumns([{ key: 'a', rowCopy: true }, { key: 'b', rowCopy: false }]), [0])
  assert.deepEqual(rowCopyColumns([]), [])

  const hook = readFileSync(join(ROOT, 'lib/hooks/use-table-interaction.ts'), 'utf8')
  const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('copyRowCells'), 'comment-stripping ate the source')

  // The ROW copy consults it…
  assert.match(code, /const colIdx = rowCopyColumns\(cols\);/)
  // …and the RECTANGLE copy builds its columns from the range ALONE. If the operator
  // swept the column deliberately, they asked for it.
  const tsvOf = code.slice(code.indexOf('const tsvOf'), code.indexOf('const copySelection'))
  assert.match(tsvOf, /for \(let c = range\.startCol; c <= range\.endCol; c\+\+\) colIdx\.push\(c\);/)
  assert.ok(!/rowCopy/.test(tsvOf), 'a rectangle copy must never consult rowCopy')

  // ONE column list behind both row-copy forms, so the headers line can never name
  // different columns than the values under it.
  assert.match(code, /copyRow\(navRow: number, opts\?: \{ headers\?: boolean \}\): void/)
  assert.match(code, /colIdx\.map\(\(c\) => tsvEscape\(cols\[c\]\?\.label \?\? ''\)\)/)
})

// ═══ SORT + FILTER — the view transform ═══════════════════════════════════════

interface VRow {
  id: string
  code: string
  qty: number | null
}

const V_PARENT: Record<string, { field: string; editable: boolean }> = {
  code: { field: 'code', editable: true },
  qty: { field: 'qty', editable: true },
}
/** A child is NOT a small parent: it has no figure, so it has no sort key of its own. */
const V_CHILD: Record<string, { field: string; editable: boolean }> = {
  code: { field: 'code', editable: true },
}

const viewKinds: ReadonlyMap<string, RowKind<VRow>> = new Map<string, RowKind<VRow>>([
  ['record', { kind: 'record', height: 32, addressable: true, occupies: (k) => V_PARENT[k] ?? null }],
  ['child', { kind: 'child', height: 26, addressable: true, occupies: (k) => V_CHILD[k] ?? null }],
  ['draft', { kind: 'draft', height: 32, addressable: true, occupies: (k) => V_PARENT[k] ?? null }],
  ['spacer', { kind: 'spacer', height: 8, addressable: false, occupies: () => null }],
])

const viewCols: ColumnSpec<VRow, unknown>[] = [
  {
    key: 'code', label: 'CODE', width: 100,
    format: (r) => r.code,
    clipboardValue: (r) => r.code,
  },
  {
    key: 'qty', label: 'QTY', width: 80, align: 'right',
    format: (r) => String(r.qty ?? ''),
    numericValue: (r) => r.qty,
    clipboardValue: (r) => (r.qty === null ? '' : String(r.qty)),
  },
  { key: 'num', label: '#', width: 40, cellKind: 'derived', format: () => null },
]

const vRec = (id: string, code: string, qty: number | null): GridRow<VRow> => ({
  kind: 'record', id, data: { id, code, qty },
})
const vKid = (id: string, code: string): GridRow<VRow> => ({
  kind: 'child', id, data: { id, code, qty: null },
})

/** Spacers, a parent with a child, a blank figure, and a draft at the end. */
const VIEW_ITEMS: GridRow<VRow>[] = [
  { kind: 'spacer', key: 'sp1' },
  vRec('r1', 'B', 20),
  vKid('r1c0', 'B-a'),
  vRec('r2', 'A', 30),
  { kind: 'spacer', key: 'sp2' },
  vRec('r3', 'C', 10),
  vRec('r4', 'D', null),
  { kind: 'draft', id: 'd0' },
]

const idsOf = (items: readonly GridRow<VRow>[]): string[] =>
  items.map((i) => ('id' in i ? i.id : `~${i.key}`))

function runView(sort: Parameters<typeof applyTableView>[0]['sort'], filters = NO_FILTERS) {
  return applyTableView<VRow, unknown>({
    items: VIEW_ITEMS,
    kinds: viewKinds,
    cols: viewCols,
    sort,
    filters,
    childKinds: ['child'],
    draftKind: 'draft',
    storedText: () => '',
  })
}

check('no sort and no filter returns the SAME ARRAY — the whole feature is free when unused', () => {
  const v = runView(null)
  assert.equal(v.items, VIEW_ITEMS, 'the identity must survive, or every memo downstream misses')
  assert.equal(v.sorted, false)
  assert.equal(v.filtered, false)
  assert.equal(v.total, 4, 'four DATA rows: the child, the spacers and the draft are not counted')
  assert.equal(v.matched, 4)

  // A sort naming a column that is not in the resolved set (hidden for this viewer,
  // removed from the specs) is simply not a sort. Nothing throws, nothing reorders.
  assert.equal(runView({ key: 'ghost', dir: 'asc' }).items, VIEW_ITEMS)
})

check('a sorted view HIDES the chrome rows and renders the data flat', () => {
  const asc = runView({ key: 'code', dir: 'asc' })
  assert.equal(asc.sorted, true)
  // No `~sp1` / `~sp2`: a group heading or a rule-off is a claim about a RUN of adjacent
  // rows, and a sort destroys the run. There is no honest way to re-tile one without
  // knowing what it means, which is the tenant knowledge this layer may not have.
  assert.ok(!idsOf(asc.items).some((id) => id.startsWith('~')), 'chrome rows must not survive a sort')
  // Clearing restores the consumer's own flatten EXACTLY — same array, spacers included.
  assert.equal(runView(null).items, VIEW_ITEMS)
})

check('a sort keeps a CHILD glued to its parent, and never sorts it as a peer', () => {
  // A → B(+child) → C → D(blank). The child rides with `r1` wherever it lands.
  assert.deepEqual(idsOf(runView({ key: 'code', dir: 'asc' }).items), ['r2', 'r1', 'r1c0', 'r3', 'r4', 'd0'])
  assert.deepEqual(idsOf(runView({ key: 'code', dir: 'desc' }).items), ['r4', 'r3', 'r1', 'r1c0', 'r2', 'd0'])
  // The child immediately FOLLOWS its parent in both directions — it is never emitted
  // first, and never separated from it.
  for (const dir of ['asc', 'desc'] as const) {
    const ids = idsOf(runView({ key: 'code', dir }).items)
    assert.equal(ids[ids.indexOf('r1') + 1], 'r1c0')
  }
})

check('a DRAFT never sorts and never filters out', () => {
  // Rule 4: a row being typed must not jump to the top, and must not vanish because it
  // does not match a filter yet.
  for (const dir of ['asc', 'desc'] as const) {
    const ids = idsOf(runView({ key: 'qty', dir }).items)
    assert.equal(ids[ids.length - 1], 'd0', 'the blank-row pool stays at the end')
  }
  const filtered = runView(null, { code: { text: 'zzz' } })
  assert.deepEqual(idsOf(filtered.items), ['d0'])
  assert.equal(filtered.matched, 0)
  assert.equal(filtered.total, 4, 'the draft is not counted as a data row either')
})

check('a numeric column sorts by its NUMBER, and blanks go last in BOTH directions', () => {
  // 10 · 20 · 30 · (blank). Not `String(10) < String(20) < String(30)` by luck — `qty`
  // declares a `numericValue`, so the comparator is arithmetic.
  assert.deepEqual(idsOf(runView({ key: 'qty', dir: 'asc' }).items), ['r3', 'r1', 'r1c0', 'r2', 'r4', 'd0'])
  // DESC reverses the figures and leaves the blank where it was: an operator sorting
  // descending is looking for the big numbers, not for the empty cells.
  assert.deepEqual(idsOf(runView({ key: 'qty', dir: 'desc' }).items), ['r2', 'r1', 'r1c0', 'r3', 'r4', 'd0'])
})

check('a text sort is locale-aware and NUMERIC-aware, so R-2 comes before R-10', () => {
  const items: GridRow<VRow>[] = [
    vRec('a', 'R-10', 1),
    vRec('b', 'R-2', 2),
    vRec('c', 'r-1', 3),
  ]
  const v = applyTableView<VRow, unknown>({
    items, kinds: viewKinds, cols: viewCols,
    sort: { key: 'code', dir: 'asc' }, filters: NO_FILTERS, storedText: () => '',
  })
  // `numeric: true` on the collator, and `sensitivity: 'base'` so a lowercase `r-1` is
  // not exiled to the far end of the sheet.
  assert.deepEqual(idsOf(v.items), ['c', 'b', 'a'])
})

check('a text filter is case-insensitive CONTAINS, and two filters AND', () => {
  const one = runView(null, { code: { text: 'b' } })
  assert.equal(one.filtered, true)
  assert.deepEqual(idsOf(one.items), ['r1', 'r1c0', 'd0'], 'the child rides with its parent here too')
  assert.equal(one.matched, 1)
  assert.equal(one.total, 4)
  // Chrome goes under a filter for the same reason as under a sort: a heading over a
  // group whose every row was filtered out is a heading over nothing.
  assert.ok(!idsOf(one.items).some((id) => id.startsWith('~')))

  // Bounds over `numericValue`, inclusive.
  assert.deepEqual(idsOf(runView(null, { qty: { min: 20 } }).items), ['r1', 'r1c0', 'r2', 'd0'])
  assert.deepEqual(idsOf(runView(null, { qty: { max: 20 } }).items), ['r1', 'r1c0', 'r3', 'd0'])
  assert.deepEqual(idsOf(runView(null, { qty: { min: 20, max: 20 } }).items), ['r1', 'r1c0', 'd0'])

  // AND across columns.
  assert.deepEqual(idsOf(runView(null, { code: { text: 'a' }, qty: { min: 25 } }).items), ['r2', 'd0'])
  assert.deepEqual(idsOf(runView(null, { code: { text: 'a' }, qty: { max: 25 } }).items), ['d0'])

  // A row with NO NUMBER fails a bounds filter rather than counting as 0 — otherwise
  // `min: 0` would quietly sweep in every unpriced row.
  assert.ok(!idsOf(runView(null, { qty: { min: 0 } }).items).includes('r4'))
})

check('an EMPTY filter is not a filter, and the cycle is asc → desc → off', () => {
  // A box the operator typed into and then cleared has to give every row back — and, with
  // it, the group headings rule 2 took away.
  assert.equal(isColumnFilterActive(undefined), false)
  assert.equal(isColumnFilterActive({}), false)
  assert.equal(isColumnFilterActive({ text: '' }), false)
  assert.equal(isColumnFilterActive({ text: '   ' }), false)
  assert.equal(isColumnFilterActive({ text: 'a' }), true)
  assert.equal(isColumnFilterActive({ min: 0 }), true, 'a bound of zero IS a bound')
  assert.equal(isColumnFilterActive({ max: 0 }), true)
  assert.equal(runView(null, { code: { text: '  ' } }).items, VIEW_ITEMS, 'and the array identity survives')

  assert.equal(activeFilterCount(NO_FILTERS), 0)
  assert.equal(activeFilterCount({ a: { text: '' }, b: { text: 'x' }, c: { min: 1 } }), 2)

  // OFF is `null`, never a third direction: "not sorted" has to restore the consumer's
  // own row order rather than being an ordering of its own.
  assert.equal(nextSortDirection(null), 'asc')
  assert.equal(nextSortDirection(undefined), 'asc')
  assert.equal(nextSortDirection('asc'), 'desc')
  assert.equal(nextSortDirection('desc'), null)
})

check('which columns OFFER a sort or a filter — declared, with the same default as selectable', () => {
  const plain = viewCols[0]
  const derived = viewCols[2]
  assert.equal(columnSortable(plain), true)
  assert.equal(columnFilterable(plain), true)
  // A row ordinal / an actions cluster has nothing to order by and nothing to search.
  assert.equal(columnSortable(derived), false)
  assert.equal(columnFilterable(derived), false)
  // The spec always wins, in both directions.
  assert.equal(columnSortable({ ...plain, sortable: false }), false)
  assert.equal(columnFilterable({ ...plain, filterable: false }), false)
  assert.equal(columnSortable({ ...derived, sortable: true }), true)
  assert.equal(columnFilterable({ ...derived, filterable: true }), true)
})

check('the scope decides whether sort and filter are OFFERED, and the selection drops when they move', () => {
  const table = readFileSync(join(ROOT, 'components/shared/table/BlackwoodTable.tsx'), 'utf8')
  const code = table.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('applyTableView'), 'comment-stripping ate the source')

  // ON in `focus`, OFF in `endless`: an endless grid's order and window are the SERVER's
  // keyset, and a client sort over the loaded rows would make `hasOlder`/`hasNewer` lie.
  assert.match(code, /const sortEnabled = props\.enableSort \?\? scope === 'focus';/)
  assert.match(code, /const filterEnabled = props\.enableFilter \?\? scope === 'focus';/)
  // A disabled axis is neutralised at the TRANSFORM, not merely hidden in the header —
  // so flipping the prop off can never leave a stale sort silently applied.
  assert.match(code, /const activeSort = sortEnabled \? sort : null;/)
  assert.match(code, /const activeFilters = filterEnabled \? filters : NO_FILTERS;/)

  // The rectangle is in NAV-ROW coordinates and this is exactly the operation that
  // changes which row each coordinate names.
  assert.match(code, /clearSelectionCells\(\);\s*\n\s*setActiveCell\(null\);/)

  // Everything downstream reads the TRANSFORMED array — a second row axis here would be
  // the `firstItemIndex` bug in another costume.
  assert.match(code, /const rows = useTableRows\(\{ items: viewItems, kinds, cols \}\);/)
  assert.match(code, /data=\{viewItems as GridRow<Row>\[\]\}/)
  assert.match(code, /\{viewItems\.map\(\(item, index\) => \{/)
  assert.match(code, /viewItems\.forEach\(\(it, i\) => m\.set\(it, i\)\)/)
})

// ═══ The header: a click override, and a real second line ═════════════════════

check('onHeaderClick replaces the column sweep, and the sort caret stays its own button', () => {
  const types = readFileSync(join(ROOT, 'lib/table/types.ts'), 'utf8')
  assert.match(types, /onHeaderClick\?\(spec: ColumnSpec<Row, Ctx>\): void;/)
  assert.match(types, /subLabel\?: string;/)

  const header = readFileSync(join(ROOT, 'components/shared/table/HeaderCell.tsx'), 'utf8')
  const code = header.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('labelClickable'), 'comment-stripping ate the source')

  // INSTEAD OF, not as well as: a header that opens a drawer must not also sweep 400
  // cells behind the drawer.
  assert.match(code, /if \(headerClick\) headerClick\(spec\);\s*\n\s*else onSelectColumn\?\.\(index\);/)
  // A column with NEITHER is not a button that does nothing.
  assert.match(code, /const labelClickable = headerClick !== undefined \|\| onSelectColumn !== undefined;/)

  // The two affordances are SEPARATE buttons with their own handlers, so both work when
  // a column has an override AND a sort.
  assert.match(code, /data-sort-toggle=\{spec\.key\}/)
  assert.match(code, /data-filter-toggle=\{spec\.key\}/)
  assert.match(code, /onToggleSort\(spec\.key\)/)
  // Both stop the event, or the sweep behind them fires too.
  assert.equal((code.match(/e\.stopPropagation\(\);/g) ?? []).length >= 3, true)

  // The SUB-LABEL: rendered whenever present, independent of `headerWrap`, and always
  // ONE truncated line so the header row's growth stays bounded at two.
  assert.match(code, /\{spec\.subLabel \? \(/)
  // The TYPE is pinned, because it is the reason this seam exists at all: a two-line
  // header is DECLARED here rather than hand-drawn per screen, so the default has to
  // match the real usage (RC Movement's block headers, mirroring the live matrix's
  // `text-[10px] text-muted-foreground` sub-line) or every consumer routes around it.
  assert.match(code, /text-\[10px\] leading-tight text-muted-foreground"/)
  assert.match(code, /data-sub-label/)
  assert.ok(
    !/headerWrap[\s\S]{0,120}subLabel/.test(code),
    'the sub-label must not be gated on headerWrap — they answer different questions',
  )
})

// ═══ `sizing: 'fill'` — one number for the layout AND the sticky arithmetic ════

check('fill distributes slack INSIDE the resolution, so Σ widths IS the container', () => {
  const specs: ColumnSpec<unknown, unknown>[] = [
    { key: 'p1', label: 'P1', width: 60, pin: 'start', format: () => null },
    { key: 'p2', label: 'P2', width: 100, pin: 'start', format: () => null },
    { key: 'a', label: 'A', width: 100, format: () => null },
    { key: 'b', label: 'B', width: 300, format: () => null },
    { key: 'z', label: 'Z', width: 64, pin: 'end', format: () => null },
  ]
  assert.equal(resolveColumns(specs, {}).minWidth, 624)

  const filled = resolveColumns(specs, {}, undefined, { containerWidth: 1000 })

  // THE INVARIANT, first half: the table's own width is the container's.
  assert.equal(filled.minWidth, 1000)

  // THE INVARIANT, second half: every sticky offset is a PREFIX SUM of the widths that
  // are actually rendered. This is the whole bug — the offsets used to come from the
  // declared widths while `table-layout: fixed` scaled the rendered ones, so the frozen
  // block overlapped itself on a wide monitor.
  let x = 0
  filled.cols.forEach((c, i) => {
    assert.equal(filled.offsets[i], x, `offset ${i} must be the prefix sum`)
    x += c.width
  })
  assert.equal(x, filled.minWidth)
  assert.deepEqual(filled.pinnedLeft, [0, 60])
  assert.equal(filled.pinnedWidths.start, 160)
  assert.equal(filled.pinnedWidths.end, 64)

  // A PINNED column never grows: its width is a wall the caret-follow and the drag
  // auto-scroll measure from, and widening it hides MORE of the sheet, not less.
  assert.equal(filled.cols[0].width, 60)
  assert.equal(filled.cols[1].width, 100)
  assert.equal(filled.cols[4].width, 64)
  // The slack lands on the two scrolling columns, proportionally.
  assert.equal(filled.cols[2].width + filled.cols[3].width, 776)
  assert.ok(filled.cols[3].width > filled.cols[2].width, 'the wider lane absorbs more')
})

check('fill yields to the operator, and degrades rather than overlapping', () => {
  const specs: ColumnSpec<unknown, unknown>[] = [
    { key: 'p', label: 'P', width: 100, pin: 'start', format: () => null },
    { key: 'a', label: 'A', width: 100, format: () => null },
    { key: 'b', label: 'B', width: 100, format: () => null },
    { key: 'fixed', label: 'F', width: 100, format: () => null, resizable: false },
  ]

  // A width the operator DRAGGED is an instruction. It is excluded from the
  // distribution, so the drag never looks like it was ignored — and the slack it left
  // goes to the columns that did not ask for anything.
  const withDrag = resolveColumns(specs, {}, { widths: { a: 250 } }, { containerWidth: 800 })
  assert.equal(withDrag.cols[1].width, 250, 'the dragged width is exactly what was dragged')
  assert.equal(withDrag.minWidth, 800)
  assert.equal(withDrag.cols[0].width, 100, 'pinned: untouched')
  assert.equal(withDrag.cols[3].width, 100, 'resizable: false: untouched')
  assert.equal(withDrag.cols[2].width, 350, 'the only candidate takes all of the slack')

  // NOTHING to distribute into ⇒ nothing is distributed. The table then sizes to content
  // and leaves dead space, which is honest; stretching it is what overlapped the frozen
  // block in the first place.
  const noCandidates = resolveColumns(
    [specs[0], specs[3]], {}, undefined, { containerWidth: 900 },
  )
  assert.equal(noCandidates.minWidth, 200)

  // A container NARROWER than the columns distributes nothing — "never crush, always
  // scroll" is not negotiable, and a negative slack is a scrollbar, not a squeeze.
  assert.equal(resolveColumns(specs, {}, undefined, { containerWidth: 100 }).minWidth, 400)
  // Unmeasured (0) is the same as not asking.
  assert.equal(resolveColumns(specs, {}, undefined, { containerWidth: 0 }).minWidth, 400)

  // `'content'` is untouched: no fill argument, no change of any kind.
  assert.deepEqual(
    resolveColumns(specs, {}).cols.map((c) => c.width),
    [100, 100, 100, 100],
  )
})

check('the component measures the container and renders at the width it resolved', () => {
  const table = readFileSync(join(ROOT, 'components/shared/table/BlackwoodTable.tsx'), 'utf8')
  const code = table.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('ResizeObserver'), 'comment-stripping ate the source')

  // DEFAULT IS TODAY'S BEHAVIOUR, byte for byte.
  assert.match(code, /emptyMessage, sizing = 'content',/)
  assert.match(code, /width: '100%',\s*\n\s*minWidth: columns\.minWidth,/)

  // Under fill the table is rendered at the EXACT pixel sum it resolved, so
  // `table-layout: fixed` has no slack left to scale into.
  assert.match(code, /width: columns\.minWidth,\s*\n\s*minWidth: columns\.minWidth,/)
  // A PRIMITIVE into the column memo — a fresh `{ containerWidth }` per render would
  // re-resolve every sticky offset on every keystroke.
  assert.match(code, /sizing === 'fill' \? fillWidth : undefined,/)
  // rAF-throttled, and it prefers the SCROLLER's inner width — the wrapper's is wider by
  // the vertical scrollbar, which would buy a permanent horizontal one.
  assert.match(code, /raf = requestAnimationFrame\(measure\)/)
  assert.match(code, /scrollerEl\(\)\?\.clientWidth \|\| el\.clientWidth/)
  assert.match(code, /Math\.abs\(prev - w\) < 1 \? prev : w/)
})

// ═══ `?grid=` — ONE axis, a per-page DEFAULT ═══════════════════════════════════
//
// RC IN / RC OUT flipped to v2-by-default on 2026-08-21 while nine other screens stayed
// on the old default. What has to be true for that to be safe is not "the flipped page
// works" — it is that the OTHER nine did not change meaning, and that is exactly what a
// pure test can pin: every helper is a function over plain strings, and the v1-default
// path is asserted here as an explicit case rather than as an absence of complaints.

check('parseGrid reports what the URL SAID; resolveGrid answers with a version', () => {
  // Both versions are now readable. `v1` used to parse as `null` and, on a v1-default
  // page, resolved to the old grid either way — so this widening cannot move any
  // existing screen (the case below proves it at the resolve layer too).
  assert.equal(parseGrid('v2'), GRID_V2)
  assert.equal(parseGrid('v1'), GRID_V1)

  // "The URL did not say" is NOT a version. Junk, case, emptiness and absence all land
  // here, so a typo can never half-select anything.
  for (const junk of [undefined, null, '', 'V2', 'V1', '3', 'v3', 'new', ' v2']) {
    assert.equal(parseGrid(junk), null, `${JSON.stringify(junk)} must not parse`)
  }

  // A repeated param takes the first, the way every axis in this module does.
  assert.equal(parseGrid(['v1', 'v2']), GRID_V1)
  assert.equal(parseGrid(['v2', 'v1']), GRID_V2)

  // THE DEFAULT-FLIP RULE, both directions: what the URL did not say, the page does.
  assert.equal(resolveGrid(undefined, GRID_V1), GRID_V1)
  assert.equal(resolveGrid(undefined, GRID_V2), GRID_V2)
  assert.equal(resolveGrid('junk', GRID_V1), GRID_V1)
  assert.equal(resolveGrid('junk', GRID_V2), GRID_V2)
  // An EXPLICIT value always wins over the default, on either kind of page — that is
  // the whole reachability guarantee for the classic table on a flipped screen.
  assert.equal(resolveGrid('v1', GRID_V2), GRID_V1)
  assert.equal(resolveGrid('v2', GRID_V1), GRID_V2)
})

check('the V1-DEFAULT path is unchanged — the nine unflipped screens, asserted', () => {
  // Every one of them reads `parseGrid(params.grid) === GRID_V2`, which is
  // `resolveGrid(raw, GRID_V1) === GRID_V2` by another name. Both spellings, every input.
  for (const raw of [undefined, null, '', 'v1', 'V2', '3', 'junk']) {
    assert.equal(parseGrid(raw) === GRID_V2, false, `${JSON.stringify(raw)} ⇒ old grid`)
    assert.equal(resolveGrid(raw, GRID_V1) === GRID_V2, false)
    assert.equal(isGridV2(raw), false)
  }
  assert.equal(parseGrid('v2') === GRID_V2, true)
  assert.equal(isGridV2('v2'), true)

  // The URL builders, with no default argument, must behave EXACTLY as they did before
  // `defaultVersion` existed: v2 writes the param, v1 writes nothing at all.
  assert.equal(withGrid([], true), 'grid=v2')
  assert.equal(withGrid([], false), '')
  assert.equal(gridHref('/x', [], true), '/x?grid=v2')
  assert.equal(gridHref('/x', [], false), '/x')
  // …and passing the default explicitly is the same thing, so a caller adding it while
  // reading this file changes nothing.
  assert.equal(withGrid([], true, GRID_V1), 'grid=v2')
  assert.equal(withGrid([], false, GRID_V1), '')
})

check('on a V2-DEFAULT page the paramless URL is v2 and the way back is ?grid=v1', () => {
  // The inverse, and the reason `defaultVersion` reaches the builders at all: the default
  // side of the toggle must be the CLEAN url, or every existing link into `/inventory`
  // would read as the non-default state.
  assert.equal(withGrid([], true, GRID_V2), '')
  assert.equal(withGrid([], false, GRID_V2), 'grid=v1')
  assert.equal(gridHref('/inventory', [], true, GRID_V2), '/inventory')
  assert.equal(gridHref('/inventory', [], false, GRID_V2), '/inventory?grid=v1')

  // Neither builder can ever emit an empty `?grid=`, on either kind of page.
  for (const def of [GRID_V1, GRID_V2] as const) {
    for (const v2 of [true, false]) {
      assert.ok(!withGrid([], v2, def).includes(`${GRID_PARAM}=&`))
      assert.notEqual(withGrid([], v2, def), `${GRID_PARAM}=`)
    }
  }
})

check('EVERY OTHER PARAM SURVIVES THE FLIP, on a flipped page too', () => {
  // The rule the whole side-by-side method rests on. A stale `grid` already in the query
  // is dropped and re-decided; everything else is carried across in order, repeats
  // included, in both directions and under both defaults.
  const query: [string, string][] = [
    ['tab', 'usage'],
    ['year', '2026'],
    ['grid', 'v2'],
    ['search', 'KCA 378'],
    ['f_supplier', 'a'],
    ['f_supplier', 'b'],
  ]
  const kept = 'tab=usage&year=2026&search=KCA+378&f_supplier=a&f_supplier=b'

  assert.equal(withGrid(query, true, GRID_V2), kept)
  assert.equal(withGrid(query, false, GRID_V2), `${kept}&grid=v1`)
  assert.equal(withGrid(query, true, GRID_V1), `${kept}&grid=v2`)
  assert.equal(withGrid(query, false, GRID_V1), kept)

  // A round trip through the toggle in either direction returns the URL it started from
  // — a flip is an involution, so comparing the two grids can never drift the filters.
  for (const def of [GRID_V1, GRID_V2] as const) {
    const away = withGrid(query, false, def)
    const back = withGrid(new URLSearchParams(away), true, def)
    assert.equal(back, withGrid(query, true, def), `round trip under ${def}`)
  }
})

check('the toggle reads the page default and never hard-codes a version', () => {
  const src = readFileSync(
    join(ROOT, 'components/shared/table/GridVersionToggle.tsx'),
    'utf8',
  )
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(code.includes('export function GridVersionToggle'), 'comment-stripping ate the source')

  // The default is `'v1'`, so a caller that passes nothing is byte-identical with the
  // behaviour before this prop existed — the nine unflipped screens pass nothing.
  assert.match(code, /defaultVersion = GRID_V1/)
  // Which side is lit, and which URL each side writes, both come from the SAME resolved
  // answer. Two sources would let the control light one side and navigate to the other.
  assert.match(code, /resolveGrid\(params\.get\(GRID_PARAM\), defaultVersion\) === GRID_V2/)
  assert.match(code, /gridHref\(pathname, params\.entries\(\), next, defaultVersion\)/)
  // The labels are PROPS: "Current" is a claim about one page's state, not a fact about
  // the module, so a flipped page can say something honest without this file learning
  // what any screen is.
  assert.match(code, /currentLabel = DEFAULT_CURRENT_LABEL/)
  assert.match(code, /newLabel = DEFAULT_NEW_LABEL/)
  assert.ok(
    !/>\s*Current\s*</.test(code) && !/>\s*New\s*</.test(code),
    'a hard-coded segment label would ignore the props',
  )
})

// THE REGISTRY of flipped screens. A page belongs here the day its default becomes v2 and
// nowhere else — the scan below reads it BOTH ways, so adding a flip without listing it
// fails, and listing a screen that has not flipped fails too.
const FLIPPED_PAGES = [
  join('app', '(app)', 'inventory', 'page.tsx'), // RC IN / RC OUT, 2026-08-21
  join('app', '(app)', 'cenapro', 'qc', 'page.tsx'), // QC ledger, 2026-08-21
  join('app', '(app)', 'production', '(tabs)', 'page.tsx'), // Daily · Electricity · Trucks, 2026-08-26
  join('app', '(app)', 'cenapro', 'deliveries', 'page.tsx'), // RC Deliveries, 2026-08-26
]

check('a flipped page states its default ONCE, and only the registered ones are flipped', () => {
  for (const rel of FLIPPED_PAGES) {
    const page = readFileSync(join(ROOT, rel), 'utf8')
    const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.ok(code.includes('export default async function'), `comment-stripping ate ${rel}`)

    // The page's branch and the control it mounts must agree about the default, or the
    // toggle lights the side the page did not render. The expression that reads the param
    // differs per page (one destructures `grid`, one indexes the whole bag), so this pins
    // the DEFAULT ARGUMENT rather than a spelling of the read.
    assert.match(code, /resolveGrid\([^;]*?,\s*GRID_V2\)\s*===\s*GRID_V2/, `${rel} branch`)
    assert.match(code, /defaultVersion=\{GRID_V2\}/, `${rel} control`)
  }

  // Every OTHER page carrying the toggle must still pass no default. This is the scan
  // that makes "the unflipped screens are unchanged" a test rather than a claim.
  const pages: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name === 'page.tsx') pages.push(p)
    }
  }
  walk(join(ROOT, 'app'))
  const withBar = pages.filter((p) => readFileSync(p, 'utf8').includes('GridVersionBar'))
  assert.ok(withBar.length >= 5, 'no toggle call sites found — this scan would be vacuous')
  for (const rel of FLIPPED_PAGES) {
    assert.ok(
      withBar.some((p) => p.endsWith(rel)),
      `${rel} is registered as flipped but mounts no GridVersionBar`,
    )
  }
  for (const p of withBar) {
    if (FLIPPED_PAGES.some((rel) => p.endsWith(rel))) continue
    const other = readFileSync(p, 'utf8')
    assert.ok(
      !other.includes('defaultVersion'),
      `${p} passes a grid default — only the flipped screens may`,
    )
    assert.ok(
      !/resolveGrid\([^)]*GRID_V2\s*\)/.test(other),
      `${p} resolves its default to v2 — an unflipped screen defaults to the live table`,
    )
  }
})

check('the production tabs read the flag ONCE and thread it as a REQUIRED prop', () => {
  // The first flipped screen whose grids are not reachable from its server page.
  //
  // Daily · Electricity · Trucks are client tabs of ONE page — the operator moves between
  // them with localStorage and no navigation — so the flag is read in `(tabs)/page.tsx`
  // and handed down through six files. On a v1-default screen a `v2 = false` fallback in
  // any of them was harmless (it agreed with the page). After the flip it does not, and it
  // is invisible: the prop is threaded correctly today, so a fallback would only ever fire
  // the day someone forgot it — which is exactly when the tab would silently serve Classic
  // while the toggle above it said "Table (new)".
  //
  // So the rule is structural: the DEFAULT is stated in the page and the prop is required
  // everywhere below it. TypeScript enforces the threading; this pins the shape, because
  // re-adding `= false` type-checks perfectly.
  const PROD = join(ROOT, 'app', '(app)', 'production')
  const page = readFileSync(join(PROD, '(tabs)', 'page.tsx'), 'utf8')
  const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(pageCode.includes('export default async function'), 'comment-stripping ate the page')

  // ONE read of the param, for all three tabs. Two reads is how one tab ends up on the
  // other side of the toggle from its siblings while the URL says one thing.
  assert.equal(
    (pageCode.match(/resolveGrid\(/g) ?? []).length,
    1,
    'the production page must read `?grid=` exactly once',
  )
  assert.ok(!pageCode.includes('parseGrid'), 'the flipped page resolves, it does not parse')

  const THREADED = [
    join('components', 'production-view.tsx'),
    join('components', 'daily-lazy-tab.tsx'),
    join('components', 'electricity-lazy-tab.tsx'),
    join('components', 'trucks-lazy-tab.tsx'),
    join('daily', 'daily-view.tsx'),
    join('electricity', 'electricity-view.tsx'),
    join('trucks', 'trucks-view.tsx'),
  ]
  for (const rel of THREADED) {
    const src = readFileSync(join(PROD, rel), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.match(code, /\bv2: boolean;/, `${rel} must declare v2 as REQUIRED`)
    assert.ok(!/\bv2\?: boolean/.test(code), `${rel} makes v2 optional`)
    assert.ok(!/\bv2 = (true|false)\b/.test(code), `${rel} restates the page's default`)
    // …and none of them may go around the page and read the URL itself. That read is what
    // the prop exists to avoid — it would need its own Suspense boundary here, and it
    // would be a second place the default could be spelt.
    assert.ok(!code.includes('useSearchParams'), `${rel} reads the URL directly`)
    assert.ok(!/\b(parseGrid|resolveGrid|isGridV2)\b/.test(code), `${rel} re-reads the grid param`)
  }
})

check('`all` is an OFFERED option, and hiding it cannot touch an existing caller', () => {
  const picker = readFileSync(join(ROOT, 'components/shared/table/PeriodPicker.tsx'), 'utf8')

  // Default TRUE on both axes — the clause that makes the prop additive rather than a
  // migration. `/inventory` passes neither and must keep both entries.
  assert.match(picker, /allowAllYears = true/)
  assert.match(picker, /allowAllMonths = true/)

  // Both entries are behind their own flag. A hard-coded `All years` / `All months` item
  // would render on a screen whose server read cannot widen to one.
  assert.match(picker, /\{allowAllYears \?[\s\S]*?All years/)
  assert.match(picker, /\{allowAllMonths \?[\s\S]*?All months/)

  const inventory = readFileSync(join(ROOT, 'app/(app)/inventory/page.tsx'), 'utf8')
  assert.ok(
    !inventory.includes('allowAll'),
    '/inventory must pass neither flag — its period axis genuinely spans every year',
  )

  // The QC ledger is the first screen that cannot widen: `loadQcLedgerData` takes ONE
  // `YYYY-MM`, so both entries are hidden there rather than resolving back to the month
  // the operator was already on.
  const qc = readFileSync(join(ROOT, 'app/(app)/cenapro/qc/page.tsx'), 'utf8')
  assert.match(qc, /allowAllYears=\{false\}/)
  assert.match(qc, /allowAllMonths=\{false\}/)
})

console.log(`\n${passed} assertions passed.`)
