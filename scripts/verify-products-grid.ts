/**
 * verify-products-grid.ts — framework-free assertions over the Products page
 * (`app/(app)/inventory/products/**`, `lib/products/**`). No DB, no browser, no React.
 *
 * TENANT-LAYER, deliberately separate from `scripts/verify-table-core.ts`: the widths
 * below are facts about flecon stage names and the label font they render in, and the
 * platform script must not learn either. It is the sibling of
 * `scripts/verify-rc-movement-grid.ts` and `scripts/verify-qc-grid.ts` §12, which is
 * where the method comes from.
 *
 * Run: npx tsx scripts/verify-products-grid.ts
 */
import assert from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = join(ROOT, 'app', '(app)', 'inventory', 'products')
const GRID = join(MODULE, 'products-ledger-grid.tsx')
const VIEW = join(MODULE, 'components', 'products-view.tsx')
const HEADER = join(MODULE, 'components', 'products-header.tsx')
const TABS = join(MODULE, 'components', 'grade-tabs.tsx')
const PAGE = join(MODULE, 'page.tsx')
const QUERIES = join(ROOT, 'lib', 'products', 'queries.ts')
const TYPES = join(ROOT, 'lib', 'products', 'types.ts')
const HEADER_CELL = join(ROOT, 'components', 'shared', 'table', 'HeaderCell.tsx')
const NAVBAR = join(ROOT, 'components', 'navbar.tsx')

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('\nProducts — /inventory/products\n')

const SRC = readFileSync(GRID, 'utf8')
const CODE = stripComments(SRC)
const VIEW_CODE = stripComments(readFileSync(VIEW, 'utf8'))
const HEADER_CODE = stripComments(readFileSync(HEADER, 'utf8'))
const TABS_CODE = stripComments(readFileSync(TABS, 'utf8'))
const PAGE_CODE = stripComments(readFileSync(PAGE, 'utf8'))
const QUERIES_CODE = stripComments(readFileSync(QUERIES, 'utf8'))
const TYPES_SRC = readFileSync(TYPES, 'utf8')

// ═══ 1 · EVERY HEADER MUST BE READABLE ════════════════════════════════════════
//
// CLAUDE.md → "The header owes chrome, not just its label". With sort and filter on,
// `HeaderCell` lays out two 16px buttons and their two 4px gaps as `opacity-0` flex
// SIBLINGS of the label — invisible and still occupying layout.
//
//     usable label width = declared − 16 (px-2) − 40 (two controls) − 1 (border-r)
//     usable label width = declared − 16 − 1                (column opted out of both)
//
// The numbers are MEASURED, in Chrome, against the real computed fonts: the header label
// at `500 11px Geist` with `letter-spacing: 0.275px` and `text-transform: uppercase`.
// Node has no font engine, so they cannot be re-derived here — only ENFORCED. `DATE`
// measures 29.52 here and 29.52 in `verify-rc-movement-grid.ts`, independently measured
// months apart, which is what says the two tables agree about the same font.
const HEADER_PX: Readonly<Record<string, number>> = {
  W_DATE: 29.52, // `DATE`
  W_STAGE: 29.6, // `TYPE`
  W_FLEC: 28.7, // `FLEC`
  W_KG: 15.92, // `KG`
  W_REMARKS: 55.37, // `REMARKS`
  // All eight running lanes share ONE declared width, so the WIDEST stage name is what
  // has to fit it. Measured: PROD 32.43 · OLD PROD 59.75 · AYAG 30.24 · MAGNET 49.27 ·
  // FINAL 33.45 · BLENDED 53.78 · SUNDRY 48.22 · RECLASS 52.60.
  W_RUN: 59.75, // `OLD PROD`
}

