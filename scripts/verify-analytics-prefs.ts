/**
 * verify-analytics-prefs.ts — framework-free proof that the /analytics per-user
 * preference record (owner feedback R10) is safe to READ, safe to RESTORE and
 * incapable of losing what a reader already set.
 *
 * Renzo, 2026-09-03: *"Currently, the style selections for the charts in
 * analytics has no sense of memory or permanence when it comes to user
 * selection. Every choice is made back to default when switching around
 * different charts and rows and from a refresh. I would much rather it
 * remembers the last settings used per user."*
 *
 * The risk in remembering anything is that the remembered value is now an INPUT
 * — it arrives from `localStorage` or from a jsonb column, it may have been
 * written by an older build, and on this page one of its fields goes straight
 * into a `style` attribute. So everything below is about the value's journey
 * rather than about the feature: parse it without trusting it, prune it without
 * losing it, migrate the old keys without overwriting anything, and make
 * "default" and "never chosen" the same state so a Reset is total.
 *
 * Asserts:
 *   1. Absent, empty, malformed and hostile inputs all yield EXACTLY the
 *      shipped defaults, and nothing throws.
 *   2. Rule 4 — a defaulted record serialises to `{}`, so "never chosen" and
 *      "chose the defaults" are one state and Reset leaves nothing behind.
 *   3. A fully customised record round-trips through serialise → parse
 *      unchanged, and does so identically whether it re-enters as a STRING
 *      (localStorage) or as an OBJECT (the jsonb column) — one door, one result.
 *   4. `expandHiddenYears` — `null` (never chosen, smart default applies) and
 *      `[]` (the reader wants every year) survive as DIFFERENT values through a
 *      full round trip. The NULL ≠ 0 rule, in a checklist.
 *   5. A year style is validated field by field: a palette token and a plain
 *      `#rrggbb` survive; an arbitrary string, a `url(...)` payload, a bad
 *      stroke name and a non-year key are all DROPPED, not carried.
 *   6. `comparison` accepts only its two literals; anything else is the default.
 *   7. Booleans accept only booleans — `"true"`, `1` and `null` are the default,
 *      never coerced.
 *   8. `rowOrder` drops a junk scope, drops junk keys, de-duplicates, and is
 *      bounded — a hostile store cannot become a large render.
 *   9. `pruneAnalyticsPrefs` drops years the payload no longer carries from BOTH
 *      the hidden set and the palette, keeps every year it still carries, and
 *      touches nothing else.
 *  10. Prune returns the SAME REFERENCE when nothing moved (so a clean record
 *      never writes) and is a no-op when the year list is empty (so a page that
 *      has not loaded yet cannot wipe a preference).
 *  11. The legacy fold reads R9's year-style key and BOTH row-order prefixes,
 *      prefers v2 over v1 for one scope, and ignores every unrelated key.
 *  12. The legacy fold of a browser with nothing in it IS the default, which is
 *      what lets the store use `isDefaultPrefs` to decide whether to adopt it.
 *  13. `isDefaultPrefs` is false for each single deviation, one field at a time.
 *  14. `chooseStoredPrefs` prefers the LOCAL copy, falls back to the remote one,
 *      and yields the defaults when neither exists.
 *  15. A saved row order can never hide a row added later, nor resurrect one
 *      that has gone — the `resolveOrder` contract, restated over a value that
 *      came out of this parser.
 *
 * Run:  npx tsx scripts/verify-analytics-prefs.ts
 */
import assert from 'node:assert/strict'

import {
  ANALYTICS_PREFS_KEY,
  ANALYTICS_PREFS_MODULE,
  DEFAULT_ANALYTICS_PREFS,
  LEGACY_ROW_ORDER_PREFIX,
  LEGACY_ROW_ORDER_PREFIX_V1,
  LEGACY_YEAR_STYLE_KEY,
  chooseStoredPrefs,
  isDefaultPrefs,
  migrateLegacyPrefs,
  parseAnalyticsPrefs,
  pruneAnalyticsPrefs,
  serializeAnalyticsPrefs,
  type AnalyticsPrefs,
} from '../lib/analytics/prefs'
import { resolveOrder } from '../lib/analytics/row-order'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** Serialise then read back the way the browser and the database both do. */
function roundTrip(p: AnalyticsPrefs): AnalyticsPrefs {
  return parseAnalyticsPrefs(JSON.stringify(serializeAnalyticsPrefs(p)))
}

const CUSTOM: AnalyticsPrefs = {
  yearStyles: {
    '2024': { color: '#ff8800', style: 'dashed' },
    '2026': { style: 'area' },
  },
  expandHiddenYears: ['2020', '2021'],
  showOverlay: true,
  showAvg: false,
  comparison: 'actual',
  perWorkingDay: true,
  showDictionary: false,
  rowOrder: { 'metrics:flow': ['usage', 'purchase_volume'] },
}

