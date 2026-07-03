# Jarvis Module — CONTEXT.md

> **STATUS (2026-07-03): Jarvis chat is DORMANT.** The floating button now opens the
> **Daily Sync** panel (`components/sync/SyncPanel.tsx`), not the chat. The chat
> components (`components/jarvis/JarvisChatPanel.tsx` etc.), the `chat()` server
> action, and the Jarvis DB tables all remain in the repo and are fully functional —
> they are simply **not mounted** in `app-shell.tsx` (a one-line comment marks where
> `JarvisChatPanel` used to be). `JarvisProvider` is still mounted: the Sync panel
> reuses its `open` state + Cmd/Ctrl+K keybind. To revive the chat, re-mount
> `JarvisChatPanel` alongside `SyncPanel` (or in place of it).

## Purpose

Jarvis is the AI chat agent embedded in Blackwood. It answers Renzo's inventory questions using live Supabase data via tool calls. Chat sessions persist across reloads. Tool-use loop handles multi-step queries (e.g. "how many STORED batches are in warehouse A?" → query_batches → answer).

Full design: `AI_INGESTION_AGENT.md` at project root. The Sync panel that replaced the chat in the FAB is documented at `app/(app)/sync/CONTEXT.md`.

## Files

### Backend (this agent's domain)
- `app/(app)/jarvis/actions.ts` — server actions (chat, listConversations, getMessages, clearConversation)
- `lib/anthropic/client.ts` — Anthropic SDK instance, model + token constants
- `lib/jarvis/system-prompt.ts` — JARVIS_SYSTEM_PROMPT (~2.5K tokens, prompt-cached)
- `lib/jarvis/tool-handlers.ts` — TOOL_DEFINITIONS (JSONSchema) + executeToolCall() dispatcher
- `lib/jarvis/extractors/types.ts` — ExtractedRow, EmailMeta, ReportExtractor interfaces
- `lib/jarvis/extractors/daily-production.ts` — DailyProductionExtractor skeleton (Phase 2)

### Frontend (senior-frontend-engineer's domain)
- `components/jarvis/` — chat UI components: `JarvisProvider`, `JarvisFloatingButton`,
  `JarvisChatPanel` (slide-out panel, dynamically imported), `JarvisConversationList`,
  `JarvisMessage`, `JarvisInput`, and the `useJarvisChat` hook. See
  `components/jarvis/CONTEXT.md`. (This `app/(app)/jarvis/` folder holds only
  `actions.ts` — there is no `page.tsx`/route; Jarvis is a floating panel, not a page.)
- Mounted via `app/(app)/app-shell.tsx` (which `app/(app)/layout.tsx` renders) so
  it's accessible from every page.

## Data

### Tables (created 2026-05-26, migration: create_jarvis_tables)
- `jarvis_conversations` — id, user_id, title (auto-set, max 60 chars), created_at, last_message_at, archived
- `jarvis_messages` — id, conversation_id, role ('user'|'assistant'|'tool'|'system'), content, tool_calls (JSONB), tool_results (JSONB), created_at, position
- `jarvis_learnings` — id, user_id, type ('preference'|'pattern'|'correction'), content, source_message_id, created_at, last_used_at (Phase 2 — inserts not yet implemented)
- `pending_review` — id, source_email_id, report_type, rows_json, overall_confidence, status ('pending'|'approved'|'rejected'|'manual_needed'), reviewed_by, final_rows_json, commit_audit_log_id

### RLS
- conversations/messages/learnings: user_id = auth.uid() only
- pending_review: any authenticated user can SELECT; only is_admin(auth.uid()) can INSERT/UPDATE/DELETE

## Key Behaviors

### chat() — the core action
1. Authenticates user (throws if not authenticated — no silent fallback)
2. Creates conversation if conversationId is null
3. Inserts user message with monotonic `position`
4. Loads full history, builds Anthropic MessageParam[] (tool messages folded into user turns as tool_result blocks)
5. System prompt injected with cache_control: { type: 'ephemeral' } for prompt caching
6. Tool-use loop: max 5 iterations. Each iteration: call API → if tool_use, execute all tools, append assistant + tool messages to DB and to in-memory thread → recurse. If end_turn, extract text, break.
7. Inserts final assistant message
8. Updates last_message_at on conversation
9. Sets title from first 60 chars of user message (new conversations only)
10. revalidatePath('/')

