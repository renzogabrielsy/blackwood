# Mobile Audit 02 — Home Digest (`/`)

**Read first, in this order (nothing else yet):**
1. `docs/MOBILE_UI_AUDIT.md` — goal, device matrix, verdicts, pattern catalog, result template.
2. `app/(app)/CONTEXT.md` — band-by-band architecture + render order. Skim the band list; skip the SQL/adapter details.
3. `components/digest/CONTEXT.md` — only if a specific band needs deeper inspection.

**Do the work YOURSELF — no delegation.**

## Mission
The digest is the page a phone user opens every morning. It was made mobile-responsive on 2026-07-15 (tap-to-expand widgets, `SchedulePreviewMobile` stacked list + bottom sheet, single-column stacking) — so this audit is **verify + find the residue**, not redesign. Expect ✅ with a short punch list.

## Band checklist (top → bottom, from page.tsx render order)
Walk EVERY band at 375×812, then spot-check 744×1133 + landscape + dark mode:
1. **DigestHeader + SyncLauncher** header row — flex row crushing? (launcher itself is Audit 01's problem; here just layout)
2. **PlantStatusHeader** — status bar wrapping?
3. **WeekStrip** — 7 day-cards at phone width?
4. **Snapshot row** (SchedulePreview TABLE beside OpenBlocks, `lg:grid-cols-2`) — must stack; verify the mobile SchedulePreviewMobile takes over below `sm` and its bottom sheet works by touch. NOTE: rows in the schedule table were just fixed to uniform `h-[44px]` — verify on mobile too.
5. **KpiHero** — stat-card grid reflow; sparklines at narrow width; StateCards.
6. **DigestCharts** — two chart sub-rows; Recharts responsiveness at 343px content width; the price chart is ABSENT for price-denied roles — check the flow chart spans correctly both ways; tooltips on touch.
7. **TrucksSummary**, **BagInventory** — table-ish bands; internal scroll not page scroll.
8. **SyncSummary + ActivityFeed** — feed readability.
9. **DigestFooterBand** — flags + MTD grid.

## Specific things to hunt
- Any page-level horizontal scroll at 375px (HARD RULE: none allowed).
- Hover-only affordances (tooltips carrying real info — e.g. lab stats, freshness details) that have no touch path.
- Tap targets under ~40px.
- The `errorToast()` presentation at phone width (trigger one if you can, e.g. offline reload).
- Text truncation that hides load-bearing numbers.

## Constraints
- **Audit only.** No code changes except appending your result to `docs/MOBILE_UI_AUDIT.md` + ticking P2.
- Don't re-audit the Run Sync modal (Audit 01).
- Use dev server + browser resize per the device matrix; if the pane isn't authenticated, ask Renzo to log in once.

## Deliverable
Append the standard template section (screenshots for anything broken), reply with verdicts + punch list + effort.
