/**
 * verify-case-grouping.ts — framework-free assertions over the PURE run-grouping /
 * triage / preselect logic (components/sync/cases/grouping.ts), the T2 review-page
 * spine. No DB, no browser — just the transformations the page performs.
 *
 * Run: npx tsx scripts/verify-case-grouping.ts
 */
import assert from 'node:assert'

import {
  groupCasesByRun,
  filterRowsByCluster,
  preselectForRun,
  isBulkSelectable,
  isTriageCase,
  toTriageView,
  NO_RUN_BUCKET,
  TRIAGE_KIND,
  type GroupingCase,
} from '@/components/sync/cases/grouping'
import { TRIAGE_KIND as TRIAGE_KIND_SERVER } from '@/lib/investigator/triage'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** Minimal case factory. */
function mk(over: Partial<GroupingCase> & { id: string }): GroupingCase {
  return {
    id: over.id,
    report_type: over.report_type ?? 'rc_out',
    kind: over.kind ?? 'gate_failure',
    natural_key: over.natural_key ?? `key-${over.id}`,
    status: over.status ?? 'investigated',
    last_run_id: 'last_run_id' in over ? over.last_run_id ?? null : 'run-A',
    last_seen_at: over.last_seen_at ?? '2026-07-05T00:00:00Z',
    created_at: over.created_at ?? '2026-07-05T00:00:00Z',
    row: over.row ?? null,
    verdict: over.verdict ?? null,
  }
}

/** A triage case for run `runId` clustering the given case ids. */
function mkTriage(runId: string, opts: {
  id: string
  seen: string
  summary: string
  clusters: { title: string; case_ids: string[]; action: 'dismiss' | 'needs-attention' }[]
}): GroupingCase {
  const allIds = opts.clusters.flatMap((c) => c.case_ids)
  return mk({
    id: opts.id,
    kind: TRIAGE_KIND,
    report_type: 'run',
    natural_key: `Run triage — ${runId}`,
    status: 'investigated',
    last_run_id: runId,
    last_seen_at: opts.seen,
    row: {
      clusters: opts.clusters.map((c) => ({
        title: c.title,
        root_cause: 'rc',
        case_ids: c.case_ids,
        suggested_action: c.action,
        reasoning: 'r',
      })),
      case_ids: allIds,
    },
    verdict: { verdict: 'needs-human', confidence: 'high', summary: opts.summary },
  })
}

console.log('\nverify-case-grouping — run grouping / triage / preselect\n')

// ── TRIAGE_KIND agreement (client copy must equal the server source of truth) ──
check('grouping TRIAGE_KIND matches lib/investigator/triage TRIAGE_KIND', () => {
  assert.equal(TRIAGE_KIND, TRIAGE_KIND_SERVER)
  assert.equal(TRIAGE_KIND, 'run_triage')
})

// ── isTriageCase ─────────────────────────────────────────────────────────────
check('isTriageCase true only for run_triage kind', () => {
  assert.equal(isTriageCase({ kind: TRIAGE_KIND }), true)
  assert.equal(isTriageCase({ kind: 'gate_failure' }), false)
})

// ── Run grouping: order (newest run first), no-run bucket last ────────────────
check('groupCasesByRun orders sections newest-run-first', () => {
  const cases = [
    mk({ id: 'a', last_run_id: 'run-old', last_seen_at: '2026-07-01T00:00:00Z' }),
    mk({ id: 'b', last_run_id: 'run-new', last_seen_at: '2026-07-06T00:00:00Z' }),
    mk({ id: 'c', last_run_id: 'run-mid', last_seen_at: '2026-07-03T00:00:00Z' }),
  ]
  const sections = groupCasesByRun(cases)
  assert.deepEqual(sections.map((s) => s.runId), ['run-new', 'run-mid', 'run-old'])
})

check('groupCasesByRun sinks the no-run bucket to the bottom', () => {
  const cases = [
    mk({ id: 'x', last_run_id: null, last_seen_at: '2026-07-09T00:00:00Z' }), // newest but null run
    mk({ id: 'y', last_run_id: 'run-A', last_seen_at: '2026-07-02T00:00:00Z' }),
  ]
  const sections = groupCasesByRun(cases)
  assert.equal(sections[0].runId, 'run-A')
  assert.equal(sections[1].runId, NO_RUN_BUCKET)
})

// ── Triage case excluded from table rows, surfaced as the card ────────────────
check('triage case is pulled OUT of table rows and surfaced as section.triage', () => {
  const triage = mkTriage('run-A', {
    id: 't1', seen: '2026-07-06T00:00:00Z', summary: '5 flags, one cause.',
    clusters: [{ title: 'Movement gap', case_ids: ['a', 'b'], action: 'dismiss' }],
  })
  const cases = [
    triage,
    mk({ id: 'a', last_run_id: 'run-A' }),
    mk({ id: 'b', last_run_id: 'run-A' }),
  ]
  const [section] = groupCasesByRun(cases)
  // Table rows must NOT include the triage case.
  assert.deepEqual(section.rows.map((r) => r.id).sort(), ['a', 'b'])
  assert.ok(!section.rows.some((r) => r.id === 't1'))
  // The triage surfaces as the card.
  assert.ok(section.triage)
  assert.equal(section.triage!.caseId, 't1')
  assert.equal(section.triage!.summary, '5 flags, one cause.')
  assert.deepEqual(section.triage!.caseIds.sort(), ['a', 'b'])
  assert.equal(section.triage!.clusters.length, 1)
  assert.equal(section.triage!.clusters[0].suggested_action, 'dismiss')
})

