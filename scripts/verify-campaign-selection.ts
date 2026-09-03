/**
 * verify-campaign-selection.ts — framework-free proof that the analytics campaign
 * table's TWO dropdowns (owner feedback R8) are a presentation of ONE selection.
 *
 * Renzo, 2026-09-03: *"In by production batch table, change how the batches drop down
 * filter work from checking every known batch to separating this into two drop downs:
 * one for years and one for the batches without the year. Currently it lists all 32
 * batches in one drop down."*
 *
 * The risk the split introduces is a SECOND source of truth. There is none: `?bhide=`
 * still holds `campaignLabel` keys, `lib/analytics/period-selection.ts` is untouched,
 * and both checklists are DERIVED from that set on every render. What follows proves
 * that derivation is total and invertible, and that touching one control never quietly
 * rewrites what the other one said.
 *
 * Asserts:
 *   1. An empty hidden set means EVERY year and EVERY name is ticked — the default view
 *      is unchanged, which is the whole "always default to checking all" property.
 *   2. Years arrive in the payload's own chronological order; names sort JANUARY →
 *      DECEMBER by `campaignSeq`, with a non-month name after the twelve, never
 *      alphabetically.
 *   3. The name list holds only the names inside the SELECTED years — the feature.
 *   4. Unticking a year hides exactly that year's campaign labels and nothing else.
 *   5. Ticking a year back returns it WHOLE.
 *   6. A name that ran in two selected years toggles BOTH columns.
 *   7. A name toggle NEVER touches a campaign in a switched-off year.
 *   8. Rule 1 — a control reads unticked only when EVERY column it stands for is hidden.
 *   9. Rule 2 — a toggle is applied as a DIFF: touching the year control preserves the
 *      per-batch picks made in the years that did not move.
 *  10. `All` / `None` (the wholesale sets the checklist hands back) go through the same
 *      one code path and round-trip exactly.
 *  11. The split needs no string parsing: `campaignLabel` is carried, never rebuilt, and
 *      a label that does not equal "<name> <year>" still selects correctly.
 *
 * Run:  npx tsx scripts/verify-campaign-selection.ts
 */
import assert from 'node:assert/strict'

import {
  applyNameSelection,
  applyYearSelection,
  groupCampaignNames,
  groupCampaignYears,
  hiddenNameKeys,
  hiddenYearKeys,
  shownYearSet,
  yearKey,
  type CampaignSelectable,
} from '../lib/analytics/campaign-selection'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

function c(productionBatch: string, campaignYear: number, label?: string): CampaignSelectable {
  return {
    productionBatch,
    campaignYear,
    campaignLabel: label ?? `${productionBatch} ${campaignYear}`,
  }
}

/**
 * The real shape, in miniature: two years that share two month names, one name that
 * exists in a single year, and one name that is not one of the twelve months.
 */
const CAMPAIGNS: CampaignSelectable[] = [
  c('NOVEMBER', 2025),
  c('DECEMBER', 2025),
  c('JANUARY', 2026),
  c('FEBRUARY', 2026),
  c('NOVEMBER', 2026),
  c('TRIAL', 2026),
]

const NONE: ReadonlySet<string> = new Set<string>()

const labels = (hidden: ReadonlySet<string>) => [...hidden].sort()

// ---------------------------------------------------------------------------
check('1. an empty hidden set ticks every year and every name (default unchanged)', () => {
  const years = groupCampaignYears(CAMPAIGNS, NONE)
  const names = groupCampaignNames(CAMPAIGNS, NONE, shownYearSet(years))
  assert.deepEqual(years.map((y) => y.id), [2025, 2026])
  assert.ok(years.every((y) => y.checked))
  assert.ok(names.every((n) => n.checked))
  assert.equal(hiddenYearKeys(years).size, 0)
  assert.equal(hiddenNameKeys(names).size, 0)
  // Six campaigns, five distinct names — the list really is shorter than the columns.
  assert.equal(names.length, 5)
})

