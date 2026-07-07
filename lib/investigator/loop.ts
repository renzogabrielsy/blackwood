/**
 * loop.ts — the Smart Held-Row Adjudicator's INVESTIGATOR LOOP (P3).
 *
 * `runInvestigation(caseId, opts?)` drives an Anthropic tool-use loop over ONE
 * `sync_held_cases` row: it hands the model the diagnostic playbook (playbook.ts),
 * the 5 read-only investigative tools (tools.ts) PLUS a terminal `submit_verdict`
 * tool, and lets it investigate until it submits a cited verdict. The transcript is
 * PERSISTED to `sync_case_messages` as it goes (the UI watches that over Realtime —
 * this is the "streaming"), and the final verdict is written back onto the case.
 *
 * The write stays human-directed (P5) — this surface NEVER writes to an operational
 * table, never applies/skips/deletes. It only investigates and records a verdict.
 *
 * PRICE SAFETY: tools are built with canViewPrices:false HARD — the investigator
 * never sees ₱ regardless of the caller.
 *
 * Concurrency: a compare-and-swap on the case status (`open`→`investigating`) is the
 * single-flight guard. A second concurrent invocation observes `investigating` and
 * returns `skipped` without burning a token.
 *
 * The PURE pieces (parseVerdict, position math, message-row builders, the
 * out-of-budget synthesis) are exported so verify-investigator-loop.ts can test them
 * without the network.
 */
import type Anthropic from '@anthropic-ai/sdk'

import {
  anthropic,
  INVESTIGATOR_MODEL,
  INVESTIGATOR_ESCALATION_MODEL,
  INVESTIGATOR_MAX_TOKENS,
} from '@/lib/anthropic/client'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/supabase'

import { createInvestigatorTools } from './tools'
import { buildInvestigatorSystem, buildCaseBriefing, type CaseBriefInput } from './playbook'

// ============================================================================
// Public contract
// ============================================================================

/** The structured conclusion the model submits (validated by parseVerdict). */
export interface CaseVerdict {
  verdict: 'apply' | 'skip' | 'needs-human'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  explanation: string
  citations: Array<{ claim: string; source: string }>
}

/** The full verdict persisted onto the case (CaseVerdict + provenance). */
export interface PersistedVerdict extends CaseVerdict {
  model: string
  investigated_at: string
  tool_call_count: number
}

export interface InvestigationOutcome {
  status: 'done' | 'skipped' | 'error'
  verdict?: CaseVerdict
  error?: string
}

export interface RunInvestigationOpts {
  /** Use Opus 4.8 instead of Sonnet (explicit escalation only). */
  escalate?: boolean
  /** Re-investigate even if already investigated / has a known ruling. */
  force?: boolean
}

// Iteration + tool-call budgets (spec).
export const MAX_ITERATIONS = 8
export const MAX_TOOL_CALLS = 16

// ============================================================================
// PURE helpers (network-free, exported for tests)
// ============================================================================

/**
 * Validate the model's submit_verdict input into a CaseVerdict, or null if it is
 * malformed. Strict on the two enums; requires non-empty summary + explanation;
 * citations must be an array of {claim, source} (tolerates an empty array).
 */
export function parseVerdict(input: unknown): CaseVerdict | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>

  const verdict = o.verdict
  if (verdict !== 'apply' && verdict !== 'skip' && verdict !== 'needs-human') return null

  const confidence = o.confidence
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') return null

  const summary = o.summary
  if (typeof summary !== 'string' || summary.trim().length === 0) return null

  const explanation = o.explanation
  if (typeof explanation !== 'string' || explanation.trim().length === 0) return null

  const rawCitations = o.citations
  if (!Array.isArray(rawCitations)) return null
  const citations: Array<{ claim: string; source: string }> = []
  for (const c of rawCitations) {
    if (!c || typeof c !== 'object') return null
    const cc = c as Record<string, unknown>
    if (typeof cc.claim !== 'string' || typeof cc.source !== 'string') return null
    citations.push({ claim: cc.claim, source: cc.source })
  }

  return { verdict, confidence, summary, explanation, citations }
}

/**
 * The verdict synthesized when the model burns its whole budget (incl. the grace
 * iteration) without calling submit_verdict. Always needs-human / low confidence.
 */
export function synthesizeUnconvergedVerdict(): CaseVerdict {
  return {
    verdict: 'needs-human',
    confidence: 'low',
    summary:
      'Investigation did not converge — the automatic check ran out of steps before reaching a clear conclusion. A person should review this one.',
    explanation:
      'The investigator used its full lookup budget without settling on who is wrong. Treat this as unresolved and check it by hand.',
    citations: [],
  }
}

