'use server'

import { revalidatePath } from 'next/cache'
import type Anthropic from '@anthropic-ai/sdk'
import { anthropic, JARVIS_MODEL, JARVIS_MAX_TOKENS } from '@/lib/anthropic/client'
import { JARVIS_SYSTEM_PROMPT } from '@/lib/jarvis/system-prompt'
import { TOOL_DEFINITIONS, executeToolCall } from '@/lib/jarvis/tool-handlers'
import { createClient } from '@/lib/supabase/server'

// ============================================================
// Internal helpers
// ============================================================

/** Authenticate and return the current user, or throw. */
async function requireUser() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    throw new Error('Not authenticated')
  }
  return { supabase, user }
}

/**
 * Get the next position index for a message in a conversation.
 * Reads max(position) from jarvis_messages for this conversation.
 */
async function nextPosition(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string
): Promise<number> {
  const { data } = await supabase
    .from('jarvis_messages')
    .select('position')
    .eq('conversation_id', conversationId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (data?.position ?? -1) + 1
}

/**
 * Map stored jarvis_messages rows to Anthropic message format.
 * Tool messages are folded into user turns as tool_result blocks
 * per the Anthropic SDK multi-turn tool-use pattern.
 *
 * We use ContentBlockParam[] (not ContentBlock[]) for assistant message content
 * because ContentBlock carries SDK-added fields (citations, caller) that we don't
 * store and don't need to reconstruct. ContentBlockParam is the input type for
 * building messages, which accepts the minimal shape we have in storage.
 */
function buildAnthropicMessages(
  rows: Array<{
    role: string
    content: string
    tool_calls: unknown
    tool_results: unknown
  }>
): Anthropic.MessageParam[] {
  const params: Anthropic.MessageParam[] = []

  for (const row of rows) {
    if (row.role === 'user') {
      params.push({ role: 'user', content: row.content })
    } else if (row.role === 'assistant') {
      // Reconstruct assistant content blocks using Param types (input shapes)
      const content: Anthropic.ContentBlockParam[] = []

      if (row.content) {
        const textBlock: Anthropic.TextBlockParam = { type: 'text', text: row.content }
        content.push(textBlock)
      }

      // tool_calls stored as JSON array of { id, name, input }
      const toolCalls = row.tool_calls as Array<{
        id: string
        name: string
        input: unknown
      }> | null

      if (toolCalls && Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const toolUseBlock: Anthropic.ToolUseBlockParam = {
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input as Record<string, unknown>,
          }
          content.push(toolUseBlock)
        }
      }

      if (content.length > 0) {
        params.push({ role: 'assistant', content })
      }
    } else if (row.role === 'tool') {
      // Tool results are folded into user turns as tool_result content blocks
      const toolResults = row.tool_results as Array<{
        tool_use_id: string
        content: string
      }> | null

      if (toolResults && Array.isArray(toolResults)) {
        const blocks: Anthropic.ToolResultBlockParam[] = toolResults.map(tr => ({
          type: 'tool_result' as const,
          tool_use_id: tr.tool_use_id,
          content: tr.content,
        }))
        params.push({ role: 'user', content: blocks })
      }
    }
    // Skip 'system' role rows — those are injected as the system param, not messages
  }

  return params
}

// ============================================================
// Locked public contract — frontend builds against these exact signatures
// ============================================================

