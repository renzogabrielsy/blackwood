/**
 * verify-year-overlay.ts — framework-free proof of the analytics YEAR OVERLAY's
 * placement arithmetic (owner feedback R9, 2026-09-03).
 *
 * Renzo: *"instead of making it a long chart that encompasses multiple years, you
 * could have each year be represented by a line … and have the axes be set to just
 * January to December, Q1 to Q4 and batches to be JANUARY to DECEMBER. If we have a
 * custom batch name that isn't a month … then it should be placed chronologically
 * within its production date month. So for example in AUGUST 2026 BATCH, if I have a
 * custom batch called SRC for example, then SRC axis should be placed after AUGUST
 * location since its production date is August."*
 *
 * `lib/analytics/year-overlay.ts` is the ONE placement rule and it is pure, so it can
 * be proven without mounting anything. What is at stake is not cosmetic: a placement
 * helper that quietly aggregates two points, or that infers a position it does not
 * know, would be a SECOND definition of a number `matrix.ts` already owns — the exact
 * shape of every arithmetic bug this page has had.
 *
 * Asserts:
 *   1. Month mode is exactly twelve slots, Jan → Dec, whatever the data says.
 *   2. Quarter mode is exactly four slots, Q1 → Q4.
 *   3. The batch axis is the twelve months by NAME when every campaign is month-named.
 *   4. SRC with an AUGUST start date lands immediately between AUGUST and SEPTEMBER.
 *   5. Two custom names starting in one month keep chronological order by start date.
 *   6. A custom name with NO start date goes to the END, flagged `unplaced`.
 *   7. A month-named campaign is NEVER moved by a start date that disagrees with it.
 *   8. A December-starting custom lands after DECEMBER and is `start_date`, not
 *      `unplaced` — the end of the axis is not the same fact as being unplaceable.
 *   9. The fold puts each year in its own series, ascending, one key per year.
 *  10. A slot a year has no point for is `null` — never 0.
 *  11. Nothing is aggregated: a second point for one (slot, year) is REPORTED, the
 *      first is kept, and no arithmetic happens.
 *  12. One custom slot is shared across years; its position is the EARLIEST start.
 *  13. Slot keys are unique on every clock.
 *  14. `withValue` counts figures, not points.
 *  15. Colour and stroke are pure functions of the YEAR — a filtered-out year never
 *      repaints the survivors.
 *  16. Three adjacent years get three different colours AND three different strokes.
 *  17. `parseYearStyles` refuses anything it did not write (the untrusted-storage rule).
 *  18. A resolved style is the default unless overridden, and says which it is.
 *  19. Placement is total: every point that names a slot lands in one.
 *  20. The month of a start date is read, never guessed.
 *
 * Run:  npx tsx scripts/verify-year-overlay.ts
 */
import assert from 'node:assert/strict'

import {
  buildOverlaySlots,
  buildYearOverlay,
  defaultYearColor,
  defaultYearStyle,
  monthOfDate,
  parseYearStyles,
  resolveYearStyle,
  seriesDataKey,
  slotKeyForPoint,
  YEAR_DASH,
  type OverlayPoint,
} from '../lib/analytics/year-overlay'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** A month-clock point. `seq` is the month, exactly as `Period.seq` carries it. */
function mp(year: number, month: number, value: number | null): OverlayPoint {
  return {
    periodKey: `${year}-${String(month).padStart(2, '0')}`,
    year,
    seq: month,
    value,
    fullLabel: `${month}/${year}`,
  }
}

/** A campaign point. */
function cp(
  name: string,
  year: number,
  value: number | null,
  startDate: string | null,
): OverlayPoint {
  return {
    periodKey: `${name} ${year}`,
    year,
    // Mirrors `buildCampaignMatrix`: month index of the name, 99 when unknown.
    seq: 99,
    value,
    fullLabel: `${name} ${year}`,
    name,
    startDate,
  }
}

const labels = (slots: { label: string }[]) => slots.map((s) => s.label)