// ---------------------------------------------------------------------------
check('2. years keep payload order; names sort by month, non-month last', () => {
  const years = groupCampaignYears(CAMPAIGNS, NONE)
  assert.deepEqual(years.map((y) => y.id), [2025, 2026])
  const names = groupCampaignNames(CAMPAIGNS, NONE, shownYearSet(years))
  assert.deepEqual(names.map((n) => n.id), [
    'JANUARY',
    'FEBRUARY',
    'NOVEMBER',
    'DECEMBER',
    'TRIAL',
  ])
  // Alphabetical — the obvious bug — would have put DECEMBER first and TRIAL fourth.
  assert.notDeepEqual(
    names.map((n) => n.id),
    [...names.map((n) => n.id)].sort(),
  )
})

// ---------------------------------------------------------------------------
check('3. the name list holds only the names inside the selected years', () => {
  const hidden = new Set(['NOVEMBER 2025', 'DECEMBER 2025']) // all of 2025 off
  const years = groupCampaignYears(CAMPAIGNS, hidden)
  assert.deepEqual(
    years.map((y) => [y.id, y.checked]),
    [[2025, false], [2026, true]],
  )
  const names = groupCampaignNames(CAMPAIGNS, hidden, shownYearSet(years))
  assert.deepEqual(names.map((n) => n.id), ['JANUARY', 'FEBRUARY', 'NOVEMBER', 'TRIAL'])
  // DECEMBER existed only in the switched-off year, so it left the list entirely.
  assert.ok(!names.some((n) => n.id === 'DECEMBER'))
  // NOVEMBER survived because 2026 also has one — and now stands for ONE column.
  assert.equal(names.find((n) => n.id === 'NOVEMBER')!.campaigns.length, 1)
})

// ---------------------------------------------------------------------------
check('4. unticking a year hides exactly that year’s labels', () => {
  const years = groupCampaignYears(CAMPAIGNS, NONE)
  const next = applyYearSelection(years, NONE, new Set([yearKey(2025)]))
  assert.deepEqual(labels(next), ['DECEMBER 2025', 'NOVEMBER 2025'])
})

// ---------------------------------------------------------------------------
check('5. ticking a year back returns it whole', () => {
  const hidden = new Set(['NOVEMBER 2025', 'DECEMBER 2025'])
  const years = groupCampaignYears(CAMPAIGNS, hidden)
  const next = applyYearSelection(years, hidden, NONE)
  assert.equal(next.size, 0)
})

// ---------------------------------------------------------------------------
check('6. a name in two selected years toggles BOTH columns', () => {
  const years = groupCampaignYears(CAMPAIGNS, NONE)
  const names = groupCampaignNames(CAMPAIGNS, NONE, shownYearSet(years))
  const next = applyNameSelection(names, NONE, new Set(['NOVEMBER']))
  assert.deepEqual(labels(next), ['NOVEMBER 2025', 'NOVEMBER 2026'])
})

// ---------------------------------------------------------------------------
check('7. a name toggle never touches a campaign in a switched-off year', () => {
  const hidden = new Set(['NOVEMBER 2025', 'DECEMBER 2025']) // 2025 off
  const years = groupCampaignYears(CAMPAIGNS, hidden)
  const names = groupCampaignNames(CAMPAIGNS, hidden, shownYearSet(years))
  // Untick NOVEMBER while only 2026 is on screen: 2026's column goes, 2025's stays
  // hidden because the YEAR hid it — the two reasons never get confused.
  const off = applyNameSelection(names, hidden, new Set(['NOVEMBER']))
  assert.deepEqual(labels(off), ['DECEMBER 2025', 'NOVEMBER 2025', 'NOVEMBER 2026'])
  // And ticking it back on cannot resurrect 2025's column out of a hidden year.
  const years2 = groupCampaignYears(CAMPAIGNS, off)
  const names2 = groupCampaignNames(CAMPAIGNS, off, shownYearSet(years2))
  const back = applyNameSelection(names2, off, NONE)
  assert.deepEqual(labels(back), ['DECEMBER 2025', 'NOVEMBER 2025'])
})

