'use server'

/**
 * case-chat.ts — the human-in-the-loop CHAT continuation for a held case (P4).
 *
 * The opening auto-investigation (lib/investigator/loop.ts::runInvestigation) writes
 * a full cited verdict. From there the case is a CONVERSATION: Renzo asks the
 * investigator to explain itself, check another date, or re-examine — and the
 * investigator answers, running more read-only checks when asked. If its conclusion
 * changes it re-submits a verdict; otherwise it just replies.
 *
 * This reuses the SAME tool-use loop body as the investigation (runToolLoop) and the
 * SAME playbook system prompt + a chat addendum, so both surfaces reason and speak
 * identically. It is READ-ONLY like the investigation: no operational write, ever
 * (the human-directed resolve write is P5). The transcript persists to
 * sync_case_messages as it goes, which the review page watches over Realtime.
 *
 * Service-role writes (the case tables are service-role-write only). requirePrivileged
 * gates WHO may chat.
 */
import type Anthropic from '@anthropic-ai/sdk'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePrivileged } from '@/lib/sync/privileged'
import { INVESTIGATOR_MODEL } from '@/lib/anthropic/client'
import {
  buildInvestigatorSystem,
  buildChatAddendum,
  buildCaseBriefing,
  type CaseBriefInput,
} from '@/lib/investigator/playbook'
import {
  runToolLoop,
  nextPosition,
  buildUserRow,
  type CaseMessageInsert,
  type PersistedVerdict,
} from '@/lib/investigator/loop'
import { createInvestigatorTools } from '@/lib/investigator/tools'
import {
  PROPOSE_RESOLUTION_TOOL,
  executePropose,
  type ResolutionCaseContext,
} from '@/lib/investigator/resolution'
import type { Json } from '@/types/supabase'

const MAX_MESSAGE_LEN = 4000

export interface ChatOnCaseResult {
  ok: boolean
  error?: string
}

/**
 * A stored sync_case_messages row folded into an Anthropic MessageParam[].
 * Mirrors app/(app)/jarvis/actions.ts::buildAnthropicMessages:
 *   - 'user'      → a plain user turn
 *   - 'assistant' → an assistant turn (text + any tool_use blocks from tool_calls)
 *   - 'tool'      → a user turn carrying tool_result blocks (the SDK multi-turn shape)
 *   - 'system'    → skipped (start-notes / nudges are not conversation content)
 */
function foldHistory(
  rows: Array<{
    role: string
    content: string
    tool_calls: unknown
    tool_results: unknown
  }>,
): Anthropic.MessageParam[] {
  const params: Anthropic.MessageParam[] = []

  for (const row of rows) {
    if (row.role === 'user') {
      if (row.content) params.push({ role: 'user', content: row.content })
    } else if (row.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = []
      if (row.content) content.push({ type: 'text', text: row.content })

      const toolCalls = row.tool_calls as Array<{
        id: string
        name: string
        input: unknown
      }> | null
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input as Record<string, unknown>,
          })
        }
      }
      if (content.length > 0) params.push({ role: 'assistant', content })
    } else if (row.role === 'tool') {
      const toolResults = row.tool_results as Array<{
        tool_use_id: string
        content: string
      }> | null
      if (Array.isArray(toolResults) && toolResults.length > 0) {
        params.push({
          role: 'user',
          content: toolResults.map((tr) => ({
            type: 'tool_result' as const,
            tool_use_id: tr.tool_use_id,
            content: tr.content,
          })),
        })
      }
    }
    // 'system' rows are infrastructure notes — not conversation content.
  }

  return params
}

/**
 * Continue the conversation on a case: append Renzo's message, replay the full
 * transcript, run the investigator in chat mode, and persist its reply (+ any tool
 * turns, + an updated verdict if it changed its mind).
 *
 * Rejected (ok:false, plain error) when the case is mid-investigation — a run is in
 * flight and the transcript would collide.
 */
