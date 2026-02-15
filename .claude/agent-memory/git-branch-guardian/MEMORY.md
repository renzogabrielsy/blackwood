# Git Branch Guardian Memory - Blackwood Project

## Project Context
- **Repository:** Blackwood (industrial charcoal inventory management system)
- **Main Branch:** `main` (production)
- **Active Development:** `feat/UI/NavigationBar` branch
- **Recent Merge:** `feat/UI/NavigationBar-extraDropdown` into `feat/UI/NavigationBar` (Commit 78104ed)
- **Routing:** Next.js App Router with route groups: `app/(app)/` pattern

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
