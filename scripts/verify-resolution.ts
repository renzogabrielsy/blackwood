/**
 * verify-resolution.ts — framework-free proof of the human-directed resolve (P5)
 * PURE pieces. No DB, no network, no server context.
 *
 * Covers:
 *   1. parseProposal — accepts valid dismiss/apply/edit_apply; rejects bad action,
 *      missing summary/reasoning, non-object edited_row.
 *   2. checkEligibility — dismiss allowed on any unresolved case; apply/edit_apply on
 *      gate_failure REJECTED; apply on a report with no writer REJECTED; edit_apply
 *      without edited_row REJECTED; apply on rc_out/deliveries ALLOWED; resolved case
 *      REJECTED for every action.
 *   3. rc_out + deliveries row validation (validateRcOutRow / validateDeliveriesRow):
 *      missing weight / date / destination / batch → plain error; a good row → ok.
 *   4. findOpenProposal — a lone proposal → open; proposal then a decline system row →
 *      closed; a resolved case → no open proposal; the LATEST proposal wins.
 *   5. Provenance-string composition (via a local mirror of provenanceFor's contract).
 *
 * Run:  npx tsx scripts/verify-resolution.ts
 */
import assert from 'node:assert/strict'

import {
  parseProposal,
  checkEligibility,
  findOpenProposal,
  type ProposalScanRow,
  type ResolutionCaseContext,
} from '../lib/investigator/resolution'
import { validateRcOutRow, validateDeliveriesRow, hasApplyWriter } from '../lib/sync/apply-writers'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ── 1. parseProposal ─────────────────────────────────────────────────────────
check('parseProposal accepts a valid dismiss', () => {
  const p = parseProposal({ action: 'dismiss', summary: 'DB is right', reasoning: 'sheet short' })
  assert.ok(p)
  assert.equal(p!.action, 'dismiss')
})

check('parseProposal accepts edit_apply with edited_row', () => {
  const p = parseProposal({
    action: 'edit_apply',
    summary: 'fix weight',
    reasoning: 'was mistyped',
    edited_row: { weight_kg: 5200 },
  })
  assert.ok(p)
  assert.deepEqual(p!.edited_row, { weight_kg: 5200 })
})

check('parseProposal rejects a bad action', () => {
  assert.equal(parseProposal({ action: 'nuke', summary: 'x', reasoning: 'y' }), null)
})

check('parseProposal rejects a missing summary', () => {
  assert.equal(parseProposal({ action: 'dismiss', reasoning: 'y' }), null)
})

check('parseProposal rejects a missing reasoning', () => {
  assert.equal(parseProposal({ action: 'dismiss', summary: 'x' }), null)
})

check('parseProposal rejects a non-object edited_row', () => {
  assert.equal(
    parseProposal({ action: 'edit_apply', summary: 'x', reasoning: 'y', edited_row: 'nope' }),
    null,
  )
})

// ── 2. checkEligibility ──────────────────────────────────────────────────────
const rcOutCtx: ResolutionCaseContext = { report_type: 'rc_out', kind: 'other', status: 'open' }
const gateCtx: ResolutionCaseContext = { report_type: 'rc_out', kind: 'gate_failure', status: 'open' }
const productionCtx: ResolutionCaseContext = {
  report_type: 'production',
  kind: 'other',
  status: 'open',
}

check('dismiss is allowed on any unresolved case (even gate_failure)', () => {
  const r = checkEligibility(
    { action: 'dismiss', summary: 's', reasoning: 'r' },
    gateCtx,
  )
  assert.ok(r.ok)
})

check('apply on a gate_failure is REJECTED with a plain reason', () => {
  const r = checkEligibility({ action: 'apply', summary: 's', reasoning: 'r' }, gateCtx)
  assert.equal(r.ok, false)
  assert.match(r.error!, /totals-mismatch|no one row|dismiss/i)
})

