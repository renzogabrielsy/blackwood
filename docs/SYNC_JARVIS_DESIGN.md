# In-App "Jarvis" Sync — Architecture & Build Plan

> Status: **DESIGN ONLY** (no code written). Author: design pass, 2026-06.
> Goal: turn the Claude-Code "employee" sync into a **dashboard button** with a **live, animated activity feed** and an **in-app propose→approve→execute** flow, powered by the **Claude API (Agent SDK / Messages API)** — **not** the existing in-app Jarvis chatbot.

---

## 1. Context — why this is non-trivial

Today the ICTC sync runs **in Claude Code on Renzo's laptop**. Three things make it work that a web page cannot do on its own:

1. **The judgment is an AI agent** (classify rows, flag stale-Sheet reverts, L-010 batch remaps, catch the June-6 relabel duplicate). It is *reasoning*, not app code.
2. **Credentials stay local** — Gmail IMAP app-password + Supabase service role + the Anthropic key live on the machine, never in the browser app (a deliberate trust rule: "Gmail access stays in Claude Code, NOT the production app").
3. **Approval happens in chat** — propose → "go" → execute.

So the feature is **not** "a button + animations" (that's the easy 20%). It's **relocating the brain** to an always-on backend the website can summon, while preserving the credential boundary and the human gate.

**Good news:** the Claude API is exactly the relocation mechanism, and it preserves the trust rule *better* than today — Gmail/Supabase creds live in a **worker process**, never in the browser.

---

## 2. Goals / non-goals

**Goals**
- A **"Run Sync"** button on the dashboard (its own surface, not the chatbot).
- A **live Jarvis panel**: per-employee lanes (gsheet, deliveries, rc-out, production, audit) streaming each step — "fetching Gmail…", "classifying 47 rows…", "flagging stale Sheet revert…" — with the project's existing motion/glass animation language.
- **In-app propose→approve→execute**: the run pauses with a structured proposal (inserts / updates / flags / decisions), the user reviews + adjusts + approves, then writes happen.
- **Zero loss of the safety posture**: idempotency labels, the hard reconciliation halt, never-overwrite, audit logs, the 16 Learning-Ledger rules.

**Non-goals (v1)**
- Replacing the Python extractors (reuse them as tools).
- Fully autonomous, no-human writes (the propose gate stays).
- Moving the *pricing*/Czarina or Cenapro pipelines (RC IN/OUT/production only, same scope as today).
- Putting Gmail/Supabase-service-role creds anywhere near the browser.

---

## 3. The core architecture decision — Messages API + tool use (manual loop), on a host-side worker

The Claude API offers three surfaces. Decision:

| Surface | Fit for this | Verdict |
|---|---|---|
| **Single Messages call** | No — this is multi-step, tool-driven, judgment-heavy. | ✗ |
| **Messages API + tool use, manual agentic loop** | Yes — we host the compute, our tools (Python extractors, Gmail IMAP, Supabase) run with **host-side creds**, and the **manual loop is the documented choice for human-in-the-loop approval gates + custom logging + conditional execution**. | ✅ **Recommended** |
| **Managed Agents (CMA)** | Anthropic hosts the agent loop + a per-session container. Powerful, but our tools need host-side Gmail/Supabase secrets — you'd route them back via custom tools (CMA "Pattern 9: keep secrets host-side"), and a self-hosted sandbox/worker, which is *more* moving parts than just running the loop ourselves. | ⏸ Considered, deferred. Revisit if we want Anthropic to manage scaling/containers later. |

**Why manual loop specifically:** the Anthropic agent-design guidance says promote an action to a **dedicated, gated tool** when you need to "gate, render, audit, or parallelize" it — which is *exactly* our write step. The manual loop lets us (a) stop at "proposal ready," (b) render every tool call into the Jarvis panel, (c) refuse the write tools until approval, (d) run employees in parallel.

### 3.1 Topology

```
┌────────────────────────── Browser (Next.js dashboard) ──────────────────────────┐
│  [Run Sync] button   →  insert sync_run row (status=requested)                   │
│  Jarvis panel        ←  Supabase Realtime on sync_events  (live tool-call feed)  │
│  Proposal review UI   →  set sync_run.status=approved + decisions JSON           │
│         (browser NEVER sees Gmail/Anthropic/service-role creds)                  │
└──────────────────────────────────────────────────────────────────────────────────┘
                 ▲ Realtime           │ writes run/approval rows (RLS-gated)
                 │                     ▼
┌──────────────────────── Sync Worker (Node/TS, always-on) ────────────────────────┐
│  • Watches sync_run rows (Realtime or poll)                                       │
│  • Manual agentic loop per employee → Anthropic Messages API (Opus 4.8, stream)   │
│  • Tools = thin wrappers around the EXISTING Python scripts + Supabase + Gmail    │
│  • Emits sync_events (every tool call / narration / token) for the live panel     │
│  • Holds: ANTHROPIC_API_KEY, GMAIL_APP_PASSWORD, SUPABASE_SERVICE_ROLE_KEY        │
└──────────────────────────────────────────────────────────────────────────────────┘
         │ shells out / imports                          │ writes (gated)
         ▼                                                ▼
   .claude/skills/sync-ictc/scripts/*.py            Supabase (deliveries / rc_out /
   (fetch_gmail, extract_*, classify_*, reconcile)   production_* / audit_logs)
```

**Where the worker runs** (open decision — see §10): Renzo's Mac as a launchd/pm2 service (zero new infra, matches today's locality) **or** a small always-on VM / the existing server. It does **not** need to be public — it only makes **outbound** calls (Anthropic, Gmail IMAP, Supabase, the Sheet) and reacts to Supabase rows.

