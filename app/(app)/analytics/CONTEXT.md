# Analytics Module — ICTC Owner KPI Matrix (`/analytics`)

## Purpose
The **month-on-month room**. `/` (the Home Digest) answers *"what happened today"*; this
answers *"what has been happening"* — twelve KPI rows × period columns, with a Y/Q/M
toggle, a per-working-day normalisation, a metric dictionary at the point of use, an
auto-generated callout strip and a per-row trend expand.

Renzo, 2026-09-01: *"a tool where I can monitor daily the KPIs we want to observe month on
month… This is a custom Dashboard FOR ME. For MY brain."* Plan:
`.agents/plans/ictc-analytics-dashboard-plan.md` (§4 — **P1, the matrix**).

> **Domain module (charcoal tenant).** It reads three charcoal-shaped SQL views. Nothing
> in `components/shared/` or `components/ui/` learns anything from it. The ONE platform
> file it touches is `components/digest/drilldown/drilldown-modal.tsx`, and only to widen
> `footerLink` from an object to "object or array" so a digest tile can offer a second
> destination.

## Files

| File | Role |
|------|------|
| `page.tsx` | **Server Component.** Awaits `getAnalyticsData()`, resolves the OPENING view from `searchParams` (`year` · `g` · `wd` · `metric`) and hands both to the client shell. Owns nothing else — no heading (the navbar owns the title), no aggregation, no gate of its own beyond the adapter's. Fetch inside `try/catch`, render outside it. |
| `analytics-view.tsx` | **Client shell.** Owns the three view controls (year `Select`, Y/Q/M toggle, per-working-day `Switch`), the live block-utilization chip, the callout strip, the matrix, the expanded row and the restatement footer. Calls `buildMatrix()` in a `useMemo`. |
| `analytics-matrix.tsx` | **The matrix table** — a bespoke dense table (see "Why not the Blackwood Table"). Frozen KPI-name column, explicit `<colgroup>` widths, `width: max-content` inside `overflow-x-auto`, a trailing summary column. |
| `metric-expand.tsx` | **The row expand**, rendered BELOW the table. Stat strip + full-history chart (bar or line) + the ending-inventory split rail + the dictionary spelled out. Reuses `DrilldownSection` / `DrilldownStat` / `BreakdownRail` / `DRILLDOWN_AXIS_TICK` / `drilldownTooltipChrome` from the drill-down chassis. |
| `metric-info.tsx` | **The metric dictionary** at the point of use — an `Info` button per row with the whole entry as a native `title` (hover) and a `Popover` card (click). Copy comes from `METRICS[].dictionary`. |
| `analytics-error.tsx` | Persistent, copyable load-failure banner (the project's HARD RULE applies to every error surface, not only toasts). |

### The shared library (`lib/analytics/`)

| File | Role |
|------|------|
| `types.ts` | The contract — `AnalyticsMonth`, `BlockUtilization`, `AnalyticsData`. Portable (no React, no Supabase, no `server-only`). **`null` is never 0 in this shape.** |
| `metrics.ts` | **THE metric registry + dictionary.** One entry per row: label, unit, `read`, `rollup`, `deltaMode`, `perWorkingDay`, `price`, chart shape/colours, decimals, and the plain-language definition (derived from the view COMMENTs in the Phase-1 migration). Pure, client-safe. |
| `matrix.ts` | **The pure fold** — period axis, cells, deltas, YoY, the trailing summary column, the full history series and the callouts, all in ONE pass over the same numbers. Pure, client-safe. |
| `format.ts` | Display formatters + the blank-reason hover copy. Presentation only. |
| `queries.ts` | **The server-only ADAPTER.** Reads the three views + the live blocking grid, applies the ₱ gate and the one honest nulling, returns `AnalyticsData`. |

## Data

**Three views + one live read.** All three analytics views are `security_invoker`,
`authenticated`-only, **not** granted to `service_role` (the sync worker reads none of
them — L-044's arrow direction). Migration
`20260901115129_analytics_phase1_data_layer` (+ the scalar fix `20260901115314`).

| View | Grain | Rows | Feeds |
|------|-------|------|-------|
| `view_analytics_rcin_monthly` | month with ≥1 delivery | 49 | Market price ₱/kg · Purchase volume · Active suppliers · Sundry re-entry |
| `view_analytics_flow_monthly` | **every** month, zero-filled — the complete spine | 75 | RC IN total · RC OUT · Net flow · Working days |
| `view_analytics_inventory_eom` | every month of the spine | 75 | Ending inventory · Inventory value ₱ · Runway · Active batches |
| `view_blocking_grid` | one row per active batch (**LIVE**) | ~500 | the "148/220 blocks occupied · TODAY" chip |

**Unwindowed on purpose.** CLAUDE.md's trailing-400-day idiom governs DAILY views, where
PostgREST's 1000-row ascending truncation silently eats the newest days. These are
MONTHLY grains at 49/75/75 rows — two orders of magnitude under the cap — and a
month-on-month matrix that could not reach 2024 would not be the thing that was asked for.

### The twelve rows, and the rollup rule each one ships with

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
respects the impersonation cookie) and NULLS four fields before the payload leaves the
server: `market_avg_price`, `market_php_total`, `ending_value_php`,
`avg_unit_cost_php_kg`. `view_analytics_flow_monthly` carries no ₱ and none is derivable.
The client receives `canViewPrices: boolean`; a ₱ row renders a lock badge and a `—` in
every cell, and its expand shows the restricted panel (the same treatment
`rc-in-price-drilldown.tsx` uses). **Callouts skip restricted rows entirely**, so no
sentence about a peso can be composed for a role that may not see one.

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

### Callouts (magnitude only — no thresholds)
`buildMatrix` returns the cells AND the callouts from ONE pass, so a headline can never
disagree with the grid beneath it. Three shapes, capped at 5, never two lines about the
same metric:
- the largest period-over-period change in the displayed window (only this one may claim
  *"the biggest move on the board"* — a backfilled mover drops the superlative);
- the widest year-ago gap in the displayed window;
- a value that is the highest or lowest that metric has ever read, judged against its own
  history at the same granularity, **excluding in-progress periods from both sides** (an
  unfinished month can neither set a record nor depress one), and needing ≥6 settled
  periods before the word "record" is used.

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
is their sum. No 57px header-chrome budget applies — that tax is the Blackwood Table's
`scope="focus"` hover-revealed sort/filter siblings, which a bespoke `<th>` does not have.

### The summary column
The trailing column folds the whole displayed window through **the row's own rollup rule**
(built as a synthetic `Period` so it goes down the same code path) — `2026` in M/Q view,
`All time` in Y view. Its comparison chip is the SAME fold over the prior year, because a
summary column has no "previous column" in view. A single "add the row up" column would
have been wrong on five of the twelve rows.

## Dependencies

- `lib/analytics/*` (own), `lib/auth.ts` (`canViewPrices`), `lib/supabase/server.ts`
- `components/ui/{popover,select,switch}`, `lib/utils` (`cn`), `recharts`, `lucide-react`
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
- `.agents/plans/ictc-analytics-dashboard-plan.md` — the plan, the analyst audit, phases P2–P4
- `supabase/migrations/20260901115129_analytics_phase1_data_layer.sql` — the metric dictionary's source
- `app/(app)/CONTEXT.md` — the Home Digest, the daily gateway that links here
- `components/digest/CONTEXT.md` — the drill-down chassis this page borrows its chart chrome from
- `components/NAVBAR.md` — the breadcrumb + module-list registration
