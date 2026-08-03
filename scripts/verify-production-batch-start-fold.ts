/**
 * verify-production-batch-start-fold.ts — framework-free proof that a production-batch
 * CHANGEOVER reaches the operator.
 *
 * MC's Daily Production Report marks a batch handover in the runs block's column H
 * (`ENDING` on the last output of the batch that was running, `STARTING` on the first
 * output of the new one). The worker's production apply echoes each changeover to
 * `result.reports.production.apply.production_batch_starts`. This checks the PURE
 * app-side path from there to the panel's honest findings list:
 * `lib/sync/cases-fold.ts::collectProductionBatchStarts` → `lib/sync/findings.ts`.
 * No DB, no worker, no server context.
 *
 * Asserts:
 *   1. collectProductionBatchStarts folds the channel, guarding absent / empty /
 *      pre-feature results (an ordinary run must stay silent — this is once a month).
 *   2. flattenRunFindings emits ONE `production_batch_started` finding per changeover,
 *      keyed by (date, new batch) and severity `attention` — the operator confirms the
 *      name, because the workbook never spells it out.
 *   3. The title/reason NAME the new batch, the date, and the batch it follows.
 *   4. NO cost/price key ever reaches the finding's data (the project-wide boundary).
 *   5. summarizeFindings counts it and the Claude serializer renders it.
 *   6. It coexists with the other channels — same run, one list.
 *
 * Run:  npx tsx scripts/verify-production-batch-start-fold.ts
 */
import assert from 'node:assert/strict'

import { collectProductionBatchStarts } from '../lib/sync/cases-fold'
import {
  flattenRunFindings,
  summarizeFindings,
  serializeFindingsForClaude,
} from '../lib/sync/findings'
import type { ProductionBatchStart, SyncRunResult } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

function start(overrides: Partial<ProductionBatchStart> = {}): ProductionBatchStart {
  return {
    transaction_date: '2026-08-01',
    new_batch: 'AUGUST',
    previous_batch: 'JULY',
    derivation: 'sequence',
    source_sheet: '08-01-26',
    ...overrides,
  }
}

function runWith(starts: ProductionBatchStart[]): SyncRunResult {
  return {
    reports: {
      production: {
        classify: null,
        apply: {
          report_type: 'production',
          ok: true,
          applied: { inserts: 3, updates: 0, replaced_dates: 0 },
          held: [],
          labeled: true,
          watermark_updated: true,
          errors: [],
          production_batch_starts: starts,
        },
      },
    },
  } as unknown as SyncRunResult
}

// ---------------------------------------------------------------------------
check('1. collectProductionBatchStarts folds the channel and guards every absence', () => {
  assert.deepEqual(collectProductionBatchStarts(runWith([start()])), [start()])
  assert.deepEqual(collectProductionBatchStarts(runWith([])), [])
  // pre-feature / other shapes: no field, no apply, no reports, empty result
  assert.deepEqual(
    collectProductionBatchStarts({
      reports: { production: { classify: null, apply: { held: [] } } },
    } as unknown as SyncRunResult),
    [],
  )
  assert.deepEqual(
    collectProductionBatchStarts({
      reports: { production: { classify: null, apply: null } },
    } as unknown as SyncRunResult),
    [],
  )
  assert.deepEqual(collectProductionBatchStarts({} as SyncRunResult), [])
})

// ---------------------------------------------------------------------------
check('2. ONE finding per changeover, keyed by date+batch, severity attention', () => {
  const findings = flattenRunFindings(runWith([start(), start({ transaction_date: '2026-09-01', new_batch: 'SEPTEMBER', previous_batch: 'AUGUST' })]))
  const batchStarts = findings.filter((f) => f.kind === 'production_batch_started')
  assert.equal(batchStarts.length, 2)
  assert.deepEqual(
    batchStarts.map((f) => f.key),
    ['production_batch_started:2026-08-01:AUGUST', 'production_batch_started:2026-09-01:SEPTEMBER'],
  )
  for (const f of batchStarts) {
    assert.equal(f.severity, 'attention')
    assert.equal(f.source, 'Production report')
    assert.equal(f.kindLabel, 'New production batch opened')
  }
  // An ordinary run announces nothing — this must never be noisy.
  assert.deepEqual(
    flattenRunFindings(runWith([])).filter((f) => f.kind === 'production_batch_started'),
    [],
  )
})

// ---------------------------------------------------------------------------
check('3. the title + reason name the new batch, the date, and the batch it follows', () => {
  const [f] = flattenRunFindings(runWith([start()]))
  assert.match(f.title, /2026-08-01/)
  assert.match(f.title, /AUGUST/)
  assert.equal(f.location, '2026-08-01')
  assert.match(f.reason, /JULY/)
  assert.match(f.reason, /AUGUST/)
  assert.match(f.reason, /Confirm the name/)
  assert.equal(f.data.new_batch, 'AUGUST')
  assert.equal(f.data.previous_batch, 'JULY')
  assert.equal(f.data.source_sheet, '08-01-26')

  // A cold-start derivation says so instead of claiming a sequence.
  const [cold] = flattenRunFindings(runWith([start({ derivation: 'calendar_cold_start' })]))
  assert.match(cold.reason, /nothing earlier on record/)
})

// ---------------------------------------------------------------------------
check('4. no cost/price key ever reaches the finding data', () => {
  const [f] = flattenRunFindings(runWith([start()]))
  for (const key of Object.keys(f.data)) {
    assert.ok(!/cost|price|php|peso/i.test(key), `cost-ish key leaked: ${key}`)
  }
})

// ---------------------------------------------------------------------------
check('5. summarizeFindings counts it and the Claude serializer renders it', () => {
  const findings = flattenRunFindings(runWith([start()]))
  const { total, byKind } = summarizeFindings(findings)
  assert.equal(total, 1)
  assert.equal(byKind.production_batch_started, 1)

  const text = serializeFindingsForClaude(findings, { runId: 'RUN-1', runDate: '2026-08-03', status: 'succeeded' })
  assert.match(text, /\[production_batch_started\]/)
  assert.match(text, /new production batch/) // the compact SHORT_KIND word
  assert.match(text, /new_batch=AUGUST/)
})

// ---------------------------------------------------------------------------
check('6. it coexists with the other channels in ONE list', () => {
  const result = runWith([start()]) as SyncRunResult
  result.reports!.production!.apply!.held = [
    { reason: 'malformed', natural_key: '2026-08-01 · JULY · M · runs', detail: 'bad row', kind: 'malformed' },
  ]
  const kinds = flattenRunFindings(result).map((f) => f.kind)
  assert.deepEqual(kinds, ['malformed', 'production_batch_started'])
})

console.log(`\nAll ${passed} production-batch-start-fold checks passed.`)
