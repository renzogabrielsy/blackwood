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
