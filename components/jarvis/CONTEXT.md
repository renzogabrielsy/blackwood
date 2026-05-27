# Jarvis Chat Component

## Purpose
Slide-out AI chat panel ("Jarvis") accessible from every page in the `(app)` route group. Conversational, tool-using, persistent across navigations. Powered by Sonnet 4.6 server-side via `chat()` server action. v1 is **request-response** (no streaming), **plain text** (no markdown), **inventory-only** in scope.

This directory is the UI scaffold — the brain (Claude API + tool handlers) lives behind `app/(app)/jarvis/actions.ts`.

## Files

| File | Lines | Role |
|------|-------|------|
| `JarvisProvider.tsx` | ~75 | Context — `open` state + `Cmd/Ctrl+K` global keybind + `bw_jarvis_open` localStorage persistence |
| `JarvisFloatingButton.tsx` | ~50 | Fixed-position FAB (bottom-right). Hidden when panel is open. `animate-fade-up` on first-ever mount (gated by `bw_jarvis_seen` localStorage flag) |
| `JarvisChatPanel.tsx` | ~165 | The slide-out shell. Composes header, history, message list, error banner, input footer |
| `JarvisMessage.tsx` | ~140 | Single bubble + tool-call collapsed strip + 3-dot typing indicator |
| `JarvisInput.tsx` | ~95 | Auto-grow textarea (1-6 rows). Enter sends, Shift+Enter newline |
| `JarvisConversationList.tsx` | ~115 | Collapsible history strip — shows the 5 most recent conversations, switch or start new |
| `useJarvisChat.ts` | ~190 | Hook — manages `conversationId`, messages, pending flag, error, bootstrap, optimistic appends, retry |

## Data (server action contract)

All four actions live at `app/(app)/jarvis/actions.ts` — owned by the backend agent. The UI imports the symbols directly; do not modify the signatures.

```ts
chat(input: { conversationId: string | null; message: string }):
  Promise<{
    conversationId: string
    reply: string
    toolCallsExecuted?: Array<{ name: string; args: unknown; result: unknown }>
  }>

listConversations(): Promise<Array<{ id; title; created_at; last_message_at }>>

getMessages(conversationId: string):
  Promise<Array<{ id; role: 'user' | 'assistant' | 'tool' | 'system'; content; created_at }>>

clearConversation(): Promise<{ conversationId: string }>
```

### Backing tables (provisioned by the backend agent)
- `jarvis_conversations` — `id`, `title`, `created_at`, `last_message_at`, `user_id`
- `jarvis_messages` — `id`, `conversation_id`, `role`, `content`, `created_at`

See `AI_INGESTION_AGENT.md` for the broader agent design and `handoffs/2026-05-26-rc-movement-backfill-jarvis-foundation.md` for context.

## Key Behaviors

### Mount & lifecycle
- `JarvisProvider` wraps everything inside `AppShell`. `JarvisFloatingButton` and `JarvisChatPanel` are siblings of `<Navbar />` and `<FloatingStatusBar />`.
- Panel is lazy-loaded via `dynamic(..., { ssr: false })` — Radix Dialog hydration parity matches the Navbar pattern.
- `useJarvisChat` bootstraps once on first mount: fetches `listConversations()`, selects the most recent (if any), loads its messages.

### Open / close
- FAB click toggles `open`.
- `Cmd+K` / `Ctrl+K` globally toggles `open` (ignored when focus is in a contentEditable element).
- `open` is persisted to `localStorage` under `bw_jarvis_open` so it survives page navigation and reloads.
- On open, the textarea is focused via `requestAnimationFrame` (after Radix places the content).

### Messaging
- Optimistic append: user bubble is added immediately; on success the assistant bubble is appended; on failure the user bubble stays in place so retry has something to send.
- Typing indicator: 3 animated dots in the assistant slot while `pending`.
- Empty state: friendly empty-state block with two example prompts (`What did we deliver yesterday?`, `Closed batches this month`).
- Error: red banner with retry button; does not destroy the conversation.

### Tool calls
- When the assistant returns `toolCallsExecuted`, each call renders as a collapsed `<details>` strip beneath the bubble: name + result summary (e.g. "8 results"). Expanding shows `args` and `result` JSON.
- Server-emitted `role='tool'` messages render as a standalone strip outside the bubble flow.

### /clear
- The Eraser icon in the header is a two-click confirmation (first click flips it red for 3 seconds, second click commits). Calls `clearConversation()`, resets local state, refreshes the conversation list.

### History
- Collapsible section above the message list. Defaults to collapsed.
- Shows the 5 most recent conversations when expanded; full list after that.
- "New" button starts a fresh conversation locally (no server hit — the next `sendMessage` lazily creates it).

### Scroll
- Message container auto-scrolls to the bottom on new message or when the typing indicator flips.

## Dependencies

- `radix-ui` (composite package) — used via `Dialog as SheetPrimitive` in `components/ui/sheet.tsx`
- `components/ui/sheet.tsx` — slide-out primitive built on Radix Dialog (created alongside this module; not previously in shadcn for this project)
- `components/ui/button.tsx`
- `lucide-react` — `Sparkles`, `Eraser`, `X`, `ArrowUp`, `Loader2`, `User`, `Cog`, `ChevronRight`, `ChevronDown`, `MessageSquarePlus`, `History`, `AlertCircle`
- `date-fns` — `formatDistanceToNow` for history timestamps
- `lib/utils.ts` — `cn()`

## Mount point

- `app/(app)/app-shell.tsx` — wraps all `(app)/*` children with `<JarvisProvider>`, mounts `<JarvisFloatingButton />` and `<JarvisChatPanel />`. Routes outside the `(app)` group (`/login`, `/access-denied`) do not include Jarvis.

## Keyboard shortcuts

| Keys | Action |
|------|--------|
| `Cmd+K` / `Ctrl+K` | Toggle Jarvis panel |
| `Enter` (in input) | Send message |
| `Shift+Enter` (in input) | Insert newline |
| `Esc` | Close panel (Radix default) |

## See Also
- `app/(app)/jarvis/actions.ts` — server actions (backend agent owns this)
- `AI_INGESTION_AGENT.md` — broader Jarvis / ingestion architecture
- `handoffs/2026-05-26-rc-movement-backfill-jarvis-foundation.md` — most recent context, why we're building this
- `components/ui/sheet.tsx` — the Sheet primitive we added for this feature
- `components/NAVBAR.md`, `components/NOTIFICATIONS.md` — sibling chrome components mounted in `AppShell`
