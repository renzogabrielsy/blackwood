/**
 * verify-source-diff-fold.ts — framework-free proof of the R2 SHADOW fan-out's two
 * PURE pieces: the `source_diff` fingerprint + human label (lib/sync/fingerprint.ts)
 * and the reconciliation fold (lib/sync/cases-fold.ts::collectSourceDiffs). No DB, no
 * worker, no server context.
 *
 * Asserts:
 *   1. sourceDiffFingerprint STABILITY — same diff twice → same hash.
 *   2. Source/opinion ORDER independence — reordering sources[] → SAME hash.
 *   3. A CHANGED competing value → NEW hash (a real re-alarm), but sub-kg jitter that
 *      rounds to the same integer → UNCHANGED.
 *   4. sourceDiffNaturalKey renders the stable human label.
 *   5. collectSourceDiffs folds a run result's reconciliation channel, guarding a
 *      pre-R2 result (no channel) and an empty channel.
 *
 * Run:  npx tsx scripts/verify-source-diff-fold.ts
 */
import assert from 'node:assert/strict'

import {
  singleSourceOverdueFingerprint,
  singleSourceOverdueNaturalKey,
  sourceDiffFingerprint,
  sourceDiffNaturalKey,
  unresolvedBatchFingerprint,
  unresolvedBatchNaturalKey,
} from '../lib/sync/fingerprint'
import {
  collectSingleSourceOverdue,
  collectSourceDiffs,
  collectUnresolvedBatches,
} from '../lib/sync/cases-fold'
import type {
  SingleSourceOverdue,
  SourceDiff,
  SyncRunResult,
  UnresolvedBatch,
} from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** The L-037 BLK5 diff (proposed 31,745 vs gsheet 42,558, movement corroborates proposed). */
function blk5Diff(): SourceDiff {
  return {
    naturalKey: {
      transaction_date: '2026-06-10',
      batch: 'MAR-26-BLK5',
      block_loc: 'D-11B',
      destination: 'MAIN',
    },
    field: 'weight_kg',
    table: 'rc_out',
    sources: [
      {
        source: 'proposed',
        value: 31_745,
        provenance: 'PROPOSED DAILY REPORT 2026-06-10 MAR-26-BLK5 @ D-11B',
        selfConsistent: true,
        corroboratedBy: ['movement'],
        rows: [],
      },
      {
        source: 'gsheet',
        value: 42_558,
        provenance: 'Google Sheet RC OUT 2026-06-10 MAR-26-BLK5 @ D-11B',
        selfConsistent: true,
        corroboratedBy: [],
        rows: [],
      },
    ],
    recommended: { source: 'proposed', why: 'movement corroborates; gsheet uncorroborated' },
  }
}

// ── 1. Fingerprint stability ────────────────────────────────────────────────
check('same source_diff → same hash (stable)', () => {
  const a = sourceDiffFingerprint(blk5Diff())
  const b = sourceDiffFingerprint(blk5Diff())
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})

// ── 2. Source-order independence ────────────────────────────────────────────
check('reordering sources[] does not change the hash', () => {
  const base = blk5Diff()
  const reordered = blk5Diff()
  reordered.sources.reverse() // gsheet first now
  assert.equal(sourceDiffFingerprint(base), sourceDiffFingerprint(reordered))
})

// ── 3. Value change re-alarms; sub-kg jitter does not ───────────────────────
check('a changed competing value → NEW hash; sub-kg jitter → SAME hash', () => {
  const base = blk5Diff()

  const changed = blk5Diff()
  changed.sources[1].value = 50_000 // gsheet now states a different number
  assert.notEqual(sourceDiffFingerprint(base), sourceDiffFingerprint(changed))

  const jitter = blk5Diff()
  jitter.sources[0].value = 31_745.4 // rounds to the same integer kg
  jitter.sources[1].value = 42_557.8
  assert.equal(sourceDiffFingerprint(base), sourceDiffFingerprint(jitter))

  // A DIFFERENT natural key IS a different case.
  const otherKey = blk5Diff()
  otherKey.naturalKey.block_loc = 'D-12B'
  assert.notEqual(sourceDiffFingerprint(base), sourceDiffFingerprint(otherKey))

  // A different FIELD is a different case.
  const otherField = blk5Diff()
  otherField.field = 'destination'
  assert.notEqual(sourceDiffFingerprint(base), sourceDiffFingerprint(otherField))
})

// ── 4. Human label ──────────────────────────────────────────────────────────
check('sourceDiffNaturalKey renders the stable human label', () => {
  assert.equal(sourceDiffNaturalKey(blk5Diff()), 'MAR-26-BLK5 @ D-11B · 2026-06-10 · weight')

  // A non-MAIN destination is surfaced.
  const sundry = blk5Diff()
  sundry.naturalKey.destination = 'SUNDRY'
  assert.equal(sourceDiffNaturalKey(sundry), 'MAR-26-BLK5 @ D-11B → SUNDRY · 2026-06-10 · weight')
})

