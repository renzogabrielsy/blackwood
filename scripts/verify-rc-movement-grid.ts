/**
 * verify-rc-movement-grid.ts — framework-free assertions over RC Movement's v2 grid
 * (`app/(app)/inventory/rc-movement/rc-movement-grid-v2.tsx`). No DB, no browser, no React.
 *
 * TENANT-LAYER, deliberately separate from `scripts/verify-table-core.ts`: the widths below
 * are facts about charcoal batch codes and production grades, and the platform script must
 * not learn either. It is the sibling of `scripts/verify-qc-grid.ts` §12, which is where
 * the method comes from.
 *
 * Run: npx tsx scripts/verify-rc-movement-grid.ts
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The PLATFORM paper-geometry solver — pure arithmetic, zero imports of its own, which is
// exactly why it can be imported here. §4 re-runs the printed sheet's OWN fit through it
// rather than restating the answer, so the pinned ceiling cannot drift from the sheet.
import {
  a4LandscapeBox,
  maxRepeatingColumns,
} from '../components/shared/print/print-fit'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = join(ROOT, 'app', '(app)', 'inventory', 'rc-movement')
const GRID = join(MODULE, 'rc-movement-grid-v2.tsx')
const PAGE = join(MODULE, 'page.tsx')
const HEADER_CELL = join(ROOT, 'components', 'shared', 'table', 'HeaderCell.tsx')

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('\nRC Movement — the v2 grid\n')

const SRC = readFileSync(GRID, 'utf8')
const CODE = stripComments(SRC)

// ═══ 1 · EVERY HEADER MUST BE READABLE ════════════════════════════════════════
//
// Renzo, 2026-08-29: *"a bunch of the column headers are wrapping weirdly or are being '…'
// truncated. This does not happen in our original table. Column widths must accommodate the
// header so we can see everything."*
//
// **The budget, and why it is 40px larger than the Classic matrix's.** The Classic `<th>`
// spends `px-2` + a 1px border and gives the rest to its label. This grid runs
// `scope="focus"`, which turns the PLATFORM's built-in SORT and FILTER controls on for
// every column that is not `cellKind: 'derived'` and has not opted out — and `HeaderCell`
// lays them out as flex SIBLINGS of the label, `opacity-0` until the header is hovered.
// Invisible, and still occupying layout: two 16px buttons plus two 4px gaps.
//
//     usable label width = declared − 16 (px-2) − 40 (two controls) − 1 (border-r)
//     usable label width = declared − 16 − 1                (no controls on the column)
//
// Every width this grid carried over from the Classic matrix was therefore ~40px short of
// the one it needed. Same trap, same remedy and same method as `verify-qc-grid.ts` §12.
//
// The numbers are MEASURED, in Chrome, against the real computed fonts — the lane header at
// Geist 11px/500 `uppercase tracking-wide`, a block header at Geist Mono 11px/600. Node has
// no font engine, so they cannot be re-derived here — only ENFORCED. That is the point: a
// width narrowed back to "what looks about right" is exactly how this regressed once.
const HEADER_PX: Readonly<Record<string, number>> = {
  W_ROWNUM: 7.42, // `#`
  W_DATE: 29.52, // `DATE`
  W_DAY: 22.92, // `DAY`
  W_FEDPRICE: 52.63, // `FED ₱/KG`
  W_TOTAL: 62.32, // `TOTAL FED`
  W_PRODUCED: 64.67, // `PRODUCED`
  W_GRADE: 30.25, // the widest grade the plant has ever run — `8X50` (`3X50` is 30.07)
  W_BLOCK: 115.53, // `MARCH-26-SUNDRY7` — the longest batch code `rc_out` has ever fed
}

/**
 * How much of a column is NOT available to its label.
 *
 * 57 = 16 (`px-2`) + 40 (two 16px chrome buttons + their two 4px gaps) + 1 (`border-r`).
 * 17 = the same without the buttons — a `derived` column, or one that opted out of both.
 */
const CHROME_WITH_CONTROLS = 57
const CHROME_BARE = 17
/** `#` is `cellKind: 'derived'`; a block column sets `sortable: false` + `filterable: false`. */
const NO_HEADER_CONTROLS = new Set(['W_ROWNUM', 'W_BLOCK'])
/**
 * A FOURTH flex child, on the two columns that start a section.
 *
 * `PRODUCED` and the FIRST block column hang their 2px group rule off `renderHeaderSlot`,
 * which `HeaderCell` renders as `<span data-grid-chrome class="shrink-0">`. The sliver
 * inside it is `absolute` and 0px wide — but the `gap-1` BEFORE it is not. Both columns
 * clipped by exactly this much when the first version of this table budgeted 57/17, which
 * is why it is a measured constant and not a rounding allowance.
 *
 * `W_BLOCK` is charged for it because ALL block columns share one width and the first of
 * them pays it.
 */
