# Handoff — 2026-07-06 · Audit remediation → Sync Button → TS+DBOS migration → live-debugged to working → smart-adjudicator plan

_Prior: `handoffs/2026-07-04-durable-sync-job-research.md` (research), `2026-07-03-flecon-bag-inventory-and-audit-kickoff.md`. LONG continuous session, four arcs. Read the TL;DR → "Current state" → "Next concrete action". The final chunk (live debugging + the smart-adjudicator plan) is the freshest and most important._

## TL;DR

1. **Code-audit remediation (phases 0–5)** — security leaks, docs drift, redundancy, perf, full RLS/DB hardening (advisors 217 → 115, all ERRORs = 0).
2. **One-click Sync Button** — dashboard **Run Sync** modal replacing the Jarvis chat, driving the deterministic sync pipeline (Gmail retry, live progress, L-032/L-033 hotfixes).
3. **The migration** — ported the entire ~12,750-line Python sync engine to a **TypeScript + DBOS durable worker** (`workers/sync/`). All 6 report types at **byte-parity with the Python oracle** (12/12). Modal watches Supabase Realtime, not the laptop.
4. **First real clicks → live debugging to a WORKING system** — every integration seam that broke on Renzo's actual clicks was fixed (see "post-migration seam fixes"). The modal now streams cleanly, shows correct counts, populates held rows, and gives plain, **DB-grounded** recommendations that self-diagnose (e.g. the O>M gate runs its own duplicate-check). Renzo has run it end-to-end and it works.
5. **Next big thing (planned, not built): the "smart Jarvis" held-row review** — `SMART_ADJUDICATOR_PLAN.md`. Turn held-row review into an agent that investigates like a chat session + a chat you steer + human-directed resolve. **Fly deploy is folded in as P0** of that plan.

## What shipped this session (commits, newest first)

