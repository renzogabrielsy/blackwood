/**
 * verify-sync-reducer.ts — framework-free proof that the durable-sync REDUCER
 * (lib/sync/reducer.ts) turns recorded Supabase Realtime payloads into the right
 * card state, WITHOUT a browser or the worker.
 *
 * This is the Wave-4B "prove the wiring" harness. It replays payload shapes
 * captured from the real tables (a `sync_run_events` INSERT `payload.new`, and a
 * terminal `sync_runs` UPDATE `payload.new`) through the SAME pure functions the
 * React hook uses, and asserts the resulting card state. If the worker changes its
 * event/result shape, this fails loudly.
 *
 * Run:  npx tsx scripts/verify-sync-reducer.ts
 * (No test framework is configured at the app root — this uses plain assertions.)
 */
import assert from 'node:assert/strict'

import {
  applyEventToCard,
  deriveCardStatus,
  eventReportType,
  freshCard,
  gateErrorFrom,
  isRunTrack,
  projectEvent,
} from '../lib/sync/reducer'
import type {
  SyncRunEventRow,
  SyncRunReportResult,
} from '../app/(app)/sync/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// --- Recorded `sync_run_events` INSERT payload.new shapes -------------------
// These mirror EXACTLY what the worker's progress.ts emitter writes (run_id,
// report_type, stage, pct, label, detail, level, at) and what arrives on the
// Realtime INSERT as `payload.new`.
const evExtract: SyncRunEventRow = {
  id: 101,
  run_id: 'r1',
  report_type: 'deliveries',
  stage: 'extract',
  pct: 30,
  label: 'Reading the rows…',
  detail: '43 rows',
  level: 'info',
  at: '2026-07-04T01:00:00Z',
}
const evClassify: SyncRunEventRow = {
  ...evExtract,
  id: 102,
  stage: 'classify',
  pct: 62,
  label: 'Comparing against the database…',
  detail: '40 already recorded',
}
const evApply: SyncRunEventRow = {
  ...evExtract,
  id: 103,
  stage: 'apply',
  pct: 88,
  label: 'Writing the new rows…',
  detail: null,
}
const evRunTrack: SyncRunEventRow = {
  id: 5,
  run_id: 'r1',
  report_type: '_run',
  stage: 'fetch',
  pct: 5,
  label: 'Checking Gmail for new reports…',
  detail: null,
  level: 'info',
  at: '2026-07-04T00:59:00Z',
}
const evWarn: SyncRunEventRow = {
  id: 110,
  run_id: 'r1',
  report_type: 'rc_out',
  stage: 'reconcile',
  pct: 60,
  label: 'Cross-checking against the movement total…',
  detail: 'drift 6,300 kg',
  level: 'warn',
  at: '2026-07-04T01:01:00Z',
}
const evTraceback: SyncRunEventRow = {
  id: 111,
  run_id: 'r1',
  report_type: 'deliveries',
  stage: 'classify',
  pct: 62,
  label: 'Traceback (most recent call last):',
  detail: null,
  level: 'info',
  at: '2026-07-04T01:02:00Z',
}
const evBadStage: SyncRunEventRow = { ...evExtract, id: 112, stage: 'nonsense' }

console.log('projectEvent + routing:')
check('valid event projects with clamped/rounded pct', () => {
  const ev = projectEvent(evClassify)
  assert.ok(ev)
  assert.equal(ev!.stage, 'classify')
  assert.equal(ev!.pct, 62)
  assert.equal(ev!.detail, '40 already recorded')
  assert.equal(ev!.level, 'info')
})
check('traceback-looking label is dropped (digestibility guard)', () => {
  assert.equal(projectEvent(evTraceback), null)
})
check('unknown stage is dropped', () => {
  assert.equal(projectEvent(evBadStage), null)
})
check('_run event is routed to the overall track, not a card', () => {
  assert.equal(isRunTrack(evRunTrack), true)
  assert.equal(eventReportType(evRunTrack), null)
})
check('report event routes to its card type', () => {
  assert.equal(isRunTrack(evExtract), false)
  assert.equal(eventReportType(evExtract), 'deliveries')
})
check('unknown report_type routes nowhere', () => {
  assert.equal(eventReportType({ ...evExtract, report_type: 'mystery' }), null)
})