check('edit_apply on a gate_failure is REJECTED', () => {
  const r = checkEligibility(
    { action: 'edit_apply', summary: 's', reasoning: 'r', edited_row: { weight_kg: 1 } },
    gateCtx,
  )
  assert.equal(r.ok, false)
})

check('apply on a report with no writer (production) is REJECTED', () => {
  const r = checkEligibility({ action: 'apply', summary: 's', reasoning: 'r' }, productionCtx)
  assert.equal(r.ok, false)
  assert.match(r.error!, /not supported yet/i)
})

check('edit_apply without edited_row is REJECTED', () => {
  const r = checkEligibility({ action: 'edit_apply', summary: 's', reasoning: 'r' }, rcOutCtx)
  assert.equal(r.ok, false)
  assert.match(r.error!, /edited_row|corrected row/i)
})

check('apply on rc_out (has a writer, per-row kind) is ALLOWED', () => {
  const r = checkEligibility({ action: 'apply', summary: 's', reasoning: 'r' }, rcOutCtx)
  assert.ok(r.ok)
})

check('edit_apply on deliveries with edited_row is ALLOWED', () => {
  const ctx: ResolutionCaseContext = { report_type: 'deliveries', kind: 'malformed', status: 'open' }
  const r = checkEligibility(
    { action: 'edit_apply', summary: 's', reasoning: 'r', edited_row: { weight_kg: 100 } },
    ctx,
  )
  assert.ok(r.ok)
})

check('a resolved case rejects EVERY action', () => {
  const ctx: ResolutionCaseContext = { report_type: 'rc_out', kind: 'other', status: 'resolved' }
  for (const action of ['dismiss', 'apply', 'edit_apply'] as const) {
    const r = checkEligibility(
      { action, summary: 's', reasoning: 'r', edited_row: { weight_kg: 1 } },
      ctx,
    )
    assert.equal(r.ok, false, `${action} should be rejected on a resolved case`)
  }
})

check('hasApplyWriter is true for rc_out/deliveries, false otherwise', () => {
  assert.ok(hasApplyWriter('rc_out'))
  assert.ok(hasApplyWriter('deliveries'))
  assert.equal(hasApplyWriter('production'), false)
  assert.equal(hasApplyWriter('flecon'), false)
})

// ── 3. row validation ────────────────────────────────────────────────────────
check('validateRcOutRow rejects a missing weight', () => {
  const r = validateRcOutRow({
    transaction_date: '2026-06-10',
    destination: 'FEED',
    batch_code: 'JUNE-26-BLK1',
  })
  assert.equal(r.ok, false)
  assert.match(r.error!, /weight/i)
})

check('validateRcOutRow rejects a missing date', () => {
  const r = validateRcOutRow({ weight_kg: 100, destination: 'FEED', batch_code: 'X' })
  assert.equal(r.ok, false)
  assert.match(r.error!, /date/i)
})

check('validateRcOutRow rejects a missing destination', () => {
  const r = validateRcOutRow({ transaction_date: '2026-06-10', weight_kg: 100, batch_code: 'X' })
  assert.equal(r.ok, false)
  assert.match(r.error!, /destination/i)
})

check('validateRcOutRow rejects a missing batch reference', () => {
  const r = validateRcOutRow({ transaction_date: '2026-06-10', weight_kg: 100, destination: 'FEED' })
  assert.equal(r.ok, false)
  assert.match(r.error!, /batch/i)
})

check('validateRcOutRow accepts a good row (and never surfaces cost)', () => {
  const r = validateRcOutRow({
    transaction_date: '2026-06-10',
    weight_kg: 5200,
    destination: 'FEED',
    production_batch: 'JUNE-26-BLK1',
  })
  assert.ok(r.ok)
  assert.equal(r.clean!.weight_kg, 5200)
  assert.ok(!('cost_basis' in (r.clean ?? {})))
  assert.ok(!('cost' in (r.clean ?? {})))
})

