# Smart Held-Row Adjudicator — "Investigate like chat" · Feasibility + Implementation Plan

> **STATUS 2026-07-07: P1–P6 BUILT, VERIFIED, EVAL'D (5/5).** See `handoffs/2026-07-07-smart-adjudicator-built.md` for what shipped and the deltas vs this plan (gate flags are dismiss-only in v1 — no `override_gate` wiring yet; apply-writers exist for rc_out + deliveries only). P-Fly remains deferred.

_2026-07-06. The full implementation plan: finish the sync's durability (Fly), then build the "smart Jarvis" held-row review — an in-app agent that reasons like a chat session with Claude (studies the data, cross-references sources, pinpoints who's wrong, explains it plainly), with a chat you steer and a human-directed resolve. Barely any human intervention on the **analysis**; the **write** stays human-directed via the chat._

## Decisions locked (2026-07-06)

- **Scope:** start by proving it on the **rc_out gate family** (drift + O>M), eval'd against the June-10 / May cases we solved by hand, then generalize.
- **Write policy:** the agent **never auto-resolves on its own**. Instead there is a **chat** attached to the held row where Renzo talks to the agent about its findings, and **resolution happens through that conversation** — the agent only writes what Renzo explicitly directs, and even then through the deterministic pipeline path with a confirmation + full audit trail. (Renzo: _"there should be a chat box / button where I can talk to the claude agent about the results so we can auto-resolve from there."_)

## Functional spec — LOCKED v2 (2026-07-06 PM, supersedes conflicting text below)

Renzo answered the four open functional questions. These now define the v1 target:

1. **Trigger = AUTO-INVESTIGATE.** The moment a sync finishes with held rows / gate failures, the investigator runs on **every** flag in the background (Sonnet). By the time Renzo opens the panel, full cited verdicts are already waiting — zero clicks. The "Investigate" button becomes "re-investigate / escalate to Opus." Cost is bounded: a normal run has 0–5 flags; hard cap on iterations per flag still applies.
2. **Memory = KNOWN-ISSUES LEDGER.** Every ruling is persisted with a **fingerprint** of the discrepancy (flag kind + report + date + the stable numbers). When a later sync raises the *same* discrepancy, it surfaces as **"known issue — ruled `<verdict>` on `<date>` by `<user>`"**: quiet-but-visible (never fully silenced), pre-annotated with the prior ruling, and it **re-alarms loudly if the numbers change** (a changed discrepancy is a new discrepancy). This kills the "re-dismiss June-10 every day" loop without hiding anything.
3. **Home base = PERSISTENT REVIEW PAGE + modal.** Held flags, their investigations, chat threads, and rulings are **saved to the DB** and live on a dedicated review surface until resolved — close the modal, come back tomorrow, the case file and conversation are intact. The Run Sync modal keeps showing the same flags for the in-the-moment look and links into the page. An unresolved-count badge surfaces open cases. (This **supersedes** the "No DB schema change" claim below — persistence needs new tables: cases, case messages, rulings/ledger.)
4. **Resolve actions in v1 = dismiss + apply + edit-then-apply (ALL confirm-gated through the chat, ALL via the deterministic write path with provenance audit):**
   - **Acknowledge & dismiss** — zero operational write; ruling + reasoning logged (the whole rc_out gate slice in practice).
   - **Apply the held row** — for per-row holds: after explicit confirmation in chat, writes the row through the same deterministic apply path the sync employee uses. For **report-level gate failures**, the apply-equivalent is **"override gate & run the report's writes"** — same confirm gate, explicitly labeled as an override in the audit trail. _(Default assumption — flag to Renzo if this override semantic feels wrong.)_
   - **Edit-then-apply** — Renzo corrects a value in chat ("the weight should be 5,200"); the agent echoes the exact edited row back for confirmation, then applies it through the same path. Edited values pass the same validation the sync applies.
   - **Explicitly OUT of v1:** first-class "draft the operator message" button (skipped by Renzo — the chat can always be asked to compose one ad-hoc, so nothing is lost).
   - Never-delete / never-auto-create-batches / price gating all still hold. The agent still cannot write **anything** without an explicit per-action confirmation.
5. **Models:** Sonnet is the investigator default (lookup work); Opus **effort high** only on explicit escalation — matching the project-wide "Opus-high for coding, Sonnet for lookups" rule.
6. **Sequencing change (2026-07-06 PM):** the **Fly deploy (P0) is DEFERRED** — Renzo chose to nail and build the adjudicator first. The worker keeps running locally via `npm run dev` until then. Nothing in this build depends on Fly.

## Sequencing — ship durability first, then build the brain