check('section with no triage case has triage:null', () => {
  const [section] = groupCasesByRun([mk({ id: 'lone', last_run_id: 'run-Z' })])
  assert.equal(section.triage, null)
  assert.equal(section.rows.length, 1)
})

check('a fresh triage keeps its run on top (its last_seen counts toward latestAt)', () => {
  const cases = [
    mk({ id: 'oldrow', last_run_id: 'run-1', last_seen_at: '2026-07-02T00:00:00Z' }),
    mk({ id: 'other', last_run_id: 'run-2', last_seen_at: '2026-07-03T00:00:00Z' }),
    mkTriage('run-1', {
      id: 't', seen: '2026-07-09T00:00:00Z', summary: 's',
      clusters: [{ title: 'g', case_ids: ['oldrow'], action: 'dismiss' }],
    }),
  ]
  const sections = groupCasesByRun(cases)
  assert.equal(sections[0].runId, 'run-1') // its triage is the newest timestamp
})

// ── Cluster chip filtering ────────────────────────────────────────────────────
check('filterRowsByCluster returns all rows when no active cluster', () => {
  const rows = [mk({ id: 'a' }), mk({ id: 'b' }), mk({ id: 'c' })]
  assert.equal(filterRowsByCluster(rows, null).length, 3)
})

check('filterRowsByCluster narrows to a cluster case_ids', () => {
  const rows = [mk({ id: 'a' }), mk({ id: 'b' }), mk({ id: 'c' })]
  const filtered = filterRowsByCluster(rows, ['a', 'c'])
  assert.deepEqual(filtered.map((r) => r.id), ['a', 'c'])
})

check('filterRowsByCluster ignores ids not present in rows', () => {
  const rows = [mk({ id: 'a' })]
  assert.deepEqual(filterRowsByCluster(rows, ['a', 'zzz']).map((r) => r.id), ['a'])
})

// ── ?run= preselection fallback chain ─────────────────────────────────────────
check('preselectForRun → null when run is absent', () => {
  const sections = groupCasesByRun([mk({ id: 'a', last_run_id: 'run-A' })])
  assert.equal(preselectForRun(sections, null), null)
})

check('preselectForRun → null when run not found', () => {
  const sections = groupCasesByRun([mk({ id: 'a', last_run_id: 'run-A' })])
  assert.equal(preselectForRun(sections, 'run-NOPE'), null)
})

check('preselectForRun → triage case id when the run has a triage', () => {
  const cases = [
    mkTriage('run-A', {
      id: 'triage-A', seen: '2026-07-06T00:00:00Z', summary: 's',
      clusters: [{ title: 'g', case_ids: ['a'], action: 'dismiss' }],
    }),
    mk({ id: 'a', last_run_id: 'run-A' }),
  ]
  const sections = groupCasesByRun(cases)
  assert.equal(preselectForRun(sections, 'run-A'), 'triage-A')
})

check('preselectForRun → first row when the run has no triage', () => {
  const cases = [
    mk({ id: 'first', last_run_id: 'run-B' }),
    mk({ id: 'second', last_run_id: 'run-B' }),
  ]
  const sections = groupCasesByRun(cases)
  assert.equal(preselectForRun(sections, 'run-B'), 'first')
})

// ── Bulk-selection eligibility ────────────────────────────────────────────────
check('isBulkSelectable false for triage and resolved rows, true for a real flag', () => {
  assert.equal(isBulkSelectable({ kind: TRIAGE_KIND, status: 'investigated' }), false)
  assert.equal(isBulkSelectable({ kind: 'gate_failure', status: 'resolved' }), false)
  assert.equal(isBulkSelectable({ kind: 'gate_failure', status: 'open' }), true)
  assert.equal(isBulkSelectable({ kind: 'unmapped_batch_code', status: 'investigated' }), true)
})

// ── toTriageView robustness ───────────────────────────────────────────────────
check('toTriageView tolerates a malformed row / missing verdict', () => {
  const c = mk({ id: 't', kind: TRIAGE_KIND, row: null, verdict: null })
  const v = toTriageView(c)
  assert.equal(v.caseId, 't')
  assert.equal(v.clusters.length, 0)
  assert.deepEqual(v.caseIds, [])
  assert.ok(v.summary.length > 0) // falls back to a neutral summary
})

check('toTriageView drops non-string cluster case_ids defensively', () => {
  const c = mk({
    id: 't', kind: TRIAGE_KIND,
    row: { clusters: [{ title: 'g', case_ids: ['a', 123, null] }], case_ids: ['a', 123] },
    verdict: { summary: 'x' },
  })
  const v = toTriageView(c)
  assert.deepEqual(v.clusters[0].case_ids, ['a'])
  assert.deepEqual(v.caseIds, ['a'])
})

console.log(`\n${passed} assertions passed.\n`)
