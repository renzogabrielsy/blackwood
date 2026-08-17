/**
 * verify-grid-keyboard-nav.ts — framework-free assertions over the shared grid keyboard
 * state machine (`lib/hooks/use-grid-keyboard-nav.ts`). No DB, no browser, no React.
 *
 * This hook is the linchpin: RC IN and RC OUT (both bulk grids), Production Daily,
 * Electricity, Trucks, both Cenapro production grids, the Cenapro QC ledger, the digest
 * schedule grid and the Cenapro RC Deliveries ledger all run their keyboard through it.
 * A defect here is a defect in every grid at once, which is exactly what A1 was.
 *
 * A hook cannot be called outside React, so the branch is asserted two ways, and it takes
 * BOTH to be meaningful:
 *   1. a MODEL of the decision ("which cell does a printable character edit?"), which
 *      shows what the old code did wrong and what the new code must do; and
 *   2. a SOURCE SCAN of the real file, which is what ties the model to the shipped code.
 * The behavioural version becomes a Playwright spec (T02) when the parity harness lands.
 *
 * Run: npx tsx scripts/verify-grid-keyboard-nav.ts
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(ROOT, 'lib/hooks/use-grid-keyboard-nav.ts')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('\nuse-grid-keyboard-nav — the range branch\n')

// ─────────────────────────────────────────────────────────────────────────────
// 1. The model
// ─────────────────────────────────────────────────────────────────────────────

interface Cell { row: number; col: number }

/** The geometric top-left of a rectangle — what every consumer's `anchorId()` returns. */
function anchorOf(a: Cell, b: Cell): Cell {
  return { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) }
}

/**
 * What the hook does when a printable character arrives with a range selected.
 * `edited` is the cell the character is written into (`edit.start`), `caret` is where
 * the editor mounts (every grid renders it at the ACTIVE cell).
 */
function typeOverRange(
  active: Cell,
  dragTo: Cell,
  variant: 'old' | 'fixed',
): { edited: Cell; caret: Cell } {
  const anchor = anchorOf(active, dragTo)
  // OLD: the branch moved the caret to the anchor, then fell through to a char handler
  // that still used `active` — captured before the move.
  if (variant === 'old') return { edited: active, caret: anchor }
  // FIXED: the branch only clears the range; both halves use `active`.
  return { edited: active, caret: active }
}

check('a drag UP-LEFT used to type into one cell and open the editor on another', () => {
  const active = { row: 20, col: 7 } // where the drag STARTED (mousedown sets the caret)
  const dragTo = { row: 15, col: 5 } // up and to the left
  const old = typeOverRange(active, dragTo, 'old')
  assert.deepEqual(old.edited, { row: 20, col: 7 })
  assert.deepEqual(old.caret, { row: 15, col: 5 })
  assert.notDeepEqual(old.edited, old.caret, 'this divergence IS the bug')

  const fixed = typeOverRange(active, dragTo, 'fixed')
  assert.deepEqual(fixed.edited, fixed.caret, 'the character and the editor are one cell')
  assert.deepEqual(fixed.caret, active, 'and it is the ACTIVE cell, as in Google Sheets')
})

check('every drag direction now agrees, and only up/left ever disagreed', () => {
  const active = { row: 10, col: 5 }
  const corners: Cell[] = [
    { row: 14, col: 9 }, // down-right
    { row: 14, col: 1 }, // down-left
    { row: 6, col: 9 },  // up-right
    { row: 6, col: 1 },  // up-left
    { row: 10, col: 5 }, // no drag at all
  ]
  for (const to of corners) {
    const fixed = typeOverRange(active, to, 'fixed')
    assert.deepEqual(fixed.edited, fixed.caret, `fixed: drag to ${to.row},${to.col}`)

    const old = typeOverRange(active, to, 'old')
    const wentUpOrLeft = to.row < active.row || to.col < active.col
    assert.equal(
      !!wentUpOrLeft,
      old.edited.row !== old.caret.row || old.edited.col !== old.caret.col,
      `old: only an up/left drag diverged (${to.row},${to.col})`,
    )
  }
})

check('Ctrl/Cmd+A used to open an editor in the sheet\'s FIRST column', () => {
  // `selectAll` spans {0,0}…{last,last}, so the anchor is the row-ordinal column — which
  // in the deliveries ledger is not addressable at all. The caret went there while the
  // character was written wherever the operator had last clicked.
  const active = { row: 12, col: 6 }
  const old = typeOverRange(active, { row: 0, col: 0 }, 'old')
  assert.deepEqual(old.caret, { row: 0, col: 0 })
  assert.deepEqual(typeOverRange(active, { row: 0, col: 0 }, 'fixed').caret, active)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. The source scan — what ties the model to the shipped hook
// ─────────────────────────────────────────────────────────────────────────────

check('the shipped range branch clears the range and moves NOTHING', () => {
  const code = stripComments(readFileSync(HOOK, 'utf8'))
  // The vacuous-pass guard has to be CODE, not a comment — `stripComments` removes the
  // section headers, so anchoring on one would fail on a perfectly healthy file.
  assert.match(code, /export function useGridKeyboardNav/, 'comment-stripping destroyed the source')
  assert.match(code, /if \(range && range\.isRangeSelected\)/, 'the range branch must still exist')

  // The printable-char branch, isolated from the rest of the range block.
  const branch = code.match(
    /if \(e\.key\.length === 1 && !e\.ctrlKey && !e\.metaKey && !e\.altKey\) \{([\s\S]*?)\n {8}\}/,
  )
  assert.ok(branch, 'the printable-char branch of RANGE MODE must be findable')
  const body = branch![1]
  assert.ok(
    !/setActiveCell/.test(body),
    'the range branch must NOT move the caret — the char handler below edits `active`',
  )
  assert.ok(
    !/anchorId\(\)/.test(body),
    'and it must not read the anchor: the anchor is the top-left, not the active cell',
  )
  assert.match(body, /range\.clear\(\)/, 'it still exits range mode')
})

check('the char handler still edits `active`, and the two branches are symmetric', () => {
  const code = stripComments(readFileSync(HOOK, 'utf8'))
  // The fall-through target: the ONE place a printable character starts an edit.
  assert.match(
    code,
    /if \(resolver\.isEditable\(active\)\) \{[\s\S]{0,200}?edit\.start\(active, e\.key\)/,
    'a printable character edits the ACTIVE cell',
  )
  // `active` is still captured once, before any branch can run.
  assert.match(code, /const active = activeCell/, 'the active cell is captured once, up front')
  // The NAV_KEYS branch above has always been this shape; the char branch now matches it.
  assert.match(
    code,
    /if \(NAV_KEYS\.includes\(e\.key\)\) \{\s*range\.clear\(\)/,
    'the nav branch clears and falls through — the char branch is now its twin',
  )
})

check('anchorId stays on the interface — a tiling paste will need it', () => {
  const code = stripComments(readFileSync(HOOK, 'utf8'))
  assert.match(code, /anchorId\(\): unknown/, 'the slot member is still declared')
  // Removing it would touch all 8 consumers for no gain; it is simply no longer read
  // by THIS branch.
})

console.log(`\n${passed} assertions passed.`)