// ---------------------------------------------------------------------------
check('8. a control reads unticked only when EVERY column it stands for is hidden', () => {
  // One of 2025's two campaigns hidden — the year is still showing.
  const partial = new Set(['NOVEMBER 2025'])
  const years = groupCampaignYears(CAMPAIGNS, partial)
  const y2025 = years.find((y) => y.id === 2025)!
  assert.equal(y2025.checked, true)
  assert.equal(y2025.shownCount, 1)
  assert.equal(hiddenYearKeys(years).size, 0)
  // The NAME is fully hidden in one year but not the other — still ticked.
  const names = groupCampaignNames(CAMPAIGNS, partial, shownYearSet(years))
  const nov = names.find((n) => n.id === 'NOVEMBER')!
  assert.equal(nov.checked, true)
  assert.equal(nov.shownCount, 1)
  // Hide the second one and only then does it read off.
  const both = new Set(['NOVEMBER 2025', 'NOVEMBER 2026'])
  const names2 = groupCampaignNames(CAMPAIGNS, both, shownYearSet(groupCampaignYears(CAMPAIGNS, both)))
  assert.equal(names2.find((n) => n.id === 'NOVEMBER')!.checked, false)
  assert.deepEqual([...hiddenNameKeys(names2)], ['NOVEMBER'])
})

// ---------------------------------------------------------------------------
check('9. a year toggle preserves the per-batch picks in the years that did not move', () => {
  // The reader hides JANUARY 2026 by name, then switches 2025 off and on again.
  const hidden = new Set(['JANUARY 2026'])
  const years = groupCampaignYears(CAMPAIGNS, hidden)
  const off = applyYearSelection(years, hidden, new Set([yearKey(2025)]))
  assert.deepEqual(labels(off), ['DECEMBER 2025', 'JANUARY 2026', 'NOVEMBER 2025'])
  const years2 = groupCampaignYears(CAMPAIGNS, off)
  const on = applyYearSelection(years2, off, NONE)
  // 2025 came back whole; JANUARY 2026 is STILL hidden — an absolute rewrite would
  // have silently restored it, which is the "my filter reset itself" bug.
  assert.deepEqual(labels(on), ['JANUARY 2026'])
})

// ---------------------------------------------------------------------------
check('10. All / None round-trip through the same one code path', () => {
  const years = groupCampaignYears(CAMPAIGNS, NONE)
  // "None" on the year control = every year key hidden = every column hidden.
  const all = applyYearSelection(years, NONE, new Set(years.map((y) => yearKey(y.id))))
  assert.deepEqual(labels(all), CAMPAIGNS.map((x) => x.campaignLabel).sort())
  // With everything hidden the name list is empty — there are no shown years.
  const years2 = groupCampaignYears(CAMPAIGNS, all)
  assert.equal(shownYearSet(years2).size, 0)
  assert.equal(groupCampaignNames(CAMPAIGNS, all, shownYearSet(years2)).length, 0)
  // "All" puts it straight back.
  assert.equal(applyYearSelection(years2, all, NONE).size, 0)
})

// ---------------------------------------------------------------------------
check('11. the label is carried, never rebuilt from name + year', () => {
  // A label SQL spells differently from "<name> <year>" must still select exactly.
  const odd = [c('AUGUST', 2026, 'AUG-26 CAMPAIGN'), c('AUGUST', 2025)]
  const years = groupCampaignYears(odd, NONE)
  const names = groupCampaignNames(odd, NONE, shownYearSet(years))
  const next = applyNameSelection(names, NONE, new Set(['AUGUST']))
  assert.deepEqual(labels(next), ['AUG-26 CAMPAIGN', 'AUGUST 2025'])
  // And a year toggle keys on the same carried label.
  const y = applyYearSelection(years, NONE, new Set([yearKey(2026)]))
  assert.deepEqual(labels(y), ['AUG-26 CAMPAIGN'])
})

console.log(`\nAll ${passed} campaign-selection checks passed.`)