const HEADER_SLOT_PX = 4
const PAYS_HEADER_SLOT = new Set(['W_PRODUCED', 'W_BLOCK'])

/** The widest REAL value each lane can hold, plus the cell's own `px-2` + border (17px). */
const CELL_MIN_PX: Readonly<Record<string, number>> = {
  W_ROWNUM: 30, // `31`
  W_DATE: 85.8, // `2026-08-29` at 68.80
  W_DAY: 42.18, // `Wed` at 25.18
  W_FEDPRICE: 60.3, // `₱ 48.16` in accounting layout, at 43.30
  W_TOTAL: 73.52, // `1,234,567` — a campaign grand total — at 56.52
  W_PRODUCED: 63.63, // `123,456` at 46.63
  W_GRADE: 63.63,
  W_BLOCK: 63.63, // the widest single feed on record is `81,580`
}

/** Each constant's declared width, parsed off the grid's own source. */
function declaredWidths(): Map<string, number> {
  const out = new Map<string, number>()
  for (const key of Object.keys(HEADER_PX)) {
    const m = new RegExp(`const ${key} = (\\d+);`).exec(CODE)
    assert.ok(m, `the declared width of ${key} must be findable`)
    out.set(key, Number(m[1]))
  }
  assert.equal(
    out.size,
    Object.keys(HEADER_PX).length,
    'an empty extraction is a FAILURE, never a vacuous pass',
  )
  return out
}

check('every column is wide enough for its own HEADER at the header\'s font', () => {
  const widths = declaredWidths()
  for (const [key, label] of Object.entries(HEADER_PX)) {
    const chrome =
      (NO_HEADER_CONTROLS.has(key) ? CHROME_BARE : CHROME_WITH_CONTROLS) +
      (PAYS_HEADER_SLOT.has(key) ? HEADER_SLOT_PX : 0)
    const floor = label + chrome
    const declared = widths.get(key)!
    assert.ok(
      declared >= floor,
      `${key}: declared ${declared}px but the header needs ${floor.toFixed(2)}px ` +
        `(label ${label} + ${chrome} of chrome) — it would render truncated`,
    )
  }
})

check('every column is wide enough for its widest REAL value', () => {
  // The other half of the same question, and the half the 2026-08-25 QC pass forgot. A
  // column wide enough for its name and too narrow for its numbers is not fixed.
  const widths = declaredWidths()
  for (const [key, floor] of Object.entries(CELL_MIN_PX)) {
    const declared = widths.get(key)!
    assert.ok(declared >= floor, `${key}: declared ${declared}px but its widest value needs ${floor}px`)
  }
})

check('the header budget is stated against the platform that produces it', () => {
  // The 40px is not a constant this repo owns — it is two `HeaderCell` buttons and their
  // gaps. If that markup changes, the budget above is wrong and every width with it, so
  // the shape is pinned where it lives.
  const header = readFileSync(HEADER_CELL, 'utf8')
  assert.match(header, /className="flex h-full items-center gap-1 px-2 py-1"/, 'the header pads px-2 and gaps 1')
  assert.equal(
    (header.match(/'shrink-0 rounded-sm p-0\.5 transition-colors duration-150 hover:text-foreground',/g) ?? []).length,
    2,
    'exactly two chrome buttons (sort + filter) sit beside the label',
  )
  assert.match(header, /<ListFilter className="size-3" \/>/, 'their icons are size-3 (12px), so each button is 16px')
  // …and they are laid out even while invisible, which is the whole trap.
  assert.match(header, /opacity-0 group-hover\/th:opacity-100/)
  // …and so is the group-rule slot, which is the 4px `PAYS_HEADER_SLOT` charges for.
  assert.match(header, /<span data-grid-chrome className="shrink-0">/)
  assert.match(CODE, /const renderHeaderSlot = React\.useCallback\(/)
  assert.match(CODE, /spec\.key !== KEY_PRODUCED && spec\.key !== firstBlockKey\) return null/,
    'exactly the two columns PAYS_HEADER_SLOT names may carry a slot')

  // The sheet really does turn them on: `scope="focus"` is what enables both, and nothing
  // opts the sheet out wholesale.
  assert.match(CODE, /scope="focus"/)
  assert.equal(CODE.includes('enableSort'), false, 'nothing opts out — so every non-derived column pays the chrome')
  assert.equal(CODE.includes('enableFilter'), false)

  // The two columns that DO opt out, individually — the pair `NO_HEADER_CONTROLS` names.
  assert.match(CODE, /key: KEY_ROWNUM,[\s\S]{0,400}?cellKind: 'derived',/)
  assert.match(CODE, /sortable: false,\s*\n\s*filterable: false,/)
})