console.log('\nverify-analytics-prefs — the /analytics per-user settings record\n')

// ── 1 ───────────────────────────────────────────────────────────────────────
check('garbage in is the defaults out, and nothing throws', () => {
  const junk: unknown[] = [
    null,
    undefined,
    '',
    'not json',
    '[1,2,3]',
    '"a string"',
    '42',
    [],
    42,
    { yearStyles: 'nope', rowOrder: 7, expandHiddenYears: 'all' },
  ]
  for (const raw of junk) {
    const p = parseAnalyticsPrefs(raw)
    assert.deepEqual(p, DEFAULT_ANALYTICS_PREFS, `input ${JSON.stringify(raw)}`)
    assert.equal(isDefaultPrefs(p), true)
  }
})

// ── 2 ───────────────────────────────────────────────────────────────────────
check('a defaulted record serialises to {} — Reset leaves nothing behind', () => {
  assert.deepEqual(serializeAnalyticsPrefs(DEFAULT_ANALYTICS_PREFS), {})
  assert.deepEqual(roundTrip(DEFAULT_ANALYTICS_PREFS), DEFAULT_ANALYTICS_PREFS)
  // The two constants the store writes under, pinned so a rename is deliberate.
  assert.equal(ANALYTICS_PREFS_KEY, 'bw.analytics.prefs.v1')
  assert.equal(ANALYTICS_PREFS_MODULE, 'analytics')
})

// ── 3 ───────────────────────────────────────────────────────────────────────
check('a customised record round-trips, by string AND by object, identically', () => {
  assert.deepEqual(roundTrip(CUSTOM), CUSTOM)
  const asObject = parseAnalyticsPrefs(serializeAnalyticsPrefs(CUSTOM))
  assert.deepEqual(asObject, CUSTOM)
  assert.deepEqual(asObject, roundTrip(CUSTOM))
})

// ── 4 ───────────────────────────────────────────────────────────────────────
check('expandHiddenYears — null and [] survive as different answers', () => {
  const never = roundTrip({ ...DEFAULT_ANALYTICS_PREFS, expandHiddenYears: null })
  assert.equal(never.expandHiddenYears, null)
  assert.equal('expandHiddenYears' in serializeAnalyticsPrefs(never), false)

  const showAll = roundTrip({ ...DEFAULT_ANALYTICS_PREFS, expandHiddenYears: [] })
  assert.notEqual(showAll.expandHiddenYears, null)
  assert.deepEqual(showAll.expandHiddenYears, [])
  // And "show me all of them" is NOT the default record, so Reset can undo it.
  assert.equal(isDefaultPrefs(showAll), false)
})

// ── 5 ───────────────────────────────────────────────────────────────────────
check('a year style is validated field by field; anything unrecognised is dropped', () => {
  const p = parseAnalyticsPrefs({
    yearStyles: {
      '2024': { color: 'var(--bw-year-3)', style: 'dotted' }, // palette token — kept
      '2025': { color: '#0a1B2c' },                            // plain hex — kept
      '2026': { color: 'url(javascript:alert(1))' },           // hostile — dropped
      '2027': { color: 'red' },                                // not a token — dropped
      '2028': { style: 'squiggle' },                           // not a stroke — dropped
      '20244': { color: '#ffffff' },                           // not a year key — dropped
      abc: { color: '#ffffff' },                               // not a year key — dropped
      '2029': 'not an object',                                 // wrong shape — dropped
    },
  })
  assert.deepEqual(Object.keys(p.yearStyles).sort(), ['2024', '2025'])
  assert.deepEqual(p.yearStyles['2024'], { color: 'var(--bw-year-3)', style: 'dotted' })
  assert.deepEqual(p.yearStyles['2025'], { color: '#0a1B2c' })
  // Nothing hostile reaches the record, so nothing hostile reaches a `style`.
  assert.equal(JSON.stringify(p.yearStyles).includes('javascript'), false)
})

// ── 6 ───────────────────────────────────────────────────────────────────────
check('comparison accepts only its two literals', () => {
  assert.equal(parseAnalyticsPrefs({ comparison: 'actual' }).comparison, 'actual')
  assert.equal(parseAnalyticsPrefs({ comparison: 'yoy' }).comparison, 'yoy')
  for (const bad of ['ACTUAL', 'delta', '', 0, null, {}]) {
    assert.equal(parseAnalyticsPrefs({ comparison: bad }).comparison, 'yoy', `bad ${String(bad)}`)
  }
})

