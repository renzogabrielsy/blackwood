/**
 * local-summary.test.ts — coverage for `localSyncSummary` (lib/sync/local-summary.ts).
 *
 * Repo convention note: no test framework (vitest/jest) is configured at the
 * app root (see CLAUDE.md — "No test framework is configured"; only
 * `workers/sync` has its own vitest setup, a separate npm project). This file
 * uses Node's built-in test runner (`node:test` + `node:assert/strict`, both
 * ship with Node — zero new dependencies) so it can be executed today without
 * touching the root package.json.
 *
 * Written as plain CommonJS (require(), no top-level `import`/`export`
 * keywords) so Node's loader never reparses the file as ESM — ESM relative
 * specifiers must resolve to an exact file (Node won't infer `.ts` off
 * `../local-summary`), while CJS `require('../local-summary.ts')` with the
 * explicit extension resolves cleanly under Node's native TypeScript support
 * (type-stripping is unflagged as of Node 22.18+/23.6+, confirmed here on
 * v24). `NarrateInput` is pulled in as a type-only alias (`type X =
 * import(...).X`), not an `import` statement, so it never triggers ESM
 * detection or resolves the `@/...` path alias at runtime — it's erased
 * entirely by type-stripping.
 *
 * tsc note: TS5097 ("import path can only end with '.ts'") only applies to
 * ESM `import` specifiers, not `require()` calls, so this file also passes
 * `tsc --noEmit` untouched (no `allowImportingTsExtensions` needed).
 *
 * Run: node --test lib/sync/__tests__/local-summary.test.ts
 * (or: node --test lib/sync/__tests__/ to run every test in the directory)
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see file header
const { test } = require('node:test')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see file header
const assert = require('node:assert/strict')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see file header
const { localSyncSummary } = require('../local-summary.ts') as typeof import('../local-summary')

type NarrateInput = import('@/app/(app)/sync/actions').NarrateInput

function report(overrides: Partial<NarrateInput> = {}): NarrateInput {
  return {
    report_type: 'gsheet',
    ok: true,
    gate_failures: 0,
    inserts: 0,
    updates: 0,
    flagged: 0,
    held: 0,
    ...overrides,
  }
}

test('all-clean run returns the exact short-circuit string, regardless of findingsCount', () => {
  const results = [report(), report({ report_type: 'rc_out' })]
  assert.equal(
    localSyncSummary(results, 0),
    'Nothing new today. Every report was already up to date. Nothing needs your attention.',
  )
  // A clean run always short-circuits before findingsCount is consulted.
  assert.equal(
    localSyncSummary(results, 5),
    'Nothing new today. Every report was already up to date. Nothing needs your attention.',
  )
})

test('b142814b shape: classify-level flagged>0 but findingsCount=0 -> no review clause', () => {
  // production: 1 insert. flecon: 1 insert. gsheet: flagged=1 (rows_preview empty,
  // apply held=0). rc_movement_audit: flagged=1 (informational drift note, severity
  // none). flattenRunFindings(result) renders 0 findings for this run.
  const results: NarrateInput[] = [
    report({ report_type: 'production', inserts: 1 }),
    report({ report_type: 'flecon', inserts: 1 }),
    report({ report_type: 'gsheet', flagged: 1 }),
    report({ report_type: 'rc_movement_audit', flagged: 1 }),
  ]
  const summary = localSyncSummary(results, 0)
  assert.equal(summary, 'Wrote 2 new rows.')
  assert.ok(!summary.includes('review'), 'must not promise a review the panel cannot show')
  assert.ok(!summary.includes('findings below'))
})

test('findingsCount=3 renders the review clause sized to the RENDERED count, not raw totals', () => {
  // Raw classify totals (held+flagged) would be much larger than 3, but the
  // panel only rendered 3 findings — the line must say 3, not the raw total.
  const results: NarrateInput[] = [report({ report_type: 'rc_out', held: 5, flagged: 4 })]
  const summary = localSyncSummary(results, 3)
  assert.equal(summary, 'Nothing was written. 3 items need your review — see the findings below.')
})

test('findingsCount=1 uses singular "item" and "needs"', () => {
  const results: NarrateInput[] = [report({ report_type: 'rc_out', held: 1 })]
  const summary = localSyncSummary(results, 1)
  assert.equal(summary, 'Nothing was written. 1 item needs your review — see the findings below.')
})

test('gate failures still surface regardless of findingsCount', () => {
  const results: NarrateInput[] = [report({ report_type: 'deliveries', ok: false, gate_failures: 1 })]
  const summary = localSyncSummary(results, 0)
  assert.equal(summary, 'Nothing was written. 1 report failed a totals check and saved nothing — check that first.')

  const multi: NarrateInput[] = [
    report({ report_type: 'deliveries', ok: false, gate_failures: 1 }),
    report({ report_type: 'rc_out', ok: false, gate_failures: 1 }),
  ]
  assert.equal(
    localSyncSummary(multi, 0),
    'Nothing was written. 2 reports failed a totals check and saved nothing — check those first.',
  )
})

test('writes + findings compose in the stable writeLine -> gateLine -> reviewLine order', () => {
  const results: NarrateInput[] = [
    report({ report_type: 'deliveries', inserts: 3, updates: 1 }),
    report({ report_type: 'rc_out', ok: false, gate_failures: 1 }),
  ]
  const summary = localSyncSummary(results, 2)
  assert.equal(
    summary,
    'Wrote 3 new rows and 1 updated row. 1 report failed a totals check and saved nothing — check that first. 2 items need your review — see the findings below.',
  )
})