export async function chatOnCase(caseId: string, message: string): Promise<ChatOnCaseResult> {
  await requirePrivileged()

  const trimmed = (message ?? '').trim()
  if (!trimmed) return { ok: false, error: 'Type a message first.' }
  if (trimmed.length > MAX_MESSAGE_LEN) {
    return { ok: false, error: `Message is too long (max ${MAX_MESSAGE_LEN} characters).` }
  }

  const admin = createAdminClient()

  // 1. Load the case (need status + row for briefing / tools).
  const { data: theCase, error: caseErr } = await admin
    .from('sync_held_cases')
    .select(
      'id, report_type, kind, natural_key, reason, detail, row, status, occurrence_count, last_run_id, known_ruling_id, sync_case_rulings!sync_held_cases_known_ruling_id_fkey(verdict_summary)',
    )
    .eq('id', caseId)
    .maybeSingle()
  if (caseErr) return { ok: false, error: `Could not load the case: ${caseErr.message}` }
  if (!theCase) return { ok: false, error: 'Case not found.' }

  if (theCase.status === 'investigating') {
    return {
      ok: false,
      error: 'The investigator is still working on this case — wait for it to finish, then chat.',
    }
  }

  try {
    // 2. Load the existing transcript (ordered).
    const { data: history, error: histErr } = await admin
      .from('sync_case_messages')
      .select('role, content, tool_calls, tool_results, position')
      .eq('case_id', caseId)
      .order('position', { ascending: true })
    if (histErr) throw new Error(`load transcript failed: ${histErr.message}`)

    const rows = history ?? []
    const persist = async (row: CaseMessageInsert) => {
      const { error } = await admin.from('sync_case_messages').insert(row)
      if (error) throw new Error(`persist message failed: ${error.message}`)
    }

    // 3. Position bookkeeping — append after the current max.
    const maxPos = rows.length ? rows[rows.length - 1].position : null
    let pos = nextPosition(maxPos)

    // 4. Seed the Anthropic messages. If the case was never investigated (empty
    //    transcript), lead with the case briefing so the model has the full context;
    //    otherwise replay the stored transcript (which already opens with the briefing).
    const messages: Anthropic.MessageParam[] = foldHistory(rows)
    if (messages.length === 0) {
      const rulingRel = theCase.sync_case_rulings as
        | { verdict_summary?: string }
        | { verdict_summary?: string }[]
        | null
      const knownSummary = Array.isArray(rulingRel)
        ? rulingRel[0]?.verdict_summary ?? null
        : rulingRel?.verdict_summary ?? null
      const briefInput: CaseBriefInput = {
        report_type: theCase.report_type,
        kind: theCase.kind,
        natural_key: theCase.natural_key,
        reason: theCase.reason,
        detail: theCase.detail,
        row: theCase.row,
        occurrence_count: theCase.occurrence_count,
        known_ruling_id: theCase.known_ruling_id,
        known_ruling_summary: knownSummary,
      }
      const briefing = buildCaseBriefing(briefInput)
      await persist(buildUserRow(caseId, briefing, pos++))
      messages.push({ role: 'user', content: briefing })
    }

    // 5. Persist + append Renzo's message.
    await persist(buildUserRow(caseId, trimmed, pos++))
    messages.push({ role: 'user', content: trimmed })

    // 6. Run the shared loop in CHAT mode (system + chat addendum). Tools are the
    //    same read-only investigator toolset; canViewPrices HARD false. In chat mode
    //    we ALSO expose propose_resolution — a WRITE-FREE proposal step (P5). Its
    //    executor validates eligibility against the case and echoes the proposal back;
    //    the actual write happens only on an explicit human confirmation click
    //    (executeResolution, resolve.ts). It never appears in the investigation loop.
    const investigatorTools = createInvestigatorTools({
      runId: theCase.last_run_id ?? null,
      canViewPrices: false,
    })
    const caseCtx: ResolutionCaseContext = {
      report_type: theCase.report_type,
      kind: theCase.kind,
      status: theCase.status,
    }
    const tools = {
      definitions: [...investigatorTools.definitions, PROPOSE_RESOLUTION_TOOL],
      execute: async (name: string, args: Record<string, unknown>): Promise<string> => {
        if (name === 'propose_resolution') return executePropose(args, caseCtx)
        return investigatorTools.execute(name, args)
      },
    }
    const system = buildInvestigatorSystem() + buildChatAddendum()

    const loop = await runToolLoop({
      caseId,
      model: INVESTIGATOR_MODEL,
      system,
      messages,
      tools,
      persist,
      startPos: pos,
    })
    pos = loop.pos

    // 7. If the model re-submitted a verdict, update the recorded verdict on the case.
    //    (It does this only when its conclusion changed — otherwise it just replied.)
    if (loop.verdictSubmitted && loop.verdict) {
      const persisted: PersistedVerdict = {
        ...loop.verdict,
        model: INVESTIGATOR_MODEL,
        investigated_at: new Date().toISOString(),
        tool_call_count: loop.toolCallCount,
      }
      const { error: updErr } = await admin
        .from('sync_held_cases')
        .update({
          status: 'investigated',
          verdict: persisted as unknown as Json,
          updated_at: new Date().toISOString(),
        })
        .eq('id', caseId)
      if (updErr) throw new Error(`verdict update failed: ${updErr.message}`)
    } else {
      // Touch updated_at so the review page's list re-sorts / refreshes.
      await admin
        .from('sync_held_cases')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', caseId)
    }

    return { ok: true }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    // Best-effort: record the error into the transcript so the reviewer sees it.
    try {
      const { data: last } = await admin
        .from('sync_case_messages')
        .select('position')
        .eq('case_id', caseId)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle()
      const p = nextPosition(last?.position ?? null)
      await admin
        .from('sync_case_messages')
        .insert({
          case_id: caseId,
          role: 'system',
          content: `Chat error: ${errMsg}`,
          tool_calls: null,
          tool_results: null,
          position: p,
        })
    } catch {
      // don't mask the original error
    }
    return { ok: false, error: errMsg }
  }
}
