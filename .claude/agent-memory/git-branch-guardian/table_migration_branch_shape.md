---
name: table-migration-branch-shape
description: Table migrations use one feat/<screen>-v2-default branch per SCREEN — except screens that share a page.tsx, which get ONE branch together (the ICTC production tabs precedent).
metadata:
  type: project
---

Table migrations (v2 default + inline editing + Year/Month picker) branch as
`feat/<screen>-v2-default`, **one per screen** — EXCEPT when several screens share
the same `page.tsx` / view files, in which case they take ONE branch together.

**Precedent (2026-08-26):** Renzo approved four migrations at once. The three ICTC
production tabs (Daily / Electricity / Trucks) share one page and one toggle, so
they went on a single `feat/production-tabs-v2-default` — a deliberate, stated
deviation. Cenapro Deliveries kept the per-screen convention on its own
`feat/cenapro-deliveries-v2-default`. Both cut from `main` @ `163207a`.

**Why:** three branches over one shared `page.tsx` would conflict on every merge —
the convention exists to keep screens independent, and it stops paying when the
files are not independent.

**How to apply:** when a brief asks for N migration branches, check whether the
screens share a page before creating N branches. If they do, say so and propose one
branch. Never collapse branches on your own initiative for screens with separate
files — the deviation must be stated in the brief.

**Parallel-agent shape that worked:** the branch the in-repo agents use gets
checked out; a branch destined for a worktree-isolated agent is created and pushed
here but NOT checked out (`git branch <name> main` + `git push -u origin <name>`,
which sets upstream from any branch). Branches are repo-wide, so creating it in the
main repo makes it visible to every worktree. See [[concurrent-session-promotions]].

## The registry conflict is STRUCTURAL — expect it on every v2-default promotion

Two v2-default branches cut from the same base ALWAYS conflict on exactly one hunk:
the `FLIPPED_PAGES` registry in `scripts/verify-table-core.ts`. Each branch appends
its own screen to the same array at the same line, so git sees competing insertions.

**The resolution is always the UNION** — keep every entry, one per line, no reorder.
It needs no judgement because the gate proves it: the registry scan walks every page
BOTH ways (an unregistered flip fails, and a registered page that has not flipped
fails too), so a wrong union cannot pass. Re-run `npx tsx scripts/verify-table-core.ts`
after resolving — the count grows by the assertions the branch added (80 after the
production-tabs + cenapro-deliveries union, 2026-08-26).

**How to apply:** predict it before merging with
`git merge-tree --write-tree main HEAD | grep CONFLICT`. **Exactly one CONFLICT line
naming that one file is the expected shape; anything else means STOP and report.**
Then merge `main` into the feature branch, resolve, re-gate (`verify-table-core` +
`tsc --noEmit`), push the branch, and only then merge to `main` — so `main` never
sees an unresolved state and its merge is a clean fast-forwardable `--no-ff`.

**Prove the promotion carried nothing extra:** after merging to `main`, compare trees
— `git rev-parse HEAD^{tree}` vs `<branch>^{tree}` must be EQUAL. That is a stronger
check than reading the diffstat, and it catches a bad conflict resolution that a
passing gate might not.

Dirty-file note: the standing `.claude/agent-memory-local/**` +
`supabase/.temp/cli-latest` modifications survive a branch cut from `main` untouched
when their blobs match HEAD — always run the blob pre-check
(`git rev-parse HEAD:<f>` vs `main:<f>`) rather than reflexively stashing. See
[[staging-exclusions]].
