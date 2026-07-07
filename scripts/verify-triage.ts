/**
 * verify-triage.ts — framework-free proof of the v1.1 Run Triage layer's PURE pieces.
 * No DB, no network, no server context. Run: npx tsx scripts/verify-triage.ts
 *
 * Covers:
 *   1. parseTriage validation + REPAIR — unknown id dropped, missing id → singleton
 *      needs-attention cluster, duplicate id deduped (first cluster wins), empty
 *      cluster dropped, malformed input still partitions all ids.
 *   2. triageFingerprint — stable for the same runId, differs across runIds, differs
 *      from a plain caseFingerprint payload.
 *   3. Group-proposal eligibility (checkGroupEligibility): non-triage case → refused;
 *      apply action → parseGroupProposal rejects (dismiss-only); a resolved triage →
 *      refused; a case not in the run → refused; a resolved member → refused; the
 *      triage id itself in the group → refused; a clean group → ok.
 *   4. findOpenGroupProposal — a lone group proposal → open; then a decline row →
 *      closed; a resolved case → none; the LATEST group proposal wins; it does not
 *      pick up a single propose_resolution.
 *   5. Briefing rendering (buildTriageBriefing) includes every sibling id + the run
 *      label + verdict lines.
 */
import assert from 'node:assert/strict'

import { parseTriage, triageFingerprint, TRIAGE_KIND } from '../lib/investigator/triage'
import { caseFingerprint } from '../lib/sync/fingerprint'
import {
  parseGroupProposal,
  checkGroupEligibility,
  findOpenGroupProposal,
  type GroupResolutionProposal,
  type ProposalScanRow,
} from '../lib/investigator/resolution'
import { buildTriageBriefing, type TriageSiblingBrief } from '../lib/investigator/playbook'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ── 1. parseTriage validation + repair ───────────────────────────────────────
check('parseTriage keeps a clean full partition', () => {
  const r = parseTriage(
    {
      summary: 'Two flags, one cause.',
      clusters: [
        { title: 'A', root_cause: 'x', case_ids: ['a', 'b'], suggested_action: 'dismiss', reasoning: 'r' },
      ],
    },
    ['a', 'b'],
  )
  assert.equal(r.summary, 'Two flags, one cause.')
  assert.equal(r.clusters.length, 1)
  assert.deepEqual(r.clusters[0].case_ids, ['a', 'b'])
  assert.equal(r.clusters[0].suggested_action, 'dismiss')
})

check('parseTriage drops an unknown (invented) case id', () => {
  const r = parseTriage(
    {
      summary: 's',
      clusters: [{ title: 'A', root_cause: 'x', case_ids: ['a', 'ZZZ'], suggested_action: 'dismiss', reasoning: 'r' }],
    },
    ['a'],
  )
  const all = r.clusters.flatMap((c) => c.case_ids)
  assert.deepEqual(all, ['a']) // ZZZ dropped, a survives
})

check('parseTriage appends a missing id as a singleton needs-attention cluster', () => {
  const r = parseTriage(
    {
      summary: 's',
      clusters: [{ title: 'A', root_cause: 'x', case_ids: ['a'], suggested_action: 'dismiss', reasoning: 'r' }],
    },
    ['a', 'b'],
  )
  const all = r.clusters.flatMap((c) => c.case_ids).sort()
  assert.deepEqual(all, ['a', 'b']) // every valid id present exactly once
  const singleton = r.clusters.find((c) => c.case_ids.length === 1 && c.case_ids[0] === 'b')
  assert.ok(singleton)
  assert.equal(singleton!.suggested_action, 'needs-attention')
})

check('parseTriage dedupes an id appearing in two clusters (first wins)', () => {
  const r = parseTriage(
    {
      summary: 's',
      clusters: [
        { title: 'A', root_cause: 'x', case_ids: ['a', 'b'], suggested_action: 'dismiss', reasoning: 'r' },
        { title: 'B', root_cause: 'y', case_ids: ['b', 'c'], suggested_action: 'needs-attention', reasoning: 'r' },
      ],
    },
    ['a', 'b', 'c'],
  )
  const all = r.clusters.flatMap((c) => c.case_ids).sort()
  assert.deepEqual(all, ['a', 'b', 'c']) // b only once
  assert.deepEqual(r.clusters[0].case_ids, ['a', 'b'])
  assert.deepEqual(r.clusters[1].case_ids, ['c']) // b removed from the 2nd cluster
})

