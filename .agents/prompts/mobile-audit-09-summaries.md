# Mobile Audit 09 — Summaries Analytics (`/summaries`)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — including the Archetype C spec (Audit 04); the tables here follow it.
2. `app/(app)/summaries/CONTEXT.md` — Purpose + Files + the "By Supplier view" behaviors. Skip the canonical_supplier SQL archaeology.

**Do the work YOURSELF — no delegation.**

## Mission
The price & volume analysis surface — two views behind a `?view=period|supplier` toggle. Charts are the star here (multi-year overlay: price line + volume area; supplier overlays); tables are RC IN-format with Excel cell-selection (read-only concern on mobile). This is a "check on the go" surface, not a workbench — a phone user wants the chart + KPI strip; deep table work stays desktop.

## Surfaces & facts
- **By Period:** multi-year overlay graph (each year a color), KPI strip, monthly table (rows = months).
- **By Supplier:** year dropdown, granularity toggle (Months|Quarters) + period multi-select, top-3-supplier overlay default, supplier table, per-supplier slide-out panel (subgroup breakdown).
- Price gating: ₱ columns/KPIs vanish for price-denied roles — verify layouts don't leave holes at phone width in both states if impersonation is available.

## What to verify (live)
1. Both views × device matrix × dark mode.
2. **Charts at 343px content width:** Recharts overlay legibility — multi-year lines + legend + touch tooltips. Is the legend usable? Do tooltips work on tap (not hover)?
3. KPI strips reflow.
4. View toggle, year dropdown, granularity toggle, period multi-select — all by touch at 375px.
5. Tables: apply Archetype C; note deltas only.
6. Supplier slide-out panel at phone width (compare with the blocking panel's `w-full sm:w-[520px]` precedent — does this one follow it?).
7. Cell-selection machinery on the tables — must not hijack touch scrolling.

## Constraints
- **Audit only.** ONE result section (sub-verdicts: period view / supplier view / panel) to `docs/MOBILE_UI_AUDIT.md`, tick P9.
- Don't redesign the charts — verdict + named adjustments (e.g. "legend below chart on mobile", "default to fewer overlaid years at <sm") is enough.
- Dev server + browser resize; ask Renzo to log in once if needed.

## Deliverable
Standard template section + screenshots of both charts at 375, reply with verdicts + chart adjustments list + effort.
