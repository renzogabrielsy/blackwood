/**
 * resolution.ts — the `propose_resolution` tool (chat mode ONLY) for the Smart
 * Held-Row Adjudicator's human-directed resolve (P5).
 *
 * THE AGENT NEVER WRITES. `propose_resolution` does NO operational write — it only
 * validates a proposal against the case and echoes it back, so the reviewer can
 * confirm it with an explicit button click (executeResolution, resolve.ts). The
 * proposal's persistence is the tool_calls jsonb the loop already saves on the
 * assistant message row — no schema change.
 *
 * Added to case-chat.ts's tool set (chat mode), NOT to runInvestigation's — the
 * opening auto-investigation only advises; proposing a resolution is a conversational
 * act the reviewer directs.
 *
 * Eligibility (enforced HERE and again in executeResolution — defense in depth):
 *   - dismiss: any unresolved case.
 *   - apply / edit_apply: ONLY per-row holds whose report_type has a registered
 *     writer (rc_out / deliveries). NOT gate_failure (no single row to write — the
 *     flag is a report-level cross-check). edit_apply requires edited_row.
 */
import type Anthropic from '@anthropic-ai/sdk'

import { hasApplyWriter } from '@/lib/sync/apply-writers'

export type ResolutionAction = 'dismiss' | 'apply' | 'edit_apply'

/** The validated proposal shape (parsed from the tool input). */
export interface ResolutionProposal {
  action: ResolutionAction
  summary: string
  reasoning: string
  /** Present only for edit_apply — the exact row to write (all fields echoed). */
  edited_row?: Record<string, unknown>
}

/** The minimal case facts the tool executor needs to check eligibility. */
export interface ResolutionCaseContext {
  report_type: string
  kind: string
  status: string
}

/** The `propose_resolution` tool definition (chat-mode only). */
export const PROPOSE_RESOLUTION_TOOL: Anthropic.Tool = {
  name: 'propose_resolution',
  description:
    'Propose how to resolve THIS case when the reviewer has directed a resolution in plain words ' +
    '("dismiss this", "apply it", "the weight should be 5,200 — apply that"). This does NOT save ' +
    'anything — it lays out exactly what will happen so the reviewer can confirm it with a button. ' +
    'You must NEVER claim the resolution is done; say you have prepared it and are waiting for the ' +
    "reviewer to confirm.\n\n" +
    'action:\n' +
    '- "dismiss" — acknowledge the flag and set the case aside with NO change to any operational ' +
    'data (the common answer when the database is already correct and a source sheet was just short).\n' +
    '- "apply" — save the set-aside row AS-IS. Only for per-row holds on a report type that supports ' +
    'saving (currently feedings and deliveries). NOT for a totals-mismatch flag (there is no single ' +
    'row to save).\n' +
    '- "edit_apply" — save a CORRECTED version of the row. You MUST include edited_row with EVERY ' +
    'field of the exact row that will be written (not just the changed one), so the reviewer sees ' +
    'precisely what gets saved.\n\n' +
    'summary: one or two plain sentences the reviewer can confirm. reasoning: why this is the right ' +
    'resolution. Put exact dates + kg where relevant.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['dismiss', 'apply', 'edit_apply'] },
      summary: { type: 'string', description: 'One or two plain sentences the reviewer can act on.' },
      reasoning: { type: 'string', description: 'Why this resolution is correct.' },
      edited_row: {
        type: 'object',
        description:
          'REQUIRED for edit_apply. The exact, complete row to write — every field, with the corrected ' +
          'value(s) in place. Never include a price/cost field.',
      },
    },
    required: ['action', 'summary', 'reasoning'],
  },
}

/** Parse the model's tool input into a ResolutionProposal, or null if malformed. */
export function parseProposal(input: unknown): ResolutionProposal | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>

  const action = o.action
  if (action !== 'dismiss' && action !== 'apply' && action !== 'edit_apply') return null

  const summary = o.summary
  if (typeof summary !== 'string' || summary.trim().length === 0) return null

  const reasoning = o.reasoning
  if (typeof reasoning !== 'string' || reasoning.trim().length === 0) return null

  let edited_row: Record<string, unknown> | undefined
  if (o.edited_row != null) {
    if (typeof o.edited_row !== 'object' || Array.isArray(o.edited_row)) return null
    edited_row = o.edited_row as Record<string, unknown>
  }

  return { action, summary: summary.trim(), reasoning: reasoning.trim(), edited_row }
}

