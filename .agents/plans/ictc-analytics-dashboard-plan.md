# ICTC Owner Analytics — planning document (FINALIZED 2026-09-01, build not started)

> **POST-BUILD CORRECTION — 2026-09-02, migration `20260902071050_fed_excludes_sundry_destination`.**
> The plan's decision (4) got the DELIVERY side of sundry exactly right (`fn_delivery_class`
> keeps sundry re-entries out of market purchase volume and price). It missed the **rc_out**
> side: `destination` is `MAIN` (fed to the plant) or `SUNDRY` (pulled out to be sun-dried),
> and every "fed" view summed both — so the same sun-dried charcoal that the plan correctly
> refused to count as a purchase on the way IN was being counted as plant feed on the way OUT.
> JANUARY 2026 read 1,048,908 kg fed against a true 836,328 kg; its yield read 65.56% against
> a true 82.23%. Fixed in SQL across 15 views; balance / yard-flow figures are untouched.
> **Generalised rule for any future KPI on this page: a population rule has to be stated on
> BOTH sides of a flow — what came in, and what went out — or half of it leaks back.**

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

  > ### ✅ P2 DATA LAYER BUILT — 2026-09-01, applied
  >
  > Migration `20260901124822_analytics_phase2_money_layer`. Four views, posture identical
  > to P1 (`security_invoker` / `authenticated`-only / `anon` REVOKEd / no `service_role`);
  > row counts **75 / 32 / 75 / 170**. Gates green: `tsc --noEmit` clean,
  > `verify-worker-view-grants` 4 views / 0 findings. Types regenerated.
  > **The page + server action are NOT built** — that is the frontend's half.
  > Full column-by-column detail: CLAUDE.md → Views → "Owner analytics — THE MONEY LAYER".
  >
  > - **`view_analytics_cost_monthly`** (calendar basis) · **`view_analytics_batch_cost`**
  >   (production-batch basis, decision 2) · **`view_analytics_aging_eom`** ·
  >   **`view_analytics_aging_watchlist`**.
  >
  > **The governing rule: nothing that already has a definition was re-derived.** Delivered
  > ₱/kg, actual (shrinkage-adjusted) fed ₱/kg, yield and per-block loss all come out of the
  > existing `view_rc_movement_*` family by SELECT. Proven column-for-column: **0 mismatches
  > on 75/75 months and 32/32 campaigns.**
  >
  > **THE FORMULAS, stated once.**
  > `php_per_produced_kg` (calendar, delivered basis) = `(month_price.wtd_fed_price ×
  > month_price.total_fed) ÷ yield_monthly.total_produced`, identically
  > `delivered_php_kg_fed ÷ yield_pct`. `php_per_produced_kg_true` (batch basis) =
  > `campaign_actual_price.campaign_weighted_actual_fed_php_kg ÷ campaign_yield.yield_pct` —
  > the campaign-WEIGHTED variant, because it is the one attributed to that campaign's own
  > fed kilos and is therefore shape-comparable to the delivered figure.
  >
  > **What the measurement changed about the plan.**
  >
  > 1. **The published monthly fed price is silently UNDERSTATED on 7 months, and P2 makes it
  >    visible.** `view_rc_movement_month_price` prices fed kilos through each fed batch's
  >    deliveries, so a batch with no delivery rows contributes kilos to the denominator and
  >    nothing to the numerator. 2024-03 is **98.4% untraceable** (its price is ~1/63rd of
  >    the truth), 2024-04 75.2%, 2024-05 52.0%, 2024-06 59.4%, 2024-09/-10 ~0.2%, and
  >    **2026-08 2.675%** — that last one is the L-042 `FEEDING # 2` phantom, 18,650 kg,
  >    CLAUDE.md's own KNOWN-NOT-FIXED item. `fed_price_coverage_pct` now says so, and
  >    `php_per_produced_kg` reads NULL rather than wrong when coverage is short
  >    (`php_per_produced_kg_covered` gives the honest estimate: 2026-08 is **₱53.07**, not
  >    the naive ₱51.65). Nothing about the published price was changed.
  > 2. **§2.1's aging watchlist must NOT be IN-USE only.** Measured: IN-USE holds 91,825 kg
  >    across 3 piles over a tonne; **STORED holds 10,401,479 kg across 167**. An IN-USE-only
  >    list would show three names and miss ten and a half million kilos of stock doing
  >    nothing but ageing. The watchlist is `status <> 'CLOSED'`, with `status` as a column.
  >    CLOSED is excluded for the opposite reason — its 1.17M kg is resiko, loss not stock.
  > 3. **The same split has to happen in the month-end aging series, or the number lies.**
  >    Counting closed-block residue makes the yard read **415.7 days weighted age with a
  >    2,253-day-old pile**; excluding it gives **386.5 days, oldest 1,158**. Both figures are
  >    published (`open_kg` vs `closed_residue_kg`) and their sum equals
  >    `view_analytics_inventory_eom.positive_balance_kg` exactly on 75/75 months.
  > 4. **Limit #2 (undated batch closes) is honoured by REUSING the existing approximation**,
  >    not by inventing a second one: `view_rc_movement_block_actual_price.close_date` (last
  >    feeding, or the feeding remarked CLOSED) decides both "closed in month M" and "still
  >    open at that month-end", so the analytics layer and the RC Movement screen can never
  >    disagree about when a block closed.
  > 5. **Aging is balance-weighted, never FIFO, and says so.** A pile carries the kg-weighted
  >    mean date of everything tipped into it; `rc_out` records which BATCH kilos left, never
  >    which delivery within it, so FIFO would be fiction dressed as precision. Validated:
  >    **SEPT-25-BLK4 = 344.81 days**, the ~345 days §2.1 quotes.
  > 6. **§2.1's JULY 2026 figures have moved, legitimately.** CLAUDE.md records ₱47.2747 /
  >    ₱46.2492 from 2026-08-07 when the campaign read "18 of 19 blocks closed"; the 19th has
  >    since closed and the live campaign view now reads **₱48.2579 / ₱47.5780**. P2 matches
  >    the live view exactly — the doc figure is a stale snapshot, not a defect.
  > 7. **A campaign that has produced but not yet been fed still gets a row.** SEPTEMBER 2026
  >    is exactly that today (7,506 kg produced, 0 fed, opened 2026-08-29 under L-046), which
  >    is why the batch spine is `campaign_options UNION campaign_yield`.
  >
  > **UI copy the page owes.** Both `php_per_produced_kg` blanks need the coverage sentence;
  > `closed_blocks_loss_pct` can be slightly NEGATIVE (2026-02 = −0.001022, misfiled
  > paperwork, deliberately not clamped); `loss_pct`/`yield_pct` are FRACTIONS while
  > `pct_over_60d`/`pct_over_120d` are PERCENTS.

  > ### ✅ P2 PAGE BUILT — 2026-09-01
  >
  > Eight money rows in the matrix (a new **Money** section band), the **batch-basis
  > panel** and the **live aging watchlist**. Gates green: `tsc --noEmit` clean ·
  > `npm run lint` 146/16 (baseline, no new findings) · `npm run build` clean ·
  > `verify-table-core` 84 · `test:e2e` 57 passed. Browser-verified through a throwaway
  > harness under `app/dev/table-playground/` (since deleted). Files:
  > `lib/analytics/{types,metrics,matrix,format,queries}.ts`,
  > `app/(app)/analytics/{analytics-matrix,analytics-view,metric-expand}.tsx`, and the two
  > new `app/(app)/analytics/{batch-cost-panel,aging-watchlist}.tsx`. Full detail:
  > `app/(app)/analytics/CONTEXT.md`.
  >
  > **The rows, and the rollup each ships with.** Delivered ₱/kg fed · ₱ per produced kg
  > (both **weighted**, Σ covered-basis fed value ÷ Σ fed kg / Σ produced kg) · Yield
  > (**weighted**, Σproduced ÷ Σfed, ×100 on the numerator so there is no second scaling
  > step) · Blocks closed (**sum**) · Closed-block loss (**weighted**, Σ lost ÷ Σ delivered)
  > · True ₱/kg closed (**weighted**, Σ (true × priced fed kg) ÷ Σ priced fed kg,
  > NULL-strict) · Avg stock age · Stock over 120 days (both **period-end**).
  >
  > **Three decisions the build made, and why.**
  >
  > 1. **Every money row READS the `_covered` figure, always** — not the published one with
  >    a fallback. At 100% coverage the two are byte-identical on all 75 months, so this is
  >    the same definition made honest on the seven where the published figure is silently
  >    understated. It also defuses the movers: nothing ever compares against ₱0.30.
  >    Coverage-short cells print `~`, and the hover names the percentage.
  > 2. **`produced_kg = 0` is a structural zero and is NULLED** — the same argument as
  >    `out_kg` before 2024, one stream later. 24 months publish `yield_pct = 0` because
  >    production was not reported, not because 8,000 t of charcoal became nothing. The
  >    adapter derives `productionRecorded` from the data (`produced_kg > 0`), never from a
  >    date; new blank reason `no_production`.
  > 3. **The callout guard was widened three ways, and one of them was a latent P1 bug.**
  >    An ESTIMATE and a metric's FIRST period are now excluded (Nov 2025 reads an 11.9%
  >    yield and ₱337/produced kg — measured to be the largest record AND largest mover on
  >    the whole board). And **in-progress periods were excluded from RECORDS but never
  >    from MOVERS**, which nobody noticed while every row was a volume; a ratio broke it
  >    on the first render — *"₱ per produced kg rose 177.7% MoM in September 2026 — the
  >    biggest month-on-month move on the board"*, off one day of data. The rule is now
  >    applied once, to all three kinds, and the row expand's Highest/Lowest reads the same
  >    gate so the strip and the drill-down can never name different periods.
  >
  > **The batch panel** is nine rows × one column per campaign (newest last, opens scrolled
  > to it), frozen row-label column, with `cost of storage time` (`uplift_php_kg`) and
  > `₱ per produced kg — TRUE basis` as the two starred rows and a `blocks closed / priced`
  > coverage line in the table itself rather than only in a hover. Its spine is the UNION,
  > so SEPTEMBER 2026 (produced, not yet fed) gets a column; columns sort by (year, month
  > index of the batch NAME), never `first_fed_date`, which is NULL for exactly that case.
  >
  > **The watchlist** takes its headline from the newest `aging_eom` row rather than summing
  > the visible rows — same population, measured equal to the kilo, and a TS sum would be a
  > second definition of the yard's weight. Ten oldest with `Show all N`, each row
  > deep-linking to `/inventory/blocking?block=<block_loc>` (links only for real A–D/PCA/PCB
  > slots), and the 1,214 t / 346-block closed residue disclosed beside the headline, never
  > inside it.
  >
  > **Restricted role:** 22 ₱ fields nulled server-side across the three P2 views; the
  > money rows, the panel's four ₱ rows and the watchlist's two ₱ columns render locked,
  > while **the entire aging story stays visible** — which is the whole reason
  > `view_analytics_aging_eom` was built ₱-free.
