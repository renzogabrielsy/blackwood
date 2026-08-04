---
name: main-promotion-playbook
description: How work reaches `main` in Blackwood — branch model, the feat→main --no-ff promotion recipe, the merge-base tree conflict test, and the authorized direct-to-main exceptions
metadata:
  type: project
---

`main` = production (Vercel deploys the live URL from it). `dev` = staging. `feat/*` = feature work.

**Why:** Renzo tests on the live app, so "ship it" nearly always means landing on `main` and pushing. Getting the promotion shape wrong either fails to deploy or rewrites protected history.

**How to apply:** pick the path below that matches the task prompt, then run the gates in [[gates-and-shell-traps]].

## The dominant path: `feat/*` → `main` directly (bypassing `dev`)

Accepted live-deploy path **when the task prompt explicitly authorizes it** (first used 2026-07-27, `ca18c6d`). `dev` is not involved and does not need to be.

```
git checkout main && git pull --ff-only origin main
git merge --no-ff <feat> -m "chore: merge <feat> into main — <summary>"
git push origin main
git checkout <feat>            # restore the starting branch
```

Keep `--no-ff` even when a fast-forward would work — the merge commit is what marks a prod promotion.

### The conflict test: merge-base tree comparison

```
git diff --stat origin/main $(git merge-base origin/main <feat>)
```

**Empty output = main's tree equals the merge-base tree**, so the merge applies only the new commits and is structurally conflict-free. Held on 13 consecutive promotions (empty diff, merge exit 0, every time).

- Prefer this merge-base form over `<feat-tip>^` — it stays correct when the branch accumulated more than one commit since the last promotion (2026-07-30 Phase B had 2; 2026-08-04 had 2).
- **Do NOT use `git rev-list --left-right --count origin/main...<feat>` as the gate.** After each promotion `main` carries merge commits the feat branch lacks, so it reads `N M`, not `0 N`. `main` is no longer a strict ancestor and **that is EXPECTED, not divergence.** Don't stall on it.
- Post-merge, confirm `git diff --stat main <feat>` is ALSO empty — cheap proof the merge took everything — before pushing.
- Renzo explicitly asked (2026-08-03) for the tree diff *instead of* the ancestry commit list. Don't report the list; by the 13th promotion it is a dozen `chore: merge …` lines of pure noise.

## `feat/gmail-oauth-sync-auth` — the long-lived promotion branch

21 promotions as of 2026-08-04, latest `434eb7b`; earlier `c9c4f1a`, `0be5b4a`, `478b0c0`, `566d68a`, `8ff1c77`, `52178d9`, `db95d03`, `ca18c6d`, `70dfa60`, `3450d3c`, `96e825b`, `c3608d5`, `7ac5674`, `070e52e`, `437be13`, `65c21e3`, `a773826`, `ff776f8`, `e51045f`, `8be1fa3`.

The merge-base tree test has now held **18 consecutive promotions** (empty diff, merge clean, every time) — including `478b0c0` and `0be5b4a`, both promoted from a working tree a second Claude session was editing concurrently ([[concurrent-session-promotions]]).

### Branching a correctly-named `feat/*` off a mis-named one (2026-08-04, `c8ffc53`)

`feat/gmail-oauth-sync-auth` accumulates work whose name stopped describing it long ago. When a
brief's changeset has nothing to do with the branch name, **cut a new branch from the current
HEAD** (`git checkout -b feat/<slug>`) rather than piling on. It costs nothing here because after
each promotion HEAD is already an ancestor of `main` (`git merge-base --is-ancestor HEAD main`,
exit 0) and the trees are identical (`git diff --stat <HEAD> <main>` empty) — so the new branch's
merge-base with `main` IS `main`'s tree and the gate passes trivially. `main` being AHEAD of the
branch base by its own merge commits is the normal steady state, not divergence; the `--no-ff`
merge back preserves every one of them (`git merge-base --is-ancestor <old-main-tip> main` to
prove it in the report).

`feat/cenapro-deliveries-qol` (promotion `c8ffc53`) is the first branch cut this way. Same
promotion recipe, no `dev`, no PR.

**Cheap pre-checkout check when the tree is dirty:** compare `git diff --name-only origin/main <feat>` against `git diff --name-only`. No overlap ⇒ `git checkout main` carries the dirty tracked files across without "local changes would be overwritten". Run it before the checkout, not after it fails.