console.log('\napplyEventToCard (the card state machine):')
check('idle → classifying on first extract beat, statusLine composed', () => {
  const c0 = freshCard('deliveries')
  const c1 = applyEventToCard(c0, projectEvent(evExtract)!)
  assert.equal(c1.status, 'classifying')
  assert.equal(c1.pct, 30)
  assert.equal(c1.statusLine, 'Reading the rows… · 43 rows')
  assert.equal(c1.warn, false)
})
check('apply stage flips card to applying; pct is monotonic', () => {
  let c = freshCard('deliveries')
  c = applyEventToCard(c, projectEvent(evExtract)!)
  c = applyEventToCard(c, projectEvent(evClassify)!)
  c = applyEventToCard(c, projectEvent(evApply)!)
  assert.equal(c.status, 'applying')
  assert.equal(c.pct, 88)
  assert.equal(c.statusLine, 'Writing the new rows…')
})
check('pct never decreases even if an out-of-order lower beat arrives', () => {
  let c = freshCard('deliveries')
  c = applyEventToCard(c, projectEvent(evApply)!) // 88
  c = applyEventToCard(c, projectEvent(evExtract)!) // 30 — must not lower pct
  assert.equal(c.pct, 88)
})
check('warn beat tints the card (warn=true) without an error status', () => {
  const c = applyEventToCard(freshCard('rc_out'), projectEvent(evWarn)!)
  assert.equal(c.warn, true)
  assert.notEqual(c.status, 'error')
})
check('a terminal card is not un-finished by a late progress beat', () => {
  const done = { ...freshCard('deliveries'), status: 'done' as const, pct: 100 }
  const c = applyEventToCard(done, projectEvent(evExtract)!)
  assert.equal(c.status, 'done')
  assert.equal(c.pct, 100)
})
check('a STOPPED card is frozen — a late beat cannot revive it', () => {
  const stopped = { ...freshCard('deliveries'), status: 'stopped' as const, pct: 55 }
  const c = applyEventToCard(stopped, projectEvent(evApply)!)
  assert.equal(c.status, 'stopped')
  assert.equal(c.pct, 88) // pct is still monotonic, but status stays 'stopped'
})

console.log('\nterminal result → card status (deriveCardStatus / gateErrorFrom):')
const repClean: SyncRunReportResult = {
  classify: {
    report_type: 'deliveries', ok: true, gate_failures: [],
    counts: { noop: 40, insert: 3, update: 1, flagged: 0 },
    rows_preview: [], classified_path: '/tmp/x', source: {}, watermark: '2026-07-03',
  },
  apply: {
    report_type: 'deliveries', ok: true,
    applied: { inserts: 3, updates: 1, replaced_dates: [] },
    held: [], labeled: true, watermark_updated: true, errors: [],
  },
}
const repGate: SyncRunReportResult = {
  status: 'gate-failed',
  classify: {
    report_type: 'rc_out', ok: false,
    gate_failures: [{ gate: 'PROPOSED-vs-RC-MOVEMENT drift', detail: 'drift 6,300 kg exceeds 500 kg' }],
    counts: { noop: 18, insert: 6, update: 0, flagged: 0 },
    rows_preview: [], classified_path: '/tmp/x', source: {}, watermark: '2026-07-02',
  },
  apply: null,
}
const repHeld: SyncRunReportResult = {
  classify: {
    report_type: 'production', ok: true, gate_failures: [],
    counts: { noop: 22, insert: 9, update: 0, flagged: 2 },
    rows_preview: [], classified_path: '/tmp/x', source: {}, watermark: '2026-07-03',
  },
  apply: {
    report_type: 'production', ok: true,
    applied: { inserts: 9, updates: 0, replaced_dates: [] },
    held: [{ reason: 'unmapped_batch', natural_key: '2026-07-03|WASTE|AYAG', detail: 'no such batch' }],
    labeled: false, watermark_updated: true, errors: [],
  },
}

check('clean per-report result → done, no error', () => {
  assert.equal(deriveCardStatus('deliveries', repClean), 'done')
  assert.equal(gateErrorFrom(repClean), null)
})
check('gate-failed result → gate-failed + copyable gate string', () => {
  assert.equal(deriveCardStatus('rc_out', repGate), 'gate-failed')
  const err = gateErrorFrom(repGate)
  assert.ok(err && err.includes('[PROPOSED-vs-RC-MOVEMENT drift]'))
  assert.ok(err!.includes('drift 6,300 kg'))
})
check('held rows survive on the apply result for aggregation', () => {
  assert.equal(deriveCardStatus('production', repHeld), 'done')
  assert.equal(repHeld.apply!.held.length, 1)
})
check('classify.ok=false with no explicit gate_failures still → gate-failed', () => {
  const rep: SyncRunReportResult = { ...repClean, classify: { ...repClean.classify!, ok: false } }
  assert.equal(deriveCardStatus('deliveries', rep), 'gate-failed')
})

console.log(`\nAll ${passed} reducer-parity checks passed.`)