check('parseTriage drops a cluster left empty after repair', () => {
  const r = parseTriage(
    {
      summary: 's',
      clusters: [
        { title: 'A', root_cause: 'x', case_ids: ['a'], suggested_action: 'dismiss', reasoning: 'r' },
        { title: 'Ghost', root_cause: 'y', case_ids: ['NOPE'], suggested_action: 'dismiss', reasoning: 'r' },
      ],
    },
    ['a'],
  )
  assert.equal(r.clusters.length, 1) // the all-invalid cluster is gone
  assert.equal(r.clusters[0].title, 'A')
})

check('parseTriage on malformed input still partitions all ids', () => {
  const r = parseTriage(null, ['a', 'b', 'c'])
  const all = r.clusters.flatMap((c) => c.case_ids).sort()
  assert.deepEqual(all, ['a', 'b', 'c'])
  assert.ok(r.summary.length > 0)
  assert.ok(r.clusters.every((c) => c.suggested_action === 'needs-attention'))
})

// ── 2. triageFingerprint ─────────────────────────────────────────────────────
check('triageFingerprint is stable for the same runId', () => {
  assert.equal(triageFingerprint('run-1'), triageFingerprint('run-1'))
})

check('triageFingerprint differs across runIds', () => {
  assert.notEqual(triageFingerprint('run-1'), triageFingerprint('run-2'))
})

check('triageFingerprint is a 64-char sha256 hex', () => {
  assert.match(triageFingerprint('run-1'), /^[0-9a-f]{64}$/)
})

check('triageFingerprint differs from a held-row fingerprint for the same key', () => {
  const held = caseFingerprint('rc_out', {
    reason: 'r',
    natural_key: 'run-1',
    detail: 'd',
    kind: 'other',
  })
  assert.notEqual(triageFingerprint('run-1'), held)
})

// ── 3. Group-proposal eligibility ────────────────────────────────────────────
const goodGroup: GroupResolutionProposal = {
  action: 'dismiss',
  case_ids: ['a', 'b'],
  summary: 'set aside the movement-sheet group',
  reasoning: 'db is right, sheets short',
}

check('parseGroupProposal rejects a non-dismiss action (dismiss-only in v1)', () => {
  assert.equal(parseGroupProposal({ action: 'apply', case_ids: ['a'], summary: 's', reasoning: 'r' }), null)
})

check('parseGroupProposal rejects an empty case_ids list', () => {
  assert.equal(parseGroupProposal({ action: 'dismiss', case_ids: [], summary: 's', reasoning: 'r' }), null)
})

check('parseGroupProposal accepts a clean dismiss group', () => {
  const p = parseGroupProposal({ action: 'dismiss', case_ids: ['a', 'b'], summary: 's', reasoning: 'r' })
  assert.ok(p)
  assert.deepEqual(p!.case_ids, ['a', 'b'])
})

check('checkGroupEligibility refuses a non-triage case', () => {
  const e = checkGroupEligibility(goodGroup, {
    caseKind: 'gate_failure',
    status: 'investigated',
    runCaseIds: ['a', 'b'],
    resolvedIds: [],
    triageCaseId: 't',
  })
  assert.equal(e.ok, false)
  assert.match(e.error!, /run triage/i)
})

check('checkGroupEligibility refuses a resolved triage', () => {
  const e = checkGroupEligibility(goodGroup, {
    caseKind: TRIAGE_KIND,
    status: 'resolved',
    runCaseIds: ['a', 'b'],
    resolvedIds: [],
    triageCaseId: 't',
  })
  assert.equal(e.ok, false)
})

check('checkGroupEligibility refuses a case not in the run family', () => {
  const e = checkGroupEligibility(
    { ...goodGroup, case_ids: ['a', 'x'] },
    { caseKind: TRIAGE_KIND, status: 'investigated', runCaseIds: ['a', 'b'], resolvedIds: [], triageCaseId: 't' },
  )
  assert.equal(e.ok, false)
  assert.match(e.error!, /not part of this run/i)
})