// ═══ 1b · THE SUMMARY ROW'S OWN WIDTH BUDGET ══════════════════════════════════
//
// A block column has TWO width floors, not one — the header (§1) and the SUMMARY cell.
// The cell was cut to THREE lines on 2026-09-17 (Renzo: *"it is best that the footer
// remains just these values (top to bottom): kg fed …, php/kg (not actual), loss"*), plus
// a FOURTH when the `Actual ₱` switch is on — so the widest line is no longer the old
// `this camp <kg>` headline and the budget was RE-MEASURED rather than left alone. The
// Classic matrix's `W_BLOCK` came back down 124 → 108 on that measurement; this grid's
// 148 is set by its HEADER floor and did not move.
//
// The summary cell pays NO header chrome (no sort/filter buttons live in a `<tfoot>`) —
// its own `px-2` + the `border-r`, plus the 2px GROUP_DIVIDER that the FIRST block column
// carries and every block column is therefore sized for.
const SUMMARY_CELL_CHROME = 16 + 1 + 2
/**
 * MEASURED in Chrome with `Range.getBoundingClientRect()` at the real computed fonts, the
 * same method as HEADER_PX — Node has no font engine, so these can only be ENFORCED here,
 * never re-derived. The widest of the four lines is `ACTUAL` (the switched-on one);
 * `LOSS %` is the widest of the three that always render.
 *
 *   FED     18.45 + 4 + 46.83  =  69.28   (`781,234` at `font-mono text-xs`)
 *   ₱/KG    24.92 + 4 + 40.98  =  69.90   (`1,234.56` at `font-mono text-[10px]`)
 *   LOSS %  40.83 + 4 + 34.71  =  79.54   (`-10.56%` at `font-mono text-[10px]`)
 *   ACTUAL  42.26 + 4 + 47.18  =  93.44   (`1,234.56` at `font-mono text-[11px]`)
 *
 * The ₱ figures are measured at `1,234.56`, twenty times any real fed price, so the slack
 * the floors leave is real rather than nominal.
 */
const SUMMARY_ROW_PX: Readonly<Record<string, number>> = {
  W_BLOCK: 42.26 + 4 + 47.18,
}

/** The Classic matrix, whose block footer moves in LOCKSTEP with the v2 summary cell. */
const MATRIX_SRC = stripComments(readFileSync(join(MODULE, 'rc-movement-matrix.tsx'), 'utf8'))

check('every block column is wide enough for the SUMMARY row\'s widest line', () => {
  const widths = declaredWidths()
  const floor = SUMMARY_ROW_PX.W_BLOCK + SUMMARY_CELL_CHROME
  const fail = (name: string, declared: number) =>
    `${name} W_BLOCK: declared ${declared}px but the footer's widest line (\`ACTUAL <₱/kg>\`) ` +
    `needs ${floor.toFixed(2)}px (label+value ${SUMMARY_ROW_PX.W_BLOCK.toFixed(2)} + ` +
    `${SUMMARY_CELL_CHROME} of cell chrome) — it would wrap to two lines`

  const v2 = widths.get('W_BLOCK')!
  assert.ok(v2 >= floor, fail('v2 grid', v2))

  // …AND THE CLASSIC MATRIX'S OWN NUMBER, pinned here rather than left to whoever next
  // trims it: its footer carries the identical four lines, and it came DOWN 124 → 116 on
  // 2026-09-17 when the footer was cut to three (plus the switched-on fourth). 108 would
  // have cleared the three default lines and wrapped the fourth — which is exactly how a
  // width sized to the state you happened to be looking at regresses.
  const m = /const W_BLOCK = (\d+);/.exec(MATRIX_SRC)
  assert.ok(m, 'the Classic matrix\'s W_BLOCK must be findable')
  const classic = Number(m[1])
  assert.ok(classic >= floor, fail('Classic matrix', classic))
})

/**
 * Just the block footer / summary cell of each grid — asserting on the WHOLE file would
 * pass on a lifetime figure that merely moved into a hover card, which is exactly where
 * this change put them.
 */
function footerSlice(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  const b = src.indexOf(end, a)
  assert.ok(a > 0 && b > a, `the block footer must be findable (${start})`)
  return src.slice(a, b)
}

