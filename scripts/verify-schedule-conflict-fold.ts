/**
 * verify-schedule-conflict-fold.ts — framework-free proof that a production-PLAN conflict
 * (the sync withheld an upstream value because a human owns the day) reaches the operator.
 *
 * The worker's Stage 3c writes them to `result.reconciliation.schedule_conflicts`. This
 * checks the PURE app-side path from there to the panel's honest findings list:
 * `lib/sync/cases-fold.ts::collectScheduleConflicts` → `lib/sync/findings.ts`. No DB, no
 * worker, no server context.
 *
 * Asserts:
 *   1. collectScheduleConflicts folds the channel, guarding absent / empty / pre-feature.
 *   2. flattenRunFindings emits ONE `schedule_conflict` finding per parked day, keyed by
 *      the date (stable, safe as a React key) and severity `attention` — never auto-resolved.
 *   3. The reason text is PLAIN and names the actual before/after values.
 *   4. NO ₱/cost key ever appears in the finding's data (the project-wide price boundary).
 *   5. summarizeFindings counts it, and the Claude serializer renders it.
 *   6. It coexists with the other channels (held rows, block diffs) — same run, one list.
 *
 * Run:  npx tsx scripts/verify-schedule-conflict-fold.ts
 */
import assert from 'node:assert/strict'

import { collectScheduleConflicts } from '../lib/sync/cases-fold'
import {
  flattenRunFindings,
  summarizeFindings,
  serializeFindingsForClaude,
} from '../lib/sync/findings'
import type { ScheduleConflict, SyncRunResult } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const REV = 'joseph:REV6|gm1234.9|3f21aa90bb01'

function conflict(plan_date = '2026-08-03'): ScheduleConflict {
  return {
    plan_date,
    source_rev: REV,
    changed_fields: ['shifts', 'setup'],
    current: {
      shifts: 2,
      setup: '3X50 / 6X50',
      projected_tons: 30,
      grades: { '3X50': 30 },
      remarks: 'Renzo: double shift, customer pull-in',
    },
    proposed: {
      shifts: 0,
      setup: null,
      projected_tons: 0,
      grades: null,
      remarks: 'Sunday (per Joseph REV#6)',
    },
  }
}

function runWith(conflicts: ScheduleConflict[]): SyncRunResult {
  return { reports: {}, reconciliation: { schedule_conflicts: conflicts } } as SyncRunResult
}

// ---------------------------------------------------------------------------
check('1. collectScheduleConflicts folds the channel and guards every absence', () => {
  assert.deepEqual(collectScheduleConflicts(runWith([conflict()])), [conflict()])
  assert.deepEqual(collectScheduleConflicts(runWith([])), [])
  // pre-feature runs: no schedule_conflicts key, no reconciliation key, empty result
  assert.deepEqual(
    collectScheduleConflicts({ reports: {}, reconciliation: {} } as SyncRunResult),
    [],
  )
  assert.deepEqual(collectScheduleConflicts({ reports: {} } as SyncRunResult), [])
  assert.deepEqual(collectScheduleConflicts({} as SyncRunResult), [])
})

check('2. one finding per parked day, keyed by date, severity attention', () => {
  const findings = flattenRunFindings(runWith([conflict('2026-08-03'), conflict('2026-08-10')]))
  const sched = findings.filter((f) => f.kind === 'schedule_conflict')
  assert.equal(sched.length, 2)
  assert.deepEqual(
    sched.map((f) => f.key),
    ['schedule_conflict:2026-08-03', 'schedule_conflict:2026-08-10'],
  )
  for (const f of sched) {
    assert.equal(f.severity, 'attention')
    assert.equal(f.source, 'Production schedule (Joseph Go)')
    assert.equal(f.kindLabel, 'Schedule day you edited — the plan email disagrees')
  }
  assert.equal(sched[0].location, '2026-08-03')
  // keys are stable across calls (React-key safe)
  assert.deepEqual(
    flattenRunFindings(runWith([conflict('2026-08-03')])).map((f) => f.key),
    ['schedule_conflict:2026-08-03'],
  )
})

check('3. the reason is plain and names the real before/after values', () => {
  const f = flattenRunFindings(runWith([conflict()]))[0]
  assert.match(f.reason, /You edited this day in the app/)
  assert.match(f.reason, /did NOT overwrite/)
  assert.match(f.reason, /shifts 2 → 0/)
  assert.match(f.reason, /line setup 3X50 \/ 6X50 → none/)
  assert.match(f.reason, /pick which one stands/)
  // the title says which fields, in plain words — never column names
  assert.match(f.title, /shifts and line setup/)
  assert.ok(!/projected_tons|plan_date|source_rev/.test(f.title), f.title)
})

check('4. no cost/price key ever reaches the finding data', () => {
  const f = flattenRunFindings(runWith([conflict()]))[0]
  const blob = JSON.stringify(f.data).toLowerCase()
  for (const banned of ['cost', 'price', 'php', 'peso', '₱']) {
    assert.ok(!blob.includes(banned), `finding data leaked "${banned}": ${blob}`)
  }
  // the useful payload IS there
  assert.equal((f.data as Record<string, unknown>).plan_date, '2026-08-03')
  assert.equal((f.data as Record<string, unknown>).source_rev, REV)
  assert.deepEqual((f.data as Record<string, unknown>).changed_fields, ['shifts', 'setup'])
})

check('5. summarize counts it and the Claude serializer renders it', () => {
  const findings = flattenRunFindings(runWith([conflict('2026-08-03'), conflict('2026-08-10')]))
  const { total, byKind } = summarizeFindings(findings)
  assert.equal(total, 2)
  assert.equal(byKind.schedule_conflict, 2)

  const text = serializeFindingsForClaude(findings, {
    runId: 'run_test',
    runDate: '2026-08-01',
    status: 'succeeded',
  })
  assert.match(text, /2 schedule day held/)
  assert.match(text, /\[schedule_conflict\]/)
  assert.match(text, /2026-08-10/)
})

check('6. it coexists with the other reconciliation channels in ONE list', () => {
  const result = {
    reports: {
      gsheet: {
        apply: {
          held: [
            {
              natural_key: '2026-08-01|A-1|JULY-26-BLK1',
              kind: 'unmapped_batch_code',
              reason: 'no such batch',
              row: { batch_code: 'JULY-26-BLK1', transaction_date: '2026-08-01' },
            },
          ],
        },
      },
    },
    reconciliation: {
      schedule_conflicts: [conflict()],
      batch_closes: [
        {
          batch_code: 'JUNE-26-BLK4',
          location_ref: 'A-4',
          transaction_date: '2026-08-01',
          block_loc: 'A-4',
          source_row: 12,
          matched: true,
        },
      ],
    },
  } as unknown as SyncRunResult

  const kinds = flattenRunFindings(result).map((f) => f.kind)
  assert.deepEqual(kinds, ['unmapped_batch_code', 'batch_closed', 'schedule_conflict'])
  assert.equal(summarizeFindings(flattenRunFindings(result)).total, 3)
})

console.log(`\nAll ${passed} schedule-conflict-fold checks passed.`)
