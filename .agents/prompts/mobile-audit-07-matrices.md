# Mobile Audit 07 — Frozen-Pane Matrices, READ (`/inventory/rc-movement`, `/inventory/flecon-bags`)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — goal, device matrix, verdicts, template. This is archetype E — the hardest shrink in the app; it was deliberately scheduled late so archetypes C (tables) and F (blocking) inform it.
2. `app/(app)/inventory/rc-movement/CONTEXT.md` — the matrix shape (5 frozen left columns, PRODUCED group, per-batch block columns, frozen footer). Skip the SQL view details.
3. `app/(app)/inventory/flecon-bags/CONTEXT.md` — the bag matrix (2 frozen cols + 14 bag columns, month separators, balance footer).

**Do the work YOURSELF — no delegation.**

## Mission
Two cross-tab matrices whose whole value is *2-D shape* (days × blocks, days × bag types) — the one data form that fundamentally resists a 375px portrait screen. Decide honestly per device: it is a legitimate outcome for the iPhone verdict to be 🔧 "summary view + landscape/iPad for the full matrix" or even 🖥 for the full matrix, IF the phone user still gets the load-bearing numbers another way. Identify what those load-bearing numbers are.

## Feature facts
- **RC Movement:** campaign picker (`?campaign=`), 5 frozen left cols (Row#/Date/Day/Fed ₱-kg/Total fed — the ₱ col drops entirely for price-denied roles, offsets recompute), then PRODUCED group + N block columns; frozen header AND footer; block headers tap → the shared blocking detail panel (already `w-full` on phones). Campaign totals live in the footer + toolbar (fed, produced, yield %, loss).
- **Flecon bags:** fill-width + `minWidth` horizontal scroll already (RC Movement mechanism); auto-scrolls to LATEST movements on mount; Current Balance footer = the number operators actually check; header nicknames are click-to-edit (an EDIT affordance — desktop-only; must not trap touch scroll).

## What to verify (live)
1. Both matrices at 375×812: does the frozen-pane horizontal scroll *work by touch* (momentum, no page-scroll fights, frozen cells staying opaque — watch for seams/bleed per the Frozen Panes rules)? A working-but-tedious scroll is different from broken — say which.
2. iPad mini 744 portrait + 1133 landscape: how much of each matrix fits? Landscape iPad may be genuinely fine — verify and say so.
3. RC Movement toolbar (campaign eyebrow + Select) at phone width.
4. Column-header tap → detail panel flow on touch (RC Movement).
5. Flecon: does the mount auto-scroll-to-bottom behave at phone size? Is the balance FOOTER visible without scrolling gymnastics?
6. **Phone-summary candidates** (pick per matrix): RC Movement → campaign KPI strip (fed/produced/yield/loss) + per-day stacked list, full matrix behind a "view matrix" affordance or landscape; Flecon → current-balance card list (14 types) + recent-movements feed, matrix on iPad. Judge against what operators actually check.

## Constraints
- **Audit only.** ONE combined result section (sub-verdicts per matrix) to `docs/MOBILE_UI_AUDIT.md`, tick P7.
- Nickname editing: out of scope beyond "doesn't hijack touch."
- Dev server + browser resize; ask Renzo to log in once if needed.

## Deliverable
Standard template section + screenshots of both matrices at 375 and 1133, reply with per-matrix per-device verdicts, the phone-summary recommendation, effort.