export interface EligibilityResult {
  ok: boolean
  /** A plain error the model relays verbatim to the reviewer when ineligible. */
  error?: string
}

/**
 * The single eligibility gate — shared by the tool executor AND executeResolution
 * (defense in depth). Encodes the locked semantics:
 *   - a resolved case can't be resolved again;
 *   - dismiss is always allowed on an unresolved case;
 *   - apply/edit_apply need a per-row writer AND must NOT be a gate_failure;
 *   - edit_apply requires edited_row.
 */
export function checkEligibility(
  proposal: ResolutionProposal,
  ctx: ResolutionCaseContext,
): EligibilityResult {
  if (ctx.status === 'resolved') {
    return { ok: false, error: 'This case is already resolved — there is nothing left to do.' }
  }

  if (proposal.action === 'dismiss') {
    return { ok: true }
  }

  // apply / edit_apply from here.
  if (ctx.kind === 'gate_failure') {
    return {
      ok: false,
      error:
        'This is a totals-mismatch flag, not a single set-aside row — there is no one row to save. ' +
        'The right resolution here is to dismiss it (the database is usually already correct), or fix ' +
        'the source sheet and re-run the sync. Saving does not apply to this kind of flag.',
    }
  }

  if (!hasApplyWriter(ctx.report_type)) {
    return {
      ok: false,
      error: `Saving a ${ctx.report_type} row from a case is not supported yet — dismiss it, or run the row through the sync employee.`,
    }
  }

  if (proposal.action === 'edit_apply' && !proposal.edited_row) {
    return {
      ok: false,
      error: 'An edited save needs the corrected row — include edited_row with every field of the row to write.',
    }
  }

  return { ok: true }
}

/**
 * The executor for propose_resolution (chat mode). Does NO write: validates the
 * proposal against the case and returns a JSON string {ok, proposal_echo} the model
 * feeds back into the conversation (and the UI reads from the persisted tool_calls).
 * Never throws.
 */
export function executePropose(input: unknown, ctx: ResolutionCaseContext): string {
  const proposal = parseProposal(input)
  if (!proposal) {
    return JSON.stringify({
      ok: false,
      error:
        'The proposal was malformed. action must be dismiss | apply | edit_apply; summary and reasoning are required; edit_apply needs edited_row.',
    })
  }

  const elig = checkEligibility(proposal, ctx)
  if (!elig.ok) {
    return JSON.stringify({ ok: false, error: elig.error })
  }

  return JSON.stringify({
    ok: true,
    proposal_echo: {
      action: proposal.action,
      summary: proposal.summary,
      reasoning: proposal.reasoning,
      ...(proposal.edited_row ? { edited_row: proposal.edited_row } : {}),
    },
    note:
      'Nothing has been saved. Tell the reviewer you have prepared this and are waiting for them to confirm with the button.',
  })
}

// ============================================================================
// GROUP resolution (v1.1 Run Triage) — dismiss-only, chat-mode on a triage case.
// ============================================================================

/** The validated group-dismiss proposal (parsed from propose_group_resolution). */
export interface GroupResolutionProposal {
  /** dismiss-ONLY in v1 (apply/edit_apply are per-case). */
  action: 'dismiss'
  case_ids: string[]
  summary: string
  reasoning: string
}

/**
 * The minimal facts executeProposeGroup needs to check a group proposal. `caseKind`
 * gates the tool to a triage case; `runCaseIds` is the authoritative set of the run's
 * sibling case ids (the triage case's row.case_ids); `resolvedIds` is the subset
 * already resolved (a group must not re-dismiss those).
 */
export interface GroupResolutionContext {
  /** The kind of the case the tool is being called FROM (must be 'run_triage'). */
  caseKind: string
  status: string
  /** Every case id that belongs to this run family (from the triage case's row). */
  runCaseIds: string[]
  /** The subset of runCaseIds that are already resolved. */
  resolvedIds: string[]
  /** The triage case's OWN id (may never be a member of the group). */
  triageCaseId: string
}

