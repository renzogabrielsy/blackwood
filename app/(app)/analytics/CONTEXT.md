# Analytics Module — ICTC Owner KPI Matrix (`/analytics`)

> **OWNER FEEDBACK ROUND 1 APPLIED — 2026-09-01.** Renzo read the live page and gave a
> ten-item list. Everything below already reflects it; the round's own summary is the
> section **"Owner feedback round 1"** near the end of this file, which is the place to
> look for *what changed and why* rather than *what the page is*.
>
> **OWNER FEEDBACK ROUND 2 APPLIED — 2026-09-02.** One feature: **the period filter** —
> a checklist on the matrix columns and a second one on each row expand's history chart.
> See **"Owner feedback round 2 — the period filter"** near the end of this file.
>
> **OWNER FEEDBACK ROUND 4 APPLIED — 2026-09-02. ⚠ THIS ROUND RESTRUCTURED THE PAGE.**
> The **Money section is dissolved** and the matrix is now TWO bands, `RC Inventory`
> and `Production`, across **eighteen** rows rather than twenty-two. Several statements
> further down this file describe the five-anchor, three-band page that existed before
> it; **the section "Owner feedback round 4 — the restructure" at the end is the
> authority** wherever they disagree, and each superseded passage carries a pointer to
> it. Read that section before trusting a row list or an anchor list above.
>
> **DATA CORRECTION — "FED" NOW EXCLUDES SUNDRY PULLS, 2026-09-02 (migration
> `20260902071050_fed_excludes_sundry_destination`). ⚠ NO UI CODE CHANGED, BUT THE
> NUMBERS ON THIS PAGE MOVED.** `rc_out.destination` is `MAIN` (fed into the plant tank)
> or `SUNDRY` (pulled out to be sun-dried and returned later as a sundry re-entry
> delivery). Every "fed" view summed both, so **JANUARY 2026 read 1,048,908 kg of
> Charcoal fed against a true 836,328 kg**, and its campaign yield read **65.56% where it
> is really 82.23%**. Fixed in SQL only: `view_analytics_cost_monthly` and
> `view_analytics_batch_cost` (and the RC-Movement views they read) now ride the FED clock,
> **coverage denominators included**. Four calendar months (2026-01 … 2026-04) and three
> campaigns (JANUARY / MARCH / APRIL 2026) changed; the deltas sum to exactly the
> 552,629 kg of SUNDRY outflow. **Unchanged on purpose:** every kg on the `RC Inventory`
> band — `in_kg` / `out_kg` / `working_days` / `runway_days` / month-end stock / aging /
> the watchlist — because those are BALANCE and yard-flow figures and a sundry pull really
> did leave the pile. Two shapes to know when reading the page: `php_per_produced_kg_true`
> is now **NULL for JANUARY 2026** (it drew from one block with sundry outflow, whose true
> fed price is unknowable — `blocks_in_price` reads 28 of 29), and `blocks_fed` fell for
> JAN/MAR/APR because blocks a campaign only *sun-dried* from are no longer counted as fed.
> Every figure quoted elsewhere in this file for those four months is **pre-correction**.
>
> **OWNER FEEDBACK ROUND 5 APPLIED — 2026-09-02. ⚠ THIS ROUND RE-ORDERED THE PAGE
> AND REMOVED TWO SURFACES.** The **callout strip is unmounted**, the supplier
> premium and supplier matrix **footnote paragraphs are gone**, **Production now sits
> ABOVE Suppliers**, the campaign panel has its **own batch checklist** which
> **drives the production band's months**, every matrix row carries a **drag handle**,
> every group carries a **Print** action, and the grade rows **expand**. The section
> **"Owner feedback round 5"** at the end is the authority wherever anything above
> disagrees with it.

## Purpose
The **month-on-month room**. `/` (the Home Digest) answers *"what happened today"*; this
answers *"what has been happening"* — twenty-two KPI rows × period columns, with a Y/Q/M
toggle, a per-working-day normalisation, a comparison-chip control, a metric dictionary at
the point of use, an auto-generated callout strip and a per-row trend expand that opens
IN PLACE — plus, below the matrix, the **campaign-basis money panel**, the **supplier
room** and the **production room**.

The page makes **four cuts through the same yard, in this order: PERIOD → CAMPAIGN →
SUPPLIER → PRODUCTION.** Each block re-keys the same kilos, and the order is the
reason none of them is a tab: a reader who has just watched the Purchase volume row move
wants to know WHO moved it, and a tab would hide exactly that. Production comes last
because it is where the yard's kilos stop being charcoal and start being product — after
the blocks that are about buying and holding it.

**A slim sticky anchor row** (`analytics-nav.tsx`) sits above the controls: **RC Inventory ·
Campaigns · Suppliers · Production** (four since R4 dissolved the Money band).

Renzo, 2026-09-01: *"a tool where I can monitor daily the KPIs we want to observe month on
month… This is a custom Dashboard FOR ME. For MY brain."* Plan:
`.agents/plans/ictc-analytics-dashboard-plan.md` (§4 — **P1, the matrix**; **P2, the money
layer**; **P3, the supplier room**; **P4, the production matrix — the page is complete**).

> **Domain module (charcoal tenant).** It reads seven charcoal-shaped SQL views. Nothing
> in `components/shared/` or `components/ui/` learns anything from it. The ONE platform
> file it touches is `components/digest/drilldown/drilldown-modal.tsx`, and only to widen
> `footerLink` from an object to "object or array" so a digest tile can offer a second
> destination.

## Files

