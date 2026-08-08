---
name: deploy-targets
description: Blackwood has TWO deploy targets — pushing `main` deploys the Vercel app ONLY; the Fly sync worker (`workers/sync/**`) needs an explicit `npm run deploy` and is otherwise inert
metadata:
  type: project
---

**Pushing `main` does NOT deploy the sync worker.** Vercel builds the Next.js app from
`main` and nothing else. `workers/sync/` is a separate artifact on **Fly.io** (app
`blackwood-sync`, region `nrt`) that ships only when someone runs
`cd workers/sync && npm run deploy`.

| Change touches | How it reaches production |
|---|---|
| `app/**`, `lib/**`, `components/**`, migrations | merge to `main` → Vercel auto-deploys |
| `workers/sync/**` | merge to `main` **and then** `cd workers/sync && npm run deploy` |

**Why:** on 2026-08-08 a full day of sync fixes (delivery two-tier identity key, the
`deliveries` human-edit latch, Czarina's tab resolved by month) was merged to `main`,
green and live on the website, while the Fly machine still ran a five-day-old bundle
(version 13, built 2026-08-03) — and the deploy that would have shipped them had itself
been failing the whole time on a broken container build. Promotion 46 (`e9aa32e`) fixed
the build and documented the gap in `CLAUDE.md`, `workers/sync/DEPLOY.md` and `RUNBOOK.md`.

**How to apply:**

- When a brief promotes a **worker-only** changeset and does not mention a Fly deploy,
  **say so in the report** — the merge alone has changed nothing in production. Do not
  run `fly deploy` yourself unless the brief authorizes it (it is a deploy, not a git op),
  but never let the report imply `main` shipped it.
- When a brief says the worker was **already deployed** before the commit (promotion 46's
  shape), note that the running image was built from the then-**uncommitted** working tree,
  so its startup banner names the PARENT commit, not the new one. That is expected, not a
  mismatch — but it means the deployed bytes were only *provably* identical to the commit
  because the tree was unchanged between deploy and commit.
- Ship discipline is unchanged for app-layer work: [[main-promotion-playbook]] still governs.

**The worker's own pre-deploy gate is `npm run verify:container-build`** (added in
promotion 46, wired as `predeploy`). It parses the Dockerfile's builder-stage
`COPY`/`WORKDIR` plus the root `.dockerignore`, materialises exactly that file set and
runs the worker's esbuild over it in ~2s with no Docker daemon. **Run it as a gate on any
promotion touching `workers/sync/Dockerfile`, the root `.dockerignore`, or
`esbuild.config.mjs`** — see [[gates-and-shell-traps]]. The class of bug it catches is the
one no other gate can: local `tsc`/tests/parity/lint all read shared files off the dev
disk, so they stay green while the container is missing them.