// ---------------------------------------------------------------------------
check('1. month mode is twelve fixed slots, Jan → Dec', () => {
  const { slots } = buildOverlaySlots('M', [mp(2026, 3, 1)])
  assert.equal(slots.length, 12)
  assert.deepEqual(labels(slots), [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ])
  // The axis does NOT shrink to the data — that is the whole point of a fixed axis.
  assert.equal(buildOverlaySlots('M', []).slots.length, 12)
})

// ---------------------------------------------------------------------------
check('2. quarter mode is four fixed slots, Q1 → Q4', () => {
  const { slots } = buildOverlaySlots('Q', [{ ...mp(2026, 1, 1), seq: 4 }])
  assert.deepEqual(labels(slots), ['Q1', 'Q2', 'Q3', 'Q4'])
  assert.equal(slotKeyForPoint('Q', { seq: 4 }), 'q4')
  assert.equal(slotKeyForPoint('Q', { seq: 5 }), null)
})

// ---------------------------------------------------------------------------
check('3. the batch axis is JANUARY → DECEMBER when every name is a month', () => {
  const pts = [
    cp('AUGUST', 2026, 10, '2026-08-02'),
    cp('JANUARY', 2026, 20, '2026-01-04'),
    cp('AUGUST', 2025, 30, '2025-08-01'),
  ]
  const { slots, unplaced } = buildOverlaySlots('B', pts)
  assert.equal(slots.length, 12)
  assert.equal(slots[0].label, 'JANUARY')
  assert.equal(slots[11].label, 'DECEMBER')
  assert.deepEqual(unplaced, [])
  // A campaign that ran in two years shares ONE slot.
  assert.equal(slotKeyForPoint('B', { seq: 99, name: 'AUGUST' }), 'm08')
})

// ---------------------------------------------------------------------------
check('4. SRC with an AUGUST start lands between AUGUST and SEPTEMBER', () => {
  const pts = [
    cp('AUGUST', 2026, 10, '2026-08-02'),
    cp('SRC', 2026, 5, '2026-08-19'),
    cp('SEPTEMBER', 2026, 7, '2026-09-01'),
  ]
  const { slots } = buildOverlaySlots('B', pts)
  const names = labels(slots)
  assert.equal(slots.length, 13)
  const aug = names.indexOf('AUGUST')
  assert.equal(names[aug + 1], 'SRC')
  assert.equal(names[aug + 2], 'SEPTEMBER')
  const src = slots[aug + 1]
  assert.equal(src.kind, 'custom')
  assert.equal(src.month, 8)
  assert.equal(src.placement, 'start_date')
})

// ---------------------------------------------------------------------------
check('5. two customs in one month keep chronological order by start date', () => {
  // Deliberately supplied newest-first and in reverse alphabetical order, so
  // neither input order nor the alphabet can be what produces the answer.
  const pts = [
    cp('ZULU', 2026, 1, '2026-08-27'),
    cp('ALPHA', 2026, 1, '2026-08-05'),
    cp('AUGUST', 2026, 1, '2026-08-01'),
  ]
  const names = labels(buildOverlaySlots('B', pts).slots)
  const aug = names.indexOf('AUGUST')
  assert.deepEqual(names.slice(aug, aug + 4), ['AUGUST', 'ALPHA', 'ZULU', 'SEPTEMBER'])

  // A tie on the date falls back to the NAME, so the axis is a total order.
  const tied = labels(
    buildOverlaySlots('B', [
      cp('ZULU', 2026, 1, '2026-08-05'),
      cp('ALPHA', 2026, 1, '2026-08-05'),
    ]).slots,
  )
  const a2 = tied.indexOf('AUGUST')
  assert.deepEqual(tied.slice(a2, a2 + 3), ['AUGUST', 'ALPHA', 'ZULU'])
})