// ── 7 ───────────────────────────────────────────────────────────────────────
check('booleans are booleans — no coercion of "true", 1 or null', () => {
  assert.equal(parseAnalyticsPrefs({ showAvg: false }).showAvg, false)
  assert.equal(parseAnalyticsPrefs({ showOverlay: true }).showOverlay, true)
  for (const bad of ['true', 1, 'false', 0, null, []]) {
    const p = parseAnalyticsPrefs({ showAvg: bad, showOverlay: bad, perWorkingDay: bad, showDictionary: bad })
    assert.equal(p.showAvg, true, `showAvg default for ${String(bad)}`)
    assert.equal(p.showOverlay, false)
    assert.equal(p.perWorkingDay, false)
    assert.equal(p.showDictionary, true)
  }
})

// ── 8 ───────────────────────────────────────────────────────────────────────
check('rowOrder drops junk scopes and keys, de-duplicates, and is bounded', () => {
  const p = parseAnalyticsPrefs({
    rowOrder: {
      'metrics:flow': ['usage', 'usage', 'purchase_volume'],   // de-duplicated
      'bad scope!': ['usage'],                                  // scope rejected
      'metrics:empty': [],                                      // nothing to say — dropped
      'metrics:junk': ['ok_key', 42, { a: 1 }, '<script>'],     // junk keys dropped
      'metrics:notarray': 'usage',                              // wrong shape — dropped
    },
  })
  assert.deepEqual(Object.keys(p.rowOrder).sort(), ['metrics:flow', 'metrics:junk'])
  assert.deepEqual(p.rowOrder['metrics:flow'], ['usage', 'purchase_volume'])
  assert.deepEqual(p.rowOrder['metrics:junk'], ['ok_key'])

  const huge = parseAnalyticsPrefs({
    expandHiddenYears: Array.from({ length: 500 }, (_, i) => String(1600 + i)),
    rowOrder: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`metrics:s${i}`, ['a', 'b']]),
    ),
  })
  assert.ok((huge.expandHiddenYears ?? []).length <= 64, 'years capped')
  assert.ok(Object.keys(huge.rowOrder).length <= 32, 'scopes capped')
})

// ── 9 ───────────────────────────────────────────────────────────────────────
check('prune drops years the payload no longer carries — from BOTH the set and the palette', () => {
  const stale: AnalyticsPrefs = {
    ...CUSTOM,
    yearStyles: { '2024': { style: 'dashed' }, '1999': { color: '#ffffff' } },
    expandHiddenYears: ['2020', '1999', '2024'],
  }
  const pruned = pruneAnalyticsPrefs(stale, [2020, 2024, 2025, 2026])
  assert.deepEqual(Object.keys(pruned.yearStyles), ['2024'])
  assert.deepEqual(pruned.expandHiddenYears, ['2020', '2024'])
  // Everything that is not a year is untouched, byte for byte.
  assert.deepEqual(pruned.rowOrder, stale.rowOrder)
  assert.equal(pruned.showAvg, stale.showAvg)
  assert.equal(pruned.comparison, stale.comparison)
  assert.equal(pruned.perWorkingDay, stale.perWorkingDay)
  assert.equal(pruned.showDictionary, stale.showDictionary)
  assert.equal(pruned.showOverlay, stale.showOverlay)
  // A year the reader has never mentioned is simply not mentioned — a new year
  // can never arrive pre-hidden.
  assert.equal((pruned.expandHiddenYears ?? []).includes('2025'), false)
})

// ── 10 ──────────────────────────────────────────────────────────────────────
check('prune is referentially identical when nothing moved, and a no-op with no years', () => {
  const clean: AnalyticsPrefs = {
    ...DEFAULT_ANALYTICS_PREFS,
    yearStyles: { '2025': { style: 'dotted' } },
    expandHiddenYears: ['2024'],
  }
  assert.equal(pruneAnalyticsPrefs(clean, [2024, 2025, 2026]), clean, 'same reference')
  // An empty year list means the page has not loaded its data — it must never
  // be read as "no year exists any more".
  assert.equal(pruneAnalyticsPrefs(clean, []), clean)
  // `null` (never chosen) survives pruning as `null`, not as `[]`.
  const never = pruneAnalyticsPrefs({ ...clean, expandHiddenYears: null }, [2025])
  assert.equal(never.expandHiddenYears, null)
})