/** The propose_group_resolution tool definition (chat-mode, run_triage cases only). */
export const PROPOSE_GROUP_RESOLUTION_TOOL: Anthropic.Tool = {
  name: 'propose_group_resolution',
  description:
    'Propose dismissing a WHOLE GROUP of flags at once, when the reviewer has directed it in ' +
    'plain words ("dismiss the movement-sheet group", "set all of those aside"). This does NOT ' +
    'save anything — it lays out exactly which flags will be set aside so the reviewer can confirm ' +
    'with one button.\n\n' +
    'Only "dismiss" is available for groups: dismissing sets each flag aside with NO change to any ' +
    'operational data (the common outcome when the database is already correct and several source ' +
    'sheets were short for the same reason). If the reviewer wants to SAVE a row, that is done one ' +
    'flag at a time — never as a group.\n\n' +
    'case_ids: the ids of every flag in the group. NEVER include a flag the reviewer has doubts ' +
    'about, and never include the triage summary itself. summary: one or two plain sentences the ' +
    'reviewer can confirm. reasoning: why these all share one cause and can be set aside together.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['dismiss'] },
      case_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Every case id in the group to dismiss.',
      },
      summary: { type: 'string', description: 'One or two plain sentences the reviewer can confirm.' },
      reasoning: { type: 'string', description: 'Why these all share one cause and can be set aside together.' },
    },
    required: ['action', 'case_ids', 'summary', 'reasoning'],
  },
}

/** Parse the model's group tool input into a GroupResolutionProposal, or null. */
export function parseGroupProposal(input: unknown): GroupResolutionProposal | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>

  if (o.action !== 'dismiss') return null // dismiss-only in v1

  if (!Array.isArray(o.case_ids) || o.case_ids.length === 0) return null
  const case_ids: string[] = []
  for (const id of o.case_ids) {
    if (typeof id !== 'string' || !id.trim()) return null
    case_ids.push(id.trim())
  }

  const summary = o.summary
  if (typeof summary !== 'string' || summary.trim().length === 0) return null
  const reasoning = o.reasoning
  if (typeof reasoning !== 'string' || reasoning.trim().length === 0) return null

  return { action: 'dismiss', case_ids, summary: summary.trim(), reasoning: reasoning.trim() }
}

/**
 * The single group-eligibility gate — shared by the tool executor AND
 * executeGroupResolution (defense in depth). Encodes the locked semantics:
 *   - the tool is ONLY usable from a triage (run_triage) case;
 *   - a resolved triage case can't drive a group resolution;
 *   - every case_id must belong to the run family (the triage case's row.case_ids);
 *   - no case_id may be the triage case itself;
 *   - no case_id may already be resolved.
 */
export function checkGroupEligibility(
  proposal: GroupResolutionProposal,
  ctx: GroupResolutionContext,
): EligibilityResult {
  if (ctx.caseKind !== 'run_triage') {
    return {
      ok: false,
      error:
        'Group dismiss is only available from a run triage summary — on a single flag, dismiss or save it on its own.',
    }
  }
  if (ctx.status === 'resolved') {
    return { ok: false, error: 'This run triage is already resolved — there is nothing left to do.' }
  }

  const runSet = new Set(ctx.runCaseIds)
  const resolvedSet = new Set(ctx.resolvedIds)

  for (const id of proposal.case_ids) {
    if (id === ctx.triageCaseId) {
      return { ok: false, error: 'The triage summary itself cannot be part of a group — list only the individual flags.' }
    }
    if (!runSet.has(id)) {
      return {
        ok: false,
        error: `One of the flags is not part of this run (${id}). Only flags from this run can be dismissed together.`,
      }
    }
    if (resolvedSet.has(id)) {
      return {
        ok: false,
        error: `One of the flags is already resolved (${id}). Leave it out and dismiss the rest.`,
      }
    }
  }

  return { ok: true }
}

/**
 * The executor for propose_group_resolution (chat mode). Does NO write: validates the
 * group proposal against the triage case + run family and echoes it back as a JSON
 * string the model relays. The actual dismissals happen only on an explicit human
 * confirm (executeGroupResolution, resolve.ts). Never throws.
 */
export function executeProposeGroup(input: unknown, ctx: GroupResolutionContext): string {
  const proposal = parseGroupProposal(input)
  if (!proposal) {
    return JSON.stringify({
      ok: false,
      error:
        'The group proposal was malformed. action must be dismiss; case_ids must be a non-empty list of flag ids; summary and reasoning are required.',
    })
  }

  const elig = checkGroupEligibility(proposal, ctx)
  if (!elig.ok) return JSON.stringify({ ok: false, error: elig.error })

  return JSON.stringify({
    ok: true,
    group_proposal_echo: {
      action: proposal.action,
      case_ids: proposal.case_ids,
      summary: proposal.summary,
      reasoning: proposal.reasoning,
    },
    note:
      'Nothing has been saved. Tell the reviewer you have prepared this group dismissal and are waiting for them to confirm with the button.',
  })
}