- **P3 — supplier room**: per-supplier monthly matrix (kg, share, premium/discount,
  active-months), price↔volume↔participation explorer.

  > ### ✅ P3 DATA LAYER BUILT — 2026-09-01, applied
  >
  > Migration `20260901133909_analytics_phase3_supplier_layer`. ONE view,
  > **`view_analytics_supplier_monthly`**, posture identical to P1/P2 (`security_invoker` /
  > `authenticated`-only / `anon` REVOKEd / no `service_role`). Row count **275** for all of
  > history. Gates green: `tsc --noEmit` clean, `verify-worker-view-grants` 4 views / 0
  > findings. Types regenerated (23 lines added, nothing removed). **The page + server action
  > are NOT built** — that is the frontend's half. Full column detail: CLAUDE.md → Views →
  > "Owner analytics — THE SUPPLIER ROOM".
  >
  > **The governing rule, same as P2: nothing that already has a definition was re-derived.**
  > Supplier identity is `canonical_supplier()`. Population is `fn_delivery_class(...)` with
  > the same three arguments P1 passes. And the month's own totals are **JOINED from
  > `view_analytics_rcin_monthly`, never re-summed** — which is what makes it structurally
  > impossible for the supplier room and the monthly matrix to disagree about a month.
  >
  > **PROOFS (all 49 months, zero mismatches).**
  >
  > | Check | Result |
  > |---|---|
  > | Σ supplier `kg` = P1 `market_kg` | 0 mismatches / 49 months, max gap **0.00 kg** |
  > | Σ supplier `php_total` = P1 `market_php_total` | 0 mismatches, max gap **₱0.0000** |
  > | Σ supplier `priced_kg` = P1 `market_priced_kg` | 0 mismatches |
  > | Σ `share_of_month_pct` = 100 | 49/49 months, max deviation **1.8e-16** |
  > | priced-kg-weighted mean `premium_php_kg` = 0 | 49/49 months, max abs **7.1e-17** |
  > | rows with NULL premium | **7** — exactly the 7 sundry-only rows; **0** market rows |
  >
  > The premium identity is not a coincidence to be checked once — the month price **is** the
  > priced-kg-weighted mean of the supplier prices, so the column must only ever be averaged
  > weighted. An unweighted average of `premium_php_kg` is meaningless and the UI must not
  > offer one.
  >
  > **Row budget.** 275 rows all-history, **113** for the busiest single year (2025), 58 for
  > 2026 YTD, 268 market pairs + 7 sundry-only. A whole-history read is ~4× under PostgREST's
  > 1000-row cap, so no windowing was added (same reasoning as P1/P2) — but the page should
  > still filter by year and fold this read into its `truncated` test.
  >
  > **2026 YTD — the Ornales-concentration read** (weighted rollup, never an average of
  > averages; market only):
  >
  > | Supplier | kg | Share | Cum. | Months | ₱/kg | Premium | Sundry origin kg |
  > |---|---:|---:|---:|---:|---:|---:|---:|
  > | ORNALES | 4,205,515 | 45.51% | 45.51% | 8 | 44.9676 | +0.0084 | — |
  > | PAQUIBOT | 2,577,594 | 27.89% | 73.40% | 8 | 45.7727 | +0.8134 | 19,585 |
  > | TAG-AT | 1,080,607 | 11.69% | 85.09% | 8 | 44.7585 | −0.2007 | — |
  > | LLANTO | 616,683 | 6.67% | 91.77% | 8 | 42.8373 | −2.1219 | — |
  > | LAYUPAN | 201,814 | 2.18% | 93.95% | 3 | 41.7309 | −3.2283 | 197,809 |
  > | MERCADO | 100,430 | 1.09% | 95.04% | 2 | 46.4929 | +1.5336 | — |
  > | NAMOC | 90,450 | 0.98% | 96.02% | 1 | 47.0000 | +2.0407 | — |
  > | LACOTO | 88,818 | 0.96% | 96.98% | 3 | 42.8816 | −2.0777 | 27,201 |
  > | TANILON | 73,101 | 0.79% | 97.77% | 3 | 44.7818 | −0.1775 | — |
  > | ECITO | 57,469 | 0.62% | 98.39% | 3 | 44.7229 | −0.2364 | — |
  > | MARANIO | 55,175 | 0.60% | 98.99% | 3 | 44.7436 | −0.2156 | — |
  > | BAGUIO/TIPALAN | 33,092 | 0.36% | 99.35% | 2 | 45.0000 | +0.0407 | 556 |
  > | NAZARENO | 22,326 | 0.24% | 99.59% | 2 | 43.5000 | −1.4593 | 24,102 |
  > | ESITO | 22,126 | 0.24% | 99.83% | 2 | 43.5519 | −1.4073 | 51,803 |
  > | BAGUIO | 11,470 | 0.12% | 99.95% | 1 | 44.2500 | −0.7093 | — |
  > | SULA | 4,453 | 0.05% | 100.00% | 1 | 45.0000 | +0.0407 | — |
  > | *SEVILLA* | *0* | — | — | *0* | — | — | *140,590* |
  >
  > **Ornales is 45.51% YTD, not the ~40% the plan quoted, and the top THREE are 85.09%** —
  > the dependency risk is materially higher than the plan assumed. SEVILLA is the shape the
  > `sundry_origin_kg` column exists for: 140,590 kg of returning material and **not one kilo
  > bought in 2026**, which a purchase-only view would have shown as absence.
  >
  > **Renzo's belief that the premium delta is small holds at the top of the book and NOT at
  > the bottom.** The three largest sellers sit inside ±₱0.82 of market for the year — but
  > LAYUPAN is −₱3.23 and NAMOC +₱2.04, and the spread widens sharply once you look at a
  > single month. 2026-03, the 10 market suppliers (month price ₱47.5085):
  >
  > | Supplier | kg | Share | Rank | Cum. | ₱/kg | Premium |
  > |---|---:|---:|---:|---:|---:|---:|
  > | ORNALES | 905,533 | 50.62% | 1 | 50.62% | 48.2354 | +0.7269 |
  > | PAQUIBOT | 431,278 | 24.11% | 2 | 74.73% | 48.3250 | +0.8165 |
  > | TAG-AT | 167,235 | 9.35% | 3 | 84.08% | 47.6265 | +0.1180 |
  > | LLANTO | 131,004 | 7.32% | 4 | 91.40% | 45.2500 | −2.2585 |
  > | LAYUPAN | 66,968 | 3.74% | 5 | 95.14% | 41.1891 | **−6.3194** |
  > | TANILON | 21,272 | 1.19% | 6 | 96.33% | 44.2500 | −3.2585 |
  > | ECITO | 21,234 | 1.19% | 7 | 97.52% | 44.2500 | −3.2585 |
  > | MARANIO | 18,860 | 1.05% | 8 | 98.58% | 44.2500 | −3.2585 |
  > | LACOTO | 14,020 | 0.78% | 9 | 99.36% | 42.2500 | −5.2585 |
  > | BAGUIO | 11,470 | 0.64% | 10 | 100.00% | 44.2500 | −3.2585 |
  >
  > The spread in one month is **₱7.14/kg** (48.33 down to 41.19). The two big sellers are
  > paid *above* market and the eight small ones below — which is arithmetically forced once
  > the top two are 75% of the volume, and is exactly why the weighted-zero identity above
  > matters: the unweighted mean premium for 2026-03 is **−₱2.5209**, a number that looks like
  > a finding and is pure artefact. NAZARENO and SEVILLA also appear in that month as
  > `kg = 0` sundry-only rows (24,102 and 44,976 kg returning), matching P1's "10 market
  > suppliers in 2026-03" exactly.
  >
  > **One decision worth carrying to the page.** `sundry_origin_kg` was kept (the brief said
  > "only if cheap and honest") because two measurements made it both: the batch-suffix strip
  > resolves all 91 sundry deliveries to 11 origins with **zero orphans**, and it is a
  > **proven no-op on every market delivery in the table**, so it cannot move a purchase
  > number even in principle. It is a separate column, excluded from share/rank/premium/price
  > — the UI must never add it to `kg`.
  > ### ✅ P3 PAGE BUILT — 2026-09-01
  >
  > A **Suppliers section** on `/analytics`, below the campaign panel and above the
  > watchlist. Gates green: `tsc --noEmit` clean · `npm run lint` 146/16 (baseline, no new
  > findings) · `npm run build` clean · `verify-table-core` 84 · `test:e2e` 57 passed.
  > Browser-verified through a throwaway harness under `app/dev/table-playground/`
  > (since deleted). Files: `lib/analytics/supplier.ts` (new),
  > `lib/analytics/{types,queries}.ts`, `app/(app)/analytics/{supplier-room,supplier-matrix,
  > supplier-premium,supplier-explorer,supplier-expand}.tsx` (new),
  > `app/(app)/analytics/{analytics-view,metric-info}.tsx`. Full detail:
  > `app/(app)/analytics/CONTEXT.md` → "The supplier room (P3)".
  >
  > **A SECTION, NOT A TAB — and the page now reads as one descending axis:** PERIOD (the
  > KPI matrix) → CAMPAIGN (the batch panel) → SUPPLIER (here) → PILE (the watchlist). Each
  > block re-keys the same kilos, and that ordering is the argument against the tab: a
  > reader who has just watched the Purchase volume row move wants to know WHO moved it.
  > The room follows the page's YEAR picker and deliberately not the Y/Q/M toggle — a
  > supplier year is a calendar year, always.
  >
  > **THE WEIGHTED-PREMIUM RULE IS ENFORCED STRUCTURALLY, NOT BY REVIEW.**
  > `weightedPremiumPhpKg` in `lib/analytics/supplier.ts` is the ONLY function in the
  > codebase that aggregates `premium_php_kg`, and it is the only export that touches the
  > column — so "does anything average this unweighted?" is one grep. It skips a part with
  > no premium OR no priced kilos on BOTH sides, so an unpriced month cannot drag the
  > figure toward zero, and it returns `null` rather than 0 when nothing qualifies. The
  > premium panel then **prints the weighted rollup in its footer** — it reads `+₱0.00` —
  > rather than asserting the identity in prose, which makes the "unweighted is meaningless"
  > claim something the reader can watch happen. There is no unweighted average offered
  > anywhere in the UI.
  >
  > **Four decisions the build made, and why.**
  >
  > 1. **The `Σ market` footer prints P1's own `month_market_kg`, not a sum of the column.**
  >    The two are equal by proof (0 mismatches / 49 months, max gap 0.00 kg), but printing
  >    the *published* figure means the supplier room and the Purchase volume row cannot
  >    drift even in principle. The same figure is the denominator of every YTD share, so
  >    the concentration chips and the matrix are the same arithmetic too.
  > 2. **A returns-only supplier is EXEMPT from the top-12 cap and always on screen.**
  >    SEVILLA is the whole reason `sundry_origin_kg` exists, and hiding it behind a
  >    `Show all` nobody clicks would have reproduced exactly the absence the column was
  >    built to prevent. Their row expand charts the RETURNS series (labelled, muted
  >    colour) instead of rendering an empty box, and a returns-only MONTH prints the
  >    returned tonnage in the returns treatment so it can never read as a purchase.
  > 3. **A premium is measured against the months THAT supplier sold in, and the page had
  >    to say so.** The first render put a `market ₱45.13/kg` chip in the header beside
  >    rows where NAMOC showed ₱46.75 paid and −₱0.79 premium — correct (NAMOC sold only
  >    in a dear January) but readable as a contradiction. The chip is now labelled
  >    `year ₱…` and explicitly *not* the baseline, and the footnote states the rule.
  > 4. **The explorer's supplier line rides a HIDDEN axis while ₱ is visible, and takes
  >    the right axis when ₱ is restricted.** Three labelled axes do not fit 375px; the
  >    count's SHAPE is the story and its exact value is in the tooltip. Restricted, the
  >    price line is simply not drawn — nothing was sent to the browser.
  >
  > **Restricted role, and one leak found and closed during the build.** Four ₱ fields are
  > nulled server-side; the volume matrix, concentration header, returns chips and the
  > explorer's volume + supplier lines stay fully live (the P2 aging split, repeated). The
  > catch: the first draft's explorer footnote and two dictionary entries carried the
  > plan's own worked examples — *"April 2026 read ₱44.58 … the market truth was ₱46.84"*
  > and *"the gap … was ₱7.14 a kilo"* — as static prose, which a Production user would
  > have read verbatim. The dictionary copy for the ₱-bearing supplier figures is now
  > ₱-FREE by construction (that card renders for every role) and the footnote branches on
  > `canViewPrices`; a restricted render was measured to contain no ₱ value at all, in text
  > or in any `title` attribute.
  >
  > **⚠️ PRE-EXISTING, NOT INTRODUCED HERE, NOT FIXED:** the same class of leak already
  > exists in the P1/P2 metric dictionaries. `METRICS[].dictionary.caveat` renders through
  > `MetricInfo` for **every** role, including a restricted one, and several entries quote
  > real peso figures — `closed_true_price` (*"July 2026 reads ₱47.56 against ₱45.33 on
  > arrival: ₱2.23 a kilo"*) and the P2 coverage copy in `lib/analytics/metrics.ts` are the
  > clearest. Worth a decision: either strip the peso examples from those caveats the way
  > P3 now does, or gate the card's caveat field on `canViewPrices`.
  >
  > **The measured 2026 read matches the data layer's table exactly** — Ornales 45.5%,
  > top-3 85.1%, 16 sellers plus SEVILLA returns-only — and the concentration header prints
  > it as a magnitude with no colour and no threshold, per §0a.5.

- **P4 — the pattern rollout**: same matrix chassis for Production (grades, yield, downtime)
  and later PC inventory (once the stocktake feature exists).

  > ### ✅ P4 DATA LAYER BUILT — 2026-09-01, applied
  >
  > Migration `20260901142417_analytics_phase4_production_layer`. TWO views, posture identical
  > to P1/P2/P3 (`security_invoker` / `authenticated`-only / `anon` REVOKEd / no
  > `service_role`); row counts **18 / 20**. Gates green: `tsc --noEmit` clean,
  > `verify-worker-view-grants` 4 views / 0 findings. Types regenerated (+45 lines, **zero
  > removals**). **The page + server action are NOT built** — that is the frontend's half.
  > Full column detail: CLAUDE.md → Views → "Owner analytics — THE PRODUCTION MATRIX".
  >
  > - **`view_analytics_production_monthly`** · **`view_analytics_production_grade_monthly`**
  >
  > **NO ₱ COLUMN EXISTS IN EITHER VIEW AND NONE IS DERIVABLE** — asserted, 0 of 35 columns
  > match `php|peso|cost|price|value|amount`. So unlike every prior phase there is **nothing
  > for the server action to null**: the whole production matrix is visible to Production.
  > That is structural, not an oversight — production is the one module of the platform with
  > no money in it, and the money that *meets* production (₱/kg fed, ₱ per produced kg)
  > already lives in P2's `view_analytics_cost_monthly` and is gated there.
  >
  > **The governing rule, same as P2/P3: nothing that already has a definition was
  > re-derived.** `produced_kg` = `SUM(view_rc_movement_production_monthly)`; the downtime
  > fold is `view_production_daily.dt_total_hrs` SELECTed, not restated (the same fold
  > `daily/ledger-derive.ts` mirrors client-side); `reported_days` comes from
  > `view_digest_stream_reported_days` filtered to `stream='production'`, which OWNS the
  > "a production day is a day with a `production_runs` child" rule. That last reuse was
  > checked rather than assumed to be cheap: the view is a `UNION ALL` over a constant
  > `stream` literal, so the planner prunes the other four branches to
  > `One-Time Filter: false` — **12 shared buffers, 0.9 ms.**
  >
  > **PROOFS.**
  >
  > | Check | Result |
  > |---|---|
  > | `produced_kg` = `view_rc_movement_production_monthly` | **0 mismatches / 10 of 10 months**, max gap **0.0 kg** |
  > | `produced_kg` = `view_rc_movement_yield_monthly.total_produced` | **0 mismatches / 10 of 10**, max gap **0.0 kg** |
  > | Σ grade `kg` = parent `produced_kg` | **0 mismatches / 10 of 10**, max gap **0.0 kg** |
  > | Σ `share_of_month_pct` = 100 | **10 / 10 months**, max deviation **1.0e-16** |
  > | `kwh` = `view_digest_daily_power` summed | **0.00 gap** on all 4 months fully inside its 120-day window |
  > | ₱ columns | **0 of 35** |
  >
  > **DOWNTIME — the real column semantics, measured.** `dt_hrs` and `dt_mins` are two
  > COMPONENTS of one duration, not alternates: `dt_mins` never reaches 60 (max **57**),
  > `dt_hrs` maxes at 8.0, 32 of 235 rows carry both non-zero, and **not one row** has
  > `dt_mins = dt_hrs × 60`. So the fold is `dt_hrs + dt_mins/60` — which is exactly what
  > `view_production_daily.dt_total_hrs` already computes, so it is SELECTed rather than
  > written a third time. (`shift_hrs` is a separate field with only two distinct values,
  > 9.0 and 12, and is not used here.) Sample month sanity-checked: **2026-02 = 20.82 h over
  > 24 shifts**, ~0.87 h lost per shift, consistent with its neighbours (Jan 18.45, Mar 18.91).
  >
  > **THE SPINE IS PRODUCTION MONTHS ∪ ELECTRICITY MONTHS — 18 rows, not 10.** Production
  > reporting starts 2025-11; the meters start 2025-03, so eight months carry power and no
  > output. A production-only spine would have dropped **577,438 kWh** out of a view that has
  > a kWh column — the silent hole this codebase keeps re-learning. They are included flagged
  > `production_reported = false` with every production figure NULL, never 0. A page that
  > wants the ten production months filters one boolean.
  >
  > **FOUR MEASURED HAZARDS, each given a companion column rather than a silent correction.**
  >
  > 1. **ONE MIS-KEYED METER READING IS 97% OF ITS MONTH, AND IT LOOKS LIKE A FINDING.**
  >    2026-03-01 / MAIN reads `start_kwh = 0.0` against `end_kwh = 5641.2` — a start never
  >    filled in, against an end that belongs to 03-03 (03-02 and 03-03 correctly re-walk
  >    5629.9 → 5641.2). At ×120 that single row publishes **676,944 kWh** into a month whose
  >    real consumption is ~20,000, taking 2026-03 to **696,924 kWh** against 30,996 in
  >    February and 16,572 in April, and reporting an intensity of **0.7630 kWh/kg where the
  >    neighbours read 0.03** — a twenty-fold efficiency collapse that never happened. The
  >    detector is **structural, not a hardcoded date**: a `start_kwh = 0` is a genuine meter
  >    reset only if the counter WRAPPED, i.e. this row's end is BELOW the meter's previous
  >    end. Over all **818 readings the rule fires on exactly ONE row** — this one — and
  >    correctly clears 2026-03-04 (start 0.0, end 2.7 after 5641.2), which is a real
  >    rollover. `kwh` still publishes the plain sum so it can never disagree with the digest
  >    tile; `kwh_per_produced_kg` reads **NULL rather than wrong**, and
  >    `kwh_per_produced_kg_excl_suspect` gives the honest estimate: **0.0219**.
  >    **⚠️ NOTHING IS REPAIRED. The underlying row is untouched** — correcting it is Renzo's
  >    call and a separate, audited write. Flagged for him.
  > 2. **AUGUST 2026 READS 0.00 DOWNTIME HOURS AND IT IS NOT A PERFECT MONTH.** All 23 of its
  >    shifts filed a REPAIR reason — "CLEANED SCREEN RS 2A AND RS 2B", "CHANGED SPRING RS 1B"
  >    — and all 23 left `dt_hrs = dt_mins = 0`. The work was recorded; the duration stopped
  >    being filled in. On the matrix that renders as the best month ever. The two halves of
  >    the report drifted apart in **both** directions and the history says so exactly:
  >    Nov 2025 – Apr 2026 recorded durations and **not one reason**; reasons begin May 2026
  >    (5 of 22); Jun/Jul record both (1 and 2 reason-only); **Aug is reason-only 23 of 23**.
  >    `downtime_shift_count` / `downtime_shifts_with_duration` /
  >    `downtime_shifts_reason_only` is what keeps that zero honest — a count of a real
  >    pattern, not an invented threshold. **The page must not print August's 0.00 h without
  >    the reason-only count beside it.**
  > 3. **SACKS DID NOT EXIST BEFORE MAY 2026.** Zero of the 179 runs from Nov 2025 through
  >    Apr 2026 carry `sacks_bags`; May 2026 carries **1 of 38 (2.63%)**, June 36/38, July
  >    44/44, August 33/33. `sacks` is therefore **NULL, never 0**, on a month where no run
  >    recorded any — "we did not count bags" and "we produced no bags" are different answers
  >    and 0 asserts the second. `sacks_coverage_pct` is a real number even at 0.00, and
  >    May's 2.63% is what tells a reader its 270 bags describe one run out of thirty-eight.
  > 4. **NOVEMBER 2025 IS A THREE-DAY PRODUCTION MONTH INSIDE A FULL MONTH OF METERING.**
  >    Reporting began 2025-11-27; the meters ran all month. So it divides 24 power-days by 3
  >    output-days and reads **1.2766 kWh/kg against ~0.05 everywhere else** — a 25× artefact
  >    that would be the biggest mover on any board. It is deliberately **NOT nulled**, and
  >    the contrast with hazard 1 is the whole rule: **March's kWh is factually WRONG so its
  >    ratio is suppressed; November's is factually RIGHT and merely NOT COMPARABLE, so it is
  >    published beside `power_days` (24), `reported_days` (3) and `first_reported_date`
  >    (2025-11-27), which say why.** Suppressing a correct number is how a data layer starts
  >    lying; P2's existing first-period callout guard is the right place for the rest.
  >
  > Also worth carrying: **only the MAIN meter has reported since 2025-12-12** (bunkhouse and
  > pump stopped), so `power_meter_count` reads 1 from January 2026 on and a per-meter rail
  > would print one bar. And **`reported_days` is PRODUCTION'S OWN denominator, not the flow
  > view's working days** — the two answer different questions and substituting one silently
  > changes what a per-day figure means.
  >
  > **2026 spot table** (t = tonnes; DT rows shown as *records / with-duration / reason-only*):
  >
  > | 2026 | Produced t | Rep. days | t/day | Downtime h | DT rows | kWh | kWh/kg | Sacks (cov.) | Top grade |
  > |---|---:|---:|---:|---:|:--:|---:|---:|---:|---|
  > | Jan | 674.9 | 26 | 26.0 | 18.45 | 26/26/0 | 35,376 | 0.0524 | — (0%) | 3X50 100.00% |
  > | Feb | 554.5 | 23 | 24.1 | 20.82 | 24/24/0 | 30,996 | 0.0559 | — (0%) | 3X50 71.53% |
  > | Mar | 913.4 | 24 | 38.1 | 18.91 | 34/26/0 | 696,924 ⚠ | **NULL** (0.0219) | — (0%) | 3X50 100.00% |
  > | Apr | 566.9 | 22 | 25.8 | 11.70 | 23/22/0 | 16,572 | 0.0292 | — (0%) | 3X50 100.00% |
  > | May | 639.5 | 22 | 29.1 | 10.08 | 22/22/0 | 30,528 | 0.0477 | 270 (2.63%) | 3X50 88.30% |
  > | Jun | 703.6 | 24 | 29.3 | 19.63 | 23/22/1 | 18,468 | 0.0262 | 23,540 (94.74%) | 3X50 93.22% |
  > | Jul | 611.0 | 25 | 24.4 | 9.47 | 26/24/2 | 20,256 | 0.0332 | 16,799 (100%) | 3X50 70.13% |
  > | Aug | 563.3 | 23 | 24.5 | **0.00 ⚠** | 23/**0**/23 | 15,552 | 0.0276 | 19,554 (100%) | 3X50 89.78% |
  >
  > March is the plant's biggest month (913 t, 38.1 t/day) and the only 100%-3X50 month
  > besides January; July is the most mixed book on record (3X50 70.13% · 2X6 17.35% ·
  > 4X8 12.52%). Excluding March's broken reading, power intensity trends **down** across
  > 2026 — 0.0524 in January to 0.0276 in August — which is the owner read this view exists
  > to make possible.
  > ### ✅ P4 PAGE BUILT — PHASE 4 COMPLETE — 2026-09-01
  >
  > A **Production section** on `/analytics`, below the supplier room and above the
  > watchlist, plus a sticky in-page anchor row that makes the now five-screen page
  > navigable. Gates green: `tsc --noEmit` clean · `npm run lint` **146/16** (baseline, no
  > new findings) · `npm run build` clean · `verify-table-core` **84** · `test:e2e` **57
  > passed**. Browser-verified through a throwaway harness under `app/dev/table-playground/`
  > (since deleted). Files: `lib/analytics/production.ts`,
  > `app/(app)/analytics/{production-room,production-grades,analytics-nav}.tsx` (new);
  > `lib/analytics/{types,queries,metrics,matrix,format}.ts`,
  > `app/(app)/analytics/{analytics-view,analytics-matrix,metric-expand}.tsx`. Full detail:
  > `app/(app)/analytics/CONTEXT.md` → "The production room (P4)".
  >
  > **A FIFTH CUT, NOT A SIXTH BAND.** The page now reads PERIOD → CAMPAIGN → SUPPLIER →
  > PRODUCTION → PILE. The six rows live in the SAME `METRICS` registry and the SAME
  > `buildMatrix` fold as the twenty above — same rollups, same expand, same callout strip —
  > and `AnalyticsMatrix` simply gained a `sections` filter so it can be mounted twice.
  > Production sits after the three blocks about buying and holding charcoal because that is
  > where the kilos stop being charcoal and start being product.
  >
  > **`MetricSpec.annotate` is the new mechanism, and `blocksCallout` is the load-bearing
  > field.** P2's `estimated()` means exactly one thing and its `~` copy says so; P4 has
  > three different reasons a figure needs a caveat, so a row now carries its own mark, its
  > own sentence and its own callout veto — evaluated over a period's MONTHS, so a quarter
  > carries the caveat exactly as the month inside it does.
  >
  > **The four hazards, as shipped.**
  >
  > | Hazard | Treatment |
  > |---|---|
  > | March's mis-keyed reading | Power prints **696.9k ⚠** exactly as metered (it must agree with the digest tile); Power intensity is **blank** and prints **0.0219** beside the ⚠, labelled *"excl. the mis-keyed reading"*; the expand's line **gaps** at March (verified: the SVG path is two segments). Nothing repaired. |
  > | August's 0.00 downtime | **⚠** + its own sentence; the expand's rail splits records into duration-recorded / repair-named-with-no-duration / neither. Verified the expand's "Lowest" reads **May 10.08 h**, not August. |
  > | Sacks before May 2026 | **Dashes**, never zeros, with the blank's hover naming the run count; a short-coverage cell carries **~** (May: *"speaks for 1 of the period's 38 production entries — 2.6% coverage"*). |
  > | November 2025 | Deliberately **NOT** suppressed — factually right, merely not comparable — and held out of headlines by the existing first-period guard, which was verified to still cover it. |
  >
  > **TWO REAL BUGS THE BUILD FOUND AND FIXED, both measured on the first render.**
  >
  > 1. **A weighted rollup sums its two halves INDEPENDENTLY, and the P4 spine has eight
  >    power-only months.** The 2025 column added **577,438 kWh** to a numerator whose months
  >    contribute nothing to the denominator and read **0.9190 kWh/kg against a true
  >    0.1527** — six times too high, the silent-hole shape again. Both halves now gate on
  >    one predicate (`intensityUsable`). Every other weighted row on the page is co-null by
  >    construction; this one was not.
  > 2. **A CHANGE needs BOTH ENDS, and `calloutable` only ever gated one.** The strip's top
  >    line was *"Power fell 97.6% MoM in April 2026, to 16,572 kWh — the biggest
  >    month-on-month move on the board."* April's own cell is sound and passed every
  >    existing gate; the 97.6% is entirely the mis-keyed March it was divided by.
  >    `MatrixCell.deltaQuotable` / `yoyQuotable` now require the base period to pass the
  >    same gate — **a latent P1 bug**, since the period right after a metric's first was
  >    always measuring a fall from a reporting boundary. After the fix the top line is
  >    *"Power rose 84.2% MoM in May 2026"* — two sound months.
  >
  > **The grade mix CHECKS its tie rather than asserting it.** `Σ made` prints the
  > Production output row's own `producedKg` (not a sum of the grade rows), the way `Σ
  > market` prints P1's figure — but it also keeps the grade sum beside it and prints both,
  > out loud, if they ever differ by more than a kilo. Verified tying exactly on every
  > month, with every month's shares summing to 100.
  >
  > **NOTHING IS GATED IN THIS SECTION AND NOTHING IS NULLED.** The adapter still nulls 26
  > ₱ fields, unchanged — the two P4 views have none to null. The whole production matrix
  > is live for the Production role.
  >
  > **The anchor row** (Overview · Money · Campaigns · Suppliers · Production · Watchlist) is
  > `sticky top-0 z-40` glass — z-40 because `.frozen-corner` is z-30 and shares the root
  > stacking context. Two anchors are the matrix's own band `<tr>`s, because Overview and
  > Money are bands of one table rather than blocks of their own. Verified: pinned at top 0
  > under an AppShell-shaped container, targets landing at 96px clear of the bar, and
  > **document height identical pinned and unpinned — no layout shift**. At 375px the page
  > has **zero horizontal document overflow**; all four tables scroll inside their own
  > wrappers and every frozen column is fully opaque in both themes.

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

## 6. OWNER FEEDBACK ROUND 1 APPLIED — 2026-09-01

Renzo tested the live `/analytics` page and gave a ten-item list. All ten shipped on
`feat/analytics-polish`. Full detail: `app/(app)/analytics/CONTEXT.md` → "Owner feedback
round 1". The short version, and the two things the round deliberately refused:

1. **Four matrix rows retired** — Sundry re-entry, Runway, Active batches, Working days.
   Active suppliers was on his first list and he reversed on it, so it stays. **Only the
   ROWS went**: every field still crosses the wire, no view changed, and `workingDays` is
   still the divisor behind the per-working-day toggle — which is why that toggle keeps
   working with its own row gone.
2. **Ending inventory moved to the OPEN-PILES basis — after being wrong in BOTH
   directions.** It read `ending_kg`, the NET of every batch balance: 8,492 t while
   Blocking showed 10,000+ — *"kind of a weird basis"*, because a net subtracts a
   bookkeeping artefact from a physical quantity. The first correction over-shot to
   `positive_balance_kg` (11,707.9 t), which bounces off Renzo's anchor from the other side
   by folding in 1,214.6 t of closed-block residue — and per the standing **resiko
   doctrine** that residue is LOSS already recognised, not stock. It now reads
   `view_analytics_aging_eom.open_kg`.

   Two properties make that the right basis rather than the closest one: it is Blocking's
   own population, and it is **as-of** (`close_date IS NULL OR close_date > as_of_date`),
   so closing a block this week does not retroactively empty last year. Non-null and
   non-zero on all 75 months of the spine.

   Reconciled 2026-09-01: 11,707,912 kg of positive balances − 1,214,608 kg residue =
   **10,493,304 kg (this row)**, and − 18,650 kg (the L-042 `AUGUST-26-FEED2` phantom,
   which has no `location_ref` and therefore no cell in the 220-slot grid) =
   **10,474,654 kg, the `view_blocking_grid` grand total exactly**. The row ties to
   Blocking within that single disclosed phantom; the expand prints all three exclusions —
   resiko, phantom, net-after-negatives — as numbers.

   **`inventory_value` was NOT realigned and the gap is disclosed instead.** It still
   values every positive balance because `view_analytics_inventory_eom` has no close date
   at all — it derives balances from `batch_code` deltas and never joins `batches` — so an
   open-piles valuation is a new SQL column, not a client-side division, and deriving one
   in TypeScript would be a second definition of what a kilo cost. Measured: closed-block
   residue is ₱34,752,633 of ₱424,331,252, **8.19%**, and the row's dictionary caveat says
   exactly that. Backend handoff is filed at the end of
   `app/(app)/analytics/CONTEXT.md`.
3. **The row expand opens IN PLACE** — a `colSpan` row inserted under the row that was
   clicked, with the panel inside it `sticky left-0` at the scroller's measured width.
   Measured: 0 px drift when the table is scrolled 400 px sideways, frozen column intact,
   zero document overflow. Same mechanism for the supplier expand. The below-table section
   is gone.
4. **Print one metric.** A Print button on each expand + a print stylesheet that
   `display: none`s everything off the path to the card. The `visibility: hidden` version
   was built first and MEASURED FAILING — hidden elements keep their space, so the card
   landed pages down a blank document, and the sticky wrapper being a positioned ancestor
   defeated `position: absolute; top: 0` as well.
5. **One type scale up** across all four tables (cell values 12 → 14 px), with every column
   width re-measured rather than left to clip. 375 px re-checked: zero horizontal document
   overflow.
6. **Colour — identity and direction, never judgement.** Five section accents and a
   green/red tint on the period move. **No threshold colouring was introduced**; §0a.5's
   rule stands until Renzo states real targets.
7. **A Compare control.** The first indicator under a value is always the period-over-period
   move and is not switchable; the second chip toggles between the year-ago percentage and
   the same move as a real amount (`cmp=` in the URL).
8. **Every dictionary entry rewritten to 1–2 plain sentences** — *"way too wordy… AI slop"* —
   keeping the load-bearing facts (basis, exclusions, the NULL-≠-0 reasons) and the P4
   annotation sentences' numbers.
9. **"Delivered ₱/kg fed" → "Block price"**, everywhere: matrix row, campaign panel row,
   both expands, the dictionary. Renzo's own words: *"the price of the charcoal when it
   arrived at the block."* The metric KEY is unchanged, so every `?metric=` deep link still
   resolves, and **"True price" keeps its name** — the rename only works as a pair.
10. **The aging watchlist section is gone** — *"take out piles to go look at."* Component
    unmounted, nav anchor dropped, adapter read dropped. **`view_analytics_aging_watchlist`
    is untouched in the database** and `aging-watchlist.tsx` still compiles, so it is one
    read and one JSX element away. The aging MATRIX rows (Avg stock age, Stock over 120
    days) are unaffected.

**What this round refused.** Nothing was dropped from the database to tidy a page, and
"colour" was not allowed to become threshold semantics by the back door.

## 7. OWNER FEEDBACK ROUND 2 APPLIED — 2026-09-02

One feature: **the period filter.** Renzo, on the row expands drawing *"every month on
record"* back to 2020 while several metrics are honestly blank for most of that stretch:

> *"I would also like the option to click which years to display, which months, quarters
> etc. We must always default this filter checklist to checking all. We should have the
> option to select/deselect all as well."*

**One checklist component (`app/(app)/analytics/period-filter.tsx`), two surfaces:** the
matrix's period COLUMNS (beside the Y/Q/M toggle) and each row expand's chart YEARS (in the
chart card header). Same trigger, same `All` / `None`, same Esc-and-focus-return, both
themes, 375px clean.

**The structural decision.** The state is the set of **hidden** keys, never the selected
ones. *"Always default to checking all"* then stops being a default someone has to remember
and becomes a property of the shape — an absent param and an empty set cannot mean "nothing
is selected". It also gives the URL param its spelling: `?hide=` is dropped entirely when
nothing is hidden.

**Only the COLUMN filter is in the URL** (`?hide=<comma-joined period keys>`, resolved
server-side so a shared link paints correctly first time). The expand's year selection is
session state scoped to one card: a param carrying it would mean something different the
moment `metric=` changed, and a shared link would arrive with a filter belonging to a row
the recipient is not looking at.

**The rule the whole feature is built around: filtering HIDES, it never RESTATES.**

- The summary column re-folds over the selection through `buildMatrix`'s own machinery, so a
  filtered price is still Σ pesos ÷ Σ priced kilos. Measured: Apr–Sep prints **₱47.93**, the
  weighted fold, not the ₱47.85 mean of the six visible cells.
- It is headed **`Selected`**, never a year, and its comparison chip narrows the prior year
  to the same positions rather than comparing four months to twelve.
- A change still reads the real neighbouring period. Measured at YEAR granularity: with 2025
  hidden, 2026 still prints **−48.9%** (against 2025's actual value) and is *not* re-based
  onto the visible 2024, which would read −40.9%.
- Callouts cannot quote a hidden period, and it cost no new code: `displayed` is derived
  from the filtered set, which the record branch already required and the mover/year-ago
  branches get for free by walking `cells`. Measured: hiding the three months the strip was
  naming re-ranked it with zero references to any of them.
- The rolling average **breaks at the gap**. Hidden periods are nulled first, `rollingMean`
  runs over that sequence, and only then are they dropped. Measured on RC OUT with 2025
  hidden: two segments of **10 and 7** points (`12−2`, `9−2`); a bridging implementation
  would have drawn one run of 19 straight across the hole.
- The stat strip recomputes and **says so** — `Latest · selected`, `Highest · selected`,
  `Lowest · selected`, and a `Selected` window figure folded by `foldSelection`. Measured:
  `Highest` moved from Aug 2025 to Feb 2024 when 2025 was switched off.
- Print prints the selection and names what it left out, in the paper-only title line.

**What this round refused.** No number is recomputed by a second route — `foldSelection` is
a thin wrapper over the same `foldPeriod` + `rawValue` pair every column already uses, so a
mean of the surviving cells stays inexpressible in `matrix.ts`. And no filter is allowed to
change an arithmetic comparison: hiding a period removes it from view and from the fold,
never from the record a neighbouring figure is measured against.

---

## 8. OWNER FEEDBACK ROUND 3 APPLIED — 2026-09-02 (big-screen scale + three controls)

Renzo, on the live page: *"Make it more visible on bigger screens. It utilizes the space
well on my smaller 14-inch MacBook Pro screen, but on my 27-inch 1440p monitor it does not
really scale well. Text is much smaller. Overall I'd like to see things clearer."* — plus
three follow-ons in the same round: *"toggle on/off the 3 month average line in the
charts"*, *"toggle on and off the 'what it is' sections below the chart (could be a master
toggle instead)"*, and *"ability to default to landscape when printing"*.

### 8.1 The breakpoint is 1920px, and Tailwind's `2xl` would have been wrong

A 14-inch MacBook Pro reports a **logical** width of **1512 px** at its default scaling and
**1800 px** in "More Space". Tailwind's `2xl` is **1536 px**, so a `2xl:` bump would have
fired on the exact laptop Renzo says already reads well — the one screen this change had to
leave alone. 1800 is therefore the highest width that must stay small, and **1920** is the
next standard desktop step above it. A 2560-wide monitor crosses it with a window at 75% of
the screen; a window narrower than 1920 on that monitor is genuinely laptop-sized, so
falling back to the small scale there is correct rather than a miss.

ONE step, not a ladder: a second breakpoint doubles what has to be verified and there is no
third screen in evidence.

**Measured at the boundary:** 1800 px → small (`--bw-fs-14: .875rem`, name column 232 px);
**1919 px → small**; **1920 px → big** (17 px, 276 px). No JavaScript is involved, so there
is no `matchMedia`, no hydration seam and nothing to get wrong on a resize.

### 8.2 A CSS-variable ladder, because type and column width cannot be allowed to drift

The page's geometry is not only type: four tables carry explicit `<colgroup>` widths whose
SUM is each table's `minWidth` ("never crush, always scroll"). A type bump that left those
widths alone would clip a header — exactly the failure R1 re-measured every width to avoid.
Both are now variables on one container (`.bw-analytics`, `globals.css`), so they can only
move together.

**The small scale is declared on `:root`, only the big one on `.bw-analytics`.** Two
reasons, both load-bearing: Radix PORTALS the year `Select` and both `Popover`s to `<body>`,
outside the container, so a `var()` that resolved to nothing there would have dropped the
declaration entirely; and the shared drill-down chassis can then read the same variables
with its own literal as the fallback, leaving the Home Digest reading the number it always
did. (All three portals also carry `bw-analytics` so they scale WITH the page — the `:root`
declaration is the net under them, not the mechanism.)

**Type — one variable per size that already existed, so the small scale is reproduced
exactly rather than approximated by merging sizes into a shorter ladder (~1.19x):**

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
small scale is byte-identical even for a reader who has raised their browser's root font
size; the rest were px literals in the source and stay px.

**Boxes:** row 62 → 74, header row 36 → 42, section band 28 → 33, value line 20 → 24, delta
line 16 → 19, controls 32 → 38. **Charts:** expand 260 → **340**, supplier expand 220 →
**290** — `ResponsiveContainer` is `height="100%"` inside those boxes, so recharts
re-measures for free.

**Widths, re-derived at the big scale (~1.19x, matching the type):**

| table | small | big |
|---|---|---|
| KPI matrix | 232 / 116 / 128 | **276 / 138 / 152** |
| Campaign panel | 232 / 128 | **276 / 152** |
| Supplier matrix | 196 / 92 / 124 | **234 / 110 / 148** |
| Grade mix | 184 / 92 / 124 | **220 / 110 / 148** |
| Premium table | 148 / 78 / 196 / 82 / 92 | **176 / 94 / 234 / 98 / 110** |

Each table's `minWidth` became a `calc()` over the same variables, so the "sum of the
colgroup IS the minWidth" guarantee is now structural rather than re-typed. The in-place
expand's clamp became a CSS `min(measuredFrame, thatCalc)` for the same reason — identical
semantics, resolved at the same breakpoint.

**The container was the other half of the problem.** `max-w-7xl` is 1280 px, so on a 2560 px
monitor the whole room rendered inside HALF the screen. Above 1920 it relaxes to
**1760 px** — sized against the widest real object rather than picked for looks: the KPI
matrix at the big scale with a nine-column year is 276 + 9x138 + 152 = **1670 px**, so at
1760 it finally fits with no sideways scroll and the page still leaves real margin.

### 8.3 The three controls

**The 3-period average line** — a labelled checkbox beside the chart card's `Years` filter,
DEFAULT ON. Not a clickable recharts legend: its hit target is a ~10 px swatch that looks
exactly like the static legend it has always been (a control that must be discovered by
clicking things is not a control), and it sits INSIDE the print card. The line is genuinely
removed rather than hidden, so recharts drops its legend entry with it and print needs no
rule of its own. `canDrawAvg()` is the ONE definition of when the line can exist at all —
never at YEAR granularity, never on the paired Block-price-vs-True-cost chart — and where it
returns false the control is not rendered either. **The paired chart carries no average
today and still does not.** Session state per card, matched to the `Years` filter beside it.

**`Definitions` — a MASTER page switch** (`?dict=off`), beside `Per working day` and wearing
the same `Switch`, DEFAULT ON. Master rather than per-card for a reason the per-card version
could not meet: both matrices key an expand by metric, so a per-card setting would come back
on the moment a different row was opened. It governs the two dictionary CARDS only — every
row name keeps its own `Info` popover, which is the definition at the point of use and costs
no vertical space. The param is spelled only in the non-default state (the R2 rule), so the
default view keeps a clean address.

**Landscape print** — `@page { size: A4 landscape; margin: 12mm }`. It is the right default
rather than a preference because the card is a WIDE object: measured under the real print
rules, landscape keeps the chart and its side rail two-column (`676px 320px`) and the stat
strip at 246 px a cell, where portrait collapses the rail UNDER the chart (`lg:` is 1024 px,
portrait's printable column is 703 px) and squeezes the stats to 164 px.

### 8.4 Measured in the browser (throwaway harness under `app/dev/table-playground/`, deleted)

- **1512 px is byte-identical to before**, both themes: header 11.5 px, row label 13 px,
  sublabel 11 px, value 14 px, delta 11 px, band 11 px; widths 232/116/128, campaign 232/128,
  supplier 196/92/124, premium 148/78/196/82/92, grade 184/92/124; container 1280 px; zero
  horizontal document overflow.
- **2560 px**: header 13.5, label 15.5, sublabel 13, value 17, band 13; row box 74, header row
  42, band 33, value line 24; container 1760; KPI table 1670 inside a 1710 frame — **no
  sideways scroll**; campaign 1644, supplier 1372, grade 1358, premium 712, all inside the
  frame; chart 340 px, stat value 22 px, axis ticks 12 px; **zero truncated labels** (the two
  that ellipsised at 1512 both fit); zero horizontal document overflow.
- **Frozen panes at both scales**: the KPI name column stays `position: sticky; left: 0;
  z-index: 10` over a SOLID token and **drifts 0 px** with the periods scrolled 174 / 300 px.
  The supplier matrix's in-place expand resolves to
  `min(1710px, calc(--an-w-supplier + 9 * --an-w-month + --an-w-month-total))` = 1372 px and
  drifts 0 px.
- **All three portals scale**: the `Columns` popover (items 14 px, header 13 px), the row
  `Info` popover, and the year `Select` (option 14 px) — each inside `.bw-analytics`, each
  inside the viewport.
- **375 px unchanged**: container 375, small scale, **zero horizontal document overflow**,
  every table scrolling inside its own wrapper.
- **Print, emulated by lifting every `@media print` rule into a live stylesheet**: `@page`
  reports `a4 landscape / 12mm`; the card lands at `top: 0, left: 0` at the full 1032 px
  printable width; the on-screen header and both `data-print-hide` controls are `display:
  none`; the paper-only title and restatement lines are `display: block`; and the scale is
  **pinned small on paper** (`--bw-fs-14: .875rem`, `--an-chart: 260px`) so what R1 measured
  onto a sheet keeps landing on a sheet whatever monitor the dialog was opened from. A plain
  metric (RC OUT) is **0.96 of a page**; a rail-carrying metric with `Definitions` off is
  0.91 (Ending inventory) and 0.73 (Block price).
- **Both toggles**: the average line and its legend entry disappear together and come back
  (`aria-checked` follows); the paired row and YEAR granularity render no control at all;
  `Definitions` off removes both dictionary cards from the top matrix's expand AND from the
  production room's own expand, takes the card from 773 → 611 px, writes `?dict=off`, drops
  the param again when switched back on, and leaves all 44 row `Info` buttons in place.

## 9. OWNER FEEDBACK ROUND 4 APPLIED — 2026-09-02 (ROUND 4 RESTRUCTURE)

Renzo's nine-item list, applied on `feat/analytics-round4`. **This is the round that
changed the page's SHAPE**, so §4's phase descriptions and §6–§8's row lists describe a
page that no longer exists in one respect: the MONEY section is gone. The full
reasoning, the measured verification and the row-by-row map live in
`app/(app)/analytics/CONTEXT.md` → "Owner feedback round 4 — the restructure"; this
section records the decisions.

### 9.1 The Money section is dissolved, and the reason is a CLOCK

Renzo: *"money is redundant, most of it is analyzable in the by-production-batch
section."* Confirmed. The money band's **Block price** was the CALENDAR-month basis of
the figure the campaign panel already publishes on the **CAMPAIGN** basis — the same fact
against two different clocks — and a campaign is the clock the plant actually runs on
(AUGUST closed and SEPTEMBER opened on 2026-08-29). Neither was wrong; the calendar
reading was the one that could go.

That answer is **recorded at the point of use**, in the campaign panel's Block price row
hover, not only in a document.

| Row | Fate |
|---|---|
| Block price · ₱ per produced kg · True ₱/kg (closed) | **RETIRED** — the campaign panel carries both bases |
| Blocks closed · Closed-block loss | **→ campaign panel**, as per-campaign rows |
| Yield | **→ Production**, joined by its complement Process loss |
| Avg stock age · Stock over 120 days | **→ the volume/stock band, RENAMED "RC Inventory"** |

Twenty-two rows in three bands became **eighteen in two**; the nav went from five anchors
to four. **Nothing left the database or the payload** — every retired row's field still
crosses the wire behind the same ₱ gate, exactly as R1's four retirements did, and no
migration was written. Deep links were checked: none of the four digest drill-downs names
a retired key.

### 9.2 The plan's "no threshold colouring" rule is still untouched

R4 added a gradient AREA fill under line metrics and a second Y axis for an optional
price overlay. Both are identity and shape, not judgement: the fill is the series' own
colour and the overlay is a second series, so nothing on this page still turns a colour
because a value crossed a number. The rule holds through four rounds.

### 9.3 Two measured corrections this round, both of the same shape

- **Yield's weighted rollup had the `intensityUsable` bug.** Numerator and denominator
  were summed independently across months where charcoal was fed and no production was
  reported, so the 2025 column read ~2.3% against a real 14.0%. Both halves now gate on
  one `yieldUsable` predicate — the same fix P4 applied to power intensity, one row later.
- **The stat strip and the chart header counted different populations** under labels that
  both said "months" (45 vs 44 in Renzo's screenshot; 75 vs 33 on RC OUT). Both now print
  one derived count of periods carrying a figure, taken from the chart's own data.

### 9.4 The universal module contract

*"Each module is something I look at and possibly report."* All three expand surfaces now
carry the same chrome: a period checklist with the smart default, a stat strip that
recomputes from it, an average switch, Print, and the page's master `Definitions` switch.
The supplier expand was the gap and gained all four; `printCard` moved into its own
module so two cards share one mechanism. The campaign panel is not an expand and did not
gain the contract — it gained the two rows above.

### 9.5 The R2 "always default to checking all" rule, narrowed

Superseded for the CHART filters only: an expand's checklist opens on the periods that
carry a figure for that row. The MATRIX column filter is unchanged, because its periods
come from the zero-filled flow spine and there are no empty ones to hide. Because the
state is the HIDDEN set, this was a different starting value rather than a different
mechanism — `All` / `None`, the coverage counts and the reversibility are untouched, and
the control can never hide every period.

### 9.6 Gates

`npx tsc --noEmit` clean · `npm run lint` 146 problems / 16 errors (unchanged) ·
`npm run build` clean · `verify-table-core` 84 assertions · `test:e2e` 57 passed ·
browser-verified in a throwaway harness at `app/dev/table-playground/analytics-r4/`
(a NEW subdirectory — the committed Blackwood Table playground beside it was not
touched), since deleted.

---

## 10. OWNER FEEDBACK ROUND 5 APPLIED — 2026-09-02 (ROUND 5)

Renzo's eight-item list. **This round re-ordered the page, removed two surfaces, and
gave every table group a filter, an order and a report.** Full detail and every
measurement lives in `app/(app)/analytics/CONTEXT.md` → "Owner feedback round 5"; this
is the plan-level record of WHAT was decided and WHY.

| # | Asked for | Landed |
|---|---|---|
| 1 | A visible line between every matrix row | `.bw-row-rule` — a border on each CELL, so the opaque frozen column carries it |
| 2 | Drag-to-reorder rows within their section | Grip handle + HTML5 DnD + ↑/↓ keyboard, persisted per browser |
| 3 | Print per metric group | One landscape report, each row's card on its own page |
| 4 | Remove the callout strip and two supplier prose blocks | UI unmounted; every pure function and honesty gate kept |
| 5 | Grade rows expand like everything else | `grade-expand.tsx`, full universal module contract |
| 6 | The campaign panel gets its own checklist | Chronological by the month the batch NAME spells, never alphabetical |
| 7 | Production above Suppliers | Page order and anchors both moved |
| 8 | The batch filter drives the production months | A second fold + a `monthFilter` on the grade year |

### 10.1 The two decisions worth recording at plan level

**Row order is per-browser `localStorage`, not a URL param.** Every other control on
this page is in the address bar because each describes WHAT IS ON SCREEN — a link
carrying one shows the recipient the same figures. A row order describes how one reader
likes to read: it changes no number, hides nothing, and pasting it into a colleague's
browser would rearrange a page they had already learned. It is also eight to ten keys
per section and would dominate the address. The page footer states this.

**The batch filter IS a URL param (`?bhide=`)**, by the same test read the other way: it
decides what is on screen — the campaign panel's columns AND the production band's
months — so it must survive a refresh and a share.

### 10.2 The page's reading order, restated

**PERIOD → CAMPAIGN → PRODUCTION → SUPPLIER.** §4's original order put production last
because it is where kilos stop being charcoal and start being product. R5 moves it up one
place for a stronger reason: the campaign checklist now DRIVES the production band's
months, and a control cannot be separated from the thing it controls by an unrelated
section. Suppliers reads last on its own merits — it is the only block answering "who",
it is the widest, and nothing else on the page depends on it.

### 10.3 What was NOT removed with the callout strip

`buildMatrix` still returns `callouts`, and `MatrixCell.calloutable` / `deltaQuotable` /
`yoyQuotable` are untouched. That gate is not decoration — it is what stops an estimate, a
metric's first period, an unfinished period or an annotated figure being quoted, and the
row expand's Highest / Lowest stats read the same predicate. §6's and §7's honesty rules
are intact; only the strip that displayed their output is gone.

### 10.4 The honest edge, stated at the point of use

Production is metered by CALENDAR month while a batch straddles months, and nothing in
the database attributes a meter reading to a campaign. So when the batch filter narrows
the band, **a month overlapping a selected AND an unselected batch is shown WHOLE** —
splitting it would mean inventing a per-batch share of a reading never taken per batch.
The production band's header says this in as many words, and points at the campaign panel
for output and yield per batch. It is R4's calendar-vs-batch answer read in the other
direction: R4 retired the money band because the CAMPAIGN was the right clock for a cost;
this band is the one place the CALENDAR clock is still the right one.

### 10.5 Gates

`npx tsc --noEmit` clean · `npm run lint` 146 problems / 16 errors (unchanged) ·
`npm run build` clean · `verify-table-core` 84 assertions · `test:e2e` 57 passed ·
browser-verified in a throwaway harness at `app/dev/table-playground/analytics-r5/`
(a NEW subdirectory — the committed Blackwood Table playground beside it was not
touched), since deleted.