// ── 11 ──────────────────────────────────────────────────────────────────────
check('the legacy fold reads R9 styles and BOTH row-order prefixes, v2 winning', () => {
  const folded = migrateLegacyPrefs([
    [LEGACY_YEAR_STYLE_KEY, JSON.stringify({ '2025': { color: '#123456', style: 'area' } })],
    [`${LEGACY_ROW_ORDER_PREFIX}metrics:flow`, JSON.stringify(['usage', 'purchase_volume'])],
    [`${LEGACY_ROW_ORDER_PREFIX_V1}metrics:flow`, JSON.stringify(['stock_age', 'over_120d'])],
    [`${LEGACY_ROW_ORDER_PREFIX_V1}metrics:campaigns`, JSON.stringify(['yield', 'produced'])],
    ['rc_in_table_settings', '{"fontSize":12}'],            // another module — ignored
    ['bw.analytics.roworder.v2.bad scope!', '["usage"]'],   // junk scope — ignored
    ['theme', 'dark'],                                      // unrelated — ignored
    [`${LEGACY_ROW_ORDER_PREFIX}metrics:broken`, 'not json'], // unparseable — ignored
  ])
  assert.deepEqual(folded.yearStyles, { '2025': { color: '#123456', style: 'area' } })
  assert.deepEqual(Object.keys(folded.rowOrder).sort(), ['metrics:campaigns', 'metrics:flow'])
  assert.deepEqual(folded.rowOrder['metrics:flow'], ['usage', 'purchase_volume'], 'v2 wins')
  assert.deepEqual(folded.rowOrder['metrics:campaigns'], ['yield', 'produced'], 'v1 kept where v2 is silent')
  // The fold only ever ADDS what was already set — it invents no toggle.
  assert.equal(folded.showAvg, DEFAULT_ANALYTICS_PREFS.showAvg)
  assert.equal(folded.comparison, DEFAULT_ANALYTICS_PREFS.comparison)
  assert.equal(folded.expandHiddenYears, null)
  // And what it produces survives the wire.
  assert.deepEqual(roundTrip(folded), folded)
})

// ── 12 ──────────────────────────────────────────────────────────────────────
check('a browser with no legacy keys folds to exactly the defaults', () => {
  assert.equal(isDefaultPrefs(migrateLegacyPrefs([])), true)
  assert.equal(isDefaultPrefs(migrateLegacyPrefs([['theme', 'dark'], ['x', '1']])), true)
  // Which is precisely the test the store uses to decide not to adopt it.
  assert.deepEqual(migrateLegacyPrefs([]), DEFAULT_ANALYTICS_PREFS)
})

// ── 13 ──────────────────────────────────────────────────────────────────────
check('isDefaultPrefs is false for each single deviation, one field at a time', () => {
  const deviations: Partial<AnalyticsPrefs>[] = [
    { yearStyles: { '2024': { style: 'dotted' } } },
    { expandHiddenYears: [] },
    { expandHiddenYears: ['2020'] },
    { showOverlay: true },
    { showAvg: false },
    { comparison: 'actual' },
    { perWorkingDay: true },
    { showDictionary: false },
    { rowOrder: { 'metrics:flow': ['usage'] } },
  ]
  for (const d of deviations) {
    assert.equal(isDefaultPrefs({ ...DEFAULT_ANALYTICS_PREFS, ...d }), false, JSON.stringify(d))
  }
  // An EMPTY year-style entry is not a customisation — it serialises away.
  assert.equal(isDefaultPrefs({ ...DEFAULT_ANALYTICS_PREFS, yearStyles: { '2024': {} } }), true)
  assert.equal(isDefaultPrefs(DEFAULT_ANALYTICS_PREFS), true)
})

// ── 14 ──────────────────────────────────────────────────────────────────────
check('chooseStoredPrefs prefers local, falls back to remote, then to defaults', () => {
  const local = { ...DEFAULT_ANALYTICS_PREFS, showAvg: false }
  const remote = { ...DEFAULT_ANALYTICS_PREFS, showAvg: true, perWorkingDay: true }
  assert.equal(chooseStoredPrefs(local, remote), local)
  assert.equal(chooseStoredPrefs(null, remote), remote)
  assert.deepEqual(chooseStoredPrefs(null, null), DEFAULT_ANALYTICS_PREFS)
})

// ── 15 ──────────────────────────────────────────────────────────────────────
check('a stored row order can neither hide a new row nor resurrect a retired one', () => {
  const stored = parseAnalyticsPrefs({
    rowOrder: { 'metrics:flow': ['usage', 'stock_age', 'purchase_volume'] },
  }).rowOrder['metrics:flow']
  // `stock_age` was retired in R7; `runway` is newer than the save.
  const registry = ['purchase_volume', 'usage', 'net_flow', 'runway']
  const order = resolveOrder(registry, stored)
  assert.deepEqual(order, ['usage', 'purchase_volume', 'net_flow', 'runway'])
  assert.equal(order.includes('stock_age'), false, 'retired row not resurrected')
  assert.equal(order.length, registry.length, 'every registry row present exactly once')
  assert.deepEqual([...order].sort(), [...registry].sort())
})

console.log(`\n${passed} checks passed.\n`)
