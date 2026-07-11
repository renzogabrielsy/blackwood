/**
 * verify-create-batch.ts — framework-free proof of the PURE create-batch core
 * (lib/sync/create-batch-plan.ts). No DB, no server context — every derivation branch
 * is exercised deterministically. The DB read/write + audit live in the server action
 * (app/(app)/sync/resolve.ts::executeCreateBatch), which this does not touch.
 *
 * Asserts:
 *   1. FEED (null/blank/invalid-code block) → location_ref '', isFeed true; a real
 *      chk_location_ref_format-valid block → that block, verbatim.
 *   2. Batch fields default: STORED, current_weight 0, avg_cost null (unpriced).
 *   3. Writer lane: unresolved_batch → rc_out; deliveries → deliveries; gsheet mode → lane;
 *      an unknown/writer-less shape → ambiguous (create batch only).
 *   4. A minimal {mode,index} row (no batch_code) → no plan.
 *   5. Ruling summary shape: created-vs-existing × rows-written-vs-not.
 *   6. Provenance string composition.
 *   7. parseCreateBatchInput / findOpenCreateBatchPlan round-trip + decline closes it.
 *
 * Run:  npx tsx scripts/verify-create-batch.ts
 */
import assert from 'node:assert/strict'

import {
  CREATE_BATCH_TOOL,
  buildCreateBatchPlan,
  createBatchProvenance,
  createBatchRulingSummary,
  deriveBatchFields,
  findOpenCreateBatchPlan,
  parseCreateBatchInput,
  pickWriterLane,
  readBatchCaseInput,
  type CreateBatchProposalInput,
  type CreateBatchScanRow,
} from '../lib/sync/create-batch-plan'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ── 1 + 2. FEED vs block + field defaults. ──────────────────────────────────
check('FEED (null block) → location_ref \'\' (BUG B fix), isFeed; STORED/0/null defaults', () => {
  const feed = deriveBatchFields('JULY-26-FEED1', null)
  assert.equal(feed.location_ref, '')
  assert.equal(feed.status, 'STORED')
  assert.equal(feed.current_weight, 0)
  assert.equal(feed.avg_cost, null)

  const blank = deriveBatchFields('X', '   ')
  assert.equal(blank.location_ref, '') // blank block also → ''

  const block = deriveBatchFields('SEPT-26-BLK9', 'A-9C')
  assert.equal(block.location_ref, 'A-9C')
  assert.equal(block.avg_cost, null)
})

check('BUG B: a block_loc that is not a valid chk_location_ref_format code falls back to \'\', never the literal "FEED" sentinel (23514 guard)', () => {
  const freeText = deriveBatchFields('JULY-26-BLK1', 'FOR FEEDING')
  assert.equal(freeText.location_ref, '')
  assert.notEqual(freeText.location_ref, 'FEED')

  const pathway = deriveBatchFields('JULY-26-BLK2', '16A NEAR PATHWAY')
  assert.equal(pathway.location_ref, '')

  // Valid codes across every constraint prefix (PCA|PCB|[A-DF]) round-trip verbatim.
  for (const code of ['A-9C', 'B-1A', 'C-12A', 'D-3B', 'F-1A', 'PCA-1B', 'PCB-2D']) {
    assert.equal(deriveBatchFields('X', code).location_ref, code)
  }
})

// ── 3. Writer lane resolution + plans. ──────────────────────────────────────
check('unresolved_batch (rc_out) → rc_out lane, not feed-ambiguous, unblock carries the row', () => {
  const row = {
    sources: ['gsheet'],
    block_loc: null,
    weight_kg: 3000,
    batch_code: 'JULY-26-FEED1',
    candidates: [],
    destination: 'MAIN',
    transaction_date: '2026-07-08',
  }
  const plan = buildCreateBatchPlan({ kind: 'unresolved_batch', reportType: 'rc_out', row })
  assert.ok(plan)
  assert.equal(plan!.batch_code, 'JULY-26-FEED1')
  assert.equal(plan!.isFeed, true)
  assert.equal(plan!.writerLane, 'rc_out')
  assert.equal(plan!.ambiguous, false)
  assert.equal((plan!.unblock as Record<string, unknown>).weight_kg, 3000)
})

check('unmapped deliveries → deliveries lane; gsheet mode routes rc_in/rc_out', () => {
  const del = buildCreateBatchPlan({
    kind: 'unmapped_batch_code',
    reportType: 'deliveries',
    row: { supplier: 'Czarina', weight_kg: 8200, batch_code: 'SEPT-26-BLK9' },
  })
  assert.equal(del!.writerLane, 'deliveries')
  assert.equal(del!.isFeed, true) // no block on the row → FEED marker

  assert.equal(pickWriterLane('unmapped_batch_code', 'gsheet', { mode: 'rc_in', batch_code: 'X' }), 'deliveries')
  assert.equal(pickWriterLane('unmapped_batch_code', 'gsheet', { mode: 'rc_out', batch_code: 'X' }), 'rc_out')
})

