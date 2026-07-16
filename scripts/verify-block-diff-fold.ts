/**
 * verify-block-diff-fold.ts — framework-free proof of the RB block-balance fan-out's two
 * PURE pieces: the `block_diff` fingerprint + human label (lib/sync/fingerprint.ts) and the
 * fold (lib/sync/cases-fold.ts::collectBlockDiffs). No DB, no worker, no server context.
 *
 * Asserts:
 *   1. blockDiffFingerprint STABILITY — same diff twice → same hash.
 *   2. A CHANGED balance → NEW hash (re-alarm); sub-kg jitter that rounds the same → UNCHANGED.
 *   3. A batch_mismatch folds the competing batch codes; a multi_batch folds the count.
 *   4. Different block_loc / kind → different case.
 *   5. blockDiffNaturalKey renders stable labels (per-block + grand total).
 *   6. collectBlockDiffs folds the reconciliation.blocking channel, guarding absent + empty.
 *
 * Run:  npx tsx scripts/verify-block-diff-fold.ts
 */
import assert from 'node:assert/strict'

import { blockDiffFingerprint, blockDiffNaturalKey } from '../lib/sync/fingerprint'
import { collectBlockDiffs } from '../lib/sync/cases-fold'
import type { BlockDiff, SyncRunResult } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

function balanceDiff(): BlockDiff {
  return {
    kind: 'balance',
    block_loc: 'A-9C',
    sheet_kg: 73_575,
    computed_kg: 60_000,
    delta: 13_575,
    detail: 'Block A-9C balance disagrees: Sheet 73,575 kg vs app 60,000 kg (Δ 13,575 kg).',
  }
}
function batchDiff(): BlockDiff {
  return {
    kind: 'batch_mismatch',
    block_loc: 'D-11B',
    sheet_kg: 31_745,
    computed_kg: 31_745,
    delta: 0,
    sheet_batch: 'FEB-26-BLK3',
    computed_batch: 'MARCH-26-BLK4',
    detail: "Block D-11B holds 'FEB-26-BLK3' in the Sheet but 'MARCH-26-BLK4' in the app.",
  }
}
function multiDiff(): BlockDiff {
  return {
    kind: 'multi_batch',
    block_loc: 'B-3A',
    sheet_kg: 70_000,
    computed_kg: 70_000,
    delta: null,
    active_batch_count: 2,
    detail: 'Block B-3A has 2 active (non-CLOSED) batches in the app — a block should hold exactly one.',
  }
}
function grandTotalDiff(): BlockDiff {
  return {
    kind: 'grand_total',
    block_loc: null,
    sheet_kg: 10_289_082,
    computed_kg: 10_200_000,
    delta: 89_082,
    detail: 'Total inventory disagrees: Sheet 10,289,082 kg vs app 10,200,000 kg (Δ 89,082 kg).',
  }
}

// ── 1. Stability ────────────────────────────────────────────────────────────
check('same block_diff → same hash (stable)', () => {
  const a = blockDiffFingerprint(balanceDiff())
  const b = blockDiffFingerprint(balanceDiff())
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})

// ── 2. Value change re-alarms; sub-kg jitter does not ───────────────────────
check('a changed balance → NEW hash; sub-kg jitter → SAME hash', () => {
  const base = blockDiffFingerprint(balanceDiff())

  const changed = balanceDiff()
  changed.computed_kg = 55_000
  assert.notEqual(base, blockDiffFingerprint(changed))

  const jitter = balanceDiff()
  jitter.sheet_kg = 73_575.4
  jitter.computed_kg = 60_000.2
  assert.equal(base, blockDiffFingerprint(jitter))
})

// ── 3. Kind-specific fields participate ─────────────────────────────────────
check('batch_mismatch folds competing codes; multi_batch folds the count', () => {
  const base = blockDiffFingerprint(batchDiff())
  const otherBatch = batchDiff()
  otherBatch.computed_batch = 'APRIL-26-BLK9'
  assert.notEqual(base, blockDiffFingerprint(otherBatch))

  const baseMulti = blockDiffFingerprint(multiDiff())
  const three = multiDiff()
  three.active_batch_count = 3
  assert.notEqual(baseMulti, blockDiffFingerprint(three))
})

// ── 4. Identity: different block/kind → different case ──────────────────────
check('different block_loc or kind → different hash', () => {
  const base = blockDiffFingerprint(balanceDiff())
  const otherLoc = balanceDiff()
  otherLoc.block_loc = 'A-10C'
  assert.notEqual(base, blockDiffFingerprint(otherLoc))

  // Same block, but a batch_mismatch is a different case than a balance diff.
  assert.notEqual(base, blockDiffFingerprint(batchDiff()))

  // The grand-total diff is its own stable case.
  assert.match(blockDiffFingerprint(grandTotalDiff()), /^[0-9a-f]{64}$/)
})

// ── 5. Human labels ─────────────────────────────────────────────────────────
check('blockDiffNaturalKey renders stable labels', () => {
  assert.equal(blockDiffNaturalKey(balanceDiff()), 'A-9C · balance')
  assert.equal(blockDiffNaturalKey(batchDiff()), 'D-11B · batch')
  assert.equal(blockDiffNaturalKey(multiDiff()), 'B-3A · multi-batch')
  assert.equal(blockDiffNaturalKey(grandTotalDiff()), 'GRAND TOTAL · blocking')
})

// ── 6. collectBlockDiffs folds the channel ──────────────────────────────────
check('collectBlockDiffs folds reconciliation.blocking, guarding absent + empty', () => {
  const withDiffs: SyncRunResult = {
    reports: {},
    reconciliation: {
      blocking: {
        blockDiffs: [balanceDiff(), grandTotalDiff()],
        totals: {
          sheetSumKg: 10_289_082,
          computedSumKg: 10_200_000,
          sheetStatedTotalKg: 10_289_082,
          delta: 89_082,
          sheetBlocks: 167,
          computedBlocks: 165,
          comparedBlocks: 164,
          negativeComputedBlocks: [],
        },
      },
    },
  }
  const folded = collectBlockDiffs(withDiffs)
  assert.equal(folded.length, 2)
  assert.equal(folded[0].block_loc, 'A-9C')

  // A run with only the rc_out channel (no blocking) → [].
  assert.deepEqual(
    collectBlockDiffs({ reconciliation: { rc_out: { diffs: [], agreements: 0 } } } as SyncRunResult),
    [],
  )
  // Empty blocking channel → [].
  assert.deepEqual(
    collectBlockDiffs({
      reconciliation: {
        blocking: {
          blockDiffs: [],
          totals: {
            sheetSumKg: 0,
            computedSumKg: 0,
            sheetStatedTotalKg: null,
            delta: 0,
            sheetBlocks: 0,
            computedBlocks: 0,
            comparedBlocks: 0,
            negativeComputedBlocks: [],
          },
        },
      },
    } as SyncRunResult),
    [],
  )
  // Pre-RB result (no reconciliation) → [].
  assert.deepEqual(collectBlockDiffs({ reports: {} } as SyncRunResult), [])
  assert.deepEqual(collectBlockDiffs({} as SyncRunResult), [])
})

console.log(`\nAll ${passed} block-diff-fold checks passed.`)
