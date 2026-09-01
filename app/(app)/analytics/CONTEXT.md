# Analytics Module — ICTC Owner KPI Matrix (`/analytics`)

> **OWNER FEEDBACK ROUND 1 APPLIED — 2026-09-01.** Renzo read the live page and gave a
> ten-item list. Everything below already reflects it; the round's own summary is the
> section **"Owner feedback round 1"** near the end of this file, which is the place to
> look for *what changed and why* rather than *what the page is*.
>
> **OWNER FEEDBACK ROUND 2 APPLIED — 2026-09-02.** One feature: **the period filter** —
> a checklist on the matrix columns and a second one on each row expand's history chart.
> See **"Owner feedback round 2 — the period filter"** near the end of this file.

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

**A slim sticky anchor row** (`analytics-nav.tsx`) sits above the controls: Overview ·
Money · Campaigns · Suppliers · Production.

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
| `page.tsx` | **Server Component.** Awaits `getAnalyticsData()`, resolves the OPENING view from `searchParams` (`year` · `g` · `wd` · `metric`) and hands both to the client shell. Owns nothing else — no heading (the navbar owns the title), no aggregation, no gate of its own beyond the adapter's. Fetch inside `try/catch`, render outside it. |
| `analytics-view.tsx` | **Client shell.** Owns the four view controls (year `Select`, Y/Q/M toggle, **Compare chip toggle**, per-working-day `Switch`), the anchor row, the live block-utilization chip, the callout strip, the matrix, **the campaign panel, the supplier room, the production room** and the restatement footer. Calls `buildMatrix()` in a `useMemo`. It renders `AnalyticsMatrix` for the `flow` + `money` bands only, and passes the expand panel INTO it; the `production` band is rendered by `production-room.tsx` from the SAME fold. |
| `analytics-matrix.tsx` | **The matrix table** — a bespoke dense table (see "Why not the Blackwood Table"). Frozen KPI-name column, explicit `<colgroup>` widths, `width: max-content` inside `overflow-x-auto`, a trailing summary column, **section bands** (anchor targets, `id="band-<key>"`, wearing the section accent as a left border), an optional `sections` filter so the component can be mounted twice, the `~` / `·` / `⚠` cell marks, the green/red direction tint, and **the in-place expand row** (`colSpan` over every column, panel `sticky left-0` at the scroller's measured width). |
| `analytics-nav.tsx` | **The in-page anchor row.** Sticky (`top-0 z-40`), glass, **five** links, active section observed with an `IntersectionObserver` and claimed instantly on click. A flow element, so pinning it shifts nothing. |
| `metric-expand.tsx` | **The row expand**, rendered IN PLACE inside the matrix, in a full-width row directly beneath the row that was clicked. Stat strip + full-history chart (bar or line, **plus the dashed comparison line where a row declares a pair**) + one of six side rails (inventory split · price coverage · closed blocks · aging bands · downtime · power) + the dictionary spelled out + **a Print button** that prints just this card. Reuses `DrilldownSection` / `DrilldownStat` / `BreakdownRail` / `DRILLDOWN_AXIS_TICK` / `drilldownTooltipChrome` from the drill-down chassis. |
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
| `period-filter.tsx` | **R2 — THE checklist popover, written once, mounted twice.** The matrix's period columns and a row expand's chart years. Trigger + `All` / `None` + a dense scrollable list of `role="checkbox"` buttons; Radix Popover gives Esc and focus-return for free. Its state is the set of **hidden** keys, never the selected ones — which is what makes "always default to all checked" a property of the shape. |
| `analytics-error.tsx` | Persistent, copyable load-failure banner (the project's HARD RULE applies to every error surface, not only toasts). |

### The shared library (`lib/analytics/`)

| File | Role |
|------|------|
| `types.ts` | The contract — `AnalyticsMonth`, `CampaignCost`, `BlockUtilization`, `SupplierMonth`, `SupplierData`, `ProductionGradeMonth`, `ProductionGradeData`, `AnalyticsData`. (`AgingWatchItem` / `AgingWatchlist` are still declared but no longer on `AnalyticsData` — see the unmounted watchlist above.) Portable (no React, no Supabase, no `server-only`). **`null` is never 0 in this shape**, and the two unit conventions (fractions vs percents) are stated at the top. |
| `metrics.ts` | **THE metric registry + dictionary.** One entry per row: label, unit, `read`, `rollup`, `deltaMode`, `perWorkingDay`, `price`, `section`, `dependsOn`, `estimated`, **`annotate`**, an optional comparison `pair`, chart shape/colours, decimals, and the plain-language definition. Also owns **`SECTION_ACCENT`** — the one place the five block colours are named. Pure, client-safe. |
| `matrix.ts` | **The pure fold** — period axis, cells, deltas (percentage AND `deltaAbs`), YoY, the trailing summary column, the full history series, the pair history, the per-period annotations, the section grouping and the callouts, all in ONE pass over the same numbers. Also owns `ComparisonMode` / `COMPARISON_MODES`. Pure, client-safe. |
| `supplier.ts` | **P3 — the supplier fold + its dictionary.** `buildSupplierYear` (columns, rows, YTD, concentration), `buildExplorer`, `SUPPLIER_DICTIONARY`, and **`weightedPremiumPhpKg` — the ONE function that aggregates `premium_php_kg` anywhere in the codebase.** Pure, client-safe. |
| `production.ts` | **P4 — the grade fold + its dictionary.** `buildGradeYear` (columns, grade rows, YTD, the checked Σ tie, the top-grade read) and `PRODUCTION_DICTIONARY`. Pure, client-safe. |
| `period-selection.ts` | **R2 — the hidden set's URL codec** (`NO_HIDDEN`, `serializeHidden`, `parseHidden`). A separate module from `period-filter.tsx` for one reason: that file is `"use client"`, and a plain function exported from a client module becomes a client REFERENCE, so the Server Component calling it would fail at request time rather than at build time. Pure, importable from both sides. |
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

### The twenty-two rows, and the rollup rule each one ships with

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
Year, granularity, the working-day toggle, the comparison chip, the expanded metric and
(R2) **the hidden period columns (`hide`)** are **React state that writes itself into the
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

**Section bands.** Twenty rows in one undifferentiated stack is a wall, so `groupBySection`
splits them into `Volume & stock`, `Money` and `Production` (declared on
`MetricSpec.section`, ordered by `SECTIONS`), and takes an optional `only` list so the same
component can render the first two bands at the top and the third in the production room.
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

### The anchor row (P4)
`analytics-nav.tsx` — five links, `sticky top-0 z-40`, the canonical glass pattern
(`bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60`), legal here
because it floats over empty page background rather than over scrolling table cells (which
are opaque, above). **z-40 and not 30**: the frozen-pane scale tops out at 30
(`.frozen-corner`) and a sticky table corner shares the root stacking context with this bar,
so at equal z the later element in the DOM would win.

Two of the five anchors are the matrix's own **band rows** (`id="band-flow"`,
`id="band-money"`), which is deliberate: Overview and Money are bands of one table, not
blocks of their own, and pointing at the same table twice would be a lie about its shape.
Every target carries `scroll-mt-24` to clear the bar. **No layout shift** — sticky never
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

### The summary column
The trailing column folds the whole displayed window through **the row's own rollup rule**
(built as a synthetic `Period` so it goes down the same code path) — `2026` in M/Q view,
`All time` in Y view. Its comparison chip is the SAME fold over the prior year, because a
summary column has no "previous column" in view. A single "add the row up" column would
have been wrong on five of the twelve rows.

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