/** Next monotonic position given the current max (or null when the case has none). */
export function nextPosition(currentMax: number | null): number {
  return (currentMax ?? -1) + 1
}

/** The `submit_verdict` tool definition — the loop TERMINATES when the model calls it. */
export const SUBMIT_VERDICT_TOOL: Anthropic.Tool = {
  name: 'submit_verdict',
  description:
    'Call this ONCE, at the very end, when you can explain who is wrong and what to do. It ends ' +
    'the investigation. verdict "skip" = the flag is a known/explained source-sheet issue and the ' +
    'database is already correct (recommend dismissing). "apply" = the set-aside row itself should ' +
    'genuinely be saved (rare). "needs-human" = genuinely ambiguous even after investigating. Put ' +
    'exact dates + kg in summary/explanation and cite every number in citations.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['apply', 'skip', 'needs-human'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      summary: { type: 'string', description: 'One or two plain sentences a plant manager can act on.' },
      explanation: { type: 'string', description: 'The fuller plain-language reasoning.' },
      citations: {
        type: 'array',
        description: 'One entry per numeric claim.',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            source: { type: 'string', description: 'Which tool + what you asked it.' },
          },
          required: ['claim', 'source'],
        },
      },
    },
    required: ['verdict', 'confidence', 'summary', 'explanation', 'citations'],
  },
}

/** A row about to be inserted into sync_case_messages. */
export interface CaseMessageInsert {
  case_id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  tool_calls: Json | null
  tool_results: Json | null
  position: number
}

/** Build a system-note message row (e.g. "Investigation started"). */
export function buildSystemRow(caseId: string, content: string, position: number): CaseMessageInsert {
  return { case_id: caseId, role: 'system', content, tool_calls: null, tool_results: null, position }
}

/** Build the opening user (briefing) message row. */
export function buildUserRow(caseId: string, content: string, position: number): CaseMessageInsert {
  return { case_id: caseId, role: 'user', content, tool_calls: null, tool_results: null, position }
}

/** Build an assistant message row from one iteration's text + tool_use blocks. */
export function buildAssistantRow(
  caseId: string,
  text: string,
  toolCalls: Array<{ id: string; name: string; input: unknown }>,
  position: number,
): CaseMessageInsert {
  return {
    case_id: caseId,
    role: 'assistant',
    content: text,
    tool_calls: (toolCalls.length ? toolCalls : null) as Json | null,
    tool_results: null,
    position,
  }
}

/** Build a tool message row from one iteration's tool results. */
export function buildToolRow(
  caseId: string,
  toolResults: Array<{ tool_use_id: string; content: string }>,
  position: number,
): CaseMessageInsert {
  return {
    case_id: caseId,
    role: 'tool',
    content: '',
    tool_calls: null,
    tool_results: (toolResults.length ? toolResults : null) as Json | null,
    position,
  }
}

// ============================================================================
// The loop (network + DB)
// ============================================================================

type AdminClient = ReturnType<typeof createAdminClient>