**Never delete this branch after a promotion** — it keeps accumulating work and is re-merged.

A **docs-only promotion is still a full `--no-ff` promotion** (2026-08-04, `52178d9`, one `handoffs/YYYY-MM-DD-*.md` file): same recipe, same gate discipline, no shortcut to a FF. Session-handoff files are a standing CLAUDE.md convention (`handoffs/` at repo root, never deleted), so `docs(handoff): <date> <slug>` commits recur — scan them like any other file, but the build gate alone suffices when nothing under `workers/sync/` is touched.

**A brief may pre-run the build and waive the gate — honour it** (2026-08-04, `434eb7b`, 3 markdown files): "`npm run build` was run before this brief and exited 0, so skip it." Markdown-only changesets have no code impact; re-running an 8-minute build to prove a `CONTEXT.md` compiles is waste. Same waiver shape as `0be5b4a` in [[concurrent-session-promotions]] §1b.

**Concurrent-session mode can be OFF — verify, don't assume.** [[concurrent-session-promotions]] says to presume selective staging when `app/(app)/cenapro/deliveries/**` is in play. On `434eb7b` the brief said the same, but `git status --short` came back clean apart from the brief's own 3 paths + the standing `.claude/agent-memory*` dirt — no stray source files at all. The pre-staging `git status --short` is what decides; report it verbatim when the brief asks whether the other session is live.

## `dev` → `main` promotion: LOCAL merge commit, no PR

Precedents `d323257`, `bacbe12`, `0e4ae9c` — all `git checkout main && git merge --no-ff dev -m "..."` then `git push origin main`. Never a GitHub PR. `main` has diverged history from `dev`, so `git merge --ff-only` always fails with "Diverging branches" — go straight to `--no-ff`. Trigger is an explicit request to sync the Vercel *production* target (a build/config or perf fix), not routine feature landing.

## `feat/*` → `dev`: GitHub PR **merge commits**

`gh pr merge <n> --merge` — NOT squash, NOT rebase. dev's history is a chain of "Merge pull request #N from …" commits (#3–#19). Match it.

- GitHub's repo *default* branch is `main`, so **always pass `--base dev` explicitly** when opening a feat→dev PR.
- Neither `dev` nor `main` has branch protection (gh api → 404 "Branch not protected"), but still confirm `mergeStateStatus: CLEAN` when a PR is used.
- **EXCEPTION:** when the task prompt itself says "ff expected" AND `dev` is a strict ancestor of the feat tip (`git merge-base --is-ancestor origin/dev <feat>`, exit 0), a plain `git merge --ff-only` with no PR is correct — that's what was asked for, not a shortcut. Done 2026-07-17 for `feat/mobile-pwa`.
- **`gh pr view --json merged` is INVALID in this gh version** — use `state` (=="MERGED"), `mergedAt`, `mergedBy`, `mergeCommit.oid`. A bad `--json` field exits 1 and silently skips any `&&`-chained git command after it; run gh JSON queries standalone.

## Direct commits to `dev` and `main`

- **`dev`: direct conventional commits ARE the norm** for session work (verified 2026-07-07: `014fff4`→`4ccd9ae`). Reserve `feat/*` + PR merges for large multi-session feature lines. Do NOT refuse or stall on an explicit direct-to-dev instruction.
- **`main`: direct commit only on an explicit, unambiguous instruction naming `main` + the live-deploy motivation.** Two authorized instances, both 2026-07-23: `529687e` (Shipments/Trello export feature) and `b2949b7` (a "trigger redeploy" commit whose entire purpose was forcing a fresh Vercel build so dashboard-added env vars get picked up — Vercel only reads new env vars on the next build). Plain `git push origin main`, no PR.
- If a branch is already **ahead of its remote before you start**, your push republishes those older local commits too — call that out in the report (happened 2026-07-23 with `9878caf` + `a871b5a`).

## Misc

- **Merged `feat/*` branches are KEPT, not deleted** — every historical feature branch (local + origin) survives. Default to keeping unless told otherwise.
- Branch naming shifted from `feat/<UI|backend>/<name>` (early) to flat `feat/<kebab-name>` (recent).
