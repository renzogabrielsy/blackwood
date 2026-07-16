---
name: jarvis-foundation
description: Jarvis AI chat agent — tables, server actions, Anthropic SDK integration patterns, and SDK version gotchas
metadata:
  type: project
---

# Jarvis Foundation (2026-05-26)

## What was built

Migration `20260526020000_create_jarvis_tables` applied to live Supabase + local file:
- `jarvis_conversations` — user_id FK, title (nullable, auto-set), archived
- `jarvis_messages` — conversation_id FK (cascade), role check, tool_calls JSONB, tool_results JSONB, position int (monotonic ordering)
- `jarvis_learnings` — user_id FK, type check ('preference'|'pattern'|'correction'), source_message_id FK nullable
- `pending_review` — source_email_id (idempotency), rows_json JSONB, overall_confidence numeric(4,3), status check, reviewed_by FK→profiles, commit_audit_log_id FK→audit_logs

**Why:** [[project-rc-movement]] established Jarvis need. These tables persist AI chat sessions and the email ingestion review queue.

**How to apply:** Always use `mcp__supabase__apply_migration`, never the CLI, for remote DB work. Then write the local `.sql` file manually for version tracking.

## Server actions contract (locked — frontend builds against this)

Located at `app/(app)/jarvis/actions.ts`:

```
chat(input: { conversationId: string | null; message: string })
  → Promise<{ conversationId: string; reply: string; toolCallsExecuted?: [...] }>

listConversations()
  → Promise<Array<{ id, title, created_at, last_message_at }>>

getMessages(conversationId: string)
  → Promise<Array<{ id, role, content, created_at }>>

clearConversation()
  → Promise<{ conversationId: string }>
```

## Anthropic SDK v0.98 type gotchas

**TextBlock requires `citations: Array<TextCitation> | null`** and **ToolUseBlock requires `caller: DirectCaller | ...`** — these are SDK-returned types with extra required fields that don't exist on input/param types.

**Fix:** When building assistant message content arrays from stored data:
- Use `Anthropic.TextBlockParam` (not `TextBlock`) — only requires `{type:'text', text:string}`
- Use `Anthropic.ToolUseBlockParam` (not `ToolUseBlock`) — only requires `{type:'tool_use', id, name, input}`
- Then cast the array as `Anthropic.ContentBlock[]` for MessageParam (TypeScript accepts this)

**Why this matters:** The API response gives you ContentBlock[] (with citations, caller). When you reconstruct from stored JSON, you're building ContentBlockParam[] (inputs). These are different types in v0.98.

## Tool-use loop DB persistence pattern

For each tool-use iteration:
1. Insert ONE `role='assistant'` message with `tool_calls=[{id,name,input}]` array
2. Insert ONE `role='tool'` message with `tool_results=[{tool_use_id,content:JSON.stringify(result)}]` array
3. On history replay → assistant row becomes ContentBlock[] (text + tool_use blocks), tool row becomes user-turn tool_result blocks

## Prompt caching

System prompt in `lib/jarvis/system-prompt.ts` is ~2.5K tokens. Injected with:
```ts
system: [{ type: 'text', text: JARVIS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]
```
Cache window is ~5 minutes on Sonnet 4.6. Minimum 2048 tokens to cache. Do NOT shrink the prompt below ~2K tokens.

## Tool auth pattern

Tool handlers in `lib/jarvis/tool-handlers.ts` use `createAdminClient()` (service role) for DB reads. This bypasses RLS — intentional, Jarvis has elevated read privilege. Cost/price fields are NOT yet scrubbed in v1 (Renzo is Owner so it's fine; add role-gating in Phase 2).

## TypeScript narrowing: string | null after if-block

When `let x: string | null` is reassigned inside an if-block, TypeScript can't narrow it after. Pattern:
```ts
let resolvedId: string
if (input.id) { resolvedId = input.id } else { resolvedId = newId }
const id = resolvedId  // now `string` forever
```

## Status filter type constraint

`batches.status` is typed as `Database['public']['Enums']['batch_status'] | null`. When filtering with `.eq('status', status)`, the arg must be `BatchStatus` not `string`. Import the type alias or inline the cast.