// ---------------------------------------------------------------------------
check('6. a custom with no start date goes to the END, flagged unplaced', () => {
  const pts = [cp('AUGUST', 2026, 1, '2026-08-01'), cp('SRC', 2026, 2, null)]
  const { slots, unplaced } = buildOverlaySlots('B', pts)
  assert.equal(slots.length, 13)
  assert.equal(slots[12].label, 'SRC')
  assert.equal(slots[12].placement, 'unplaced')
  assert.equal(slots[12].month, null)
  assert.deepEqual(unplaced, ['SRC'])
  // It is NOT quietly filed under January.
  assert.notEqual(slots[0].label, 'SRC')
})

// ---------------------------------------------------------------------------
check('7. a month name is never moved by a disagreeing start date', () => {
  // AUGUST 2026 whose first reported day is in SEPTEMBER, and one whose first
  // reported day is in the DECEMBER of the year before. Both stay in AUGUST.
  const pts = [
    cp('AUGUST', 2026, 1, '2026-09-03'),
    cp('AUGUST', 2025, 1, '2024-12-30'),
  ]
  const { slots } = buildOverlaySlots('B', pts)
  assert.equal(slots.length, 12)
  const fold = buildYearOverlay('B', pts)
  const augRow = fold.rows.find((r) => r.label === 'AUGUST')!
  assert.equal(augRow[seriesDataKey(2026)], 1)
  assert.equal(augRow[seriesDataKey(2025)], 1)
  // Nothing landed in September or December.
  assert.equal(fold.rows.find((r) => r.label === 'SEPTEMBER')![seriesDataKey(2026)], null)
  assert.equal(fold.rows.find((r) => r.label === 'DECEMBER')![seriesDataKey(2025)], null)
})

// ---------------------------------------------------------------------------
check('8. a December-starting custom is placed, not unplaced', () => {
  const { slots, unplaced } = buildOverlaySlots('B', [
    cp('SRC', 2026, 1, '2026-12-11'),
  ])
  assert.equal(slots.length, 13)
  assert.equal(slots[12].label, 'SRC')
  assert.equal(slots[12].placement, 'start_date')
  assert.equal(slots[12].month, 12)
  assert.deepEqual(unplaced, [])
})

// ---------------------------------------------------------------------------
check('9. one series per year, ascending, one data key each', () => {
  const pts = [
    mp(2026, 1, 5), mp(2024, 6, 3), mp(2025, 12, 4), mp(2026, 2, 6),
  ]
  const fold = buildYearOverlay('M', pts)
  assert.deepEqual(fold.series.map((s) => s.year), [2024, 2025, 2026])
  assert.deepEqual(fold.series.map((s) => s.dataKey), ['y2024', 'y2025', 'y2026'])
  assert.equal(new Set(fold.series.map((s) => s.dataKey)).size, 3)
})

// ---------------------------------------------------------------------------
check('10. a slot a year has no point for is null, never 0', () => {
  const fold = buildYearOverlay('M', [mp(2026, 1, 5), mp(2025, 6, null)])
  const jan = fold.rows[0]
  assert.equal(jan[seriesDataKey(2026)], 5)
  assert.equal(jan[seriesDataKey(2025)], null)
  // And a point that EXISTS carrying a null value is still null, not dropped —
  // "nothing was recorded" and "no such period" both draw a gap.
  const jun = fold.rows[5]
  assert.equal(jun[seriesDataKey(2025)], null)
  assert.equal(jun.fullLabel, 'June')
  // No row anywhere invented a zero.
  for (const r of fold.rows) {
    for (const s of fold.series) assert.notEqual(r[s.dataKey], 0)
  }
})