check('checkGroupEligibility refuses an already-resolved member', () => {
  const e = checkGroupEligibility(goodGroup, {
    caseKind: TRIAGE_KIND,
    status: 'investigated',
    runCaseIds: ['a', 'b'],
    resolvedIds: ['b'],
    triageCaseId: 't',
  })
  assert.equal(e.ok, false)
  assert.match(e.error!, /already resolved/i)
})

check('checkGroupEligibility refuses the triage id inside the group', () => {
  const e = checkGroupEligibility(
    { ...goodGroup, case_ids: ['a', 't'] },
    { caseKind: TRIAGE_KIND, status: 'investigated', runCaseIds: ['a', 'b'], resolvedIds: [], triageCaseId: 't' },
  )
  assert.equal(e.ok, false)
  assert.match(e.error!, /triage summary itself/i)
})

check('checkGroupEligibility allows a clean in-family unresolved group', () => {
  const e = checkGroupEligibility(goodGroup, {
    caseKind: TRIAGE_KIND,
    status: 'investigated',
    runCaseIds: ['a', 'b', 'c'],
    resolvedIds: [],
    triageCaseId: 't',
  })
  assert.equal(e.ok, true)
})

// ── 4. findOpenGroupProposal ─────────────────────────────────────────────────
function groupRow(pos: number): ProposalScanRow {
  return {
    role: 'assistant',
    content: 'prepared a group dismiss',
    tool_calls: [
      {
        id: `tu-${pos}`,
        name: 'propose_group_resolution',
        input: { action: 'dismiss', case_ids: ['a', 'b'], summary: `g${pos}`, reasoning: 'r' },
      },
    ],
    tool_results: null,
    position: pos,
  }
}
function declineRow(pos: number): ProposalScanRow {
  return { role: 'system', content: 'Proposal declined by x.', tool_calls: null, tool_results: null, position: pos }
}

check('findOpenGroupProposal returns a lone group proposal', () => {
  const open = findOpenGroupProposal([groupRow(2)], 'investigated')
  assert.ok(open)
  assert.equal(open!.position, 2)
  assert.equal(open!.proposal.summary, 'g2')
})

check('findOpenGroupProposal is closed by a later decline row', () => {
  assert.equal(findOpenGroupProposal([groupRow(2), declineRow(3)], 'investigated'), null)
})

check('findOpenGroupProposal returns null on a resolved case', () => {
  assert.equal(findOpenGroupProposal([groupRow(2)], 'resolved'), null)
})

check('findOpenGroupProposal picks the LATEST group proposal', () => {
  const open = findOpenGroupProposal([groupRow(2), groupRow(5)], 'investigated')
  assert.ok(open)
  assert.equal(open!.position, 5)
  assert.equal(open!.proposal.summary, 'g5')
})

check('findOpenGroupProposal ignores a single propose_resolution', () => {
  const single: ProposalScanRow = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'x', name: 'propose_resolution', input: { action: 'dismiss', summary: 's', reasoning: 'r' } }],
    tool_results: null,
    position: 1,
  }
  assert.equal(findOpenGroupProposal([single], 'investigated'), null)
})

// ── 5. buildTriageBriefing rendering ─────────────────────────────────────────
check('buildTriageBriefing includes the run label, summary, and every sibling', () => {
  const siblings: TriageSiblingBrief[] = [
    {
      id: 'case-1',
      report_type: 'rc_out',
      kind: 'gate_failure',
      natural_key: 'June 10 feeding mismatch',
      status: 'investigated',
      verdict: { verdict: 'skip', confidence: 'high', summary: 'sheet is short' },
    },
    {
      id: 'case-2',
      report_type: 'deliveries',
      kind: 'unmapped_batch_code',
      natural_key: 'JULY-26-BLK9',
      status: 'open',
      verdict: null,
    },
  ]
  const out = buildTriageBriefing(
    { run_label: 'Run triage — 2026-06-10 (abc12345)', summary: '2 flags, 2 causes.' },
    siblings,
  )
  assert.match(out, /Run triage — 2026-06-10/)
  assert.match(out, /2 flags, 2 causes\./)
  assert.match(out, /case-1/)
  assert.match(out, /case-2/)
  assert.match(out, /June 10 feeding mismatch/)
  assert.match(out, /JULY-26-BLK9/)
  assert.match(out, /skip \(high\) — sheet is short/)
  assert.match(out, /propose_group_resolution/)
})

console.log(`\n${passed} checks passed.`)