- `3624216` fold Fly deploy into the smart-adjudicator roadmap as P0
- `dd5435f` smart-adjudicator plan: lock decisions + add chat & human-directed resolve
- `822addc` **SMART_ADJUDICATOR_PLAN.md** (feasibility + implementation, not built)
- `ede7c35` **O>M gate self-diagnoses** (runs the rc_out duplicate-check itself: DB dups vs missing movement entries)
- `d6d1350` held recommendations name the specifics (drift dates + both numbers) + plain-floor language (jargon banned, test-enforced)
- `9d287c7` decision-grade held-row adjudication (real row + targeted DB lookup + rule context + descriptive headings)
- `ef1d037` fix: held section blank + false "nothing new" summary (a stale `settled` snapshot read from inside a deferred setState updater)
- `d98775`→`5fafc4d` result-shape reconciliation + crash guard (worker envelope ↔ frontend contract; gate-failed apply no longer white-screens)
- `69cac60` Mail Clerk live progress + attachment-only fetch (~2m40s → ~52s)
- `e356400` **M5.1 lifecycle** — Stop button, graceful cancel, self-healing (startup recovery + stale-run watchdog)
- `e2b04f3` fly.toml **bulletproof mode** (`min_machines_running=1`, Renzo's choice)
- `abed8a7` worker loads its own `.env` on boot
- `add2e0e` **M4+M5** durable worker end-to-end + Realtime cutover · `1c409c4`/`063095a`/`a51a3d8` M3 ports (6/6 parity) · `e30a297` M2 harness + production wiring hotfix · `90e0889` M0+M1 · `8d1ac7d` migration plan
- (earlier) `8173d2d` dashboard modal · `4a16f7f` L-033 · `e6a4e64` Gmail retry/progress · `bfad78d` L-032 audit-RPC hotfixes · `c2c9629` Sync Button · `9b99d9c` audit phase 4

## The system, one paragraph

`workers/sync/` (standalone TS, NOT in the Next build) wraps every step in **DBOS** (durable execution, checkpoints in our Supabase Postgres; crash → resume). The dashboard **Run Sync** click writes a `sync_runs` row + POSTs the worker `/kick`; the worker fetches Gmail via the **Mail Clerk** (one IMAP session → Supabase Storage), runs 6 report workflows (gsheet first, 4 writers parallel, auditor last), writes progress → `sync_run_events` and results → `sync_runs.result`. The modal reads it over **Supabase Realtime**. The Python stays in-repo as **oracle + manual fallback** until a future M6. Safety = the **golden-master parity harness** (`npm run parity`, 12/12).

## Post-migration seam fixes (the "first real click" arc — highest recent value)

Each proven-in-isolation piece failed at its **seam** on Renzo's real clicks; each closed permanently:
- **L-032 audit-write RPCs** — `audit_logs` needs BOTH a SECURITY DEFINER INSERT RPC (`write_ingestion_audit`) and an UPDATE RPC (`stamp_ingestion_audit`); service_role has no grant on `audit_logs`. Plus `REPLACE` added to the operation enum (flecon). Migrations `20260703*`.
- **Stuck queued run** — DBOS only recovers *started* workflows, so a click while the worker slept dangled forever. Fixed with **startup recovery** (grab orphaned `queued` runs on boot) + a **stale-run watchdog** (auto-expire >15min no-progress) + the **Stop button** (graceful cancel, keeps written rows, `cancelled` status). Proven live.
- **Gmail "stuck on Checking Gmail"** — the fetch was one opaque ~2m40s step with zero progress. Added per-report progress + attachment-only download (~52s).
- **Result-shape drift** — the worker wrote a flat/lossy envelope (held collapsed to a count) while the frontend expected nested `applied` + held ROWS; also the auditor was keyed `rc_movement_audit` vs the panel's `rc_movement`. Reconciled via `normalizeReport.ts`.
- **Blank held section + false "nothing new"** — `settled` was `.push()`ed inside a deferred `setState` updater and read empty synchronously. Fixed by folding from a `stateRef` mirror.
- **Held-row quality** (3 rounds, per Renzo's feedback): (a) enriched each held row with a human `natural_key` + `kind` + structured `row`; (b) named the specifics (exact dates + both numbers) in plain plant language (jargon **banned + test-enforced**); (c) the O>M gate now **self-diagnoses** by querying `rc_out` for real duplicates.

## The June-10 / May data verdict (Renzo asked "sync bug or DB issue?")

**Neither — the database is CORRECT on every flagged date.** Verified directly:
- Drift dates **May 15** (DB 28,087 = movement 28,087; proposed over-stated 29,024) and **May 28** (DB 56,393 = movement 56,393; proposed 59,142). DB matches the movement sheet exactly; the *proposed daily report* over-stated. No dups.
- O>M date **June 10**: DB has 5 distinct feedings (71,144 kg, zero dups); the **movement sheet is short 13,743 kg** (= 10,813 + 2,930, two feedings it omitted). June 12: movement sheet has no entry at all.
- **Conclusion:** the gates are catching **real gaps in the operator's source spreadsheets** (movement sheet missing June feedings; proposed report over-stating two May days), not bugs and not DB corruption. Action = tell whoever maintains the RC MOVEMENT sheet to add the missing entries; the held rows are safe to dismiss. The gates doing their job = the safety net working.

## Critical learnings (highest value)

- **The Claude Bash sandbox CANNOT open a raw Postgres connection to Supabase:5432** (TCP connects, DB handshake times out). SAME creds connect ~900ms from Renzo's own Terminal. This burned an hour (I wrongly blamed the DB password; a *deliberately-wrong* password timed out identically → proving it was the sandbox, not the credential). **Rule: never test the worker's DBOS/Supabase-DB connection from a Bash tool — Renzo runs `workers/sync/scripts/db-connect-test.mjs` from his own Terminal. Gmail (993) + Supabase REST/Storage (443) DO work from the sandbox.** Every worker agent gets this warning.
- **Where each piece lives (permanent answer to "easy to edit after Fly?"):** the sync **worker** → Fly (`flyctl deploy` ~1-2min; local `npm run dev` still hot-reloads). The **agent/chat/adjudicator** → the **Next app, NOT Fly** — edited like any app feature. State → Supabase. So a Fly deploy doesn't slow future agent work at all.
- **Banker's rounding** (Python `round()` = round-half-to-even; JS `Math.round` ≠). `norm.ts` matches CPython; `Math.round` lint-banned in data paths; 127 norm fixtures generated by running the Python.
- **Merged-cell trap** — exceljs resolves covered merged cells to the master value; openpyxl reads `None`. Each affected report ships a local merge-aware `sheet.ts`.
- **The migration found live PYTHON bugs** (bug-for-bug parity is a feature): production classified ZERO rows for weeks (wiring bug — fixed, recovered 2 days), the L-018 skip gap, a gsheet gate-crash, a `dt_mins≥60` DB-constraint crash — all handled via logged deviations (`PORTING_DECISIONS.md` + `expected-deviations.json`).
- **DBOS TS specifics:** cancel error classes under the `Error` namespace; `getWorkflowStatus` PENDING/ENQUEUED/DELAYED live vs CANCELLED; recovery only resumes STARTED workflows (hence custom queued recovery). The Write tool can inject control bytes into adjacent `${…}` template literals (grep with `-lP '[\x00-\x08…]'`).

## Current state

- **Fully working locally, verified by Renzo:** a real Run Sync streams all 6 cards, correct applied counts, held rows populate, gate failures show with plain DB-grounded recommendations. Parity 12/12; worker vitest 290; reducer 22/22; adjudication 10/10; root+worker tsc+build clean; all pushed to `dev`.
- **Env done:** `.env.local` wired (`SYNC_WORKER_URL=localhost:8080` + matching kick secret); `workers/sync/.env` has real Gmail creds + service key + a VALID `DBOS_DATABASE_URL` (session pooler — Renzo's terminal test connected in 886ms).
- **NOT deployed to Fly** (bulletproof `min=1` configured; `RUNBOOK.md` written). Renzo owns the `flyctl` steps. This is P0 of the next plan.
- **To pick up the latest worker changes**, restart the local worker (`Ctrl-C` → `npm run dev`).

## Open decisions / plan (SMART_ADJUDICATOR_PLAN.md)

Renzo's LOCKED decisions for the "smart Jarvis" build:
- **Scope:** prove the investigator on the **rc_out gate family** first, eval vs the June-10/May cases, then generalize.
- **Write policy:** the agent **never auto-resolves alone** — a **chat per held row** where Renzo talks to the investigator and resolves THROUGH the conversation (confirm-gated write via the deterministic path + provenance audit). For the rc_out slice, "resolve" = acknowledge/dismiss = zero operational write.
- **Sequencing:** **P0 Fly deploy** (~15min Renzo) → then P1–P5 investigator build (~2-3 sessions, all app-side, no worker/DB-schema changes).

## Next concrete action

**P0 — walk Renzo through the Fly deploy** (`workers/sync/RUNBOOK.md`): `brew install flyctl` → `flyctl auth login` → `flyctl launch --no-deploy` → `flyctl secrets set` (6 keys, names in `.env.example`) → `flyctl deploy` → set a $5 spend cap in the Fly dashboard → flip `SYNC_WORKER_URL` in `.env.local` to `https://blackwood-sync.fly.dev`. Verify `/health`. **Then** start P1 of the smart-adjudicator (investigative toolset, reusing the Jarvis loop + price-gated DB tools).

## Key files

- `SMART_ADJUDICATOR_PLAN.md` (the next build), `SYNC_TS_MIGRATION_PLAN.md`, `CODE_AUDIT_PLAN.md`
- `workers/sync/` — worker (`src/workflows/{runSync,reportWorkflow,mailClerk,normalizeReport,selfHeal}.ts`, `src/reports/<type>/` + `held.ts`, `src/lib/{gmail,db,norm,xlsx,progress}.ts`, `RUNBOOK.md`, `specs/`, `scripts/db-connect-test.mjs`)
- `app/(app)/sync/` (actions, types, `adjudication.ts`, CONTEXT) + `components/sync/` + `lib/sync/reducer.ts`
- `.claude/skills/sync-ictc/` — Python oracle + `SYNC_CLI_CONTRACT.md` + `LEARNING_LEDGER.md` (L-001…L-033)
- migrations `20260703*`/`20260704*`/`20260706*` (sync_runs/events, Storage bucket, audit RPCs, `cancelled` status)
