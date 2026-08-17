---
name: staging-exclusions
description: What to unstage after Renzo's mandatory `git add .` — machine-local .claude dirs, supabase CLI scratch — and how to triage untracked source files the brief never mentioned
metadata:
  type: feedback
---

Renzo's hard rule is **always `git add .`, never stage individual files**. So exclusions happen AFTER staging, via `git restore --staged <path>`.

**Why:** he wants one predictable staging command, not per-file judgment calls that risk leaving real work behind. The cost is that a blanket `add .` sweeps in machine-local scratch, which must be backed out deliberately.

**How to apply:** `git status -sb` first, eyeball every `??` and every `.claude/` path, `git add .`, then restore the exclusions below, then `git diff --staged --stat` to confirm.

## Standing exclusions

- **`.claude/agent-memory-local/**`** — TRACKED (not gitignored) and locally modified nearly every session. The dirty set is >1 file (since 2026-08-03 also `supabase-backend-engineer/production-module-schema.md` alongside its `MEMORY.md`), so **unstage the whole DIRECTORY**: `git restore --staged .claude/agent-memory-local/` — never one named file. Expect it as a standing ` M` in `git status -sb` on every branch after checkout/merge/commit; it is not new noise. It survives `git checkout main` cleanly (same blob on both branches), so the promotion dance never trips on it.
- **The exclusion holds even when a task prompt says "include it".** 2026-07-27 an orchestrator listed the file as "incidental, include it"; that phrasing describes a dirty tree, not a deliberate override. Unstage it, commit the rest, flag the exclusion in the report — conservative and reversible.
- **When the brief's VERBATIM commit message claims the excluded path, amend that ONE body line — never the subject, never the trailer, and never the exclusion.** 2026-08-17 (`22eaff5`, `feat/universal-table`): the supplied body said *"agent memory updates from the perf-reviewer and supabase-backend-engineer runs"*, but supabase-backend-engineer's memory lives in `.claude/agent-memory-local/`. Three options, only one is honest: committing it violates the standing exclusion; shipping the message as-given makes the commit describe files it does not contain. So rewrite that bullet to name only what shipped **plus why the rest did not**, and lead the report with it. A commit body that lies is worse than a body that deviates from the brief.
- **`.claude/agent-memory/`** (NON-local, shared/versioned) **stays staged.**
- **`supabase/.temp/cli-latest`** — CLI scratch (just the installed Supabase CLI version string), tracked but not gitignored; changes on any local `supabase` invocation (verified 2026-07-17: only `v2.109.0`→`v2.109.1`). Never stage; expect a lingering ` M`.

**CORRECTION (verified 2026-07-11): `.gitignore` has ZERO `.claude`/`agent-memory` entries — nothing named `.claude` is actually gitignored in this repo.** Those paths just were never `git add`ed by anyone. So any `**/.claude/**` untracked dir — including novel ones one level down like `workers/sync/.claude/` — WILL be swept up by a bare `git add .`. Don't assume gitignore has it covered. (`git check-ignore` on a tracked file inside such a dir reports "not ignored" because tracked paths bypass the check.)

## Untracked `??` SOURCE files the brief never mentions

Usually **real parallel work — commit them, but in their OWN commit** (2026-08-04, promotion `566d68a`). The QC-month brief listed 3 tracked files; `git status` also showed `?? lib/cenapro/rc-formula.ts` (366 lines) + `?? scripts/verify-rc-formula.ts` (286) — a fully-documented formula parser from a different work line in the same tree. The `git add .` rule means they ship, but folding them into the brief's commit would make its subject a lie. Split with the pathspec recipe in [[feedback-commit-splitting]]: `git commit -- <the brief's files>` first, then a bare `git commit` for the remainder.

Triage before deciding:
- `grep -rn <module> --include='*.ts' --include='*.tsx' .` — does anything import it? (Nothing did → zero build risk.) **zsh trap:** unquoted `--include=*.ts` dies with "no matches found"; always quote the glob.
- Read the head of the file — authored prose/JSDoc means real work, not scratch.
- Do NOT confuse this with `.claude/**` machine-local dirs, which stay excluded.

## A committed source file can carry a machine-local path in a CONSTANT

The secret scan must look past filenames and into content. `scripts/verify-rc-formula.ts:223` hardcodes `/private/tmp/claude-501/.../<expired-session-uuid>/scratchpad/rc2026-extract.json` as its replay fixture. Not a secret, and `existsSync`-guarded so it degrades silently, but it is dead on any other machine. Committed as-is (editing source is not the git operator's call) and flagged to the orchestrator.

Scan pattern: `grep -nE '/Users/|/home/|/private/tmp/|sk-|eyJ|API_KEY|SERVICE_ROLE|password|token|secret' <staged files>`. Expect benign hits on `token` from any tokenizer/parser code — read the match, don't just count it.

**Non-secret identifiers are fine to commit:** `scripts/trello-shipments/set-vercel-env.sh` intentionally hardcodes a Trello **board ID** as a fallback default. Board IDs are embedded in Trello URLs, not auth material; only `TRELLO_API_KEY`/`TRELLO_TOKEN` *values* are secrets.

**The FIXED form of that machine-local path** (`scripts/verify-rc-deliveries-cells.ts`, 2026-08-04): scratch path first, then `const FALLBACK = 'scripts/cenapro/rc2026-extract.json'`, `existsSync(EXTRACT) ? … : existsSync(FALLBACK) ? … : null`. With the fixture committed in-repo the script actually replays on any machine. Don't flag this shape — flag only the fallback-less one.

**Large business-data JSON is committable here.** `scripts/cenapro/rc2026-extract.json` (~800KB, 34k lines — real supplier names + prices) ships deliberately as the RC-deliveries import's provenance record. Private repo, project's own data, zero secret-shaped strings (`grep -c 'eyJ|sk-|SERVICE_ROLE|apikey|password'` = 0). Scan its *content*, don't reject it on size or on the words "supplier"/"price". Importers here read credentials from `process.env` (`SUPABASE_SERVICE_ROLE_KEY`) — confirm that, don't assume it.

## Concurrent session + COMMIT-ONLY brief (no promotion) — `git add .` still rules

2026-08-04, `c761ad0` + `12fb533` on `feat/gmail-oauth-sync-auth`. [[concurrent-session-promotions]]'s selective-staging override fires ONLY when a brief enumerates the exact paths. A brief that merely *names files to consider excluding* is not that — keep `git add .`, then `git restore --staged` the named paths. Two ways to get this wrong: sweeping their work in, and inventing a path list nobody gave you.

- **The other session's pending edits to the SHARED guardian memory** (`main_promotion_playbook.md`, `concurrent_session_promotions.md`) are the one exception to "`.claude/agent-memory/` stays staged". They record ITS promotions and it commits them itself as `chore(memory): record Nth promotion …`; it may append another before it's done. Unstage, leave on disk, say so.
- **Record your own learning in a file the other session is NOT holding** (here: this file) so it can ship in your own `chore(memory)` commit instead of getting entangled in theirs. Check mtimes + `git status` before choosing which memory file to write.
- **A shared docs file mixing both sessions' prose** (`app/(app)/cenapro/CONTEXT.md`) is safe to commit WHOLE on a feature branch — the QC hunks documented already-shipped code (`f121671`), so committing them catches the doc up rather than shipping unfinished work. That's the opposite call from a `main` promotion, where the blast radius is production. Note the bleed in the commit body.
