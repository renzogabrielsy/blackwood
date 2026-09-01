# Analytics Module — ICTC Owner KPI Matrix (`/analytics`)

## Purpose
The **month-on-month room**. `/` (the Home Digest) answers *"what happened today"*; this
answers *"what has been happening"* — twenty KPI rows × period columns, with a Y/Q/M
toggle, a per-working-day normalisation, a metric dictionary at the point of use, an
auto-generated callout strip and a per-row trend expand — plus, below the matrix, the
**campaign-basis money panel** and the **live aging watchlist**.

Renzo, 2026-09-01: *"a tool where I can monitor daily the KPIs we want to observe month on
month… This is a custom Dashboard FOR ME. For MY brain."* Plan:
`.agents/plans/ictc-analytics-dashboard-plan.md` (§4 — **P1, the matrix**; **P2, the money
layer**).

> **Domain module (charcoal tenant).** It reads seven charcoal-shaped SQL views. Nothing
> in `components/shared/` or `components/ui/` learns anything from it. The ONE platform
> file it touches is `components/digest/drilldown/drilldown-modal.tsx`, and only to widen
> `footerLink` from an object to "object or array" so a digest tile can offer a second
> destination.

## Files

| File | Role |
|------|------|
| `page.tsx` | **Server Component.** Awaits `getAnalyticsData()`, resolves the OPENING view from `searchParams` (`year` · `g` · `wd` · `metric`) and hands both to the client shell. Owns nothing else — no heading (the navbar owns the title), no aggregation, no gate of its own beyond the adapter's. Fetch inside `try/catch`, render outside it. |
| `analytics-view.tsx` | **Client shell.** Owns the three view controls (year `Select`, Y/Q/M toggle, per-working-day `Switch`), the live block-utilization chip, the callout strip, the matrix, the expanded row, **the campaign panel, the watchlist** and the restatement footer. Calls `buildMatrix()` in a `useMemo`. |
| `analytics-matrix.tsx` | **The matrix table** — a bespoke dense table (see "Why not the Blackwood Table"). Frozen KPI-name column, explicit `<colgroup>` widths, `width: max-content` inside `overflow-x-auto`, a trailing summary column, **section bands** and the `~` / `·` cell marks. |
| `metric-expand.tsx` | **The row expand**, rendered BELOW the table. Stat strip + full-history chart (bar or line, **plus the dashed comparison line where a row declares a pair**) + one of four side rails (inventory split · price coverage · closed blocks · aging bands) + the dictionary spelled out. Reuses `DrilldownSection` / `DrilldownStat` / `BreakdownRail` / `DRILLDOWN_AXIS_TICK` / `drilldownTooltipChrome` from the drill-down chassis. |
| `metric-info.tsx` | **The metric dictionary** at the point of use — an `Info` button per row with the whole entry as a native `title` (hover) and a `Popover` card (click). Copy comes from `METRICS[].dictionary`. |
| `batch-cost-panel.tsx` | **P2 — the BATCH basis.** One column per production campaign, nine rows (fed · delivered ₱/kg · true ₱/kg · **cost of storage time** · weight lost · produced · yield · ₱/produced kg on both bases) plus a `blocks closed / priced` coverage line. Frozen row-label column, opens scrolled to the newest campaign. |
| `aging-watchlist.tsx` | **P2 — the LIVE list.** SQL-owned headline (open stock · weighted age · % over 120d · oldest pile), the ten oldest open piles with a `Show all N` toggle, each row deep-linking to `/inventory/blocking?block=<block_loc>`, and the closed-residue (resiko) disclosure. |
| `analytics-error.tsx` | Persistent, copyable load-failure banner (the project's HARD RULE applies to every error surface, not only toasts). |

### The shared library (`lib/analytics/`)

| File | Role |
|------|------|
| `types.ts` | The contract — `AnalyticsMonth`, `CampaignCost`, `AgingWatchItem`, `AgingWatchlist`, `BlockUtilization`, `AnalyticsData`. Portable (no React, no Supabase, no `server-only`). **`null` is never 0 in this shape**, and the two unit conventions (fractions vs percents) are stated at the top. |
| `metrics.ts` | **THE metric registry + dictionary.** One entry per row: label, unit, `read`, `rollup`, `deltaMode`, `perWorkingDay`, `price`, `section`, `dependsOn`, `estimated`, an optional comparison `pair`, chart shape/colours, decimals, and the plain-language definition (derived from the view COMMENTs in the P1 and P2 migrations). Pure, client-safe. |
| `matrix.ts` | **The pure fold** — period axis, cells, deltas, YoY, the trailing summary column, the full history series, the pair history, the section grouping and the callouts, all in ONE pass over the same numbers. Pure, client-safe. |
| `format.ts` | Display formatters, the blank-reason hover copy and the estimate hover. Presentation only. |
| `queries.ts` | **The server-only ADAPTER.** Reads the seven views + the live blocking grid, applies the ₱ gate and the two honest nullings, returns `AnalyticsData`. |

## Data

**Seven views + one live read.** All seven analytics views are `security_invoker`,
`authenticated`-only, **not** granted to `service_role` (the sync worker reads none of
them — L-044's arrow direction). Migrations
`20260901115129_analytics_phase1_data_layer` (+ the scalar fix `20260901115314`) and
`20260901124822_analytics_phase2_money_layer`.

| View | Grain | Rows | Feeds |
|------|-------|------|-------|
| `view_analytics_rcin_monthly` | month with ≥1 delivery | 49 | Market price ₱/kg · Purchase volume · Active suppliers · Sundry re-entry |
| `view_analytics_flow_monthly` | **every** month, zero-filled — the complete spine | 75 | RC IN total · RC OUT · Net flow · Working days |
| `view_analytics_inventory_eom` | every month of the spine | 75 | Ending inventory · Inventory value ₱ · Runway · Active batches |
| `view_analytics_cost_monthly` | every month of the spine | 75 | Delivered ₱/kg fed · ₱ per produced kg · Yield · Blocks closed · Closed-block loss · True ₱/kg |
| `view_analytics_aging_eom` | every month of the spine | 75 | Avg stock age · Stock over 120 days · the watchlist HEADLINE |
| `view_analytics_batch_cost` | one row per campaign per year | 32 | the whole batch-cost panel |
| `view_analytics_aging_watchlist` | one row per open pile > 1 t (**LIVE**) | 170 | the watchlist rows |
| `view_blocking_grid` | one row per active batch (**LIVE**) | ~500 | the "148/220 blocks occupied · TODAY" chip |

**Unwindowed on purpose.** CLAUDE.md's trailing-400-day idiom governs DAILY views, where
PostgREST's 1000-row ascending truncation silently eats the newest days. These are
MONTHLY / campaign grains at 32–170 rows — an order of magnitude or two under the cap —
and a month-on-month matrix that could not reach 2024 would not be the thing that was
asked for. The watchlist is the only read anywhere near the cap, so it carries a
`truncated` flag and the panel says so when it trips.

### The twenty rows, and the rollup rule each one ships with

| # | Row | Unit | Rollup (Q / Y / summary column) | Δ mode | ÷ working days? | ₱-gated |
|---|-----|------|--------------------------------|--------|-----------------|---------|
| 1 | Market price | ₱/kg | **weighted** — Σ `market_php_total` ÷ Σ `market_priced_kg` | % | no | **yes** |
| 2 | Purchase volume | t | sum | % | **yes** | no |
| 3 | Active suppliers | count | **peak** — the busiest constituent month | abs | no | no |
| 4 | Sundry re-entry | t | sum | % | **yes** | no |
| 5 | RC IN total | t | sum | % | **yes** | no |
| 6 | RC OUT | t | sum | % | **yes** | no |
| 7 | Net flow | t | sum | **abs** (a net crosses zero — % of last month's net is meaningless) | **yes** | no |
| 8 | Ending inventory | t | **period-end** | % | no | no |
| 9 | Inventory value | ₱ | **period-end** | % | no | **yes** |
| 10 | Runway | days | **period-end** | abs | no | no |
| 11 | Active batches | count | **period-end** | abs | no | no |
| 12 | Working days | days | sum | abs | no | no |

**Section `money` — P2.** Every row below is blank before 2024-01 (`dependsOn: outflow`);
the two ₱-per-produced rows are also blank before 2025-11 (`dependsOn: production`).

| # | Row | Unit | Rollup (Q / Y / summary column) | Δ mode | ₱-gated |
|---|-----|------|--------------------------------|--------|---------|
| 13 | Delivered ₱/kg fed | ₱/kg | **weighted** — Σ (covered ₱/kg × fed kg) ÷ Σ fed kg | % | **yes** |
| 14 | ₱ per produced kg | ₱/kg | **weighted** — Σ (covered ₱/kg × fed kg) ÷ Σ produced kg | % | **yes** |
| 15 | Yield | % | **weighted** — Σ produced ÷ Σ fed (×100 on the numerator) | **abs** (percentage POINTS) | no |
| 16 | Blocks closed | count | sum | abs | no |
| 17 | Closed-block loss | % | **weighted** — Σ kg lost ÷ Σ kg delivered | **abs** (crosses zero) | no |
| 18 | True ₱/kg (closed) | ₱/kg | **weighted** — Σ (true ₱/kg × priced fed kg) ÷ Σ priced fed kg | % | **yes** |
| 19 | Avg stock age | days | **period-end** | abs | no |
| 20 | Stock over 120 days | % | **period-end** | abs | no |

**Rows 13 and 14 READ the `_covered` figure, always.** At 100% coverage
`delivered_php_kg_fed_covered` is byte-identical to the published `delivered_php_kg_fed`
(checked on all 75 months), so this is not a second definition — it is the same one, made
honest on the seven months where the published figure is silently understated by
untraceable kilos. Row 14's monthly value equals `php_per_produced_kg` exactly when
coverage is 100 and `php_per_produced_kg_covered` exactly when it is not.

**Row 18 is NULL-strict and its rollup weights by FED kilos**, the same weighting its own
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
respects the impersonation cookie) and NULLS **22** fields before the payload leaves the
server — the four P1 ones (`market_avg_price`, `market_php_total`, `ending_value_php`,
`avg_unit_cost_php_kg`) plus the eight on `view_analytics_cost_monthly`, the eight on
`view_analytics_batch_cost` and the two on `view_analytics_aging_watchlist`. The complete
list is in the adapter's header, copied from the migrations' own COMMENTs.
`view_analytics_flow_monthly` and `view_analytics_aging_eom` carry no ₱ and none is
derivable from either — which is why **the whole aging story stays visible for the
Production role**, including the watchlist's ages, kilos and locations.

The client receives `canViewPrices: boolean`; a ₱ row renders a lock badge and a `—` in
every cell, its expand shows the restricted panel (the same treatment
`rc-in-price-drilldown.tsx` uses), the campaign panel's four ₱ rows read `restricted`, and
the watchlist's two ₱ columns render a lock. **Callouts skip restricted rows entirely**,
so no sentence about a peso can be composed for a role that may not see one.

### The three honesty behaviours the page OWES its reader
1. **`ending_kg` is a NET with a disclosed hole.** ~−3,200 t across 77 batches carrying a
   negative balance — charcoal fed out under one batch name whose arrival was booked under
   a different spelling of it. **Misattribution, not evaporation.** The split
   (`positive_balance_kg` / `negative_balance_kg` / `negative_batch_count`) is a
   `BreakdownRail` in the row's expand, with the explanation beside it.
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
  The rule is now applied once, to all three kinds.

All three gates are **callout-only**: every one of those cells still renders, still
carries its delta, and still explains itself in its hover. The row expand's
Highest / Lowest stats read the SAME gate (`comparable`), so the strip and the drill-down
can never name different periods; the chart still draws everything, and the stat's hover
says how many settled periods were held out and why.

There is **no colour semantics anywhere on the page**: a delta is a direction glyph
(▲ ▼ ·) and a muted number. The plan withholds threshold colouring until Renzo states real
targets, and a rising purchase price is not "up" in the cheerful sense.

### View state
Year, granularity, the working-day toggle and the expanded metric are **React state that
writes itself into the URL** with `window.history.replaceState`. The house rule (URL params
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
   scrolling table (~1,500px).

Twelve rows also means virtualisation buys nothing. The bespoke table still obeys both
platform layout rules: **"never crush, always scroll"** (`table-fixed` + `width:
max-content` + a full `<colgroup>` of explicit widths + `overflow-x-auto`, no flexible
column) and **frozen panes are OPAQUE** (the KPI-name column is `.frozen-col` + `.frozen-edge`
over scrolling cells, paints a solid token and repaints its hover/selected state solidly).
The header row is deliberately NOT sticky-top: the table never scrolls vertically inside
its own box, so there would be nothing to pin against.

Widths: name **208px**, each period **100px**, the summary column **112px**; `minWidth`
is their sum. The campaign panel is the same discipline: label **208px**, each campaign
**116px**. No 57px header-chrome budget applies — that tax is the Blackwood Table's
`scope="focus"` hover-revealed sort/filter siblings, which a bespoke `<th>` does not have.

**Section bands.** Twenty rows in one undifferentiated stack is a wall, so `groupBySection`
splits them into `Volume & stock` and `Money` (declared on `MetricSpec.section`, ordered by
`SECTIONS`). The band's label cell is `.frozen-col` like every other cell in that column —
a band that scrolled away would leave the rows under it unlabelled exactly when the reader
is furthest from the header.

### The two panels below the matrix, and why they are not matrix rows
- **The campaign panel is a different AXIS.** A campaign crosses month boundaries (AUGUST
  closed and SEPTEMBER opened on 2026-08-29), so folding it in would mean a column that is
  neither a month nor a quarter sitting beside columns that are. It also has a genuinely
  different star number: `upliftPhpKg`, the cost of storage time, which only exists per
  campaign. Its spine is `campaign_options UNION campaign_yield`, so a campaign that has
  produced but not yet been fed still gets a column — SEPTEMBER 2026 is exactly that today.
  Column order is (year, month index of the batch NAME), **never `first_fed_date`**, which
  is NULL for such a campaign.
- **The watchlist is a different GRAIN** — one row per named pile, today, not one column
  per period. Its headline (`open_kg`, `wtd_age_days`, `pct_over_120d`, `oldest_age_days`)
  comes from the newest `view_analytics_aging_eom` row and is **not summed from the visible
  rows**: that view covers the same population, was measured equal to the kilo, and
  re-adding it in TypeScript would be a second definition of how much charcoal is in the
  yard — and a wrong one the moment the list is capped.
  - **"Open" is `status <> 'CLOSED'`, deliberately wider than IN-USE.** Only three piles
    over a tonne are actively being fed (92 t) while 167 STORED piles hold 10,401 t doing
    nothing but ageing. `status` rides as a column so the split stays visible.
  - **Closed residue is excluded and disclosed.** 1,214 t across 346 blocks — the resiko,
    which is loss rather than stock and is never something to act on (Renzo's standing
    rule). Counting it made the yard read 416 days old with a six-year-old pile in it.
  - Rows deep-link to `/inventory/blocking?block=<block_loc>`, that route's own selection
    param. Only real warehouse slots (`A–D-` / `PCA-` / `PCB-`) are links — a feed-area
    label has no cell in the 220-slot grid, and a link to a block that cannot be selected
    is worse than plain text.

### The summary column
The trailing column folds the whole displayed window through **the row's own rollup rule**
(built as a synthetic `Period` so it goes down the same code path) — `2026` in M/Q view,
`All time` in Y view. Its comparison chip is the SAME fold over the prior year, because a
summary column has no "previous column" in view. A single "add the row up" column would
have been wrong on five of the twelve rows.

## Dependencies

- `lib/analytics/*` (own), `lib/auth.ts` (`canViewPrices`), `lib/supabase/server.ts`
- `components/ui/{popover,select,switch}`, `lib/utils` (`cn`), `recharts`, `lucide-react`,
  `next/link` (the watchlist's Blocking deep links)
- `components/digest/drilldown/drilldown-modal.tsx` — `DrilldownSection`,
  `DrilldownStat`, `DRILLDOWN_AXIS_TICK`, `drilldownTooltipChrome`
- `components/digest/drilldown/series-parts.tsx` — `BreakdownRail`, `RailItem`

**What imports THIS module:** nothing. The four digest drill-downs link to `/analytics`
by href only (`rc-in`, `rc-in-price`, `rc-out`, `flow` — each deep-links its own
`?metric=`), which is a URL, not an import.

`VolumeSeriesChart` is deliberately NOT reused: `VolumePoint.value` is `number` and this
page's whole point is that a missing figure is a GAP (RC OUT has none before 2024, and 42
zero-height bars would assert the plant fed nothing), and its rolling-mean legend is
hardcoded to day/month while these buckets are months, quarters or years.

## See Also
- `.agents/plans/ictc-analytics-dashboard-plan.md` — the plan, the analyst audit, phases P3–P4
- `supabase/migrations/20260901115129_analytics_phase1_data_layer.sql` — the P1 metric dictionary's source
- `supabase/migrations/20260901124822_analytics_phase2_money_layer.sql` — the P2 dictionary's source,
  and the full column-by-column reasoning behind the money layer
- `app/(app)/inventory/blocking/CONTEXT.md` — the watchlist's link destination (`?block=`)
- `app/(app)/inventory/rc-movement/CONTEXT.md` — the `view_rc_movement_*` family every P2
  money figure is lifted from, unchanged
- `app/(app)/CONTEXT.md` — the Home Digest, the daily gateway that links here
- `components/digest/CONTEXT.md` — the drill-down chassis this page borrows its chart chrome from
- `components/NAVBAR.md` — the breadcrumb + module-list registration
