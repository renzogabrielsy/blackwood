/**
 * verify-case-fingerprint.ts — framework-free proof of the case-persistence SPINE's
 * two PURE pieces: the fingerprint (lib/sync/fingerprint.ts) and the held-row fold
 * (lib/sync/cases-fold.ts). No DB, no worker, no server context.
 *
 * Asserts:
 *   1. Fingerprint STABILITY — same input twice → same hash.
 *   2. Key-order independence — a gate_failure whose `row` is built with keys in a
 *      different order → SAME hash (canonicalization sorts keys recursively).
 *   3. Gate-failure NUMBERS change → hash CHANGES (a real re-alarm).
 *   4. Other-kind row-PAYLOAD change → hash UNCHANGED (identity is natural_key).
 *   5. collectHeldRows folds a realistic SyncRunResult into the right flat list,
 *      guarding an apply:null report and a no-held report.
 *
 * Run:  npx tsx scripts/verify-case-fingerprint.ts
 * (No test framework is configured at the app root — this uses plain assertions.)
 */
import assert from 'node:assert/strict'

import { caseFingerprint } from '../lib/sync/fingerprint'
import { collectHeldRows } from '../lib/sync/cases-fold'
import type { HeldRow, SyncRunResult } from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ── 1. Fingerprint stability ────────────────────────────────────────────────
check('same input → same hash (stable)', () => {
  const held: HeldRow = {
    reason: 'unmapped batch code',
    natural_key: '2026-07-03|JULY-26-BLK9',
    detail: "batch JULY-26-BLK9 isn't in the system",
    kind: 'unmapped_batch_code',
    row: { batch_code: 'JULY-26-BLK9', transaction_date: '2026-07-03' },
  }
  const a = caseFingerprint('deliveries', held)
  const b = caseFingerprint('deliveries', held)
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/) // sha256 hex
})

// ── 2. Key-order independence (gate_failure) ────────────────────────────────
check('gate_failure: key order in row.drift_dates does not change the hash', () => {
  // Same two drift dates, built with their keys inserted in DIFFERENT orders and
  // the DATES array in DIFFERENT order — must canonicalize to one hash.
  const heldA: HeldRow = {
    reason: 'PROPOSED-vs-RC-MOVEMENT drift',
    natural_key: 'PROPOSED-vs-RC-MOVEMENT drift',
    detail: 'writes halted',
    kind: 'gate_failure',
    row: {
      drift_dates: [
        { date: '2026-06-10', proposed_kg: 71144, movement_kg: 57401, diff_kg: 13743 },
        { date: '2026-06-12', proposed_kg: 5000, movement_kg: null, note: 'no movement entry' },
      ],
    },
  }
  const heldB: HeldRow = {
    reason: 'PROPOSED-vs-RC-MOVEMENT drift',
    natural_key: 'PROPOSED-vs-RC-MOVEMENT drift',
    detail: 'writes halted',
    kind: 'gate_failure',
    row: {
      drift_dates: [
        // Different array order AND different key insertion order:
        { note: 'no movement entry', movement_kg: null, date: '2026-06-12', proposed_kg: 5000 },
        { diff_kg: 13743, movement_kg: 57401, proposed_kg: 71144, date: '2026-06-10' },
      ],
    },
  }
  assert.equal(caseFingerprint('rc_out', heldA), caseFingerprint('rc_out', heldB))
})

// ── 3. Gate-failure numbers change → hash changes ───────────────────────────
check('gate_failure: a changed drift number produces a NEW hash (re-alarm)', () => {
  const base: HeldRow = {
    reason: 'PROPOSED-vs-RC-MOVEMENT drift',
    natural_key: 'PROPOSED-vs-RC-MOVEMENT drift',
    detail: 'writes halted',
    kind: 'gate_failure',
    row: {
      drift_dates: [{ date: '2026-06-10', proposed_kg: 71144, movement_kg: 57401, diff_kg: 13743 }],
    },
  }
  const changed: HeldRow = {
    ...base,
    row: {
      drift_dates: [{ date: '2026-06-10', proposed_kg: 80000, movement_kg: 57401, diff_kg: 22599 }],
    },
  }
  assert.notEqual(caseFingerprint('rc_out', base), caseFingerprint('rc_out', changed))

  // But sub-kg jitter (rounds to the same integer) must NOT change the hash.
  const jitter: HeldRow = {
    ...base,
    row: {
      drift_dates: [{ date: '2026-06-10', proposed_kg: 71144.4, movement_kg: 57401.2, diff_kg: 13743.1 }],
    },
  }
  assert.equal(caseFingerprint('rc_out', base), caseFingerprint('rc_out', jitter))
})

