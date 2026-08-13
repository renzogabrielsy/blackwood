/**
 * verify-awaiting-batch-assignment-fold.ts — framework-free proof that a delivery weighed
 * in with NO PILE ASSIGNED YET reaches the operator as "waiting on you", not as an error.
 *
 * The defect (L-042, 2026-08-13): `classify_deliveries` sent any row missing
 * `transaction_date` / `batch_code` / `weight_kg` to MALFORMED, whose operator-facing label
 * is "Row could not be read". MC books overnight weights in early with only the truck plate,
 * the weight and the moisture and assigns the pile later in the day, so two perfectly normal
 * rows were reported malformed on 2026-08-12 and had filled themselves in by morning. Crying
 * wolf about a self-clearing stage of someone's day is how a findings list stops being read.
 *
 * This checks the PURE app-side path from the worker's new channel to the panel's honest
 * findings list: `lib/sync/cases-fold.ts::collectAwaitingBatchAssignments` ->
 * `lib/sync/findings.ts`. No DB, no worker, no server context. (The worker-side split — and
 * the fact that an ORPHAN wet-recovery sub-row STAYS malformed — is proven in
 * `workers/sync/test/reports/deliveries-feeding-label.test.ts`.)
 *
 * Asserts:
 *   1. collectAwaitingBatchAssignments folds the channel, guarding absent / empty /
 *      pre-feature results (a clean run must stay silent).
 *   2. ONE finding per waiting row, `section: 'deliveries'`, keyed by the row's identity.
 *   3. It reads as "waiting on the operator", never as an error, and is the QUIETEST thing
 *      on the list on day zero.
 *   4. Severity ESCALATES with age: info (0-1d) -> attention (2-3d) -> high (4d+).
 *   5. It is NOT a held row and creates NO durable case — `held` stays empty.
 *   6. NO cost/price key ever reaches the finding data (the project-wide boundary).
 *   7. summarizeFindings counts it and the Claude serializer renders it.
 *   8. It coexists with the other channels — same run, one list — and MALFORMED still
 *      reports separately and louder.
 *
 * Run:  npx tsx scripts/verify-awaiting-batch-assignment-fold.ts
 */
import assert from 'node:assert/strict'

import { collectAwaitingBatchAssignments, collectHeldRows } from '../lib/sync/cases-fold'
import {
  flattenRunFindings,
  summarizeFindings,
  serializeFindingsForClaude,
} from '../lib/sync/findings'
import type { AwaitingBatchAssignment, SyncRunResult } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** The real early-morning shape: plate, weight, moisture — Block cell empty. */
function waiting(overrides: Partial<AwaitingBatchAssignment> = {}): AwaitingBatchAssignment {
  return {
    transaction_date: '2026-08-13',
    supplier: 'Tag-at',
    truck_plate: 'AAV 6111',
    weight_kg: 17900,
    sacks: 480,
    source_row: '21',
    days_pending: 0,
    ...overrides,
  }
}

function runWith(rows: AwaitingBatchAssignment[]): SyncRunResult {
  return {
    reports: {
      deliveries: {
        classify: null,
        apply: {
          report_type: 'deliveries',
          ok: true,
          applied: { inserts: 2, updates: 0, replaced_dates: 0 },
          held: [],
          labeled: true,
          watermark_updated: true,
          errors: [],
          awaiting_batch_assignment: rows,
        },
      },
    },
  } as unknown as SyncRunResult
}

// ---------------------------------------------------------------------------
check('1. the fold reads the channel and guards every absence', () => {
  assert.deepEqual(collectAwaitingBatchAssignments(runWith([waiting()])), [waiting()])
  assert.deepEqual(collectAwaitingBatchAssignments(runWith([])), [])
  assert.deepEqual(
    collectAwaitingBatchAssignments({
      reports: { deliveries: { classify: null, apply: { held: [] } } },
    } as unknown as SyncRunResult),
    [],
  )
  assert.deepEqual(
    collectAwaitingBatchAssignments({
      reports: { deliveries: { classify: null, apply: null } },
    } as unknown as SyncRunResult),
    [],
  )
  assert.deepEqual(collectAwaitingBatchAssignments({} as SyncRunResult), [])
})

// ---------------------------------------------------------------------------
check('2. ONE deliveries-section finding per waiting row, keyed by its identity', () => {
  const findings = flattenRunFindings(
    runWith([
      waiting(),
      waiting({ truck_plate: 'KCA 378', sacks: 516, weight_kg: 18650, source_row: '22' }),
    ]),
  ).filter((f) => f.kind === 'awaiting_batch_assignment')

  assert.equal(findings.length, 2)
  assert.deepEqual(findings.map((f) => f.key), [
    'awaiting_batch_assignment:2026-08-13:AAV 6111:17900:480',
    'awaiting_batch_assignment:2026-08-13:KCA 378:18650:516',
  ])
  for (const f of findings) {
    assert.equal(f.section, 'deliveries')
    assert.equal(f.source, 'Delivery email (RC IN)')
    assert.equal(f.kindLabel, 'Waiting on a pile assignment')
  }
  // A clean run says nothing at all.
  assert.deepEqual(
    flattenRunFindings(runWith([])).filter((f) => f.kind === 'awaiting_batch_assignment'),
    [],
  )
})

