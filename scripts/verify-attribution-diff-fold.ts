/**
 * verify-attribution-diff-fold.ts — framework-free proof of the second-pass attribution
 * matcher's app-side PURE pieces: the `attribution_diff` fingerprint + human label
 * (lib/sync/fingerprint.ts) and the reconciliation fold (lib/sync/cases-fold.ts::
 * collectAttributionDiffs). No DB, no worker, no server context.
 *
 * Anchored on the 2026-07-11 forensics: run 83d17774 produced 47 `single_source_overdue`
 * cases that were really ~20 pairs of the SAME physical feeding under two different
 * batch/block attributions (the proposed report derives its batch from block_date+block_no
 * while the Sheet carries an operator-typed code). The pure PAIRING logic itself is proven
 * in workers/sync/test/reconcile/rcOut.test.ts; this script proves the app-side fold that
 * turns a worker-emitted AttributionDiff into a durable, deduped case.
 *
 * Asserts:
 *   1. attributionDiffFingerprint STABILITY — same pairing twice → same hash.
 *   2. Side ORDER independence — which side is "proposed" vs "gsheet" is fixed by the type,
 *      but swapping the two sides' batch identities still folds into a fingerprint that
 *      sorts the batch-id set (order-independent on the underlying identity pair).
 *   3. A CHANGED weight or batch → NEW hash (a real re-alarm); a different destination →
 *      NEW hash; block_loc is NOT in the fingerprint (only the disagreement matters).
 *   4. attributionDiffNaturalKey renders the stable human label (code preferred over id).
 *   5. collectAttributionDiffs folds a run result's reconciliation channel, guarding a
 *      pre-this-feature result (no field), an absent channel, and an empty array.
 *
 * Run:  npx tsx scripts/verify-attribution-diff-fold.ts
 */
import assert from 'node:assert/strict'

import { attributionDiffFingerprint, attributionDiffNaturalKey } from '../lib/sync/fingerprint'
import { collectAttributionDiffs } from '../lib/sync/cases-fold'
import type { AttributionDiff, SyncRunResult } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** The real 2026-05-04 pairing: proposed 5,943 kg @ "16A NEAR PATHWAY" (NOV-24-BLK10) vs
 *  gsheet 5,943 kg @ "PCA-16C" (MARCH-26-SUNDRY4) — same feeding, different attribution. */
function may04Pair(): AttributionDiff {
  return {
    transaction_date: '2026-05-04',
    destination: 'MAIN',
    weight_kg: 5_943,
    proposed: {
      source: 'proposed',
      batch: 'id-blk10',
      batch_code: 'NOV-24-BLK10',
      block_loc: '16A NEAR PATHWAY',
      weight_kg: 5_943,
      provenance: 'PROPOSED DAILY REPORT 2026-05-04 batch id-blk10 @ 16A NEAR PATHWAY',
    },
    gsheet: {
      source: 'gsheet',
      batch: 'id-sundry4',
      batch_code: 'MARCH-26-SUNDRY4',
      block_loc: 'PCA-16C',
      weight_kg: 5_943,
      provenance: 'Google Sheet RC OUT 2026-05-04 batch id-sundry4 @ PCA-16C',
    },
  }
}

// ── 1. Fingerprint stability ────────────────────────────────────────────────
check('same attribution_diff → same hash (stable)', () => {
  const a = attributionDiffFingerprint(may04Pair())
  const b = attributionDiffFingerprint(may04Pair())
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})

// ── 2. Identity-pair order independence (sorted batch-id set) ───────────────
check('swapping which side is "proposed" vs "gsheet" does not change the hash', () => {
  const base = may04Pair()
  const swapped: AttributionDiff = {
    transaction_date: base.transaction_date,
    destination: base.destination,
    weight_kg: base.weight_kg,
    proposed: { ...base.gsheet, source: 'proposed' },
    gsheet: { ...base.proposed, source: 'gsheet' },
  }
  assert.equal(attributionDiffFingerprint(base), attributionDiffFingerprint(swapped))
})

// ── 3. Real changes re-alarm; block_loc alone never does ────────────────────
check('a changed weight or batch → NEW hash; a changed block_loc alone → SAME hash', () => {
  const base = may04Pair()

  const changedWeight = may04Pair()
  changedWeight.weight_kg = 6_000
  assert.notEqual(attributionDiffFingerprint(base), attributionDiffFingerprint(changedWeight))

  const changedBatch = may04Pair()
  changedBatch.gsheet.batch = 'id-different-batch'
  assert.notEqual(attributionDiffFingerprint(base), attributionDiffFingerprint(changedBatch))

  const changedDest = may04Pair()
  changedDest.destination = 'SUNDRY'
  assert.notEqual(attributionDiffFingerprint(base), attributionDiffFingerprint(changedDest))

  // Sub-kg jitter rounds to the same integer → SAME hash.
  const jitter = may04Pair()
  jitter.weight_kg = 5_943.4
  assert.equal(attributionDiffFingerprint(base), attributionDiffFingerprint(jitter))

  // block_loc is NOT in the fingerprint — only the batch identity + weight + date/dest.
  const changedBlock = may04Pair()
  changedBlock.proposed.block_loc = 'SOME OTHER BLOCK'
  assert.equal(attributionDiffFingerprint(base), attributionDiffFingerprint(changedBlock))
})

// ── 4. Human label ──────────────────────────────────────────────────────────
check('attributionDiffNaturalKey renders the stable human label (code preferred over id)', () => {
  assert.equal(
    attributionDiffNaturalKey(may04Pair()),
    'NOV-24-BLK10 vs MARCH-26-SUNDRY4 · 2026-05-04 · 5,943 kg',
  )

  // No batch_code on a side → falls back to the raw batch id.
  const noCode = may04Pair()
  noCode.proposed.batch_code = null
  assert.equal(
    attributionDiffNaturalKey(noCode),
    'id-blk10 vs MARCH-26-SUNDRY4 · 2026-05-04 · 5,943 kg',
  )

  // A non-MAIN destination is surfaced.
  const sundry = may04Pair()
  sundry.destination = 'SUNDRY'
  assert.equal(
    attributionDiffNaturalKey(sundry),
    'NOV-24-BLK10 vs MARCH-26-SUNDRY4 → SUNDRY · 2026-05-04 · 5,943 kg',
  )
})

// ── 5. collectAttributionDiffs folds the reconciliation channel ─────────────
check('collectAttributionDiffs folds the channel, guarding absent + empty + pre-feature', () => {
  const withPairs: SyncRunResult = {
    reports: {},
    reconciliation: { rc_out: { diffs: [], agreements: 3, attributionDiffs: [may04Pair()] } },
  }
  const folded = collectAttributionDiffs(withPairs)
  assert.equal(folded.length, 1)
  assert.equal(folded[0].proposed.batch_code, 'NOV-24-BLK10')

  // Pre-this-feature channel (field absent) → [].
  assert.deepEqual(
    collectAttributionDiffs({ reconciliation: { rc_out: { diffs: [], agreements: 0 } } } as SyncRunResult),
    [],
  )
  // No reconciliation channel at all → [].
  assert.deepEqual(collectAttributionDiffs({ reports: {} } as SyncRunResult), [])
  // Totally empty result → [].
  assert.deepEqual(collectAttributionDiffs({} as SyncRunResult), [])
})

console.log(`\nAll ${passed} attribution-diff-fold checks passed.`)
