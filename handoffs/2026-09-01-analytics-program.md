# 2026-09-01 — The owner analytics program (plan → 4 phases → feedback round 1) + L-046

> One day, two arcs. Morning: the waste tab-batch sync fix (L-046) + repair. Then Renzo's
> planning brief — *"the dashboard [as] the gateway to access more in depth tools for
> analysis… a custom Dashboard FOR ME. For MY brain."* — ran plan → professional-analyst
> audit → Phases 1-4 → owner feedback round 1, all shipped same-day.

## TL;DR
`/analytics` exists and is live: a KPI × period monthly matrix (M/Q/Y weighted rollups,
MoM primary + YoY/absolute chip toggle, magnitude-only callouts, metric dictionary,
per-metric print-to-PDF, in-place expands, section colors, big type), a campaign (batch-
basis) cost panel, the supplier room (volume matrix, weighted-only premium panel,
price×volume×participation explorer), and the production matrix (output, downtime, power
intensity, grade mix). Everything reads from 10 new all-history monthly/as-of views built
on the ONE-definition sources, every tie proven to 0.00, all ₱ server-gated. Plan +
decisions: `.agents/plans/ictc-analytics-dashboard-plan.md`.

## Shipped (chronological, all merged to main + Vercel; worker v23 on Fly)
1. **L-046** (`d30d2e2` + Fly v23): waste rows take their batch from the TAB, not the
   date's month; the stranded 08-29 SEPTEMBER waste row repaired with audit (shift
   `95083fed`, waste `bdb5c337`).
2. **Plan** (`06d0c57`, audited `083542c`): decisions — /analytics page; BOTH month bases;
   all 4 snapshot families; sundry re-entries are a delivery CLASS not a spelling; no
   threshold coloring yet; callouts by magnitude; YoY chips; working-day toggle.
3. **P1** (`018adbf`): `fn_delivery_class` (market 98.0% of kg / sundry 1.8% / recook
   0.15%) + 3 monthly views (market population byte-identical to
   view_delivery_monthly_analytics 49/49 months; eom reconstruction == live to 0.00 kg)
   + the matrix page. Found: April 2026 market price was ₱46.84 not ₱44.58 (sundry drag);
   supplier participation is the price↔volume mechanism (13-14 real sellers @₱47-48 vs 4
   @₱38).
4. **P2** (`633a74c`): money layer — cost/batch-cost/aging views + campaign panel.
   Found: 7 months with fed-price coverage holes (2026-08 honest cost ₱53.07 not ₱51.65);
   watchlist had to include STORED (10.4M kg); closed-residue excluded from aging (386.5d
   vs 415.7d); CLAUDE.md's JULY figures were stale (19th block closed since).
5. **P3** (`f0976a3`): supplier room. Found: Ornales 45.5% of YTD kg (not ~40%), top-3
   85.1%; premium spread ₱7.14 in 2026-03; premium may ONLY be averaged weighted (one
   function enforces it); sundry origins resolve 91/91 to 11 real sellers; fixed a P1/P2 ₱
   leak (worked peso examples in dictionary caveats shown to restricted roles).
6. **P4** (`08212db`): production matrix. Found: ONE mis-keyed meter reading (2026-03-01
   MAIN start=0) fabricates 676,944 kWh — flagged structurally, NOT repaired (task chip
   filed, Renzo to rule); August 2026's 23 downtime shifts are reason-only zero-hour
   (annotated, never a bare 0.00); power intensity trends 0.0524 → 0.0276 kWh/kg across
   2026; two latent P1 callout/rollup bugs fixed (movers gate, half-gated weighted sums).
7. **Owner feedback round 1** (`0cb244f`): rows cut (sundry, runway, active batches,
   working days — active suppliers kept); **Ending inventory = OPEN-PILES basis**
   (10,493.3t, ties to Blocking 10,474.7t within the single 18.65t L-042 phantom; resiko
   residue 1,214.6t and the 8,492.5t net now disclosures in the expand); expand-in-place
   under the clicked row; per-metric Print (print stylesheet → browser PDF); type scale up
   (values 14px, rows 62px, widths re-measured); section accent colors + direction tints
   (aesthetic only — no-threshold rule intact); MoM-primary + YoY/Δ-actual chip toggle
   (`?cmp=`); dictionary copy cut to 1-2 plain sentences; "Delivered ₱/kg fed" → **"Block
   price"** (metric key unchanged so deep links hold); aging watchlist removed.

## Open items / next actions
- **Renzo's next test round** — feedback round 2 expected.
- **The March 2026 meter reading** (task chip): repair or leave; until ruled, Power
  intensity for that month reads NULL + excl-suspect 0.0219.
- **Backend handoff filed** (end of `app/(app)/analytics/CONTEXT.md`): `open_value_php`
  on the eom view so Inventory value can move to the open-piles basis (currently wider
  basis, disclosed: closed residue is ₱34.75M of ₱424.3M = 8.19%).
- **Aug-12 "FEED" remark** panel click still pending (delivery_human_edited re-fires).
- Phase-2+ ideas parked in the plan: quality-adjusted buying, weekly volatility band,
  target-based coloring when Renzo states targets, PC inventory matrix post-stocktake.

## Gates at final ship
tsc clean · lint 146/16 (baseline) · build clean · verify-table-core 84 ·
verify-worker-view-grants 4/0 · e2e 57 · worker (from the L-046 ship) 848/848 + parity
clean w/ documented L-046 deviation.
