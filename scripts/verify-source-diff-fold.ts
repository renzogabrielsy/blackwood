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
  sourceDiffFingerprint,
  sourceDiffNaturalKey,
} from '../lib/sync/fingerprint'
import { collectSourceDiffs } from '../lib/sync/cases-fold'
import type { SourceDiff, SyncRunResult } from '../app/(app)/sync/types'

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

console.log(`\nAll ${passed} source-diff-fold checks passed.`)
