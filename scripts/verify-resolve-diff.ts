/**
 * verify-resolve-diff.ts — framework-free proof of R3a's PURE core: the pick-source
 * write-plan (app/(app)/sync/diff-plan.ts::computeDiffWritePlan) plus the provenance +
 * ruling-summary composers + the persisted-proposal parser/detector. No DB, no worker,
 * no server context — every branch of the planner is exercised deterministically.
 *
 * Asserts:
 *   1. The L-037 clean case → ONE edit (31,745 → 20,932), result sum 31,745, not ambiguous.
 *   2. Equal-count value-diff → a noop + a single edit.
 *   3. Ambiguous unequal-count with no clean weight match → ambiguous:true, no steps.
 *   4. Insert-missing-leg → an insert step; DB already equal → all noops, no changes.
 *   5. Soft-remove of an over-stated leg (weight → 0, never delete).
 *   6. Provenance string composition + the pick_source ruling summary shape.
 *   7. parsePickSourceInput / findOpenPickSourcePlan round-trip + decline closes it.
 *
 * Run:  npx tsx scripts/verify-resolve-diff.ts
 */
import assert from 'node:assert/strict'

import {
  computeDiffWritePlan,
  diffResolutionProvenance,
  pickSourceRulingSummary,
  parsePickSourceInput,
  findOpenPickSourcePlan,
  PICK_SOURCE_TOOL,
  type DbRcOutRow,
  type PickSourceProposalInput,
  type PickSourceScanRow,
} from '../app/(app)/sync/diff-plan'
import type { SourceLegRow } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let db = 0
function dbRow(weight: number): DbRcOutRow {
  return {
    id: `db-${++db}`,
    transaction_date: '2026-06-10',
    batch_id: 'batch-1',
    block_loc: 'D-11B',
    destination: 'MAIN',
    weight_kg: weight,
    production_batch: 'MAR-26-BLK5',
    remarks: null,
  }
}
function leg(weight: number): SourceLegRow {
  return {
    transaction_date: '2026-06-10',
    batch_code: 'MAR-26-BLK5',
    block_loc: 'D-11B',
    destination: 'MAIN',
    weight_kg: weight,
  }
}

// ── 1. L-037 clean case: DB [10,813, 31,745] → proposed [10,813, 20,932] = 1 edit ──
check('L-037 clean → one edit 31,745→20,932, result 31,745, not ambiguous', () => {
  const plan = computeDiffWritePlan({
    source: 'proposed',
    dbRows: [dbRow(10_813), dbRow(31_745)],
    sourceRows: [leg(10_813), leg(20_932)],
  })
  assert.equal(plan.ambiguous, false)
  const edits = plan.steps.filter((s) => s.op === 'edit')
  const noops = plan.steps.filter((s) => s.op === 'noop')
  assert.equal(edits.length, 1)
  assert.equal(noops.length, 1)
  assert.equal(edits[0].from_weight_kg, 31_745)
  assert.equal(edits[0].to_weight_kg, 20_932)
  assert.equal(plan.resultingSumKg, 31_745)
  assert.equal(plan.chosenSumKg, 31_745)
  assert.equal(plan.currentSumKg, 42_558)
  assert.equal(plan.hasChanges, true)
})

// ── 2. Equal-count value diff → noop + single edit ──────────────────────────
check('equal-count value diff → one noop + one edit', () => {
  const plan = computeDiffWritePlan({
    source: 'gsheet',
    dbRows: [dbRow(100), dbRow(200)],
    sourceRows: [leg(100), leg(250)],
  })
  assert.equal(plan.ambiguous, false)
  assert.equal(plan.steps.filter((s) => s.op === 'edit').length, 1)
  assert.equal(plan.steps.filter((s) => s.op === 'noop').length, 1)
  assert.equal(plan.resultingSumKg, 350)
})

// ── 3. Ambiguous: unequal counts, no clean weight match ─────────────────────
check('ambiguous unequal-count, no weight match → ambiguous:true, no steps', () => {
  const plan = computeDiffWritePlan({
    source: 'gsheet',
    dbRows: [dbRow(100), dbRow(200)],
    sourceRows: [leg(50), leg(60), leg(70)],
  })
  assert.equal(plan.ambiguous, true)
  assert.equal(plan.steps.length, 0)
  assert.equal(plan.hasChanges, false)
  assert.ok(plan.suggestion && plan.suggestion.length > 0)
  // The current sum is unchanged when ambiguous.
  assert.equal(plan.resultingSumKg, plan.currentSumKg)
})

// ── 4a. Insert a missing leg ────────────────────────────────────────────────
check('insert-missing-leg → one insert; result = chosen sum', () => {
  const plan = computeDiffWritePlan({
    source: 'proposed',
    dbRows: [dbRow(100)],
    sourceRows: [leg(100), leg(500)],
  })
  assert.equal(plan.ambiguous, false)
  const inserts = plan.steps.filter((s) => s.op === 'insert')
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0].to_weight_kg, 500)
  assert.equal(inserts[0].leg?.weight_kg, 500)
  assert.equal(plan.resultingSumKg, 600)
})

