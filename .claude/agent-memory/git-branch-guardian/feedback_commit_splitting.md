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

**CRITICAL — NEVER mix `git commit -- <pathspec>` with partial-index (hunk) staging (learned the hard way 2026-06-30).** `git commit -- <pathspec>` does NOT commit the index for those paths — it re-reads the WORKING-TREE version of each named path and commits that, silently discarding any partial/hunk staging you did via `git apply --cached`. Symptom that session: I `git apply --cached`'d only hunk 1 (auth) of `production-manager.md` and only the shift hunks of `extract_daily_production.py`, then ran `git commit -- <those paths>` — both files got committed WHOLE (4X8 leaked into the shift commit; shift hunks leaked into the auth commit). Nothing was lost, but the split was wrong and I had to `git reset --soft` back and redo. **Rule:**
  - Whole-file groups → `git commit -- <pathspec>` is fine (working-tree == intended index).
  - ANY file you hunk-split into the index → commit it with PLAIN `git commit -m ...` (NO `--`/pathspec), which commits exactly the index. Stage every path you want first, then bare-commit. To interleave whole-file and hunk-split groups in one sequence, do the hunk-split commits via bare `git commit -m` and reserve `-- <pathspec>` only for runs where no listed path is partially staged.
  - Always verify post-commit with `git show --stat HEAD` AND `git show HEAD -- <split-file> | grep -c '^@@'` to confirm the hunk count matches intent.

**How to apply:** Any multi-commit split on this repo. Verify after each commit with `git --no-pager log -1 --stat` and confirm a clean `git status --short` before pushing.

**Caveat — prefer file-granular; hunk-split only when truly necessary.** `commit -- <pathspec>` cannot split changes *within* one file across commits. DEFAULT: when a single file legitimately serves two commits (e.g. `app/(app)/cenapro/types.ts` held both production lookup constants AND opening-balance types), land it WHOLE in its dominant-concern commit and note the overlap in the other commit's body. This keeps `git add .` whole and avoids hunk staging.

**Hunk-splitting IS allowed when all three hold (done successfully 2026-06-30):** (1) the task explicitly wants granular per-concern commits AND the file mixes genuinely separate concerns; (2) the hunks are cleanly separable so every intermediate commit still builds (e.g. a one-line `VALID_GRADES` set literal vs. a large `resolve_run_shift` block in the same `.py` — the set edit is valid in any subset); (3) you commit index-only (see the CRITICAL note above — bare `git commit -m`, never `-- <pathspec>`, for the split files). Mechanics that worked: `git diff -- <file> | awk '/^@@/{h++} <keep-condition>{print} ' > /tmp/x.patch` to isolate hunks, then `git apply --cached /tmp/x.patch`. For a PURE-DOCS file whose hunks interleave two concerns and can't be cleanly separated (e.g. `PRODUCTION_DESIGN.md` had a hunk adding both a 4X8 migration-log row AND an L-025 addendum), keep it WHOLE in its dominant concern (buildability is moot for docs) and note the bleed — don't sub-hunk-edit prose.

**Generated artifacts (`types/supabase.ts`) span features — land in the FIRST consuming commit.** A regenerated file like `types/supabase.ts` is one atomic blob that often reflects TWO+ migrations from the same session (e.g. a `fn_blend_proposal` RPC AND new `deliveries` columns). It cannot be split. Put it in the commit whose code is the FIRST to reference any of its new symbols (so that commit type-checks), and add one sentence to the LATER feature commits' bodies noting "the regenerated types for these columns shipped in <earlier commit>". Confirmed acceptable on 2026-06-27.

**When 3+ features all touch the same component, split by FILE-cluster, not by feature.** The 2026-06-27 blocking session had Blend Proposal, native-print, price-toggle, and deductions-popover all editing `blocking-grid.tsx` + `blocking-detail-panel.tsx` + `actions.ts` in interleaved hunks. Forcing feature-pure commits would have produced non-buildable intermediates (a file importing a symbol a later commit defines). Resolution: each shared file lands WHOLE in its dominant-feature commit; the body names the secondary concern that rode along ("price-toggle ships here because it's inseparable from blend mode in this component"). This is the buildable-commit rule applied to multi-feature overlap, and Renzo's brief explicitly invited it ("organize commits as you see fit").

**Trailer:** every commit on this project ends with the exact line
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
(NOTE 2026-06-27: dropped the old "(1M context)" suffix — current standing instruction and the system prompt both use the bare `Claude Opus 4.8` form. Use the user's stated trailer verbatim each session; don't assume the archived one.) Pass it as its own final `-m` so it renders as a real git trailer; verify with `git log --format="%(trailers:key=Co-Authored-By)"`.