// ============================================================================
// Open-proposal detection (PURE) — used by resolve.ts + the UI to decide whether
// an actionable resolution card should show. Exported for the verify script.
// ============================================================================

/** A message row as stored in sync_case_messages (loose — from the DB). */
export interface ProposalScanRow {
  role: string
  content: string
  tool_calls: unknown
  tool_results: unknown
  position: number
}

/** The latest open (un-actioned) proposal found while scanning a transcript. */
export interface OpenProposal {
  proposal: ResolutionProposal
  /** The 1:1 position of the assistant message that carried the propose_resolution call. */
  position: number
  /** The tool_use id of the propose_resolution call (for tracing). */
  tool_use_id: string
}

/** Extract a named tool_use block from an assistant row's tool_calls. */
function findToolCall(
  toolCalls: unknown,
  toolName: string,
): { id: string; input: unknown } | null {
  if (!Array.isArray(toolCalls)) return null
  for (const tc of toolCalls) {
    if (tc && typeof tc === 'object') {
      const o = tc as Record<string, unknown>
      if (o.name === toolName) {
        return { id: String(o.id ?? ''), input: o.input }
      }
    }
  }
  return null
}

/** Extract a propose_resolution tool_use block from an assistant row's tool_calls. */
function findProposeCall(
  toolCalls: unknown,
): { id: string; input: unknown } | null {
  return findToolCall(toolCalls, 'propose_resolution')
}

/** True when a system row records a declined proposal at `position`. */
function isDeclineRow(row: ProposalScanRow): boolean {
  return row.role === 'system' && /proposal declined/i.test(row.content)
}

/**
 * Decide whether a case has an OPEN, actionable resolution proposal.
 *
 * A proposal is OPEN when it is the LATEST propose_resolution in the transcript AND
 * there is no later signal that closed it:
 *   - the case being 'resolved' (a ruling landed) closes ALL proposals;
 *   - a "Proposal declined" system row AFTER the proposal closes it.
 *
 * Returns the open proposal (with the message position) or null. PURE — takes the
 * transcript rows + the case status, no DB.
 */
export function findOpenProposal(
  rows: ProposalScanRow[],
  caseStatus: string,
): OpenProposal | null {
  if (caseStatus === 'resolved') return null

  // Find the latest assistant row carrying a propose_resolution call.
  let latest: OpenProposal | null = null
  for (const row of rows) {
    if (row.role !== 'assistant') continue
    const call = findProposeCall(row.tool_calls)
    if (!call) continue
    const proposal = parseProposal(call.input)
    if (!proposal) continue
    latest = { proposal, position: row.position, tool_use_id: call.id }
  }
  if (!latest) return null

  // Any decline row AFTER the proposal's position closes it.
  for (const row of rows) {
    if (row.position > latest.position && isDeclineRow(row)) return null
  }

  return latest
}

/** The latest open (un-actioned) GROUP proposal found while scanning a transcript. */
export interface OpenGroupProposal {
  proposal: GroupResolutionProposal
  /** The position of the assistant message that carried the propose_group_resolution call. */
  position: number
  /** The tool_use id of the propose_group_resolution call (for tracing). */
  tool_use_id: string
}

/**
 * Decide whether a triage case has an OPEN, actionable GROUP resolution proposal.
 * Mirrors findOpenProposal for the propose_group_resolution tool name: the LATEST
 * propose_group_resolution with no later decline row, and not on a resolved case.
 * PURE — no DB.
 */
export function findOpenGroupProposal(
  rows: ProposalScanRow[],
  caseStatus: string,
): OpenGroupProposal | null {
  if (caseStatus === 'resolved') return null

  let latest: OpenGroupProposal | null = null
  for (const row of rows) {
    if (row.role !== 'assistant') continue
    const call = findToolCall(row.tool_calls, 'propose_group_resolution')
    if (!call) continue
    const proposal = parseGroupProposal(call.input)
    if (!proposal) continue
    latest = { proposal, position: row.position, tool_use_id: call.id }
  }
  if (!latest) return null

  for (const row of rows) {
    if (row.position > latest.position && isDeclineRow(row)) return null
  }

  return latest
}