| File | Role |
|------|------|
| `page.tsx` | **Server Component.** Awaits `getAnalyticsData()`, resolves the OPENING view from `searchParams` (`year` · `g` · `wd` · `cmp` · `hide` · `dict` · `metric`), owns the shell class (`bw-analytics` + the 1920px container relax — R3) and hands both to the client shell. Owns nothing else — no heading (the navbar owns the title), no aggregation, no gate of its own beyond the adapter's. Fetch inside `try/catch`, render outside it. |
| `analytics-view.tsx` | **Client shell.** Owns the view controls (year `Select`, Y/Q/M toggle, **Compare chip toggle**, per-working-day `Switch`, the R2 `Columns` checklist and the **R3 master `Definitions` switch**), the anchor row, the live block-utilization chip, the callout strip, the matrix, **the campaign panel, the supplier room, the production room** and the restatement footer. Calls `buildMatrix()` in a `useMemo`. It renders `AnalyticsMatrix` for the `flow` + `money` bands only, and passes the expand panel INTO it; the `production` band is rendered by `production-room.tsx` from the SAME fold. |
| `analytics-matrix.tsx` | **The matrix table** — a bespoke dense table (see "Why not the Blackwood Table"). Frozen KPI-name column, explicit `<colgroup>` widths, `width: max-content` inside `overflow-x-auto`, a trailing summary column, **section bands** (anchor targets, `id="band-<key>"`, wearing the section accent as a left border), an optional `sections` filter so the component can be mounted twice, the `~` / `·` / `⚠` cell marks, the green/red direction tint, and **the in-place expand row** (`colSpan` over every column, panel `sticky left-0` at the scroller's measured width). |
| `analytics-nav.tsx` | **The in-page anchor row.** Sticky (`top-0 z-40`), glass, **five** links, active section observed with an `IntersectionObserver` and claimed instantly on click. A flow element, so pinning it shifts nothing. |
| `print-card.ts` | **R4 — the print mechanism, extracted.** `printCard(el)` tags every ancestor `data-print-ancestor`, adds `bw-printing` to `<body>` and calls `window.print()`, clearing both on `afterprint` with a 1 s fallback. It lived inside `metric-expand.tsx` until the supplier expand needed it too; two copies of something this fiddly would drift the first time one was touched. A plain module, not `"use client"` — it is imported only by client components and touches the DOM at CALL time. **R5: it also MARKS the card itself** when the element does not already carry `data-print-card`, and unmarks it in `clear()` — the group-print stage and the campaign panel are printable without being permanently marked, which they must not be (the sheet hides everything that is not `[data-print-card]`, so a second permanent mark would put the campaign table on every printed metric sheet). |
| `group-print.tsx` | **R5 — print a whole metric GROUP.** `GroupPrintStage` renders the group's cards in a real, laid-out 1040 px column parked inside a zero-sized clipped box, waits 400 ms for `ResponsiveContainer` to measure, calls `printCard` on it, and unmounts on `afterprint` (2 s fallback). `GroupPrintPage` wraps one card and carries the page break. **The offstage-with-layout trick is load-bearing and was measured**: `display: none` gives no box, recharts measures its parent's box, and a print media query does not apply until the dialog is already open — a `hidden print:block` sheet prints empty chart frames. |
| `row-handle.tsx` | **R5 — the drag grip and the `<tr>` drop props.** HTML5 drag-and-drop (the platform already solves auto-scroll and hit testing inside a sticky-column `overflow-x-auto` table), payload `text/plain` = the row key, plus ArrowUp / ArrowDown on the focused handle through the SAME `move()` the pointer path ends in. The handle is `opacity-0 group-hover:opacity-100` and stays in layout, so nothing reflows when it appears. |
| `use-row-order.ts` | **R5 — the reader's own row order for one group.** `localStorage`, keyed `bw.analytics.roworder.v1.<scope>`, read in an EFFECT (never a lazy initialiser — the server renders the registry order, so reading storage during render is a hydration mismatch). Every read and write is wrapped: a private window or blocked site data means "no saved order", which is the default. |
| `grade-expand.tsx` | **R5 — one grade's year.** The grade mix's row expand, carrying the full R4 universal module contract: a month checklist with the smart default (opens on the months that grade was actually run), a stat strip that re-folds from it, an average switch, Print and the master `Definitions` switch. Bars = tonnes on a zero-floored axis, dashed line = share of the month on its OWN axis fixed 0–100. No ₱ exists in it and none is derivable. |
| `metric-expand.tsx` | **The row expand** (+ R3: `canDrawAvg` and the `AvgToggle` beside `Years`, and the dictionary blocks behind the page's `Definitions` switch), rendered IN PLACE inside the matrix, in a full-width row directly beneath the row that was clicked. Stat strip + full-history chart (bar or line, **plus the dashed comparison line where a row declares a pair**) + one of six side rails (inventory split · price coverage · closed blocks · aging bands · downtime · power) + the dictionary spelled out + **a Print button** that prints just this card. Reuses `DrilldownSection` / `DrilldownStat` / `BreakdownRail` / `DRILLDOWN_AXIS_TICK` / `drilldownTooltipChrome` from the drill-down chassis. |
| `metric-info.tsx` | **The dictionary** at the point of use — an `Info` button with the whole entry as a native `title` (hover) and a `Popover` card (click). `DictionaryPopover` is the ONE card and takes any `MetricDictionaryEntry`; `MetricInfo` is the matrix row's wrapper over it (`METRICS[].dictionary`) and the supplier room passes `SUPPLIER_DICTIONARY` entries into the same component, so a metric and a supplier figure can never explain themselves in two layouts. |
| `batch-cost-panel.tsx` | **P2 — the BATCH basis.** One column per production campaign, nine rows (fed · delivered ₱/kg · true ₱/kg · **cost of storage time** · weight lost · produced · yield · ₱/produced kg on both bases) plus a `blocks closed / priced` coverage line. Frozen row-label column, opens scrolled to the newest campaign. |
| `aging-watchlist.tsx` | **UNMOUNTED (owner feedback R1).** Nothing imports it and the adapter no longer reads its view. Kept, compiling, against the `AgingWatchItem` / `AgingWatchlist` types so the block is one read and one JSX element away if it is ever wanted back. |
| `supplier-room.tsx` | **P3 — the SUPPLIER axis.** The section shell: the concentration header (top-1 / top-3 / seller count / suppliers-to-half), the dictionary strip, and the four blocks below. Follows the page's YEAR picker; deliberately NOT the Y/Q/M toggle. |
| `supplier-matrix.tsx` | **P3 — supplier × month volume.** Frozen supplier column, tonnes + share-of-month per cell, ↩ returns chips, a YTD column, a `Σ market` footer row that prints P1's own figure, `Show all N` over a top-12 default, and the **in-place expand row** (same mechanism as the KPI matrix). |
| `supplier-premium.tsx` | **P3 — the ₱ read (gated).** Weighted ₱/kg paid, weighted premium vs market, priced kg, and a diverging bar per supplier. Footer prints the WEIGHTED rollup (₱0.00 by construction). |
| `supplier-explorer.tsx` | **P3 — the three-line story.** Price × volume × active-supplier count for the year, from `AnalyticsMonth` (P1's own view) — no new read. |
| `supplier-expand.tsx` | **P3 — one supplier's year.** Five stats, a bars + premium-line chart, a month-by-month share rail, and the returns note. |
| `production-room.tsx` | **P4 — the PRODUCTION axis.** The section shell: the year chips (made · top grade · reported days · power), the dictionary strip, the production band of the shared matrix, its expand, and the grade mix. No ₱ anywhere, so nothing in it is gated. |
| `production-grades.tsx` | **P4 — grade × month tonnage.** Frozen grade column, tonnes + share-of-month per cell, a YTD column, and a `Σ made` footer row that prints the Production output row's own figure — with the tie CHECKED, not assumed. |
| `period-filter.tsx` | **R2 — THE checklist popover, written once, mounted twice.** The matrix's period columns and a row expand's chart years. Trigger + `All` / `None` + a dense scrollable list of `role="checkbox"` buttons; Radix Popover gives Esc and focus-return for free. Its state is the set of **hidden** keys, never the selected ones. **R4 changed what that set STARTS as, and only on the chart filters:** a matrix COLUMN filter still opens with everything checked (its periods come from the complete flow spine, so "all" and "the ones with data" are the same set), while an EXPAND's filter opens on the periods that actually carry a figure for that row. The hidden-set shape is what made both defaults expressible without a second mechanism. |
| `analytics-error.tsx` | Persistent, copyable load-failure banner (the project's HARD RULE applies to every error surface, not only toasts). |

### The shared library (`lib/analytics/`)

| File | Role |
|------|------|
| `types.ts` | The contract — `AnalyticsMonth`, `CampaignCost`, `BlockUtilization`, `SupplierMonth`, `SupplierData`, `ProductionGradeMonth`, `ProductionGradeData`, `AnalyticsData`. (`AgingWatchItem` / `AgingWatchlist` are still declared but no longer on `AnalyticsData` — see the unmounted watchlist above.) Portable (no React, no Supabase, no `server-only`). **`null` is never 0 in this shape**, and the two unit conventions (fractions vs percents) are stated at the top. |
| `metrics.ts` | **THE metric registry + dictionary.** One entry per row: label, unit, `read`, `rollup`, `deltaMode`, `perWorkingDay`, `price`, `section`, `dependsOn`, `estimated`, **`annotate`**, an optional comparison `pair`, chart shape/colours, decimals, and the plain-language definition. Also owns **`SECTION_ACCENT`** — the one place the five block colours are named. Pure, client-safe. |
| `matrix.ts` | **The pure fold** — period axis, cells, deltas (percentage AND `deltaAbs`), YoY, the trailing summary column, the full history series, the pair history, the per-period annotations, the section grouping and the callouts, all in ONE pass over the same numbers. Also owns `ComparisonMode` / `COMPARISON_MODES`. Pure, client-safe. |
| `supplier.ts` | **P3 — the supplier fold + its dictionary.** `buildSupplierYear` (columns, rows, YTD, concentration), `buildExplorer`, `SUPPLIER_DICTIONARY`, and **`weightedPremiumPhpKg` — the ONE function that aggregates `premium_php_kg` anywhere in the codebase.** Pure, client-safe. |
| `production.ts` | **P4 — the grade fold + its dictionary.** `buildGradeYear` (columns, grade rows, YTD, the checked Σ tie, the top-grade read) and `PRODUCTION_DICTIONARY`. Pure, client-safe. |
| `period-selection.ts` | **R2 — the hidden set's URL codec** (`NO_HIDDEN`, `serializeHidden`, `parseHidden`). A separate module from `period-filter.tsx` for one reason: that file is `"use client"`, and a plain function exported from a client module becomes a client REFERENCE, so the Server Component calling it would fail at request time rather than at build time. Pure, importable from both sides. **R5 reuses it verbatim for `?bhide=`.** |
| `campaign.ts` | **R5 — campaign identity.** `CAMPAIGN_MONTHS`, `campaignMonthIndex`, **`campaignSeq`** (moved OUT of `queries.ts`, which is `server-only`, so the panel's checklist and the server's column sort share ONE definition of chronological), `campaignKey`, **`campaignMonthKeys`** (the `YYYY-MM` months a campaign covers) and `selectedCampaignMonths`. Pure, client-safe. |
| `row-order.ts` | **R5 — the ordering arithmetic**: `resolveOrder`, `isDefaultOrder`, `moveKey`, `dropKey`, `applyOrder`. Pure, so an ordering bug is readable without mounting anything, and so the same functions can be run against an untrusted `localStorage` value. **A saved order is a PREFERENCE, never a row list** — a key that no longer names a row is dropped and a row the save never heard of is APPENDED in registry position, so a row added in a future round cannot be hidden by an order set today. |
| `format.ts` | Display formatters, the blank-reason hover copy and the estimate hover. Presentation only. |
| `queries.ts` | **The server-only ADAPTER.** Reads the **nine** views + the live blocking grid, applies the ₱ gate and the two honest nullings, returns `AnalyticsData`. |

## Data

**Nine views + one live read.** All analytics views are `security_invoker`,
`authenticated`-only, **not** granted to `service_role` (the sync worker reads none of
them — L-044's arrow direction). Migrations
`20260901115129_analytics_phase1_data_layer` (+ the scalar fix `20260901115314`),
`20260901124822_analytics_phase2_money_layer`,
`20260901133909_analytics_phase3_supplier_layer` and
`20260901142417_analytics_phase4_production_layer`.

| View | Grain | Rows | Feeds |
|------|-------|------|-------|
| `view_analytics_rcin_monthly` | month with ≥1 delivery | 49 | Market price ₱/kg · Purchase volume · Active suppliers |
| `view_analytics_flow_monthly` | **every** month, zero-filled — the complete spine | 75 | RC IN total · RC OUT · Net flow · the working-day divisor |
| `view_analytics_inventory_eom` | every month of the spine | 75 | Ending inventory · Inventory value ₱ |
| `view_analytics_cost_monthly` | every month of the spine | 75 | Block price · ₱ per produced kg · Yield · Blocks closed · Closed-block loss · True ₱/kg |
| `view_analytics_aging_eom` | every month of the spine | 75 | Avg stock age · Stock over 120 days · the closed-residue split |
| `view_analytics_batch_cost` | one row per campaign per year | 32 | the whole batch-cost panel |
| `view_analytics_supplier_monthly` | month × canonical supplier, MARKET only | 275 | the whole supplier room |
| `view_analytics_production_monthly` | production months **∪ electricity months** | 18 | the six production rows |
| `view_analytics_production_grade_monthly` | month × grade | 39 | the grade mix |
| `view_blocking_grid` | one row per active batch (**LIVE**) | ~500 | the "148/220 blocks occupied · TODAY" chip |

**`view_analytics_aging_watchlist` still exists and is untouched in the database** — the
page simply stopped reading it (owner feedback R1). Dropping a view because one screen
stopped rendering it would be destroying a thing to tidy a page.

**Unwindowed on purpose.** CLAUDE.md's trailing-400-day idiom governs DAILY views, where
PostgREST's 1000-row ascending truncation silently eats the newest days. These are
MONTHLY / campaign grains at 18–275 rows — an order of magnitude or two under the cap —
and a month-on-month matrix that could not reach 2024 would not be the thing that was
asked for. The supplier read is the largest, so it carries a `truncated` flag and the room
says so when it trips.

### The rows, and the rollup rule each one ships with

> ⚠ **SUPERSEDED IN PART BY R4.** This section describes twenty-two rows in three
> bands. There are now **eighteen in two**: five money rows were retired, two moved
> to the campaign panel, two moved into RC Inventory, Yield moved into Production
> and Process loss was added. The tables below are still correct about every rollup
> rule and every caveat of a row that SURVIVED; for what moved where and why, read
> "Owner feedback round 4 — the restructure" at the end.

**Four rows were retired in owner feedback R1** — Sundry re-entry, Runway, Active batches
and Working days. Renzo does not act on any of them and twelve rows in one band was a
wall. **Only the ROWS went**: every underlying field still crosses the wire, `workingDays`
is still the divisor behind the per-working-day toggle (which is why that toggle keeps
working with its row gone), and nothing in SQL changed. Active suppliers was on that list
and he put it back.

| # | Row | Unit | Rollup (Q / Y / summary column) | Δ mode | ÷ working days? | ₱-gated |
|---|-----|------|--------------------------------|--------|-----------------|---------|
| 1 | Market price | ₱/kg | **weighted** — Σ `market_php_total` ÷ Σ `market_priced_kg` | % | no | **yes** |
| 2 | Purchase volume | t | sum | % | **yes** | no |
| 3 | Active suppliers | count | **peak** — the busiest constituent month | abs | no | no |
| 4 | RC IN total | t | sum | % | **yes** | no |
| 5 | RC OUT | t | sum | % | **yes** | no |
| 6 | Net flow | t | sum | **abs** (a net crosses zero — % of last month's net is meaningless) | **yes** | no |
| 7 | Ending inventory | t | **period-end** | % | no | no |
| 8 | Inventory value | ₱ | **period-end** | % | no | **yes** |

**Row 7 is the OPEN-PILES basis (owner feedback R1), and it has now been wrong in BOTH
directions — which is the part worth remembering.** It reads
`view_analytics_aging_eom.open_kg`.

- It began on `ending_kg`, the NET of every batch balance: **8,492 t** against a Blocking
  screen reading 10,000+ — *"kind of a weird basis"*. It is: a net subtracts a bookkeeping
  artefact (~3,200 t of negative balances) from a physical quantity.
- The first correction over-shot to `positive_balance_kg`, **11,707.9 t**, which bounces
  off Renzo's anchor from the OTHER side because it folds in **1,214.6 t of closed-block
  residue**. By the project's standing **resiko doctrine** that residue is LOSS already
  recognised — evaporated weight that is still logged — and never stock anyone can walk out
  and use. A stock row that counts it is not a stock row.

**Two properties make `open_kg` the right basis rather than merely the closest one:**

1. it is Renzo's own anchor — the population `view_blocking_grid` totals;
2. **it is AS-OF, not a snapshot of today.** The view tests
   `close_date IS NULL OR close_date > as_of_date`, so a block closed this week still
   counts in the months it was open. A current-`status` rule would have retroactively
   emptied history. Measured non-null and non-zero on **all 75 months** of the spine, so
   the row can never go structurally blank.

**The tie, measured 2026-09-01 and reconciled to the kilo:**

| | kg | t |
|---|---|---|
| every positive balance (`positive_balance_kg`) | 11,707,912 | 11,707.9 |
| − closed-block residue (`closed_residue_kg`, 346 blocks) — **the resiko, excluded** | 1,214,608 | 1,214.6 |
| = **`open_kg` — THIS ROW** | **10,493,304** | **10,493.3** |
| − `AUGUST-26-FEED2` (L-042 phantom, no `location_ref`, so no cell in the 220-slot grid) | 18,650 | 18.7 |
| = **`view_blocking_grid` grand total** | **10,474,654** | **10,474.7** |

So the row ties to Blocking **within the single disclosed 18.65 t phantom**. The expand
prints all three exclusions as numbers — the residue, the phantom, and the
net-after-negatives figure — rather than asserting any of them in prose.

**`inventory_value` does NOT share this population, and the page says so.** It still values
every POSITIVE balance, closed blocks included, because `view_analytics_inventory_eom` has
no notion of a close date at all — it derives balances from `batch_code` deltas and never
joins `batches`. Aligning it is a new SQL column, not a client-side division, and inventing
one in TypeScript would be a second definition of what a kilo cost. **Kept as-is and
disclosed**: measured 2026-09-01, closed-block residue is **₱34,752,633 of ₱424,331,252 —
8.19%** of the published value, and the row's dictionary caveat prints exactly that. See
the backend handoff at the end of this file.

**Section `money` — P2.** Every row below is blank before 2024-01 (`dependsOn: outflow`);
the two ₱-per-produced rows are also blank before 2025-11 (`dependsOn: production`).

| # | Row | Unit | Rollup (Q / Y / summary column) | Δ mode | ₱-gated |
|---|-----|------|--------------------------------|--------|---------|
| 9 | **Block price** | ₱/kg | **weighted** — Σ (covered ₱/kg × fed kg) ÷ Σ fed kg | % | **yes** |
| 10 | ₱ per produced kg | ₱/kg | **weighted** — Σ (covered ₱/kg × fed kg) ÷ Σ produced kg | % | **yes** |
| 11 | Yield | % | **weighted** — Σ produced ÷ Σ fed (×100 on the numerator) | **abs** (percentage POINTS) | no |
| 12 | Blocks closed | count | sum | abs | no |
| 13 | Closed-block loss | % | **weighted** — Σ kg lost ÷ Σ kg delivered | **abs** (crosses zero) | no |
| 14 | True ₱/kg (closed) | ₱/kg | **weighted** — Σ (true ₱/kg × priced fed kg) ÷ Σ priced fed kg | % | **yes** |
| 15 | Avg stock age | days | **period-end** | abs | no |
| 16 | Stock over 120 days | % | **period-end** | abs | no |

**"Delivered ₱/kg fed" is now "Block price" everywhere** — the matrix row, the campaign
panel's own row, both expands and the dictionary — because that is Renzo's own name for
it: *"the price of the charcoal when it arrived at the block."* The METRIC KEY is
unchanged (`delivered_fed_price`), so every `?metric=` deep link still resolves; the
₱-per-produced rows say "block-price basis" rather than "arrival basis"; and **"True
price" keeps its name**, which is the whole reason the rename reads as a pair.

**Section `production` — P4.** Rendered by `production-room.tsx`, after the supplier room,
from the SAME `buildMatrix` fold. **Not one row is ₱-gated and none can be** — no ₱ column
exists in either P4 view and none is derivable (the migration asserts 0 of 35 columns match
`php|peso|cost|price|value|amount`), so the whole band is live for the Production role and
the adapter has nothing to null.

| # | Row | Unit | Rollup (Q / Y / summary column) | Δ mode | Blank before |
|---|-----|------|--------------------------------|--------|--------------|
| 17 | Production output | t | sum | % | 2025-11 (`production`) |
| 18 | Output per reported day | t | **weighted** — Σ tonnes ÷ Σ **reported days** | % | 2025-11 |
| 19 | Downtime | hours | sum | abs | 2025-11 |
| 20 | Power | kWh | sum | % | — (**no `dependsOn`**; the meters start 2025-03) |
| 21 | Power intensity | kWh/kg | **weighted** — Σ kWh ÷ Σ produced kg, **paired and null-strict** | % | 2025-11 |
| 22 | Bags counted | count | sum | % | 2026-05 in practice (NULL, never 0) |

**Row 17 reads the SAME `producedKg` as the money band** — both are
`view_rc_movement_yield_monthly.total_produced` (measured equal on 10 of 10 production
months, max gap 0.0 kg). One field, one definition; a second would be a second definition
waiting to drift, which is also what makes the grade mix's `Σ made` footer a tie rather
than a coincidence.

**Row 18's denominator is PRODUCTION'S OWN reported days, not the working-day divisor** — the yard can take in charcoal on a day the plant does not run. That is why **no
production row is `perWorkingDay`**: the toggle would divide the plant's tonnage by the
yard's activity and silently change what the figure means. The honest normalisation is its
own row and says so in its dictionary.

**Row 21 is PAIRED, and that was a measured bug, not a precaution.** A weighted rollup sums
numerator and denominator INDEPENDENTLY, and the P4 spine carries **eight months with
metered power and no production at all** (meters from 2025-03, production from 2025-11). On
the first render the 2025 column added 577,438 kWh to a numerator whose months contribute
nothing to the denominator and read **0.9190 kWh/kg against a true 0.1527** — six times too
high. Both halves now gate on one predicate (`intensityUsable`): a month counts only if it
has a sound kWh reading AND a produced figure. Every other weighted row on the page is safe
from this by construction; this one was not.

**Rows 9 and 10 READ the `_covered` figure, always.** At 100% coverage
`delivered_php_kg_fed_covered` is byte-identical to the published `delivered_php_kg_fed`
(checked on all 75 months), so this is not a second definition — it is the same one, made
honest on the seven months where the published figure is silently understated by
untraceable kilos. Row 14's monthly value equals `php_per_produced_kg` exactly when
coverage is 100 and `php_per_produced_kg_covered` exactly when it is not.

**Row 14 is NULL-strict and its rollup weights by FED kilos**, the same weighting its own
value uses, which is what makes its dashed comparison line (`closed_blocks_delivered_php_kg`,
declared as `MetricSpec.pair`) a like-for-like comparison rather than two rival series.

**`peak` is the one approximation, and it is labelled.** Distinct suppliers across a
quarter is NOT derivable from three monthly distinct counts (anyone who sold twice would
be double-counted), so the Q/Y columns show the busiest month and the dictionary says so.
A future `view_analytics_rcin_quarterly` would fix it properly.

### The two arithmetic traps, obeyed structurally

1. **`ending_value_php` pairs with `positive_balance_kg`, never `ending_kg`.** Only piles
   with a positive balance are valued, in SQL. Nothing in TypeScript re-divides them.
2. **A Q/Y price is Σ pesos ÷ Σ priced kilos, never the mean of the monthly prices.** The
   ONLY rows carrying a `numerator`/`denominator` pair are the ones allowed to use the
   `weighted` rule, so an average of averages is not expressible in `matrix.ts`.

## Key Behaviors

### The ₱ gate (security boundary)
`getAnalyticsData()` resolves `canViewPrices()` (the ONE helper, `lib/auth.ts`, which
respects the impersonation cookie) and NULLS **24** fields before the payload leaves the
server — the four P1 ones (`market_avg_price`, `market_php_total`, `ending_value_php`,
`avg_unit_cost_php_kg`) plus the eight on `view_analytics_cost_monthly`, the eight on
`view_analytics_batch_cost` and the four on `view_analytics_supplier_monthly`
(`avg_price_php_kg`, `php_total`, `premium_php_kg`, `month_avg_price_php_kg`). It was 26
until the watchlist read was dropped in owner feedback R1 and took its two with it. The
complete list is in the adapter's header, copied from the migrations' own COMMENTs.
`view_analytics_flow_monthly` and `view_analytics_aging_eom` carry no ₱ and none is
derivable from either — which is why **the whole aging story stays visible for the
Production role**, including the two aging matrix rows and the closed-residue split.

The client receives `canViewPrices: boolean`; a ₱ row renders a lock badge and a `—` in
every cell, its expand shows the restricted panel (the same treatment
`rc-in-price-drilldown.tsx` uses), and the campaign panel's four ₱ rows read `restricted`.
**Callouts skip restricted rows entirely**, so no sentence about a peso can be composed
for a role that may not see one. Verified in the browser: 5 locked rows, the callout strip
composes 5 sentences and none of them names a peso, and the expand shows the lock panel.

### The three honesty behaviours the page OWES its reader
1. **The headline is USABLE STOCK and everything it leaves out is printed (inverted in
   owner feedback R1).** The row publishes `open_kg`; its expand's rail shows that against
   the closed-block residue it excludes, and three numbered disclosures follow it: the
   resiko (`+1,214.6 t` if it were counted), the Blocking gap (one pile, 18.7 t, no block
   location), and the net-after-negatives (`−3,215.4 t` across 77 batches →
   `7,277.9 t`). **Misattribution, not evaporation** — charcoal fed out under one batch
   name whose arrival was booked under a different spelling of it. Before R1 the board
   carried the net and disclosed the positive half.
2. **`outflow_recorded = false` months show BLANKS, not zeros.** `rc_out` begins
   2024-01-01. The ADAPTER nulls `outKg` / `netKg` / `outPerWorkingDay` / `runwayDays` for
   those months, so a structural zero can never sum into a quarter or a year as if the
   plant had fed nothing. Every blank cell carries a `title` saying why it is blank
   (`format.ts` → `BLANK_TITLE`), and a period that summed over a hole is marked with an
   amber `·` and reads *"this figure is a floor, not a total."*
3. **Block occupancy is LIVE-only.** `batches.location_ref` describes where a batch is NOW
   and is cleared and reused, so there is no as-of block map. Utilization is a chip beside
   the controls, stamped **TODAY**, and is never a matrix row. `price_coverage_pct` reads
   100.00 on every month today — it lives in the dictionary, with no alarm UI, exactly as
   the data layer instructed.

### The three P2 honesty behaviours, on top of those
4. **A coverage-short month shows the ESTIMATE, marked `~`.** Seven months cannot price
   every kilo they fed, because some kilos came out of piles with no delivery record at
   all (pre-system stock, and the L-042 `FEEDING # 2` phantom holding 18,650 kg). The
   published price is understated by exactly that share — March 2024 reads **₱0.30**
   against a real ~₱19 — so every money row reads the `_covered` figure instead, prints a
   `~`, and its hover names the coverage percentage. **August 2026 is ₱53.07 per produced
   kilo, not the naive ₱51.65.** The `CoverageSplit` rail in the row expand shows the
   traceable / untraceable kilo split as numbers.
5. **`produced_kg = 0` is a STRUCTURAL zero, and is nulled.** Production reports begin
   2025-11; the view zero-fills the 24 months before that, and a 0% yield rolling into a
   quarter would say the plant turned 8,000 tonnes of charcoal into nothing. The adapter
   sets `productionRecorded = produced_kg > 0` and nulls `producedKg` / `yieldPct` /
   `processLossKg` / both ₱-per-produced figures — measured from the data, never from a
   hardcoded date. Blank reason: `no_production`.
6. **Negative loss renders as measured.** `closed_blocks_loss_pct` is −0.001022 in
   February 2026 — those blocks fed out marginally more than was booked into them, which
   is misfiled paperwork, not a measurement error. It prints **−0.10%** and is never
   clamped. Same for `closed_blocks_uplift_php_kg`.

### The four P4 honesty behaviours — `MetricSpec.annotate`
P2's `estimated()` means exactly one thing (some fed kilos carry no price) and its `~`
hover says so. P4 has THREE different reasons a figure needs a caveat, so a row may declare
its own — a mark, its own sentence, and `blocksCallout`. The annotation is computed over a
period's MONTHS, so a quarter carries a caveat exactly as the month inside it does.

7. **One mis-keyed meter reading is 97% of its month, and it looks like a finding.**
   2026-03-01 / MAIN reads `start_kwh = 0` against an end that was still climbing; at ×120
   that single row publishes **676,944 kWh** into a month whose real consumption is about
   20,000. The **Power row publishes the total exactly as metered** (it must agree with the
   home dashboard's daily tile) with a `⚠` quantifying the bad reading. The **Power
   intensity row is NULL-strict** — blank rather than 0.7630 against neighbours reading
   0.03 — and prints the honest excl-suspect figure (**0.0219**) beside the ⚠, *labelled*,
   because withholding a number the page knows is silence rather than caution. **Nothing is
   repaired**: correcting the reading is Renzo's call and a separate, audited write.
8. **August 2026 reads 0.00 downtime hours and it is not a perfect month.** All 23 shifts
   named a repair and every one left the duration at zero. The cell carries a `⚠` and its
   own sentence, and the row expand's rail splits the month's records three ways
   (duration recorded / repair named with no duration / neither). Verified: August is
   **not** the "Lowest" in the expand's stat strip — May's 10.08 h is.
9. **Bags did not exist before May 2026.** `sacks` is NULL, never 0, on a month where no
   run recorded any, and a short-coverage cell carries a `~` naming the share (May 2026:
   *"speaks for 1 of the period's 38 production entries — 2.6% coverage"*).
10. **November 2025 is deliberately NOT suppressed.** It divides 24 days of metering by 3
    days of output and reads 1.2766 kWh/kg. March's kWh is factually WRONG so its ratio is
    suppressed; November's is factually RIGHT and merely not comparable, so it is published
    and held out of the headlines by the existing first-period guard instead. Suppressing a
    correct number is how a page starts lying.

### Callouts (magnitude only — no thresholds)
`buildMatrix` returns the cells AND the callouts from ONE pass, so a headline can never
disagree with the grid beneath it. Three shapes, capped at 5, never two lines about the
same metric:
- the largest period-over-period change in the displayed window (only this one may claim
  *"the biggest move on the board"* — a backfilled mover drops the superlative);
- the widest year-ago gap in the displayed window;
- a value that is the highest or lowest that metric has ever read, judged against its own
  history at the same granularity, and needing ≥6 comparable periods before the word
  "record" is used.

**`MatrixCell.calloutable` / `HistoryPoint.calloutable` is the ONE gate, and P2 widened
it three ways.** A period may be quoted only when it is settled, not an estimate, and not
the metric's first period on record:
- **an ESTIMATE cannot be a record or the biggest move** — quoting March 2024, which
  prices 1.6% of what it fed, as the cheapest month ever is a sentence about a hole in the
  data dressed as a sentence about the business;
- **nor can a metric's FIRST period** — production reporting opened part-way through
  November 2025, so that month reads an 11.9% yield and **₱337 per produced kilo** against
  a real ~₱50, which was measured to be the single largest "record" and "biggest move" on
  the whole board. Derived from the data (the first non-null period), never from a date,
  so it retires itself as history fills in;
- **nor an in-progress period, for a MOVER either.** P1 excluded unfinished periods from
  RECORDS and stated the reason as "it is not finished", but the mover and year-ago
  branches never applied it — which nobody noticed while every row was a volume. A ratio
  breaks it immediately: on the first day of a month the money rows carry one day of
  feeding against one day of production, and the strip's top line became *"₱ per produced
  kg rose 177.7% MoM in September 2026 — the biggest month-on-month move on the board."*
  The rule is now applied once, to all three kinds;
- **nor an ANNOTATED cell (P4)** — a figure the page is itself warning about can never be
  the thing the page leads with. Both P4 hazards would have topped the strip: August 2026's
  0.00 downtime hours is the lowest "record" on the board, and March 2026's 696,924 kWh is
  both the highest Power value ever and the biggest mover;
- **and a CHANGE needs BOTH ENDS (P4, `MatrixCell.deltaQuotable` / `yoyQuotable`).**
  `calloutable` gates the period a sentence is ABOUT; a mover is a statement about two
  periods, so the one measured FROM has to pass the same gate. Measured on the first P4
  render, this was the strip's top line: *"Power fell 97.6% MoM in April 2026, to 16,572
  kWh — the biggest month-on-month move on the board."* April's own cell is sound and
  passed every gate above; the 97.6% is entirely the mis-keyed March reading it was divided
  by. The same shape had been latent since P1 for the period immediately after a metric's
  first — a fall from a reporting boundary is a fact about when reporting started.

All five gates are **callout-only**: every one of those cells still renders, still
carries its delta, and still explains itself in its hover. The row expand's
Highest / Lowest stats read the SAME gate (`comparable`), so the strip and the drill-down
can never name different periods; the chart still draws everything, and the stat's hover
says how many settled periods were held out and why.

### Colour, and what kind of colour it is (owner feedback R1)

Renzo asked for *"a splash of color"*. The plan's rule — **no threshold colouring until
real targets are stated** — is untouched, so the page gained exactly two kinds of colour,
both of which are FACTS rather than verdicts:

- **A section accent per block** (`SECTION_ACCENT` in `metrics.ts`, the CSS vars
  `--bw-sec-*` in `globals.css`, both themes): flow blue, money amber, campaigns green,
  suppliers rose, production violet. It rides as a left RULE on each band row and section
  header, as the tint on a ₱ row's label, and as the dot on a callout — it says WHERE you
  are, never whether a number is good. A frozen band cell wears it as a real `border-left`
  and NOT as `.bw-accent-rule`, because `.frozen-edge` already owns that cell's
  `box-shadow` and is deliberately unlayered — measured: the accent's shadow was being
  dropped entirely.
- **A green/red DIRECTION tint on the period-over-period change**, the same convention the
  Home Digest uses for a signed number. It follows the arithmetic sign and stops there.

Everything else is unchanged: a delta still carries its ▲ ▼ · glyph, no cell turns amber
because a value is high, and a rising purchase price is still not "up" in the cheerful
sense. The `⚠` on a mis-keyed reading remains the one amber mark, and it says a figure
rests on a broken input — a fact about the record.

### The comparison chip (owner feedback R1)

The FIRST indicator under every value is **always the period-over-period move** and is not
switchable — it is the question the page exists to answer. A page-level `Compare` control
beside the Y/Q/M toggle decides only what rides beside it:

- **`YoY %`** (default) — the same period one year earlier, as a percentage. Unchanged
  from before, and null in the YEAR view where it would merely repeat the primary.
- **`Δ actual`** — `MatrixCell.deltaAbs`, the same move as a real amount in the row's own
  unit. **Null on a row whose `deltaMode` is already `abs`**, because the primary line IS
  the actual change there and printing it twice is noise rather than a second reading.

It writes itself into the URL as `cmp=actual` (absent = `yoy`), and the server resolves it
from `searchParams` like every other control. Verified across all three granularities:
`M` prints `▼−4.6%` + `Y −4.4%` / `Δ −63.8`; `Y` prints `▼−32.0%` + `Δ −6,203.6`.

### View state
Year, granularity, the working-day toggle, the comparison chip, the expanded metric,
(R2) **the hidden period columns (`hide`)** and (R3) **the master `Definitions` switch
(`dict`)** are **React state that writes itself into the
URL** with `window.history.replaceState`. The house rule (URL params
drive filters) exists because a filter changes what the SERVER reads — here nothing does:
the adapter returns all history in one payload and every control re-slices what the browser
already holds. Routing them through `router.replace` would re-run four Supabase reads to
change a column header. The SERVER still resolves the initial values from `searchParams`,
so a shared link renders correctly on the first paint.

### Why NOT the Blackwood Table
The platform grid is right for a LEDGER (rows = records, columns = fields). This surface
inverts that, and breaks three of its assumptions:
1. **The formatter belongs to the ROW, not the column** — `Mar` prints ₱48.26 on one row,
   1,864.1 t on the next and 14 on the next; `ColumnSpec.format` is per column.
2. **A cell is three things, none editable** — value + delta + YoY chip. Nothing here is
   ever written, so the edit journal, paste sink and caret model are cost with no benefit.
3. **The row expand is the point of the page** — a chart reached through
   `renderChromeRow` lives INSIDE a `table-fixed` row and would be as wide as the whole
   scrolling table (~1,500px). (R1 solved that WITHOUT the grid — see below.)

Twenty-two rows across two mounted instances also means virtualisation buys nothing. The bespoke table still obeys both
platform layout rules: **"never crush, always scroll"** (`table-fixed` + `width:
max-content` + a full `<colgroup>` of explicit widths + `overflow-x-auto`, no flexible
column) and **frozen panes are OPAQUE** (the KPI-name column is `.frozen-col` + `.frozen-edge`
over scrolling cells, paints a solid token and repaints its hover/selected state solidly).
The header row is deliberately NOT sticky-top: the table never scrolls vertically inside
its own box, so there would be nothing to pin against.

### The IN-PLACE expand (owner feedback R1)

Renzo on the old below-the-table panel: *"such a long scroll."* The layout objection above
was real, so the fix is not to give up the `colSpan` — it is to stop the panel inside it
from being table-width:

- the expand is a `<tr>` spanning **every** column, inserted immediately after the row that
  was clicked, so it sits exactly where the reader is looking;
- the panel INSIDE that cell is `position: sticky; left: 0` at the **scroller's measured
  `clientWidth`**, clamped to the table's own `minWidth` so a table narrower than the
  viewport cannot be pushed into horizontal overflow by its own expand;
- **a non-positive measurement is treated as "not measured yet"** and leaves the panel at
  100% of its cell. Measured: a `ResizeObserver` callback can land while the element has no
  layout at all and report 0, which pinned the expand to zero width.

Verified in the browser at 1280px: the panel is 1,230 px wide, sits directly under its own
row, and **drifts 0 px when the table is scrolled 400 px sideways**, with the frozen column
still pinned and the document's horizontal overflow still 0. The supplier matrix uses the
same mechanism for its own expand.

### Widths, re-measured for the R1 type bump

*"The numbers look so tiny."* Cell values went 12 → **14 px**, row labels 12 → **13 px**,
sublabels 10 → **11 px**, headers 10.5 → **11.5 px**, row height 52 → **62 px** — and every
explicit width was re-measured against the new metrics rather than left to clip.

| Table | Before | After |
|---|---|---|
| KPI matrix | 208 / 100 / 112 | **232 / 116 / 128** |
| Campaign panel | 208 / 116 | **232 / 128** |
| Supplier matrix | 180 / 84 / 112 | **196 / 92 / 124** |
| Grade mix | 168 / 84 / 112 | **184 / 92 / 124** |

The frozen name column carries a 12 px chevron + 4 gap + the label + 4 gap + a 16 px info
button inside 8 px padding either side; the longest label on the board is "Output per
reported day" (~150 px at 13 px medium), so 232 leaves headroom and nothing truncates. No
57px header-chrome budget applies — that tax is the Blackwood Table's `scope="focus"`
hover-revealed sort/filter siblings, which a bespoke `<th>` does not have. Verified at
375 px: **zero horizontal document overflow**, every table scrolling inside its own
wrapper.

**R3 re-derived every one of these a second time, at a second scale** — see "The big-screen
scale" below. The numbers above are still the ones the page renders below 1920 px; the
table there is the same set at ~1.19x.

### Printing one metric (owner feedback R1)

Each expanded metric carries a **Print** button — the pragmatic browser print-to-PDF route,
no PDF library and no server round trip. The button tags every ancestor of the panel with
`data-print-ancestor`, adds `bw-printing` to `<body>` and calls `window.print()`; both
marks come off on `afterprint`, with a 1 s fallback because not every engine fires it on a
dismissed dialog.

**The print stylesheet `display: none`s everything that is not the card, not inside it and
not on the path down to it** — it does NOT merely hide it. That distinction was measured,
not assumed: the obvious `visibility: hidden` version leaves every element occupying its
space, so the sheet came out as several blank pages with the card wherever its row happened
to sit; and because the card lives inside a `position: sticky` wrapper — a positioned
ancestor — `position: absolute; top: 0` resolved against that wrapper rather than the page
and did not lift it either. The path itself is flattened to plain blocks with no width,
position, overflow or chrome.

`@page` is A4 with a 14 mm margin, `print-color-adjust: exact` keeps the chart's colours,
and the recharts SVG gets `max-width: 100%; height: auto` so it scales to the column rather
than clipping at the margin. Two blocks exist ONLY on paper — a title line naming the
metric, the window and the as-of date, and the page's own restatement policy — because a
printed figure that does not say what it is or when it was true is one somebody will
misquote a month later. Verified by emulating the real print rules in the browser: the card
lands at `top: 0`, the on-screen header and the Print/Close controls are gone, and the whole
report fits one 697 px-tall sheet.

**Section bands.** Rows in one undifferentiated stack are a wall, so `groupBySection`
splits them by `MetricSpec.section`, ordered by `SECTIONS`, and takes an optional `only`
list so the same component can render the top band(s) at the top and the production band
in the production room. **Since R4 there are TWO bands — `RC Inventory` and `Production`**
(it was `Volume & stock` · `Money` · `Production`; see the R4 section at the end).
The band's label cell is `.frozen-col` like every other cell in that column — a band that
scrolled away would leave the rows under it unlabelled exactly when the reader is furthest
from the header — and it carries the anchor `id`.

### The panels below the matrix, and why they are not matrix rows
- **The campaign panel is a different AXIS.** A campaign crosses month boundaries (AUGUST
  closed and SEPTEMBER opened on 2026-08-29), so folding it in would mean a column that is
  neither a month nor a quarter sitting beside columns that are. It also has a genuinely
  different star number: `upliftPhpKg`, the cost of storage time, which only exists per
  campaign. Its spine is `campaign_options UNION campaign_yield`, so a campaign that has
  produced but not yet been fed still gets a column — SEPTEMBER 2026 is exactly that today.
  Column order is (year, month index of the batch NAME), **never `first_fed_date`**, which
  is NULL for such a campaign.
- **The AGING WATCHLIST used to be here and is gone (owner feedback R1).** Renzo: *"take
  out piles to go look at."* The section, its nav anchor and the adapter's read of
  `view_analytics_aging_watchlist` all went; the view, the types and
  `aging-watchlist.tsx` all remain, unmounted, so it is one read and one JSX element away.
  **The aging MATRIX ROWS are unaffected** — Avg stock age and Stock over 120 days read
  `view_analytics_aging_eom`, which is still read and now also feeds the ending-inventory
  expand's closed-residue split.

### The supplier room (P3) — and its one hard arithmetic rule

The third cut: **who we bought from.** A section below the campaign panel, not a tab —
see Purpose. It follows the page's YEAR picker and deliberately NOT the Y/Q/M toggle: a
supplier year is a calendar year, always, and a quarter column of suppliers would be a
different question from the one the room answers.

**`premium_php_kg` may only ever be averaged WEIGHTED by priced kilos, and
`weightedPremiumPhpKg` in `lib/analytics/supplier.ts` is the ONLY function that touches
the column.** The month's market price IS the priced-kg-weighted mean of the supplier
prices, so weighted, the premiums come to exactly zero every month by construction
(measured all 49 months, max |Σ| = 7.1e-17). Unweighted, the same column reads −₱2.52 for
March 2026 — a number that looks like a finding and is pure artefact of the top two
sellers being three quarters of the volume. The premium panel therefore **prints the
weighted rollup in its footer** (`+₱0.00`) rather than asserting the identity in prose,
and there is no unweighted average anywhere in the UI to offer.

**The `Σ market` footer is not a sum of the rows.** It prints `month_market_kg`, which the
view carries onto every supplier row by joining `view_analytics_rcin_monthly` — so the
footer IS the KPI matrix's Purchase volume row rather than a second number that happens to
agree with it. (The two were measured equal on 49/49 months, max gap 0.00 kg; printing the
published one means they cannot drift even in principle.) The same figure is the
denominator of every YTD share, so the concentration header and the matrix cannot disagree
either.

**Returned sun-dried material is traceability and enters nothing.** `sundryOriginKg` is
never added to `kg`, never enters share, rank, price or premium. It rides as a ↩ chip on
the supplier's name, as an inline ↩ mark on a month that had both, and as the cell value
(in the muted returns treatment) on a month that had only returns. **A returns-only
supplier is exempt from the top-12 cap and is always on screen** — SEVILLA bought nothing
in 2026 and had 140.6 t come back, and a purchase-only view would have rendered that as
absence, which is the one thing the column exists to prevent. Their row expand charts the
RETURNS series, labelled as such, rather than showing an empty box.

**A supplier's premium is measured against the months THEY sold in**, never against the
year — so a seller who only appeared while charcoal was dear can show a higher ₱/kg than
the year figure and still read as a discount. The panel says so under the table, and the
year price beside the header is labelled `year ₱…` (context) rather than presented as the
baseline.

**The explorer takes no new read.** Price × volume × active-supplier count come from
`AnalyticsMonth` — P1's own monthly view, already in the payload — so the chart cannot
disagree with either matrix. Volume bars force a zero baseline; the price line gets the
padded domain. The supplier count rides a HIDDEN axis while ₱ is visible (three labelled
axes do not fit a 375px screen) and takes the right axis when ₱ is restricted.

**Restricted role.** Four ₱ fields are nulled server-side (`avg_price_php_kg`,
`php_total`, `premium_php_kg`, `month_avg_price_php_kg`). The volume matrix, the
concentration header, the returns chips and the explorer's volume + supplier lines all
stay **fully live** — the same split that made `view_analytics_aging_eom` useful to a
restricted role in P2. The premium panel renders the lock treatment; the expand drops its
premium line and marks the ₱ stats restricted. **The dictionary copy for the two ₱-bearing
supplier figures is deliberately ₱-FREE**, because that card renders for every role and a
worked example with a real peso figure in it is a price leak dressed as documentation.

Widths: supplier **180px**, each month **84px**, the YTD column **112px**; `minWidth` is
their sum. The premium table is 148 / 78 / 196 / 82 / 92. The `Σ market` row is a plain
last row rather than a sticky `<tfoot>` — this table never scrolls vertically inside its
own box, so there is nothing to pin against (the same reason the KPI matrix's header is
not sticky-top) — but its label cell is still `.frozen-col` + `.frozen-edge`, because the
table does scroll sideways.

### The production room (P4) — and the tie it CHECKS rather than asserts

The fourth cut: **what the plant made.** A section after the supplier room, not a band at
the top — see Purpose. Its six rows are the SAME `buildMatrix` fold as the twenty above:
`AnalyticsMatrix` takes a `sections` filter and is mounted twice, so the two tables, the
row expands and the callout strip are the same numbers by construction and a production
record is judged by identical machinery. The **grade mix** follows the page's YEAR picker
and deliberately not the Y/Q/M toggle (a quarter column of grades is a different question);
the six matrix rows follow the toggle like everything else.

**The `Σ made` footer is not a sum of the grade rows.** It prints the monthly series' own
`producedKg` — the very field the Production output row reads — so the grade mix and that
row cannot drift apart. The two ARE equal (Σ grade `kg` = the parent view's `produced_kg`,
0 mismatches / 10 of 10 months, max gap 0.0 kg), and unlike the supplier room's `Σ market`
this one **checks the tie every render**: `GradeYear.totalGradeKg` is kept beside
`totalKg`, and when they differ by more than a kilo the footnote says so out loud with both
figures rather than quietly showing one of them. A tie that is asserted and never checked
is not a tie.

**Every monthly share is SQL's own** (`share_of_month_pct`, whose denominator is JOINED
from the monthly production view), so nothing here recomputes one. The YEAR share IS
computed here, as Σ kilos ÷ Σ kilos — weighted by construction, never the mean of twelve
monthly percentages.

**Nothing in this section is gated and nothing is nulled**, because there is no ₱ in it and
none is derivable. That is the P2 aging split taken to its limit: production is the one
module of the platform with no money in it, and the money that MEETS production already
lives in the money band and is gated there.

Widths: grade **168px**, each month **84px**, the YTD column **112px**; `minWidth` is their
sum. Same frozen-column discipline as the two matrices above (measured: `position: sticky`,
`left: 0`, `z-index: 10`, a fully OPAQUE background in both themes, no backdrop-filter).

### The anchor row (P4, narrowed to four in R4)
`analytics-nav.tsx` — **four** links, `sticky top-0 z-40`, the canonical glass pattern
(`bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60`), legal here
because it floats over empty page background rather than over scrolling table cells (which
are opaque, above). **z-40 and not 30**: the frozen-pane scale tops out at 30
(`.frozen-corner`) and a sticky table corner shares the root stacking context with this bar,
so at equal z the later element in the DOM would win.

The FIRST anchor is the matrix's own **band row** (`id="band-flow"`), which is deliberate:
RC Inventory is a band of that table, not a block of its own. (It was two — `band-money`
went with the Money band in R4.) Every target carries `scroll-mt-24` to clear the bar. **No layout shift** — sticky never
removes an element from flow (measured: document height identical pinned and unpinned), and
the active state is a background change only, never a weight change or an added glyph. The
active section is OBSERVED with an `IntersectionObserver` over the real anchors and claimed
instantly on click, so the bar answers before the scroll finishes.

## Owner feedback round 1 — the ten-item list, 2026-09-01

Renzo tested the live page and gave a direct list. All ten are applied; the detail lives in
the sections above, and each file carries the reasoning at the point of change.

| # | Asked for | Where it landed |
|---|---|---|
| 1 | Drop Sundry re-entry, Runway, Active batches, Working days — **keep Active suppliers** | `metrics.ts`; only the registry entries went, no field and no view |
| 2 | Ending inventory on a basis that matches Blocking, not the weird net | `metrics.ts` reads `openKg`; the resiko, the phantom and the net are all expand disclosures; ties to Blocking within 18.65 t (reconciled above). `inventory_value` kept as-is and its wider basis disclosed |
| 3 | Expand IN PLACE, not below the table | `analytics-matrix.tsx` + `supplier-matrix.tsx` — spanning row, `sticky left-0` panel at the measured frame width |
| 4 | Print / PDF per metric | A `Print` button on the expand + the print rules in `globals.css` |
| 5 | Everything bigger | One type scale up across all four tables, with every width re-measured |
| 6 | A splash of colour, not thresholds | Section accents + direction tints; no threshold semantics anywhere |
| 7 | Primary = the period move always; a toggle for the second chip | `Compare` control, `MatrixCell.deltaAbs`, `cmp=` in the URL |
| 8 | Dictionary copy cut to 1–2 plain sentences | Every entry in `metrics.ts`, `supplier.ts`, `production.ts`, and the three P4 annotation sentences |
| 9 | "Delivered ₱/kg fed" → **Block price** | Matrix row, campaign panel row, both expands, the dictionary; the metric KEY is unchanged so deep links still resolve |
| 10 | Remove the aging watchlist | Component unmounted, nav anchor dropped, adapter read dropped; the view and the file survive |

**Two things this round deliberately did NOT do.** Nothing was dropped from the database —
`view_analytics_aging_watchlist` is untouched and every field behind a retired row still
crosses the wire. And no threshold colouring was introduced: item 6 asked for colour and
got identity and direction, which are facts, not the target-based judgement the plan still
withholds until Renzo states real targets.

## Owner feedback round 2 — the period filter, 2026-09-02

Renzo, on the row expands drawing *"every month on record"* back to 2020 while several
metrics are honestly blank for most of it: *"I would also like the option to click which
years to display, which months, quarters etc. We must always default this filter checklist
to checking all. We should have the option to select/deselect all as well."*

**ONE checklist component, two surfaces** — `period-filter.tsx`, mounted by the controls
row (matrix COLUMNS) and by each row expand's chart card header (chart YEARS). Same
trigger, same `All` / `None`, same dense list, same Esc-and-focus-return, both themes.

### The one structural decision: the state is what is HIDDEN
Never the selected set. *"Always default to checking all"* then stops being a default
somebody has to remember and becomes a property of the shape: an absent param and an empty
set **cannot** mean "nothing is selected", they can only mean "everything is". It also
gives the URL param its spelling — `?hide=` is simply dropped when nothing is hidden, so
the default view has a clean address and the param's presence always means something.

> **R4 superseded the DEFAULT for the chart filters — and the shape is why it cost
> nothing.** Renzo asked an expand's checklist to open on the years that actually
> carry a figure. Because the state is the hidden set, that is a different STARTING
> VALUE and not a different mechanism: `All` / `None` are untouched, the empty years
> are still listed with their `0/12` coverage count, and one click brings any of them
> back. **The matrix COLUMN filter still defaults to everything checked** — its
> periods come from the complete flow spine, so there are no empty ones to hide.
> Detail and the two safety properties are in the R4 section at the end.

### The URL param, and why only ONE of the two filters is in it
`?hide=<comma-joined period keys>`, resolved server-side by `parseHidden` exactly like
`year` / `g` / `wd` / `cmp` / `metric`, so a filtered link renders correctly on the FIRST
paint. **The expand's year selection is deliberately NOT in the URL** — it is scoped to one
metric's chart, so a param carrying it would silently mean something different the moment
`metric=` changed and a shared link would arrive with a filter belonging to a row the
recipient is not looking at. Both call sites `key` the expand by metric, so opening a
different row starts with every year checked.

**ONE hidden set spans every granularity and year**, because a period key is already
self-describing (`2026-03`, `2026-Q1`, `2025`): a key belonging to a view the reader is not
on matches nothing and is inert, and comes back intact when they return to that grain.
Verified: hiding Jan/Feb/Mar in M, switching to Q (all quarters back), hiding Q1/Q3, then
switching back to M returns Apr/Aug/Sep exactly. `All` clears only the keys the control
itself owns, so the month view's `All` cannot silently un-hide a quarter.

### The honesty rule: filtering HIDES, it never RESTATES
Three consequences, all deliberate and all measured in the browser:

1. **The summary column re-folds over the selection, through the same machinery.**
   `buildMatrix` drops hidden periods from `shown`, and `shown` is what `foldPeriod` builds
   the total from — so a filtered price is still Σ pesos ÷ Σ priced kilos. **Measured:**
   over Apr–Sep the Market price summary prints **₱47.93**, which is the kg-weighted fold
   (47.9312) and **not** the mean of the six visible cells (47.8500). A mean of the
   surviving cells is not expressible anywhere in `matrix.ts`, filtered or not.
2. **The header says `Selected`, never a year.** A fold over four chosen months is not the
   year to date, so `totalLabel` becomes `Selected` and its hover reads *"6 of 9 months
   selected · 2026"*. Its comparison chip narrows the PRIOR year to the same positions
   (`selectedSeq`) rather than comparing four months to twelve.
3. **A comparison still reads the real neighbouring period.** **Measured at YEAR
   granularity:** with 2025 hidden, 2026 still prints `▼−48.9%` — its change against 2025's
   actual value — and is *not* silently re-based onto the visible 2024 (which would read
   −40.9%). Comparison uses the data; the filter only decides what is drawn. The page
   footer says this in plain language, and so does each control's hover.

### Callouts cannot quote a hidden period, and it costs no new code
`shownKeys` is built from the FILTERED `shown`, so `HistoryPoint.displayed` is false for a
hidden period — and the record branch already required `displayed`, while the mover and
year-ago branches only ever walk `cells`, which are built from `shown`. One set, both
guarantees. **Measured:** hiding May/June/July — the three months the strip was naming —
re-ranked it onto April and August with zero references to any hidden month. The record
POPULATION is deliberately still the metric's whole history: a record is judged against the
metric's life and merely *reported* when it falls in the window, which filtering must not
change.

### The rolling average breaks at the gap — the order of operations IS the feature
In the expand, hidden periods are **nulled first**, `rollingMean` is run over that nulled
sequence, and only **then** are they dropped. Any window overlapping a hidden year yields
null, so the smoothed line breaks exactly as it already does at a month nothing was
recorded in. Filtering first and averaging after would have drawn a line straight across a
hole the reader made and called it a trend.

**Measured on RC OUT (values 2024-01 … 2026-09) with 2025 hidden:** the average path is
**two segments of 10 and 7 points** — precisely `12−2` and `9−2`. A bridging implementation
would have produced one run of 19. `rollingMean` and `rollingWindowFor` are exported from
`matrix.ts` and reused rather than re-implemented, so there is one definition of the
smoothing and of the 3-period window.

### The stat strip recomputes, and says so
`Latest`, `Highest` and `Lowest` all carry **`· selected`** while filtered, because
"Highest" over three chosen years is a different claim from "Highest" over the record; the
window stat becomes **`Selected`**, folded by `foldSelection` — a thin wrapper over the same
`foldPeriod` + `rawValue` pair every column uses, which is why it needed `Matrix.allPeriods`
(a rollup needs the MONTHS underneath; no amount of averaging the chart's points can
produce a weighted price). **Measured on RC OUT with 2025 hidden:** `Highest` moved from
August 2025 (1,685.8 t) to February 2024 (1,679.1 t), and the window stat from
`2026 · 8,687.9 t` to `Selected · 23,388.0 t · 6 of 7 years · 63 months`. `recordScope`
gains a sentence naming how many years are switched on.

### Two empty states, because they are two different facts
`None` on the columns prints *"Every column is switched off… all 9 are still there"* rather
than "no months recorded" — the window genuinely being empty is a fact about the data,
every column being off is a state the reader created a second ago, and conflating them
would send them looking for a bug. Same split in the chart.

### The years list shows COVERAGE, which is the point
Each year carries `withValue/total` — RC OUT reads `2020 0/6`, `2021 0/12`, `2022 0/12`,
`2023 0/12`, `2024 12/12`, `2026 9/9`. The whole reason the control exists is that some
rows are honestly blank for years at a time; a reader deciding what to put away should be
able to see which years those are **without switching them off first**.

### Print prints the SELECTION, and says what it left out
The chart renders the filtered series, the Years control is `data-print-hide`, and the
paper-only title line names both filters. **Measured under the real print rules** (every
`@media print` block lifted into a live stylesheet, including the nested Tailwind `print:`
variants): card at `top: 0`, on-screen header hidden, print title shown, Years control
`display: none`, **21 filtered bars printed rather than 33**, and the title reading
*"RC OUT · tonnes fed · 2026 · 7 of 9 months selected · month columns · records through
2026-09-02 / History filtered to 2020, 2021, 2022, 2023, 2024, 2026 (6 of 7 years). Hidden
years are not restated…"*. A printed chart that silently omits three years is exactly what
this page's restatement policy exists to prevent.

### One platform-adjacent change
`DrilldownSection` (`components/digest/drilldown/drilldown-modal.tsx`) gained an optional
`action` slot in its header, so the expand's checklist can sit beside the subtitle. Purely
additive — omitted, the header renders as before; the header's cross-axis alignment moved
from `items-baseline` to `items-center` so a control lines up with the text.

### Verified in the browser (throwaway harness, since deleted)
Both themes, 1280px and 375px (**zero horizontal document overflow**, both popovers inside
the viewport at 248px wide), Esc closes and returns focus to the trigger, `?hide=`
round-trips through a fresh server render (`3 of 9 months`, summary 3,213.9 t = the three
kept months), `All` / `None` behave, and the grain round-trip preserves each grain's own
selection.

### Open backend handoff — an open-piles inventory VALUE

```
## Backend Request: value inventory over OPEN piles, not every positive balance
**File:** supabase/migrations/<new>_analytics_open_piles_value.sql
**Object:** view_analytics_inventory_eom (add a column; do not change `ending_value_php`)
**Add:** open_value_php numeric  — the same avg-cost valuation the view already does,
         restricted to piles still open AT THAT MONTH-END
**Behavior:** reuse `view_analytics_aging_eom`'s own open test verbatim —
         `close_date IS NULL OR close_date > as_of_date`, sourced from
         `view_rc_movement_block_actual_price` — so "open" has ONE definition on this page
         rather than two. Keep `ending_value_php` unchanged: it is the cost of everything
         still on the books and something may want it.
**Tables/views involved:** view_analytics_inventory_eom, view_analytics_aging_eom,
         view_rc_movement_block_actual_price
**Called from:** the `inventory_value` row in `lib/analytics/metrics.ts`, which would then
         read `open_value_php` and pair with the Ending inventory row above it.
**Why not client-side:** `view_analytics_inventory_eom` never joins `batches` and has no
         close date, so nothing in the payload can distinguish an open pile's value from a
         closed one's. Deriving it in TypeScript would be a second definition of what a
         kilo cost — the exact thing `avg_cost` was narrowed to prevent (BUG-018 / L-039).
**Measured today:** ₱34,752,633 of ₱424,331,252 (8.19%) is closed-block residue.
```

Until that lands, the two stock rows describe slightly different populations and the
`inventory_value` dictionary caveat says so with the measured share in it.

## Owner feedback round 3 — the big-screen scale, 2026-09-02

Renzo, after testing on his own two screens: *"Make it more visible on bigger screens. It
utilizes the space well on my smaller 14-inch MacBook Pro screen, but on my 27-inch 1440p
monitor it does not really scale well. Text is much smaller. Overall I'd like to see things
clearer."* Three follow-ons landed in the same round and are documented under it: a switch
for the trailing-average line, a master switch for the dictionary blocks, and landscape
print.

### The breakpoint is 1920px, and Tailwind's `2xl` would have been wrong
A 14-inch MacBook Pro reports a **logical** width of **1512 px** at default scaling and
**1800 px** in "More Space". Tailwind's `2xl` is **1536 px** — so a `2xl:` bump would have
fired on the exact laptop Renzo says already reads well, which is the one screen this
change had to leave alone. 1800 is therefore the highest width that must stay small, and
**1920** is the next standard desktop step above it: a 2560-wide monitor crosses it with a
window at 75% of the screen, and a window narrower than 1920 on that monitor is genuinely
laptop-sized, so the small scale there is correct rather than a miss. ONE step, not a
ladder — a second breakpoint doubles what has to be verified and there is no third screen
in evidence. **Measured at the boundary: 1800 → small · 1919 → small · 1920 → big.**

### A CSS-variable ladder, because type and column width may not drift apart
The geometry is not only type. Four tables carry explicit `<colgroup>` widths whose SUM is
each table's `minWidth` ("never crush, always scroll"), so a type bump that left the widths
alone would clip a header — the exact failure R1 re-measured every width to avoid. Both are
now variables on one container (`.bw-analytics`, declared in `globals.css`), which is what
makes it impossible for one to move without the other. There is **no JavaScript in it**: no
`matchMedia`, no hydration seam, and a chart height or a column width is resolved by the
same media query that resolved the font above it.

**The small scale is declared on `:root`; only the big one is scoped to `.bw-analytics`.**
Two reasons, both load-bearing. (1) Radix **portals** the year `Select` and both `Popover`s
to `<body>`, outside the container — had the small values lived only on the class, every
`var()` inside a popover would have resolved to nothing and the declaration would have been
dropped at computed-value time. On `:root` the worst case is "renders exactly as today".
(All three portals also carry `bw-analytics` so they scale WITH the page; the `:root`
declaration is the net under them, not the mechanism.) (2) The shared drill-down chassis can
then read the same variables with its own literal as the fallback, so the Home Digest reads
the number it always did.

**Type — one variable per size that already existed**, so the small scale is reproduced
exactly rather than approximated by collapsing sizes into a shorter ladder (~1.19x):

| token | small | big | where |
|---|---|---|---|
| `--bw-fs-9` | 9 | 11 | direction glyph |
| `--bw-fs-95` | 9.5 | 11.5 | "today" chip |
| `--bw-fs-10` | 10 | 12 | comparison chips, rail ordinals, chart axis ticks |
| `--bw-fs-105` | 10.5 | 12.5 | stat labels, card subtitles |
| `--bw-fs-11` | 11 | 13 | sublabels, section bands, deltas, chart legend |
| `--bw-fs-115` | 11.5 | 13.5 | table headers |
| `--bw-fs-12` (`text-xs`) | .75rem | 14 | body copy, controls, checklist |
| `--bw-fs-125` | 12.5 | 15 | |
| `--bw-fs-13` | 13 | 15.5 | KPI row labels |
| `--bw-fs-14` (`text-sm`) | .875rem | 17 | **cell values** |
| `--bw-fs-15` | 15 | 18 | |
| `--bw-fs-16` (`text-base`) | 1rem | 19 | |
| `--bw-fs-18` (`text-lg`) | 1.125rem | 22 | drill-down stat value |

The four that stand in for a NAMED Tailwind size keep Tailwind's own **rem** units, so the
small scale stays byte-identical even for a reader who has raised their browser's root font
size; the rest were px literals in the source and stay px.

**Boxes** move with the line boxes they hold: row 62 → **74**, header row 36 → **42**,
section band 28 → **33**, value line 20 → **24**, delta line 16 → **19**, controls 32 →
**38**. **Charts** 260 → **340** (the expand — the "see things clearer" payload) and 220 →
**290** (supplier expand); `ResponsiveContainer` is `height="100%"` inside those boxes, so
recharts re-measures for free.

**Widths, re-derived at the big scale** (~1.19x, matching the type):

| Table | ≤1919px | ≥1920px |
|---|---|---|
| KPI matrix | 232 / 116 / 128 | **276 / 138 / 152** |
| Campaign panel | 232 / 128 | **276 / 152** |
| Supplier matrix | 196 / 92 / 124 | **234 / 110 / 148** |
| Grade mix | 184 / 92 / 124 | **220 / 110 / 148** |
| Premium table | 148 / 78 / 196 / 82 / 92 | **176 / 94 / 234 / 98 / 110** |

Each `minWidth` became a `calc()` over those same variables, so "the sum of the colgroup IS
the minWidth" is now structural rather than re-typed at each scale. The in-place expand's
clamp became a CSS `min(measuredFrame, thatCalc)` for the same reason — identical
semantics, resolved at the same breakpoint as the widths it clamps against.

**The container was the other half of the problem.** `max-w-7xl` is 1280 px, so on a 2560 px
monitor the room rendered inside HALF the screen with empty gutters — most of what "does not
really scale well" was describing. Above 1920 it relaxes to **1760 px**, sized against the
widest real object rather than picked for looks: the KPI matrix at the big scale with a
nine-column year is 276 + 9x138 + 152 = **1670 px**, so at 1760 it finally fits with no
sideways scroll and the page still leaves real margin.

**Paper is always the small scale, pinned rather than inherited.** A print context evaluates
width media queries against the PAGE BOX, so `min-width: 1920px` would not match anyway —
but relying on that is relying on an engine detail. `@media print` re-declares every small
value, placed AFTER the big block so source order decides. What R1 measured onto a sheet
keeps landing on a sheet whatever monitor the dialog was opened from.

### The trailing-average switch (R3)
A labelled checkbox beside the chart card's `Years` filter, **default ON** — today's
behaviour, so nobody has to switch anything on to get back the page they know.

**Not a clickable recharts legend.** `<Legend>` takes an `onClick` and it was the first
idea; two things ruled it out. Its hit target is a ~10 px swatch that looks exactly like the
static legend it has always been, so nothing would say it can be clicked — and a control
that has to be discovered by clicking things is not a control. And it lives INSIDE the print
card, which would put chrome on the paper unless separately excluded. The switch instead
wears the same shape as the `Years` trigger it sits beside (same height, same border, same
type token), carries the page's OWN checkbox mark and a rule in the series' colour, and
being a sibling of `Years` is already inside the header's `data-print-hide`.

The line is **genuinely removed, not hidden**: recharts derives the legend from the children
it is given, so dropping the `<Line>` drops its legend entry with it and the chart reads as
one series rather than one series plus a blank key. That is also why print needs no rule of
its own — the paper gets whatever the chart was drawing.

**`canDrawAvg(spec, granularity)` is THE definition of when the line can exist at all** —
never at YEAR granularity (a 3-year mean over 7 points smooths away the only signal there
is) and never on the paired Block-price-vs-True-cost chart (four lines is noise). Where it
returns false the CONTROL is not rendered either: a toggle for a line that cannot exist is a
control that lies about what the page can do. **The paired chart carried no average before
this round and still carries none** — checked, not assumed.

Session state per card, matched deliberately to the `Years` filter beside it: both are one
card's exploration of one row rather than a description of the page's window, so neither
belongs in an address someone might share, and both start fresh because the card is keyed by
metric at both call sites.

### The master `Definitions` switch (R3)
Renzo: *"ability to toggle on and off the 'what it is' sections below the chart (could be a
master toggle instead)"* — and a master it is, for a reason the per-card version could not
meet: both matrices key an expand by metric, so a per-card setting would come back on the
moment a different row was opened, which is exactly when a reader who does not want the
prose would meet it again.

It sits beside `Per working day` wearing the same `Switch`, because both are one page-level
boolean that changes how every expand reads and two different shapes would suggest two
different KINDS of control. It lives in the URL as **`?dict=off`**, spelled only in the
non-default state (the R2 rule — the default view keeps a clean address and the param's
presence always means something), and is resolved server-side by `resolveDictionary` like
every other control. It IS in the URL, unlike the expand's own filters, because it describes
the whole page: it applies to every expand at once, so a shared link carrying it means the
same thing to whoever opens it.

It governs the two dictionary CARDS only. **Every row name keeps its own `Info` popover** —
that is the definition at the point of use, it costs no vertical space, and it is what a
reader scanning a grid actually reaches for. The blocks are not rendered when it is off, so
the panel is genuinely shorter (773 → 611 px measured) and a printed sheet carries what was
on screen rather than quietly re-adding two paragraphs the reader had put away. The
production room mounts its own `MetricExpand`, so the switch is threaded through
`ProductionRoom` too — otherwise half the page's expands would ignore it.

### Landscape print (R3)
`@page { size: A4 landscape; margin: 12mm }`. The right default rather than a preference,
because the card is a WIDE object: a four-across stat strip, a chart beside a 320 px side
rail, and a two-column dictionary grid. Measured under the real print rules, landscape keeps
the chart and rail two-column (`676px 320px`) and the stat strip at 246 px a cell; portrait
collapses the rail UNDER the chart (`lg:` is 1024 px, portrait's printable column is 703 px)
and squeezes the stats to 164 px. The margin came down 14 → 12 mm with the rotation because
landscape is the short dimension vertically and two millimetres are worth more as height.
`@page` cannot be scoped to a class, so it governs any print of the app — which today means
exactly this card, the only deliberate print path in the product.

### Verified in the browser (throwaway harness, since deleted)
The harness mounted the REAL `AnalyticsView` in the REAL shell class over synthetic data,
outside the authenticated route group, because `/analytics` itself cannot be reached
headlessly.

- **1512 px is byte-identical to before**, both themes: header 11.5 · row label 13 ·
  sublabel 11 · value 14 · delta 11 · band 11; widths 232/116/128, 232/128, 196/92/124,
  148/78/196/82/92, 184/92/124; container 1280; zero horizontal document overflow.
- **2560 px**: header 13.5 · label 15.5 · sublabel 13 · value 17 · band 13; row box 74,
  header row 42, band 33, value line 24; container 1760; KPI table **1670 inside a 1710
  frame — no sideways scroll**; campaign 1644, supplier 1372, grade 1358, premium 712 all
  inside the frame; chart 340, stat value 22, axis ticks 12; **zero truncated labels** (the
  two that ellipsised at 1512 both fit); zero horizontal document overflow.
- **Frozen panes at both scales**: the KPI name column stays `sticky / left: 0 / z-index 10`
  over a SOLID token and **drifts 0 px** with the periods scrolled 174 and 300 px; the
  supplier matrix's in-place expand resolves to `min(1710px, calc(...))` = 1372 px and
  drifts 0 px.
- **All three portals scale and stay inside the viewport**: the `Columns` popover (items 14,
  header 13), the row `Info` popover, the year `Select` (option 14).
- **375 px unchanged**: container 375, small scale, zero horizontal document overflow, every
  table scrolling inside its own wrapper.
- **Print, emulated by lifting every `@media print` rule into a live stylesheet**: `@page`
  reports `a4 landscape / 12mm`; the card lands at `top: 0, left: 0` at the full 1032 px
  printable width; the on-screen header and both `data-print-hide` controls are
  `display: none`; the paper-only title and restatement lines are `display: block`; the
  scale is **pinned small on paper** (`--bw-fs-14: .875rem`, `--an-chart: 260px`). A plain
  metric (RC OUT) is **0.96 of a page**; with `Definitions` off, Ending inventory is 0.91
  and Block price 0.73.
- **Both toggles**: the average line and its legend entry disappear together and come back
  (`aria-checked` follows); the paired row and YEAR granularity render no control at all;
  `Definitions` off removes both dictionary cards from the top matrix's expand AND from the
  production room's own expand, writes `?dict=off`, drops the param again when switched back
  on, and leaves all 44 row `Info` buttons in place.

### One platform-adjacent change (R3)
The shared drill-down chassis now reads the ambient type scale **with its own literal as the
fallback** — `DRILLDOWN_AXIS_TICK.fontSize`, the tooltip chrome, `DrilldownStat`,
`DrilldownSection`'s header and `BreakdownRail`'s rows. Unset, which is every Home Digest
surface, each resolves to exactly the value it always had; mounted inside `.bw-analytics` on
a wide screen, the same component grows with the page. `BreakdownRail.maxHeight` widened from
`number` to `number | string` so a rail can be sized off the same variable as the chart
beside it — a plain number still means px, so every existing caller is unchanged.

### The summary column
The trailing column folds the whole displayed window through **the row's own rollup rule**
(built as a synthetic `Period` so it goes down the same code path) — `2026` in M/Q view,
`All time` in Y view. Its comparison chip is the SAME fold over the prior year, because a
summary column has no "previous column" in view. A single "add the row up" column would
have been wrong on five of the twelve rows.

## Owner feedback round 4 — the restructure, 2026-09-02

Renzo's nine-item list, applied. **This is the round that changed the page's SHAPE**, so
where anything above disagrees with this section, this section is the authority.

| # | Asked for | Where it landed |
|---|---|---|
| 1 | Chart year filters default to the years WITH data | `metric-expand.tsx` + `supplier-expand.tsx` — a lazy initial hidden set, derived from the row's own history |
| 2 | Line metrics → line + gradient area | `metric-expand.tsx` → `MetricTrendChart`; bars untouched |
| 3 | Every expand behaves identically | The supplier expand gained a period checklist, an average switch, Print and the master dictionary; a real stat-strip mismatch was found and fixed |
| 4 | Optional price overlay on Purchase volume | `MetricExpandProps.priceOverlay`, default OFF, absent for a restricted role |
| 5 | Inventory value → weighted average unit cost | `metrics.ts` → `inventory_value` reads `avg_unit_cost_php_kg`; the ₱ total moved into the expand's rail |
| 6 | **Dissolve the Money section** | `MetricKey`, `MetricSection`, `SECTIONS`, the nav, the campaign panel — see below |
| 7 | Production gains Yield and Process loss | `metrics.ts` → `PRODUCTION_METRICS` |

### The calendar-vs-batch answer, and where it is recorded

Renzo: *"money is redundant, most of it is analyzable in the by-production-batch
section."* Confirmed, and the reason is a **CLOCK, not a duplication**: the money band's
**Block price** was the CALENDAR-month basis of the very figure the campaign panel
already publishes on the **CAMPAIGN** basis — the same fact read against two different
clocks. A campaign is the clock the plant actually runs on (AUGUST closed and SEPTEMBER
opened on 2026-08-29), so the calendar reading was the one that could go.

**That answer is now recorded at the point of use**, in the `title` of the campaign
panel's Block price row (`batch-cost-panel.tsx`), in as many words: *"Measured BY BATCH,
not by calendar months — a batch can straddle months… the same fact the old monthly Money
row carried, read on the clock the plant actually runs on."* It is in the row's hover
rather than only in this file because a reader meeting the panel for the first time is
exactly the person who asks the question.

### Where the eight money rows went

| Row | Fate |
|---|---|
| Block price (`delivered_fed_price`) | **RETIRED** — the campaign panel's own Block price row is the same fact on the right clock |
| ₱ per produced kg (`php_per_produced`) | **RETIRED** — the campaign panel carries it on BOTH bases (block price and true) |
| True ₱/kg closed (`closed_true_price`) | **RETIRED** — likewise, as `True ₱/kg fed` |
| Blocks closed (`closed_blocks`) | **→ campaign panel**, as a new row reading `CampaignCost.blocksClosed` |
| Closed-block loss (`closed_loss`) | **→ campaign panel**, where the existing `Weight lost` row (`lossPct`) already was it per campaign |
| Yield (`yield_rate`) | **→ Production band** |
| Avg stock age (`stock_age`) | **→ RC Inventory band** |
| Stock over 120 days (`over_120d`) | **→ RC Inventory band** |

**Nothing was dropped from the database and nothing was dropped from the payload.** Every
retired row's field still crosses the wire, still nulled by the same ₱ gate, exactly as
the four rows R1 retired do — `AnalyticsMonth` is unchanged, `queries.ts` is unchanged,
and no migration was written. The `MetricSpec.estimated` machinery (the `~` mark, its
hover, the callout gate) is also left in place with no row declaring it today.

**The two rails that explained the retired rows went with them** — `CoverageSplit` and
`ClosedBlocksSplit` in `metric-expand.tsx`. Keeping a rail nothing can open is dead code,
not a spare.

**Deep links survive.** The four digest drill-downs point at `market_price`, `net_flow`,
`rc_in_total`, `rc_out` and `purchase_volume` — checked, and not one of them names a
retired key. `inventory_value` also keeps its key despite the row being renamed, so a
link to it still resolves.

### A measured bug found while moving Yield: `yieldUsable`

A weighted rollup sums numerator and denominator INDEPENDENTLY, and the spine carries
months with fed kilos and **no production at all** (feedings begin 2024-01, production
reporting 2025-11). Yield's numerator was `producedKg × 100` and its denominator was
`fedKg` with no shared gate, so a quarter or a year spanning that boundary put ten
months of fed kilos into the denominator against two months of product in the numerator.
`dependsOn` could not save it and neither could the `num.had === 0` guard, because two
of the twelve months genuinely did report.

**This is the `intensityUsable` shape exactly**, one row later. Both halves of Yield and
of the new Process loss now gate on `yieldUsable(m)` — a month counts only if it has fed
kilos AND a produced figure. **Measured in the harness: the 2025 year column read the
correct 14.0% rather than the ~2.3% the ungated fold produced.**

**Process loss is `1 − yield`, and the complementarity is structural.** Its `read` is
literally `(1 − yieldPct) × 100`, so a month cell always sums to exactly 100 with the row
above it; its weighted rollup is `Σ(fed − produced) ÷ Σ fed`, which is algebraically
`1 − Σproduced ÷ Σfed`, so a quarter and a year do too. Measured: 14.0% + 86.0% = 100.0%
in every cell and in the summary column. It is a separate ROW rather than a hover on
Yield because a loss going up is the alarming reading of a yield going down, and a page
that prints only the cheerful half makes the reader do the subtraction.

### The stat-strip mismatch, found and closed

Renzo's screenshot showed an expand's `Selected` stat reading *"4/7 years · 45 months"*
beside a chart header reading *"44 settled months"*. They were **describing different
populations under labels that both said "months"**:

- `SelectionFold.periodCount` was `periods.length` — every period in the selection,
  **including ones carrying no figure at all**. On RC OUT with every year switched on it
  read 75 against 33 months in which anything was ever fed. A count like that under a
  total reading "23,388 t" invites exactly the wrong division.
- The chart header counted SETTLED periods, which additionally drops the in-progress
  one — hence 45 against 44.

Both now print ONE derived value, `withValue` = periods in the selection that carry a
figure. **It cannot disagree with the chart because it IS the chart's data** (`view.history`
is the series the chart is handed). Measured on RC OUT: the stat says `33 months with a
figure`, the header says `33 months with a figure`, and the chart draws **33 bars**.
`settled` still governs the Highest/Lowest population — a different question, and its own
hover says so.

### Smart year defaults — three properties that keep them honest

1. **derived, never dated** — a year is hidden when `withValue === 0` on that row's own
   history, so the default retires itself the moment a year gets a figure;
2. **visible and reversible** — the empty years are still listed, still toggleable, and
   each carries the `0/12` coverage count the control has always shown. The control's
   hover, the card's own note and the page footer all say the card opens this way;
3. **it can never hide everything** — a row with no figure in any year opens FULLY
   CHECKED, because an empty chart under an empty-state sentence the reader did not cause
   is worse than an empty chart.

Measured: RC OUT opens `3 of 7 years` (2024–2026), 2020–2023 hidden. The **matrix column
filter is deliberately unchanged** — its periods come from the zero-filled flow spine, so
"all" and "the ones with data" are the same set there.

### Area charts

A metric whose `chart` is `line` is drawn as a single `<Area>` carrying its own stroke —
**not** an area plus a line, which would claim two legend entries for one fact. Gradient
`0.28 → 0.02` in the series' own colour, with a `React.useId()` gradient id because two
expands can be mounted at once (the top matrix and the production room) and a duplicated
SVG `id` makes the second chart paint with the first one's fill.

**It cannot obscure anything, and that is ordering rather than luck.** The area is the
FIRST series child, so the comparison line, the trailing average and the price overlay are
all painted after it — verified with `compareDocumentPosition`. And the fill running to a
padded floor rather than to zero is safe for the same reason a price is a line and not a
bar in the first place: a line is read as a shape, so `paddedDomain` already governs its
axis. **Bars are untouched.**

### The price overlay (Purchase volume only)

`MetricExpandProps.priceOverlay` takes the Market price row **of the same
`buildMatrix` fold** rather than raw months, which is what makes the overlaid line
literally the numbers that row prints — same rollup, same per-working-day option, same
restriction. It rides its own right-hand `YAxis` (a ₱/kg and a tonnage share no scale),
dashed, drawn last, and the axis is only mounted while the toggle is on so an unused
gutter never eats chart width.

**The ₱ gate is structural.** A restricted row carries `null` in every cell because the
values never left the server, so the card renders no CONTROL at all — verified: for a
restricted role the toggle is absent, Market price and Stock avg cost are the two locked
rows, and **zero `₱<digits>` sequences appear anywhere on the page**.

### Stock avg cost

`inventory_value` keeps its key (deep links) and becomes **Stock avg cost · ₱/kg on
hand**, reading `view_analytics_inventory_eom.avg_unit_cost_php_kg` — the view's OWN
column, so nothing divides two published figures and invents a third definition of what a
kilo cost. It is a `periodEnd` rollup and a LINE (hence an area), and it is still
₱-gated.

The ₱ total is **not lost**: it is the numerator of the figure that replaced it, so it
moved into the expand's new `StockValueSplit` rail beside the kilos it is divided by,
with the valued/unvalued split that is the honest question about an average. The
population caveat is kept and restated — closed-block residue is still in the valuation,
which is 8.19% of the money — with the note that **being a ratio, that moves this figure
far less than it moved the total it replaced.**

### The universal module contract

Renzo: *"each module is something I look at and possibly report."* Audited, the supplier
expand was short four things and now has them, so all three expand surfaces (KPI matrix,
production room, supplier room) carry: a **period checklist** with the smart default, a
**stat strip that recomputes from it**, an **average switch**, **Print**, and the page's
**master `Definitions` switch**.

- The supplier card's axis is one year of MONTHS, so its checklist filters months
  (`foldSupplierSelection` in `lib/analytics/supplier.ts`). Every rule the year row obeys
  is obeyed there because it is the same arithmetic over a shorter list: the price is
  Σ pesos ÷ Σ priced kilos, the premium goes through `weightedPremiumPhpKg`, and **the
  share's denominator narrows with the selection** so a four-month share is a share of
  those four months. `SupplierCell` gained `phpTotal` for that fold — reconstructing it
  as `avgPrice × pricedKg` would have been almost right and quietly lossy.
- `printCard` moved out of `metric-expand.tsx` into **`app/(app)/analytics/print-card.ts`**
  so two cards share one mechanism rather than two copies that would drift.
- `AvgToggle` became the exported **`ChartToggle`** with the explanatory sentence as a
  REQUIRED prop: three call sites govern three different lines, and a default sentence
  would be wrong on two of them rather than merely vague.
- `SupplierRoom` gained `showDictionary` / `printScope` / `asOfDate`, threaded from the
  shell — it mounts its own expand, so without that one of the page's three expands would
  ignore a switch the other two obey.
- Measured on the sparse seller BRIX: `Months filter — 2 of 9 months shown`, all five
  stats carry `· selected`, 2 bars drawn, Print present, one dictionary block pair that
  the page-level switch removes and restores (with `?dict=off` round-tripping).

**The campaign panel is NOT an expand and did not gain the contract** — it has no
per-column detail card. It gained the two rows above and the calendar-vs-batch answer.

### Verified in the browser (throwaway harness, since deleted)

The harness mounted the REAL `AnalyticsView` in the REAL shell class over synthetic data,
at `app/dev/table-playground/analytics-r4/` — a NEW subdirectory beside the committed
Blackwood Table playground, which was not touched and is still there.

- **Restructure**: nav reads `RC Inventory · Campaigns · Suppliers · Production`; bands
  are `band-flow: RC Inventory` and `band-production: Production` only; RC Inventory
  carries Ending inventory, Stock avg cost, Avg stock age, Stock over 120 days; the
  campaign panel carries Weight lost and Blocks closed; Production carries Yield and
  Process loss; **no callout names a retired row**.
- **Smart defaults**: RC OUT opens 3/7 years; stat strip, chart header and drawn bars all
  read 33.
- **Area charts**: gradient stops 0.28/0.02, one legend entry for the series, the average
  line drawn after the area — at **1512 light** (container 1280, `--an-chart: 260px`,
  `--bw-fs-14: .875rem`) and **2560 dark** (container 1760, 340px, 17px), zero horizontal
  document overflow at both, and at 375 px.
- **Overlay**: off by default; on → 2 Y axes and `Market price (right)` in the legend;
  **restricted role → no toggle, no ₱ value anywhere**.
- **Yield weighting**: the 2025 year column reads 14.0%, not the ungated ~2.3%; Yield +
  Process loss = 100.0% in every cell and in the summary column.
- **Print**: `@page { size: a4 landscape; margin: 12mm }`, card at `top: 0 / left: 0`,
  on-screen header and both `data-print-hide` control groups `display: none`, scale pinned
  small on paper, paper-only title and restatement lines present.

## Owner feedback round 5 — reordering, filtering and reporting, 2026-09-02

Renzo's eight-item list, applied. **This round moved a section, removed two surfaces
and gave every group a filter, an order and a report.** Where anything above disagrees
with what follows, this section is the authority.

| # | Asked for | Where it landed |
|---|---|---|
| 1 | A visible line between every row | `.bw-row-rule` in `globals.css`; applied to the KPI matrix, the supplier matrix, the campaign panel and the grade mix |
| 2 | Drag-to-reorder rows within their section | `row-handle.tsx` + `use-row-order.ts` + `lib/analytics/row-order.ts`; the KPI matrix's two bands and the campaign panel |
| 3 | Print per metric group | `group-print.tsx`; a `Print N` action on each band, on the campaign panel and on the grade mix |
| 4 | Remove the callout strip and the two supplier footnote blocks | `analytics-view.tsx`, `supplier-premium.tsx`, `supplier-room.tsx` — UI only; every pure function survives |
| 5 | Grade rows expand like everything else | `grade-expand.tsx`, mounted in place by `production-grades.tsx` |
| 6 | The campaign panel gets its own checklist | `batch-cost-panel.tsx` mounts `PeriodFilter`; ordering comes from `lib/analytics/campaign.ts` |
| 7 | Production above Suppliers | `analytics-view.tsx` + `analytics-nav.tsx` |
| 8 | The batch filter drives the production months | `selectedCampaignMonths` → a second `buildMatrix` fold + `buildGradeYear`'s `monthFilter` |

### The divider is a BORDER ON THE CELLS, not on the row

The rows already carried `border-b`; `--border` is tuned for a card edge on the page
ground and disappears into four tables' worth of 62 px rows. `--bw-row-rule` is
`color-mix(in oklab, var(--foreground) 16%)` in light and **24% in dark** — the higher
value is deliberate, a hairline that reads on white vanishes on zinc-950.

**It is drawn on each `<th>`/`<td>`, and the frozen-pane rule is what decides that.**
These tables are `border-collapse: separate`, where a `<tr>` cannot paint a border at
all; and the first cell of every row is a sticky, fully OPAQUE frozen column sitting ON
TOP of scrolling cells, so a divider drawn as a background stripe or an overlay would be
interrupted at exactly that column. A border-bottom is carried by the frozen cell as
solidly as by a scrolling one. Specificity (`0,1,1`) beats `.border-b` with no
`!important`, so a `Σ` footer or a section band can still set a heavier rule of its own.
**Measured:** 36 rows in the KPI matrix, 10 in the campaign panel, 5 in the supplier
matrix and 3 in the grade mix, at 1 px, in both themes.

### Row order — persisted per browser, NOT in the URL, and stated

**The choice, and its reason.** Every other view control on this page is in the address
bar because each describes WHAT IS ON SCREEN — a link carrying one shows the recipient
the same figures. A row order is not that: it describes how one reader likes to read, it
changes no number, hides nothing, and pasting it into a colleague's browser would
silently rearrange a page they had already learned the shape of. It is also eight to ten
keys per section and would dominate an address whose whole point is to be legible. So:
`localStorage`, keyed `bw.analytics.roworder.v1.<scope>`, per browser, never in a link.
The page footer says so.

**Cross-section drags are unrepresentable rather than refused.** The order, the drag
state and the reset affordance all live inside `MatrixSectionRows`, one instance per
band, so a handle can only ever emit its own key and a drop can only ever resolve it
against its own band's order. **Measured:** dragging a Production handle onto a
RC Inventory row left both saved orders byte-identical.

**Keyboard is the same mechanism, not a second one.** The handle is a real `<button>`;
Arrow Up / Arrow Down call the same `move()` the pointer path ends in. **Measured:**
focus the Market price grip, press ↓, the row moves to position 2, the saved array
becomes `["purchase_volume","market_price",…]`, and the handle keeps focus with its
`aria-label` updated to "position 2 of 10".

**Two properties keep a save honest.** It is read in an EFFECT, never a lazy `useState`
initialiser — the server renders the registry order, so reading storage during render is
a hydration mismatch. And a save is a PREFERENCE, not a row list: `resolveOrder` drops a
key that no longer names a row and appends a row the save never heard of, so a row added
in a later round cannot be hidden by an order set today. Storage failing is not an error
state — a private window is "this reader has no saved order", which is the default.

**Reset is unobtrusive by construction**: it renders only once `isDefaultOrder` is false,
so a page nobody has reordered carries no control at all. **Measured:** present after a
move, gone after the reset, and the storage key removed rather than set to a default.

**Grade rows and supplier rows deliberately have NO handle.** Both print their own RANK
(#1 by tonnage), so a hand-sorted order would contradict the number in the row beside it.
Reordering is for METRIC rows, whose order is arbitrary; a ranked list already has one.

**The band's actions live in the FROZEN cell.** Measured and corrected during
verification: the band's hint `<td>` spans every period column, so anything
right-aligned inside it sits at the far end of a table 1,400 px wider than the viewport —
a Print button nobody can see is not a Print button. The frozen cell is the only part of
a band row that is always on screen, so `--an-w-name` grew **232 → 248** (small) and
**276 → 296** (big) to hold the grip, the label, the reset icon and the Print button.
Re-measured at 2560: the KPI table is **1690 px inside a 1712 px frame — still no
sideways scroll** — and **zero labels truncate**.

### Group print — the same mechanism, given more than one card

A group report is not a new kind of report: it is the card the per-row Print button
already produces, rendered once per row, in the group's current order, page-broken. The
per-row button is untouched.

**The cards are rendered OFFSTAGE WITH REAL LAYOUT, and that is measured rather than
stylistic.** `display: none` gives an element no box, `ResponsiveContainer` measures its
parent's box, and a print media query does not apply until the dialog is already open —
so the obvious `hidden print:block` sheet prints empty chart frames. The stage is instead
a real 1040 px column inside a zero-sized clipped `position: fixed` box; when `printCard`
tags it `data-print-ancestor` the existing print rules flatten it (`position: static`,
`width: auto`, `overflow: visible`) and the column lands at the top of the sheet exactly
as a single card does. It is mounted only while a print is in flight — ten recharts
instances is a real cost and is not paid for a button nobody pressed.

**`[data-print-page]` carries the break, not the card**, so the same card prints alone or
in a sequence without knowing which it is in; the LAST page takes `break-after: auto`,
because a trailing forced break is a blank final sheet.

**Measured under the real print rules** (every `@media print` block, including the ones
nested inside Tailwind's `@layer utilities`, lifted into a live stylesheet):
`@page { size: a4 landscape; margin: 12mm }`; the sheet at **top 0, left 0**; page breaks
reading **`page, page, auto`**; all six `data-print-hide` control groups `display: none`;
the on-screen card headers hidden and the paper-only titles shown; the scale **pinned
small on paper** (`--bw-fs-14: .875rem`, `--an-chart: 260px`). And with the dialog
stubbed: **RC Inventory 10 pages / 10 cards / 10 charts laid out (996 px where there is
no side rail, 664 px where there is), Production 8 / 8 / 8, Grade mix 3 / 3 / 3**, then
the stage unmounted, `bw-printing` removed and zero `data-print-ancestor` left behind.

**The campaign panel prints the TABLE, not cards** — it has no per-column detail card, so
its group print is the panel itself. That is why `printCard` gained the ability to mark
its own target: nothing on this page may wear `data-print-card` permanently except the
three expands, or a printed metric sheet would carry the campaign table with it.

### What was REMOVED, and what deliberately was not

**The callout strip is unmounted.** It sat between the controls and the grid, restating
in prose what the deltas under every value already say. **Only the UI went** —
`buildMatrix` still returns `callouts`, and `MatrixCell.calloutable` / `deltaQuotable` /
`yoyQuotable` are untouched, because that gate is not decoration: it is what stops an
estimate, a metric's first period, an unfinished period or an annotated figure being
quoted, and the row expand's Highest / Lowest stats read the SAME `comparable` predicate.
Deleting the fold to tidy a strip would have taken the honesty rules with it.

**Both supplier prose blocks are gone** — "Each row is measured against its OWN
months…", the big-sellers-sit-near-market paragraph, and "A cell is tonnes bought…".
**Not one fact went with them.** Each already existed at the point of use: the premium
header says the comparison is against "the months THEY sold in", the `year ₱…/kg` chip
carries the context hover, every row hover spells out the weighting, the `Weighted`
footer PRINTS the ₱0.00 identity rather than asserting it, the `Supplier` header and the
`Premium & discount` heading both carry the dictionary popover, and the `Σ market` row's
own hover states that it is the matrix's published figure rather than a sum.

**The supplier TRUNCATION warning survives** and is now its own conditional line. It is
not documentation — it is a fact about THIS read, it appears nowhere else, and a supplier
list quietly short of the real one is exactly what a reader must be told.

### The batch checklist, and the one thing it must not sort by

`PeriodFilter` mounted a fourth time, in the campaign panel's header, labelled `Batches`.
The options are `campaigns` **in payload order**, and that is the whole sorting story:
the adapter already orders them chronologically by the month their NAME spells, so the
checklist reads JAN → DEC within each year and matches the columns beside it exactly.
**Alphabetical — APRIL, AUGUST, DECEMBER — is the obvious bug and is unrepresentable
here**, because nothing in the component re-derives an order. `campaignSeq` moved from
`queries.ts` (which is `server-only`) into the pure `lib/analytics/campaign.ts` so the
server sort and the client list are ONE definition rather than two that could drift.

`PeriodFilter` gained an optional `nounPlural`, because the fallback produced *"9 of 9
batchs shown"* in the control's accessible name — a label a screen reader would say out
loud. **Measured:** `Batches filter — 9 of 9 batches shown`, options JANUARY 2026 →
SEPTEMBER 2026, everything checked, `All` / `None` unchanged.

It is IN the URL as **`?bhide=`**, spelled exactly like `hide` and resolved by the same
codec, because it decides what is on screen — the panel's columns AND the production
band's months — so a link carrying it shows the recipient the same figures. **Measured:**
a `?bhide=` link renders the narrowed panel and the narrowed production band on the FIRST
paint.

### The linkage, and the honest edge it states out loud

`selectedCampaignMonths(campaigns, hidden)` returns the `YYYY-MM` months the selected
batches ran in, or **`null` when nothing is switched off** — `null` is not "every month",
it means there is no filter, which is what lets the production band reuse the page's own
matrix object rather than building an identical second fold under a different name.

**A campaign's month span is a UNION of its fed range and its NAMED month**, deliberately
rather than a fallback. The fed range is the truthful span when it exists and it
routinely straddles a boundary; but SEPTEMBER 2026 has produced and not yet been fed, so
its `first_fed_date` is NULL and a fed-range-only rule would make the current campaign —
the one a reader is most likely to pick — filter the band down to nothing.

The production band is a SECOND `buildMatrix` fold with the same options and only a
different hidden set, so a production cell prints the number it would have printed
unfiltered, and the summary column honestly re-folds and renames itself `Selected`
exactly as the column checklist already makes it do. The grade mix takes the same set as
`buildGradeYear`'s `monthFilter`, where the year column is still a plain sum of the
columns shown and the share's denominator is still the months' published `producedKg`.
The room's four chips narrow with it, because a chip quietly reading the whole year
beside a filtered grid would be the page disagreeing with itself.

**A MONTH IS ATOMIC HERE, and the production band says so at the point of use.** Downtime
and electricity are metered by calendar month while a batch straddles months, and nothing
in the database attributes a meter reading to a campaign — so a month overlapping a
SELECTED and an UNSELECTED batch is shown WHOLE. Splitting it would mean inventing a
per-batch share of a reading that was never taken per batch. The note also points at the
campaign panel for output and yield PER BATCH, which is the R4 calendar-vs-batch answer
read in the other direction: R4 retired the money band because the campaign was the right
clock for a cost; this band is the one place the calendar clock is still the right one.

**Measured:** with only JULY 2026 selected (fed 2026-06-28 → 2026-07-27), the panel shows
one column, the production matrix shows `JUN · JUL · SELECTED`, the grade mix shows
`JUN · JUL · 2026`, the note reads *"Filtered to 1 of 9 batches — 2 calendar months in
all"*, and the RC Inventory band is untouched at its full nine columns.

### The new page order, and the call behind it

**RC Inventory → Campaigns → Production → Suppliers.** Production moved above Suppliers
not for taste but because item 8 makes the campaign checklist DRIVE the production band's
months, and a control and the thing it controls cannot have an unrelated section between
them — a reader who unticks four batches has to see what that did without scrolling past
the whole supplier room. The two now read as one thought: the batch basis, then the
calendar months those batches ran in.

**Suppliers reads last on its own merits**: it is the only block that answers "who", it
is the widest (a matrix, a premium table and a chart), and nothing else on the page
depends on it. The anchor row moved with the sections — an anchor row that does not match
the page's order is worse than no anchor row. **Measured:** nav reads
`RC Inventory · Campaigns · Production · Suppliers`, and the anchor targets are at 183 /
946 / 1607 / 2820 px in that order.

### Grade expands — the universal module contract, completed

The grade mix was the last table on the page a reader could not open. `GradeExpand`
carries all five things R4 defined the contract as: a **month checklist with the smart
default** (it opens on the months that grade was actually run — derived from the row's
own cells, never a date; the empty months still listed with their tonnage and one click
away; and it can never hide everything), a **stat strip that re-folds from it** (`Made`,
`Share`, `Best month`, `Bags`, every label carrying `· selected` while filtered), an
**average switch**, **Print**, and the page's **master `Definitions` switch**.

Bars are tonnes on a zero-floored axis; the dashed line is the grade's share of each
month on its OWN axis **fixed 0–100**, because a share is a share of the whole and
letting recharts auto-scale it would make a grade that never exceeds 20% look like it
fills the plant. The rolling average is nulled-then-averaged-then-dropped, the same order
the KPI expand uses, so it **breaks at a hidden month** rather than drawing across one;
`rollingMean` and `rollingWindowFor` are imported from `matrix.ts` rather than
re-implemented.

**The arithmetic is not repeated.** Monthly shares are SQL's own, and `foldGradeSelection`
lives in `lib/analytics/production.ts` beside the fold the table itself uses. **The
share's denominator narrows with the selection** (the months' published `producedKg`,
never a sum of the grade rows), so a four-month share is a share of those four months.
**No ₱ exists in the card and none is derivable**, so there is no gate and no restricted
variant. **Measured on 4X8** (deliberately absent from three months in the fixture): the
card opens `6 of 9 months`, draws 6 bars and 2 lines, every stat carries `· selected`, and
the panel is pinned to the visible frame at 1136 px with zero document overflow.

### Verified in the browser (throwaway harness, since deleted)

The harness mounted the REAL `AnalyticsView` in the REAL shell class over synthetic data,
at `app/dev/table-playground/analytics-r5/`, and resolved `?hide=` / `?bhide=` from
`searchParams` exactly as `page.tsx` does so the server round-trip was exercised rather
than assumed. The committed Blackwood Table playground beside it was not touched.

- **Dividers**: 36 / 10 / 5 / 3 rows across the four tables, 1 px, `0.16` alpha light and
  `0.24` dark, carried by the frozen cell, which stays fully OPAQUE (no alpha in its
  computed background) at both scales.
- **Reorder**: keyboard ↓ moves and persists; a synthetic drag moves and persists; a
  cross-band drag is a no-op on both saved orders; the order survives a reload; `Reset`
  restores the registry order, clears the key and removes itself.
- **Group print**: 10 / 8 / 3 pages with every chart laid out, `page, page, auto` breaks,
  controls hidden, paper titles shown, scale pinned small, stage unmounted and every mark
  cleared afterwards.
- **Removals**: zero `ul.stagger-fast` (the callout strip), and neither *"Each row is
  measured against its OWN months"* nor *"A cell is tonnes bought"* appears in the
  document.
- **Batch filter**: chronological JAN → SEP, all checked, `?bhide=` round-trips through a
  fresh server render, and the production matrix + grade mix follow it while RC Inventory
  does not.
- **Scales**: 1512 light (name column 248, zero document overflow), 2560 dark (container
  1760, table 1690 in a 1712 frame, zero truncated labels, zero overflow), 375 (container
  375, every table scrolling inside its own wrapper, zero overflow — including with both a
  metric expand and a grade expand open, each pinned at 349 px).

## Dependencies

- `lib/analytics/*` (own), `lib/auth.ts` (`canViewPrices`), `lib/supabase/server.ts`
- `components/ui/{popover,select,switch}`, `lib/utils` (`cn`), `recharts`, `lucide-react`,
  `next/link` (only the unmounted watchlist still imports it)
- `components/digest/drilldown/drilldown-modal.tsx` — `DrilldownSection` (whose optional
  `action` header slot R2 added), `DrilldownStat`, `DRILLDOWN_AXIS_TICK`,
  `drilldownTooltipChrome`
- `components/digest/drilldown/series-parts.tsx` — `BreakdownRail`, `RailItem`

**What imports THIS module:** nothing. The four digest drill-downs link to `/analytics`
by href only (`rc-in`, `rc-in-price`, `rc-out`, `flow` — each deep-links its own
`?metric=`), which is a URL, not an import.

`VolumeSeriesChart` is deliberately NOT reused: `VolumePoint.value` is `number` and this
page's whole point is that a missing figure is a GAP (RC OUT has none before 2024, and 42
zero-height bars would assert the plant fed nothing), and its rolling-mean legend is
hardcoded to day/month while these buckets are months, quarters or years.

## See Also
- `.agents/plans/ictc-analytics-dashboard-plan.md` — the plan, the analyst audit, P1–P4 (complete)
  and **§6, OWNER FEEDBACK ROUND 1 APPLIED**
- `supabase/migrations/20260901142417_analytics_phase4_production_layer.sql` — the P4
  dictionary's source, and the four measured hazards each companion column exists for
- `app/(app)/production/CONTEXT.md` — the module the production band reads, and the reason
  there is no ₱ in it
- `supabase/migrations/20260901115129_analytics_phase1_data_layer.sql` — the P1 metric dictionary's source
- `supabase/migrations/20260901124822_analytics_phase2_money_layer.sql` — the P2 dictionary's source,
  and the full column-by-column reasoning behind the money layer
- `supabase/migrations/20260901133909_analytics_phase3_supplier_layer.sql` — the P3 dictionary's
  source, and the proof that the supplier breakdown and the monthly matrix cannot disagree
- `app/(app)/inventory/blocking/CONTEXT.md` — the screen the Ending inventory row now ties to,
  and the unmounted watchlist's old link destination (`?block=`)
- `app/(app)/inventory/rc-movement/CONTEXT.md` — the `view_rc_movement_*` family every P2
  money figure is lifted from, unchanged
- `app/(app)/CONTEXT.md` — the Home Digest, the daily gateway that links here
- `components/digest/CONTEXT.md` — the drill-down chassis this page borrows its chart chrome from
- `components/NAVBAR.md` — the breadcrumb + module-list registration
