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

## Key Git Patterns Used
1. **Merge strategy:** Simple FF-enabled merges for feature branches
2. **Commit message style:** Conventional commits with feat/fix/refactor prefixes
3. **Branch naming:** `feat/UI/*` for UI features
4. **Merge commit naming:** "Merge pull request #N from..." (GitHub auto-generated)

## Development Notes
- Project uses Supabase with PostgreSQL
- All mutations via Server Actions with `revalidatePath()`
- Route group structure: `(app)` groups protected routes
- Inventory module location: `app/(app)/inventory/` (recently reorganized from flat structure)