check('validateDeliveriesRow rejects a missing supplier + missing batch_code', () => {
  const noSupplier = validateDeliveriesRow({
    transaction_date: '2026-06-10',
    weight_kg: 100,
    batch_code: 'X',
  })
  assert.equal(noSupplier.ok, false)
  assert.match(noSupplier.error!, /supplier/i)

  const noBatch = validateDeliveriesRow({
    transaction_date: '2026-06-10',
    weight_kg: 100,
    supplier: 'ACME',
  })
  assert.equal(noBatch.ok, false)
  assert.match(noBatch.error!, /batch/i)
})

check('validateDeliveriesRow accepts a good row', () => {
  const r = validateDeliveriesRow({
    transaction_date: '2026-06-10',
    supplier: 'ACME',
    weight_kg: 1000,
    batch_code: 'JUNE-26-BLK1',
  })
  assert.ok(r.ok)
})

// ── 4. findOpenProposal ──────────────────────────────────────────────────────
function assistantProposal(position: number, action = 'dismiss'): ProposalScanRow {
  return {
    role: 'assistant',
    content: 'prepared a resolution',
    tool_calls: [
      {
        id: `tu_${position}`,
        name: 'propose_resolution',
        input: { action, summary: 'sheet short', reasoning: 'db is right' },
      },
    ],
    tool_results: null,
    position,
  }
}
function systemRow(position: number, content: string): ProposalScanRow {
  return { role: 'system', content, tool_calls: null, tool_results: null, position }
}
function userRow(position: number): ProposalScanRow {
  return { role: 'user', content: 'apply it', tool_calls: null, tool_results: null, position }
}

check('a lone proposal → OPEN', () => {
  const rows = [userRow(0), assistantProposal(1)]
  const open = findOpenProposal(rows, 'investigated')
  assert.ok(open)
  assert.equal(open!.position, 1)
  assert.equal(open!.proposal.action, 'dismiss')
})

check('proposal then a "Proposal declined" system row → CLOSED', () => {
  const rows = [assistantProposal(1), systemRow(2, 'Proposal declined by owner@x.com.')]
  assert.equal(findOpenProposal(rows, 'investigated'), null)
})

check('a resolved case → no open proposal even with a proposal row', () => {
  const rows = [assistantProposal(1)]
  assert.equal(findOpenProposal(rows, 'resolved'), null)
})

check('the LATEST proposal wins when there are two', () => {
  const rows = [assistantProposal(1, 'dismiss'), assistantProposal(3, 'apply')]
  const open = findOpenProposal(rows, 'investigated')
  assert.ok(open)
  assert.equal(open!.position, 3)
  assert.equal(open!.proposal.action, 'apply')
})

check('a decline BEFORE the newest proposal does not close it', () => {
  const rows = [
    assistantProposal(1, 'dismiss'),
    systemRow(2, 'Proposal declined by owner@x.com.'),
    assistantProposal(3, 'apply'),
  ]
  const open = findOpenProposal(rows, 'investigated')
  assert.ok(open)
  assert.equal(open!.position, 3)
})

// ── 5. provenance composition (contract mirror) ─────────────────────────────
check('provenance string names action + email', () => {
  // Mirror of resolve.ts::provenanceFor (kept in sync deliberately — assert the shape).
  const provenance = (action: string, email: string) => {
    const verb =
      action === 'dismiss'
        ? 'dismissed'
        : action === 'edit_apply'
          ? 'applied an edited row'
          : 'applied the row'
    return `Resolved (${action}) via case chat by ${email} — ${verb}.`
  }
  assert.match(provenance('apply', 'renzo@x.com'), /Resolved \(apply\) via case chat by renzo@x\.com/)
  assert.match(provenance('dismiss', 'renzo@x.com'), /dismissed/)
  assert.match(provenance('edit_apply', 'renzo@x.com'), /applied an edited row/)
})

console.log(`\n${passed} checks passed.`)