// ── 4. Other-kind payload change → hash unchanged (identity = natural_key) ───
check('non-gate kind: mutating a non-key row field does NOT change the hash', () => {
  const held: HeldRow = {
    reason: 'unmapped batch code',
    natural_key: '2026-07-03|JULY-26-BLK9',
    detail: "batch JULY-26-BLK9 isn't in the system",
    kind: 'unmapped_batch_code',
    row: { batch_code: 'JULY-26-BLK9', transaction_date: '2026-07-03', weight_kg: 5820 },
  }
  const mutated: HeldRow = {
    ...held,
    // Same natural_key, different (excluded) row payload — same case.
    row: { batch_code: 'JULY-26-BLK9', transaction_date: '2026-07-03', weight_kg: 5821, sacks: 99 },
  }
  assert.equal(caseFingerprint('deliveries', held), caseFingerprint('deliveries', mutated))

  // Sanity: a DIFFERENT natural_key IS a different case.
  const other: HeldRow = { ...held, natural_key: '2026-07-03|AUG-26-BLK1' }
  assert.notEqual(caseFingerprint('deliveries', held), caseFingerprint('deliveries', other))
})

// ── 5. collectHeldRows folds a realistic SyncRunResult ──────────────────────
check('collectHeldRows flattens held rows, guarding apply:null and no-held reports', () => {
  // Shapes copied from scripts/dev-fake-run.ts richResult().
  const result: SyncRunResult = {
    reports: {
      // gsheet: clean, has apply with empty held.
      gsheet: {
        classify: null,
        apply: {
          report_type: 'gsheet', ok: true,
          applied: { inserts: 0, updates: 0, replaced_dates: 0 },
          held: [], labeled: true, watermark_updated: true, errors: [],
        },
      },
      // production: TWO held rows.
      production: {
        classify: null,
        apply: {
          report_type: 'production', ok: true,
          applied: { inserts: 9, updates: 0, replaced_dates: 0 },
          held: [
            { reason: 'unmapped_batch', natural_key: '2026-07-03|WASTE|AYAG', detail: 'batch AUG-26-BLK9 missing' },
            { reason: 'meter_rollover', natural_key: '2026-07-03|ELEC|GEN2', detail: 'reading < prior' },
          ],
          labeled: true, watermark_updated: true, errors: [],
        },
      },
      // rc_out: gate-failed → apply is null. Must be guarded (0 held contributed).
      rc_out: {
        status: 'gate-failed',
        classify: null,
        apply: null,
      },
      // deliveries: apply present, held absent-ish (empty array).
      deliveries: {
        classify: null,
        apply: {
          report_type: 'deliveries', ok: true,
          applied: { inserts: 3, updates: 1, replaced_dates: 0 },
          held: [], labeled: true, watermark_updated: true, errors: [],
        },
      },
    },
  }

  const collected = collectHeldRows(result)
  // Only production's 2 held rows survive.
  assert.equal(collected.length, 2)
  assert.equal(collected[0].reportType, 'production')
  assert.equal(collected[0].held.natural_key, '2026-07-03|WASTE|AYAG')
  assert.equal(collected[1].held.natural_key, '2026-07-03|ELEC|GEN2')

  // A result with no `reports` folds to [].
  assert.deepEqual(collectHeldRows({} as SyncRunResult), [])
})

console.log(`\nAll ${passed} case-fingerprint checks passed.`)