### Tool-use DB persistence pattern
- When assistant emits tool_use blocks: insert ONE 'assistant' message with tool_calls=[{id, name, input}]
- Then insert ONE 'tool' message with tool_results=[{tool_use_id, content: JSON.stringify(result)}]
- On replay (building Anthropic messages from history): assistant row → ContentBlock[] (text + tool_use), tool row → user turn with tool_result blocks

### Conversation title
First 60 chars of user's first message, set immediately (no Haiku call). Cheap and fast. May revisit with a proper title-generation call in Phase 2.

### No streaming (v1)
Request-response only. Streaming is Phase 2.

## Tools (v1)

| Name | Description | Key args |
|------|-------------|----------|
| query_batches | Query batches table | batch_code, status, location_ref, limit |
| query_deliveries | Query deliveries (RC IN) | start_date, end_date, supplier, batch_code, limit |

Both tools use `createAdminClient()` (service role) so they bypass RLS for AI reads. Cost/price fields ARE now gated: `executeToolCall` resolves the canonical `canViewPrices()` (`lib/auth.ts`, impersonation-aware) once and nulls `avg_cost` (batches) / `cost_basis` (deliveries) out of the returned rows for price-denied roles (Production) BEFORE they reach the model.

## Dependencies

- `@anthropic-ai/sdk` — already installed (v0.98.0+)
- `ANTHROPIC_API_KEY` — in .env.local
- `SUPABASE_SERVICE_ROLE_KEY` — in .env.local (used by createAdminClient for tool queries)
- `lib/supabase/server.ts` — createClient() for authenticated user operations
- `lib/supabase/admin.ts` — createAdminClient() for tool reads
- `lib/auth.ts` — `canViewPrices()` gates cost fields in tool results (see Tools note above)

## Ingestion Pipeline (Phase A — shipped 2026-05-27)

The AI ingestion pipeline lives in `lib/jarvis/` alongside the chat infrastructure.

### New files (Phase A)
- `lib/jarvis/extractors/rc-deliveries.ts` — RcDeliveriesExtractor (first real extractor)
  - Parses RC DELIVERIES XLSX files; flexible header mapping (synonyms)
  - Natural key: (transaction_date, batch_code, block_loc, weight_kg)
  - Validates: block_loc format, weight plausibility, lab value ranges, cost_basis range
  - Confidence: 1.0 − 0.15 per warning, floor 0.0
- `lib/jarvis/classifier.ts` — classifyEmail() + extractorForType() + REGISTRY
- `lib/jarvis/diff-engine.ts` — classifyRow() — live DB lookup + field diff
- `app/(app)/review-queue/actions.ts` — 5 server actions (locked contract)
- `app/(app)/review-queue/CONTEXT.md` — full review queue documentation

### New DB tables (Phase A)
- `ingestion_watermarks` — tracks Gmail poll state per report_type (Phase B writes here)
  - Migration: `supabase/migrations/20260527000000_create_ingestion_watermarks.sql`

### Adding Phase B extractors
1. Implement `ReportExtractor` interface in `lib/jarvis/extractors/<name>.ts`
2. Add instance to REGISTRY array in `lib/jarvis/classifier.ts`
3. Add its natural key + compare fields lookup in `app/(app)/review-queue/actions.ts` uploadForReview()

## See Also

- `AI_INGESTION_AGENT.md` — full design for the email ingestion pipeline
- `lib/jarvis/extractors/` — report extractors (rc-deliveries.ts + daily-production skeleton)
- `app/(app)/review-queue/CONTEXT.md` — review queue module
- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN module (primary data target)
- `app/(app)/inventory/rc-out/CONTEXT.md` — RC OUT module
- `app/(app)/inventory/blocking/CONTEXT.md` — Blocking module