/** Load the max message position for a case (or null). */
async function currentMaxPosition(admin: AdminClient, caseId: string): Promise<number | null> {
  const { data } = await admin
    .from('sync_case_messages')
    .select('position')
    .eq('case_id', caseId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.position ?? null
}

/** The minimal tool surface runToolLoop drives (matches createInvestigatorTools). */
interface ToolSurface {
  definitions: Anthropic.Tool[]
  execute(name: string, args: Record<string, unknown>): Promise<string>
}

/** What one runToolLoop pass produces. */
export interface ToolLoopOutcome {
  /** The verdict the model submitted, or null if it never called submit_verdict. */
  verdict: CaseVerdict | null
  /** Whether the model called submit_verdict at all this pass. */
  verdictSubmitted: boolean
  /** Total tool calls consumed. */
  toolCallCount: number
  /** The next free message position after all persisted turns. */
  pos: number
}

/**
 * The shared Anthropic tool-use loop (extracted P4). Drives `messages` (which it
 * MUTATES in place, appending each assistant/tool turn) against `tools` + the
 * terminal `submit_verdict` tool, persisting every turn to `sync_case_messages`
 * via `persist`, until the model submits a verdict or the budget is exhausted.
 *
 * Behavior is IDENTICAL to the loop that was previously inline in runInvestigation
 * (grace iteration, budget nudges, malformed-verdict fallback) — runInvestigation
 * now calls this so investigation + chat share one loop body.
 *
 * The caller owns: seeding `messages`, persisting the opening turns, and deciding
 * what to do with the returned verdict (write it onto the case, or not).
 */
export async function runToolLoop(params: {
  caseId: string
  model: string
  system: string
  messages: Anthropic.MessageParam[]
  tools: ToolSurface
  persist: (row: CaseMessageInsert) => Promise<void>
  startPos: number
  /** Start the tool-call budget partway used (chat continuation). Default 0. */
  toolCallsUsed?: number
}): Promise<ToolLoopOutcome> {
  const { caseId, model, system, messages, tools, persist } = params
  const toolDefs: Anthropic.Tool[] = [...tools.definitions, SUBMIT_VERDICT_TOOL]

  let pos = params.startPos
  let toolCallCount = params.toolCallsUsed ?? 0
  let finalVerdict: CaseVerdict | null = null
  let verdictSubmitted = false
  let grantedGrace = false

  for (let iter = 0; iter < MAX_ITERATIONS + 1; iter++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: INVESTIGATOR_MAX_TOKENS,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools: toolDefs,
    })

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    const assistantText = textBlocks.map((b) => b.text).join('')

    // Did the model call submit_verdict? That terminates the loop.
    const verdictCall = toolUseBlocks.find((b) => b.name === 'submit_verdict')
    if (verdictCall) {
      const parsed = parseVerdict(verdictCall.input)
      finalVerdict = parsed ?? synthesizeUnconvergedVerdict()
      verdictSubmitted = true
      await persist(
        buildAssistantRow(
          caseId,
          assistantText,
          toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
          pos++,
        ),
      )
      // Persist a synthetic tool_result for EVERY tool_use on this terminal turn
      // (submit_verdict + any sibling calls the model bundled with it). Without
      // this the stored transcript ends with an assistant tool_use that has no
      // following tool_result — which foldHistory replays verbatim, and the
      // Anthropic API rejects (400: tool_use without tool_result). The verdict
      // call gets an "ok" note; any sibling gets a neutral placeholder.
      await persist(
        buildToolRow(
          caseId,
          toolUseBlocks.map((b) => ({
            tool_use_id: b.id,
            content:
              b.id === verdictCall.id
                ? JSON.stringify({ ok: true, note: 'verdict recorded' })
                : JSON.stringify({ ok: true, note: 'not executed — investigation ended' }),
          })),
          pos++,
        ),
      )
      break
    }

    // No verdict yet. If there are tool calls, execute them (sequentially).
    if (toolUseBlocks.length > 0 && response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Array<{ tool_use_id: string; content: string }> = []
      const toolCalls: Array<{ id: string; name: string; input: unknown }> = []
      for (const block of toolUseBlocks) {
        toolCallCount++
        let result: string
        if (toolCallCount > MAX_TOOL_CALLS) {
          result = JSON.stringify({ error: 'tool-call budget exhausted — call submit_verdict now.' })
        } else {
          result = await tools.execute(block.name, block.input as Record<string, unknown>)
        }
        toolResults.push({ tool_use_id: block.id, content: result })
        toolCalls.push({ id: block.id, name: block.name, input: block.input })
      }

      await persist(buildAssistantRow(caseId, assistantText, toolCalls, pos++))
      await persist(buildToolRow(caseId, toolResults, pos++))

      messages.push({
        role: 'user',
        content: toolResults.map((tr) => ({
          type: 'tool_result' as const,
          tool_use_id: tr.tool_use_id,
          content: tr.content,
        })),
      })
      continue
    }

    // No tool call and no verdict (end_turn or empty). Record what it said.
    if (assistantText) await persist(buildAssistantRow(caseId, assistantText, [], pos++))

    // Out of budget? Give ONE grace nudge, then synthesize.
    const outOfIterations = iter >= MAX_ITERATIONS - 1
    if (outOfIterations && !grantedGrace) {
      grantedGrace = true
      const nudge =
        'You are out of investigation budget. Call submit_verdict now with your best conclusion.'
      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: nudge })
      await persist(buildSystemRow(caseId, nudge, pos++))
      continue
    }
    if (grantedGrace) {
      finalVerdict = synthesizeUnconvergedVerdict()
      break
    }
    // Otherwise keep looping (nudge the model to continue investigating).
    messages.push({ role: 'assistant', content: response.content })
    messages.push({
      role: 'user',
      content: 'Continue investigating, or call submit_verdict if you can conclude.',
    })
  }

  return { verdict: finalVerdict, verdictSubmitted, toolCallCount, pos }
}

