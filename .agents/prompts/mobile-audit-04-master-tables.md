# Mobile Audit 04 — Master Tables, READ layer (`/inventory` — RC IN + RC OUT tabs)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — goal, device matrix, verdicts, pattern catalog, result template. Note archetype C: the pattern you pick HERE becomes the reference for every dense table in the app (production tables, schedule, summaries tables follow it).
2. `app/(app)/inventory/CONTEXT.md` — the tab shell + route map (short).
3. `app/(app)/inventory/rc-in/CONTEXT.md` — read the Files table + Key Behaviors for `delivery-master-table.tsx` ONLY. **Skip** everything about `bulk-delivery-input.tsx`, server actions, and audit machinery — the EDIT layer is desktop-only by decree.
4. `app/(app)/inventory/rc-out/CONTEXT.md` — same discipline: the table + closed-blocks toggle only.

**Do the work YOURSELF — no delegation.**

## Mission
Decide the **canonical mobile pattern for the Industrial Spreadsheet read layer**. RC IN is the reference implementation (~20 columns: date, supplier, batch, loc, truck, sacks, weight, 7 lab cols, ₱/kg, ₱ total, remarks; virtual scroll; header filters; density modes). The verdict here is reused by Audits 05, 08, 09 — so go deeper than usual and make the recommendation genuinely reusable.

## Mobile scope reminder (locked)
READ + navigate + search + filter only. No bulk input, no inline editing, no cell selection, no context menus, no delete. Those must simply not break the phone experience (hover-only / right-click affordances should be inert, not obstructive).

## What to verify (live)
1. `/inventory` at 375×812: what happens to the delivery master table today? (Expected: brutal horizontal squeeze or overflow.) Characterize precisely — does the page itself scroll horizontally (HARD-RULE violation) or does the table own it?
2. The **tab shell** (Deliveries · Usage bottom tab bar) at phone width.
3. Toolbar at 375px: search, filters, density toggle, columns, settings, Add, refresh — which survive, which must hide on mobile?
4. Column header filter popovers (STATE/Supplier/LOC) by touch.
5. Virtual scroll behavior in a touch context (momentum scroll, sticky header).
6. RC OUT tab: same checks + the Closed Blocks summary toggle.
7. iPad mini 744 portrait + 1133 landscape: the full table might be near-viable there — measure how many columns fit legibly.
8. **Pattern candidates** to weigh for the phone (name ONE winner):
   - **(a) Card list:** one card per row showing the ~6 load-bearing fields (date, supplier, batch, weight, loc, state), tap → full-row detail sheet. Precedent: `SchedulePreviewMobile`.
   - **(b) Column-diet table:** same `<table>`, a mobile column subset (5-6 cols) with a per-row expander.
   - **(c) Frozen-first-column + horizontal scroll:** keep all columns, pin identity, embrace scroll.
   Weigh against: search/filter continuity, virtual-scroll compatibility (TanStack), price gating, and the fact the same pattern must serve production/electricity/trucks/summaries tables.

## Constraints
- **Audit only.** Append result to `docs/MOBILE_UI_AUDIT.md`, tick P4. No other code changes.
- Do NOT audit bulk input, edit dialogs, or the audit-history dialogs beyond "do they accidentally open/obstruct on touch."
- Dev server + browser resize; ask Renzo to log in once if needed.

## Deliverable
Standard template section + screenshots (375 both tabs, 744, 1133). Because this sets archetype C, ALSO write a short "**Archetype C pattern spec**" (≤10 lines) under your result: the chosen pattern, its column-selection rule, and what the other table audits should reuse vs re-decide. Reply with verdicts + the spec + effort.
