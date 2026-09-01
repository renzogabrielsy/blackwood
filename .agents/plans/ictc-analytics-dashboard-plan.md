# ICTC Owner Analytics — planning document (FINALIZED 2026-09-01, build not started)

> **Renzo's decisions (2026-09-01):** (1) New `/analytics` page. (2) Cost KPIs BOTH bases —
> calendar months for market KPIs, production batches for cost/yield, side by side, labeled.
> (3) ALL FOUR snapshot KPI families in (value ₱ · age+watchlist · runway · counts/utilization)
> — "we'll grow more and slash some off in the future," so rows must be cheap to add/hide.
> (4) The batch-suffixed supplier entries are NOT a spelling problem — Renzo correctly
> identified them as SUNDRY re-entries, and the data confirms it 17/17: every `<Supplier> -
> <BLOCK>` entry lands in a `*-SUNDRY*` batch. RULE: `canonical_supplier` stays untouched;
> the analytics layer CLASSIFIES deliveries (market purchase vs sundry re-entry vs
> refeed/recook); market-price and purchase-volume KPIs EXCLUDE non-market classes; sundry
> re-entry kg becomes its own monthly KPI row (recovery metric); origin-supplier attribution
> kept for traceability only.

> Renzo: "The goal here is to have the dashboard be the gateway to access more in depth tools
> for analysis... a tool where I can monitor daily the KPIs we want to observe month on month...
> This is a custom Dashboard FOR ME. For MY brain." Planning/analysis only — nothing built yet.
> Open questions at the bottom; the plan finalizes after Renzo answers.

## 0a. Professional-analyst audit (2026-09-01, Renzo-requested, decisions folded in)

The plan was stress-tested against "would a professional analyst build it this way for a CEO."
Already met (house rules force them): one SQL-owned definition per metric; weighted rollups
only; explicit population rules (sundry/refeed excluded from market KPIs); honesty flags
(truncation floors, coverage, as-of dates). Five gaps closed:

1. **Metric dictionary IN the UI** — every KPI row carries a plain-language definition on
   hover/expand: numerator, denominator, exclusions, basis (calendar vs batch). A number the
   reader can interrogate without asking anyone.