**Step 0 (do first, ~15 min of Renzo's `flyctl` steps): deploy the sync worker to Fly.** This closes the one open durability gap (sync runs off the laptop) and — importantly — **does not slow down anything that follows**, because of where each piece lives:

| Piece | Where it runs | How you edit it AFTER the Fly deploy |
|---|---|---|
| Deterministic sync worker (fetch → classify → write) | **Fly** (bulletproof `min=1`, ~$2–3/mo) | edit `workers/sync/` → `flyctl deploy` (~1–2 min). Local `npm run dev` still works for iteration; deploy only when a change is ready. Auto-deploy-on-push wireable later. |
| **The investigator / chat agent (this whole plan)** | **The Next.js app** (server-side, like Jarvis) — **NOT on Fly** | edit app code + deploy the app the way you already do. **Fly is not in this loop at all.** |
| Progress + results + held rows | **Supabase** (tables + Realtime) | schema via MCP migrations |

So the entire "smart Jarvis" build lands in the **app**, untouched by the Fly deploy. Deploying now finishes the durability chapter and costs **nothing** in future flexibility — the agent is edited exactly like any app feature, and the worker is a one-command redeploy.

## The insight

What made the chat diagnoses good was **not the model being clever in a vacuum** — it was **agency + tools**. On the June-10 O>M case I: queried `rc_out` for the date, checked for duplicate rows, saw there were none, compared the DB total to the movement total, noticed the 13,743 kg gap equalled two specific real feedings, and concluded "the movement sheet is missing entries, the DB is correct." That's a **loop**: form a hypothesis → run a tool to test it → revise → conclude.

The adjudicator we shipped today is **single-shot**: for each flag type it runs ONE hard-coded lookup, then asks Sonnet once. Smart-ish, but rigid — it can only ever check what we pre-wired. To match chat, it must be able to **decide what to investigate next**, iteratively, like an agent.

## Feasibility: HIGH — we already own most of it

| Ingredient | Status |
|---|---|
| An Anthropic **tool-use loop** (agent that calls tools, reads results, continues) | ✅ EXISTS — `app/(app)/jarvis/actions.ts` (`chat()`, iteration loop, `executeToolCall`) |
| **Read-only DB query tools** | ✅ EXISTS — `lib/jarvis/tool-handlers.ts` (`query_batches`, `query_deliveries`), already price-gated (SEC-2) |
| **Domain knowledge** to reason with | ✅ EXISTS — `.claude/skills/sync-ictc/LEARNING_LEDGER.md` + `RULES_DIGEST.md` (L-001…L-033) |
| **The held-row context** to investigate | ✅ EXISTS — enriched held rows (kind + structured row + drift numbers) shipped today |
| **The source files** for the run (proposed report, movement sheet, gsheet) | ✅ EXISTS — the Mail Clerk already stores them in the `sync-inbox` Storage bucket per run |
| Server-side Anthropic client + PRIVILEGED gating | ✅ EXISTS — `lib/anthropic/client.ts`, `requirePrivileged()` |

**The hard part (a working investigative loop) is done.** The build is: give that loop a **scoped, read-only investigative toolset**, a **diagnostic playbook** as its system prompt, wrap it as an **on-demand** action, bound its cost, and surface it in the modal.

## What we build

### A. The Investigator — a read-only agent scoped to held-row review
A tool-use loop that, given ONE held row + its run context, investigates until it can explain **who is wrong and what to do**, then returns a cited verdict.

**Toolset (ALL read-only, price-gated, service-role, PRIVILEGED-only):**
| Tool | What it does | Guard |
|---|---|---|
| `query_table` | Scoped SELECT on `rc_out` / `deliveries` / `batches` / `production_*` / `flecon_*` / the `view_*` reporting views | allow-listed tables/columns; **NO ₱/cost columns**; `LIMIT` enforced |
| `check_duplicates` | Group-by-natural-key duplicate detector for a table+date | read-only |
| `read_run_source` | Read this run's fetched workbook rows from Storage (proposed report / movement sheet / gsheet) so it can compare the ACTUAL source numbers, like the reconcile does | run-scoped storage path only |
| `find_batches` | Fuzzy batch-code / bag-type candidate lookup | read-only |
| `read_rule` | Pull the plain meaning + history of an L-rule from the ledger | static file |

Every tool is **SELECT/READ ONLY**. The agent **cannot write, apply, skip, or delete** — it only recommends. The write stays with the human (v1).

**System prompt = the diagnostic playbook.** Encodes how to reason per flag type (e.g. *O>M → first check for duplicate rows; none → the movement sheet is missing entries; some → DB double-entry*), the plain-plant-language rules (the jargon ban already enforced), the batch-code conventions, and the hard boundary "you investigate and advise; you never write."

**Output:** a structured verdict — `apply | skip | needs-human` + a **detailed, cited explanation** (the numbers it found, the query results, which source is the outlier) + a **confidence**. Cited = it must ground claims in tool results, not vibes.

### B. How it surfaces (UX)
- **Keep today's instant single-shot recommendation** as the default (fast, zero extra clicks) — it's the floor.
- **Add "Investigate deeply"** per held row (or per flagged report). Clicking runs the Investigator and **streams its work** — the checks it ran and what it found — ending in the detailed verdict. Essentially a focused, on-rails version of a chat investigation, in the modal.
- Advisory only in v1: it produces the writeup; applying still goes through the sync employee.

### B2. The chat + human-directed resolution (Renzo's refinement)
The investigation isn't a dead-end report — it's the **opening turn of a conversation**. Each held row (and each flagged report) gets a **chat thread** with the investigator, so Renzo can interrogate and steer it exactly like our sessions:
- *"why do you think the movement sheet is wrong and not the DB?"* → it re-queries / re-explains.
- *"also check June 12"* → it investigates the new date.
- *"ok, this is a movement-sheet gap — dismiss it"* → it **resolves the row as Renzo directs.**

**The resolution (the only write) is strictly human-directed and safe:**
- The agent has a `propose_resolution(action)` step and a separate `execute_resolution` that fires **only after Renzo explicitly confirms in the chat** — never on the agent's own initiative.
- It routes through the **same deterministic write path** the sync employee uses (per-report apply / dismiss), so audit rows (`write_ingestion_audit` / provenance = "resolved via chat by <user>"), price gating, and the never-delete/never-auto-create rules all still hold.
- For the **rc_out gate slice specifically**, "resolve" is almost always **acknowledge & dismiss** (the flags are known source-sheet discrepancies — the DB is already correct), which writes **nothing** to operational tables — the safest possible first slice. Riskier `apply` writes (per-row types) come later, each gated the same way.
- Every chat-directed action is **logged** (who, what, why) so there's a full trail of any human-directed resolution.

This is essentially a **scoped Jarvis chat** — same loop + tools — pointed at one held row, with a confirm-gated resolve action on top of the read-only investigation.

### C. Where it runs
Next.js **server action** (like Jarvis), **on-demand** when Renzo clicks — not the worker (the worker is the deterministic sync; this is interactive investigation). PRIVILEGED-gated; the deterministic single-shot lookup remains the fallback if the agent errors.

## Honest tradeoffs (the "before we proceed" part)

- **Cost & latency.** An agentic investigation = several model calls + tool round-trips = a few seconds and more tokens than the single-shot. **Mitigation:** on-demand only (never auto-runs on every sync), a hard cap on tool calls/iterations per row, **Sonnet as the default**, Opus only on an explicit "escalate."
- **Reasoning can still be wrong.** A model can misread or over-conclude. **Mitigations:** tools return only real data; it must cite the numbers; it's **advisory** (never auto-writes); the deterministic diagnosis stays as a floor; and we **eval it against known cases** (June-10 O>M = "movement sheet missing," May 15/28 = "proposed over-stated," a seeded true-duplicate = "DB double-entry") before trusting it.
- **Scope discipline.** "As smart as chat" is open-ended; we bound it to **held-row adjudication**, not a general agent. No write tools, ever, in this surface.
- **Human sign-off stays (v1).** You get near-zero-intervention *analysis*; the *write* remains gated. A future v2 could let a high-confidence verdict auto-resolve the safe, unambiguous cases (e.g. a proven duplicate → skip) — but that's a separate, riskier decision to make only after the analysis has earned trust.

## Phased implementation (v2 — Fly deferred, spec locked 2026-07-06 PM)

| Phase | Deliverable | Effort |
|---|---|---|
| **P1 — Case persistence (the spine)** | New tables: `sync_held_cases` (one per flag: fingerprint, run ref, kind, structured row, status open/resolved), `sync_case_messages` (the chat thread + investigation transcript), `sync_case_rulings` (the known-issues ledger: fingerprint → verdict, who, when, reasoning). Migration + types + fingerprint function. Sync completion fans held rows/gate failures out into cases; re-occurrences match the ledger by fingerprint and arrive pre-annotated ("known issue — ruled X on date"). | M |
| **P2 — Investigative toolset** | The 5 read-only tools + allow-list + price-gating + unit tests (adapt Jarvis' `tool-handlers`) | S–M |
| **P3 — The Investigator loop + AUTO-TRIGGER** | The scoped tool-use loop + diagnostic-playbook system prompt; bounded iterations; Sonnet default, Opus-high on explicit escalation. **Auto-runs on every new case when a sync completes** (skipping ledger-matched known issues — they reuse the prior verdict); verdicts persist to the case, so they're waiting even if the modal was closed. | M |
| **P4 — Review page + chat UX** | The persistent review surface listing open cases (badge = unresolved count), each opening a chat thread with the investigator (reuse Jarvis chat UI); stream re-investigations; render cited findings + confidence; the Run Sync modal links each held row to its case. | M |
| **P5 — Human-directed resolve (dismiss / apply / edit-then-apply)** | `propose_resolution` + confirm-gated `execute_resolution` through the deterministic write path with provenance audit. Dismiss = zero operational write. Apply = per-row deterministic apply; gate failures get "override gate & run writes," labeled as override. Edit-then-apply = agent echoes the exact edited row for confirmation, validates like the sync, then applies. Every action logged (who/what/why). | M–L |
| **P6 — Eval + trust** | Fixture eval over the known cases (O>M-missing-sheet, proposed-over-stated, seeded true-dup) asserting the right conclusion; a ledger-match eval (same flag re-raised → pre-annotated, changed numbers → re-alarms); cost/latency + write-safety budget check. | S |
| **P-Fly (deferred)** | Deploy the sync worker to Fly per `workers/sync/RUNBOOK.md` (bulletproof mode configured, env verified). Renzo owns the `flyctl` steps; ~15 min. Independent of everything above. | S · Renzo ~15 min |

**Total ≈ 3–4 focused sessions** for the rc_out proof slice (persistence + investigator + review page + full resolve), then generalize per flag family. Requires a DB migration (cases/messages/rulings — app tables only, the worker schema is untouched). No worker change (investigator runs app-side); the only worker-adjacent touch is fanning run results into cases, which can live app-side off the existing Realtime completion event. Reuses the Jarvis loop + tools as the base.

## v1.1 — Run Triage layer (LOCKED 2026-07-07 PM, approved "plan then execute go")

Renzo's friction after the first real incident (5 flags = 1 root cause = 5 separate cases to read and dismiss): the per-case model is the right foundation but lacks the **run-level conversation**. Industry pattern adopted (Sentry/PagerDuty/data-observability convergence): group by root cause, triage summary first, bulk resolution, one conversation per run.

**Locked design:**
1. **Triage case per run.** When `autoInvestigateRun` finishes a run's investigations, a **synthesis pass** (one Sonnet call, no tools — input = every case's briefing + verdict) clusters the run's cases by root cause and writes a run summary. Persisted as a **synthetic case row** (`kind: 'run_triage'`, fingerprint = hash of run id, clusters in `row` jsonb, summary in `verdict`) — deliberately reusing the ENTIRE existing case machinery (messages thread, Realtime, chat loop, review page) instead of new tables. Zero-flag runs get no triage case.
2. **Run-level chat** = `chatOnCase` on the triage case. Its briefing embeds the run context + all sibling case verdicts; same 5 read-only tools; NEW chat-mode tool `propose_group_resolution` `{action:'dismiss', case_ids, summary, reasoning}` (**dismiss-only for groups in v1** — applies stay per-case) → confirm card → `executeGroupResolution` dismisses every listed case (one ruling per case so each fingerprint enters the ledger individually), all confirm-gated exactly like single resolution.
3. **Review page groups by run**: section per run (newest first) with the triage summary card on top (clusters as chips → filter), the per-case table beneath; triage case opens the run chat. Multi-case bulk-dismiss also available from selection (routes through the same group action).
4. **Modal "Ask Claude" → doorway**: the held-rows button deep-links to `/sync/cases?run=<runId>` landing on that run's triage chat (in-modal quick recommendations stay as the glance layer).
5. **Explicitly deferred:** auto-resolution of ledger-matched known issues (v2, after the ledger earns trust); group `apply`.

Phases: **T1** backend (synthesis + trigger + group resolution + verify additions + live smoke) → **T2** frontend (run grouping, triage card, run chat deep-link, group confirm card, modal button) → **T3** gates + docs + commit.

## What it does NOT change
The deterministic sync (parity 12/12), the write gate (human-approved via the employee), price gating, the fast single-shot default, and the "never auto-write held rows in v1" policy.

## Recommendation
Feasible and high-value — it turns the held panel from "flags with canned advice" into "flags with a real investigation attached," which is exactly the chat experience you've been relying on. Suggested start: **P1 + P2 against ONE flag family (the rc_out gates)** as a proof, eval it against the June-10 / May cases, and only then generalize to the other flag types. That de-risks the open-ended "smart" goal into a provable first slice.
