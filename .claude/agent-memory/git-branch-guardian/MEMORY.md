# Git Branch Guardian Memory — Blackwood

## Index

- [Main promotion playbook](main_promotion_playbook.md) — branch model, the `feat/*`→`main` `--no-ff` recipe, merge-base tree conflict test, authorized direct-to-main cases.
- [Gates and shell traps](gates_and_shell_traps.md) — build/test/parity/lint gates before `main`; the zsh `$PIPESTATUS` trap that fakes a green run.
- [Staging exclusions](staging_exclusions.md) — what to unstage after the mandatory `git add .`; triaging untracked source files; content-level secret scan.
- [Commit splitting under `git add .`](feedback_commit_splitting.md) — split one staged changeset into several commits via `git commit -- <pathspec>`, no per-file staging.

## Role

- **You are an EXECUTOR.** Do the git work yourself with your own Bash calls, verify with post-action `git log`/`git status`, report in the fixed block format. Never narrate future work, never claim anything runs "in the background" — the old advisor persona stalled mid-commit doing exactly that (twice, 2026-07-07).
- Renzo delegates ALL git ops here and never runs git directly, so a stall leaves him with nothing.

## Standing conventions

- **Staging:** always `git add .`, never individual files. Exclusions happen after, via `git restore --staged`. See [Staging exclusions](staging_exclusions.md).
- **Trailer:** use the EXACT trailer the task prompt specifies, verbatim — it names a different model version most sessions (`Claude Opus 5`, `Claude Opus 4.8`, `Claude Fable 5` have all appeared). Pass it as its own final `-m` so it renders as a real git trailer.
- **Conventional commits:** `feat|fix|refactor|docs|chore|test|perf|ci|build|revert(<scope>): <imperative, lowercase>`.
- **Ship, don't hold:** when work is done the default is commit + merge to `main` + push — Renzo tests on the live Vercel app, not locally.
- **Multi-concern split, buildable-commit rule:** when one file mixes two concerns, keep the FILE whole in its dominant-concern commit rather than splitting hunks — hunk-splitting risks non-buildable intermediate commits. Split by file-grouping; note unavoidable bleed in the commit body.

## Repo facts

- Next.js App Router, route groups under `app/(app)/`. Supabase + Postgres. Sync worker at `workers/sync/`.
- Working tree is otherwise clean — good hygiene; unexpected dirt is worth a second look, not a shrug.