check('the block footer prints THREE values, all of them THIS CAMPAIGN\'s or the block\'s own', () => {
  // Renzo, 2026-09-17, after the two-clock labelling landed the same morning: *"It is
  // best that the footer remains just these values (top to bottom): kg fed (fed for the
  // batch/campaign and not lifetime), php/kg (not actual), loss. The other values
  // currently on that footer can be viewed on hover anyway."* Pinned on BOTH grids,
  // because the footer is reachable on either and the paramless URL serves v2.
  const slices: readonly (readonly [string, string])[] = [
    // THE SLICE IS THE RENDERED CELL, not the whole renderer: the v2 cell's `title`
    // legitimately carries the lifetime figures — that is where they MOVED to — and a
    // whole-file assertion would fail on the very hover card this change filled.
    [
      'v2 grid',
      footerSlice(CODE, '<div className="flex flex-col gap-0 px-2 py-0.5 leading-tight">', 'const summaryRows'),
    ],
    [
      'Classic matrix',
      footerSlice(
        MATRIX_SRC,
        '<div className="flex cursor-default flex-col gap-0 px-2 py-0.5 leading-tight">',
        '<TooltipContent',
      ),
    ],
  ]
  for (const [name, cell] of slices) {
    // THE HEADLINE IS THE CAMPAIGN'S OWN DRAW, read from the payload, never re-added.
    assert.ok(cell.includes('campaignFedKg'), `${name}: the footer must lead with campaignFedKg`)
    assert.ok(
      !/reduce\(|\+=/.test(cell),
      `${name}: the footer is a LOOKUP — it must never fold the cells above it`,
    )
    // AND THE LIFETIME FIGURES ARE GONE FROM IT. `totalOut` is the block's whole-life
    // outflow; printing it under a column of this campaign's days is the misread that
    // started all of this, and it now lives only on the hover card / the cell title.
    assert.ok(
      !cell.includes('totalOut'),
      `${name}: the LIFETIME outflow must not be on the visible footer — it belongs on hover`,
    )
    assert.ok(
      !cell.includes('all campaigns') && !cell.includes('>life</span>'),
      `${name}: neither the \`all campaigns\` caption nor the \`life\` line may remain`,
    )
    // THE ₱ LINE IS THE DELIVERED PRICE, NOT THE ACTUAL — Renzo named both.
    assert.ok(cell.includes('avgFedPrice'), `${name}: line 2 is the DELIVERED block price`)
  }
})

check('the ACTUAL ₱/kg line is on a SWITCH, and the switch has one definition', () => {
  // Renzo: *"Being able to toggle on/off the ability to see the actual price of the block
  // in the footer would be really cool."* Three surfaces show a block footer — this grid,
  // the Classic matrix on `?grid=v1`, and `/operations`' RC FED modal, which HOSTS the
  // Classic matrix — so the control is one component all three render.
  const toggle = stripComments(readFileSync(join(MODULE, 'actual-price-toggle.tsx'), 'utf8'))
  assert.match(toggle, /aria-pressed=\{value\}/, 'the switch is a real toggle, keyboard-operable')
  assert.match(toggle, /export const ACTUAL_PARAM = 'actual'/)
  assert.match(toggle, /return v === ACTUAL_ON/, 'OFF is the default and is spelled as ABSENCE')
  // It must hold NO router hook: the Classic matrix is hosted inside `/operations`, and a
  // `useSearchParams` in that tree would rewrite that page's own address.
  for (const banned of ['useSearchParams', 'usePathname', 'useRouter']) {
    assert.ok(!toggle.includes(banned), `the switch must not reach for \`${banned}\``)
  }

  // Both grids gate the fourth line on the switch AND on the server-resolved price flag,
  // so a stale `?actual=on` opened by Production reveals nothing.
  for (const [name, src] of [['v2 grid', CODE], ['Classic matrix', MATRIX_SRC]] as const) {
    assert.match(
      src,
      /const showActualLine = showFedPrice && showActualPrice;/,
      `${name}: the ACTUAL line is gated on the price flag as well as the switch`,
    )
    assert.ok(src.includes('showActualLine'), `${name}: …and the footer line reads it`)
    assert.ok(
      src.includes('ActualPriceToggle') || src.includes('onShowActualPriceChange'),
      `${name}: …and the switch is the shared component, never a second button`,
    )
  }
  // The Classic matrix takes it as an OPTIONAL prop defaulting to FALSE, so its existing
  // hosts are unaffected by the addition.
  assert.match(MATRIX_SRC, /showActualPrice = false,/, 'the Classic matrix defaults the prop to false')
})

check('a block loss never prints a leading minus', () => {
  // THE SIGN. `blockLoss` is `(out - in) / in`, so a real loss is NEGATIVE and the old
  // `fmtSignedPct` printed `LOSS -0.86%` — "negative loss", the opposite of the truth.
  for (const [name, src] of [['v2 grid', CODE], ['Classic matrix', MATRIX_SRC]] as const) {
    assert.ok(
      !src.includes('fmtSignedPct'),
      `${name}: fmtSignedPct must be gone — it put a minus in front of every ordinary loss`,
    )
    assert.match(src, /function fmtLossPct\(blockLoss: number \| null\): string \{[\s\S]{0,160}?\(-blockLoss \* 100\)\.toFixed\(2\)/,
      `${name}: fmtLossPct must flip the sign so a loss prints POSITIVE`)
  }
})

check('NOTHING on this sheet wraps its header any more', () => {
  // `headerWrap` was the old answer to two of these columns and it was the wrong one
  // twice over: the header row grows to its TALLEST cell, so one wrapped header raises
  // every other one — and a name broken across two lines is not more readable than the
  // same name on one line that fits. Renzo saw both and called it "wrapping weirdly".
  assert.ok(!CODE.includes('headerWrap'), 'no column may declare headerWrap')
  // The block header's SECOND line stays — it is a `subLabel` (the block location), which
  // is a subtitle, not the name spilling over. Different question, different field.
  assert.match(CODE, /subLabel: c\.blockLoc \?\? '—',/)
})

// ═══ 2 · THE FOOTER IS PINNED ═════════════════════════════════════════════════
//
// Renzo: *"Footer must also 'freeze' same as original."* The Classic matrix pins its
// TOTALS row to the container bottom; v2 rendered the same figures as the LAST ROW OF THE
// BODY, because `renderChromeRow` was the only shape that fitted ~40 different stacks and
// it reaches the body only. `TableSummaryRow.cell` (2026-08-29) is the platform seam.

check('the totals row is a PINNED SUMMARY ROW, not a body chrome row', () => {
  assert.match(CODE, /summaryRows=\{summaryRows\}/, 'the grid must pass summary rows')
  assert.match(CODE, /\{ key: 'totals', sticky: true, height: TOTALS_H, cell: totalsCell \}/)
  // The old shape is GONE, not merely unused — a second copy of this footer is exactly
  // how the two would drift.
  assert.ok(!CODE.includes('renderChromeRow'), 'the chrome-row footer must be removed, not left beside it')
  assert.ok(!CODE.includes('pinnedOffsets'), 'the offsets are the platform\'s now — this file must not compute them')
  // …and with it the row family it needed. A `summary` kind that no item uses would be a
  // coordinate space with a phantom in it.
  assert.ok(!/kind: 'summary'/.test(CODE), 'the summary row family must be gone with the item')
  assert.match(CODE, /return rows\.map\(\(row\) => \(\{ kind: 'day', id: row\.date, data: row \}\)\)/)
})

check('the footer paints OPAQUELY and never re-derives a sticky offset', () => {
  const start = CODE.indexOf('const totalsCell')
  const end = CODE.indexOf('const summaryRows')
  assert.ok(start > 0 && end > start, 'the totals cell renderer must be findable')
  const cell = CODE.slice(start, end)

  // A pinned surface that overlaps scrolling content is OPAQUE (CLAUDE.md → Frozen Panes).
  // The status tint REPLACES `bg-muted` rather than layering over it, and every one of its
  // branches is a solid token pair.
  assert.match(cell, /statusTint\(block\.status\)/)
  assert.ok(
    !/bg-(muted|background|card)\/\d/.test(cell) && !cell.includes('backdrop-blur'),
    'no glass and no alpha on the pinned footer',
  )
  // Position, z and the seams belong to the platform — this file must not spell any of them.
  for (const owned of ['frozen-corner-bottom', 'frozen-row-bottom', 'frozen-edge', 'frozen-col', 'left:']) {
    assert.ok(!cell.includes(owned), `the footer must not hand-roll \`${owned}\``)
  }
})

check('the ₱ lines of the footer are gated on the SERVER-resolved flag', () => {
  const start = CODE.indexOf('const totalsCell')
  const cell = CODE.slice(start, CODE.indexOf('const summaryRows'))
  // `showFedPrice` is `data.canViewPrices`, resolved by `lib/auth.canViewPrices()` inside
  // `fetchRcMovementMatrix`. The FED ₱/kg column does not EXIST for a gated viewer, and
  // the two per-block ₱ lines are checked again here — belt and braces, one direction.
  assert.match(CODE, /const showFedPrice = canViewPrices;/)
  assert.match(cell, /if \(!showFedPrice\) return \{ className: PAD \};/)
  // ONE `showFedPrice ?` since 2026-09-17, not two: the per-block ₱/kg line is gated
  // directly, and the ACTUAL line is gated through `showActualLine`, which is
  // `showFedPrice && showActualPrice` — so a stale `?actual=on` opened by a
  // price-denied reader still reveals nothing. Both are asserted; the second one is
  // asserted at its definition, where the AND actually lives.
  assert.equal(
    (cell.match(/showFedPrice \?/g) ?? []).length,
    1,
    'the per-block ₱/kg line is gated directly on the price flag',
  )
  assert.match(cell, /\{showActualLine \? \(/, 'the ACTUAL line is gated through showActualLine')
  assert.match(CODE, /const showActualLine = showFedPrice && showActualPrice;/)
  // And this file never re-derives the role.
  assert.ok(!CODE.includes('hasPermission'), 'price visibility is never re-decided on the client')
})

// ═══ 3 · THE FLIP ═════════════════════════════════════════════════════════════

check('the route DEFAULTS to v2 and the Classic matrix stays reachable at ?grid=v1', () => {
  const page = stripComments(readFileSync(PAGE, 'utf8'))
  assert.match(page, /resolveGrid\(params\.grid, GRID_V2\) === GRID_V2/)
  assert.match(page, /defaultVersion=\{GRID_V2\}/)
  assert.ok(!page.includes('parseGrid'), 'a flipped page resolves, it does not parse')
  // Both branches still mount, and both still read the SAME action — the flip is a
  // default, not a cutover. `scripts/verify-table-core.ts` owns the registry half.
  assert.match(page, /<RcMovementGridV2 data=\{data\}/)
  assert.match(page, /<RcMovementRouteView \/>/)
  assert.equal(
    (page.match(/fetchRcMovementMatrix/g) ?? []).length,
    2,
    'one import and one call — the v2 branch fetches, the Classic host fetches its own',
  )
})

check('the Classic matrix and its host were not edited by the flip', () => {
  // The strangler-fig rule. Two surfaces still live ONLY there (the open-blocks dialog and
  // the Radix hover info cards), so `?grid=v1` has to keep working exactly as it did.
  const matrix = readFileSync(join(MODULE, 'rc-movement-matrix.tsx'), 'utf8')
  const host = readFileSync(join(MODULE, 'rc-movement-route-view.tsx'), 'utf8')
  assert.ok(matrix.includes('OpenBlocksDialog'), 'the dialog must still live in the Classic matrix')
  assert.ok(matrix.includes('RcMovementSummaryMobile'), 'the phone summary must still be there')
  for (const [name, src] of [['matrix', matrix], ['route view', host]] as const) {
    assert.ok(!src.includes('BlackwoodTable'), `the Classic ${name} must not import the module`)
    assert.ok(!src.includes('summaryRows'), `the Classic ${name} must not have been migrated`)
  }
})

check('the banner says what is ACTUALLY live', () => {
  // A banner that lists a shipped feature as missing is a bug report waiting to be filed.
  assert.match(CODE, /bottom-pinned totals footer/)
  assert.ok(
    !/the bottom-pinned footer are not/.test(CODE),
    'the footer must no longer be listed as not-yet-live',
  )
  // …and the two that genuinely are not built stay named.
  assert.match(CODE, /open-blocks dialog/)
})

// ═══ 4 · THE PRINTED SHEET ════════════════════════════════════════════════════
//
// Renzo, 2026-09-17: *"a similar colored print functionality for rc movement page. Make
// sure an entire month can fit inside of landscape A4."*
//
// The one-page promise is ARITHMETIC over a measured glyph width, so it can be pinned
// here exactly the way the header budget above is: Node has no font engine, so the
// advance can only be ENFORCED, never re-derived. Everything below was MEASURED with
// headless Chrome against real PDFs rendered from `app/dev/table-playground/rcmprint`
// (`pdfinfo` page counts, `pdftoppm` crops at 300dpi) — see the CONTEXT.md print section.

const PRINT = join(MODULE, 'rc-movement-print.tsx')
const PRINT_SRC = readFileSync(PRINT, 'utf8')
const PRINT_CODE = stripComments(PRINT_SRC)

/** Pull a numeric `const NAME = 1.23;` out of the print module's own source. */
function printConst(name: string): number {
  const m = PRINT_CODE.match(new RegExp(`\\b${name} = (-?[0-9.]+);`))
  assert.ok(m, `${name} must be a plain numeric constant in rc-movement-print.tsx`)
  return Number(m![1])
}

check('the sheet is sized by a MEASURED glyph advance, rounded UP', () => {
  // Measured in headless Chrome over a 100-glyph run of tabular digits at 100px against
  // the app's own `font-mono` stack: 0.6120 em (the fixture re-measures it live and
  // publishes it as `data-fixture-advance`). The constant is carried ROUNDED UP, because
  // a width derived from an UNDER-estimate is a clipped number — the first PDF of this
  // feature clipped `DAY` and the tail of `MARCH-26-SUNDRY7` for exactly that reason.
  const MEASURED_ADVANCE_EM = 0.612
  const advance = printConst('RCM_MONO_ADVANCE_EM')
  assert.ok(
    advance >= MEASURED_ADVANCE_EM,
    `RCM_MONO_ADVANCE_EM (${advance}) must never be below the measured ${MEASURED_ADVANCE_EM}`,
  )
  assert.ok(advance <= 0.65, 'and not so far above it that the sheet wastes a column')
})

check('the print margin is stated ONCE and the @page rule is derived from it', () => {
  // `@page` cannot be scoped, so this report takes the app-wide 12mm away for the
  // duration and gives it back on unmount. The number must reach BOTH the page-box
  // arithmetic and the injected rule from the same constant, or the sheet is laid out
  // against a box the printer does not use.
  assert.equal(printConst('RCM_PRINT_MARGIN_MM'), 7)
  assert.match(PRINT_CODE, /const PAGE = a4LandscapeBox\(RCM_PRINT_MARGIN_MM\)/)
  assert.match(PRINT_CODE, /marginMm: RCM_PRINT_MARGIN_MM/)
  assert.ok(
    !/marginMm: \d/.test(PRINT_CODE),
    'the margin must never be written as a literal beside the constant',
  )
})

check('the MEASURED one-page ceiling is 26 block columns', () => {
  // Recomputed HERE with the module's own constants through the SAME platform solver the
  // sheet runs, so this can never drift from what the sheet does. Verified against real
  // PDFs: 26 blocks → 1 page, 27 → 2. The widest campaign the yard has ever fed is 32
  // block columns (MARCH 2026), so the column-pagination path is LIVE, not theoretical.
  const advanceEm = printConst('RCM_MONO_ADVANCE_EM')
  const padPx = printConst('PAD_PX')
  const marginMm = printConst('RCM_PRINT_MARGIN_MM')
  const fontFloor = 5 // the last rung of FONT_LADDER
  assert.match(PRINT_CODE, /const FONT_LADDER = \[9, 8\.5, 8, 7\.5, 7, 6\.5, 6, 5\.5, 5\]/)

  const page = a4LandscapeBox(marginMm)
  /**
   * The spine of a JULY-2026-shaped sheet. Every `chars` is the LONGEST STRING THAT
   * COLUMN ACTUALLY RENDERS, measured off the real payload — which is what the solver
   * itself does, so this is the same question asked the same way:
   *   rownum `33` · date `2026-06-30` · day `Wed` · fedphp `45.34`
   *   total `1,639,849` (the grand total, not a day) · produced `716,969` · grade `345,171`
   * A width guessed from a typical value is how a sheet silently clips; a width guessed
   * too WIDE here would under-report the ceiling and quietly weaken this assertion.
   */
  const spine = (grades: number) => [
    { key: 'rownum', chars: 2 },
    { key: 'date', chars: 10 },
    { key: 'day', chars: 3 },
    { key: 'fedphp', chars: 5 },
    { key: 'total', chars: 9 },
    { key: 'produced', chars: 7 },
    ...Array.from({ length: grades }, (_, i) => ({ key: `grade${i}`, chars: 7 })),
  ]
  const ceilingAt = (grades: number) =>
    maxRepeatingColumns({
      fixed: spine(grades),
      unit: { key: 'block', chars: 7 }, // `150,000`
      availablePx: page.widthPx,
      fontPt: fontFloor,
      padPx,
      advanceEm,
    })

  // TWO grades is the case Renzo's worst realistic month presents, and 26 is exactly
  // where the real PDFs turn over: 26 blocks → 1 page, 27 → 2.
  assert.equal(ceilingAt(2), 26, 'the one-page ceiling must stay at the measured 26 block columns')
  // Each additional grade column costs about one block column. Stated so the ceiling is
  // understood as a function of the data rather than as a single magic number.
  assert.equal(ceilingAt(1), 27)
  assert.equal(ceilingAt(3), 25)
  // And the requirement itself: the worst realistic case Renzo named must fit on ONE sheet.
  assert.ok(ceilingAt(2) >= 25, 'a 33-day × 25-block campaign must fit one A4 landscape sheet')
})

check('the split is taken at capacity and the TYPE is re-solved for the page', () => {
  // Measured: 33 days x 32 blocks splits 16 + 16, and solving the font over the WHOLE
  // column set pinned both sheets at the 5pt floor — 16 columns of `150,000` sitting in
  // gutters wide enough for 26. Re-solved against the widest page's own demands they
  // print at 7pt. Sizing type for columns a sheet does not carry is a legibility bug.
  assert.match(PRINT_CODE, /const capacityFontPt = Math\.min\(rowFit\.fontPt, widthFit\.fontPt\)/)
  assert.match(PRINT_CODE, /fontPt: capacityFontPt,/)
  assert.match(PRINT_CODE, /const fontPt = Math\.min\(rowFit\.fontPt, pageWidthFit\.fontPt\)/)
  // and the widths must be re-solved against the SAME demand set as the font
  assert.match(PRINT_CODE, /columns: pageDemands,\s+availablePx: PAGE\.widthPx,\s+ladder: \[fontPt\]/)
})

check('the FOOTER ROWS are in the row divisor, and are never a <tfoot>', () => {
  // Chrome REPEATS a `<tfoot>` on every printed page, so a totals row in one reads as a
  // duplicated total. Measured on the real PDF: `tfoot` count 0, `tbody` row count 38 for
  // a 33-day sheet — i.e. 33 days + the 5 footer lines, which is also what makes the
  // vertical solve honest (pinning a footer row at a constant instead is the circularity
  // that made `/operations`' first attempt miss by exactly one row).
  assert.ok(!PRINT_CODE.includes('<tfoot'), 'the printed sheet must never use a <tfoot>')
  assert.match(PRINT_CODE, /const rowCount = data\.rows\.length \+ footers\.length;/)
  assert.match(PRINT_CODE, /budgetPx: rowBudget,\s+rowCount,/)
})

check('the print path FETCHES NOTHING and COMPUTES NOTHING', () => {
  // It renders the payload the page already received. A weighted average recomputed here
  // would be a second definition of a number SQL already owns.
  for (const banned of ['fetchRcMovementMatrix', 'createClient', 'use server', 'await ']) {
    assert.ok(!PRINT_CODE.includes(banned), `the print module must not contain \`${banned}\``)
  }
  // The module DOES fold — over COLUMN WIDTHS and over the words of a header label. That
  // is paper geometry, and it is the whole job. What it must never fold is the DATA: every
  // kilogram, price, yield and loss on the sheet is a field of the payload, formatted. So
  // the ban is specific — no reduce/sum over `data.rows` or `data.columns` — rather than a
  // blanket ban on `reduce(`, which would have been satisfied by renaming a loop.
  for (const m of PRINT_CODE.matchAll(/(\w[\w.]*)\s*\.reduce\(/g)) {
    assert.ok(
      !m[1].startsWith('data.'),
      `the sheet must not fold the payload — found \`${m[1]}.reduce(\``,
    )
  }
  assert.ok(
    !/data\.(rows|columns)\.reduce/.test(PRINT_CODE),
    'totals come from the payload; they are never re-summed here',
  )
})

check('the printed sheet inherits the price gate — it never re-decides it', () => {
  // `fetchRcMovementMatrix` nulls every ₱ field server-side for a `!canViewPrices()`
  // caller, so there is nothing here to leak; the same flag drops the ₱/kg COLUMN and
  // both ₱ FOOTER ROWS from the layout entirely. Verified on a real PDF: the price-denied
  // sheet carries TOTAL / YIELD % / LOSS % only — no ₱ column, no ₱ row.
  assert.match(PRINT_CODE, /const showFedPrice = data\.canViewPrices;/)
  assert.match(
    PRINT_CODE,
    /if \(showFedPrice\) out\.push\('php'\);\s*if \(showFedPrice && showActual\) out\.push\('actual'\);/,
    'the ₱ footer rows follow the gate, and ACTUAL follows the gate AND the switch',
  )
  // the gate is never re-derived from a role on the client
  for (const banned of ['hasPermission', 'canViewPrices()', 'getUserRole']) {
    assert.ok(!PRINT_CODE.includes(banned), `price visibility is never re-decided here (${banned})`)
  }
})

check('the toolbar Print button is wired on BOTH grids from the same control', () => {
  // It prints from the PAYLOAD, not from either grid, so `?grid=v1` and `?grid=v2`
  // produce a byte-identical sheet. The v2 grid is virtualised — printing IT was never
  // an option, which is why the sheet is its own plain non-virtualised table.
  for (const f of ['rc-movement-matrix.tsx', 'rc-movement-grid-v2.tsx']) {
    const src = stripComments(readFileSync(join(MODULE, f), 'utf8'))
    assert.match(src, /import \{ RcMovementPrintControl \} from '\.\/rc-movement-print'/, f)
    assert.match(
      src,
      /<RcMovementPrintControl data=\{data\} showActualPrice=\{showActualPrice\} \/>/,
      `${f} must pass the payload and the live Actual ₱ switch`,
    )
  }
  // and the stage is PORTALLED to <body> — Tailwind v4 centres an overlay with the
  // INDIVIDUAL `translate` property, which `transform: none` does not reset.
  assert.match(PRINT_CODE, /createPortal\(/)
  assert.match(PRINT_CODE, /document\.body,/)
})

// ═══ 5 · THE SHARED PRINT LAYER IS PLATFORM CODE ══════════════════════════════
//
// CLAUDE.md's layer rule: anything under `components/shared/` carries ZERO tenant
// knowledge. These two modules were written for RC Movement and must not remember it —
// `/operations` is expected to re-point at them later.
check('components/shared/print carries no tenant knowledge', () => {
  const TENANT = [
    'charcoal', 'campaign', 'batch', 'block', 'supplier', 'delivery', 'flecon',
    'blackwood', 'ictc', 'cenapro', 'rc_out', 'rcMovement', 'php', '₱', 'kg',
  ]
  for (const f of ['print-fit.ts', 'print-page-rules.ts']) {
    const src = readFileSync(join(ROOT, 'components', 'shared', 'print', f), 'utf8')
    // Comments may NAME their call sites (that is documentation, not coupling); the CODE
    // may not. So the tenant sweep runs over the comment-stripped source.
    const code = stripComments(src).toLowerCase()
    for (const word of TENANT) {
      assert.ok(
        !code.includes(word.toLowerCase()),
        `${f} must not mention \`${word}\` — components/shared is platform code`,
      )
    }
    assert.ok(!code.includes('@/app/'), `${f} must not import from a tenant module`)
  }
  // `print-fit.ts` is PURE arithmetic — no React at all, which is what lets this script
  // import it and re-run the sheet's own solver above.
  const fit = readFileSync(join(ROOT, 'components', 'shared', 'print', 'print-fit.ts'), 'utf8')
  assert.ok(!fit.includes('import'), 'print-fit.ts must have zero imports')
  assert.ok(!fit.includes('use client'), 'print-fit.ts is not a client module — it is arithmetic')
})

console.log(`\n${passed} assertions passed.`)
