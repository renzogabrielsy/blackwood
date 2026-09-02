# RC Movement Module — Daily Feed Matrix

## Purpose
A cross-tab / pivot of feeding activity, mirroring how the user reasons about a **production campaign** at a glance: **days as rows, opened blocks as columns, kg-fed in the cells.** This is the dense matrix at the **standalone route `/inventory/rc-movement`** (Phase 2 — it is NO LONGER a tab inside the `/inventory` logs shell).

> **⚠ "FED" MEANS `rc_out.destination = 'MAIN'` — SUNDRY PULLS ARE NOT FEED (2026-09-02, migration `20260902071050_fed_excludes_sundry_destination`).** `destination` is `MAIN` (into the plant tank) or `SUNDRY` (pulled out of a block to be sun-dried; it returns later as a sundry re-entry DELIVERY). Every campaign view summed BOTH, so this screen showed **JANUARY 2026 "Charcoal fed" = 1,048,908 kg against a true 836,328 kg** and a yield of 65.56% against a true 82.23%. Fixed in SQL only — **no component changed and no column moved**; the matrix reads the same field names. Three consequences to know when reading the grid: (1) a `(date, block)` cell that was ONLY a sundry pull is **no longer a cell**, so blocks a campaign merely sun-dried from have dropped out of the column set (JAN 34 → 29 columns, MAR 41 → 32, APR 27 → 24); (2) the footer's **`totalOut` is still every rc_out row** (a balance figure, computed in `actions.ts` straight off `rc_out`), so on a block with sundry outflow it legitimately exceeds the column's fed total — that gap *is* the sundry pull; (3) `actualFedPrice` / `upliftPhpKg` are **NULL on any block with sundry outflow** (the view's `has_sundry_outflow` guard — the money left with the sun-dried charcoal and returns inside a different batch), which the UI already renders as blank. `weightLostKg` / `lossPct` are unchanged: they subtract ALL outflow, because a sundry pull is not evaporation. `view_rc_movement_campaign_options` now also carries `sundry_kg` / `out_kg` / `out_days` if the screen ever wants to print "+212,580 kg pulled to sun-drying".

> **Campaign-scoped (NOT calendar-month).** The picker selects a **production campaign** = `(production_batch, campaign_year)`, e.g. `("JUNE", 2026)` labelled **"June 2026"**. A campaign straddles calendar months and **splits transition days by tag** — the campaign-keyed SQL views already handle the split, so BOTH fed (RC OUT) and produced (production) are filtered to the same campaign. The `production_batch` is stored as the **bare uppercase month name** (e.g. `JUNE`, `MAY`), so the URL-safe key is `${production_batch}-${campaign_year}` → `"JUNE-2026"` and the label title-cases the month. **2024 legacy campaigns are excluded** from the picker (`campaign_year >= 2025`). Production output only exists Dec-2025+, so earlier campaigns are **fed-but-no-production** (produced = 0 / yield = NULL) — tolerated gracefully.

> **Domain Module (Charcoal Tenant):** Tenant-specific. Reads the charcoal-shaped **8 campaign-keyed SQL views** (`view_rc_movement_campaign_*`). Lives in the inventory/charcoal layer — never imported by platform widgets. (The old per-month `view_rc_movement` + `view_rc_movement_*_price`/`*_production_*`/`*_yield_monthly` views are retired from this module; `view_rc_movement_batch_price` is kept — it is campaign-independent.)

> **Single view now.** The earlier flat-list Movement view (one row per (date, batch lane)) was **retired** — the user decided the matrix is the correct presentation. The folder holds the matrix component, its server action, and (Phase 2) a **standalone route** (`page.tsx` + `rc-movement-route-view.tsx`). The old lazy tab `../components/rc-movement-matrix-lazy-tab.tsx` was **deleted** — its fetch + `?campaign=` URL logic moved into `rc-movement-route-view.tsx`.

## Files
| File | Lines | Role |
|------|-------|------|
| `actions.ts` | ~700 | Backend. Single server action `fetchRcMovementMatrix(campaign?)` → `RcMovementMatrix`. `campaign` = the encoded campaign key `"PRODUCTION_BATCH-YEAR"` (e.g. `"JUNE-2026"`); absent/invalid → resolves to the most recent campaign. Builds `campaignOptions` from `view_rc_movement_campaign_options` (filtered `campaign_year >= 2025`, ordered `max_date` desc). For the resolved `(pb, yr)` it pivots `view_rc_movement_campaign_cells` into ordered block-columns × calendar-day-rows (day-range from the options view's `min_date`→`max_date`), and reads the campaign fed-price views (`_campaign_day_price`, `_campaign_price`) + the campaign production/yield views (`_campaign_production_daily`, `_campaign_production_daily_total`, `_campaign_production`, `_campaign_yield`). Every campaign view is filtered `.eq('production_batch', pb).eq('campaign_year', yr)`. The per-block footer pass (status / totalIn / totalOut / mc / ash / blockLoss / `avgFedPrice`) is **all-time per-batch, campaign-independent** — unchanged (`batches`, `deliveries`, `rc_out`, `view_rc_movement_batch_price`). Pages through every view via the **shared `fetchAllRows()` helper** (`@/lib/supabase/paginate`, DUP-1 — a thin local `fetchAll` delegates to it; the helper's throw surfaces as the action's `empty` fallback) to bypass PostgREST's 1000-row cap. |
| `page.tsx` | ~78 | **Standalone route entry (`/inventory/rc-movement`).** Server component. **DEFAULTS TO v2 since 2026-08-29** — `resolveGrid(params.grid, GRID_V2)`; the Classic matrix is `?grid=v1` (see "The flip" below). The Classic branch renders `<RcMovementRouteView>` inside a `<Suspense>` exactly as before (the view uses `useSearchParams`), while the v2 branch awaits `fetchRcMovementMatrix(campaign)` HERE and hands the payload down as a prop. |
| `rc-movement-route-view.tsx` | ~95 | **NEW. Standalone-route host.** Client component owning the matrix fetch (`fetchRcMovementMatrix(campaign?)`), the spinner/empty states, the `?campaign=` URL param (read via `useSearchParams`, written via `router.replace`), and the `onNavigateToBatch` wiring (`router.push('/inventory?tab=…')`). SHELL-AGNOSTIC — does NOT use `useInventoryTab`. Repurposed from the deleted `rc-movement-matrix-lazy-tab`. |
| `rc-movement-matrix.tsx` | ~1400 | **Matrix** client table. Frozen-pane sticky table: **5** pinned left columns (Row # / Date / Day / Fed ₱/kg / Total fed) + frozen header row + pinned top-left corner **+ frozen summary footer pinned to the container bottom** (per-column stacked summary + bottom-left corner). Scrolling region: **PRODUCED group (TOTAL PRODUCED + dynamic per-grade columns)** FIRST, then the dynamic per-batch BLOCK columns; 2px `GROUP_DIVIDER` borders separate the two scrolling groups. `table-fixed`, explicit px widths, `h-8` rows, mono right-aligned numerics, thousands separators, blank zero cells. **Active campaign** is shown as a prominent toolbar label (eyebrow "Campaign" over the `campaignLabel` heading, e.g. "June 2026") beside the **campaign picker** (shadcn `Select`, value = encoded key, options = `campaignOptions`); selecting calls `onCampaignChange?(campaign)` → the route view writes it to the `?campaign=` URL param and re-fetches. Block column headers are **clickable** → open the shared `BlockingDetailPanel` (slide-over) for that column's batch. **Props:** `data`, `onCampaignChange?`, **`onNavigateToBatch?`** (passed straight to the detail panel's "Edit All"; the standalone route wires it to `router.push('/inventory?tab=…')`). |

| `rc-movement-grid-v2.tsx` | ~1200 | **THE DEFAULT GRID since 2026-08-29** (built 2026-08-19). The same day×block matrix on the **Blackwood Table** (`lib/table/` + `components/shared/table/`). READ-ONLY, built BESIDE the Classic matrix, which is not edited by one character — nor is `rc-movement-route-view.tsx`. Owns its own campaign picker (writes `?campaign=`, preserving every other param) and a `useTransition` busy state. Its column widths are **measured, not eyeballed** (see "Header widths") and its campaign totals row is a **bottom-pinned summary row**. See "The flip". |

> The folder now HAS a `page.tsx` (Phase 2) — `/inventory/rc-movement` is a real standalone route. The matrix is reached there (no longer via a tab).

### Mobile (Archetype E phone-summary)
The frozen matrix can't shrink to a phone (its frozen-left region alone is 384px > a 375px screen), so `rc-movement-matrix.tsx` is **additive-responsive**: the full `<table>` is wrapped `hidden sm:flex` (byte-for-byte unchanged, desktop/landscape only) and a `sm:hidden` **`RcMovementSummaryMobile`** renders below it. The summary = a **campaign KPI strip** (Fed `grandTotalFed`, Produced `campaignTotalProduced`, Yield `campaignYieldPct`, Loss = `1 − yield` display transform, and a price-gated Camp. ₱/kg from `campaignAvgFedPrice`) + a **tappable block list** (`columns[].{batchCode, blockLoc, totalOut, blockLoss, status}` → taps through to the SAME `BlockingDetailPanel` via `handleHeaderClick`) + a **per-day feed list** (`rows[].{date, dayOfWeek, totalFed, totalProduced, avgFedPriceDay}`). **Every number is reused verbatim from `data` — nothing is recomputed** (CLAUDE.md); ₱ honors `data.canViewPrices` exactly as the desktop `showFedPrice` gate does (no ₱ for Production). The toolbar row is `flex-wrap` so it doesn't overflow at 375px. Helpers `KpiTile` / `StatusPill` are local to the file.

## Data
- **Source:** the **8 campaign-keyed views** (`view_rc_movement_campaign_*`, see below) + `batches`/`deliveries`/`rc_out`/`view_rc_movement_batch_price` for the all-time per-block footer pass. (The selected campaign's `production_batch` comes straight from the resolved campaign — no separate `rc_out` dominant-batch query.)
- **Server action:** `fetchRcMovementMatrix(campaign?)` from `app/(app)/inventory/rc-movement/actions.ts`. `campaign` = encoded key `"PRODUCTION_BATCH-YEAR"` (e.g. `"JUNE-2026"`); absent/invalid → most recent campaign.
- **Types:** `RcMovementMatrix`, `RcMovementMatrixColumn`, `RcMovementMatrixRow`, `RcMovementCampaignOption`, **`RcMovementActualFedPrice`**, **`RcMovementOpenBlock`** (all in `actions.ts`)
- **PRICE-GATED (server-side).** `fetchRcMovementMatrix` resolves the canonical gate `canViewPrices()` from `@/lib/auth` ONCE up front and **nulls every ₱ field BEFORE the payload leaves the server** when the effective role can't view prices (Production, **including an impersonating Owner/Admin/Dev** — the gate uses `getUserRole()`, so the `dev_mock_role` cookie is respected). Nulled fields: `row.avgFedPriceDay`, `column.avgFedPrice`, `matrix.campaignAvgFedPrice`. The matrix returns a `canViewPrices: boolean` so the client can conditionally render. (kg figures, lab metrics in the column hover tooltip, yield/loss are NOT gated.) **Frontend render guard is DONE (Wave-1 security fix complete).** `rc-movement-matrix.tsx` derives `const showFedPrice = data.canViewPrices` and, when false, **drops the entire Fed ₱/kg frozen column** (colgroup `<col>`, header cell, every body cell, footer "camp. avg" cell) AND the per-column footer ₱/kg line AND the tooltip "Fed price" row — so Production sees no confusingly-empty price column at all.

> **Frozen-pane geometry for the hidden price column (CRITICAL).** The Fed ₱/kg column is a FROZEN-left column, so removing it must keep the cumulative `left` offsets aligned (per CLAUDE.md Frozen Panes). The fix: `LEFT_TOTAL` is computed at RUNTIME from `showFedPrice` (it is no longer a module constant). The offsets up to and including Day are fixed (`LEFT_ROWNUM=0` · `LEFT_DATE=48` · `LEFT_DAY=148` · `LEFT_FEDPRICE=200`). Then `LEFT_TOTAL = showFedPrice ? LEFT_FEDPRICE + W_FEDPRICE (=296) : LEFT_FEDPRICE (=200)` — i.e. when the price column is hidden, **Total fed shifts LEFT by `W_FEDPRICE` (96px)** to sit directly after Day, and the total frozen width drops 384→288. Total fed stays the LAST frozen column and keeps `.frozen-edge`. The block (scrolling) columns flow after the frozen region, so they shift automatically — no manual `left` math on them. The conditional `{showFedPrice && …}` is applied identically in the colgroup, header, body, and footer so the column either exists in all three sections or none.

### Campaign views (all filtered `.eq('production_batch', pb).eq('campaign_year', yr)`)
All eight are SECURITY-INVOKER (granted authenticated/anon). `production_batch` is the **bare uppercase month name**; `campaign_year` is an integer. Price columns are NUMERIC and **NULL when zero-fed** (UI renders blank). kg figures may be 0 / NULL for fed-but-no-production campaigns. SQL is the source of truth — weighted averages, totals, and yield ratios are **NEVER** recomputed in TS.
| View | Key columns | Maps to |
|------|-------------|---------|
| `view_rc_movement_campaign_options` | `production_batch`, `campaign_year`, `feed_days`, `total_fed`, `min_date`, `max_date` | `campaignOptions` (filtered `campaign_year >= 2025`, ordered `max_date` desc; **drives the picker + default + the row day-range**) |
| `view_rc_movement_campaign_cells` | `date`, `batch_id`, `batch_code`, `block_loc`, `fed_kg` | block columns + `row.fedByBatch` + `row.totalFed` (pivot; PAGINATED past 1000 rows) |
| `view_rc_movement_campaign_day_price` | `date`, `wtd_fed_price`, `total_fed` | `row.avgFedPriceDay` (per-day, joined on `date`) |
| `view_rc_movement_campaign_price` | `wtd_fed_price`, `total_fed` | `matrix.campaignAvgFedPrice` (`.maybeSingle()`; EXACT/unrounded) |
| `view_rc_movement_campaign_production_daily` | `date`, `grade`, `produced_kg` | `row.producedByGrade` (date → grade → kg) |
| `view_rc_movement_campaign_production_daily_total` | `date`, `produced_kg` | `row.totalProduced` (per-day, null on no-production days) |
| `view_rc_movement_campaign_production` | `grade`, `produced_kg` | `matrix.producedGrades[].campaignTotal` (grade footer totals) + drives the present-grade set |
| `view_rc_movement_campaign_yield` | `total_fed`, `total_produced`, `yield_pct` (FRACTION), `loss_kg` | `matrix.campaignTotalProduced` / `campaignYieldPct` (fraction, kept as-is) / `campaignLossKg` (`.maybeSingle()`) |

Migration: `supabase/migrations/20260609010000_create_rc_movement_fed_price_views.sql` (and sibling campaign-view migrations). `view_rc_movement_batch_price` (per-block ₱/kg footer) is **campaign-independent** and reused unchanged.

### ACTUAL FED ₱/kg views (2026-08-07 — WIRED INTO THE UI, see "ACTUAL FED ₱/kg — UI" below)
Migration: `supabase/migrations/20260807090554_rc_movement_actual_fed_price.sql`. **Three new `security_invoker` views, strictly additive** — nothing above was altered, and `view_rc_movement_campaign_price` remains the **delivered-price reference line** the UI draws against.

> **The idea (Renzo).** *"This would be the total php amount of the block divided by the total fed kg of the block IF its closed (NOT the weights it arrived in). Inherently, prices would be higher since we would lose weight while maintaining the value."* A block arrives at a delivered ₱/kg, then dries out and loses weight — but the money already spent does not shrink, so each kilogram that actually reached the plant cost **more** than the arrival price. `actual_fed_php_kg` = `SUM(deliveries.cost_basis × weight_kg) ÷ SUM(rc_out.weight_kg)`, and it exists **only when the block is CLOSED** (only then is the fed total final).

| View | Grain | Key columns |
|------|-------|-------------|
| `view_rc_movement_block_actual_price` | one row per batch ever fed (`EXISTS rc_out`, same scope as `_batch_price`); **campaign-independent / all-time**, like the existing per-block footer pass | `batch_id`, `batch_code`, `block_loc`, `status`, `is_closed`, `close_date`, `first_fed_date`, `last_fed_date`, `feed_count`, `delivered_kg`, `delivered_value_php`, `total_fed_kg`, `delivered_php_kg`, **`actual_fed_php_kg`**, `uplift_php_kg`, `uplift_pct`, `weight_lost_kg`, `loss_pct`, `delivery_count`, `priced_delivery_count`, `unpriced_delivery_count`, **`has_unpriced_delivery`**, `is_fully_priced`, `priced_delivered_kg`, `unpriced_delivered_kg`, `priced_delivered_php_kg` |
| `view_rc_movement_campaign_actual_price` | one row per `(production_batch, campaign_year)` | coverage `blocks_fed`/`blocks_closed`/`blocks_open`/`blocks_in_price`/`blocks_closed_unpriced`; `campaign_fed_kg` + `_closed`/`_open`/`_included`/`_excluded`/`_included_pct`; `delivered_value_php`, `delivered_kg`, `block_fed_kg`; **`actual_fed_php_kg`**, **`campaign_weighted_actual_fed_php_kg`**, `delivered_php_kg`, `uplift_php_kg`, `weight_lost_kg`, `loss_pct`, `is_fully_covered` |
| `view_rc_movement_campaign_open_blocks` | one row per still-open block a campaign fed | `batch_code`, `block_loc`, `status`, `campaign_fed_kg`, `campaign_fed_kg_total`, `campaign_fed_share`, `campaign_first_fed_date`/`_last_fed_date`/`_feed_days`, `delivered_kg`, `delivered_value_php`, `delivered_php_kg`, `priced_delivered_php_kg`, `has_unpriced_delivery`, `unpriced_delivery_count`, `fed_kg_to_date`, `balance_kg`, `fed_share_of_delivered`, `first_fed_date`, `last_fed_date`, `feed_count` |

**Five rules the UI must not re-derive or work around.**

1. **`view_rc_out_closed_blocks` is a DIFFERENT statistic — do not substitute it.** Its `total_value` is *fed kg × delivered price*, so its `avg_price` collapses back to the **delivered** ₱/kg (₱48.1612 for `JAN-26-BLK22`). The new views divide the **delivered value** (₱2,708,294.30) by the **fed kg** (53,512) → **₱50.6110**.
2. **NULL is NEVER 0 here.** `cost_basis = 0` is the L-008 unpriced placeholder, so a partially-priced block computes an **understated** price that points opposite to the whole insight (`FEB-26-BLK5`: delivered ₱49.00, lost weight, computes to ₱38.4957). Both `actual_fed_php_kg` and `delivered_php_kg` are NULL unless the block is **CLOSED and fully priced**. Render a blank + explain it from `has_unpriced_delivery` / `unpriced_delivery_count`; show `priced_delivered_php_kg` as the honest partial. Never `?? 0`, never format a null as ₱0.00.
3. **An OPEN block has no actual price, by design** — `actual_fed_php_kg` is NULL with `is_closed = false` (e.g. `JAN-26-BLK18`). Its `delivered_php_kg` is still populated when priced, so the column is not empty; only the *actual* figure waits for closure.
4. **The campaign figures are pre-aggregated in SQL — never average the per-block prices in TS** (JULY 2026: correct ₱47.2747 vs naive mean ₱45.8374). Pick ONE of the two exposed forms and label it: `actual_fed_php_kg` = whole-block value ÷ whole-block all-time fed kg (*"the blocks this campaign drew from cost this"*, ₱47.2747); `campaign_weighted_actual_fed_php_kg` = attributed to this campaign's own fed kg (₱46.2492), shaped like `view_rc_movement_campaign_price` so it is the apples-to-apples partner of the delivered line. Coverage columns exist so the **"18 of 19 blocks closed"** badge never counts rows client-side; clicking it lists `view_rc_movement_campaign_open_blocks` (JULY 2026 → `JAN-26-BLK18`, A-8B, IN-USE, 13,134 kg = 1.68% of the campaign, 3,933 kg still in the block).
5. **`loss_pct`, `uplift_pct`, `campaign_fed_share`, `campaign_fed_kg_included_pct` and `fed_share_of_delivered` are FRACTIONS, not percents** — ×100 at render, matching the existing `campaignYieldPct` convention. `weight_lost_kg` is only *loss* once `is_closed`; on an open block read `balance_kg` instead (that is charcoal still sitting there, not evaporation).

**PRICE-GATED.** All three carry ₱ (`delivered_value_php`, `delivered_php_kg`, `actual_fed_php_kg`, `uplift_php_kg`, `priced_delivered_php_kg`). Whichever server action exposes them must null those fields **before the payload leaves the server** under `canViewPrices()` and pass a `canViewPrices` boolean down — exactly as `fetchRcMovementMatrix` already does for `avgFedPrice` / `avgFedPriceDay` / `campaignAvgFedPrice`, and the matrix drops the whole Fed ₱/kg column for Production. **Wired into `actions.ts` on 2026-08-07 with a STRONGER gate than nulling: all three views are NOT QUERIED AT ALL when `!canViewPrices()`** — every column they carry is ₱-derived (even the coverage counts exist only to qualify a ₱ figure), so the payload cannot leak what was never fetched. `campaignActualFedPrice` comes back `null`, `openBlocks` `[]`, and every column's `actualFedPrice` `null`.

**Data reality worth knowing before designing the UI:** of 458 closed+priced blocks, **334 (72.9%) lost weight** and behave as the premise predicts (actual > delivered); **101 fed exactly what was delivered** (uplift ₱0.00 — the closing feed balanced the block to zero); **23 fed MORE than delivered** (negative balance, so actual < delivered). So `uplift_php_kg` is legitimately zero or negative on ~27% of blocks — do not treat that as an error state.

**Dynamic grade set + canonical order:** grade columns are derived PER CAMPAIGN (never hardcoded). `producedGrades` is built from `view_rc_movement_campaign_production`'s grade set (falls back to the union of daily by-grade rows when empty), ordered canonically `3X50 · 6X50 · 8X50 · 2X6` filtered to grades present this campaign; any non-canonical grade is appended alphabetically (surfaces rather than silently dropping). A fed-but-no-production campaign yields an **empty** grade set (just the TOTAL PRODUCED column, no grade columns).

### `RcMovementMatrix` shape
```typescript
{
  campaign: string;               // resolved encoded key, e.g. "JUNE-2026" ('' when none)
  productionBatch: string;        // resolved bare month, e.g. "JUNE"
  campaignYear: number;           // resolved year, e.g. 2026 (0 when none)
  campaignLabel: string;          // resolved human label, e.g. "June 2026"
  columns: Array<{                // ordered by firstFedDate, tie-break batchCode
    batchId: string;
    batchCode: string;
    blockLoc: string | null;      // '' / null FEED blocks -> null
    firstFedDate: string;         // YYYY-MM-DD
    // ── Footer summary (ALL-TIME per-batch, campaign-independent; ONE batched pass) ──
    totalOut: number;             // all-time SUM(rc_out.weight_kg) for this batch (= total fed)
    totalIn: number;              // all-time SUM(deliveries.weight_kg) for this batch
    status: string;               // batches.status -> IN-USE (blue) / else CLOSED (red) badge
    mc: number;                   // weighted-avg moisture % (0 when no metric-bearing deliveries)
    ash: number;                  // weighted-avg ash %
    blockLoss: number | null;     // (totalOut - totalIn) / totalIn, signed ratio; null when totalIn = 0
    avgFedPrice: number | null;   // weighted-avg fed price ₱/kg (view_rc_movement_batch_price); null = zero-fed
    actualFedPrice: number | null; // ACTUAL FED ₱/kg (view_rc_movement_block_actual_price.actual_fed_php_kg). NULL = block OPEN or has an unpriced delivery — render BLANK, never ₱0.00
    isClosed: boolean;            // why a blank is blank, reason 1
    hasUnpricedDelivery: boolean; // why a blank is blank, reason 2
    upliftPhpKg: number | null;   // actual − delivered ₱/kg. Legitimately 0 / NEGATIVE on ~27% of closed blocks — render NEUTRALLY (no red, no warning)
    weightLostKg: number | null;  // delivered − fed. Only MEANS "lost" once isClosed (tooltip omits it on an open block)
    lossPct: number | null;       // FRACTION (×100 at render)
  }>;
  rows: Array<{                    // every calendar day, campaign min_date→max_date
    rowNum: number;               // 1-based
    date: string;                 // YYYY-MM-DD
    dayOfWeek: string;            // Mon/Tue/…
    productionBatch: string | null; // the campaign's production_batch (SAME on every row); kept in the data layer but NO LONGER RENDERED (the Batch column was removed)
    totalFed: number;             // sum of fed_kg across blocks (kg)
    fedByBatch: Record<string, number>; // batchId -> kg (absent = blank cell)
    avgFedPriceDay: number | null; // day's weighted-avg fed price ₱/kg (campaign_day_price); null = zero-fed day
    totalProduced: number | null;  // day's total produced kg (campaign_production_daily_total); null = no-production day
    producedByGrade: Record<string, number>; // grade -> kg produced that day (absent/0 = blank cell)
  }>;
  campaignOptions: Array<{ productionBatch: string; campaignYear: number; value: string; label: string; feedDays: number; totalFed: number }>;
  grandTotalFed: number;          // SUM of fed_kg across the visible campaign (footer grand total, kg)
  campaignAvgFedPrice: number | null; // campaign's weighted-avg fed price ₱/kg (campaign_price); EXACT (unrounded); null = zero-fed
  producedGrades: Array<{ grade: string; campaignTotal: number | null }>; // present-this-campaign grades, canonical order; campaignTotal from the campaign by-grade view
  campaignTotalProduced: number | null; // campaign's total produced kg (campaign_yield.total_produced); null = no production
  campaignYieldPct: number | null;   // campaign's yield as a FRACTION (produced/fed) — kept AS-IS (×100 for display); null when total_fed = 0
  campaignLossKg: number | null;     // campaign's loss kg (fed − produced; campaign_yield.loss_kg) — in data layer, not rendered
  campaignActualFedPrice: {          // ACTUAL FED ₱/kg rollup (view_rc_movement_campaign_actual_price). NULL when the campaign has no row OR the caller can't view prices (the view is NOT QUERIED then)
    actualFedPhpKg: number | null;              // PRIMARY headline — whole-block value ÷ whole-block all-time fed kg (Renzo's definition). NULL, never 0
    campaignWeightedActualFedPhpKg: number | null; // apples-to-apples twin of campaignAvgFedPrice (campaign-attributed). Available, not currently rendered
    deliveredPhpKg: number | null; upliftPhpKg: number | null; // delivered reference + uplift over the SAME price set
    blocksFed: number; blocksClosed: number; blocksOpen: number; blocksInPrice: number; blocksClosedUnpriced: number; // coverage — SQL-counted, never counted in TS
    campaignFedKgIncludedPct: number | null;    // FRACTION of the campaign's fed kg the statistic covers (×100 at render)
    isFullyCovered: boolean;
  } | null;
  openBlocks: Array<{                // the campaign's still-open blocks (view_rc_movement_campaign_open_blocks) = exactly what the actual price excludes. [] when !canViewPrices (not queried)
    batchId; batchCode; blockLoc; status; campaignFedKg; campaignFedShare /*FRACTION*/; campaignFeedDays;
    campaignFirstFedDate; campaignLastFedDate; deliveredKg; deliveredPhpKg; pricedDeliveredPhpKg;
    hasUnpricedDelivery; unpricedDeliveryCount; fedKgToDate; balanceKg; firstFedDate; lastFedDate; feedCount;
  }>;
  canViewPrices: boolean;            // canonical server-side price gate (lib/auth.canViewPrices); FALSE for Production (incl. impersonated). When false, ALL ₱ fields above are already nulled server-side
}
```

### ACTUAL FED ₱/kg — UI (2026-08-07)
Renzo: *"Below the current pricing feature you have on the footer, should have another line with the price if closed, blank if not closed."* · *"**Keep** the current way you're pricing still. It's a good reference."* · *"It would be nice to see the blocks still open and clicking that badge should pop up a modal or a sidepanel."*

Four surfaces, all in `rc-movement-matrix.tsx`, all **additive — nothing existing was changed**. Line 3 (the delivered weighted-avg ₱/kg) and the footer's `camp. avg` cell are deliberately **untouched**: they are the reference the new number is read against.

| Surface | What it shows | Blank rule |
|---|---|---|
| **Per-column footer, Line 4** (`actual`) | `column.actualFedPrice`, directly under Line 3, separated by a `border-border/60` hairline. Bolder + one step larger (`text-[11px] font-bold` vs Line 3's `text-[10px]`) so it reads as the more important figure at grid density. | **BLANK** when null. The LABEL slot is kept so every per-column footer stays the same height; the hover tooltip says *why* (`block still open` / `awaiting price`). |
| **Footer campaign cell** (frozen `Fed ₱/kg` column) | `camp. avg ₱44.55` (unchanged) → hairline → **`actual fed ₱47.27`** (bold, `text-[13px]`) → `16/19 priced`. Uses `actualFedPhpKg`, the PRIMARY form. The coverage line reads **`blocksInPrice`, NOT `blocksClosed`** — a closed-but-unpriced block is closed and *still excluded*, so printing 18 here would overstate what the ₱ above it covers (JULY 2026: 18 closed, 16 in the price). The hover title spells out all four counts. | Value blank when null; the coverage line always shows so a partial figure is never read as the whole campaign. |
| **Toolbar coverage badge** | `● 18 of 19 blocks closed · 1 open` — a **button** when `openBlocks.length > 0`, an inert pill otherwise. Counts come from `blocksClosed`/`blocksFed`. | Absent entirely when `campaignActualFedPrice` is null (no row, or price-gated). |
| **`OpenBlocksDialog`** (the badge's modal) | One dense `table-fixed` row per open block: Block (code + loc, click-through to `BlockingDetailPanel`), Status, Fed here, Share, Balance, Feeds, **Last fed = the BLOCK's own `lastFedDate`** (its campaign window is on the hover title — `JAN-26-BLK18` last fed `2026-08-06`, after this campaign closed on `2026-07-29`), ₱/kg in. Header states `16 of 19` + `83.21% of the campaign's fed kg` + the `blocksClosedUnpriced` exclusion. | `deliveredPhpKg` null → falls back to `pricedDeliveredPhpKg` with a `*` and a footnote; never ₱0.00. |

Plus the phone summary (`RcMovementSummaryMobile`): an `ACTUAL FED ₱/KG` KpiTile beneath the existing `CAMP. ₱/KG` tile, with the coverage as its caption (`KpiTile` gained an optional `sub`).

Three rules this UI holds to:
1. **NULL renders as BLANK, never ₱0.00 and never a dash that looks like a value.** Verified on `JAN-26-BLK18` (open) and `FEB-26-BLK1`/`FEB-26-BLK4` (closed, unpriced) — the `ACTUAL` label renders with nothing after it.
2. **Zero / negative uplift is rendered neutrally** — no red, no warning icon, no badge. `JULY-26-FEED1`/`FEED2`/`JUNE-26-FEED7` all read `₱/KG 36.00 → ACTUAL 36.00` and look completely normal, which is correct: ~27% of closed blocks fed exactly or more than was delivered.
3. **Price gating is structural, not cosmetic.** `showFedPrice = data.canViewPrices` drops the whole frozen `Fed ₱/kg` column (Line 3 AND Line 4, the campaign cell, the tooltip rows) and the coverage badge, and `LEFT_TOTAL` collapses to `LEFT_FEDPRICE` so the frozen offsets stay cumulative (measured under Production: `0 / 48 / 148 / 200` with `frozen-edge` on `Total fed`). Measured on the gated render: **0 `₱` glyphs and no `ACTUAL` / `blocks closed` text in the DOM at all.**

Footer height grew by one line; the frozen geometry is unchanged (`.frozen-corner-bottom` + `.frozen-edge-top`, solid `bg-muted`, `border-collapse: separate` still load-bearing). The dialog's sticky `<thead>` puts `sticky` + opaque `bg-muted` on each `<th>` (not just the row) for the same collapsed-border reason.

## Key Behaviors
- **Concept:** cross-tab / pivot, **campaign-scoped**. ROWS = every calendar day from the campaign's `min_date` to its `max_date` (from the options view; zero-feed days **included** so open/close edges show as gaps). COLUMNS = each opened block consumed during the campaign, "spawned" in chronological order of FIRST feed date (tie-break `batch_code` ASC). CELLS = kg fed from that block on that day (blank when none).
- **Transition-day split:** a campaign straddles calendar months, so a single transition date can appear in TWO campaigns — each showing only that campaign's feeds. The split is done in SQL (the campaign views are tagged), so the matrix simply renders whatever the campaign view returns for the selected `(pb, yr)`. No TS-side date math splits anything.
- **Fed + produced both campaign-scoped:** every fed (RC OUT) and produced (production) figure comes from a campaign view filtered to the SAME `(production_batch, campaign_year)` — they are always about the same campaign, never mismatched.
- **Fed-but-no-production tolerance:** production output only exists Dec-2025+. Earlier campaigns (and any campaign with no output) render with TOTAL PRODUCED blank/0, the tricolor footer at 0% yield / 100% loss (already handled), and an **empty grade set** (just the TOTAL PRODUCED column, no grade columns).
- **Fed price (₱/kg) is shown; lab metrics live in the column hover tooltip.** Weighted-avg fed price is surfaced via the frozen "Fed ₱/kg" column (per-day body + per-campaign footer), the per-block footer line, and the column tooltip — all sourced from the campaign fed-price views (`_campaign_day_price`, `_campaign_price`) + the campaign-independent `_batch_price` view (never recomputed in TS). The price basis is each batch's weighted-avg delivery cost.
- **Pure reshaping:** `fed_today` is already SQL-aggregated. TS only sums already-aggregated `fed_today` for the per-day row total — no inventory math derived in TS (respects CLAUDE.md rule).
- **"Batch" frozen column REMOVED.** It used to show the dominant `production_batch` per day; now the whole view is ONE campaign, so the value was uniform on every row — pure repetition. Removed entirely (colgroup `<col>`, header / body / footer cells) and the active campaign is surfaced in the **toolbar** instead (see "Active-campaign label"). `row.productionBatch` is still computed in the data layer (harmless, the resolved `pb` on every row) but no longer rendered.
- **Active-campaign label (toolbar):** to keep the campaign context that the Batch column used to provide, the toolbar shows a prominent label to the LEFT of the picker — a tiny uppercase muted **"Campaign"** eyebrow (`text-[10px] tracking-wide`) over the `campaignLabel` heading (`text-sm font-semibold`, e.g. "June 2026"); renders "—" when no campaign resolved. The picker `Select` sits beside it (switches campaign), and the `N blocks · M days` summary follows.
- **Default campaign:** the most recent campaign = `campaignOptions[0]` (options ordered by `max_date` desc, `campaign_year >= 2025`). The lazy tab starts with no `?campaign=` param, letting the action resolve this default; the resolved value comes back on `data.campaign` and the Select reflects it.
- **Frozen panes (canonical pattern — see CLAUDE.md "Frozen Panes" + `globals.css`):** up to **5** left columns pinned via cumulative `left` offsets — `LEFT_ROWNUM=0` (Row #=48) · `LEFT_DATE=48` (Date=100) · `LEFT_DAY=148` (Day=52) · `LEFT_FEDPRICE=200` (**Fed ₱/kg**=96, PRICE-GATED) · `LEFT_TOTAL` (Total fed=88); total frozen width = 384px **when the price column is shown, 288px when hidden**. The Fed ₱/kg column is dropped for Production, so `LEFT_TOTAL` is computed at RUNTIME = `showFedPrice ? 296 : 200` (see the price-gating section above) — when hidden, Total fed (the LAST frozen column, keeps `.frozen-edge`) sits directly after Day. (Earlier, the Batch column was also removed; everything after Day shifted LEFT by `W_BATCH`=96.) Header row pinned `top:0`; top-left corner pinned in both axes. The block (scrolling) columns are NOT sticky — they flow naturally after the frozen cells, so removing a frozen column shifts them left automatically (no manual `left` math on the block cells). Uses the shared `.frozen-col` / `.frozen-row` / `.frozen-corner` utilities (plus the new footer mirrors `.frozen-row-bottom` / `.frozen-corner-bottom` / `.frozen-edge-top`, see globals.css) — z-scale: **corner(s) 30 > header/footer row 20 > frozen body col 10 > normal scrolling cells**. The footer is the bottom-pinned mirror of the header (`bottom:0` instead of `top:0`). **All frozen surfaces are fully OPAQUE** (corner/header `bg-muted` solid, body `bg-background` solid — NEVER the `/opacity` glass pattern, which lets scrolling content bleed THROUGH the pinned cells). Frozen body cells repaint the hover tint opaquely via `group-hover:bg-accent` over the opaque base so pinned and scrolling cells match. The table uses `border-separate` + `borderSpacing:0` (NOT `border-collapse`) — collapsed borders make sticky-cell backgrounds render transparent, so the frozen columns would bleed; `border-separate` keeps each cell's opaque background painting. The last frozen column (Total fed) carries `.frozen-edge` (solid inset right border + soft shadow) to kill the 1px boundary seam.
- **Fed ₱/kg frozen column (weighted-avg fed price) — BETWEEN Day and Total fed:** a frozen-left column (`W_FEDPRICE = 96`, `LEFT_FEDPRICE = LEFT_DAY + W_DAY = 200`; `LEFT_TOTAL = LEFT_FEDPRICE + W_FEDPRICE = 296`). Total fed stays the LAST frozen column, so **`.frozen-edge` stays on Total fed** (NOT on this column). It is a MIDDLE frozen column rendered through the same `FrozenHeaderCell` / `FrozenBodyCell` / `FrozenFooterCell` helpers as its neighbors, so it inherits the exact frozen z-scale (header `.frozen-corner`/`bg-muted`/z30 — pinned in both axes like all frozen-left header cells; body `.frozen-col`/`bg-background`/z10; footer `.frozen-corner-bottom`/`bg-muted`/z30) and the auto `border-r` separator (the helpers add `border-r` whenever the className lacks `frozen-edge`).
  - **Header:** "Fed ₱/kg" (right-aligned). **Body:** the day's weighted-avg fed price (`row.avgFedPriceDay`) in **accounting format** — `flex justify-between` with the `₱` symbol pinned left + value pinned right, `font-mono tabular-nums`, 2 decimals; **blank on zero-fed days** (`avgFedPriceDay === null`). Hover/zebra repaint opaquely via the `FrozenBodyCell` `group-hover:bg-accent` over the opaque `bg-background` base. **Footer:** the **campaign's** weighted-avg fed price (`campaignAvgFedPrice`) as the headline calc value — a tiny `camp. avg` muted label over the ₱-accounting value (`font-mono text-xs font-bold`); blank when null. Opaque `.frozen-corner-bottom`, compact within the footer height.
- **PRODUCED section (SCROLLING — the FIRST scrolling group, right after the frozen Total fed and BEFORE the block columns):** shows continuous-tank production output for the month. Column order in the scrolling region is **`TOTAL PRODUCED · [grade columns: 3X50 · 6X50 · 8X50 · 2X6, present-this-month only] · [existing per-batch BLOCK columns]`**. These columns are **NOT frozen** — they flow after the last frozen cell (Total fed), so the frozen geometry / `left` offsets / `.frozen-edge` on Total fed are unchanged; the block columns simply shift right by the produced-section width. Widths: `W_PRODUCED = 88` (matches `W_TOTAL`), `W_GRADE = 80` per grade.
  - **Group dividers (2px left border, `GROUP_DIVIDER = 'border-l-2 border-l-border'`)** mark section starts so FED-blocks vs PRODUCED read as distinct groups: applied to the FIRST cell of the PRODUCED group (TOTAL PRODUCED) AND the FIRST cell of the BLOCK group (`ci === 0`), in all three sections (header `<th>`, body `<td>`, footer `<td>`). This is the same `border-l-2` idiom used elsewhere (e.g. the cenapro ledger).
  - **Header:** the TOTAL PRODUCED cell carries a small uppercased `produced` group caption over a `Total` label; each grade header is the grade code (`font-mono text-[11px]`). All are scrolling header cells (`frozen-row` + OPAQUE `bg-muted`, sticky-top only), right-aligned.
  - **Body:** after the Total fed frozen cell — TOTAL PRODUCED (`row.totalProduced`, kg, `font-mono font-medium tabular-nums`, blank when null/0) then one cell per grade (`row.producedByGrade[grade]`, blank when 0/absent). `group-hover:bg-accent` repaints the row hover tint to match the frozen + block cells. Numbers are KG (no ₱); blank on zero via `text-transparent`.
  - **Footer — the yield/loss PAYOFF (LABEL-LESS TRICOLOR highlight):** the TOTAL PRODUCED footer cell is a compact 3-line stack of **color-highlighted bold numbers with NO text labels** — color alone encodes each metric, and a `title` attr per line ("Produced" / "Yield" / "Loss") keeps the meaning discoverable on hover. **FULL-BLEED:** the cell is `p-0` (overrides the helper's `px-2 py-0.5`) so the bands reach every edge; the inner stack is `flex h-full flex-col`, each band `flex-1 w-full` (equal thirds), NO rounded corners, NO gaps, NO per-band padding — only a tiny `pr-1` keeps the digits off the right border. The result reads as three solid horizontal color bands (yellow/green/red) filling the cell completely, bold numbers on top. Each band is `font-bold font-mono text-[11px] tabular-nums`, right-aligned: **Produced (kg) → amber** (`bg-amber-100 dark:bg-amber-950 text-amber-950 dark:text-amber-50`), **Yield (%) → emerald**, **Loss (%) → red** — the same OPAQUE tint-pair style as `statusTint()` (frozen-pane rule: no glass/translucency on a sticky surface). Values: `campaignTotalProduced` (`—` when null), `yield = campaignYieldPct × 100, 1 dp` (`fmtYieldPct`, `—` when null/total_fed = 0), `loss = (1 − campaignYieldPct) × 100, 1 dp` (a PERCENT, reusing `fmtYieldPct`; `—` when yield null, `100.0%` when yield = 0 / fed-but-no-production). `campaignLossKg` stays in the data layer but is no longer rendered. Each grade footer cell = that grade's `campaignTotal` (kg, bold mono, blank when null). These scrolling footer cells use the **same `.frozen-row-bottom` (z20) + `.frozen-edge-top` OPAQUE `bg-muted` pattern as the block-column footers** (NOT corner — they scroll); the cell base stays neutral muted (not a batch state, so no `statusTint`) — only the inner tricolor strips are tinted. The 3-line produced footer matches the existing 3-line per-block footer band height — no new height pressure.
- **Frozen summary footer (bottom-pinned, mirror of the header) — COMPACT 2-LINE layout, WHOLE-CELL state tint, MC/Ash in a hover tooltip:** a sticky `<tfoot>` pinned to the container bottom (`bottom:0`). Each per-column cell is **two tight lines** (`px-2 py-0.5`, no inter-line gap) wrapped in a `Tooltip`/`TooltipTrigger` (reusing the table's existing `TooltipProvider`); the trigger content carries `cursor-default`:
  - **Line 1 (headline):** a `flex justify-between` row — tiny `text-[10px]` uppercase muted `fed` label pinned left + total fed kg (`totalOut`, bold `font-mono text-xs`) pinned right, mirroring the loss row's label/value rhythm.
  - **Line 2 (loss):** a `flex justify-between` row — tiny `text-[10px]` uppercase muted `loss` label pinned left + the signed block-loss % (`fmtSignedPct(blockLoss)`, `font-mono text-[10px]`) pinned right. "—" when `blockLoss` is null.
  - **Line 3 (₱/kg — per-block weighted-avg fed price):** a `flex justify-between` row — tiny `text-[10px]` uppercase muted `₱/kg` label pinned left + `column.avgFedPrice` in accounting format (`fmtPrice`, `font-mono text-[10px]`) pinned right. **Blank value when null** (the label slot is KEPT so every per-column footer stays the same height). The price also appears in the hover tooltip's `<dl>` as a **Fed price** row (`₱{value}/kg`, "—" when null).
  - **MC & Ash live in the hover tooltip** (de-clutters the previously cramped 3-col `mc | ash | loss` grid, which was REMOVED). **Tooltip = a polished info card, not stacked text.** The `TooltipContent` (`side="top"`, `w-[180px]`, `p-0`) uses the canonical popover **glass** surface `bg-popover/95 backdrop-blur-lg` (correct here — it floats over empty space, unlike the OPAQUE frozen cells). Structure: a **header** (`px-2.5 py-2`) with the batch code (`font-mono text-xs font-semibold`) over the `block_loc` (muted `text-[10px]`) on the left and a compact **state pill** on the right (colored dot + uppercase status text — blue for IN-USE, red for CLOSED/FEED, neutral muted otherwise, matching the footer tint convention); a `border-t border-border` **divider**; then a `<dl>` **label/value list** (`px-2.5 py-2`, `space-y-1`) with muted left labels + `font-mono tabular-nums` right-aligned values via `flex justify-between` per row — **Fed** (`totalOut` kg), **In** (`totalIn` kg), **MC** (2-dec %), **Ash** (2-dec %), **Fed price** (`avgFedPrice` → `₱{value}/kg`, "—" when null), **Loss** (signed %, keeps red-neg/emerald-pos/muted-null coloring), **Opened** (`firstFedDate`). All `text-[11px]`, semantic tokens (light + dark).
  - **STATE = ENTIRE-CELL COLOR (the `StateBadge` dot/label was REMOVED).** The whole per-column footer cell background is tinted by `batches.status` via the `statusTint()` helper, which **replaces** `bg-muted` on these cells (one bg per element — never a translucent tint layered over `bg-muted`). The cell itself is `p-0`; the inner trigger `<div>` owns the `px-2 py-0.5` padding. **CRITICAL: the tints are OPAQUE solid tokens** (this is a frozen/sticky surface — any `/opacity`/glass reopens the bleed-through bug). Mapping: **IN-USE → `bg-blue-100 dark:bg-blue-950`** (blue), **CLOSED / FEED → `bg-red-100 dark:bg-red-950`** (red), **everything else (STORED / SUNDRYING / SUNDRIED / …) → neutral `bg-muted`**. Each tint pairs a readable foreground for both modes (blue/red `text-…-950 dark:text-…-50`; neutral `text-foreground`). On the RED (CLOSED/FEED) tint the loss red/green would clash, so **loss inherits the cell foreground there**; on the blue and neutral tints loss keeps the red(neg)/emerald(pos)/muted(null) sign coloring.
  - The 5 cells under the frozen LEFT columns are the **bottom-left corner** — sticky on BOTH axes via `.frozen-corner-bottom` (z30), `align-middle`; they stay **NEUTRAL opaque `bg-muted`** (not per-column, so no state tint). The "Total fed" footer cell shows the **grand total** (`grandTotalFed`, bold) and carries `.frozen-edge` for the vertical seam, the Date footer cell shows a muted "Totals" label, the rest are blank. The scrolling per-column footer cells use `.frozen-row-bottom` (z20) + `.frozen-edge-top` to kill the seam against the scrolling body above. All footer surfaces remain fully OPAQUE.
  - **State tint convention (footer-specific):** IN-USE = **blue**, CLOSED/FEED = **red**, other = **neutral**. This is distinct from the Blocking heatmap's status palette — it reflects feed-completion, not warehouse occupancy.
  - **Block loss formula (PENDING SIGN CONFIRMATION):** implemented exactly as `(totalOut − totalIn) / totalIn`, rendered as a signed % (negative tinted red, positive emerald). Divide-by-zero guarded: `totalIn = 0` → `blockLoss = null` → renders "—". The sign/direction is a first-look; confirm with the user before treating it as final.
  - **Summary data is computed in ONE batched pass** in `fetchRcMovementMatrix` — **four** `.in(...)` queries (`batches` for status, `deliveries` for totalIn + weighted mc/ash, `rc_out` for totalOut, **`view_rc_movement_batch_price` for `avgFedPrice`**) keyed on the column batch_ids/codes, NOT a per-column action call. Weighted-avg mc/ash mirrors Blocking's `fetchBlockDataForBatch` (`SUM(metric × weight) / SUM(weight_with_metric)`). totalOut/totalIn are all-time SUMs (campaign-independent). Fed-price columns come straight from SQL (NEVER recomputed in TS). The per-day (`view_rc_movement_campaign_day_price`) and per-campaign (`view_rc_movement_campaign_price`) prices are fetched separately (both campaign-filtered).
- **No virtualization:** ~44 cols × ~31 rows (~1.3k cells) — a plain sticky `<table>` is sufficient and simpler.
- **Density:** `table-fixed` + `<colgroup>` explicit px widths, `px-2 py-1`, `text-xs`, `h-8` rows. Numerics `font-mono tabular-nums`, right-aligned, integer kg, thousands separators, blank for zero. Active (fed) cells get a subtle `bg-emerald-500/10` tint.
- **Gridlines (full spreadsheet grid):** every column boundary carries a SUBTLE vertical separator (`border-r border-border/50`, matching the horizontal `border-b border-border/50` gridline weight), giving a continuous vertical line down each column from header → body → footer. Applied to: the scrolling block cells in all three sections (header `<th>`, body `<td>`, footer `<td>` — footer already had it), AND the frozen LEFT columns (Row#/Date/Day/Fed ₱/kg) via the `FrozenHeaderCell`/`FrozenBodyCell`/`FrozenFooterCell` helpers (each adds `border-r` only when its `className` does NOT include `frozen-edge`). The LAST frozen-left column (**Total fed**) is the exception — it keeps `.frozen-edge` as its right divider/anti-seam and gets NO competing `border-r` (the helpers detect `frozen-edge` and skip the border). Borders only — no change to sticky positioning, z-scale, offsets, or opacity.
- **Block column header (clickable → detail panel):** `batch_code` (mono bold) over `block_loc` muted subline; full code + block + open-date in a Tooltip ("Click to view batch details"). The whole header is a `<button>` inside the frozen-row `<th>` — affordance is `cursor-pointer` + `hover:bg-accent` (and `bg-accent` while selected) layered over the OPAQUE `bg-muted` frozen surface (no `/opacity` on the sticky cell, so no bleed-through). Keyboard-focusable with `focus-visible:ring`. Clicking opens the shared **`BlockingDetailPanel`** (the same slide-over the Blocking tab uses) for THAT column's batch.
  - **Batch-accurate, not loc-accurate:** the panel must show the matrix column's specific batch even for historical months where the slot was later reused or the batch was closed. Detail history is fetched batch-keyed via the Blocking module's `fetchBlockingDetail(batchCode, batchId)`. The **header summary** (`BlockData`: status / balance / total_in / php / lab weighted-avgs) is fetched via a new Blocking action **`fetchBlockDataForBatch(batchId)`** — it computes the same metrics `view_blocking_grid` produces but keyed on `batch_id` with **no status/loc filter**, so a CLOSED/reused batch (absent from the view) still resolves. `canViewPrices` comes back from that same call.
  - **State:** `selectedColumn` / `panelBlockData` / `panelCanViewPrices` live in `RcMovementMatrix`. On header click: set the column (panel slides open), clear `panelBlockData` (panel shows its loading/blank state), then fill from `fetchBlockDataForBatch`. The panel's display `locKey` = `column.blockLoc ?? column.batchCode` (FEED columns have no loc; the panel's `parseLocKey` tolerates the non-loc key and just hides the "WHSE/Col/Row" subline). The panel owns its own close/Escape/scroll-lock.
- **Weekend cue:** Sat/Sun day-of-week label tinted amber.
- **Campaign picker:** shadcn `Select` showing `Month YYYY` + feed-day count; `value` is the encoded campaign key (`data.campaign`), options are `campaignOptions`. Selection calls the `onCampaignChange(key)` prop → the lazy tab writes the `?campaign=` URL param via `router.replace(..., { scroll: false })` → the effect re-runs and re-fetches. **URL-driven** (per the project's search-param convention, mirroring the RC IN table) — no page reload; deep-linkable / shareable.
- **Glass vs frozen:** the campaign-picker Select dropdown uses glass (`bg-popover/95 backdrop-blur-lg`) because it floats over empty space. Frozen header/column/corner surfaces are the OPPOSITE — fully opaque (see Frozen panes above), since they overlap scrolling content. Empty state `animate-fade-up`. No row stagger/entrance animation (per CLAUDE.md).

### Route integration (standalone `/inventory/rc-movement`)
- `rc-movement-route-view.tsx` is the client host (rendered by `page.tsx` inside a `Suspense`). The selected campaign is **driven by the `?campaign=` URL search param** (read via `useSearchParams`, the URL is the source of truth). It fetches `fetchRcMovementMatrix(campaignParam || undefined)` on first render and whenever the param changes, shows a `Loader2` spinner while loading (only when there's no prior data), and renders `<RcMovementMatrix data={…} onCampaignChange={…} onNavigateToBatch={…} />`. `onCampaignChange` writes the param via `router.replace(pathname?campaign=KEY, { scroll: false })`; `onNavigateToBatch` does `router.push('/inventory?tab=deliveries|usage&search=…&editBatch=…')`.
- The route renders in the thin inventory layout's content area (full height) with **no tab-bar footer** — it is shell-agnostic (does NOT use `useInventoryTab`). The old in-tab `RcMovementMatrixLazyTab` was deleted this wave.
- Campaign switching re-fetches the server action **without a page reload** — the spinner shows only when there is no prior data.

## The flip — v2 is the DEFAULT (2026-08-29)

Renzo: *"RC Movement is an essential table — it gives me the best idea of how my rc and pc
are moving daily and monthly. Visibility is key."*

`/inventory/rc-movement` now serves the **Blackwood Table** on a paramless URL; the Classic
matrix is `?grid=v1`. A DEFAULT FLIP, not a cutover — `rc-movement-matrix.tsx`,
`rc-movement-route-view.tsx` and `actions.ts` are still byte-identical, the Classic branch
still mounts, and **two surfaces still live only there** (see "Not reproduced in v2"). Only
`page.tsx` changed for the flip itself: `resolveGrid(params.grid, GRID_V2) === GRID_V2`, and
`GridVersionBar defaultVersion={GRID_V2}` so the toggle lights the side the page rendered.
The screen is registered in `FLIPPED_PAGES` in `scripts/verify-table-core.ts`, which reads
the registry BOTH ways — flipping without listing fails, listing without flipping fails.

Two things shipped with the flip, both of them Renzo's own findings.

### Header widths — MEASURED, and 40px larger than the Classic matrix's

*"a bunch of the column headers are wrapping weirdly or are being '…' truncated. This does
not happen in our original table. Column widths must accommodate the header so we can see
everything."*

**The cause is invisible chrome, not the font.** The Classic `<th>` spends `px-2` + a 1px
border and gives everything left to its label. This grid runs `scope="focus"`, which turns
the platform's built-in SORT and FILTER controls on for every column that is not
`cellKind: 'derived'` and has not opted out — and `HeaderCell` lays them out as flex
SIBLINGS of the label, `opacity-0` until the header is hovered. **Invisible, and still
occupying layout:** two 16px buttons plus two 4px gaps. And the two columns that START a
section (`PRODUCED`, the first block column) hang their 2px group rule off
`renderHeaderSlot`, a fourth flex child whose sliver is `absolute` and 0px wide — but whose
`gap-1` is not, so those two pay a further **4px**.

    usable label width = declared − 16 (px-2) − 40 (two controls) − 1 (border-r)
                       = declared − 57            ( − 61 with a header slot )
    usable label width = declared − 17            ( a column offering neither control )

Every width carried over from the Classic matrix was therefore ~40px short. Same trap and
same remedy as the QC ledger's 2026-08-26 pass (`scripts/verify-qc-grid.ts` §12).

| key | label | label px | chrome | floor | was | now |
|---|---|---|---|---|---|---|
| `rownum` | `#` | 7.42 | 17 | 24.42 | 48 | **48** |
| `date` | `DATE` | 29.52 | 57 | 86.52 | 100 | **100** |
| `day` | `DAY` | 22.92 | 57 | 79.92 | 52 | **84** |
| `fedprice` | `FED ₱/KG` | 52.63 | 57 | 109.63 | 96 | **112** |
| `total` | `TOTAL FED` | 62.32 | 57 | 119.32 | 88 | **124** |
| `produced` | `PRODUCED` | 64.67 | 57+4 | 125.67 | 88 | **128** |
| `grade:*` | `3X50` · `6X50` · `8X50` | 30.25 | 57 | 87.25 | 80 | **92** |
| `blk:*` | `MARCH-26-SUNDRY7` | 115.53 | 17+4 | 136.53 | 92 | **148** |

Measured in Chrome against the real computed fonts (lane header Geist 11px/500
`uppercase tracking-wide`; block header Geist Mono 11px/600; body figure Geist Mono 12px
`tabular-nums`). Node has no font engine, so they cannot be re-derived — only ENFORCED, which
**`scripts/verify-rc-movement-grid.ts`** does: it parses each `W_*` off this file and
compares it against both the header floor AND the widest real VALUE the lane can hold (the
half the QC pass forgot the first time).

Three decisions inside that table:

1. **`headerWrap` is gone from every column.** It was the old answer on `TOTAL FED` and the
   grade lanes and it was wrong twice over — the header row grows to its TALLEST cell, so one
   wrapped header raises all sixteen, and a name broken across two lines is not more readable
   than the same name on one line that fits. The block header's second line stays: that is a
   `subLabel` (the block location), a subtitle rather than the name spilling over.
2. **`W_BLOCK`'s floor is the longest batch code that EXISTS** — 16 characters
   (`MARCH-26-SUNDRY7` / `APRIL-26-SUNDRY2`, measured over all 531 codes `rc_out` has ever
   fed). The declared 148 additionally clears `SEPTEMBER-26-BLK12` (18 chars, 123.74px), i.e.
   the longest the naming convention produces with an ordinary `BLK` kind. A hypothetical
   `SEPTEMBER-26-SUNDRY12` would still truncate and its full code is on the `title`; the line
   is drawn where a wider column would cost every campaign real scroll width for a code
   nobody has typed. **This is the one place the two headers deliberately differ — the
   Classic matrix truncates a 16-character code at 92px and this does not.**
3. **Every declared width clears its floor with a few px of slack**, deliberately: a column
   sized to the exact measurement is one font-hinting change away from an ellipsis.

The frozen-left run is now **468px** (48+100+84+112+124) with prices, **356px** without.
Verified at 375px: the PAGE does not scroll sideways, the grid's own scroller does —
"never crush, always scroll", with the `maxWidth: useTableColumns(...).minWidth` clamp
unchanged.

### The footer is PINNED

*"Footer must also 'freeze' same as original."*

The campaign totals row was a `renderChromeRow`, i.e. the LAST ROW OF THE BODY, and it
scrolled away with the rows it summarises. It is now **one `sticky` `TableSummaryRow` with a
`cell` renderer** — the platform seam built for it, `TableSummaryRow.cell` (see
`lib/table/CONTEXT.md`). What changed here:

- `renderChromeRow`, the `summary` row family and the `{ kind: 'summary' }` item are **gone**,
  not left beside it — a second copy of this footer is how the two would drift.
- **~15 lines of hand-rolled geometry deleted.** `pinnedOffsets(api.cols)`, the `frozen-col`
  / `frozen-edge` / `left:` bookkeeping and the per-cell shell are all the platform's now.
  The consumer returns `{ content, className, title }` per column and nothing else.
- The whole-cell `statusTint()` still REPLACES the shell's `bg-muted` (merged last, and
  opaque — a pinned surface that overlaps scrolling content is opaque or the rows bleed),
  the tricolor produced/yield/loss bands still get `p-0` for their full bleed, and the ₱
  lines are still gated on the server-resolved `showFedPrice`.
- `height: TOTALS_H` (62) is a **floor**: measured 76px for a price-seeing viewer (four
  stacked lines per block), and legitimately shorter for Production.
- Measured after the change: the footer's pinned `left` offsets are **identical** to the
  body's on every frozen column, in both the priced and the gated render; the bottom-left
  corner is `position: sticky; bottom: 0; left: 0; z-index: 30` with an opaque background,
  and it carries **both** seams via the new `.frozen-edge-corner` (see below).

**`.frozen-edge-corner` (new in `globals.css`).** `box-shadow` is ONE property, so
`.frozen-edge` + `.frozen-edge-top` on the same element is not two shadows — the later rule
wins and the VERTICAL seam silently disappears. The one cell that owes both (the bottom-left
corner of a pinned footer) now takes a composed utility. Same tokens, same weights, same dark
variant; only the combination is new. The Classic matrix sidesteps this by putting
`.frozen-edge-top` only on its SCROLLING footer cells.

### Everything below this line describes the grid as originally built (2026-08-19)

`rc-movement-grid-v2.tsx` renders the SAME `RcMovementMatrix` payload on the platform grid,
so the two can still be compared cell-for-cell on the same campaign.

- **Why the v2 branch is fetched on the SERVER.** The live branch's payload is fetched
  client-side by `rc-movement-route-view.tsx`, and that file may not be edited — so rather
  than adding a prop to it, `page.tsx` awaits the SAME read action for the v2 branch and
  passes the result down. No second copy of the campaign-resolution logic, no client fetch,
  no spinner state, and the live host keeps every line it had.
- **PRICE GATING is unchanged and is not decided in the client.** `canViewPrices` arrives
  inside `data` (resolved by `lib/auth.canViewPrices()` inside `fetchRcMovementMatrix`,
  which also nulls every ₱ field and does not even QUERY the three ACTUAL FED ₱/kg views for
  a gated viewer). The v2 grid mirrors the live matrix exactly: `Fed ₱/kg` is
  `visible: (ctx) => ctx.canViewPrices`, so for a gated viewer the column does not EXIST —
  absent from the coordinate space, not blanked. **The runtime `LEFT_TOTAL` arithmetic the
  live file has to do by hand disappears:** the module recomputes every pinned offset from
  the RESOLVED column set, so `Total fed` slides left to sit directly after `Day` and keeps
  `.frozen-edge` on its own. The footer's `₱/kg` + `actual` lines and the coverage badge are
  gated on the same flag.
- **The `#` column is the module's `CellSlot.addressable: false` case.** A row ordinal
  RENDERS its number and must never be a keyboard stop; it is `cellKind: 'derived'` (so
  `columnSelectable` also excludes it from rectangles) and the `day` row family returns
  `addressable: false` for that one slot. Every Tab run and every jump key steps straight
  over it.
- ~~**The summary footer is a CHROME ROW (`renderChromeRow`), not `summaryRows`.**~~
  **SUPERSEDED 2026-08-29 — see "The footer is PINNED" above.** The reasoning was right
  about the problem: a `TableSummaryRow` tiled six DECLARED lanes, so it could carry one
  headline figure and one total, while this footer carries a different stack under every one
  of ~40 columns (per-block `fed` / `loss` / `₱/kg` / `actual` with the opaque
  `statusTint()` state colour, the tricolor produced/yield/loss bands, each grade's campaign
  total, the grand total fed and the campaign delivered + actual ₱/kg). It was wrong to
  accept the cost — being the LAST ROW OF THE BODY rather than pinned — as permanent: the
  right answer was a platform seam, and `TableSummaryRow.cell` is now it.
- **The 2px `GROUP_DIVIDER` is painted from inside the cells.** The module owns every
  `<td>`/`<th>` className (`cell-classes.ts` builds it from ten enums), so a consumer cannot
  add a border to one. Body cells draw the rule on their own `absolute inset-0` inner span
  (`TOTAL PRODUCED` and the first block column), the header draws it through
  `renderHeaderSlot` (an `inset-y-0 left-0 w-0.5` sliver — the `<th>` is a positioned box),
  and the totals row draws it directly. All three sections therefore carry it, as they do
  today.
- **The width clamp is load-bearing.** The live matrix uses `width: 'max-content'` so
  `table-fixed` cannot stretch its columns on a campaign with few blocks. `BlackwoodTable`
  renders `width: 100%` + `minWidth: Σ widths` with an explicit `<col width>` per column,
  and a fixed table wider than its columns scales ALL of them proportionally (measured in
  Chrome at a 1600px container: a declared 76px column renders 94.7px) — which would drift
  the sticky `left` offsets computed from the DECLARED widths. The grid clamps its own
  `maxWidth` to `useTableColumns(...).minWidth`, so the stretch is unreachable and the clamp
  follows a column resize and the price gate automatically.
- **The block header is the live matrix's two lines, DECLARED (2026-08-20).** Renzo:
  *"the display and frontend [must be] exactly the same as current rc movement table …
  wrapping is weird and not behaving like the current version and there is no block
  location underneath it as a subheading."* The header was `headerWrap: true` at 104px,
  which wrapped the BATCH CODE across two lines and never showed the block loc at all.
  It is now `label` (the batch code — still the required plain string the `title`, the
  resize handle's `aria-label` and `Copy with headers` read) over
  `subLabel: c.blockLoc ?? '—'`, both one truncated line, and `headerWrap` is GONE.
  `labelNode` re-styles the name to the live `<th>`'s own
  `font-mono text-[11px] font-semibold normal-case` in `text-foreground`, because the
  platform's default header type is uppercase sans in `text-muted-foreground` and a batch
  code is an identifier, not a lane label. ~~**`W_BLOCK` is back to the live matrix's 92**
  — with no header chrome on these columns the label's budget is `92 − 16` (the module's
  `px-2`) = 76px, the same 76px the live `<th>`'s `px-2` gives it, so the truncation point
  matches.~~ **REVISED 2026-08-29 to 148** — matching the Classic matrix's width also
  matched its TRUNCATION, and the whole of Renzo's next complaint was `…` in a header. See
  "Header widths" above; the budget was also 4px short (the group-rule `renderHeaderSlot` on
  the first block column is a fourth flex child). **The sub-line's type matches:**
  `HeaderCell`'s `subLabel` shipped as
  `text-[9px] text-muted-foreground/70` and was corrected to
  `text-[10px] leading-tight text-muted-foreground` in the same pass — a platform edit,
  made deliberately rather than worked around, because these block headers are `subLabel`'s
  ONLY real consumer (a grep over `app/ components/ lib/` returns this file and the dev
  playground fixture, nothing else) and a default every consumer has to route around via
  `labelNode` is the wrong default. See `lib/table/CONTEXT.md` → the review pass, item 4.
  **One deliberate pixel difference remains: v2's block column is 148px against the Classic
  matrix's 92, so a 16-character batch code renders whole here and truncates there.**
- **Clicking a block header opens the shared `BlockingDetailPanel`** — the live matrix's
  behaviour, on `ColumnSpec.onHeaderClick`, which replaces the column sweep entirely (a
  header naming a *thing* is not a lane label, and sweeping ~31 cells behind the slide-over
  that just covered them is not the gesture). State shape is copied from the live matrix
  field for field: `selectedColumn` both opens the panel and supplies the display key
  (`blockLoc ?? batchCode` — `parseLocKey` tolerates a FEED column's non-loc key),
  `panelBlockData` is null while the fetch is in flight so the panel shows its own loading
  state, and `panelCanViewPrices` comes back from the SAME `fetchBlockDataForBatch` call
  rather than being re-derived. That action is used rather than a grid-map lookup for the
  live matrix's reason: a historical column's batch may be CLOSED or its slot reused, so it
  is absent from `view_blocking_grid` and a map would show today's occupant.
  `onNavigateToBatch` reproduces `rc-movement-route-view.tsx`'s handler verbatim — this
  standalone route mounts no `InventoryTabProvider`, and the panel's own fallback push
  omits `tab=` / `editView=`.
- **The panel closes back into the grid.** It is a plain `position: fixed` slide-over, NOT
  Radix, so there is no `onCloseAutoFocus` to preventDefault (the idiom
  `lib/table/CONTEXT.md` records for the Radix case). `onClose` is the single funnel for
  every close path — Escape, backdrop, both X buttons — so `handlePanelClose` clears the
  state and calls `apiRef.current?.focus()` once, covering all of them. **The live matrix
  has no equivalent**: it is not on the module and holds no handle, so this is the one
  place v2 does MORE than the screen it mirrors.
- **The grid stays read-only, and the panel does not change that.** No `ColumnSpec` here
  declares a `parse`, so `columnAcceptsEdit` is false at every coordinate — a header click
  is not a cell edit. The panel is a SEPARATE surface and is existing production code,
  already mounted on `/inventory/blocking` and on the live matrix on this same route; its
  write paths (`updateBlockNotes`, `EditDeliveryDialog`) gate themselves exactly as they do
  there, and `canViewPrices` arrives from the server action's own resolution. **Mounting it
  adds no NEW write path to the application.** The distinction is recorded at the mount
  site in `rc-movement-grid-v2.tsx`, which is where someone reading the JSX will be
  standing.
- **A block column offers NO built-in sort or filter** (`sortable: false`,
  `filterable: false`). Not a width concession: the row axis here is the CALENDAR, so
  re-ordering the days by how much came out of one block produces a feeding matrix in no
  order at all — and the platform hides every chrome row while either axis is active, so
  one click would delete this grid's entire campaign footer. The date/day/kg lanes keep
  both affordances (they are lanes), **with the same footer caveat — sorting any of them
  hides the totals rule-off until the sort is cleared.**
- **Not reproduced in v2 — the REMAINING GAPS, and they are why `?grid=v1` still matters**
  (left out rather than stubbed):
  1. **The `OpenBlocksDialog`** behind the coverage badge. In v2 the badge is an inert pill
     that still prints the SQL-counted `blocksClosed` / `blocksFed` / `openBlocks.length`;
     clicking it does nothing. The dense per-open-block table (Block · Status · Fed here ·
     Share · Balance · Feeds · Last fed · ₱/kg in) exists **only** in
     `rc-movement-matrix.tsx`. **To see it today: `?grid=v1`.**
  2. **The Radix hover info card** per footer column — the `w-[180px]` glass popover with the
     state pill and the `<dl>` of Fed / In / MC / Ash / Fed price / Loss / Opened. v2 carries
     the same figures on a native multi-line `title`: the same DATA, a plainer surface.
  3. **The `sm:hidden` phone summary** (`RcMovementSummaryMobile`) — the campaign KPI strip,
     the tappable block list and the per-day feed list. v2 at 375px shows the real grid with
     its own horizontal scroller instead (verified: the PAGE does not scroll sideways).
  4. **A hand-rolled selection-size chip.** Deliberate rather than missing: the table now
     publishes the real SUM/AVERAGE/COUNT/MIN/MAX of a rectangle to the app's floating status
     bar by itself, so a `rows × cols` chip beside it would be a second, worse answer.

  *(The block-header detail panel and two-line block headers were on this list until
  2026-08-20, and the bottom-pinned footer until 2026-08-29; all three are now built.)*
- **What IS live from the module:** cell selection and rectangular ranges, the full keyboard
  (arrows, Tab, Ctrl/Cmd+Arrow, Home/End, Ctrl+Home/End, PageUp/PageDown), Ctrl/Cmd+C as
  TSV, column resize (session-local), the 5-column frozen block with the price column
  dropping out of it for Production, the sticky header, the weekend amber cue, the emerald
  fed-cell wash, and the zero-fed-day dimming. `scope="focus"` (a plain sticky `<table>`,
  no virtualisation) matches the live matrix's own choice for ~31 × ~44 cells.

## Dependencies
- `@/lib/supabase/server` — used by `actions.ts` (server-side only)
- `@/lib/supabase/paginate` — `fetchAllRows()` shared pagination helper (DUP-1)
- `@/components/ui/select` — campaign picker in the matrix
- `next/navigation` — `useRouter` / `usePathname` / `useSearchParams` in the **route view** (URL `?campaign=` param drives the selected campaign)
- `@/components/ui/tooltip` — block-column header tooltip (batch code + block + open date)
- `@/lib/utils` — `cn()` for the matrix's frozen-cell class composition
- `lucide-react` — `Loader2` (spinner in the route view)
- `../_shared/blocking-detail-panel` — `BlockingDetailPanel` + `BlockingDetailNavTarget`, reused for the column-header slide-over **by BOTH grids since 2026-08-20** (`rc-movement-matrix.tsx` and `rc-movement-grid-v2.tsx`), each with its own `fetchBlockDataForBatch` call and its own `onNavigateToBatch`. The panel itself is untouched by the v2 work. **The panel was hoisted out of `blocking/` into the neutral `_shared/` folder** so it carries no inventory-tab-shell dependency. On this standalone route the matrix forwards an explicit `onNavigateToBatch` (from `rc-movement-route-view.tsx`) to the panel's "Edit All", which `router.push`es to `/inventory?tab=…`. (When the panel is rendered in-shell elsewhere with `onNavigateToBatch` omitted, it falls back to the `INVENTORY_NAVIGATE_EVENT` window event handled by `InventoryTabProvider`.)
- `../blocking/actions` — `fetchBlockDataForBatch(batchId)` (batch-accurate header summary) — the matrix calls this; detail history is fetched by the panel itself via `fetchBlockingDetail`
- `../blocking/types` — `BlockData` (panel header-summary shape)
- `@/components/shared/table` + `@/lib/table` — the **Blackwood Table** platform module, which
  `rc-movement-grid-v2.tsx` (the DEFAULT grid) is built on. The pinned campaign footer uses
  `TableSummaryRow.cell`, a seam added for this screen on 2026-08-29 — see
  `lib/table/CONTEXT.md`. The Classic matrix imports none of it.
- **`scripts/verify-rc-movement-grid.ts`** — the tenant-side guard for this module: it parses
  every `W_*` off `rc-movement-grid-v2.tsx` and enforces it against the MEASURED header and
  value widths, pins the header-chrome budget against `HeaderCell.tsx` (where the 40px + 4px
  actually come from), asserts the totals row is a pinned summary row rather than a chrome
  row, and asserts the Classic matrix and its host were not edited by the flip. Run it after
  ANY width change on this sheet — Node has no font engine, so a width is enforceable here
  and not re-derivable. `scripts/verify-table-core.ts` owns the platform half (the seam and
  the `FLIPPED_PAGES` registry).

## See Also
- [RC IN](../rc-in/CONTEXT.md) — Source of `deliveries.lab_results`, `deliveries.cost_basis`, `deliveries.block_loc` which feed `view_rc_movement` via `batch_meta` CTE
- [RC OUT](../rc-out/CONTEXT.md) — Source of `rc_out.weight_kg`, `rc_out.transaction_date`, and `rc_out.production_batch` which feed the matrix
- [Blocking](../blocking/CONTEXT.md) — Sibling visualization showing physical warehouse occupancy. The shared `BlockingDetailPanel` the matrix reuses now lives in `../_shared/` (shell-agnostic), but Blocking still owns its data: `fetchBlockDataForBatch` (batch-accurate header summary for the panel) and `fetchBlockingDetail`/`updateBlockNotes` in `blocking/actions.ts`, plus `BlockData` & friends in `blocking/types.ts`.
- [Inventory](../CONTEXT.md) — Parent module + route map. RC Movement is a **standalone route** (`/inventory/rc-movement`), not a tab; `page.tsx` → `rc-movement-route-view.tsx` mounts this matrix outside the logs tab shell.
- Reference frozen-pane implementation alongside the Cenapro production ledger (`app/(app)/cenapro/production/production-ledger-grid.tsx`)