check('writer-less shape → ambiguous plan (create batch only)', () => {
  const plan = buildCreateBatchPlan({
    kind: 'unmapped_batch_code',
    reportType: 'production',
    row: { batch_code: 'MYSTERY-1' },
  })
  assert.ok(plan)
  assert.equal(plan!.writerLane, null)
  assert.equal(plan!.ambiguous, true)
  assert.equal(plan!.unblock, null)
  assert.ok(plan!.note && plan!.note.length > 0)
})

// ── 4. No batch_code → no plan. ─────────────────────────────────────────────
check('minimal {mode,index} row (no batch_code) → readBatchCaseInput null → no plan', () => {
  assert.equal(readBatchCaseInput({ mode: 'rc_in', index: 1220 }), null)
  assert.equal(buildCreateBatchPlan({ kind: 'unmapped_batch_code', reportType: 'gsheet', row: { mode: 'rc_in', index: 1220 } }), null)
  assert.equal(readBatchCaseInput(null), null)
})

// ── 5. Ruling summary shapes. ───────────────────────────────────────────────
check('createBatchRulingSummary reflects created-vs-existing × rows-written', () => {
  assert.equal(
    createBatchRulingSummary({ batchCode: 'JULY-26-FEED1', created: true, rowsWritten: 1 }),
    'Created batch "JULY-26-FEED1" and wrote 1 skipped row(s).',
  )
  assert.equal(
    createBatchRulingSummary({ batchCode: 'JULY-26-FEED1', created: false, rowsWritten: 0 }),
    'Batch "JULY-26-FEED1" already existed (no row written — it will land on the next sync).',
  )
  assert.equal(
    createBatchRulingSummary({ batchCode: 'X', created: true, rowsWritten: 0 }),
    'Created batch "X" (no row written — it will land on the next sync).',
  )
})

// ── 6. Provenance. ──────────────────────────────────────────────────────────
check('provenance composes exactly', () => {
  assert.equal(
    createBatchProvenance('renzo@ictc.test', 'JULY-26-FEED1'),
    'batch "JULY-26-FEED1" created + row written via Sync Review by renzo@ictc.test',
  )
})

// ── 7. Proposal parse + open-detection round-trip. ──────────────────────────
check('parseCreateBatchInput + findOpenCreateBatchPlan round-trip; decline closes it', () => {
  const plan = buildCreateBatchPlan({
    kind: 'unresolved_batch',
    reportType: 'rc_out',
    row: { batch_code: 'JULY-26-FEED1', block_loc: null, weight_kg: 3000, destination: 'MAIN', transaction_date: '2026-07-08' },
  })!
  const input: CreateBatchProposalInput = { batch_code: 'JULY-26-FEED1', naturalKeyLabel: 'JULY-26-FEED1 · 2026-07-08', plan }

  // Malformed → null.
  assert.equal(parseCreateBatchInput(null), null)
  assert.equal(parseCreateBatchInput({ batch_code: 'X', naturalKeyLabel: 'y' }), null) // no plan
  assert.equal(parseCreateBatchInput({ naturalKeyLabel: 'y', plan }), null) // no batch_code
  // Valid → parsed back.
  const parsed = parseCreateBatchInput(input)
  assert.ok(parsed)
  assert.equal(parsed!.batch_code, 'JULY-26-FEED1')

  const rows: CreateBatchScanRow[] = [
    { role: 'system', content: 'Case opened.', tool_calls: null, position: 0 },
    { role: 'assistant', content: 'Prepared to create the batch.', tool_calls: [{ id: 'cb_1', name: CREATE_BATCH_TOOL, input }], position: 1 },
  ]
  const open = findOpenCreateBatchPlan(rows, 'investigated')
  assert.ok(open)
  assert.equal(open!.position, 1)
  assert.equal(open!.tool_use_id, 'cb_1')

  // Resolved case → none.
  assert.equal(findOpenCreateBatchPlan(rows, 'resolved'), null)

  // A later decline closes it.
  const declined: CreateBatchScanRow[] = [
    ...rows,
    { role: 'system', content: 'Proposal declined by renzo.', tool_calls: null, position: 2 },
  ]
  assert.equal(findOpenCreateBatchPlan(declined, 'investigated'), null)
})

console.log(`\nAll ${passed} create-batch checks passed.`)