// ---------------------------------------------------------------------------
check('11. nothing is aggregated — a collision is reported, not summed', () => {
  const dup: OverlayPoint[] = [
    { ...mp(2026, 3, 10), periodKey: 'first' },
    { ...mp(2026, 3, 90), periodKey: 'second' },
  ]
  const fold = buildYearOverlay('M', dup)
  const mar = fold.rows[2]
  assert.equal(mar[seriesDataKey(2026)], 10, 'the first point keeps the slot')
  assert.equal(fold.collisions.length, 1)
  assert.deepEqual(fold.collisions[0], {
    slotKey: 'm03',
    year: 2026,
    kept: 'first',
    dropped: 'second',
  })
  // 100 would be a sum, 50 a mean, 90 an overwrite. None of those happened.
  assert.notEqual(mar[seriesDataKey(2026)], 100)
  assert.notEqual(mar[seriesDataKey(2026)], 50)
})

// ---------------------------------------------------------------------------
check('12. a custom name shared across years is ONE slot at its earliest start', () => {
  const pts = [
    cp('SRC', 2026, 2, '2026-11-04'),
    cp('SRC', 2025, 1, '2025-08-19'),
    cp('AUGUST', 2026, 9, '2026-08-01'),
  ]
  const { slots } = buildOverlaySlots('B', pts)
  assert.equal(slots.filter((s) => s.label === 'SRC').length, 1)
  const names = labels(slots)
  // Placed by the EARLIEST sighting (August 2025), not the later November one.
  assert.equal(names[names.indexOf('AUGUST') + 1], 'SRC')
  const fold = buildYearOverlay('B', pts)
  const src = fold.rows.find((r) => r.label === 'SRC')!
  assert.equal(src[seriesDataKey(2025)], 1)
  assert.equal(src[seriesDataKey(2026)], 2)
})

// ---------------------------------------------------------------------------
check('13. slot keys are unique on every clock', () => {
  const pts = [
    cp('AUGUST', 2026, 1, '2026-08-01'),
    cp('SRC', 2026, 1, '2026-08-02'),
    cp('SRC', 2025, 1, '2025-08-02'),
    cp('MOP', 2026, 1, null),
  ]
  for (const [clock, points] of [
    ['M', [mp(2026, 1, 1)]],
    ['Q', [{ ...mp(2026, 1, 1), seq: 2 }]],
    ['B', pts],
  ] as const) {
    const { slots } = buildOverlaySlots(clock, points)
    assert.equal(new Set(slots.map((s) => s.key)).size, slots.length, clock)
  }
})

// ---------------------------------------------------------------------------
check('14. withValue counts FIGURES, not points', () => {
  const fold = buildYearOverlay('M', [
    mp(2026, 1, 5), mp(2026, 2, null), mp(2026, 3, 7), mp(2025, 4, null),
  ])
  const by = new Map(fold.series.map((s) => [s.year, s.withValue]))
  assert.equal(by.get(2026), 2)
  assert.equal(by.get(2025), 0, 'a year of blanks is still a series, with nothing in it')
})

// ---------------------------------------------------------------------------
check('15. colour and stroke are pure functions of the year', () => {
  // Same year, different neighbours — the answer may not move. This is the
  // data-viz rule "colour follows the entity, never its rank".
  const a = resolveYearStyle(2025, {})
  const b = resolveYearStyle(2025, {})
  assert.deepEqual(a, b)
  assert.equal(defaultYearColor(2024), 'var(--bw-year-1)')
  assert.equal(defaultYearColor(2025), 'var(--bw-year-2)')
  assert.equal(defaultYearColor(2026), 'var(--bw-year-3)')
  // The cycle is arithmetic on the year and wraps rather than running out.
  assert.equal(defaultYearColor(2032), defaultYearColor(2024))
  assert.equal(defaultYearColor(2016), defaultYearColor(2024))
  assert.equal(defaultYearColor(2023), 'var(--bw-year-8)')
})