// ── 4b. DB already equals the source → all noops, no changes ────────────────
check('DB already equal → all noops, hasChanges:false', () => {
  const plan = computeDiffWritePlan({
    source: 'gsheet',
    dbRows: [dbRow(100), dbRow(200)],
    sourceRows: [leg(200), leg(100)],
  })
  assert.equal(plan.ambiguous, false)
  assert.equal(plan.steps.every((s) => s.op === 'noop'), true)
  assert.equal(plan.hasChanges, false)
  assert.equal(plan.resultingSumKg, 300)
})

// ── 5. Soft-remove of an over-stated leg (weight → 0, never delete) ──────────
check('soft-remove over-stated leg → weight 0, kept', () => {
  const plan = computeDiffWritePlan({
    source: 'proposed',
    dbRows: [dbRow(100), dbRow(200)],
    sourceRows: [leg(100)],
  })
  assert.equal(plan.ambiguous, false)
  const removes = plan.steps.filter((s) => s.op === 'remove')
  assert.equal(removes.length, 1)
  assert.equal(removes[0].from_weight_kg, 200)
  assert.equal(removes[0].to_weight_kg, 0)
  assert.ok(removes[0].db_id) // a remove targets a specific DB row (soft-zero, never delete)
  assert.equal(plan.resultingSumKg, 100)
})

// ── 6. Provenance + ruling-summary composition ──────────────────────────────
check('provenance + ruling summary compose exactly', () => {
  const label = 'MAR-26-BLK5 @ D-11B · 2026-06-10 · weight'
  const prov = diffResolutionProvenance({
    email: 'renzo@ictc.test',
    source: 'proposed',
    field: 'weight_kg',
    naturalKeyLabel: label,
  })
  assert.equal(
    prov,
    `source_diff resolved via Sync Review by renzo@ictc.test: picked proposed — weight for ${label}`,
  )

  const plan = computeDiffWritePlan({
    source: 'proposed',
    dbRows: [dbRow(10_813), dbRow(31_745)],
    sourceRows: [leg(10_813), leg(20_932)],
  })
  const summary = pickSourceRulingSummary({
    source: 'proposed',
    field: 'weight_kg',
    naturalKeyLabel: label,
    plan,
  })
  assert.equal(summary, `Picked proposed as authoritative for ${label}: weight is now 31,745 kg.`)
})

// ── 7. Proposal parse + open-detection round-trip ───────────────────────────
check('parsePickSourceInput + findOpenPickSourcePlan round-trip; decline closes it', () => {
  const plan = computeDiffWritePlan({
    source: 'proposed',
    dbRows: [dbRow(10_813), dbRow(31_745)],
    sourceRows: [leg(10_813), leg(20_932)],
  })
  const input: PickSourceProposalInput = {
    source: 'proposed',
    field: 'weight_kg',
    naturalKeyLabel: 'MAR-26-BLK5 @ D-11B · 2026-06-10 · weight',
    plan,
  }
  // Malformed inputs → null.
  assert.equal(parsePickSourceInput(null), null)
  assert.equal(parsePickSourceInput({ source: 'nope', field: 'weight_kg', naturalKeyLabel: 'x', plan }), null)
  assert.equal(parsePickSourceInput({ source: 'proposed', field: 'weight_kg', naturalKeyLabel: 'x' }), null)
  // Valid → parsed back.
  const parsed = parsePickSourceInput(input)
  assert.ok(parsed)
  assert.equal(parsed!.source, 'proposed')

  const rows: PickSourceScanRow[] = [
    { role: 'system', content: 'Case opened.', tool_calls: null, position: 0 },
    {
      role: 'assistant',
      content: 'Prepared a resolution.',
      tool_calls: [{ id: 'pick_1', name: PICK_SOURCE_TOOL, input }],
      position: 1,
    },
  ]
  const open = findOpenPickSourcePlan(rows, 'investigated')
  assert.ok(open)
  assert.equal(open!.position, 1)
  assert.equal(open!.tool_use_id, 'pick_1')
  assert.equal(open!.input.source, 'proposed')

  // A resolved case has no open proposal.
  assert.equal(findOpenPickSourcePlan(rows, 'resolved'), null)

  // A later "Proposal declined" system row closes it.
  const declined: PickSourceScanRow[] = [
    ...rows,
    { role: 'system', content: 'Proposal declined by renzo.', tool_calls: null, position: 2 },
  ]
  assert.equal(findOpenPickSourcePlan(declined, 'investigated'), null)
})

console.log(`\nAll ${passed} resolve-diff checks passed.`)