export async function chat(input: {
  conversationId: string | null
  message: string
}): Promise<{
  conversationId: string
  reply: string
  toolCallsExecuted?: Array<{ name: string; args: unknown; result: unknown }>
}> {
  const { supabase, user } = await requireUser()

  // 1. Create conversation if needed
  let isNewConversation = false
  let resolvedConversationId: string

  if (input.conversationId) {
    resolvedConversationId = input.conversationId
  } else {
    const { data: conv, error: convErr } = await supabase
      .from('jarvis_conversations')
      .insert({ user_id: user.id })
      .select('id')
      .single()

    if (convErr || !conv) {
      throw new Error(`Failed to create conversation: ${convErr?.message}`)
    }
    resolvedConversationId = conv.id
    isNewConversation = true
  }

  const conversationId = resolvedConversationId

  // 2. Insert user message
  const userPosition = await nextPosition(supabase, conversationId)
  const { error: msgErr } = await supabase
    .from('jarvis_messages')
    .insert({
      conversation_id: conversationId,
      role: 'user',
      content: input.message,
      position: userPosition,
    })

  if (msgErr) {
    throw new Error(`Failed to store user message: ${msgErr.message}`)
  }

  // 3. Load full conversation history for context
  const { data: history, error: histErr } = await supabase
    .from('jarvis_messages')
    .select('role, content, tool_calls, tool_results')
    .eq('conversation_id', conversationId)
    .order('position', { ascending: true })

  if (histErr) {
    throw new Error(`Failed to load conversation history: ${histErr.message}`)
  }

  // 4. Build Anthropic messages from history
  const anthropicMessages = buildAnthropicMessages(history ?? [])

  // 5. Tool-use loop (max 5 iterations)
  const MAX_ITERATIONS = 5
  const allToolCallsExecuted: Array<{ name: string; args: unknown; result: unknown }> = []
  let finalReply = ''
  let currentMessages = anthropicMessages

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: JARVIS_MODEL,
      max_tokens: JARVIS_MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: JARVIS_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: currentMessages,
      tools: TOOL_DEFINITIONS,
    })

    if (response.stop_reason === 'end_turn') {
      // Extract text from response
      for (const block of response.content) {
        if (block.type === 'text') {
          finalReply += block.text
        }
      }
      break
    }

    if (response.stop_reason === 'tool_use') {
      // Extract tool_use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      )
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      )
      const assistantText = textBlocks.map(b => b.text).join('')

      // Append assistant turn with tool_use blocks to message thread
      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: response.content },
      ]

      // Execute each tool call, collect results
      const toolResults: Array<{
        tool_use_id: string
        content: string
      }> = []

      const toolCallsThisIteration: Array<{
        id: string
        name: string
        input: unknown
      }> = []

      for (const toolBlock of toolUseBlocks) {
        const result = await executeToolCall(
          toolBlock.name,
          toolBlock.input as Record<string, unknown>
        )

        allToolCallsExecuted.push({
          name: toolBlock.name,
          args: toolBlock.input,
          result,
        })

        toolCallsThisIteration.push({
          id: toolBlock.id,
          name: toolBlock.name,
          input: toolBlock.input,
        })

        toolResults.push({
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result),
        })
      }

      // Append tool results turn (user role with tool_result blocks)
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.tool_use_id,
        content: tr.content,
      }))
      currentMessages = [
        ...currentMessages,
        { role: 'user' as const, content: toolResultBlocks },
      ]

      // Persist assistant message + tool message to DB
      let pos = await nextPosition(supabase, conversationId)

      await supabase.from('jarvis_messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: assistantText,
        tool_calls: toolCallsThisIteration as unknown as import('@/types/supabase').Json,
        position: pos,
      })
      pos++

      await supabase.from('jarvis_messages').insert({
        conversation_id: conversationId,
        role: 'tool',
        content: '',
        tool_results: toolResults as unknown as import('@/types/supabase').Json,
        position: pos,
      })

      continue
    }

    // Unexpected stop_reason — break with whatever text we have
    for (const block of response.content) {
      if (block.type === 'text') finalReply += block.text
    }
    break
  }

  // 6. Insert final assistant reply
  const replyPosition = await nextPosition(supabase, conversationId)
  await supabase.from('jarvis_messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    content: finalReply,
    position: replyPosition,
  })

  // 7. Update conversation last_message_at
  await supabase
    .from('jarvis_conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId)

  // 8. Set conversation title from first user message (truncate to 60 chars)
  if (isNewConversation) {
    const title = input.message.slice(0, 60).trim()
    await supabase
      .from('jarvis_conversations')
      .update({ title })
      .eq('id', conversationId)
  }

  revalidatePath('/')

  return {
    conversationId,
    reply: finalReply,
    toolCallsExecuted: allToolCallsExecuted.length > 0 ? allToolCallsExecuted : undefined,
  }
}

export async function listConversations(): Promise<
  Array<{
    id: string
    title: string
    created_at: string
    last_message_at: string
  }>
> {
  const { supabase, user } = await requireUser()

  const { data, error } = await supabase
    .from('jarvis_conversations')
    .select('id, title, created_at, last_message_at')
    .eq('user_id', user.id)
    .eq('archived', false)
    .order('last_message_at', { ascending: false })
    .limit(50)

  if (error) {
    throw new Error(`Failed to list conversations: ${error.message}`)
  }

  return (data ?? []).map(c => ({
    id: c.id,
    title: c.title ?? 'New conversation',
    created_at: c.created_at,
    last_message_at: c.last_message_at,
  }))
}

export async function getMessages(conversationId: string): Promise<
  Array<{
    id: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    content: string
    created_at: string
  }>
> {
  const { supabase, user } = await requireUser()

  // Verify the conversation belongs to this user
  const { data: conv, error: convErr } = await supabase
    .from('jarvis_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (convErr || !conv) {
    throw new Error('Conversation not found or access denied')
  }

  const { data, error } = await supabase
    .from('jarvis_messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('position', { ascending: true })

  if (error) {
    throw new Error(`Failed to load messages: ${error.message}`)
  }

  return (data ?? []).map(m => ({
    id: m.id,
    role: m.role as 'user' | 'assistant' | 'tool' | 'system',
    content: m.content,
    created_at: m.created_at,
  }))
}

export async function clearConversation(): Promise<{ conversationId: string }> {
  const { supabase, user } = await requireUser()

  const { data: conv, error } = await supabase
    .from('jarvis_conversations')
    .insert({ user_id: user.id, title: null })
    .select('id')
    .single()

  if (error || !conv) {
    throw new Error(`Failed to create new conversation: ${error?.message}`)
  }

  revalidatePath('/')

  return { conversationId: conv.id }
}
