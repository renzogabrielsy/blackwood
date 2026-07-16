# Mobile Audit 05 — Production module, READ layer (`/production` + `/production/schedule`)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — including the **Archetype C pattern spec** appended by Audit 04 (if Audit 04 hasn't run yet, STOP and tell Renzo — this audit depends on it).
2. `app/(app)/production/CONTEXT.md` — module shell, 3 tabs, the schedule page entry in the Files table. Skip the Grid Architecture editing details (desktop-only by decree).

**Do the work YOURSELF — no delegation.**

## Mission
Apply the Archetype C decision to the production surfaces and find what's specific here. Four surfaces:
1. **Daily tab** — ONE unified inline-editable ledger, `minWidth: 1800px`, sectioned columns (Identity/Production/Downtime/Waste).
2. **Electricity tab** — single grid (readings, computed diff, price-gated RATE/TTL PHP).
3. **Trucks tab** — single grid (odometer + fuel).
4. **`/production/schedule`** — month plan-vs-actual table (Date/Day/Setup/Grades/Shifts/Proj/Act/Act hrs/Var/Status/Source/Remarks), `?month=` nav, frozen header + footer. NOTE: its digest sibling already has a mobile pattern (`SchedulePreviewMobile`) — strong candidate to generalize.

## Feature facts
- All three tab grids are **editors** (dirty tracking, keyboard nav, paste) — on mobile they are READ views; editing affordances must degrade silently. The `minWidth: 1800px` daily ledger is the extreme stress case for archetype C.
- Universal `PeriodPicker` (Year + Batch selects) + bottom tab bar (Daily · Electricity · Trucks) — both must work by touch at 375px.
- Schedule page is a Server Component with `<Link>` month nav — should be naturally mobile-friendlier; verify the frozen header/footer at phone width.

## What to verify (live)
1. Each tab at 375×812 + 744 + landscape + dark: page-level horizontal scroll (forbidden) vs internal; sticky/frozen surfaces bleeding (frozen = opaque rule).
2. Does the archetype C pattern from Audit 04 map cleanly onto the daily ledger's SECTIONED columns (a card would need section grouping)? Note deltas, don't redesign from scratch.
3. Period picker + tab bar by touch.
4. `/production/schedule` at all three viewports; month prev/next links tappable; status/source chips legible; compare with `SchedulePreviewMobile` and say whether that component should be generalized for the full-month page.
5. Electricity: price-gated columns — confirm no awkward empty columns for a price-denied role if you can impersonate (Dev role switcher in navbar).

## Constraints
- **Audit only.** Append ONE combined result section (sub-verdicts per surface) to `docs/MOBILE_UI_AUDIT.md`, tick P5.
- Editing flows: out of scope beyond "doesn't break touch reading."
- Dev server + browser resize; ask Renzo to log in once if needed.

## Deliverable
Standard template section (one, with a 4-row sub-verdict table), screenshots of the daily ledger + schedule at 375px, reply with verdicts + deltas-from-archetype-C + effort.
