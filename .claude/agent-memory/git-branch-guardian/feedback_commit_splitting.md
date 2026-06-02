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

**Trailer:** every commit on this project ends with the exact line
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
Pass it as its own final `-m` so it renders as a real git trailer; verify with `git log --format="%(trailers:key=Co-Authored-By)"`.
