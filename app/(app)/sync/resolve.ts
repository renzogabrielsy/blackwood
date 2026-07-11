'use server'

/**
 * resolve.ts — HUMAN-DIRECTED RESOLUTION (P5) of a held case.
 *
 * The investigator NEVER writes. A resolution is applied ONLY when the reviewer
 * clicks Confirm on a proposal the agent prepared (propose_resolution), which fires
 * executeResolution — a separate server action that re-reads the proposal FROM THE DB
 * (never trusting a client payload), re-checks eligibility (defense in depth), and:
 *   - dismiss    → NO operational write.
 *   - apply      → route the case's own row through the deterministic writer registry.
 *   - edit_apply → route the proposal's edited_row through the same writer, validated
 *                  like the sync applies it.
 *
 * Every resolution writes a sync_case_rulings row (the known-issues ledger) + a case
 * system message trail + full provenance ("resolved via case chat by <email>"), and
 * flips the case to 'resolved' with known_ruling_id pointing at the new ruling.
 *
 * Never deletes. Price gating: apply payloads never carry ₱ (rc_out has none;
 * deliveries.cost_basis is forced 0 by the writer per L-008).
 *
 * The pure-ish core is factored into executeResolutionInternal(admin, caseRow,
 * proposal, provenance) so the live-smoke script can drive it with a service-role
 * client, bypassing requirePrivileged.
 */
import { revalidatePath } from 'next/cache'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePrivileged } from '@/lib/sync/privileged'
import type { Json } from '@/types/supabase'
import {
  parseProposal,
  parseGroupProposal,
  checkEligibility,
  checkGroupEligibility,
  findOpenProposal,
  findOpenGroupProposal,
  type ResolutionProposal,
  type ResolutionCaseContext,
  type GroupResolutionProposal,
} from '@/lib/investigator/resolution'
import { APPLY_WRITERS } from '@/lib/sync/apply-writers'
import { sourceDiffNaturalKey } from '@/lib/sync/fingerprint'
import {
  computeDiffWritePlan,
  diffResolutionProvenance,
  pickSourceRulingSummary,
  findOpenPickSourcePlan,
  parsePickSourceInput,
  PICK_SOURCE_TOOL,
  type DbRcOutRow,
  type DiffWritePlan,
  type DiffPlanStep,
  type PickSourceProposalInput,
} from './diff-plan'
import {
  CREATE_BATCH_TOOL,
  FEED_LOCATION_REF,
  buildCreateBatchPlan,
  createBatchProvenance,
  createBatchRulingSummary,
  findOpenCreateBatchPlan,
  parseCreateBatchInput,
  type CreateBatchPlan,
  type CreateBatchProposalInput,
} from '@/lib/sync/create-batch-plan'
import type { RcOutSource, SourceDiff, SourceLegRow, SyncReportType } from './types'
import { randomUUID } from 'node:crypto'

type AdminClient = ReturnType<typeof createAdminClient>

export interface ResolveResult {
  ok: boolean
  error?: string
  ruling_id?: string
}

/** The subset of a sync_held_cases row the resolution path needs. */
interface CaseRow {
  id: string
  report_type: string
  kind: string
  status: string
  fingerprint: string
  row: unknown
}

/**
 * The ONE dismissal-write code path — shared by quickDismiss, the dismiss branch of
 * executeResolutionInternal, group dismiss, and bulk dismiss. Writes a
 * sync_case_rulings row (action 'dismiss', THIS case's fingerprint, so each dismissal
 * enters the ledger individually), flips the case to resolved + known_ruling_id, and
 * appends a system message. Idempotent-guarded by the caller (must not be resolved).
 * Does NO operational write (dismiss never touches operational data). Returns the new
 * ruling id.
 */
