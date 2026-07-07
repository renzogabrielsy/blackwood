/**
 * case-history.ts — the PURE, server-import-free transcript→Anthropic-messages layer
 * for the held-case chat (P4).
 *
 * Deliberately split out of case-chat.ts (`'use server'`, where only async server
 * actions may be exported) so these synchronous pure functions can be exported AND
 * unit-tested without a Next server context, a DB, or the network — the same split
 * discipline adjudication.ts uses against actions.ts.
 *
 * Two functions:
 *   - foldHistory: fold stored sync_case_messages rows into Anthropic MessageParam[].
 *   - sanitizeAnthropicHistory: repair the tool_use/tool_result pairing invariant so
 *     the replayed history is always API-valid (heals dangling submit_verdict turns
 *     already on disk — see the fn doc).
 */
import type Anthropic from '@anthropic-ai/sdk'

/**
 * A stored sync_case_messages row folded into an Anthropic MessageParam[].
 * Mirrors app/(app)/jarvis/actions.ts::buildAnthropicMessages:
 *   - 'user'      → a plain user turn
 *   - 'assistant' → an assistant turn (text + any tool_use blocks from tool_calls)
 *   - 'tool'      → a user turn carrying tool_result blocks (the SDK multi-turn shape)
 *   - 'system'    → skipped (start-notes / nudges are not conversation content)
 */
export function foldHistory(
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
 * Collect every tool_use id in an assistant turn (empty when it carries none).
 */
function toolUseIdsIn(msg: Anthropic.MessageParam | undefined): string[] {
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return []
  const ids: string[] = []
  for (const block of msg.content) {
    if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use') {
      ids.push((block as { id: string }).id)
    }
  }
  return ids
}

/**
 * Collect every tool_result tool_use_id in a user turn (empty when it carries none).
 */
function toolResultIdsIn(msg: Anthropic.MessageParam | undefined): string[] {
  if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) return []
  const ids: string[] = []
  for (const block of msg.content) {
    if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result') {
      ids.push((block as { tool_use_id: string }).tool_use_id)
    }
  }
  return ids
}

/**
 * Sanitize a folded Anthropic history so it satisfies the API's tool-use pairing
 * invariant: every assistant `tool_use` block MUST be immediately followed by a user
 * turn carrying a `tool_result` for its id.
 *
 * WHY THIS EXISTS (the bug this heals): the investigator loop persists a terminal
 * `submit_verdict` assistant turn and breaks — historically WITHOUT a following tool
 * row (now fixed at write-time in lib/investigator/loop.ts). But existing DB
 * transcripts still contain that dangling shape, and error-truncated runs can produce
 * it too. foldHistory replays the stored transcript verbatim, so without this pass the
 * Anthropic API rejects the very first chat message on every already-investigated case
 * (400: `tool_use` ids without `tool_result` blocks). This is REQUIRED regardless of
 * the write-time fix — it is the migration-free heal for rows already on disk.
 *
 * What it does, PURELY (no DB, no network):
 *   - for each assistant turn with tool_use ids, look at the NEXT message; inject a
 *     fresh user turn, or extend the existing next user turn, with synthetic
 *     tool_result blocks ('[result not recorded]') for any ids not already answered;
 *   - drop any orphan tool_result block whose tool_use id was NOT opened by the
 *     immediately-preceding assistant turn (defensive against malformed history).
 *
 * Does not mutate the input array — returns a new one.
 */
export function sanitizeAnthropicHistory(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  // Work on a shallow copy so we can extend a "next" user turn in place without
  // mutating the caller's array.
  const work = [...messages]
  const out: Anthropic.MessageParam[] = []

  for (let i = 0; i < work.length; i++) {
    const msg = work[i]

    // Defensive: drop orphan tool_result blocks in a user turn — a tool_result is
    // only valid when the IMMEDIATELY-PRECEDING assistant turn opened its id.
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const openedIds = new Set(toolUseIdsIn(work[i - 1]))
      const hasToolResult = msg.content.some(
        (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
      )
      if (hasToolResult) {
        const kept = msg.content.filter((b) => {
          if (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result') {
            return openedIds.has((b as { tool_use_id: string }).tool_use_id)
          }
          return true
        })
        // Skip a user turn that becomes empty after dropping every orphan result.
        if (kept.length === 0) continue
        out.push({ ...msg, content: kept })
      } else {
        out.push(msg)
      }
    } else {
      out.push(msg)
    }

    // If this is an assistant turn with tool_use ids, guarantee the NEXT emitted
    // message answers ALL of them.
    const openIds = toolUseIdsIn(msg)
    if (openIds.length === 0) continue

    const next = work[i + 1]
    const answered = new Set(toolResultIdsIn(next))
    const missing = openIds.filter((id) => !answered.has(id))
    if (missing.length === 0) continue

    const syntheticResults: Anthropic.ToolResultBlockParam[] = missing.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: '[result not recorded]',
    }))

    if (next && next.role === 'user' && Array.isArray(next.content)) {
      // The next turn is a user tool_result turn missing some ids — prepend the
      // synthetic results so ALL ids are answered when the loop emits that turn.
      work[i + 1] = { ...next, content: [...syntheticResults, ...next.content] }
    } else {
      // No suitable next turn — inject a fresh user turn carrying the synthetic results.
      out.push({ role: 'user', content: syntheticResults })
    }
  }

  return out
}