// ── 5. collectSourceDiffs folds the reconciliation channel ───────────────────
check('collectSourceDiffs folds the channel, guarding absent + empty', () => {
  const withDiffs: SyncRunResult = {
    reports: {},
    reconciliation: { rc_out: { diffs: [blk5Diff()], agreements: 3 } },
  }
  const folded = collectSourceDiffs(withDiffs)
  assert.equal(folded.length, 1)
  assert.equal(folded[0].naturalKey.batch, 'MAR-26-BLK5')

  // Pre-R2 result (no reconciliation channel) → [].
  assert.deepEqual(collectSourceDiffs({ reports: {} } as SyncRunResult), [])
  // Empty channel → [].
  assert.deepEqual(
    collectSourceDiffs({ reconciliation: { rc_out: { diffs: [], agreements: 0 } } } as SyncRunResult),
    [],
  )
  // Totally empty result → [].
  assert.deepEqual(collectSourceDiffs({} as SyncRunResult), [])
})

// ============================================================================
// R4a — unresolved_batch + single_source_overdue fold kinds
// ============================================================================

/** A batch that resolved to NO id (0 candidates). */
function unresolved(): UnresolvedBatch {
  return {
    transaction_date: '2026-06-10',
    batch_code: 'JULY-26-BLK9',
    candidates: [],
    block_loc: 'D-9A',
    destination: 'MAIN',
    weight_kg: 5_000,
    sources: ['proposed'],
  }
}

/** A gsheet-only fact whose second witness is 5 days overdue. */
function overdue(): SingleSourceOverdue {
  return {
    naturalKey: {
      transaction_date: '2026-06-10',
      batch: 'id-blk5',
      block_loc: 'D-11B',
      destination: 'MAIN',
    },
    field: 'weight_kg',
    table: 'rc_out',
    source: 'gsheet',
    value: 5_000,
    provenance: 'gsheet 2026-06-10 batch id-blk5 @ D-11B = 5000',
    ageDays: 5,
    lagDays: 2,
  }
}

check('unresolvedBatch fingerprint is stable + candidate-set aware', () => {
  const a = unresolvedBatchFingerprint(unresolved())
  assert.equal(a, unresolvedBatchFingerprint(unresolved()))
  assert.match(a, /^[0-9a-f]{64}$/)

  // A DIFFERENT candidate set (now ambiguous) → NEW hash (re-alarm).
  const ambiguous = unresolved()
  ambiguous.candidates = ['id-a', 'id-b']
  assert.notEqual(a, unresolvedBatchFingerprint(ambiguous))

  // Candidate ORDER does not change the hash (sorted inside).
  const reordered = unresolved()
  reordered.candidates = ['id-b', 'id-a']
  const ordered = unresolved()
  ordered.candidates = ['id-a', 'id-b']
  assert.equal(unresolvedBatchFingerprint(reordered), unresolvedBatchFingerprint(ordered))

  // Weight is NOT in the fingerprint (identity, not payload).
  const heavier = unresolved()
  heavier.weight_kg = 9_999
  assert.equal(a, unresolvedBatchFingerprint(heavier))
})

check('unresolvedBatch natural key renders the code + date', () => {
  assert.equal(unresolvedBatchNaturalKey(unresolved()), 'JULY-26-BLK9 · 2026-06-10')
})

check('singleSourceOverdue fingerprint is identity-based (value-independent)', () => {
  const a = singleSourceOverdueFingerprint(overdue())
  assert.equal(a, singleSourceOverdueFingerprint(overdue()))
  assert.match(a, /^[0-9a-f]{64}$/)

  // A CHANGED value does NOT re-alarm (the concern is the missing witness, not the number).
  const other = overdue()
  other.value = 6_000
  assert.equal(a, singleSourceOverdueFingerprint(other))

  // A different SOURCE, key, or field IS a different case.
  const diffSource = overdue()
  diffSource.source = 'proposed'
  assert.notEqual(a, singleSourceOverdueFingerprint(diffSource))
  const diffKey = overdue()
  diffKey.naturalKey.block_loc = 'D-12B'
  assert.notEqual(a, singleSourceOverdueFingerprint(diffKey))
})

check('singleSourceOverdue natural key names the batch, date, field, and lone source', () => {
  assert.equal(
    singleSourceOverdueNaturalKey(overdue()),
    'id-blk5 @ D-11B · 2026-06-10 · weight (only gsheet)',
  )
  // A feed fact (null block) reads "(feed)".
  const feed = overdue()
  feed.naturalKey.block_loc = null
  assert.equal(singleSourceOverdueNaturalKey(feed), 'id-blk5 @ (feed) · 2026-06-10 · weight (only gsheet)')
})

check('collectUnresolvedBatches + collectSingleSourceOverdue fold the channel, guarding absent', () => {
  const full: SyncRunResult = {
    reports: {},
    reconciliation: {
      rc_out: {
        diffs: [],
        agreements: 2,
        pending: 3,
        heldOverdue: [overdue()],
        unresolvedBatches: [unresolved()],
      },
    },
  }
  assert.equal(collectUnresolvedBatches(full).length, 1)
  assert.equal(collectSingleSourceOverdue(full).length, 1)

  // Pre-R4a channel (fields absent) → [] for both.
  const preR4a: SyncRunResult = { reconciliation: { rc_out: { diffs: [], agreements: 0 } } }
  assert.deepEqual(collectUnresolvedBatches(preR4a), [])
  assert.deepEqual(collectSingleSourceOverdue(preR4a), [])

  // No reconciliation channel at all → [].
  assert.deepEqual(collectUnresolvedBatches({ reports: {} } as SyncRunResult), [])
  assert.deepEqual(collectSingleSourceOverdue({} as SyncRunResult), [])
})

console.log(`\nAll ${passed} source-diff-fold checks passed.`)
