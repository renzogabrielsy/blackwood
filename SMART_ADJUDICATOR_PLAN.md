# Smart Held-Row Adjudicator — "Investigate like chat" · Feasibility + Implementation Plan

_2026-07-06. A plan for Renzo to react to BEFORE any build. Goal: make the in-app held-row review reason like a chat session with Claude — study the data, cross-reference sources, pinpoint who's wrong, and explain it plainly — with barely any human intervention on the **analysis** (the **write** stays human-gated in v1)._

## Decisions locked (2026-07-06)

- **Scope:** start by proving it on the **rc_out gate family** (drift + O>M), eval'd against the June-10 / May cases we solved by hand, then generalize.
- **Write policy:** the agent **never auto-resolves on its own**. Instead there is a **chat** attached to the held row where Renzo talks to the agent about its findings, and **resolution happens through that conversation** — the agent only writes what Renzo explicitly directs, and even then through the deterministic pipeline path with a confirmation + full audit trail. (Renzo: _"there should be a chat box / button where I can talk to the claude agent about the results so we can auto-resolve from there."_)

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

## Phased implementation

| Phase | Deliverable | Effort |
|---|---|---|
| **P1 — Investigative toolset** | The 5 read-only tools + allow-list + price-gating + unit tests (adapt Jarvis' `tool-handlers`) | S–M |
| **P2 — The Investigator loop** | The scoped tool-use loop + the diagnostic-playbook system prompt; bounded iterations; Sonnet default, Opus escalation | M |
| **P3 — Chat UX** | Per-held-row **chat thread** with the investigator (reuse Jarvis chat UI); stream the opening investigation + let Renzo interrogate/steer; render cited findings + confidence | M |
| **P4 — Human-directed resolve** | `propose_resolution` + confirm-gated `execute_resolution` routed through the deterministic write path (dismiss/apply) with provenance audit; for the rc_out slice, dismiss = zero operational write | S–M |
| **P5 — Eval + trust** | A fixture eval over the known cases (O>M-missing-sheet, proposed-over-stated, seeded true-dup) asserting the agent reaches the right conclusion; cost/latency + write-safety budget check | S |

**Total ≈ 2–3 focused sessions** for the rc_out proof slice (investigator + chat + confirm-gated resolve), then generalize per flag family. No DB schema change. No worker change (it runs app-side). Reuses the Jarvis loop + tools as the base.

## What it does NOT change
The deterministic sync (parity 12/12), the write gate (human-approved via the employee), price gating, the fast single-shot default, and the "never auto-write held rows in v1" policy.

## Recommendation
Feasible and high-value — it turns the held panel from "flags with canned advice" into "flags with a real investigation attached," which is exactly the chat experience you've been relying on. Suggested start: **P1 + P2 against ONE flag family (the rc_out gates)** as a proof, eval it against the June-10 / May cases, and only then generalize to the other flag types. That de-risks the open-ended "smart" goal into a provable first slice.