### 3.2 Why this preserves the trust boundary
The browser talks **only to Supabase** (run rows + Realtime), gated by RLS/roles. Gmail + service-role + Anthropic keys live **only in the worker** — same "not in the browser app" rule we have today, just hosted instead of laptop-bound.

---

## 4. The agent design (per employee)

Each employee (gsheet-sync, deliveries-manager, rc-out-manager, production-manager, rc-movement-auditor) becomes a **headless agent run** in the worker.

### 4.1 Model & params (per the Claude API guidance)
- **Model:** `claude-opus-4-8` (project convention; highest judgment for the classification/flagging work).
- **Thinking:** `thinking: { type: "adaptive" }` (set explicitly — off if omitted).
- **Effort:** `output_config: { effort: "high" }` (use `"xhigh"`/`"max"` only if eval shows it's worth the tokens; **low** for the read-only auditor).
- **Streaming:** `client.messages.stream(...)`, `max_tokens: 64000` (streaming avoids HTTP timeouts on long runs).
- Sub-tasks that are mechanical (e.g. pure XLSX extraction) stay **deterministic Python** — don't spend Opus tokens on them.

### 4.2 Tool surface (dedicated, gated)
Promote each pipeline step to a **dedicated tool** so the worker can render/gate/audit it:

| Tool | Side effect | Gating |
|---|---|---|
| `fetch_gmail(query)` | read-only IMAP | none |
| `pull_gsheet()` | read-only curl xlsx | none |
| `extract_xlsx(path, kind)` | pure | none |
| `query_supabase(sql_readonly)` | read-only | none (parameterized, read-only role) |
| `classify_rows(...)` | pure compute | none |
| `reconcile(...)` | pure compute | none — but the **>500 kg hard halt is enforced in the tool**, not left to the model |
| `submit_proposal(plan_json)` | **ends the PROPOSE phase** | this is the gate handoff |
| `write_supabase(rows)` | **WRITE** | **disabled until `sync_run.status=approved`**; never-overwrite + audit-log enforced in the tool |
| `label_gmail(uids)` | side-effect (idempotency) | only after successful write |

The **write/label tools are deterministic and defensive** — the agent decides *what* to write, but the *guardrails* (never overwrite a non-null tag, halt on drift, write an audit_log per row, apply the label only on success) live in the tool code, not in the prompt. This is the "gate hard-to-reverse actions" principle.

### 4.3 System prompt = the employee definitions + the Learning Ledger
The big reused prompt = each agent's `.claude/agents/<name>.md` persona + the relevant slice of the **Learning Ledger (L-001…L-016)**. This is the institutional judgment we do **not** want to re-code.

### 4.4 Prompt caching (the cost lever)
The employee prompt + ledger is large and **identical across runs** → cache it.
- Put `cache_control: { type: "ephemeral" }` on the **last system block** (caches tools + system together). Opus min cacheable prefix = **4096 tokens** (our prompt is well above).
- **Keep the system prompt byte-frozen.** Do NOT interpolate the date/watermark/decisions into it — that invalidates the whole prefix every run.
- Inject the **volatile per-run context** (today's date, the DB watermark, the approved decisions) as a **mid-conversation `role:"system"` message** in `messages[]` (beta `mid-conversation-system-2026-04-07`) or as a user-turn block — both leave the cached prefix intact, and `role:"system"` is the non-spoofable operator channel.
- **Verify** `usage.cache_read_input_tokens > 0`; if it's 0 across runs, a silent invalidator (a timestamp/UUID in the prefix, unsorted tool JSON) is at work.
- Cache reads ≈ **0.1×** input price; writes 1.25× (5-min TTL). A daily multi-employee run reuses the same cached prompt → big saving.

### 4.5 The propose→approve→execute gate (two-phase — mirrors today's UX)
1. **PROPOSE run.** Agent runs read-only tools, then calls `submit_proposal(plan_json)` (a **strict structured-output** schema: `{ inserts[], updates[], flags[], unmapped[], decisions_needed[] }`). The loop ends. Worker writes the plan to `sync_proposals`, sets `sync_run.status = awaiting_approval`.
2. **Review UI.** Dashboard renders the plan (this is a richer `/review-queue`): the safe auto-applies, the judgment calls with recommended defaults, the flagged stale-Sheet reverts. User toggles decisions, hits **Approve** → `status = approved` + `decisions` JSON.
3. **EXECUTE run.** Worker resumes (continue the same `messages[]`, or a fresh turn seeded with the proposal + decisions) with the **write/label tools now enabled**, injecting the decisions as a `role:"system"` message. Agent writes rows + audit_logs, applies Gmail labels, emits a final summary.

> Alternative (more granular, chattier): single session with `write_supabase` as an `always_ask` tool that pauses per write for confirmation. The two-phase model matches the current "one proposal, one approval" feel better — recommend two-phase for v1.

### 4.6 Parallelism (per-employee lanes)
The worker runs the employees as **concurrent agent loops** (today we fan out 4-5). Each streams into its **own lane** in the Jarvis panel. Ordering rule from today's playbook still holds: **gsheet-sync first** (source of truth) → the email/production agents → audit. Caching caveat: concurrent identical-prefix calls each pay a full cache write — **fire gsheet first, await its first streamed token (cache now warm), then fan out** the rest so they read the warm cache.

---

## 5. The live "Jarvis" panel (the fun, easy part)

- **Transport:** worker inserts `sync_events` rows (employee, kind, text, tool, ts); dashboard subscribes via **Supabase Realtime** (already used in the app) — no new socket infra. (Optional: a worker SSE endpoint if we want lower latency than Realtime.)
- **Event source:** the **streaming** Messages API already emits `content_block_delta` (narration) and `tool_use` blocks (each step) — map them 1:1 to `sync_events`. Add a `model_request_end` usage event per turn for a live token/cost meter.
- **UI:** per-employee lane with the project's `animate-fade-up` / `stagger-children` / glass surfaces; a tool-call timeline ("Fetched 2 Gmail threads ✓", "Classified 47 rows → 7 new", "⚠ flagged FEED5 revert"); a token/$ ticker; a final summary card. Reuse the Digest's visual language. **Respect the Motion budget** (no per-row animation on big tables; lane entrance + status pulses only).
- This panel is **read-only theater** over the worker's real events — it never holds creds or triggers writes directly.

---

## 6. Safety, idempotency, audit (unchanged guarantees)
- **Idempotency:** the `Blackwood-Processed` Gmail label still gates re-fetch; only label on successful write.
- **Hard gates stay deterministic:** the >500 kg PROPOSED-vs-MOVEMENT halt, never-overwrite-non-null, "production not gated by RC-IN drift" — enforced in tool code, surfaced as flags, never overridable by the model.
- **Audit:** one `audit_logs` row per write (provenance = `jarvis-sync`), same as today.
- **Headless risk control:** no human watching mid-run → lean on (a) the propose gate, (b) the deterministic guards, (c) the read-only auditor as an independent post-write check, (d) a per-run token ceiling (`output_config.task_budget`, beta) so a runaway loop self-limits.

---

## 7. Cost model (order-of-magnitude)
- Opus 4.8: **$5 / 1M input, $25 / 1M output**. Today each employee used **~80k–270k tokens** per propose+execute.
- The dominant input is the reused employee+ledger prompt. **Cached** → ~0.1× on every run after the first → the per-run input cost largely collapses to the cache-read rate + the small volatile delta.
- Rough daily run (5 employees, propose+execute, caching on): **low single-digit dollars/day** range — refine with `count_tokens` on the real prompts + a metered pilot. Levers: caching (biggest), `effort` per employee (auditor = low), Haiku for any mechanical sub-classification, task budgets to cap agentic loops.
- Add a **live cost meter** in the Jarvis panel from `usage` events so spend is visible per run.

---

## 8. What we reuse vs build

> **Big finding: the app already runs a Claude agent.** The existing in-app Jarvis *chatbot* is a working precedent — it already does an **agentic tool-use loop with prompt caching** against the Anthropic API. We copy its patterns (not its code path). See **Appendix B** for the full analysis.

**Reuse (proven, in-app):**
- `lib/anthropic/client.ts` — the SDK init + `ANTHROPIC_API_KEY` handling (already server-side).
- `app/(app)/jarvis/actions.ts` (~lines 190-306) — the **agentic tool-use loop** (`stop_reason === 'tool_use'` → execute → append → re-prompt). This is exactly the manual loop the sync worker needs.
- `lib/jarvis/tool-handlers.ts` — the **tool-definition + dispatcher** pattern (and Supabase-admin tool execution).
- **Prompt caching is already in production** (`cache_control: { type: 'ephemeral' }` on the system prompt) — the caching strategy in §4.4 is already validated in this codebase.
- All Python extractors/classifiers/reconcilers, the **Gmail-label idempotency**, the Supabase schema + audit pattern, the `/review-queue` UI pattern, the Digest's animation language, and the **16 Learning-Ledger rules** (as the system prompt).

**Build (net-new vs the chatbot):**
- The **Node sync worker** — a *long-running process*, not a Next.js server action. (The chatbot runs inside a request action, which is fine for a 1-turn chat but would hit function timeouts on a multi-minute sync — hence the dedicated worker.)
- **Streaming** — the chatbot is **non-streaming** (`messages.create`, one-shot). The live Jarvis panel needs `messages.stream(...)` + an event feed. This is the main net-new plumbing.
- **Opus 4.8** (the chatbot uses `claude-sonnet-4-6`) — heavier judgment for classification/flagging; add `thinking: adaptive` + `effort` (the chatbot sets neither).
- **New tools** (gmail/gsheet/extract/classify/reconcile/write/label) instead of the chatbot's inventory tools, with the **write/label tools gated** behind approval.
- **Decoupled from request/user context** — the chatbot hard-wires `requireUser()` + per-user `jarvis_conversations`; the sync is operator-triggered and ephemeral → new `sync_runs` / `sync_events` / `sync_proposals` tables, not the jarvis tables.
- The **Run button + Jarvis panel + proposal review UI**, and the credential/worker hosting.

---

## 9. Phased build plan
- **Phase 0 — Sync engine extraction.** Stand up the Node worker: manual agentic loop calling Opus 4.8, the existing Python steps wrapped as tools, prompt caching wired, **read-only** (proposal only). CLI-triggered. Proves the brain runs headless + caches.
- **Phase 1 — Run + watch (no in-app writes).** Dashboard **Run** button → PROPOSE run → **live Jarvis panel** via Realtime → render the proposal. Approval still a click, execution still gated/manual. Proves the whole pipe + the UX.
- **Phase 2 — In-app approve → execute.** The proposal **review UI** + one-click approve → EXECUTE run with gated write/label tools + audit. This is feature-complete "button does the sync."
- **Phase 3 — Polish & autonomy.** Per-employee lane animations, cost meter, **scheduling** (cron/auto-run that pings for approval), error recovery + lossless reconnect, role-gating who can trigger/approve, optional move to a managed/hosted worker.

---

## 10. Open decisions (need Renzo)
1. **Where does the worker live?** Renzo's Mac (launchd, zero infra) vs a small always-on VM/the existing server. (Determines uptime + who can trigger when the laptop's asleep.)
2. **Surface:** Messages API + manual loop (recommended) vs Managed Agents (Anthropic-hosted loop/containers) — affects ops, not capability.
3. **Trust line confirmation:** OK to host Gmail app-password + Supabase **service-role** + Anthropic key in the worker (never the browser)? This is the one real security trade vs today's laptop-only posture.
4. **Approval granularity:** one proposal/one approval (two-phase, recommended) vs per-write confirmation.
5. ~~**Who can run/approve** in the app~~ → **RESOLVED: only Renzo's account** runs/approves the sync. Implication: gate the Run + Approve actions to his `user_id` (or a single `sync_operator` role); **one run at a time** (no multi-user concurrency to design for) — simpler auth, simpler locking, and the worker can be pinned to his identity.
6. **Schedule:** manual-only v1, or auto-run-then-ping-to-approve.

---

## 11. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Token cost creep | Prompt caching (frozen prefix), per-employee `effort`, task budgets, live cost meter, Haiku for mechanical bits. |
| Headless judgment error | Propose gate + deterministic guard tools + independent read-only audit + the Ledger in the system prompt. |
| Long job vs serverless timeout | Use the **worker** (not an Edge Function / serverless route); stream to avoid HTTP timeouts. |
| Credential custody | Worker-only secrets; browser talks to Supabase (RLS) only; rotate on exposure. |
| Cache silently not hitting | Verify `cache_read_input_tokens`; keep system byte-frozen; inject volatile context as `role:"system"` messages. |
| Stream drops / missed events | On reconnect, replay `sync_events` history + dedupe (and/or Messages stream is restartable from the worker's own state). |

---

### Appendix B — Existing in-app Jarvis chatbot (precedent analysis)

What the app already proves works against the Anthropic API:

| Aspect | Chatbot today | Sync worker (this design) |
|---|---|---|
| SDK / key | `@anthropic-ai/sdk`, `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })` in `lib/anthropic/client.ts` (server-side) | **Same** — reuse the client init |
| Model | `claude-sonnet-4-6`, `max_tokens: 4096` | `claude-opus-4-8`, `max_tokens: 64000` (heavier judgment) |
| Agentic loop | **Yes** — `app/(app)/jarvis/actions.ts` tool-use loop, capped at 5 iterations | **Reuse the pattern**, no fixed low cap; gate write tools |
| Tools | `query_batches`, `query_deliveries` → Supabase admin (`lib/jarvis/tool-handlers.ts`) | New tools (gmail/gsheet/extract/classify/write/label) |
| Prompt caching | **Yes** — `cache_control: ephemeral` on the system prompt | **Same strategy** (already validated here) |
| Thinking / effort | Not set | `thinking: adaptive` + `effort: high/xhigh` |
| Streaming | **No** (`messages.create`, one-shot) | **Yes** (`messages.stream`) — net-new, powers the live feed |
| Auth | `requireUser()` (Supabase session), per-user `jarvis_conversations`/`jarvis_messages` | Operator-only (Renzo); ephemeral `sync_*` tables; runs in a **long-running worker**, not a request action |
| DB writes | Read-only tools | **Gated write tools** + audit_logs |

**Net:** the API integration, the tool-loop, and prompt caching are already de-risked in this repo. The genuinely new pieces are **streaming**, the **long-running worker** (vs request-bound server action), the **sync-specific gated tools**, and the **operator/approval UI**.

### Appendix C — Server-side Gmail IMAP (answering "is that possible?")

**Yes — straightforwardly.** IMAP is just a TLS socket to `imap.gmail.com:993` authenticated with the Gmail **app password** — nothing about it requires a laptop or Claude Code. Two facts:
- The Next.js **app today has *no* server-side Gmail/IMAP** — email fetching lives only in the `.claude/skills/sync-ictc/scripts/fetch_gmail.py` (Python `imaplib`) harness.
- The **sync worker** adds server-side IMAP. Two equivalent options:
  1. **Reuse `fetch_gmail.py` as-is** — the worker shells out to the existing, battle-tested Python script (zero rewrite; it already handles search, attachment download, and the `Blackwood-Processed` labeling).
  2. **Port to Node** — use `imapflow` (the standard Node IMAP client) if we want one runtime.
- Either way the **app password lives only in the worker's env** (never the browser) — same custody model as the Anthropic + service-role keys, and consistent with today's "Gmail stays out of the browser app" rule. Recommend **(1)** for v1 — it's the smallest change and keeps the proven extractor logic intact.

### Appendix A — minimal manual-loop shape (TS, illustrative, not final)
```ts
// worker: one employee run, streaming, gated writes
const stream = client.messages.stream({
  model: "claude-opus-4-8",
  max_tokens: 64000,
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
  system: [{ type: "text", text: EMPLOYEE_PROMPT_PLUS_LEDGER, cache_control: { type: "ephemeral" } }],
  messages, // volatile run-context injected here as role:"system", not in `system`
  tools,    // read tools always; write/label tools only present once approved
});
// map content_block_delta + tool_use → sync_events (Realtime); execute tool handlers
// (Python shell-outs / Supabase); loop on stop_reason==="tool_use"; stop on "end_turn".
// PROPOSE phase ends when the agent calls submit_proposal(...).
```