// ---------------------------------------------------------------------------
check('3. it reads as "waiting on the operator", never as an error', () => {
  const [f] = flattenRunFindings(runWith([waiting()]))
  assert.match(f.title, /no pile assigned yet/i)
  assert.match(f.title, /17,900 kg/)
  assert.equal(f.location, '2026-08-13 · row 21')
  assert.match(f.reason, /usually fills itself in/i)
  assert.match(f.reason, /nothing to do unless it is still here tomorrow/i)
  // The words the OLD behaviour used must be gone.
  for (const banned of [/could not be read/i, /malformed/i, /invalid/i, /error/i, /failed/i]) {
    assert.ok(!banned.test(`${f.title} ${f.reason} ${f.kindLabel}`), `alarming wording: ${banned}`)
  }
})

// ---------------------------------------------------------------------------
check('4. severity escalates with age: info -> attention -> high', () => {
  const sev = (days: number) =>
    flattenRunFindings(runWith([waiting({ days_pending: days })]))[0].severity
  assert.equal(sev(0), 'info') // the ordinary same-day case
  assert.equal(sev(1), 'info')
  assert.equal(sev(2), 'attention') // it did not self-clear overnight
  assert.equal(sev(3), 'attention')
  assert.equal(sev(4), 'high') // not late any more — forgotten
  assert.equal(sev(9), 'high')

  // Day zero is strictly quieter than a malformed row would have been.
  assert.equal(sev(0), 'info')
  const stale = flattenRunFindings(runWith([waiting({ days_pending: 3 })]))[0]
  assert.match(stale.reason, /has not/i)
  assert.match(stale.reason, /needs the pile written in/i)
})

// ---------------------------------------------------------------------------
check('5. nothing is HELD, so no durable case is ever created for it', () => {
  const result = runWith([waiting({ days_pending: 5 })])
  assert.deepEqual(collectHeldRows(result), [])
  // `ensureCasesForRun` fans out held rows + the reconciliation channels only; with no
  // held row and no reconciliation block there is nothing for it to persist.
  assert.equal(result.reconciliation, undefined)
  assert.deepEqual(result.reports!.deliveries!.apply!.held, [])
})

// ---------------------------------------------------------------------------
check('6. no cost/price key ever reaches the finding data', () => {
  const [f] = flattenRunFindings(runWith([waiting()]))
  for (const key of Object.keys(f.data)) {
    assert.ok(!/cost|price|php|peso/i.test(key), `cost-ish key leaked: ${key}`)
  }
  assert.equal(f.data.days_pending, 0)
  assert.equal(f.data.source_row, '21')
  assert.equal(f.data.truck_plate, 'AAV 6111')
})

// ---------------------------------------------------------------------------
check('7. summarizeFindings counts it and the Claude serializer renders it', () => {
  const findings = flattenRunFindings(runWith([waiting()]))
  const { total, byKind } = summarizeFindings(findings)
  assert.equal(total, 1)
  assert.equal(byKind.awaiting_batch_assignment, 1)

  const text = serializeFindingsForClaude(findings, {
    runId: 'RUN-1',
    runDate: '2026-08-13',
  })
  assert.match(text, /awaiting_batch_assignment|no pile yet|Waiting on a pile assignment/)
})

// ---------------------------------------------------------------------------
check('8. it coexists with MALFORMED, which still reports separately and louder', () => {
  const result = runWith([waiting()]) as SyncRunResult
  // An ORPHAN wet-recovery sub-row — genuinely bad data, still held, still loud.
  result.reports!.deliveries!.apply!.held = [
    {
      reason: 'malformed',
      natural_key: '2026-08-13|null|520',
      detail: 'Missing required field (transaction_date / batch_code / weight_kg)',
      kind: 'malformed',
    },
  ]
  const findings = flattenRunFindings(result)
  assert.deepEqual(findings.map((f) => f.kind), ['malformed', 'awaiting_batch_assignment'])
  const [bad, soft] = findings
  assert.equal(bad.severity, 'attention')
  assert.equal(soft.severity, 'info')
  assert.equal(bad.kindLabel, 'Row could not be read')
})

console.log(`\nAll ${passed} awaiting-batch-assignment-fold checks passed.`)