export async function runInvestigation(
  caseId: string,
  opts: RunInvestigationOpts = {},
): Promise<InvestigationOutcome> {
  const admin = createAdminClient()
  const escalate = opts.escalate ?? false
  const force = opts.force ?? false
  const model = escalate ? INVESTIGATOR_ESCALATION_MODEL : INVESTIGATOR_MODEL

  // 1. Load the case.
  const { data: theCase, error: loadErr } = await admin
    .from('sync_held_cases')
    .select(
      'id, report_type, kind, natural_key, reason, detail, row, status, occurrence_count, last_run_id, known_ruling_id, sync_case_rulings!sync_held_cases_known_ruling_id_fkey(verdict_summary)',
    )
    .eq('id', caseId)
    .maybeSingle()
  if (loadErr || !theCase) {
    return { status: 'error', error: loadErr?.message ?? 'case not found' }
  }

  // 2. Skip conditions (single-flight + already-done + known-ruling reuse).
  if (theCase.status === 'investigating') return { status: 'skipped' }
  if (!force && (theCase.status === 'investigated' || theCase.status === 'resolved')) {
    return { status: 'skipped' }
  }
  if (!force && theCase.known_ruling_id) {
    // Ledger-matched known issue — reuse the prior ruling, no tokens burned.
    return { status: 'skipped' }
  }

  // 3. Compare-and-swap the status to 'investigating' — the concurrency guard.
  //    open → investigating (normal); on force, any non-investigating → investigating.
  let claim = admin.from('sync_held_cases').update({ status: 'investigating' }).eq('id', caseId)
  claim = force ? claim.neq('status', 'investigating') : claim.eq('status', 'open')
  const { data: claimed, error: claimErr } = await claim.select('id').maybeSingle()
  if (claimErr) return { status: 'error', error: claimErr.message }
  if (!claimed) return { status: 'skipped' } // someone else won the race

  // From here on, any error MUST reset the status to 'open' (never stuck).
  try {
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

    // Tools — canViewPrices HARD false (this surface never sees ₱).
    const tools = createInvestigatorTools({ runId: theCase.last_run_id ?? null, canViewPrices: false })

    const system = buildInvestigatorSystem()
    const briefing = buildCaseBriefing(briefInput)

    // Persist messages with a locally-incremented monotonic position.
    let pos = nextPosition(await currentMaxPosition(admin, caseId))
    const persist = async (row: CaseMessageInsert) => {
      const { error } = await admin.from('sync_case_messages').insert(row)
      if (error) throw new Error(`persist message failed: ${error.message}`)
    }

    // System start note + opening user briefing.
    const trigger = escalate ? 'escalation → Opus' : force ? 're-investigate' : 'auto'
    await persist(buildSystemRow(caseId, `Investigation started (${model}, ${trigger}).`, pos++))
    await persist(buildUserRow(caseId, briefing, pos++))

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: briefing }]

    // Drive the shared tool-use loop (extracted so chat mode reuses the same body).
    const loop = await runToolLoop({
      caseId,
      model,
      system,
      messages,
      tools,
      persist,
      startPos: pos,
    })
    pos = loop.pos
    const toolCallCount = loop.toolCallCount
    const finalVerdict = loop.verdict ?? synthesizeUnconvergedVerdict()

    // Final plain-language assistant summary row, then write the verdict onto the case.
    await persist(
      buildAssistantRow(
        caseId,
        `${finalVerdict.summary}\n\n${finalVerdict.explanation}`,
        [],
        pos++,
      ),
    )

    const persisted: PersistedVerdict = {
      ...finalVerdict,
      model,
      investigated_at: new Date().toISOString(),
      tool_call_count: toolCallCount,
    }
    const { error: updErr } = await admin
      .from('sync_held_cases')
      .update({
        status: 'investigated',
        verdict: persisted as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId)
    if (updErr) throw new Error(`verdict write failed: ${updErr.message}`)

    return { status: 'done', verdict: finalVerdict }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Reset the case out of 'investigating' so it is never stuck, and record the error.
    await admin
      .from('sync_held_cases')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', caseId)
    try {
      const p = nextPosition(await currentMaxPosition(admin, caseId))
      await admin
        .from('sync_case_messages')
        .insert(buildSystemRow(caseId, `Investigation error: ${message}`, p))
    } catch {
      // best-effort — don't mask the original error
    }
    return { status: 'error', error: message }
  }
}
