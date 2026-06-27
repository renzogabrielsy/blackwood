---
name: feedback-commit-splitting
description: How to split one staged changeset into multiple logical commits while honoring Renzo's "always git add ." rule
metadata:
  type: feedback
---

When a task requires splitting a single working-tree changeset into several logical conventional commits, reconcile it with Renzo's hard rule "always stage with `git add .`, never individual files / never hunk-stage" like this:

- Stage the WHOLE tree once: `git add .`
- Build each commit by passing explicit pathspecs to commit, NOT by re-staging: `git commit -m ... -- <path1> <path2>`. `git commit -- <pathspec>` commits only those paths from the index and leaves the rest staged for the next commit.

**Why:** This satisfies both constraints simultaneously — `git add .` does all the staging (his rule), and `commit -- <pathspec>` does the grouping without any per-file `git add` or `git add -p`.

**How to apply:** Any multi-commit split on this repo. Verify after each commit with `git --no-pager log -1 --stat` and confirm a clean `git status --short` before pushing.

**Caveat — file-granular only:** `commit -- <pathspec>` cannot split changes *within* one file across commits. When a single file legitimately serves two commits (e.g. `app/(app)/cenapro/types.ts` held both production lookup constants AND opening-balance types), it must land whole in one commit — pick the one the task assigns it to and note the overlap in the other commit's reasoning. Do not reach for hunk staging to separate them; that violates the rule.

**Generated artifacts (`types/supabase.ts`) span features — land in the FIRST consuming commit.** A regenerated file like `types/supabase.ts` is one atomic blob that often reflects TWO+ migrations from the same session (e.g. a `fn_blend_proposal` RPC AND new `deliveries` columns). It cannot be split. Put it in the commit whose code is the FIRST to reference any of its new symbols (so that commit type-checks), and add one sentence to the LATER feature commits' bodies noting "the regenerated types for these columns shipped in <earlier commit>". Confirmed acceptable on 2026-06-27.

**When 3+ features all touch the same component, split by FILE-cluster, not by feature.** The 2026-06-27 blocking session had Blend Proposal, native-print, price-toggle, and deductions-popover all editing `blocking-grid.tsx` + `blocking-detail-panel.tsx` + `actions.ts` in interleaved hunks. Forcing feature-pure commits would have produced non-buildable intermediates (a file importing a symbol a later commit defines). Resolution: each shared file lands WHOLE in its dominant-feature commit; the body names the secondary concern that rode along ("price-toggle ships here because it's inseparable from blend mode in this component"). This is the buildable-commit rule applied to multi-feature overlap, and Renzo's brief explicitly invited it ("organize commits as you see fit").

**Trailer:** every commit on this project ends with the exact line
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
(NOTE 2026-06-27: dropped the old "(1M context)" suffix — current standing instruction and the system prompt both use the bare `Claude Opus 4.8` form. Use the user's stated trailer verbatim each session; don't assume the archived one.) Pass it as its own final `-m` so it renders as a real git trailer; verify with `git log --format="%(trailers:key=Co-Authored-By)"`.
