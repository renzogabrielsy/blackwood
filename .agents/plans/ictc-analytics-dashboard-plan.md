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