2. **Comparison context on every cell** — MoM Δ always; **YoY as a compact chip** where data
   reaches (Renzo's pick — not full side-by-side years, not bare numbers).
3. **Working-day normalization as a toggle** — volume/consumption per working day (derived
   from observed activity, the freshness-rework definition), because Feb vs Mar raw tonnage
   misleads. Toggle, never extra permanent rows.
4. **Stated restatement policy, printed on the page** — snapshots derive from events, so a
   corrected past delivery restates history; the page says "figures reflect the underlying
   records as of today" and the audit trail explains any why.
5. **Callouts strip above the matrix** (Renzo: yes) — 3-5 auto one-liners. **Because Renzo
   chose NO threshold coloring yet**, callouts derive purely from MAGNITUDE (biggest movers,
   new highs/lows vs a KPI's own history) — no invented "breach" rules; cells stay plain
   numbers + deltas. Target-based coloring is a later layer, added only when Renzo states
   real targets or asks for history-derived bands.

Also codified: tonnes (one decimal) in the matrix, kg in drilldowns; correlation stories
(price↔volume↔participation) presented as observational, never causal claims.

## 0. The architectural gift: RC inventory can already time-travel

Unlike the PC warehouse (no location history → stocktake-forward mindset), the RC side is
fully event-sourced: every kilo in (`deliveries`) and out (`rc_out`) is a dated row. So
"inventory as of any past date" = opening + Σin − Σout up to that date, per batch — derivable
in SQL for ALL history, no snapshot jobs, no waiting to accumulate data. Month-end snapshots
back to the beginning of the data are a VIEW, not a pipeline.

Three honest limits, stated up front:
1. **Per-BATCH history is exact; per-BLOCK history is approximate.** `batches.location_ref`
   describes the block NOW (it's cleared/reused); the delivery rows carry `block_loc` at
   arrival, so an as-of block mapping is reconstructable but fuzzy where blocks were reused.
   KPI grain should be BATCH (and warehouse letter), not block, for history.
2. **Batch close DATES aren't evented** — status flips aren't a dated log. "Closed during
   month M" is approximated by the batch's last feeding date (good enough; the
   closure-reconciliation vision would make it exact later).
3. **`quality_stats` can't time-travel** (INSERT-only incremental blend, not invertible).
   As-of lab stats = recompute from delivery lab panels, which IS possible per batch.

## 1. Renzo's four asks, made concrete

### 1a. Running inventory, month on month (snapshots)
Month-end as-of series, computed from events (Y/Q/M rollups = the same series sampled):
- **Ending inventory kg** (total; by warehouse letter; by batch status mix)
- **Ending inventory VALUE ₱** (priced deliveries' ₱ attached to remaining kg — avg-cost
  basis, price-gated)
- **# active batches / blocks occupied** (utilization of the 220 slots)
- **Age profile of stock** (kg-weighted days since delivery; the % older than 60/120 days)
- **Runway** (ending kg ÷ that month's avg daily consumption = days of feed on hand)

### 1b. RC IN price (market read)
- Monthly weighted avg ₱/kg over priced deliveries (measured 2026: Jan 47.64 → Feb 48.41 →
  Mar 47.20 → Apr 44.58 → May 44.96 → Jun 38.25 → Jul 37.88 → Aug 39.90)
- Q/Y = weighted rollups of the same, never averages of averages
- Optional band: min/max week within month (volatility)

### 1c. RC IN volume + the price↔volume relationship
- Monthly tonnes (same table: 1,505 → 2,004 → 1,989 → 714 → 1,034 → 762 → 902 → 826)
- **Measured: the hypothesis holds, and the MECHANISM is supplier participation** — active
  supplier count by month: 14 → 20 → 21 → 7 → 4 → 4 → 4 → 6. High price doesn't just buy
  more kilos from the same people; it brings sellers to the gate. Q1 at ₱47-48 had 14-21
  suppliers; the ₱38 summer had 4. So the chart to build is a three-line story:
  price × volume × active-supplier-count.
- Per-supplier: monthly kg + share + supplier's avg ₱ vs the month's market avg
  (premium/discount) — Renzo believes the delta is small; we show it measured.

### 1d. IN/OUT volume → reframed as the ACCUMULATION story
Monthly: IN (bought), OUT (fed), NET, ending inventory, runway. This is 1a's flow view —
"did we build or draw down stock this month, and how many days of feed do we hold."

## 2. What Renzo DIDN'T ask for (the consultant list, prioritized)

1. **Aging → shrinkage → TRUE cost.** Charcoal shrinks while it sits (resiko), so the money
   already spent spreads over fewer kilos. Already proven in the DB: JAN-26-BLK22 delivered
   at ₱48.16 truly cost ₱50.61/kg fed (−4.84% weight); NOV-25-BLK7 ₱42.00 → ₱46.96 (−10.56%).
   And RIGHT NOW SEPT-25-BLK4 sits at D-7D with 32.6t that is **345 days old**. Monthly KPIs:
   avg loss % of blocks closed that month, TRUE ₱/kg fed (view_rc_movement_*_actual_price
   rolled monthly), and an aging watchlist (piles > N days). This connects price, inventory
   and cost into one owner-grade number.
2. **Runway** (days of feed on hand) — the operational survival number.
3. **Unit economics chain:** ₱ fed per produced kg = true fed cost ÷ yield (yield monthly
   already exists: view_rc_movement_yield_monthly). THE number: "what did a kg of product
   cost me in charcoal this month."
4. **Supplier concentration** (top-1/top-3 share; Ornales ≈ 40% YTD) — dependency risk.
5. **₱ tied up in inventory** (working capital) month-end — pairs with 1a value.
6. **Quality-adjusted buying** (phase 2): lab panel (MC/ash) by supplier/month; wet-sack
   deduction rates — is cheap charcoal wet charcoal?
7. **Data-health footnote:** unpriced volume % and pricing lag (already tracked daily).

## 3. Shape (for Renzo's brain: Excel-first)

New page `/analytics` (ICTC): the **monthly matrix** — rows = KPIs, columns = months of the
selected year, Y/Q/M toggle, this-vs-last-year option later. Excel-standard density, frozen
KPI-name column, the new pinned footer for YTD. Each row expands (the proven drilldown
chassis at page scale) into its chart + breakdown (per-supplier, per-warehouse). The
dashboard tiles' existing modals gain a "Full analytics →" footer link — the dashboard stays
the daily gateway, /analytics is the month-on-month room. Price rows fully behind
canViewPrices() (server-side).

Data: a small family of as-of/monthly SQL views following the 400-day-window/security_invoker
idiom where windowing applies (monthly grains are naturally small — a monthly view can span
all history within row budgets). No new tables. No snapshot jobs.

## 4. Phasing (each phase shippable alone)

- **P1 — the matrix**: price, volume, active suppliers, IN/OUT/NET, ending kg, runway,
  batch/block counts. (Monthly views + the page + row-expand charts.)

  > ### ✅ P1 DATA LAYER BUILT — 2026-09-01, applied
  >
  > Migrations `20260901115129_analytics_phase1_data_layer` (+ the one-line cost fix
  > `20260901115314_analytics_inventory_eom_outflow_flag_scalar`). One function, three views,
  > all `security_invoker` / `authenticated`-only / no `service_role`; row counts 49 / 75 / 75.
  > Gates green: `tsc --noEmit` clean, `verify-worker-view-grants` 4 views / 0 findings.
  > Types regenerated. **The page + server action are NOT built** — that is the frontend's half.
  >
  > - **`fn_delivery_class(batch_code, supplier, remarks)`** — `market | sundry_reentry |
  >   recook_refeed`. All-time split: market **1,631 rows / 31,004,993 kg (98.010%)** ·
  >   sundry_reentry **91 / 581,173 kg (1.837%)** · recook_refeed **5 / 48,244 kg (0.153%)**.
  >   A delivery straight into the FEEDING AREA is a PURCHASE (all 13 raw-`FEED` rows are
  >   Paquibot trucks at ₱19.50–₱25.00). It takes 3 arguments because 2 re-cooks announce
  >   themselves only in `supplier` (@ ₱1.50/₱1.75 processing fees, on ordinary BLK/FEED codes)
  >   and 1 sundry-batch row is remarked "FOR SUNDRYING" (still market).
  > - **`view_analytics_rcin_monthly`** · **`view_analytics_flow_monthly`** ·
  >   **`view_analytics_inventory_eom`** — full definitions in CLAUDE.md → Views → "Owner
  >   analytics".
  >
  > **What the measurement changed about §1c's story.** The plan's 2026 table is reproduced
  > exactly, and it was computed over ALL arrivals; the market-only figures differ, and the
  > supplier count differs a LOT:
  >
  > | 2026 | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug |
  > |---|---|---|---|---|---|---|---|---|
  > | tonnes, plan (all) | 1,505.4 | 2,004.4 | 1,988.8 | 713.9 | 1,034.1 | 762.0 | 901.5 | 825.6 |
  > | tonnes, **market** | 1,468.3 | 1,864.1 | 1,788.9 | **598.2** | 1,034.1 | 762.0 | 901.5 | 824.0 |
  > | ₱/kg, plan (all) | 47.64 | 48.41 | 47.20 | 44.58 | 44.96 | 38.25 | 37.88 | 39.90 |
  > | ₱/kg, **market** | 47.53 | 48.26 | **47.51** | **46.84** | 44.96 | 38.25 | 37.88 | **39.97** |
  > | suppliers, plan (all) | 14 | 20 | 21 | 7 | 4 | 4 | 4 | 6 |
  > | suppliers, **market** | **13** | **14** | **10** | **4** | 4 | 4 | 4 | **5** |
  >
  > Two things worth carrying into the page. **April's real market price is ₱46.84, not ₱44.58** —
  > 115,691 kg of sundry re-entry was dragging it down, so the "price collapse" starts a month
  > later and more sharply than the plan's line shows. And **the participation story is stronger,
  > not weaker**: Feb/Mar were 14 and 10 real market sellers, not 20 and 21 — the extra entries
  > were sundry re-entries carrying an origin-supplier name. The high-price months still drew
  > 3× the sellers of the ₱38 summer.
  >
  > **Two honest limits confirmed by measurement, both needing UI copy.** (1) `ending_kg`
  > 8,492,517.09 kg reconciles to the live table EXACTLY (gap 0.00 kg) — but it is a NET of
  > +11.71M kg positive and **−3.22M kg spread over 77 batches with negative balances**
  > (misattribution, the L-042 shape, not evaporation). The view exposes the split; the page
  > must print the caveat rather than showing an 8.5M headline alone. (2) `price_coverage_pct`
  > currently reads **100.00 on every month** — all 1,727 deliveries are priced today. The
  > column is structural honesty, not a live signal, so do not build a UI that only appears
  > when coverage < 100.

  > ### ✅ P1 PAGE BUILT — 2026-09-01
  >
  > `/analytics` is live: server page + adapter + the matrix + the row expand + the
  > dictionary + the callouts + the working-day toggle, registered in the navbar
  > (breadcrumb + `ICTC_MODULES`). Gates green: `tsc --noEmit` clean, `npm run lint`
  > 146/16 (baseline, no new), `npm run build` clean, `verify-table-core` 84,
  > `test:e2e` 57. Full architecture: **`app/(app)/analytics/CONTEXT.md`**.
  >
  > **Files.** `app/(app)/analytics/{page,analytics-view,analytics-matrix,metric-expand,metric-info,analytics-error}.tsx`
  > + `lib/analytics/{types,metrics,matrix,format,queries}.ts`.
  >
  > **The matrix is a BESPOKE dense table, not the Blackwood Table** — and the reason is
  > structural, not taste. The platform grid assumes rows are RECORDS and columns are
  > FIELDS; this inverts both, so (a) `ColumnSpec.format` is per COLUMN while here `Mar`
  > must print ₱48.26 on one row and 1,864.1 t on the next, (b) a cell is value + delta +
  > year-ago chip and is never editable, so the edit journal / paste sink / caret model are
  > pure cost, and (c) the row expand is the point of the page and `renderChromeRow` reaches
  > only INSIDE a `table-fixed` row (a chart there would be ~1,500px wide). Twelve rows also
  > means virtualisation buys nothing. Both platform LAYOUT rules are still obeyed: "never
  > crush, always scroll" (`table-fixed` + `width: max-content` + a full `<colgroup>`, no
  > flexible column) and opaque frozen panes (`.frozen-col` + `.frozen-edge` on the KPI-name
  > column, solid tokens, hover/selected repainted solidly).
  >
  > **Rollup rules as shipped** — weighted (Σ₱ ÷ Σkg): Market price. Sum: Purchase volume,
  > Sundry re-entry, RC IN total, RC OUT, Net flow, Working days. **Period-end** (a stock is
  > not additive): Ending inventory, Inventory value, Runway, Active batches. **Peak** — the
  > one approximation, and it is labelled in the dictionary: Active suppliers, because
  > distinct sellers over a quarter is NOT derivable from three monthly distinct counts. The
  > trailing summary column folds the displayed window through the SAME rule (built as a
  > synthetic period), so "add the row up" is never applied to the five rows it would break.
  >
  > **Callouts** are returned by `buildMatrix` from the SAME pass that builds the cells —
  > never a second computation — and are magnitude-only per §0a.5: the largest
  > period-over-period move (only that one may claim "the biggest move on the board"), the
  > widest year-ago gap, and highs/lows against a metric's own history with in-progress
  > periods excluded from BOTH sides and a ≥6-period floor before the word "record" is used.
  > Capped at 5, never two lines about one metric, restricted (₱) rows contribute nothing.
  > **No colour semantics anywhere on the page** — a delta is a direction glyph and a muted
  > number, per the "no threshold colouring yet" decision.
  >
  > **Two measured corrections during the build, both worth keeping.** A recharts BAR chart's
  > "auto" Y domain starts at the data minimum, which turned a 30% spread in ending inventory
  > into a visual collapse — bars now force a zero baseline while LINE metrics (price,
  > runway) keep the padded domain the price drill-down uses. And a 360px dictionary popover
  > opened with `side="right"` from the frozen left column flipped left and hung 133px off a
  > 375px screen; it is `side="bottom"` with `max-h-[var(--radix-popover-content-available-height)]`.
  >
  > **Gateway links.** `DrilldownModal.footerLink` was widened from an object to
  > object-or-array (every existing caller byte-identical), and RC IN / RC IN price / RC OUT /
  > Flow each gained `Full analytics →` deep-linked to their own `?metric=`. Production and
  > Power got none — P1 has no production-grade or power row, and a door to nowhere is worse
  > than no door.

- **P2 — the money layer**: inventory value ₱, true fed ₱/kg monthly, loss % of closed
  blocks, aging profile + watchlist, ₱-per-produced-kg.
- **P3 — supplier room**: per-supplier monthly matrix (kg, share, premium/discount,
  active-months), price↔volume↔participation explorer.
- **P4 — the pattern rollout**: same matrix chassis for Production (grades, yield, downtime)
  and later PC inventory (once the stocktake feature exists).

## 5. Open questions for Renzo (plan finalizes on these)

1. WHERE: new /analytics page (recommended) vs growing the dashboard?
2. MONTH BASIS for cost KPIs: calendar months, production batches, or both? (Market price =
   calendar, always; but "what did AUGUST-the-batch cost" is a different, also-true answer.)
3. Which inventory-snapshot KPIs matter most (cut list): value ₱ · age/watchlist · runway ·
   counts/utilization?
4. The `LAYUPAN - JAN-26-BLK9` batch-suffix supplier folding (open since 2026-08-28) — it
   now affects every per-supplier KPI here. Fold or keep separate?
5. Volume basis: booked `weight_kg` everywhere, or surface `true_weight_kg` deductions as a
   quality KPI too (they're display-only today)?
