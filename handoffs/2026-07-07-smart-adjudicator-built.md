# Handoff — 2026-07-07 · Smart Held-Row Adjudicator BUILT (P1–P6, eval 5/5)

_Prior: `handoffs/2026-07-06-sync-ts-migration-and-durable-worker.md` (the migration + live-debug session that planned this build). This session locked the functional spec, then built and verified all six phases of `SMART_ADJUDICATOR_PLAN.md`. Fly deploy intentionally skipped (Renzo's call: "skip the fly setup for now")._

## TL;DR

The "smart Jarvis" held-row review is **built and proven**. Held sync rows are now persistent **cases** in the DB; an AI **investigator** auto-runs on every new flag when a sync lands (Sonnet, tools, cited verdicts); each case has a **chat** where Renzo interrogates it and resolves through conversation; every ruling feeds a **known-issues ledger** so the same discrepancy never re-alarms (but changed numbers do); resolution is **confirm-gated** (dismiss / apply / edit-then-apply) through the deterministic write path with full provenance audit. The permanent trust harness (`scripts/eval-investigator.ts`) passes **5/5**, including re-deriving the June-10 and May verdicts from scratch and catching a seeded true duplicate. Nothing auto-writes, ever.

## The locked functional spec (v2 — decided at session start, in the plan doc)

Renzo's four decisions: (1) **auto-investigate** every flag on sync completion, (2) **known-issues ledger** (quiet-but-visible re-occurrences, re-alarm on changed numbers), (3) **persistent review page + modal links** (cases + chats survive modal close), (4) resolve v1 = **dismiss + apply + edit-then-apply** (all confirm-gated; operator-message drafting skipped — the chat can compose one ad-hoc).

## What shipped (per phase; nothing committed yet at time of writing — commit in flight this session)

- **P1 — persistence spine.** Migration `20260706120000_smart_adjudicator_cases.sql`: `sync_held_cases` (UNIQUE fingerprint, status open/investigating/investigated/resolved, verdict jsonb, known_ruling_id, occurrence_count), `sync_case_messages` (thread + transcript), `sync_case_rulings` (the ledger, action CHECK incl. unused-for-now `override_gate`). RLS = sync-tables pattern (authenticated SELECT-only, service-role writes); Realtime on cases+messages. `lib/sync/fingerprint.ts` (`caseFingerprint` — gate flags hash their rounded drift numbers so changed numbers = new case; row holds hash kind+natural_key), `lib/sync/cases-fold.ts`, `lib/sync/privileged.ts` (shared `requirePrivileged`, extracted from actions.ts), `app/(app)/sync/cases.ts` (`ensureCasesForRun` idempotent fan-out + ledger pre-annotation, `listOpenCases`, `getCaseWithMessages`).
- **P2 — toolset.** `lib/investigator/{tools,allowlist,query,source,rules}.ts`: `query_table` (11 tables + 3 views, column allow-lists, price columns unconditionally excluded + post-query scrub), `check_duplicates`, `read_run_source` (generic capped SheetJS grid dump from the private `sync-inbox` bucket — no per-report parsers needed, the model reads the grid), `find_batches` (month-prefix-variant aware), `read_rule` (L-rules digest/full).
- **P3 — the investigator.** `lib/investigator/loop.ts` `runInvestigation(caseId, {escalate?, force?})`: compare-and-swap single-flight (open→investigating), 8 iterations/16 tool calls, terminal `submit_verdict` tool (grace iteration → synthesized needs-human fallback), transcript persisted to `sync_case_messages` live (= the streaming), verdict jsonb + status on the case, error → status reset to open. `lib/investigator/playbook.ts`: per-kind diagnostic recipes, jargon ban (same banned list as adjudication.ts), citation rules. Models: `INVESTIGATOR_MODEL='claude-sonnet-4-6'`, `INVESTIGATOR_ESCALATION_MODEL='claude-opus-4-8'` (lib/anthropic/client.ts). Auto-trigger: `autoInvestigateRun(runId)` (ensure + concurrency-2 pool over fresh open non-known cases), fired fire-and-forget from `useSyncRun.finalizeRun` when a run lands with held rows.
- **P4 — Sync Review page + chat.** Route `/sync/cases` (privileged-gated), `components/sync/cases/` (CasesClient/CaseList/CaseDetail/CaseThread/CaseChatInput/labels): dense Excel-standard case list (filters, verdict + known-issue badges), detail (drift table, verdict card w/ confidence + citations, live thread over Realtime, collapsed tool strips), actions bar (Investigate / Re-investigate / Escalate to Opus). `app/(app)/sync/case-chat.ts` `chatOnCase` — same loop in chat mode (shared `runToolLoop` factored in loop.ts), 5 iterations/10 calls, submit_verdict can revise the verdict mid-chat. Navbar breadcrumb "Sync Review"; HeldRows.tsx links "Open in Sync Review →".
- **P5 — confirm-gated resolve.** `lib/investigator/resolution.ts` (`propose_resolution` — CHAT-mode-only tool, write-free, eligibility enforced twice), `app/(app)/sync/resolve.ts` (`executeResolution` re-reads the proposal from the DB message row — never trusts the client; double-execution guard; `cancelProposal`; `quickDismiss` w/ required reason), `lib/sync/apply-writers.ts` (registry: **rc_out** via `write_ingestion_audit`, **deliveries** via `set_audit_comment`+trigger; unique-batch-match required — never auto-creates; cost_basis forced 0 per L-008; other types refuse with a plain message). Every resolution → ruling row (feeds the ledger) + case resolved + system-message trail + provenance "resolved via case chat by <email>". UI: ResolutionCard (old→new table for edit_apply, destructive Confirm for applies) + Quick Dismiss dialog.
- **P6 — trust harness.** `scripts/eval-investigator.ts` (permanent, `--case`/`--keep`, cleanup in `finally`, safe to re-run on prod — synthetic 2020 dates isolate): **5/5** — june10-o-gt-m (skip/high, 13 calls, 75s), may-proposed-overstated (skip/high, 10 calls, 49s), seeded-true-dup (needs-human/high, 2 calls, 20s), ledger-rematch (no model), write-safety (operational tables untouched). One playbook fix landed from the eval: the O>M duplicate branch now explicitly verdicts **needs-human, never skip** (the model had the right reasoning but the wrong label — failed twice, so it was systematic, not variance).

## Verification state (all green at handoff)

`npx tsc --noEmit` · `npm run build` · six verify scripts: investigator-loop **28**, investigator-tools **31**, case-fingerprint **5**, sync-reducer **22**, adjudication **10**, resolution **28** (= 124 assertions) · eval **5/5** · DB seeded-row orphans **0**. Migration applied to remote; types regenerated.

## Critical learnings

- **The eval caught a real playbook bug** (dup → "skip") that three green live-smokes missed — the trust harness is not ceremonial. Re-run it after ANY playbook/model change.
- **Two P3 live-smoke observations worth keeping:** the investigator coped with an empty storage path (fake run) by concluding from DB queries alone with honest citations; and it invented a useful check we never scripted (all 5 June-10 rows share one `created_at` → not a re-insert).
- **Subagent discipline:** one implementation agent responded to its brief by delegating-and-stopping (nothing on disk). Fix: briefs now say "do the work YOURSELF — do NOT spawn or delegate," and verify disk state (`git status`) before trusting any completion report.
- **`audit_logs` SELECT is revoked even from the local service-role key path** used by scripts — smoke tests can prove audit writes by RPC success + MCP read, not by direct SELECT.
- **Killed background agents can't be resumed** (SendMessage refuses) — a fresh agent auditing disk state against the spec worked cleanly as the recovery pattern.

## Deltas vs the plan (deliberate, flag-to-Renzo items)

1. **Gate-failure flags are dismiss-only in v1.** No `override_gate` wiring (would need a worker re-run capability; every real case so far resolved correctly as dismiss). The rulings CHECK already accepts `override_gate` — future add needs no migration.
2. **Apply-writers cover rc_out + deliveries only**; production/flecon/gsheet rows refuse with "not supported yet — dismiss, or run through the sync employee."
3. **No browser screenshot of `/sync/cases`** — the preview browser can't authenticate past the login wall (and Renzo's own dev server held the lock). Verified via build + route-serve (307→/login proves the gate) + the real `listOpenCases()` wire shape on seeded data. **First manual look is on Renzo.**

