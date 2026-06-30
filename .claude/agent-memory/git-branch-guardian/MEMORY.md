# Git Branch Guardian Memory - Blackwood Project

## Project Context
- **Repository:** Blackwood (industrial charcoal inventory management system)
- **Main Branch:** `main` (production); `dev` is staging — never commit directly to either, always branch a `feat/*` first
- **Active Development (2026-06-27):** `dev` = `origin/dev` = `79c2684` (Merge PR #19 from `feat/ictc-modules-routing` — Blend Proposal what-if + ×1.30 product cost, forward-only weight-deductions protocol with `true_weight_kg`/`deduction_note`, rc_out/delivery dedup fixes L-019/L-020/L-021). PR #19 took dev `56a375a` → `79c2684`. `main` untouched at `4deb20e`.
- **MERGE CONVENTION (verified 2026-06-27): merge `feat/*` → `dev` via GitHub PR MERGE COMMITS** (`gh pr merge <n> --merge`), NOT squash/rebase. dev's history is a chain of "Merge pull request #N from ..." commits (#3–#19). Match this; do NOT squash. Neither `dev` nor `main` has branch protection (gh api → 404 "Branch not protected") — merges aren't gated by reviews/checks, but still confirm `mergeStateStatus: CLEAN` first. NOTE: GitHub's repo *default* branch is `main`, so always pass `--base dev` explicitly when opening a feat→dev PR.
- **Merged `feat/*` branches are KEPT, not deleted** — every historical feature branch (local + origin) survives post-merge. Default to keeping unless the user says otherwise.
- **`gh pr view --json merged` is INVALID in this gh version** — use `state` (=="MERGED"), `mergedAt`, `mergedBy`, `mergeCommit.oid`. A bad --json field exits 1 and silently skips any `&&`-chained git commands after it; run gh JSON queries standalone.
- **Observed FF pattern:** `feat/*` branches are typically cut from the dev tip and dev doesn't move, so the merge is conflict-free. Convention is still a PR merge-commit, not a `branch -f` fast-forward. Verify cleanliness with `git merge-base --is-ancestor origin/dev HEAD` (exit 0 = clean) before merging.
- **Routing:** Next.js App Router with route groups: `app/(app)/` pattern
- **Note:** branch-naming has shifted from `feat/<UI|backend>/<name>` (early) to flat `feat/<kebab-name>` (recent, e.g. feat/blackwood-table-universal-grid)

## Workflow Conventions
- [Commit splitting under `git add .`](feedback_commit_splitting.md) — how to split one staged changeset into multiple logical commits without per-file/hunk staging (stage whole tree, then `git commit -- <pathspec>` per group). Includes the exact Co-Authored-By trailer requirement.
- **`.claude/agent-memory-local/` is GITIGNORED but has legacy-tracked files in it.** `git check-ignore` on the tracked *file* reports "not ignored" (tracked paths bypass the check), but `git add` on the *directory* refuses it. Never include `agent-memory-local/*` in a shared commit — the `-local` + gitignore intent = machine-local only. Stage paths explicitly; don't `git add .` it in.
- **Multi-concern split, buildable-commit rule:** when one file mixes two concerns (e.g. `rc-out/actions.ts` had price-gating + dead-code removal in adjacent hunks), keep the FILE whole in its dominant-concern commit rather than splitting hunks — hunk-splitting risks non-buildable intermediate commits. Split by file-grouping, reserving separate commits for cleanly-separable file-level changes (e.g. whole-file deletions). Note unavoidable WIP bleed in the commit body.

## Recent Issue Investigation (2026-02-13)
**Issue:** Route `/inventory/rc-in` broken after merge from `feat/UI/NavigationBar-extraDropdown`

**Root Cause:** NOT A GIT ISSUE - file renames were properly merged
- Commit 78104ed properly carried through all renames (R096-R100 = 96-100% similarity renames)
- Old files: `app/(app)/rc-in/**` → New files: `app/(app)/inventory/rc-in/**`
- All 14 files successfully renamed and present in current checkout
- Navbar config (`components/navbar.tsx` lines 35-39) correctly references `/inventory/rc-in`
- Dashboard (`app/(app)/page.tsx` line 18) correctly links to `/inventory/rc-in`
- Page component exists at correct path: `app/(app)/inventory/rc-in/page.tsx`

**Resolution:** Next.js build cache issue
- Removed `.next` directory to clear build cache
- Files verified present and git-clean
- Route should work after next `npm run dev` or rebuild

## Workflow Assessment (2026-02-14)

### Current State Summary
- **17 local branches** (including 1 local-only `feat/userContext` without tracking branch)
- **28 remote branches** including stale/abandoned feature branches
- **Main-to-Dev Gap:** Main is 65 commits behind dev (dev has absorbed all development)
- **Dev-to-HEAD Gap:** dev is 2 commits behind current HEAD (feat/UI/rcOut-table)
- **Unmerged Feature Branches:** 8+ feature branches not yet merged to dev or main
- **Dead Code:** At least 5 branches appear stale/abandoned (no commits in weeks)

### Branch Graveyard (Cleanup Needed)
- `feat/rc-in-inputs` — behind by 5 commits (orphaned)
- `feat/userContext` — local only, no remote tracking
- `revert-1-feat/rc-in-inputs` — leftover revert branch
- `feat/userContext-oAuth` — functionality likely merged elsewhere
- `origin/feat/rc-in-excel-grid` — remote only, no local tracking
- Several early navBar branches merged but never cleaned up

### Key Git Patterns Used
1. **Merge strategy:** GitHub PR merge commits (non-FF) via PRs
2. **Commit message style:** Good — Conventional commits with feat/fix/refactor
3. **Branch naming:** `feat/<UI|backend>/<feature-name>` pattern (consistent)
4. **Integration Branch:** `dev` acts as staging (unused main branch)

## Development Notes
- Project uses Supabase with PostgreSQL
- All mutations via Server Actions with `revalidatePath()`
- Route group structure: `(app)` groups protected routes
- Inventory module location: `app/(app)/inventory/`
- Working tree is always clean — excellent hygiene