// ---------------------------------------------------------------------------
check('16. three adjacent years differ in BOTH colour and stroke', () => {
  const years = [2024, 2025, 2026]
  const colors = years.map(defaultYearColor)
  const styles = years.map(defaultYearStyle)
  assert.equal(new Set(colors).size, 3)
  assert.equal(new Set(styles).size, 3, 'mono print needs the stroke to carry identity')
  assert.deepEqual(styles, ['solid', 'dashed', 'dotted'])
  // Four concurrent years still separate without colour.
  assert.equal(new Set([...years, 2027].map(defaultYearStyle)).size, 4)
  assert.equal(YEAR_DASH.solid, undefined)
  assert.notEqual(YEAR_DASH.dashed, YEAR_DASH.dotted)
  // `area` is offered but is never a default — two fills hide each other.
  assert.equal(
    [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027].some(
      (y) => defaultYearStyle(y) === 'area',
    ),
    false,
  )
})

// ---------------------------------------------------------------------------
check('17. parseYearStyles refuses anything it did not write', () => {
  assert.deepEqual(parseYearStyles(null), {})
  assert.deepEqual(parseYearStyles('not json'), {})
  assert.deepEqual(parseYearStyles('[1,2,3]'), {})
  assert.deepEqual(parseYearStyles('{"2026":{"style":"squiggly"}}'), {})
  assert.deepEqual(parseYearStyles('{"nineteen":{"style":"solid"}}'), {})
  // An arbitrary string must never reach a `style` attribute.
  assert.deepEqual(
    parseYearStyles('{"2026":{"color":"url(javascript:alert(1))"}}'),
    {},
  )
  assert.deepEqual(parseYearStyles('{"2026":{"color":"#ff8800"}}'), {
    2026: { color: '#ff8800' },
  })
  assert.deepEqual(parseYearStyles('{"2026":{"color":"var(--bw-year-5)"}}'), {
    2026: { color: 'var(--bw-year-5)' },
  })
})

// ---------------------------------------------------------------------------
check('18. a resolved style is the default unless overridden, and says which', () => {
  const plain = resolveYearStyle(2026, {})
  assert.equal(plain.color, 'var(--bw-year-3)')
  assert.equal(plain.style, 'dotted')
  assert.equal(plain.customised, false)

  const custom = resolveYearStyle(2026, { 2026: { style: 'area' } })
  assert.equal(custom.style, 'area')
  assert.equal(custom.color, 'var(--bw-year-3)', 'an unset half keeps its default')
  assert.equal(custom.customised, true)
  assert.equal(custom.dash, undefined)

  assert.equal(resolveYearStyle(2026, { 2025: { style: 'area' } }).customised, false)
})

// ---------------------------------------------------------------------------
check('19. placement is total — every point that names a slot lands in one', () => {
  const pts = [
    cp('AUGUST', 2026, 1, '2026-08-01'),
    cp('SRC', 2026, 2, '2026-08-09'),
    cp('MOP', 2026, 3, null),
    cp('DECEMBER', 2025, 4, '2025-12-01'),
  ]
  const fold = buildYearOverlay('B', pts)
  const placed = fold.rows.flatMap((r) =>
    fold.series.map((s) => r[s.dataKey]).filter((v) => v != null),
  )
  assert.equal(placed.length, pts.length)
  assert.equal(fold.collisions.length, 0)
  // A blank name names no slot and is dropped rather than bucketed.
  assert.equal(slotKeyForPoint('B', { seq: 99, name: '  ' }), null)
  assert.equal(slotKeyForPoint('B', { seq: 99, name: null }), null)
  // Case and padding do not create a second slot.
  assert.equal(slotKeyForPoint('B', { seq: 99, name: ' august ' }), 'm08')
})

// ---------------------------------------------------------------------------
check('20. the month of a start date is read, never guessed', () => {
  assert.equal(monthOfDate('2026-08-29'), 8)
  assert.equal(monthOfDate('2026-01-01'), 1)
  assert.equal(monthOfDate('2026-12-31'), 12)
  assert.equal(monthOfDate(null), null)
  assert.equal(monthOfDate(''), null)
  assert.equal(monthOfDate('August 2026'), null)
  assert.equal(monthOfDate('2026-13-01'), null)
  assert.equal(monthOfDate('2026-00-01'), null)
})

console.log(`\nAll ${passed} year-overlay checks passed.`)