/** The widest stage label, and every one of them, so a new stage cannot slip past. */
const STAGE_LABEL_PX: Readonly<Record<string, number>> = {
  PROD: 32.43,
  'OLD PROD': 59.75,
  AYAG: 30.24,
  MAGNET: 49.27,
  FINAL: 33.45,
  BLENDED: 53.78,
  SUNDRY: 48.22,
  RECLASS: 52.6,
}

const CHROME_WITH_CONTROLS = 57
const CHROME_BARE = 17
/** The eight running lanes declare `sortable: false` + `filterable: false`. */
const NO_HEADER_CONTROLS = new Set(['W_RUN'])

/**
 * The widest REAL value each lane can hold, plus the cell's own `px-2` + border (17px).
 * Measured at the CELL fonts, which are not the header's: `700 12px Geist` for the date,
 * `600 11px Geist` for the stage word, `500 12px Geist` for every figure.
 */
const CELL_MIN_PX: Readonly<Record<string, number>> = {
  // `2026-09-05` 73.78 + `ml-1` 4 + the ⚠ an out-of-order row carries ≈ 10.7 → 88.5 + 17.
  W_DATE: 105.5,
  // dot 8 + `gap-1.5` 6 + `OLD PROD` 55.46 + 6 + `~` 5.75 = 81.21 + 17.
  W_STAGE: 98.21,
  W_FLEC: 53.12, // `−1,234` 36.12 + 17 — the header is what actually sizes this lane
  W_KG: 70.03, // `−100,320` 53.03 + 17 — the real 2X6 shipment row
  W_REMARKS: 120, // truncates by design; wide enough to be worth reading
  W_RUN: 46.78, // `1,234` 29.78 + 17
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

check("every column is wide enough for its own HEADER at the header's font", () => {
  const widths = declaredWidths()
  for (const [key, label] of Object.entries(HEADER_PX)) {
    const chrome = NO_HEADER_CONTROLS.has(key) ? CHROME_BARE : CHROME_WITH_CONTROLS
    const floor = label + chrome
    const declared = widths.get(key)!
    assert.ok(
      declared >= floor,
      `${key}: declared ${declared}px but the header needs ${floor.toFixed(2)}px ` +
        `(label ${label} + ${chrome} of chrome) — it would render truncated`,
    )
  }
})

check('the ONE running-lane width fits the widest of the EIGHT stage names', () => {
  // The lanes are built per grade, so which eight appear depends on the grade — but they
  // all share `W_RUN`. A ninth stage inventing a longer name has to move this number.
  const declared = declaredWidths().get('W_RUN')!
  for (const [stage, px] of Object.entries(STAGE_LABEL_PX)) {
    assert.ok(
      declared >= px + CHROME_BARE,
      `W_RUN ${declared}px cannot hold "${stage}" (${px} + ${CHROME_BARE})`,
    )
  }
  const widest = Math.max(...Object.values(STAGE_LABEL_PX))
  assert.equal(widest, HEADER_PX.W_RUN, 'W_RUN must be budgeted against the WIDEST stage name')
  // …and every stage the type module declares is in the measured table above.
  const declaredStages = /export const PRODUCT_STAGES = \[([\s\S]*?)\] as const/.exec(TYPES_SRC)
  assert.ok(declaredStages, 'PRODUCT_STAGES must be findable')
  const names = [...declaredStages[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.equal(names.length, 8, 'eight stages')
  for (const n of names) {
    assert.ok(n in STAGE_LABEL_PX, `stage "${n}" has no measured label width — measure it`)
  }
})

check('every column is wide enough for its widest REAL value', () => {
  // The other half of the same question, and the half the 2026-08-25 QC pass forgot: a
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
  assert.match(header, /opacity-0 group-hover\/th:opacity-100/, 'laid out even while invisible — the whole trap')

  // This sheet turns both on EXPLICITLY, and the running lanes opt out individually.
  assert.match(CODE, /scope="endless"/)
  assert.match(CODE, /\n\s*enableSort\n\s*enableFilter\n/, 'both axes are switched on by name')
  assert.match(CODE, /sortable: false,\s*\n\s*filterable: false,/, 'the running lanes opt out')
  assert.equal(
    (CODE.match(/sortable: false/g) ?? []).length,
    1,
    'exactly ONE opt-out — it lives on the shared running-lane spec',
  )
})

check('nothing on this sheet wraps its header', () => {
  // The header row grows to its TALLEST cell, so one wrapped header raises every other
  // one — and a name broken across two lines is not more readable than one that fits.
  assert.ok(!CODE.includes('headerWrap'), 'no column may declare headerWrap')
})

// ═══ 2 · THE NUMBERS ARE THE DATABASE'S ═══════════════════════════════════════

check('the grid never recomputes a running balance', () => {
  // `view_product_ledger` computes every stage's running balance in SQL with conditional
  // window sums. The grid READS `row.running[stage]` and formats it.
  assert.match(CODE, /numericValue: \(row\) => row\.running\[stage\] \?\? null,/)
  assert.ok(
    !/running\[[^\]]+\]\s*[+\-]/.test(CODE),
    'no arithmetic on a running balance anywhere in the grid',
  )
  // The ONE accumulator it owns is the footer Σ over the DELTAS, and it says so.
  assert.match(CODE, /total\.flec \+= row\.flecDelta \?\? 0;/)
  assert.match(CODE, /total\.kg \+= row\.kgDelta \?\? 0;/)
})

check('the footer says what it actually totals, and never claims "shown"', () => {
  // Sort and filter live inside `BlackwoodTable`; no seam hands the consumer the rows
  // that survived them. A footer claiming to total "what is shown" would be wrong the
  // instant a filter is on — the platform's own view strip reports "N of M rows".
  assert.match(CODE, /movement\{total\.count === 1 \? '' : 's'\} loaded/)
  assert.ok(!/movements? shown/.test(CODE), 'the footer must not claim to total the VISIBLE rows')
  assert.match(CODE, /Totals cover every loaded row/)
  // …and it is a PINNED per-column summary row, not a body chrome row that scrolls away.
  assert.match(CODE, /\{ key: 'totals', sticky: true, cell: totalsCell \}/)
})

check('a NULL is rendered blank and never as a zero', () => {
  // CONTEXT.md → Six things #1 and #6. "We do not know" and "it weighs nothing" are
  // different answers, and `kg_delta` is genuinely NULL on a real row today.
  assert.match(CODE, /if \(value === null\) return <span className="text-muted-foreground\/40">&mdash;<\/span>;/)
  assert.match(QUERIES_CODE, /function nn\(value: number \| string \| null \| undefined\): number \| null/)
  assert.match(HEADER_CODE, /tonnage unknown — no kg\/flec recorded yet/)
  assert.match(HEADER_CODE, /function tons\(value: number \| null\): string \| null \{\s*\n\s*if \(value === null\) return null;/)
})

check('the per-stage tonnage is the VIEW\'s own formula, not a second definition', () => {
  // `view_product_onhand` publishes `flecs * kg_per_flec` and rounds tons to 3dp; the
  // adapter applies exactly that to a balance the DATABASE computed. It is a unit
  // conversion of a published number, never a re-derivation of a balance.
  assert.match(
    QUERIES_CODE,
    /return Math\.round\(\(\(flecs \* kgPerFlec\) \/ 1000\) \* 1000\) \/ 1000;/,
  )
  assert.match(QUERIES_CODE, /if \(kgPerFlec === null\) return null;/)
  // And it AGREES with SQL: the view's own `final_tons` must equal the conversion applied
  // to `final_flecs`, on every grade. Measured live 2026-09-07.
  const LIVE: [string, number, number | null, number | null, number | null][] = [
    // code, final_flecs, kg_per_flec, final_tons (from the view), total_tons
    ['8X50', 59, 550, 32.45, 32.45],
    ['6X50', 187, 570, 106.59, 212.04],
    ['2X6', 65, 570, 37.05, 48.45],
    ['KURARAY 3X50', 36, 590, 21.24, 86.14],
    ['4X8', 35, 575, 20.125, 20.125],
  ]
  const convert = (flecs: number, rate: number | null) =>
    rate === null ? null : Math.round(((flecs * rate) / 1000) * 1000) / 1000
  for (const [code, final, rate, finalTons] of LIVE) {
    assert.equal(
      convert(final, rate),
      finalTons,
      `${code}: the TS conversion disagrees with view_product_onhand.final_tons`,
    )
  }
  // …and the totals the portfolio publishes are the sum of the grades', to the kilo.
  const totalTons = LIVE.reduce((a, [, , , , t]) => a + (t ?? 0), 0)
  assert.equal(Math.round(totalTons * 1000) / 1000, 399.205, 'Σ total_tons = the portfolio row')
  const finalTonsSum = LIVE.reduce((a, [, , , t]) => a + (t ?? 0), 0)
  assert.equal(Math.round(finalTonsSum * 1000) / 1000, 217.455, 'Σ final_tons = the portfolio row')
})

check('vans are FRACTIONAL, and 44 is stated once', () => {
  // The sheet's own formula, FINAL ÷ 44. Rounding it to "1 van" throws away the half a
  // van that is the operational point (CONTEXT.md → Six things #2).
  assert.match(HEADER_CODE, /const FLEC_PER_VAN = 44;/)
  assert.match(HEADER_CODE, /minimumFractionDigits: 2, maximumFractionDigits: 2/)
  // The view computes it; nothing here divides.
  assert.ok(!/\/ 44/.test(HEADER_CODE), 'the header must not divide by 44 — the view already did')
  assert.ok(!/\/ 44/.test(VIEW_CODE), 'the shell must not divide by 44 either')
  assert.match(QUERIES_CODE, /vansReady: n0\(row\.vans_ready\)/)
  // Measured against the live view: FINAL 59 / 44 = 1.3409, 187 / 44 = 4.25.
  assert.equal(Math.round((59 / 44) * 10000) / 10000, 1.3409)
  assert.equal(Math.round((187 / 44) * 10000) / 10000, 4.25)
})

// ═══ 3 · THE TWO SOURCE DEFECTS ARE QUIET, AND SAID ONCE ══════════════════════

check('the sheet-running drift is a ~ and a once-per-grade note, NEVER a red row', () => {
  // `agrees_with_sheet` is false on 448 of 808 rows and that is the SHEET, not the app.
  assert.match(CODE, /showDriftMarker && row\.agreesWithSheet === false \? \(/)
  // …and a marker that would land on EVERY row is not drawn at all: it would single out
  // nothing (2X6 drifts on 216 of 216 rows), and the header note is then the whole
  // message. Same reasoning as a month heading naming the only month present.
  assert.match(
    CODE,
    /const showDriftMarker = grade\.sheetRunningDisagreementCount < grade\.movementCount;/,
  )
  assert.match(HEADER_CODE, /const everyRow = grade\.sheetRunningDisagreementCount >= grade\.movementCount;/)
  assert.match(HEADER_CODE, /so no per-row mark is drawn, it would single out nothing/)
  assert.match(CODE, /text-muted-foreground\/70"\s*\n\s*title="The sheet's own printed running cell disagrees/)
  // Nothing paints a row from it, and no destructive colour is anywhere near it.
  assert.ok(
    !/agreesWithSheet[\s\S]{0,400}?(bg-red|text-red|destructive)/.test(CODE),
    'a disagreeing row must never be painted red',
  )
  assert.match(HEADER_CODE, /The sheet&rsquo;s own running column drifts on\{' '\}/)
  assert.match(HEADER_CODE, /grade\.sheetRunningDisagreementCount > 0/)
})

check('the out-of-order dates are flagged, muted, and never corrected', () => {
  assert.match(CODE, /row\.dateOutOfSheetOrder && 'font-normal text-muted-foreground'/)
  assert.match(CODE, /a likely year typo\)\. Flagged, never corrected/)
  assert.ok(
    !/dateOutOfSheetOrder[\s\S]{0,300}?(bg-red|text-red|destructive)/.test(CODE),
    'an out-of-order date must never be painted red',
  )
  // Nothing anywhere rewrites a transaction date.
  assert.ok(!/transactionDate\s*=/.test(CODE), 'the grid must never assign a transaction date')
  assert.ok(!/new Date\(/.test(CODE), 'no Date() round trip — a timezone moves a row to the previous day')
  assert.ok(!/new Date\(/.test(HEADER_CODE), 'the header slices dates, it does not parse them')
})

check('the OTHER catch-all is surfaced rather than dropped', () => {
  // `other_flecs > 0` means a stage exists with no column here. It is counted in the
  // total by SQL; the page must say so instead of silently losing it.
  assert.match(QUERIES_CODE, /const otherFlecs = n0\(row\.other_flecs\);/)
  assert.match(QUERIES_CODE, /stages\.push\(\{ stage: 'OTHER'/)
  assert.match(HEADER_CODE, /sit in a stage\s*\n\s*this page has no column for/)
})

// ═══ 4 · NO PESO, ANYWHERE ════════════════════════════════════════════════════

check('this module has no price gate because it has no price', () => {
  // COMMENTS ARE STRIPPED FIRST, deliberately: every one of these files EXPLAINS in prose
  // that there is no price here and therefore no gate, and a scan that could not tell a
  // rationale from a call would forbid the module from documenting itself.
  const files: [string, string][] = [
    ['grid', CODE], ['view', VIEW_CODE], ['header', HEADER_CODE],
    ['tabs', TABS_CODE], ['page', PAGE_CODE], ['queries', QUERIES_CODE],
    ['types', stripComments(TYPES_SRC)],
  ]
  for (const [name, src] of files) {
    assert.ok(!src.includes('canViewPrices'), `${name} must not import or mention canViewPrices`)
    assert.ok(!src.includes('hasPermission'), `${name} must not re-derive a role`)
    assert.ok(!src.includes('₱'), `${name} must not carry a ₱ glyph`)
    assert.ok(
      !/\b(cost_basis|php_kg|avg_price|price_php|peso)\b/i.test(src),
      `${name} must not name a price column`,
    )
  }
  // …and the rationale IS written down, in both halves of the data layer.
  assert.match(TYPES_SRC, /NO PESO ANYWHERE IN THIS MODULE/)
  assert.match(readFileSync(QUERIES, 'utf8'), /NO PESO ANYWHERE/)
})

// ═══ 5 · THE URL CONTRACT ═════════════════════════════════════════════════════

check('?grade= selects the tab, and a value naming nothing means the DEFAULT', () => {
  assert.match(PAGE_CODE, /searchParams: Promise<\{ grade\?: string \}>/)
  assert.match(PAGE_CODE, /const data = await getProductsData\(grade\);/)
  assert.match(VIEW_CODE, /const GRADE_PARAM = 'grade';/)
  // The resolver is pure and exported, so it can be exercised right here.
  assert.match(QUERIES_CODE, /export function resolveGrade\(/)
  assert.match(QUERIES_CODE, /return grades\[0\];/, 'an unrecognised param falls back, never half-selects')
  // Every OTHER param survives a grade change — the round trip is exhaustive.
  assert.match(VIEW_CODE, /new URLSearchParams\(searchParams\.toString\(\)\)/)
  assert.match(VIEW_CODE, /params\.set\(GRADE_PARAM, code\);/)
  // Optimistic, so the rail and the header repaint on the SAME frame as the click.
  assert.match(VIEW_CODE, /React\.useOptimistic\(serverCode\)/)
  assert.match(VIEW_CODE, /startTransition\(\(\) => \{\s*\n\s*setOptimisticCode\(code\);/)
  assert.match(VIEW_CODE, /router\.replace\(qs \? `\$\{pathname\}\?\$\{qs\}` : pathname, \{ scroll: false \}\)/)
  // …and the LEDGER stays on the server-selected grade, or a grade's rows would render
  // under another grade's name for the length of a round trip.
  assert.match(VIEW_CODE, /grade=\{data\.selected\}/)
  assert.match(VIEW_CODE, /const ledgerStale = selectedCode !== serverCode;/)
})

// ═══ 6 · THE SHELL ════════════════════════════════════════════════════════════

check('the rail is DERIVED, so a new grade appears without a code change', () => {
  assert.match(VIEW_CODE, /grades=\{data\.grades\}/)
  assert.match(TABS_CODE, /grades\.map\(\(grade\) => \{/)
  assert.ok(!/'8X50'|'6X50'|'2X6'|'4X8'|Kuraray/i.test(TABS_CODE), 'no grade is named in the rail')
  assert.ok(!/'8X50'|'6X50'|'2X6'|'4X8'/.test(CODE), 'no grade is named in the grid')
  // ACTIVE only — and the sync never deactivates anything, so the filter honours a human.
  assert.match(QUERIES_CODE, /\.filter\(\(r\) => r\.active !== false\)/)
})

check('the tabs are BIG, and the rail scrolls rather than crushing', () => {
  // Renzo: "Also make the grade tabs bigger." 60px cards, 15px name, mono 11px numbers.
  assert.match(TABS_CODE, /'flex h-\[60px\] shrink-0 flex-col/)
  assert.match(TABS_CODE, /text-\[15px\] font-semibold/)
  assert.match(TABS_CODE, /FINAL \{int\(grade\.finalFlecs\)\} flec · \{vans\(grade\.vansReady\)\} vans/)
  assert.match(TABS_CODE, /'flex shrink-0 gap-2 overflow-x-auto pb-1'/)
  assert.match(TABS_CODE, /'border-primary bg-primary text-primary-foreground shadow-sm'/)
})

check('the header is FLEC-FIRST — the hero is shippable flecs, tons is subtext', () => {
  // Renzo: "more flecon amount forward (the final and shippable flecon bag amounts, with
  // the total vans as an additional info and the total tons as some kind of subtext)."
  const hero = HEADER_CODE.slice(
    HEADER_CODE.indexOf('· shippable'),
    HEADER_CODE.indexOf('<Cap>Vans ready</Cap>'),
  )
  assert.ok(hero.length > 100, 'the hero block must be findable')
  assert.match(hero, /text-\[34px\] font-semibold/, 'the hero is set at 34px')
  assert.match(hero, /\{int\(grade\.finalFlecs\)\}/, 'and it is FINAL — the shippable half')
  assert.match(hero, /<Unit>flec<\/Unit>/, 'unit on the left, as in the mockup')
  assert.match(hero, /text-\[11px\] text-muted-foreground/, 'the tonnage is muted subtext')
  assert.match(hero, /t on hand/)
  // And it really is the BIGGEST type on the page — measured against every size the two
  // presentation files declare, not merely asserted about the one line.
  const sizes = [...HEADER_CODE.matchAll(/text-\[(\d+)px\]/g), ...TABS_CODE.matchAll(/text-\[(\d+)px\]/g)]
    .map((m) => Number(m[1]))
  assert.equal(Math.max(...sizes), 34, 'nothing may be set larger than the shippable-flec hero')
  // Vans is secondary — smaller than the hero, larger than the subtext.
  const vansBlock = HEADER_CODE.slice(
    HEADER_CODE.indexOf('<Cap>Vans ready</Cap>'),
    HEADER_CODE.indexOf('grade.stages.map'),
  )
  assert.ok(vansBlock.length > 100, 'the vans block must be findable')
  assert.match(vansBlock, /text-\[22px\] font-semibold/)
  assert.match(vansBlock, /× \{FLEC_PER_VAN\} flec \/ van/)
  const vansSize = Number(/text-\[(\d+)px\] font-semibold/.exec(vansBlock)![1])
  assert.ok(vansSize < 34 && vansSize > 11, 'vans sits between the hero and the subtext')
  // Only stages that actually hold something get a cell.
  assert.match(QUERIES_CODE, /if \(flecs !== 0\) stages\.push/)
})

check('the stage colours are the shared data-viz series, and are theme-aware', () => {
  for (const [stage, token] of [
    ['PROD', 'var(--bw-year-1)'],
    ['AYAG', 'var(--bw-year-4)'],
    ['MAGNET', 'var(--bw-year-7)'],
    ['FINAL', 'var(--bw-year-3)'],
    ['BLENDED', 'var(--bw-year-5)'],
    ['SUNDRY', 'var(--bw-year-2)'],
    ['RECLASS', 'var(--muted-foreground)'],
  ] as const) {
    assert.ok(
      new RegExp(`${stage.includes(' ') ? `'${stage}'` : stage}: '${token.replace(/[()\-]/g, '\\$&')}'`).test(CODE),
      `${stage} must use ${token}`,
    )
  }
  // OLD PROD is a slate MIXED from two existing tokens rather than a new global.
  assert.match(CODE, /'OLD PROD': 'color-mix\(in oklab, var\(--bw-year-1\) 30%, var\(--muted-foreground\)\)'/)
  // No hard-coded hex anywhere — the palette is `globals.css`'s, in both themes.
  assert.ok(!/#[0-9a-fA-F]{6}/.test(CODE), 'the grid must carry no literal hex colour')
  assert.ok(!/#[0-9a-fA-F]{6}/.test(HEADER_CODE), 'the header must carry no literal hex colour')
})

// ═══ 7 · THE READ IS READ-ONLY, AND IT IS THE SYNC PANEL'S OWN FINDINGS ═══════

check('nothing on this page can write', () => {
  for (const [name, src] of [['grid', CODE], ['view', VIEW_CODE], ['header', HEADER_CODE], ['tabs', TABS_CODE]] as const) {
    assert.ok(!src.includes("'use server'"), `${name} must declare no server action`)
    assert.ok(!/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(src), `${name} must make no mutation`)
  }
  // Structurally read-only: every column is `readonly`, none carries a `parse`, and no
  // editor is passed — so `columnAcceptsEdit` is false at every coordinate.
  assert.equal(
    (CODE.match(/cellKind: 'readonly'/g) ?? []).length,
    6,
    'five data columns + the shared running-lane spec, all readonly',
  )
  assert.ok(!/\bparse:/.test(CODE), 'no column may declare a parse')
  assert.ok(!CODE.includes('renderEditor'), 'no editor may be passed')
  assert.ok(!CODE.includes('draftKind'), 'no blank-row pool')
  // The RPCs are `service_role` only and the app must not name them.
  for (const rpc of ['fn_upsert_product_grade', 'fn_rename_product_grade', 'fn_replace_product_grade']) {
    assert.ok(!QUERIES_CODE.includes(rpc), `the app must never call ${rpc}`)
  }
})

check('the sync chips are the PANEL\'s own findings, gated to who can act on them', () => {
  // Same `flattenRunFindings` over the same latest-run read as `app/(app)/sync/needs-you.ts`,
  // so a chip can never disagree with the panel about what the run said.
  assert.match(QUERIES_CODE, /import \{ flattenRunFindings \} from '@\/lib\/sync\/findings'/)
  assert.match(QUERIES_CODE, /\.from\('sync_runs'\)/)
  assert.match(QUERIES_CODE, /\.not\('result', 'is', null\)/)
  assert.match(QUERIES_CODE, /\.order\('started_at', \{ ascending: false \}\)/)
  assert.match(QUERIES_CODE, /\.filter\(\(f\) => f\.section === 'products'\)/)
  // PRIVILEGED only, through `getUserRole()` so the impersonation cookie is respected.
  assert.match(QUERIES_CODE, /if \(!PRIVILEGED_ROLES\.includes\(role\)\) return \{ findings: \[\], runId: null \};/)
  // FAILS QUIET — a missing chip costs a click; a fabricated one sends someone hunting.
  assert.match(QUERIES_CODE, /\} catch \{\s*\n\s*return \{ findings: \[\], runId: null \};/)
  // Read-only: the chips LINK to /sync and build no second door to a decision.
  assert.match(VIEW_CODE, /const href = runId \? `\/sync\/cases\?run=\$\{runId\}` : '\/sync';/)
  assert.ok(!VIEW_CODE.includes('acknowledgeFinding'), 'no action is taken from this page')
})

check('the ledger read is PAGED and scoped to one grade', () => {
  // 331 rows at the widest today against PostgREST's 1000-row cap — but a grade that
  // outgrows it must page, not be silently truncated to its OLDEST 1000 rows.
  assert.match(QUERIES_CODE, /fetchAllRows<LedgerRow>\(\(from, to\) =>/)
  assert.match(QUERIES_CODE, /\.eq\('grade_id', selected\.gradeId\)/)
  assert.match(QUERIES_CODE, /\.order\('transaction_date', \{ ascending: false \}\)/)
  assert.match(QUERIES_CODE, /\.order\('source_row', \{ ascending: false, nullsFirst: false \}\)/)
  // A failure is SURFACED, never thrown — the page renders whatever arrived.
  assert.match(QUERIES_CODE, /ledgerError = `The running tally could not be loaded/)
})

check('an error persists until dismissed AND carries a Copy button (HARD RULE)', () => {
  assert.match(VIEW_CODE, /import \{ errorToast \} from '@\/lib\/toast'/)
  assert.ok(!VIEW_CODE.includes('toast.error'), 'never sonner directly — errorToast enforces the rule')
  assert.match(VIEW_CODE, /if \(shownError\) errorToast\(shownError\);/)
  // …and the inline half, which survives a dismissed toast.
  assert.match(VIEW_CODE, /function ErrorBanner\(\{ message \}: \{ message: string \}\)/)
  assert.match(VIEW_CODE, /navigator\.clipboard\?\.writeText\(message\)/)
})

// ═══ 8 · THE ROUTE IS REGISTERED ══════════════════════════════════════════════

check('the navbar owns the title, and the page renders none', () => {
  const nav = readFileSync(NAVBAR, 'utf8')
  assert.match(
    nav,
    /prefix\('\/inventory\/products'\), backLabel: 'Back to Inventory', backHref: '\/inventory', pageTitle: 'Products', pageDescription: 'Finished goods — flec stock by grade & running tally'/,
  )
  assert.match(nav, /\{ name: 'Products', href: '\/inventory\/products' \}/)
  // It must precede the `/inventory` catch-all, or the crumb reads "Inventory".
  assert.ok(
    nav.indexOf("prefix('/inventory/products')") < nav.indexOf("prefix('/inventory'), backLabel"),
    'the sub-route entry must precede the /inventory catch-all',
  )
  // No page renders its own header (project rule).
  for (const [name, src] of [['page', PAGE_CODE], ['view', VIEW_CODE]] as const) {
    assert.ok(!/<h1/.test(src), `${name} must not render a page title`)
  }
})

check('the dev fixture harness is NOT shipped', () => {
  // The browser pass mounts `ProductsView` on an in-memory fixture under
  // `app/dev/table-playground/products/`. It is a throwaway and must not survive.
  assert.ok(
    !existsSync(join(ROOT, 'app', 'dev', 'table-playground', 'products')),
    'the throwaway products fixture must be deleted before commit',
  )
})

console.log(`\n${passed} assertions passed.`)