async function dismissOneCase(
  admin: AdminClient,
  caseRow: CaseRow,
  summary: string,
  reasoning: string,
  ruledBy: string | null,
  ruledByEmail: string,
  systemMessage: string,
): Promise<ResolveResult> {
  // 1. Ledger row (keyed by THIS case's fingerprint).
  const { data: ruling, error: rulingErr } = await admin
    .from('sync_case_rulings')
    .insert({
      fingerprint: caseRow.fingerprint,
      case_id: caseRow.id,
      action: 'dismiss',
      verdict_summary: summary,
      reasoning,
      ruled_by: ruledBy,
      ruled_by_email: ruledByEmail,
    })
    .select('id')
    .single()
  if (rulingErr) return { ok: false, error: `Recording the ruling failed: ${rulingErr.message}` }
  const rulingId = ruling.id as string

  // 2. Flip the case to resolved + pin the ruling.
  const { error: updErr } = await admin
    .from('sync_held_cases')
    .update({
      status: 'resolved',
      known_ruling_id: rulingId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseRow.id)
  if (updErr) return { ok: false, error: `Marking the case resolved failed: ${updErr.message}` }

  // 3. System-message trail.
  const pos = await nextMessagePosition(admin, caseRow.id)
  await admin.from('sync_case_messages').insert({
    case_id: caseRow.id,
    role: 'system',
    content: systemMessage,
    tool_calls: null,
    tool_results: null,
    position: pos,
  })

  return { ok: true, ruling_id: rulingId }
}

/** Map a proposal action to the sync_case_rulings.action CHECK value. */
function rulingAction(action: ResolutionProposal['action']): string {
  // The CHECK allows dismiss | apply | edit_apply | override_gate.
  return action // dismiss | apply | edit_apply — all valid.
}

/** Compose the provenance string stamped on every write + ruling + trail. */
function provenanceFor(action: ResolutionProposal['action'], email: string): string {
  const verb =
    action === 'dismiss'
      ? 'dismissed'
      : action === 'edit_apply'
        ? 'applied an edited row'
        : 'applied the row'
  return `Resolved (${action}) via case chat by ${email} — ${verb}.`
}

/** Next monotonic message position for a case. */
async function nextMessagePosition(admin: AdminClient, caseId: string): Promise<number> {
  const { data } = await admin
    .from('sync_case_messages')
    .select('position')
    .eq('case_id', caseId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.position ?? -1) + 1
}

/**
 * The core resolution executor — client-injectable so the live-smoke script can run
 * it with a service-role client (no requirePrivileged). Does the dispatch, ruling
 * insert, case flip, and system-message trail. Returns the new ruling id.
 *
 * `ruledBy` is the profile/user id (nullable — the smoke path may pass null);
 * `ruledByEmail` stamps the human identity into the ledger + provenance.
 */
export async function executeResolutionInternal(
  admin: AdminClient,
  caseRow: CaseRow,
  proposal: ResolutionProposal,
  ruledBy: string | null,
  ruledByEmail: string,
): Promise<ResolveResult> {
  const ctx: ResolutionCaseContext = {
    report_type: caseRow.report_type,
    kind: caseRow.kind,
    status: caseRow.status,
  }
  const elig = checkEligibility(proposal, ctx)
  if (!elig.ok) return { ok: false, error: elig.error }

  // Dismiss = NO operational write — route through the shared per-case dismissal path
  // (one code path for quickDismiss / group / bulk / this).
  if (proposal.action === 'dismiss') {
    return dismissOneCase(
      admin,
      caseRow,
      proposal.summary,
      proposal.reasoning,
      ruledBy,
      ruledByEmail,
      `Resolved (dismiss) by ${ruledByEmail}: ${proposal.summary}`,
    )
  }

  const provenance = provenanceFor(proposal.action, ruledByEmail)

  // 1. Dispatch the operational write (apply / edit_apply).
  let writeNote = ''
  const writer = APPLY_WRITERS[caseRow.report_type]
  if (!writer) {
    return {
      ok: false,
      error: `Saving a ${caseRow.report_type} row from a case is not supported yet — dismiss, or run the row through the sync employee.`,
    }
  }
  const rowToWrite =
    proposal.action === 'edit_apply'
      ? proposal.edited_row ?? {}
      : (caseRow.row as Record<string, unknown> | null) ?? {}
  try {
    const outcome = await writer(rowToWrite, admin, provenance)
    writeNote = ` Wrote 1 row to ${outcome.table}, id ${outcome.record_id}.`
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }

  // 2. Ledger row (the known-issues ledger, keyed by fingerprint).
  const { data: ruling, error: rulingErr } = await admin
    .from('sync_case_rulings')
    .insert({
      fingerprint: caseRow.fingerprint,
      case_id: caseRow.id,
      action: rulingAction(proposal.action),
      verdict_summary: proposal.summary,
      reasoning: proposal.reasoning,
      ruled_by: ruledBy,
      ruled_by_email: ruledByEmail,
    })
    .select('id')
    .single()
  if (rulingErr) return { ok: false, error: `Recording the ruling failed: ${rulingErr.message}` }
  const rulingId = ruling.id as string

  // 3. Flip the case to resolved + pin the ruling.
  const { error: updErr } = await admin
    .from('sync_held_cases')
    .update({
      status: 'resolved',
      known_ruling_id: rulingId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseRow.id)
  if (updErr) return { ok: false, error: `Marking the case resolved failed: ${updErr.message}` }

  // 4. System-message trail.
  const pos = await nextMessagePosition(admin, caseRow.id)
  await admin.from('sync_case_messages').insert({
    case_id: caseRow.id,
    role: 'system',
    content: `Resolved (${proposal.action}) by ${ruledByEmail}: ${proposal.summary}${writeNote}`,
    tool_calls: null,
    tool_results: null,
    position: pos,
  })

  return { ok: true, ruling_id: rulingId }
}

/**
 * The confirm-gated resolution write. requirePrivileged; re-reads the proposal from
 * the named message row (must belong to this case, must carry a propose_resolution
 * tool_use); guards double-execution; then runs executeResolutionInternal.
 */
export async function executeResolution(
  caseId: string,
  proposalMessageId: string,
): Promise<ResolveResult> {
  const userId = await requirePrivileged()
  const admin = createAdminClient()

  // Resolve the reviewer's email for provenance.
  const email = await resolveEmail(admin, userId)

  // 1. Load the case.
  const { data: theCase, error: caseErr } = await admin
    .from('sync_held_cases')
    .select('id, report_type, kind, status, fingerprint, row')
    .eq('id', caseId)
    .maybeSingle()
  if (caseErr) return { ok: false, error: `Could not load the case: ${caseErr.message}` }
  if (!theCase) return { ok: false, error: 'Case not found.' }
  if (theCase.status === 'resolved') {
    return { ok: false, error: 'This case is already resolved.' }
  }
  if (theCase.status === 'investigating') {
    return { ok: false, error: 'The investigator is still working on this case — wait for it to finish.' }
  }

  // 2. Load the proposal message row and re-read the proposal from the DB.
  const { data: msg, error: msgErr } = await admin
    .from('sync_case_messages')
    .select('id, case_id, tool_calls, position')
    .eq('id', proposalMessageId)
    .maybeSingle()
  if (msgErr) return { ok: false, error: `Could not load the proposal: ${msgErr.message}` }
  if (!msg || msg.case_id !== caseId) {
    return { ok: false, error: 'That proposal does not belong to this case.' }
  }

  const proposal = extractProposalFromToolCalls(msg.tool_calls)
  if (!proposal) {
    return { ok: false, error: 'That message does not contain a resolution proposal.' }
  }

  // 3. Guard double-execution: the proposal must still be the OPEN one (no later
  //    ruling / decline closed it). Re-scan the transcript.
  const { data: history, error: histErr } = await admin
    .from('sync_case_messages')
    .select('role, content, tool_calls, tool_results, position')
    .eq('case_id', caseId)
    .order('position', { ascending: true })
  if (histErr) return { ok: false, error: `Could not verify the proposal: ${histErr.message}` }
  const open = findOpenProposal(history ?? [], theCase.status)
  if (!open || open.position !== msg.position) {
    return {
      ok: false,
      error: 'This proposal is no longer the current one (it was superseded, declined, or already resolved).',
    }
  }

  const result = await executeResolutionInternal(admin, theCase as CaseRow, proposal, userId, email)
  if (result.ok) revalidatePath('/sync/cases')
  return result
}

/**
 * Decline an open proposal: writes a "Proposal declined" system row so the UI clears
 * the card server-side (findOpenProposal treats a later decline row as closing the
 * proposal). No other effect.
 */
export async function cancelProposal(
  caseId: string,
  proposalMessageId: string,
): Promise<ResolveResult> {
  const userId = await requirePrivileged()
  const admin = createAdminClient()
  const email = await resolveEmail(admin, userId)

  // Confirm the message belongs to the case (light guard — decline is harmless).
  const { data: msg, error: msgErr } = await admin
    .from('sync_case_messages')
    .select('case_id')
    .eq('id', proposalMessageId)
    .maybeSingle()
  if (msgErr) return { ok: false, error: `Could not load the proposal: ${msgErr.message}` }
  if (!msg || msg.case_id !== caseId) {
    return { ok: false, error: 'That proposal does not belong to this case.' }
  }

  const pos = await nextMessagePosition(admin, caseId)
  const { error: insErr } = await admin.from('sync_case_messages').insert({
    case_id: caseId,
    role: 'system',
    content: `Proposal declined by ${email}.`,
    tool_calls: null,
    tool_results: null,
    position: pos,
  })
  if (insErr) return { ok: false, error: `Could not decline the proposal: ${insErr.message}` }

  revalidatePath('/sync/cases')
  return { ok: true }
}

/**
 * A one-click dismiss from the actions bar — human-directed by definition (the human
 * typed the reason and clicked). Synthesizes a dismiss ruling directly (same
 * ruling + message + status writes as an agent-proposed dismiss), with a required
 * "why" reason. No operational write.
 */
export async function quickDismiss(caseId: string, reason: string): Promise<ResolveResult> {
  const userId = await requirePrivileged()
  const trimmed = (reason ?? '').trim()
  if (!trimmed) return { ok: false, error: 'Give a reason for dismissing this case.' }

  const admin = createAdminClient()
  const email = await resolveEmail(admin, userId)

  const { data: theCase, error: caseErr } = await admin
    .from('sync_held_cases')
    .select('id, report_type, kind, status, fingerprint, row')
    .eq('id', caseId)
    .maybeSingle()
  if (caseErr) return { ok: false, error: `Could not load the case: ${caseErr.message}` }
  if (!theCase) return { ok: false, error: 'Case not found.' }
  if (theCase.status === 'resolved') return { ok: false, error: 'This case is already resolved.' }
  if (theCase.status === 'investigating') {
    return { ok: false, error: 'The investigator is still working on this case — wait for it to finish.' }
  }

  const result = await dismissOneCase(
    admin,
    theCase as CaseRow,
    trimmed,
    `Quick-dismissed by ${email}.`,
    userId,
    email,
    `Resolved (dismiss) via case chat by ${email}: ${trimmed}`,
  )
  if (result.ok) revalidatePath('/sync/cases')
  return result
}

// ============================================================================
// GROUP dismiss (v1.1 Run Triage) + bulk dismiss.
// ============================================================================

export interface GroupResolveResult {
  ok: boolean
  /** How many cases were dismissed. */
  resolved: number
  /** Per-case failures (id + message) — successes are NOT rolled back. */
  errors: Array<{ caseId: string; error: string }>
  /** Set when the triage case itself was also resolved (all flags cleared). */
  triageResolved?: boolean
}

/**
 * Dismiss a WHOLE GROUP of a run's flags via the run-triage chat (v1.1). Re-reads the
 * group proposal FROM THE DB message row (never a client payload), validates it against
 * the triage case's run family, then dismisses each listed case INDIVIDUALLY (one
 * ruling per case, each entering the ledger under its own fingerprint). Processes
 * sequentially, collects per-case errors, does NOT roll back successes (each dismissal
 * is independent + status-guarded, so a re-run is idempotent).
 *
 * If every non-triage case of the run ends up resolved, the triage case itself is also
 * resolved.
 */
export async function executeGroupResolution(
  triageCaseId: string,
  proposalMessageId: string,
): Promise<GroupResolveResult> {
  const userId = await requirePrivileged()
  const admin = createAdminClient()
  const email = await resolveEmail(admin, userId)

  const fail = (error: string): GroupResolveResult => ({ ok: false, resolved: 0, errors: [{ caseId: triageCaseId, error }] })

  // 1. Load the triage case.
  const { data: triage, error: tErr } = await admin
    .from('sync_held_cases')
    .select('id, report_type, kind, status, last_run_id, row, fingerprint')
    .eq('id', triageCaseId)
    .maybeSingle()
  if (tErr) return fail(`Could not load the run triage: ${tErr.message}`)
  if (!triage) return fail('Run triage not found.')
  if (triage.kind !== 'run_triage') return fail('That is not a run triage — group dismiss only works from a run summary.')
  if (triage.status === 'resolved') return fail('This run triage is already resolved.')

  // 2. Load the proposal message + re-read the group proposal from the DB row.
  const { data: msg, error: msgErr } = await admin
    .from('sync_case_messages')
    .select('id, case_id, tool_calls, position')
    .eq('id', proposalMessageId)
    .maybeSingle()
  if (msgErr) return fail(`Could not load the proposal: ${msgErr.message}`)
  if (!msg || msg.case_id !== triageCaseId) return fail('That proposal does not belong to this run triage.')

  const proposal = extractGroupProposalFromToolCalls(msg.tool_calls)
  if (!proposal) return fail('That message does not contain a group dismiss proposal.')

  // 3. Guard double-execution: the proposal must still be the OPEN group proposal.
  const { data: history, error: histErr } = await admin
    .from('sync_case_messages')
    .select('role, content, tool_calls, tool_results, position')
    .eq('case_id', triageCaseId)
    .order('position', { ascending: true })
  if (histErr) return fail(`Could not verify the proposal: ${histErr.message}`)
  const open = findOpenGroupProposal(history ?? [], triage.status)
  if (!open || open.position !== msg.position) {
    return fail('This group proposal is no longer the current one (it was superseded, declined, or already resolved).')
  }

  // 4. Build the run family + resolved set for eligibility (defense in depth).
  const runCaseIds = extractRunCaseIds(triage.row)
  const { data: familyRows } = await admin
    .from('sync_held_cases')
    .select('id, status')
    .eq('last_run_id', triage.last_run_id)
    .neq('kind', 'run_triage')
  const resolvedIds = (familyRows ?? []).filter((r) => r.status === 'resolved').map((r) => r.id)

  const elig = checkGroupEligibility(proposal, {
    caseKind: triage.kind,
    status: triage.status,
    runCaseIds,
    resolvedIds,
    triageCaseId,
  })
  if (!elig.ok) return fail(elig.error ?? 'This group cannot be dismissed.')

  // 5. Dismiss each case individually (sequential; collect per-case errors).
  const errors: Array<{ caseId: string; error: string }> = []
  const resolvedNow: string[] = []
  for (const caseId of proposal.case_ids) {
    const { data: c, error: cErr } = await admin
      .from('sync_held_cases')
      .select('id, report_type, kind, status, fingerprint, row')
      .eq('id', caseId)
      .maybeSingle()
    if (cErr || !c) {
      errors.push({ caseId, error: cErr?.message ?? 'case not found' })
      continue
    }
    if (c.status === 'resolved') {
      // Already resolved — treat as a no-op success (idempotent).
      resolvedNow.push(caseId)
      continue
    }
    const res = await dismissOneCase(
      admin,
      c as CaseRow,
      proposal.summary,
      proposal.reasoning,
      userId,
      email,
      `Dismissed via run triage by ${email}: ${proposal.summary}`,
    )
    if (res.ok) resolvedNow.push(caseId)
    else errors.push({ caseId, error: res.error ?? 'dismiss failed' })
  }

  // 6. A system note on the triage case listing what was dismissed.
  const triagePos = await nextMessagePosition(admin, triageCaseId)
  await admin.from('sync_case_messages').insert({
    case_id: triageCaseId,
    role: 'system',
    content: `Dismissed ${resolvedNow.length} of ${proposal.case_ids.length} flags via run triage by ${email}: ${proposal.summary}`,
    tool_calls: null,
    tool_results: null,
    position: triagePos,
  })

  // 7. If every non-triage case of the run is now resolved, resolve the triage case too.
  let triageResolved = false
  const { data: remaining } = await admin
    .from('sync_held_cases')
    .select('id')
    .eq('last_run_id', triage.last_run_id)
    .neq('kind', 'run_triage')
    .neq('status', 'resolved')
    .limit(1)
  if ((remaining ?? []).length === 0) {
    const tRes = await dismissOneCase(
      admin,
      triage as CaseRow,
      'All flags in this run resolved.',
      'Every individual flag on this run has been dismissed or resolved.',
      userId,
      email,
      `Run triage closed by ${email}: all flags in this run resolved.`,
    )
    triageResolved = tRes.ok
  }

  revalidatePath('/sync/cases')
  return { ok: errors.length === 0, resolved: resolvedNow.length, errors, triageResolved }
}

/**
 * Direct multi-select bulk dismiss (the review page's selection path). Same per-case
 * ruling writes as a group dismiss (one ruling per case under its own fingerprint),
 * provenance "bulk-dismissed by <email>". Sequential, collects per-case errors, does
 * not roll back successes. Requires a reason.
 */
export async function bulkDismissCases(caseIds: string[], reason: string): Promise<GroupResolveResult> {
  const userId = await requirePrivileged()
  const trimmed = (reason ?? '').trim()
  if (!trimmed) return { ok: false, resolved: 0, errors: [{ caseId: '', error: 'Give a reason for dismissing these cases.' }] }
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    return { ok: false, resolved: 0, errors: [{ caseId: '', error: 'No cases selected.' }] }
  }

  const admin = createAdminClient()
  const email = await resolveEmail(admin, userId)

  const errors: Array<{ caseId: string; error: string }> = []
  let resolved = 0
  for (const caseId of caseIds) {
    const { data: c, error: cErr } = await admin
      .from('sync_held_cases')
      .select('id, report_type, kind, status, fingerprint, row')
      .eq('id', caseId)
      .maybeSingle()
    if (cErr || !c) {
      errors.push({ caseId, error: cErr?.message ?? 'case not found' })
      continue
    }
    if (c.kind === 'run_triage') {
      errors.push({ caseId, error: 'A run triage summary cannot be dismissed directly — dismiss its flags.' })
      continue
    }
    if (c.status === 'resolved') {
      resolved++ // idempotent no-op
      continue
    }
    const res = await dismissOneCase(
      admin,
      c as CaseRow,
      trimmed,
      `Bulk-dismissed by ${email}.`,
      userId,
      email,
      `Resolved (dismiss) — bulk-dismissed by ${email}: ${trimmed}`,
    )
    if (res.ok) resolved++
    else errors.push({ caseId, error: res.error ?? 'dismiss failed' })
  }

  revalidatePath('/sync/cases')
  return { ok: errors.length === 0, resolved, errors }
}

// ============================================================================
// Helpers.
// ============================================================================

/** Pull a propose_resolution proposal out of an assistant row's tool_calls jsonb. */
function extractProposalFromToolCalls(toolCalls: unknown): ResolutionProposal | null {
  if (!Array.isArray(toolCalls)) return null
  for (const tc of toolCalls) {
    if (tc && typeof tc === 'object') {
      const o = tc as Record<string, unknown>
      if (o.name === 'propose_resolution') {
        return parseProposal(o.input)
      }
    }
  }
  return null
}

/** Pull a propose_group_resolution proposal out of an assistant row's tool_calls jsonb. */
function extractGroupProposalFromToolCalls(toolCalls: unknown): GroupResolutionProposal | null {
  if (!Array.isArray(toolCalls)) return null
  for (const tc of toolCalls) {
    if (tc && typeof tc === 'object') {
      const o = tc as Record<string, unknown>
      if (o.name === 'propose_group_resolution') {
        return parseGroupProposal(o.input)
      }
    }
  }
  return null
}

/** Read the run's sibling case ids off a triage case's row.case_ids jsonb (loose). */
function extractRunCaseIds(row: unknown): string[] {
  if (!row || typeof row !== 'object') return []
  const ids = (row as { case_ids?: unknown }).case_ids
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

/** Resolve a user id to their email (for provenance / the ledger). */
async function resolveEmail(admin: AdminClient, userId: string): Promise<string> {
  const { data } = await admin.from('profiles').select('email').eq('id', userId).maybeSingle()
  return (data?.email as string | undefined) ?? userId
}

// ============================================================================
// R3a — PICK-SOURCE resolution of a `source_diff` case (the Sync Reconciliation
// Model's Stage-3 human arbitration). The reviewer picks WHICH source's value is
// authoritative for a natural key; we translate that into a per-leg rc_out write plan
// (diff-plan.ts) and, on an explicit confirm, apply it under a full audit trail + a
// `pick_source` ruling. NEVER auto-picks; NEVER hard-deletes; a `remove` step only
// zeroes a weight, and only ever inside a confirmed + audited plan here.
// ============================================================================

export interface PickSourceResult {
  ok: boolean
  error?: string
  /** The persisted proposal message id — the `proposalRef` for executeDiffResolution. */
  proposal_message_id?: string
  /** The new ruling id (execute only). */
  ruling_id?: string
  /** The computed plan — the confirm UI renders exactly what picking this source changes. */
  plan?: DiffWritePlan
}

/** The subset of a source_diff case row the pick-source path needs. */
interface DiffCaseRow {
  id: string
  report_type: string
  kind: string
  status: string
  fingerprint: string
  natural_key: string
  row: unknown
}

const DIFF_CASE_COLS = 'id, report_type, kind, status, fingerprint, natural_key, row'

/**
 * PROPOSE picking `source` as authoritative for a source_diff case. Validates the case
 * is an unresolved source_diff and `source` is one of the diff's competing sources;
 * reads the LIVE rc_out legs at the natural key; computes the pure write plan
 * (computeDiffWritePlan); and PERSISTS it as an assistant message carrying one
 * propose_pick_source tool_use (mirrors P5 propose_resolution so findOpen*-detection +
 * sanitize replay both work). Writes NOTHING to rc_out. Returns the plan + the proposal
 * message id for the confirm step.
 */
export async function proposePickSource(
  caseId: string,
  source: RcOutSource,
): Promise<PickSourceResult> {
  await requirePrivileged()
  const admin = createAdminClient()

  // 1. Load + validate the case.
  const { data: theCase, error: caseErr } = await admin
    .from('sync_held_cases')
    .select(DIFF_CASE_COLS)
    .eq('id', caseId)
    .maybeSingle()
  if (caseErr) return { ok: false, error: `Could not load the case: ${caseErr.message}` }
  if (!theCase) return { ok: false, error: 'Case not found.' }
  const c = theCase as DiffCaseRow
  if (c.kind !== 'source_diff') {
    return { ok: false, error: 'This is not a source-disagreement case — pick-source only applies to a source_diff.' }
  }
  if (c.status === 'resolved') return { ok: false, error: 'This case is already resolved.' }
  if (c.status === 'investigating') {
    return { ok: false, error: 'The investigator is still working on this case — wait for it to finish.' }
  }

  // 2. Parse the SourceDiff off the case row + validate the picked source.
  const diff = c.row as SourceDiff | null
  if (!diff || !Array.isArray(diff.sources)) {
    return { ok: false, error: 'This case has no reconciliation detail to resolve.' }
  }
  const opinion = diff.sources.find((s) => s.source === source)
  if (!opinion) {
    const avail = diff.sources.map((s) => s.source).join(', ')
    return { ok: false, error: `"${source}" is not one of the sources in this disagreement (${avail}).` }
  }

  // 3. Read the LIVE rc_out legs at the natural key (date + block + destination — the
  //    physical grain that identifies a block's feedings on a day; a batch mismatch just
  //    makes the plan AMBIGUOUS, which is safe). source_diff keys always carry a block.
  const key = diff.naturalKey
  if (!key.block_loc) {
    return { ok: false, error: 'This disagreement has no block location, so its feeding legs cannot be located to rewrite.' }
  }
  const dest = key.destination ?? 'MAIN'
  const { data: liveRows, error: liveErr } = await admin
    .from('rc_out')
    .select('id, transaction_date, batch_id, block_loc, destination, weight_kg, production_batch, remarks')
    .eq('transaction_date', key.transaction_date)
    .eq('block_loc', key.block_loc)
    .eq('destination', dest)
  if (liveErr) return { ok: false, error: `Could not read the current feedings: ${liveErr.message}` }

  const dbRows: DbRcOutRow[] = (liveRows ?? []).map((r) => ({
    id: r.id as string,
    transaction_date: r.transaction_date as string,
    batch_id: (r.batch_id as string | null) ?? null,
    block_loc: (r.block_loc as string | null) ?? null,
    destination: (r.destination as string | null) ?? null,
    weight_kg: Number(r.weight_kg ?? 0),
    production_batch: (r.production_batch as string | null) ?? null,
    remarks: (r.remarks as string | null) ?? null,
  }))

  // 4. Compute the pure per-leg write plan.
  const plan = computeDiffWritePlan({ source, dbRows, sourceRows: opinion.rows ?? [] })

  // 5. Persist the proposal (assistant row + one propose_pick_source tool_use).
  const input: PickSourceProposalInput = {
    source,
    field: diff.field,
    naturalKeyLabel: c.natural_key,
    plan,
  }
  const toolUseId = `pick_${randomUUID()}`
  const pos = await nextMessagePosition(admin, caseId)
  const { data: msg, error: insErr } = await admin
    .from('sync_case_messages')
    .insert({
      case_id: caseId,
      role: 'assistant',
      content: pickProposalNarration(input),
      tool_calls: [{ id: toolUseId, name: PICK_SOURCE_TOOL, input }] as unknown as Json,
      tool_results: null,
      position: pos,
    })
    .select('id')
    .single()
  if (insErr) return { ok: false, error: `Could not save the proposal: ${insErr.message}` }

  return { ok: true, proposal_message_id: msg.id as string, plan }
}

/**
 * EXECUTE a pick-source resolution the reviewer confirmed. requirePrivileged; re-reads
 * the plan FROM THE PERSISTED PROPOSAL (never a client payload); guards it is still the
 * OPEN proposal; then:
 *   - ambiguous plan → NO write, returns an error routing the UI to P5 edit-then-apply;
 *   - else applies each step (EDIT-preferred; INSERT via the deterministic rc_out writer;
 *     `remove` = soft-zero) each stamped with write_ingestion_audit provenance.
 * Records a `pick_source` sync_case_rulings row, flips the case resolved + pins the
 * ruling, and appends a system trail. revalidates the review page.
 *
 * NOTE — this write is a HUMAN CORRECTION. Until R4 retires "Sheet-wins", a later gsheet
 * run may re-overwrite it; the `pick_source` ruling recorded here is exactly what R4
 * consults to STOP that clobbering (see the migration comment + LEARNING_LEDGER L-037).
 */
export async function executeDiffResolution(
  caseId: string,
  proposalRef: string,
): Promise<PickSourceResult> {
  const userId = await requirePrivileged()
  const admin = createAdminClient()
  const email = await resolveEmail(admin, userId)

  // 1. Load the case.
  const { data: theCase, error: caseErr } = await admin
    .from('sync_held_cases')
    .select(DIFF_CASE_COLS)
    .eq('id', caseId)
    .maybeSingle()
  if (caseErr) return { ok: false, error: `Could not load the case: ${caseErr.message}` }
  if (!theCase) return { ok: false, error: 'Case not found.' }
  const c = theCase as DiffCaseRow
  if (c.kind !== 'source_diff') return { ok: false, error: 'This is not a source-disagreement case.' }
  if (c.status === 'resolved') return { ok: false, error: 'This case is already resolved.' }
  if (c.status === 'investigating') {
    return { ok: false, error: 'The investigator is still working on this case — wait for it to finish.' }
  }

  // 2. Load the proposal message + re-read the plan from the DB (never client input).
  const { data: msg, error: msgErr } = await admin
    .from('sync_case_messages')
    .select('id, case_id, tool_calls, position')
    .eq('id', proposalRef)
    .maybeSingle()
  if (msgErr) return { ok: false, error: `Could not load the proposal: ${msgErr.message}` }
  if (!msg || msg.case_id !== caseId) return { ok: false, error: 'That proposal does not belong to this case.' }

  const input = extractPickSourceProposal(msg.tool_calls)
  if (!input) return { ok: false, error: 'That message does not contain a pick-source proposal.' }

  // 3. Guard double-execution: it must still be the OPEN pick-source proposal.
  const { data: history, error: histErr } = await admin
    .from('sync_case_messages')
    .select('role, content, tool_calls, position')
    .eq('case_id', caseId)
    .order('position', { ascending: true })
  if (histErr) return { ok: false, error: `Could not verify the proposal: ${histErr.message}` }
  const open = findOpenPickSourcePlan(history ?? [], c.status)
  if (!open || open.position !== msg.position) {
    return {
      ok: false,
      error: 'This proposal is no longer the current one (it was superseded, declined, or already resolved).',
    }
  }

  const plan = input.plan

  // AMBIGUOUS → no write; route to P5 edit-then-apply.
  if (plan.ambiguous) {
    return {
      ok: false,
      error:
        (plan.suggestion ?? 'The feedings do not line up cleanly with the chosen source.') +
        ' Use edit-then-apply on the individual feedings instead — this pick cannot be applied automatically.',
    }
  }

  const provenance = diffResolutionProvenance({
    email,
    source: input.source,
    field: input.field,
    naturalKeyLabel: input.naturalKeyLabel,
  })

  // 4. Apply each plan step (EDIT-preferred; soft-remove/insert only inside this
  //    confirmed + audited plan).
  let applied = 0
  for (const step of plan.steps) {
    try {
      const did = await applyDiffStep(admin, step, provenance)
      if (did) applied++
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return { ok: false, error: `Applying the plan failed on a ${step.op} step: ${m}` }
    }
  }

  // 5. Ledger row (action 'pick_source').
  const summary = pickSourceRulingSummary({
    source: input.source,
    field: input.field,
    naturalKeyLabel: input.naturalKeyLabel,
    plan,
  })
  const { data: ruling, error: rulingErr } = await admin
    .from('sync_case_rulings')
    .insert({
      fingerprint: c.fingerprint,
      case_id: c.id,
      action: 'pick_source',
      verdict_summary: summary,
      reasoning: `${provenance}. Applied ${applied} change(s); the block/day now totals ${plan.chosenSumKg} kg.`,
      ruled_by: userId,
      ruled_by_email: email,
    })
    .select('id')
    .single()
  if (rulingErr) return { ok: false, error: `Recording the ruling failed: ${rulingErr.message}` }
  const rulingId = ruling.id as string

  // 6. Flip the case to resolved + pin the ruling.
  const { error: updErr } = await admin
    .from('sync_held_cases')
    .update({ status: 'resolved', known_ruling_id: rulingId, updated_at: new Date().toISOString() })
    .eq('id', c.id)
  if (updErr) return { ok: false, error: `Marking the case resolved failed: ${updErr.message}` }

  // 7. System-message trail.
  const pos = await nextMessagePosition(admin, caseId)
  await admin.from('sync_case_messages').insert({
    case_id: caseId,
    role: 'system',
    content: `${summary} (${applied} change(s) applied by ${email})`,
    tool_calls: null,
    tool_results: null,
    position: pos,
  })

  revalidatePath('/sync/cases')
  return { ok: true, ruling_id: rulingId, plan }
}

/**
 * Apply ONE plan step to rc_out under a full audit stamp. Returns true when it wrote
 * (noop → false). EDIT/`remove` are direct UPDATEs (the trigger fn_update_blackwood_state
 * recomputes the batch balance); INSERT routes through the deterministic rc_out writer
 * (batch resolution + its own audit). rc_out has no audit trigger, so EDIT/remove write
 * their own write_ingestion_audit row. NEVER hard-deletes.
 */
async function applyDiffStep(
  admin: AdminClient,
  step: DiffPlanStep,
  provenance: string,
): Promise<boolean> {
  if (step.op === 'noop') return false

  if (step.op === 'edit' || step.op === 'remove') {
    if (!step.db_id) throw new Error(`${step.op} step is missing its db row id`)
    const newWeight = step.op === 'remove' ? 0 : step.to_weight_kg ?? 0

    const { data: before, error: befErr } = await admin
      .from('rc_out')
      .select('weight_kg')
      .eq('id', step.db_id)
      .maybeSingle()
    if (befErr) throw new Error(befErr.message)
    if (!before) throw new Error(`the feeding (id ${step.db_id}) no longer exists`)

    const { error: updErr } = await admin
      .from('rc_out')
      .update({ weight_kg: newWeight })
      .eq('id', step.db_id)
    if (updErr) throw new Error(updErr.message)

    const comment =
      step.op === 'remove'
        ? `${provenance} (soft-remove: over-stated leg zeroed, row kept — never deleted)`
        : provenance
    const { error: auditErr } = await admin.rpc('write_ingestion_audit', {
      p_table_name: 'rc_out',
      p_record_id: step.db_id,
      p_operation: 'UPDATE',
      p_diff: { weight_kg: { from: Number(before.weight_kg ?? 0), to: newWeight } } as unknown as Json,
      p_snapshot: null,
      p_comment: comment,
    })
    if (auditErr) throw new Error(`wrote the feeding but the audit log failed: ${auditErr.message}`)
    return true
  }

  if (step.op === 'insert') {
    const leg = step.leg
    if (!leg) throw new Error('insert step is missing its source leg')
    const writer = APPLY_WRITERS['rc_out']
    if (!writer) throw new Error('no rc_out writer is registered')
    await writer(
      {
        transaction_date: leg.transaction_date,
        weight_kg: step.to_weight_kg ?? leg.weight_kg,
        destination: leg.destination,
        batch_code: leg.batch_code,
        production_batch: leg.production_batch ?? null,
        block_loc: leg.block_loc,
        remarks: leg.remarks ?? null,
      },
      admin,
      provenance,
    )
    return true
  }

  return false
}

/** Pull a propose_pick_source proposal out of an assistant row's tool_calls jsonb. */
function extractPickSourceProposal(toolCalls: unknown): PickSourceProposalInput | null {
  if (!Array.isArray(toolCalls)) return null
  for (const tc of toolCalls) {
    if (tc && typeof tc === 'object') {
      const o = tc as Record<string, unknown>
      if (o.name === PICK_SOURCE_TOOL) return parsePickSourceInput(o.input)
    }
  }
  return null
}

/** Plain-language narration stored on the proposal's assistant message. */
function pickProposalNarration(input: PickSourceProposalInput): string {
  const { plan, source, naturalKeyLabel } = input
  if (plan.ambiguous) {
    return (
      `Prepared a resolution for ${naturalKeyLabel}: make ${source} authoritative. The current feedings ` +
      `do not line up one-to-one with ${source}, so this cannot be applied automatically — ` +
      `${plan.suggestion ?? 'fix the rows with edit-then-apply.'} Nothing has been saved.`
    )
  }
  const changes = plan.steps.filter((s) => s.op !== 'noop')
  if (changes.length === 0) {
    return (
      `Prepared a resolution for ${naturalKeyLabel}: ${source} already matches the database exactly — ` +
      `confirming records the decision without changing any feeding.`
    )
  }
  const lines = changes.map((s) => `• ${s.describe}`).join('\n')
  return (
    `Prepared a resolution for ${naturalKeyLabel}: make ${source} authoritative. This will:\n${lines}\n` +
    `Nothing has been saved yet — confirm to apply.`
  )
}

// ============================================================================
// CREATE-BATCH resolution of an `unmapped_batch_code` / `unresolved_batch` case.
// The ONE human-confirmed exception to "never auto-create a batch": the reviewer
// clicks "create this batch", which INSERTS the batch and re-attempts the skipped
// row(s) through the SAME deterministic apply-writers path the sync uses. Mirrors the
// R3a pick-source rails: a PURE plan (create-batch-plan.ts) + a persisted proposal +
// a confirm-gated executor that re-reads the plan from the DB. NEVER deletes; audited.
// ============================================================================

/** The case kinds a create-batch resolution applies to. */
const CREATE_BATCH_KINDS = ['unmapped_batch_code', 'unresolved_batch']

export interface CreateBatchResult {
  ok: boolean
  error?: string
  /** The persisted proposal message id — the `proposalRef` for executeCreateBatch. */
  proposal_message_id?: string
  /** The new ruling id (execute only). */
  ruling_id?: string
  /** True when the batch was inserted (false = it already existed → skip-create). */
  created_batch?: boolean
  /** The batch id (created or pre-existing). */
  batch_id?: string
  /** How many skipped rows were written through the deterministic writer. */
  rows_written?: number
  /** Non-fatal notes (e.g. "the row could not be written — it will land next sync: <why>"). */
  warnings?: string[]
  /** The computed plan — the confirm UI renders exactly what creating this batch does. */
  plan?: CreateBatchPlan
}

/** The subset of a case row the create-batch path needs. */
interface BatchCaseRow {
  id: string
  report_type: string
  kind: string
  status: string
  fingerprint: string
  natural_key: string
  row: unknown
}

const BATCH_CASE_COLS = 'id, report_type, kind, status, fingerprint, natural_key, row'

/**
 * PROPOSE creating the batch a case references. Validates the case is an unresolved
 * `unmapped_batch_code` / `unresolved_batch`; builds the PURE plan (fields + writer lane +
 * the skipped row); checks (read-only) whether the batch already exists so the narration is
 * honest; and PERSISTS the plan as an assistant message carrying one propose_create_batch
 * tool_use (mirrors pick-source so findOpen*-detection + sanitize replay both work). Writes
 * NOTHING operational. Returns the plan + the proposal message id for the confirm step.
 */
export async function proposeCreateBatch(caseId: string): Promise<CreateBatchResult> {
  await requirePrivileged()
  const admin = createAdminClient()

  const { data: theCase, error: caseErr } = await admin
    .from('sync_held_cases')
    .select(BATCH_CASE_COLS)
    .eq('id', caseId)
    .maybeSingle()
  if (caseErr) return { ok: false, error: `Could not load the case: ${caseErr.message}` }
  if (!theCase) return { ok: false, error: 'Case not found.' }
  const c = theCase as BatchCaseRow
  if (!CREATE_BATCH_KINDS.includes(c.kind)) {
    return {
      ok: false,
      error: 'Creating a batch only applies to an unmapped / unresolved batch flag.',
    }
  }
  if (c.status === 'resolved') return { ok: false, error: 'This case is already resolved.' }
  if (c.status === 'investigating') {
    return { ok: false, error: 'The investigator is still working on this case — wait for it to finish.' }
  }

  const plan = buildCreateBatchPlan({
    kind: c.kind,
    reportType: c.report_type as SyncReportType,
    row: c.row,
  })
  if (!plan) {
    return { ok: false, error: 'This flag does not name a batch code, so no batch can be created from it.' }
  }

  // Read-only: does the batch already exist? (Honest narration; the executor re-checks.)
  const { data: existing } = await admin
    .from('batches')
    .select('id')
    .eq('batch_code', plan.batch_code)
    .maybeSingle()
  const alreadyExists = Boolean(existing)

  const input: CreateBatchProposalInput = {
    batch_code: plan.batch_code,
    naturalKeyLabel: c.natural_key,
    plan,
  }
  const toolUseId = `createbatch_${randomUUID()}`
  const pos = await nextMessagePosition(admin, caseId)
  const { data: msg, error: insErr } = await admin
    .from('sync_case_messages')
    .insert({
      case_id: caseId,
      role: 'assistant',
      content: createBatchNarration(input, alreadyExists),
      tool_calls: [{ id: toolUseId, name: CREATE_BATCH_TOOL, input }] as unknown as Json,
      tool_results: null,
      position: pos,
    })
    .select('id')
    .single()
  if (insErr) return { ok: false, error: `Could not save the proposal: ${insErr.message}` }

  return { ok: true, proposal_message_id: msg.id as string, plan }
}

/**
 * EXECUTE a create-batch resolution the reviewer confirmed. requirePrivileged; re-reads the
 * plan FROM THE PERSISTED PROPOSAL (never a client payload); guards it is still the OPEN
 * proposal; then:
 *   1. INSERT the batch if its code doesn't exist yet (skip-create if it does — idempotent,
 *      race-safe on the batch_code UNIQUE), audited via write_ingestion_audit.
 *   2. Re-attempt the skipped row through the deterministic apply-writers path (deliveries
 *      for RC IN, rc_out for RC OUT). A row-write failure is NON-FATAL — the batch is the
 *      primary win; the row lands on the next sync. Partial is reported in `warnings`.
 *   3. Record a `create_batch` sync_case_rulings row, flip the case resolved + pin the
 *      ruling, append a system trail. revalidates /sync/cases.
 *
 * NEVER deletes. NEVER carries ₱ (rc_out has none; deliveries.cost_basis forced 0 by the writer).
 */
export async function executeCreateBatch(
  caseId: string,
  proposalRef: string,
): Promise<CreateBatchResult> {
  const userId = await requirePrivileged()
  const admin = createAdminClient()
  const email = await resolveEmail(admin, userId)

  // 1. Load + validate the case.
  const { data: theCase, error: caseErr } = await admin
    .from('sync_held_cases')
    .select(BATCH_CASE_COLS)
    .eq('id', caseId)
    .maybeSingle()
  if (caseErr) return { ok: false, error: `Could not load the case: ${caseErr.message}` }
  if (!theCase) return { ok: false, error: 'Case not found.' }
  const c = theCase as BatchCaseRow
  if (!CREATE_BATCH_KINDS.includes(c.kind)) {
    return { ok: false, error: 'Creating a batch only applies to an unmapped / unresolved batch flag.' }
  }
  if (c.status === 'resolved') return { ok: false, error: 'This case is already resolved.' }
  if (c.status === 'investigating') {
    return { ok: false, error: 'The investigator is still working on this case — wait for it to finish.' }
  }

  // 2. Load the proposal message + re-read the plan from the DB (never client input).
  const { data: msg, error: msgErr } = await admin
    .from('sync_case_messages')
    .select('id, case_id, tool_calls, position')
    .eq('id', proposalRef)
    .maybeSingle()
  if (msgErr) return { ok: false, error: `Could not load the proposal: ${msgErr.message}` }
  if (!msg || msg.case_id !== caseId) return { ok: false, error: 'That proposal does not belong to this case.' }

  const input = extractCreateBatchProposal(msg.tool_calls)
  if (!input) return { ok: false, error: 'That message does not contain a create-batch proposal.' }

  // 3. Guard double-execution: it must still be the OPEN create-batch proposal.
  const { data: history, error: histErr } = await admin
    .from('sync_case_messages')
    .select('role, content, tool_calls, position')
    .eq('case_id', caseId)
    .order('position', { ascending: true })
  if (histErr) return { ok: false, error: `Could not verify the proposal: ${histErr.message}` }
  const open = findOpenCreateBatchPlan(history ?? [], c.status)
  if (!open || open.position !== msg.position) {
    return {
      ok: false,
      error: 'This proposal is no longer the current one (it was superseded, declined, or already resolved).',
    }
  }

  const plan = input.plan
  const provenance = createBatchProvenance(email, plan.batch_code)
  const warnings: string[] = []

  // 4. Create-or-skip the batch (race-safe on the batch_code UNIQUE).
  let batchId: string
  let createdBatch = false
  try {
    const ensured = await ensureBatchExists(admin, plan, provenance)
    batchId = ensured.batchId
    createdBatch = ensured.created
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `Could not create the batch: ${m}` }
  }

  // 5. Re-attempt the skipped row through the deterministic writer (non-fatal on failure).
  let rowsWritten = 0
  if (!plan.ambiguous && plan.writerLane && plan.unblock) {
    const writer = APPLY_WRITERS[plan.writerLane]
    if (!writer) {
      warnings.push(`No writer is registered for ${plan.writerLane} — the row will write on the next sync.`)
    } else {
      try {
        await writer(plan.unblock, admin, provenance)
        rowsWritten++
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        warnings.push(`The batch was created but its row could not be written yet (it will land on the next sync): ${m}`)
      }
    }
  } else if (plan.ambiguous) {
    warnings.push(plan.note ?? 'The batch was created; the row will write on the next sync.')
  }

  // 6. Ledger row (action 'create_batch').
  const summary = createBatchRulingSummary({ batchCode: plan.batch_code, created: createdBatch, rowsWritten })
  const reasoning = `${provenance}.${warnings.length ? ' ' + warnings.join(' ') : ''}`
  const { data: ruling, error: rulingErr } = await admin
    .from('sync_case_rulings')
    .insert({
      fingerprint: c.fingerprint,
      case_id: c.id,
      action: 'create_batch',
      verdict_summary: summary,
      reasoning,
      ruled_by: userId,
      ruled_by_email: email,
    })
    .select('id')
    .single()
  if (rulingErr) return { ok: false, error: `Recording the ruling failed: ${rulingErr.message}` }
  const rulingId = ruling.id as string

  // 7. Flip the case to resolved + pin the ruling.
  const { error: updErr } = await admin
    .from('sync_held_cases')
    .update({ status: 'resolved', known_ruling_id: rulingId, updated_at: new Date().toISOString() })
    .eq('id', c.id)
  if (updErr) return { ok: false, error: `Marking the case resolved failed: ${updErr.message}` }

  // 8. System-message trail.
  const pos = await nextMessagePosition(admin, caseId)
  await admin.from('sync_case_messages').insert({
    case_id: caseId,
    role: 'system',
    content: `${summary} (by ${email})${warnings.length ? ' — ' + warnings.join(' ') : ''}`,
    tool_calls: null,
    tool_results: null,
    position: pos,
  })

  revalidatePath('/sync/cases')
  return {
    ok: true,
    ruling_id: rulingId,
    created_batch: createdBatch,
    batch_id: batchId,
    rows_written: rowsWritten,
    warnings: warnings.length ? warnings : undefined,
    plan,
  }
}

/**
 * INSERT the batch if its code doesn't exist yet, else return the existing id (skip-create).
 * Race-safe: if a concurrent create wins the batch_code UNIQUE between our SELECT and INSERT,
 * we re-read and treat it as pre-existing. The INSERT is audited via write_ingestion_audit
 * (batches has no audit trigger). NEVER deletes.
 */
async function ensureBatchExists(
  admin: AdminClient,
  plan: CreateBatchPlan,
  provenance: string,
): Promise<{ batchId: string; created: boolean }> {
  const { data: existing, error: exErr } = await admin
    .from('batches')
    .select('id')
    .eq('batch_code', plan.batch_code)
    .maybeSingle()
  if (exErr) throw new Error(exErr.message)
  if (existing) return { batchId: existing.id as string, created: false }

  const insertPayload = {
    batch_code: plan.fields.batch_code,
    location_ref: plan.fields.location_ref,
    status: plan.fields.status as never,
    current_weight: plan.fields.current_weight,
    avg_cost: plan.fields.avg_cost,
  }
  const { data: inserted, error: insErr } = await admin
    .from('batches')
    .insert(insertPayload)
    .select('id')
    .single()
  if (insErr) {
    // Lost the race on the batch_code UNIQUE → re-read + treat as pre-existing.
    const { data: after } = await admin
      .from('batches')
      .select('id')
      .eq('batch_code', plan.batch_code)
      .maybeSingle()
    if (after) return { batchId: after.id as string, created: false }
    throw new Error(insErr.message)
  }

  const batchId = inserted.id as string
  // batches has no audit trigger → use the service-role ingestion audit writer.
  const { error: auditErr } = await admin.rpc('write_ingestion_audit', {
    p_table_name: 'batches',
    p_record_id: batchId,
    p_operation: 'INSERT',
    p_diff: null,
    p_snapshot: insertPayload as unknown as Json,
    p_comment: provenance,
  })
  if (auditErr) throw new Error(`Created the batch but the audit log failed: ${auditErr.message}`)
  return { batchId, created: true }
}

/** Pull a propose_create_batch proposal out of an assistant row's tool_calls jsonb. */
function extractCreateBatchProposal(toolCalls: unknown): CreateBatchProposalInput | null {
  if (!Array.isArray(toolCalls)) return null
  for (const tc of toolCalls) {
    if (tc && typeof tc === 'object') {
      const o = tc as Record<string, unknown>
      if (o.name === CREATE_BATCH_TOOL) return parseCreateBatchInput(o.input)
    }
  }
  return null
}

/** Plain-language narration stored on the create-batch proposal's assistant message. */
function createBatchNarration(input: CreateBatchProposalInput, alreadyExists: boolean): string {
  const { plan, naturalKeyLabel } = input
  // plan.fields.location_ref is '' for a FEED batch (BUG B, 2026-07-11) — FEED_LOCATION_REF
  // is a display-only label, never the actual stored value.
  const loc = plan.isFeed
    ? `a FEED batch (no block — filed under "${FEED_LOCATION_REF}")`
    : `block ${plan.fields.location_ref}`
  const head = alreadyExists
    ? `Batch "${plan.batch_code}" already exists — confirming will re-attempt the skipped row and record the decision.`
    : `Prepared to create batch "${plan.batch_code}" as ${loc}, starting empty (its balance is computed from deliveries and feedings).`
  const rowLine = plan.ambiguous
    ? ' There is no clean row to re-attempt from this flag — the row will write on the next sync.'
    : plan.writerLane === 'deliveries'
      ? ' It will also add the skipped delivery (RC IN) that referenced this batch.'
      : ' It will also add the skipped feeding (RC OUT) that referenced this batch.'
  return `${head}${rowLine} Nothing has been saved yet — confirm to apply.`
}
