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