## Current state / how to try it

Dev server: `env -u ANTHROPIC_API_KEY npm run dev` (the env quirk). Run a sync from the dashboard; if rows are held, cases auto-appear and investigate — watch `/sync/cases` (navbar: Sync Review). Chat with any case; say "dismiss this" → ResolutionCard → Confirm. Eval: `npx tsx scripts/eval-investigator.ts` (~3 Sonnet investigations ≈ cents).

## Next concrete action

1. **Shakedown on a real daily sync** — the June-10-style flags will re-appear as cases; resolve them through the chat (this also seeds the real ledger).
2. **P-Fly** (deferred from last session, still ~15 min of `flyctl` per `workers/sync/RUNBOOK.md`) — makes the sync worker laptop-proof.
3. Later: `override_gate`, more apply-writers, generalize the playbook beyond the rc_out gate family.

## Key files

`SMART_ADJUDICATOR_PLAN.md` (spec + status stamp) · `lib/investigator/` (tools/loop/playbook/resolution + CONTEXT.md) · `lib/sync/{fingerprint,cases-fold,privileged,apply-writers}.ts` · `app/(app)/sync/{cases.ts,case-chat.ts,resolve.ts,cases/page.tsx}` + CONTEXT.md · `components/sync/cases/` · `supabase/migrations/20260706120000_smart_adjudicator_cases.sql` · `scripts/{eval-investigator,verify-*}.ts`
