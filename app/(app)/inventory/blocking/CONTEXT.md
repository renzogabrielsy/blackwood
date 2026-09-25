# Blocking Module

## Purpose

Physical warehouse grid visualization — the digital equivalent of the Excel blocking sheet. Renders a heatmap of 220 block locations across 4 standard warehouses (A, B, C, D), plus 18 opt-in slots in 2 prepared-charcoal sundrying zones (PCA, PCB), showing which batch occupies each slot and key metrics at a glance. Clicking an occupied cell opens a slide-over detail panel with balance, quality metrics, delivery history, and usage history.

> **Standalone route (Phase 2).** Blocking is now its own route at **`/inventory/blocking`** — NOT a tab inside the `/inventory` logs shell. The selected block lives in the URL as **`?block=<block_loc>`** (deep-linkable, refresh-safe; browser Back closes the panel). `page.tsx` renders `BlockingRouteView` (inside a `Suspense` for `useSearchParams`), which fetches the grid, drives `?block=`, and wires the panel's "Edit All" to `router.push('/inventory?tab=…')`. The route does NOT depend on the inventory tab shell. See [inventory/CONTEXT.md](../CONTEXT.md) for the route map.

> **Domain Module (Charcoal Tenant):** This module is domain-specific — it belongs to the charcoal plant operations layer, not the platform layer. Business logic, schema references, and terminology here are intentionally charcoal-specific. When adapters are built for the dashboard widgets, they will extract data from these tables — but widgets themselves will never import from this module.

## Files

| File | Description |
|---|---|
| `types.ts` | Shared interfaces: **`BlockSupplierShare`** (`{ supplierKey; supplierDisplay; kg; sharePct; deliveryCount }` — one supplier's contribution to one block) and **`BlockingSupplierMap`** (`{ suppliers: Array<{ key; display; blockCount; totalKg }>; byBlock: Record<block_loc, { supplierCount; shares: BlockSupplierShare[] }> }` — the supplier-search payload; `supplierCount` is the VIEW's `supplier_count_in_block`, never `shares.length`, and the whole shape carries NO ₱). Plus `BlockData` (single cell data; `status` is the widened `BlockStatus` = the 4 styled statuses **or** any string, so the RC Movement panel can render a historical CLOSED/FEED batch), `BlockStatus`, `BlockingGridData` (full grid payload with aggregates), `BlockDataForBatch` (`{ blockData: BlockData \| null; canViewPrices }` — return of `fetchBlockDataForBatch`), `DeliveryHistoryRecord` (includes `id`, `mc`, `bd_astm`, `ash`, `cost_basis`), `UsageHistoryRecord`, `BlockingDetailData` (detail panel payload), `FullDeliveryRecord` (full delivery for edit dialog; **`cost_basis: number \| null`** — `null` when role-gated/withheld for non-price-viewers). **Stays in `blocking/`** (tenant domain types); the shell-agnostic detail panel in `_shared/` imports these via `../blocking/types`. **Also owns the PRICE LENS contract (2026-09-19)**: `BlockingMarketBasisKey`, `BlockingMarketBasis`, `BlockingPriceBand`, `BlockingPriceLens`, `BlockingPriceLensRefusalReason`, `BlockingMarketBasesResult`, `BlockingPriceLensResult`, plus the shared constants `BLOCKING_PRICE_LENS_MAX_EDGES` (6), `BLOCKING_PRICE_LENS_DEFAULT_EDGES` (`[-1, 0]`) and `BLOCKING_TRAILING_DAYS_MIN`/`_MAX`/`_DEFAULT` (1 / 400 / 30) — the SAME numbers the SQL enforces, imported by `actions.ts` rather than re-typed, and pinned to the SQL by `scripts/verify-blocking-price-lens.ts`. **Every one of these shapes is price-sensitive, including a bare band index** — see **Data → Price lens**. **2026-09-19 — also owns the AGE LENS contract**: `BlockingAgeBand`, `BlockingAgeLens`, `BlockingAgeLensRefusalReason`, `BlockingAgeLensResult`, plus `BLOCKING_AGE_LENS_MAX_EDGES` (6), `BLOCKING_AGE_LENS_DEFAULT_EDGES` (`[60, 120, 365]`) and `BLOCKING_AGE_EDGE_MIN_DAYS`/`_MAX_DAYS` (1 / 5000), pinned to the SQL by `scripts/verify-blocking-age-lens.ts`. **The age shapes are the exact OPPOSITE of the price ones: not one of them is price-sensitive and none is derivable into money**, so the Age lens is shown to every role including Production — see **Data → Age lens**. **2026-09-21 — also owns the BLEND BLOCK FACTS contract**: `BlendBlockSupplierShare`, `BlendBlockFacts`, `BlendBlockFactsRefusalReason`, `BlendBlockFactsResult` and `BLEND_BLOCK_FACTS_MAX_BATCH_IDS` (250), pinned to the SQL by `scripts/verify-blend-block-facts.ts`. Like the age shapes, **not one of them carries money**, so the blend modal's supplier/age columns are safe for every role. `isSingleSupplier` is `boolean | null` on purpose — null is NEITHER green nor orange — see **Data → Blend block facts**. The same date also adds **`BLOCKING_ROUNDED_UP_MIN_PHP`** / **`_MAX_PHP`** and the `invalid_rounded_up` refusal for the price lens's typed cut line. **2026-09-21 — also owns the BLEND ANALYSIS contract**: `BlendAnalysisSource`, `BlendNaturalGroupLabel` (the CLOSED `low \| mid \| high`), `BlendNaturalCut`, `BlendNaturalStats`, `BlendAnalysisBlockRef`, `BlendPriceBlock` / `BlendQualityBlock` / `BlendAgeBlock`, `BlendAnalysisUnmeasured`, `BlendPriceNaturalGroup`, `BlendPriceNatural`, `BlendVsMarketBand`, `BlendVsMarket`, `BlendVsMarketUnavailable`, `BlendAnalysisPriceSection`, `BlendQualityMetric`, `BlendQualityGroup`, `BlendQualityNatural`, `BlendAnalysisQualitySection`, `BlendAgeBand`, `BlendAnalysisAgeSection`, `BlendAnalysis`, `BlendAnalysisRefusalReason`, `BlendAnalysisResult`, `BlendAnalysisInput`, plus `BLEND_ANALYSIS_MAX_BLOCKS` (250), `BLEND_ANALYSIS_DEFAULT_PRICE_EDGES` (`[-1, 0]`), `BLEND_ANALYSIS_DEFAULT_AGE_EDGES` (`[60, 120, 365]`) and `BLEND_ANALYSIS_QUALITY_METRICS` (`['mc','ash','bd_astm','bd_jis']`), pinned to the SQL by `scripts/verify-blend-analysis.ts`. **This is the one contract in the file that SPLITS on money**: `BlendAnalysis.price` is `BlendAnalysisPriceSection \| null` with a sibling `pricesHidden: boolean`, because the price section is DELETED for a price-denied caller while `quality` and `age` are still returned — see **Data → Blend analysis**. The same date adds `kgWeightedPhpKg` to `BlockingPriceBand` and to `BlockingPriceLens.total` (additive; **null, never 0, on an empty band**, and the `total` figure is weighted over the PRICED population while its counts cover every block). **2026-09-22 — also owns the SUPPLIER LENS contract**: `BlockingSupplierSlice`, `BlockingSupplierBand`, `BlockingSupplierBlock`, `BlockingSupplierLens`, `BlockingSupplierLensRefusalReason`, `BlockingSupplierLensResult`, plus `BLOCKING_SUPPLIER_LENS_MIN_TOP_N` / `_MAX_TOP_N` / `_DEFAULT_TOP_N` (1 / 12 / 6), pinned to the SQL by `scripts/verify-blocking-supplier-lens.ts`. Like the age shapes, **not one of them carries money and none is derivable into it**, so the Supplier lens is shown to every role including Production. **The one thing to read before using it: there are TWO kilogram attributions** — `dominantKg`/`dominantBlockCount` is what the grid TINT shows, `apportionedKg` is what the yard-share RATIO BAR must use, and `apportionedDeliveredKg` is a third number again (it folds to the grid's `total_in`, not to `total.kg`). A `dominantKg` of **0 is a real measurement, not a missing value** (8 of 17 suppliers dominate nothing today), so it is deliberately NOT null-preserving while the two share percentages are. `isMixed` is the view's carried `supplier_count_in_block > 1` and must never be re-derived from `suppliers.length` — see **Data → Supplier lens**. |
| `constants.ts` | `WarehouseConfig` interface (`cols`, `colStart`, `rows`), `WAREHOUSES` constant (A/B/C/D + PCA/PCB), and `STANDARD_WAREHOUSES` (`['A','B','C','D']` — the 220-slot baseline). `colStart` lets PCA/PCB render columns 15-17 with correct labels and `locKey` math |
| `actions.ts` | Server actions (all price gating now via the canonical `roleCanViewPrices(role)` / `canViewPrices()` from `@/lib/auth` — DUP-2 replaced the former inline `role !== 'Production'` compares): `fetchBlockingGridData()` (queries `view_blocking_grid`, returns grid data with role-gated PHP/KG), **`fetchBlockingSupplierMap(): Promise<BlockingSupplierMap>`** (the supplier-search data layer — reads `view_blocking_block_suppliers` ONCE and folds it into `{ suppliers, byBlock }`; **does NO aggregation** — every kg, share and count comes out of SQL, and the ALL/SOME test is the view's `supplier_count_in_block`; **NOT price-gated on purpose** — the view carries no ₱ column and none derivable, so the payload is safe for Production; failures return an empty map and log, never throw), `fetchBlockingDetail(batchCode, batchId)` (fetches delivery + usage history with delivery IDs + lab results (mc/bd_astm/ash), batch notes, and avg_cost for a specific batch), **`fetchBlockDataForBatch(batchId)`** (batch-accurate `BlockData` header summary for ONE batch_id — queries `batches` + `deliveries` + `rc_out`, **no status/loc filter**, weighted-avg php+lab and `balance = total_in − total_out`, role-gated php; used by the **RC Movement matrix** so it can open the panel for a historical/closed batch that `view_blocking_grid` omits), `fetchSingleDelivery(deliveryId)` (fetches full delivery record for edit dialog and info dialog; **`cost_basis` is role-gated** — resolves the effective role via `getUserRole()` and only includes it for `roleCanViewPrices(role)`, else returns `cost_basis: null` so a Production user never receives the price through the panel's edit/info path; `FullDeliveryRecord.cost_basis` is therefore `number \| null`), `updateBlockNotes(batchId, notes)` (updates `batches.notes`, calls `revalidatePath('/inventory')`), **`buildBlendProposal(blockLocs: string[]): Promise<BlendProposal>`** (Blend Proposal mode — given selected block_locs, queries `view_blocking_grid` for the per-block passthrough rows + calls the `fn_blend_proposal` SQL RPC for the balance-weighted lab/price aggregation; TS does only the ×1.30 product-cost markup; **price-gated via `canViewPrices()`** — nulls `php_kg`/`raw_price_per_kg`/`product_cost_per_kg` and sets `can_view_prices: false` for Production BEFORE returning). **Exports the `BlendProposal` + `BlendProposalBlock` interfaces** (co-located with the action — consumer seam is `import { BlendProposal } from '.../blocking/actions'`). **2026-09-02 — the ×1.30 markup no longer lives here**: `buildBlendProposal` reads `production_loss_pct` from the SQL `fn_blend_production_loss_pct()` RPC (same `Promise.all`, no added latency) so the live what-if and a SAVED snapshot can never disagree about it; output is byte-identical (`raw * (1 + 30/100) === raw * 1.3` verified in IEEE-754). **Also adds the seven BLEND PROPOSAL HISTORY actions** — `saveBlendProposal`, `updateBlendProposalHeader`, `archiveBlendProposal`, `restoreBlendProposal`, `fetchBlendProposalList`, `fetchBlendProposalVersions`, `fetchBlendProposalVersion` — see **Data → Blend Proposal HISTORY** below. **All seven are WIRED as of 2026-09-03**: the reads by `blocking-route-view.tsx` (the saved version) and `blocking-grid.tsx` (the list), the writes by the grid. **2026-09-19 — adds the TWO PRICE LENS actions**, `fetchBlockingMarketBases(trailingDays?)` (the four market bases) and `fetchBlockingPriceLens(marketPhpKg, edgeOffsets?)` (band-classify the yard), plus the local `normalizeEdgeOffsets()` helper. **These two are gated DIFFERENTLY from everything else in the file**: they call `canViewPrices()` FIRST and return `{ok:false, reason:'prices_hidden'}` *without querying the database*, because band membership is itself price information and there is nothing to null — see **Data → Price lens** for the full contract. **2026-09-19 — adds the AGE LENS action `fetchBlockingAgeLens(edgeDays?)`** plus the local `normalizeEdgeDays()` helper (local, not exported, because `'use server'` allows only async exports — the UI's pure twin belongs in `lens/age-lens-settings.ts`). **It has NO `canViewPrices()` call and must never grow one**: nothing in its payload is money and none is derivable, so the Age lens is for EVERY role including Production; `scripts/verify-blocking-age-lens.ts` asserts the gate's ABSENCE so the asymmetry with the price sibling cannot be "tidied up". It does require a signed-in user (`auth.getUser()` → `not_signed_in`), like the other non-price reads here. See **Data → Age lens**. Backend only; no UI consumes it yet. **2026-09-21 — adds `fetchBlendBlockFacts(batchIds, asOf?)`** (the blend modal's supplier dominance + the two block ages, over `fn_blend_block_facts`). Keyed by **`batch_id`, never `block_loc`**; `asOf` omitted = today in Asia/Manila (the LIVE modal), a SAVED version passes its own version date; **no `canViewPrices()` call and it must never grow one** (nothing in the payload is money) though it does require a signed-in user; an unknown id is ABSENT from the record rather than zero-filled. See **Data → Blend block facts**. Backend only. **The same date gives `fetchBlockingPriceLens` an optional third argument `roundedUpPhp`** — for the `manual` basis pass `Math.ceil(typedPrice)`, for every measured basis pass nothing; omitted, the payload is byte-identical to before. **2026-09-21 — adds `fetchBlendAnalysis(input)`** (the blend proposal's ANALYSIS pages, over `fn_blend_analysis` + `fn_natural_breaks_3`) plus the local `normalizeAnalysisEdges()` helper and the pure `map*` re-keyers. **Its price gate is unlike anything else in this file: it is a DELETION, not a refusal and not a nulling pass.** The price lens refuses a `!canViewPrices()` caller outright because its whole payload is price; this one's payload SPLITS, so the action sets `price: null` with `pricesHidden: true` **and still returns `quality` + `age` to Production**. The gate runs AFTER the RPC (the non-price half is still wanted) and before the payload is assembled, fails closed, and `scripts/verify-blend-analysis.ts` asserts the ORDER, the single branch, the absence of a `prices_hidden` refusal, and that no money-named key exists outside `price` on a real payload. See **Data → Blend analysis**. Backend only. **`fetchBlockingPriceLens`'s mapper also now passes `kgWeightedPhpKg` through** on each band and on `total` (`lensNumOrNull`, never `?? 0`). **2026-09-22 — adds the SUPPLIER LENS action `fetchBlockingSupplierLens(topN = 6)`** (band-classify the yard by whose charcoal is in it, over `fn_blocking_supplier_lens`). **It has NO `canViewPrices()` call and must never grow one** — nothing in its payload is money and none is derivable, so the Supplier lens is for EVERY role including Production; `scripts/verify-blocking-supplier-lens.ts` asserts the gate's ABSENCE. It does require a signed-in user (`auth.getUser()` → `not_signed_in`), like the other non-price reads here. It does **no arithmetic** (asserted: no `reduce`, no `+=`, no `Math.round`, no `sort` — the band order is SQL's), only validates `topN` (integrality is enforced here because `p_top_n` is an `int` and Postgres rounds first, reusing the SQL's `invalid_top_n` reason) and re-keys `blocks[]` into `bandByBlock` + `blockByLoc`. See **Data → Supplier lens**. Backend only; no UI consumes it yet. **2026-09-25 — adds `overwriteBlendProposalVersion({proposalId, versionNo, expectedRevisionNo, blockLocs, changeNote?})` → `BlendProposalOverwriteResult`** (overwrite ANY saved version in place over `fn_overwrite_blend_proposal_version`; the replaced contents are archived first by the database; no ₱ so no price step) and extends the three history reads with the revision facts — see **Data → Blend Proposal VERSION OVERWRITE**. Backend only; no UI consumes it yet. |
| `page.tsx` | **Standalone route entry (`/inventory/blocking`).** Server component — renders `<BlockingRouteView>` inside a `<Suspense>` (the route view uses `useSearchParams`). Replaced the old "Coming soon" stub. |
| `blocking-route-view.tsx` | **NEW. Standalone-route host.** Client component owning the grid fetch / loading / error / Retry (repurposed from the deleted `blocking-lazy-tab`) — which now runs `fetchBlockingGridData()` and **`fetchBlockingSupplierMap()` in ONE `Promise.all`** (independent reads of two views; serializing would add the supplier round-trip to time-to-paint, and a failed supplier read returns an empty map by contract so it is never fatal) — the `?block=` URL selection (read via `useSearchParams`, toggled via `router.replace`), and the `onNavigateToBatch` wiring (`router.push('/inventory?tab=deliveries\|usage&search=…&editBatch=…&editView=deliveries\|usage')` — **`editView` discriminates which always-mounted table consumes `editBatch`**, see the editView deep-link contract under Key Behaviors). SHELL-AGNOSTIC — does NOT use `useInventoryTab`. Renders `<BlockingGrid>` controlled. **2026-09-03 — it also owns `?proposal=<id>&v=<n>` AND resolves it**: the two params are written TOGETHER by one `handleProposalLinkChange` (so switching proposals can never leave a stale version number behind, which would ask the server for a version that does not exist on this proposal), a junk `?v=` is treated as ABSENT rather than as version 0, and an effect turns the pair into `savedProposal` / `savedVersions` / `savedLoading` via `fetchBlendProposalVersions` → `fetchBlendProposalVersion`. **The route resolves it because the route owns the params** — the same division `?block=` and the supplier map already follow — which keeps the grid a component that RENDERS a saved proposal rather than one that goes and finds it. The writer is held in a `useRef` so the effect does not refetch every time an unrelated search param moves. |
| `supplier-search.tsx` | **NEW. The supplier search bar** (`BlockingSupplierSearch` + the `ActiveSupplierSummary` interface it takes). A **cmdk combobox** (shadcn `Command`/`CommandInput`/`CommandList`/`CommandItem`) whose suggestion list is an **absolutely-positioned panel, NOT a `Popover`** — the input stays the focus target, so nothing fights the sticky header for focus and no trap is created. Keyboard-first: typing filters, ↑/↓ moves, **Enter picks the highlighted suggestion**, and **Escape steps BACK one rung at a time** (clear the query → close the list → return to the chip); the Escape handler `stopPropagation`s so stepping back through the search never also closes the detail panel (which listens on the document). Filtering is a **case-insensitive SUBSTRING** match via a custom `filter` prop — deliberately not cmdk's fuzzy scorer — over a value that carries BOTH the canonical key and the display spelling, with a prefix hit outranking a mid-string one. Each suggestion reads `<display>` + a muted `N blocks · X t`. With a supplier active the bar renders an **emerald chip** — `Ornales · 9 blocks (all 5 · some 4)` — whose label re-opens the search and whose `×` clears the filter. Presentational only: it owns no filter state (the grid/route do) and does no aggregation. |
| `blocking-grid.tsx` | Main client component — accepts `data: BlockingGridData` and `canViewPrices: boolean` props, **plus optional controlled-selection props** `selectedLocKey?: string \| null` + `onSelectBlock?: (locKey) => void` (when BOTH are supplied the grid is fully controlled — the standalone route drives them from `?block=`; otherwise it falls back to internal `selectedLocKey` state) and `onNavigateToBatch?` (passed straight to the detail panel's "Edit All"). Renders sticky global summary header with warehouse filter chips (ALL + WHSE A/B/C/D + separator + PCA/PCB), balance text color legend, global stats. **The sticky header has a CONDENSED variant on short viewports** (`[@media(max-height:500px)]` — phone landscape; see the phone-landscape bullet under Key Behaviors) driven by the **`SHORT` const map** at the top of the file plus the `GlobalStat` / `StatDivider` / `Peso` components at the bottom. Up to 6 warehouse grid sections with CSS Grid layout — standard 20-col sections + narrow 3-col PCA/PCB sections (rendered with `max-w-[280px]`). Neutral zinc-gradient occupied cells with balance-percentage text coloring and lab-highlight text colors on MC/ASH, empty cells, utilization bars. Manages `selectedLocKey`, `activeWarehouses`, `statusFilter`, blend-mode, and the **`showPrices` price-visibility preference** state. **Owns the EFFECTIVE price flag: `canViewPrices = serverCanViewPrices && showPrices`** — this single derived value is the ONLY thing passed downstream (cells, warehouse headers, detail panel, blend modal pref) for any price render decision, so the client toggle can hide but never reveal. Warehouse headers display all 7 weighted-average lab results. Status badges + lab quality filters (Wet/Ashy) are clickable with spotlight dim/glow effect. Reads `labHighlights` from `useTableSettings()` for MC/ASH text coloring and WET/ASHY spotlight filters. **Also owns the SUPPLIER SPOTLIGHT**: it takes `supplierMap` / `supplierFilter` / `onSupplierFilterChange`, resolves the active supplier against the map (an unknown `?supplier=` key highlights nothing rather than dimming everything), counts its ALL/SOME blocks for the chip, renders `BlockingSupplierSearch` twice (see the header-placement note under Key Behaviors) and passes `supplierKey` + `supplierByBlock` down the same prop chain the status spotlight uses. `getSupplierSpotlightClass()` and `formatSupplierMix()` live beside `getSpotlightClass()`. Imports `BlockingDetailPanel` from `../_shared/blocking-detail-panel` (panel was hoisted out of this module) and renders it with the grid `data` map; "Edit All" navigation flows through the `onNavigateToBatch` prop the standalone route host wires to a `router.push` (with `editView`), NOT the `INVENTORY_NAVIGATE_EVENT` window event (that event is now only the fallback for a future in-shell host with no `onNavigateToBatch`). **Also owns the BLEND PROPOSAL HISTORY interaction layer (2026-09-03)**: the header **Proposals** button (History icon + a badge counting NON-archived proposals), the proposals list fetch (`fetchBlendProposalList({includeArchived:true})` once on mount — archived rows are filtered at the glass), every WRITE (`saveBlendProposal`, `updateBlendProposalHeader`, `archiveBlendProposal`, `restoreBlendProposal`), the `editing` Modify session, and the Compare computation. It takes `proposalId` / `savedProposal` / `savedVersions` / `savedLoading` / `onProposalLinkChange` from the route. Local helpers `SaveVersionPopover` (the change-note prompt) and `describeSaveRefusal` (turns a `stale` / `unknown_block` refusal into a sentence naming the version someone else appended, or the blocks that left the grid) live at the top of the file. |
| `blend-action-bar.tsx` | **NEW (2026-09-25). THE BLEND ACTION BAR**, extracted from `blocking-grid.tsx` so the dev fixture can mount the real thing. The floating bar shown for the WHOLE blend session (`{blendMode && …}` — also with nothing picked, when the stats strip shows its hint). Three stacked rows: the Modify banner (`Editing: <title> vN ×` + the unresolved-blocks notice), the **live stats strip** (`BlendLiveStatsRow`), and the actions (count · Build Proposal · in a Modify session **Save to v{from}** · **Save as v{N+1}** · Save as new · Clear). Owns `BlendEditingContext` (now also `fromRevisionNo` — the overwrite token — and `baseline`, the modified version's DB snapshot for the stats deltas), `describeSaveRefusal` (append) + **`describeOverwriteRefusal`** (overwrite, same tone), and `SaveVersionPopover({ mode: 'append' \| 'overwrite' })`. No data access; every handler and number is a prop. Positioned `fixed bottom-4 inset-x-0 mx-auto w-fit max-w-[calc(100vw-2rem)]` (a `left-1/2 -translate-x-1/2` bar is sized against HALF the viewport and starved the strip). |
| `blend-live-stats.tsx` | **NEW (2026-09-25). The LIVE BLEND STATS** — `useBlendLiveStats({ enabled, selection, fetcher, debounceMs?, watchdogMs? })` + the presentational `BlendLiveStatsRow`, plus the pure `blendSelectionSignature` / `blendSignatureLocs` / `acceptBlendReply` the verify script pins. See **Live blend stats — UI** below. |
| `../_shared/blend-proposal-dialog.tsx` | **TWO MODES, ONE COMPONENT (2026-09-03).** Without the new optional `saved` prop it is the LIVE what-if it has always been (everything below still applies verbatim). With `saved: BlendSavedContext` it renders a SAVED VERSION — and it needs no new gating or layout code to do it, because `fetchBlendProposalVersion` returns exactly the `BlendProposal` shape plus identity. What saved mode ADDS: the proposal's **title as the header** with the **REMARK in muted prose beneath it** (Renzo's explicit requirement — every proposal has both) and a `v3 · as proposed YYYY-MM-DD · Author` meta line (the date is the SNAPSHOT's `computed_at`, never the clock); a **version rail** (`v1 · v2 · v3★`, current starred, the selected chip's `change_note` + author + date underneath, chips write `?v=`); a status pill + an Archived badge; and the header actions **Compare with today** (read-only, stays available on mobile), **Modify**, **Edit** (a popover patching title / remark / status `draft·planned·fed` + `fed_on`, refusing `fed` without a date locally because the DB CHECK ties them), and **Archive/Restore**. What it REMOVES: the per-row **X is disabled in saved mode** — a stored version is immutable and changing its blocks is what Modify is for. Compare renders a second and third line in each summary/lab/price cell (saved / today / signed change), an amber dot + tinted row on every block whose batch changed hands, and a "No longer on the grid" footnote; deltas are **NEVER colour-coded green/red** — "ASH rose" is not good or bad, so the SIGN carries direction and colour is reserved for unknown (em dash) and unmoved. The weighted-lab strip now **scrolls** (`overflow-x-auto`, `min-w-[62px]`/`[72px]` per cell) instead of truncating to `10.…` on a phone. **MOBILE (below `sm`) IS READ-ONLY**: Save / Modify / Edit / Archive are hidden and a one-line note says why, rather than being silently absent. Also exports `BlendStatusPill`, `BLEND_STATUSES`, `SaveNewPopover` (the title+remark prompt, reused by the grid's floating bar) and the `BlendSavedContext` type. `buildBlendPrintDocument` gained a third `meta?: BlendDocMeta` argument — a saved version prints under its own name with the version line and the remark; absent meta reproduces the previous document byte for byte. **Blend Proposal result panel — a CENTERED MODAL (`Dialog`)** (was a right-side Sheet; converted per user preference). Uses the canonical dialog glass (`DialogContent` ships `bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80`) + `animate-modal-enter`. **WIDE: `max-w-4xl`, `max-h-[85vh]`, `flex flex-col` with a `flex-1 min-h-0 overflow-y-auto` body** so the header (Download PDF + Print + close) and blend-summary stay fixed while the body scrolls — sized to fit the wide per-block lab table. `showCloseButton={false}` (header owns its own Download PDF + Print + close actions). Props: `open`, `onOpenChange`, `proposal: BlendProposal \| null`, `loading`, **`onRemoveBlock?: (blockLoc: string) => void`**, and **`showPrices?: boolean`** (the client price-visibility preference from the Blocking toggle — a HIDE-ONLY layer; the dialog derives the EFFECTIVE flag `proposal.can_view_prices && showPrices` and uses it for ALL on-screen price render AND both exports, so the toggle can hide but never reveal). Renders the **combined total balance + block count**, the **balance-weighted blended lab stats** strip (MC, ASH, BD ASTM, BD JIS, GRIT, VM, FC — BD 3-decimal, rest 2-decimal), the **price section** (raw blended ₱/kg + product cost ₱/kg with the transparent formula `Raw blend ₱X × 1.30 (30% production loss) = ₱Y /kg`), and the **Selected Blocks table**. **The per-block table is Excel-dense** (`font-mono`, right-aligned numerics, `text-[10px]`, tight `px-1.5 py-1`, `whitespace-nowrap`, `min-w-[640px]` inside an `overflow-x-auto` wrapper so wide content scrolls horizontally rather than shrinking columns illegibly): columns = block_loc, batch_code, balance, **then all 7 per-block lab results (MC/ASH/BD ASTM/BD JIS/GRIT/VM/FC — same decimal precision, NOT price-gated)**, then the role-gated PHP/KG column, then a remove (X) cell. **In-modal deselect:** each row's X calls `onRemoveBlock(block_loc)`; the grid owns the source-of-truth selection and re-runs `buildBlendProposal` for the reduced set (see grid `handleRemoveBlendBlock`), so the modal numbers and the grid cell rings can never diverge. During the re-fetch the table dims (`opacity-60 pointer-events-none`) and a header spinner shows; remove buttons are `disabled` while `loading`. Removing the LAST block closes the modal + clears the selection. **Closing the modal (Escape / overlay / close) clears the blend selection** via the grid's `handleProposalOpenChange`. **Header action group (left→right): Download PDF, Print, Close.** **Download PDF button** (Download icon) opens a small **Popover** anchored to the button (`bg-popover/95 backdrop-blur-lg`) prompting for a **label** (text `Input` + a live filename preview + Cancel/Download buttons; Enter confirms). On confirm it calls `downloadBlendPdf(proposal, label)` (from `./blend-proposal-pdf`) which builds a **vector/text PDF (jsPDF + jspdf-autotable — selectable text, NOT a screenshot/raster)** from the structured `proposal` and triggers a browser download named **`YYMMDD - {label}.pdf`** (YYMMDD = `format(new Date(), 'yyMMdd')` at runtime — dynamic, never hardcoded; label sanitized to strip filesystem-illegal chars `/ \ : * ? " < > |` + control chars while KEEPING spaces, e.g. `4x8 RUN` → `260619 - 4x8 RUN.pdf`). The **Download confirm button is disabled until the sanitized label is non-empty** (`composeBlendPdfFilename` returns `null` for blank/all-illegal). PDF-generation failure surfaces `errorToast()`. **PDF price gating is identical** to screen/print: per-block PHP/KG column, raw price, product cost + formula appear ONLY when `proposal.can_view_prices` is true AND values are non-null; the per-block lab columns are NOT gated. (Currency in the PDF is spelled `PHP 42.00` not `₱` — jsPDF's built-in WinAnsi font lacks the `₱` glyph; the on-screen modal + HTML print keep `₱`.) **Print button** (Printer icon in the header) calls `handlePrint()` → `buildBlendPrintDocument(proposal)` (exported, pure) → `printViaIframe()` — the SAME hidden-iframe + self-contained-HTML approach as the detail panel (shared plumbing from `./print-utils`, NOT `@media print`). The printout mirrors the modal: title, subtitle, Summary, Blended Lab Stats, gated Pricing section (raw price + product cost + `× 1.30` formula), and the Selected Blocks table **including the 7 per-block lab columns** (with the PHP/KG column only when prices are viewable), all clean black-on-white. **Price gating (screen AND print AND PDF):** the price section, per-block ₱ column, and all printed/exported ₱ fields render ONLY when the EFFECTIVE flag is true — `proposal.can_view_prices` (server gate) **AND** the `showPrices` display preference **AND** the value is non-null. The print/PDF builders take `showPricesPref` (`buildBlendPrintDocument(proposal, showPricesPref)`, `buildBlendPdf`/`downloadBlendPdf(…, showPricesPref)`) and re-AND it with `can_view_prices` so a hidden-prices export carries no ₱. NO client role lookup; the per-block LAB columns are NOT gated (everyone sees lab stats). Iframe-creation failure surfaces a persistent, copyable `errorToast()`. **User-provided text (block_loc, batch_code) is HTML-escaped** (`escapeHtml()`) before interpolation into the print HTML. Imports the `BlendProposal` + `BlendProposalBlock` types from `../blocking/actions`, and `downloadBlendPdf` / `composeBlendPdfFilename` from `./blend-proposal-pdf`. |
| `../_shared/blend-proposal-pdf.ts` | **2026-09-03: `buildBlendPdf(proposal, showPricesPref, date, meta?)` and `downloadBlendPdf(proposal, label, showPricesPref, meta?)` take an optional `BlendDocMeta`** — a saved version's PDF is titled with the proposal's name and carries `v3 - as proposed 2026-09-02` plus the wrapped remark under the subtitle (the `·` separator is rewritten to `-` because jsPDF's WinAnsi Helvetica has no middot). The dialog defaults the PDF **label** to the proposal title so a saved proposal is never retyped. An absent meta reproduces the previous document exactly. **NEW. Vector (text-based) PDF generator** for the Blend Proposal modal's Download-PDF button — **jsPDF + jspdf-autotable**, NOT html2canvas/rasterization (output is crisp, selectable text). Exports: **`buildBlendPdf(proposal, showPricesPref?, date?)`** (builds the `jsPDF` doc from the structured payload — title, `YYYY-MM-DD` subtitle + block count + combined balance, Summary, weighted lab stats grid, gated Pricing section with the `Raw blend PHP X x 1.30 (30% production loss) = PHP Y /kg` formula, and the Selected Blocks autotable with the 7 per-block lab columns + gated PHP/KG); **`downloadBlendPdf(proposal, label, showPricesPref?)`** (composes the filename + triggers `doc.save()`); and **re-exports** `composeBlendPdfFilename` / `sanitizeLabel` (now DEFINED in `blend-proposal-filename.ts`, see below). **Price gating** mirrors print/screen exactly: the effective gate is `proposal.can_view_prices && showPricesPref && value !== null` (`showPricesPref` = the client "Prices" toggle, defaults `true`, hide-only) — no role lookup; lab columns ungated. **Currency is spelled `PHP `** (not `₱`) because jsPDF's built-in Helvetica is WinAnsi and lacks `₱` (U+20B1, would mis-map to `±`). Pure/testable — type-only import of `BlendProposal` so it runs headless in node. **PERF-4: imported LAZILY** by the dialog (`await import(...)` on the Download click) so jsPDF stays in an async chunk out of the main bundle. |
| `../_shared/blend-proposal-filename.ts` | **NEW (PERF-4).** jspdf-FREE filename helpers split out of `blend-proposal-pdf.ts` so importing them (the dialog needs them synchronously for the live filename preview + validity gate) does NOT drag jsPDF into the bundle. Exports **`composeBlendPdfFilename(label, date?)`** → `YYMMDD - {label}.pdf` or `null` if the sanitized label is empty, and **`sanitizeLabel(label)`** (strips `/ \ : * ? " < > |` + control chars, KEEPS spaces, collapses whitespace, trims). Depends only on `date-fns`. `blend-proposal-pdf.ts` re-exports both for back-compat + its node/test path. |
| `../_shared/print-utils.ts` | **2026-09-03: also owns `BlendDocMeta` + `blendVersionLine()` + `blendComputedDate()`** — the identity of a SAVED proposal in a document (title, remark, version no, the snapshot's `computed_at`), and the ONE definition of the `v3 · as proposed YYYY-MM-DD` line, shared by the on-screen header, the printout and the PDF so the three can never disagree. It lives here rather than in either builder because both builders need it and neither may import the other. **NEW. Shared native-print plumbing** for the Blocking views. Exports `escapeHtml()`, `peso()`, `printViaIframe()`, `PRINT_CSS` (base black-on-white print stylesheet), and the `PESO`/`EMDASH` constants. Both `blocking-detail-panel.tsx` and `blend-proposal-dialog.tsx` import these — only the per-view document-body builder differs. Pure module (no React); the hidden-iframe approach keeps printouts immune to dark mode/Tailwind/portals/transforms (NOT `@media print` DOM-toggling). |
| `blocking-detail-panel.tsx` | **MOVED to `app/(app)/inventory/_shared/blocking-detail-panel.tsx`** (see [inventory/CONTEXT.md](../CONTEXT.md) `_shared/`). Slide-over panel component (**`w-full sm:w-[520px]`**, h-dvh — full-width on phones so it never overflows a 375px screen; the fixed 520px kicks in at `sm`+, so desktop is unchanged; applied to BOTH the closed-placeholder and open render branches), now **shell-agnostic** (imports NOTHING from the tab shell) so Blocking and RC Movement can later render it on standalone routes. **Contract (shared with RC Movement):** props are `locKey` (display key for the header badge — `null` = closed), `onClose`, `canViewPrices`, an **optional** `data?: Record<string, BlockData>` (the grid map; Blocking grid passes this and the panel derives `data[locKey]`), an **optional** `blockData?: BlockData \| null` (a directly-supplied, batch-accurate summary that **takes precedence** over `data[locKey]`), the **optional optimistic-open trio** `loading?` / `error?` / `onRetry?` (see below), and an **optional** `onNavigateToBatch?: (target: { batchCode; view: 'deliveries' \| 'usage' }) => void` (host hook for "Edit All").

> **TWO OPENING CONTRACTS — `loading` / `error` / `onRetry` (added 2026-08-28, opt-in, default OFF).**
> **FETCH-FIRST (original):** the host resolves `blockData` and only then sets `locKey`, so the drawer opens already full — and the click does nothing at all until the round-trip returns. Blocking grid, both RC Movement grids and the inventory tab shell all still do this and are **unchanged**.
> **OPTIMISTIC (the pattern to spread):** the host sets `locKey` on the **click frame** with `blockData` still null and passes `loading`; the drawer slides out at once over a layout-matched skeleton (`DetailDrawerSkeletonBody` from `@/components/shared/detail-drawer-skeleton`), the fetch runs concurrently, and when data lands the four section wrappers get a 150ms `animate-fade-in` so the content replaces the placeholder in place — same DOM nodes, no height jump, the slide never restarts. Passing `error` (+ optional `onRetry`) keeps the drawer **open** on failure with a persistent inline banner carrying **Copy** and **Retry** (an inline banner satisfies the error HARD RULE in place of a toast). Reference implementation: `components/digest/open-blocks.tsx`.
> **How a call site adopts it:** (1) set the locKey AND `loading` on click, clearing any previous `blockData` so the drawer cannot flash the last block's numbers; (2) guard the response with a **request token** so a second click (or a close) discards the first one's late reply; (3) surface failures through `error`/`onRetry`, never as a blank panel.
> **Why the two can't collide:** with `loading` and `error` both `undefined` the optimistic branch is unreachable AND the fade class is never computed (`isOptimisticHost = loading !== undefined || error !== undefined`, derived purely from props — deliberately not state, which would mean a setState inside an effect on every open). A `locKey` with no `blockData` and no opt-in still renders the same empty closed shell it always did. The optimistic branch also emits the SAME two children in the SAME positions as the other two render branches (backdrop div, panel div), so React reconciles them as one DOM node and the slide runs straight through the swap. The Blocking grid keeps passing `data={data}` (unchanged); the RC Movement matrix passes `blockData={…}` from `fetchBlockDataForBatch` and omits `data`. **Navigation on "Edit All" — host owns it when provided:** when `onNavigateToBatch` IS supplied (both current routes pass it), the panel calls it and **returns immediately — it does NOT also `router.push`**. (Previously the panel always pushed a `tab=`-less `/inventory?editBatch=…` URL AFTER the host's push; that second push won and clobbered the host's `tab=`/`editView=`, landing "Edit All Usage" on the Deliveries tab.) The panel's own `router.push` + the `blackwood:inventory-navigate` window CustomEvent (exported as `INVENTORY_NAVIGATE_EVENT` + `emitInventoryNavigate()`) now run ONLY on the fallback path (no host hook) — a forward-looking seam for a future in-shell host that renders the panel itself; today nothing exercises it. The on-demand detail fetch keys on `blockData?.batch_id` (not `locKey`). `parseLocKey` is defensive — a non-loc display key (FEED batch code) returns `null` and the "WHSE/Col/Row" subline is hidden. Fetches detail via `fetchBlockingDetail()`. Delivery-card style layout (iPad Mini 6 portrait ~1080px, no scroll to reach delivery history): compact header, 3-col metrics grid (Balance/PHP/KG/Est.Value, role-gated), 7-cell lab row, inline notes, scrollable delivery + usage history. EditDeliveryDialog + DeliveryHistoryDialog (from RC IN) integration. Escape/backdrop to close. **True-weight popover on delivery-history rows:** a tagged delivery (`true_weight_kg != null`) shows a small `Σ` marker beside its weight value (left of the number) that opens the shared `_shared/true-weight-popover.tsx` — display-only true weight / recorded / deduction note, plus a `canViewPrices`-gated effective-₱/kg line. The marker `stopPropagation`s so opening it never fires the row's info-dialog `onClick`. Untagged rows render unchanged. **Print button** (Printer icon, header action group next to Close) calls `handlePrint()`, which builds a **fully self-contained print document** (its own `<html>` + minimal print CSS) from the data the panel already holds (`buildPrintDocument()`) and prints it in a **hidden same-origin iframe** (`printViaIframe()`, now imported from the shared `./print-utils`) — it does NOT toggle or print the live DOM. This keeps the output immune to dark mode, Tailwind, portals, overlays, transforms, and the slide-over's fixed positioning (the previous `@media print` visibility-toggle leaked all of those and printed like a screenshot). The document = title (Block loc — batch), subtitle (WHSE/Col/Row + status), Summary + Quality definition rows, optional Notes, and bordered Delivery + Usage tables, all clean black-on-white with right-aligned numerics. **User-provided text (batch code, supplier, destination, production_batch, notes) is HTML-escaped** via `escapeHtml()` (shared from `./print-utils`) before string interpolation. **All ₱ fields reuse the SAME `canViewPrices && blockData.php !== null` flag the on-screen panel uses** — passed into `buildPrintDocument()`, no role lookup — so a Production user's printout omits PHP/KG, Est. Value, the delivery PHP/KG column, and the usage Avg Price column. The iframe is removed on `afterprint` (with a 60s fallback). Failure to create the iframe surfaces an `errorToast()` (persistent + Copy). |
| `edit-delivery-dialog.tsx` | **MOVED to `app/(app)/inventory/_shared/edit-delivery-dialog.tsx`** (private dependency of the panel). Edit delivery dialog — opened from delivery row pencil icon. Fetches full delivery via `fetchSingleDelivery()`, form with all delivery fields + collapsible lab results section. Saves via `bulkUpdateDeliveries()` from RC IN actions for audit trail. PHP/KG input is role-gated behind `canViewPrices` (hidden client-side for non-price-viewers); `deliveryToForm` defaults a `null` `cost_basis` (withheld by `fetchSingleDelivery` for Production) to `''` so the form neither crashes nor shows a stale/zero price. Glass effect DialogContent with `animate-modal-enter`. Imports `../blocking/types` + `../blocking/actions`. |
| `../_shared/blend-proposals-dialog.tsx` | **NEW (2026-09-03). The Proposals LIST dialog** — the history half of the blend feature. A dense `table-fixed` list of every saved proposal, newest-touched first: **Title · Remark (truncated, full text on a shadcn `Tooltip`) · Status pill · v# (`v3 /3`) · Blocks · Balance (tonnes, ACCOUNTING layout — `t` pinned left, number pinned right) · MC · ASH · BD ASTM · Updated · By · Restore**. Explicit pixel widths in a `COLS` const summing to **1098px**, an `overflow-x-auto` wrapper and `max-w-6xl` on the dialog so all 12 columns fit on a desktop and SCROLL rather than crush below it ("never crush, always scroll" — there is deliberately no slack-absorbing `w-auto` column). Client-side search (plain case-insensitive SUBSTRING over title + remark, never a fuzzy scorer) and a **"Show archived" `Switch`**; archived rows render at `opacity-55` with a **Restore** action that `stopPropagation`s past the row click. **Archived rows are filtered CLIENT-SIDE, not refetched** — the list is small, the header badge has to count the live ones anyway, and a row you just archived should not vanish behind a round-trip. Empty state is prose, and it differs by cause (nothing saved yet / no search match / nothing un-archived). **PESO-FREE by construction** (`view_blend_proposal_list` carries no ₱ and none is derivable), so it needs no `canViewPrices()` gate and is safe for Production. Re-exports nothing; imports `BlendStatusPill` from the viewer dialog. |
| `lens/types.ts` | **NEW (2026-09-19). THE LENS FRAME CONTRACT — pure, no React, no fetch.** `BlockingLensDefinition` (`id`, `label`, `icon`, `blurb`, **`ramp`** — which colour scale, see `lens/lens-ramp.ts` —, `canShow`, `Panel`), `BlockingLensPanelProps` (incl. the optional **`onFocusBlock(blockLoc)`**, which lets a lens open a block it NAMES — the age lens's oldest pile — through the grid's own cell-click handler), `BlockingLensCapabilities` (`{ canViewPrices }` — the grid's EFFECTIVE flag), and **`BlockingLensClassifier = (block_loc) => { className?, dimmed? } \| null`**, which is the ONE seam between a lens and the grid. It is a FUNCTION rather than a `Record<block_loc, string>` because a lens knows things the grid must not have to learn — that an UNPRICED block belongs in NO band (`null` = *leave the cell exactly as it looks with no lens open*, a third answer distinct from "marked" and "dimmed"), that an empty slot dims only once bands are isolated. Also exports the pure `resolveLensCellClass(classifier, locKey)`, which reuses the shared `.spotlight-dimmed` rather than cloning it, and in which **`dimmed` beats `className`** (a glow ring on a 30%-opacity cell reads as neither) — and, since 2026-09-19, the sibling **`resolveLensCellTitle(classifier, locKey)`** for the one extra line a lens may add to a cell's EXISTING native `title` (`BlockingLensClassification.title`). Two one-line resolvers rather than one two-purpose call: the class is needed on every render of every cell, the title only on hover, and a lens with nothing to add simply omits it. |
| `lens/registry.ts` | **NEW. The whole lens list, in one array** — `BLOCKING_LENSES` (**`[PRICE_LENS, AGE_LENS, SUPPLIER_LENS]`** since 2026-09-22; order IS tab order, and Price is first because it is a price-viewer's default while Age and Supplier — both `canShow: () => true` — are what Production sees), `visibleLenses(caps)` and `resolveLens(id, caps)`. **`resolveLens` returns `null` for an unknown id AND for a lens this reader may not be offered — never the first lens**, so a shared `?lens=price` link hands a Production user the page rather than a substitute lens they did not ask for. See **REGISTERING A SECOND LENS** below. |
| `lens/lens-panel.tsx` | **`BlockingLensPanel` — THE LEGEND BAR every lens renders inside. REBUILT 2026-09-21: it is a BAR, not a sidebar.** One slim full-width row (`h-9`, `flex-nowrap`, never wrapping) directly under the control strip and sticky WITH it, holding only what a reader looks at while scanning: the lens switch (a `role="tablist"` when `lenses.length > 1`, a plain label otherwise), the lens's own headline, its band CHIPS, a thin ratio bar, the kg\|blocks switch, the "in no band" chip, a Settings gear, Clear and close. Everything else moved into `lens-settings-popover.tsx`. **The grid is FULL WIDTH again** — the flex row and the `min-w-0 flex-1` column are gone, and each warehouse section keeps its own `overflow-x-auto` + the 104px track floor, so "never crush, always scroll" holds for the reason it always did. Escape still steps back one rung (it bails while the detail drawer is open, and yields to any Radix popper/dialog/listbox — which now includes the Settings popover, so one press closes the popover and the next closes the lens). The body is still keyed `key={active.id}` so switching UNMOUNTS one lens and MOUNTS the next. **Superseded, for the record:** it used to be a DOCKED frame — at `lg`+ a `sticky` 300px column BESIDE the warehouse sections (`shrink-0`, `top-[92px]`, `max-h-[calc(100dvh-108px)]`, own `overflow-y-auto`); below `lg` a bottom **sheet** (`fixed inset-x-2 bottom-2 z-40 max-h-[65dvh]`) using the canonical floating-bar glass. It never covers the grid it exists to light up. Owns the header (lens icon + label + blurb + **Clear** + close), the **tab strip — which renders ONLY when `lenses.length > 1`**, so with one lens registered there is no dead/disabled tab, and the body keyed `key={active.id}` so switching lens UNMOUNTS one and MOUNTS the next (a hook on the definition object would change hook order on a switch — a rules-of-hooks violation, which is why a lens is a component and not a controller hook). **Escape steps back one rung at a time**: the handler bails while `escapeSuppressed` (the grid passes `!!selectedLocKey`, so the detail drawer closes first and the lens on the next press — `supplier-search.tsx`'s idiom) and bails when the event came from a `[data-radix-popper-content-wrapper]`/`[role=dialog]`/`[role=listbox]`, whose own dismiss owns that key press. |
| `lens/price-lens-panel.tsx` | **NEW. The PRICE lens body + its `PRICE_LENS` registration.** Top to bottom: the **"Market is"** `Select` (This month's / Last month's / Last 3 months / Last N days / **Set a price**), the N box or the typed-₱ box, the market figure in mono (2dp on screen, the full weighted average on `title`) + "rounds up to ₱40" + a quiet coverage line (`566,870 kg priced · 37 deliveries · 2026-09-01 → 2026-09-30`) that makes an early-month thin basis visible; the **stacked ratio bar** with a **kg \| blocks** switch that moves the bar AND the row percentages together; one **toggle row per band** (`aria-pressed`, swatch + label + share + `N blocks · X kg`); a separate muted **unpriced** row; and the **Customize bands** `Collapsible` (cut-line chips with removers, an add box, the cap stated inline rather than a dead button, per-band rename inputs, Reset). **IT COMPUTES NO STATISTIC** — every kg, count, share and band membership is the payload's, the ratio-bar widths ARE the published shares, and there is no `reduce`, no `+=` and no `Math.floor` in the file (R is SQL's). Fetches are **debounced 250 ms and race-safe via a request token**; a refusal KEEPS the previous tint. Exports **`PriceLensAdapter`**, the two-method port onto `fetchBlockingMarketBases`/`fetchBlockingPriceLens`, defaulted to the live actions and injectable only so the gated dev fixture can drive the real component with a static payload. **2026-09-19 — the band rows, the ratio bar, the kg\|blocks switch, the unpriced row, the refusal banner and the Customize disclosure were EXTRACTED to `lens/lens-*.tsx` and are now shared with the age lens**; the rendered markup and wording did not move (its verify script still passes), and what stays in this file is what is actually about PRICE: the basis select, R, the ₱ labels, the price gate and the two reads. |
| `lens/price-lens-settings.ts` | **NEW. Pure settings arithmetic** — `PriceLensSettings` (`basis`, `trailingDays`, `manualPrice`, `edgeOffsets`, `bandNames`, `unit`), `DEFAULT_PRICE_LENS_SETTINGS`, `parsePriceLensSettings` (**untrusted, FIELD BY FIELD, falling back per field** — never "one bad key, everything to defaults"), `serializePriceLensSettings` (**defaults OMITTED**, so Reset is a removal), `normalizeEdgeOffsets` / `addEdgeOffset` / `removeEdgeOffset` (±50, max 6, **at least one edge must survive** — and BOTH default edges are removable), `parseManualPriceInput` (positive, finite, ≤2dp — **`0` is refused**, a ₱0 market would put every block above market), `bandEdgeKey` / `bandOffsets`, `priceBandLabel` and `bandRampStop` / `bandRampClass` / `PRICE_LENS_RAMP` (**all three now DELEGATE to `lens/lens-ramp.ts`** — the age lens needs the same stop arithmetic over a different colour scale, so the maths moved and these stayed as the price lens's own names for the COST ramp). **A band name is keyed on the band's two OFFSETS from R, not its index** — keying on the index would silently re-point every name the moment a cut line was added below it. |
| `lens/use-lens-settings.ts` | **NEW. Per-user lens settings, one document per lens.** localStorage (`bw.blocking_lens_<id>.v1`, written synchronously) + `user_table_settings` under **`module = 'blocking_lens_<id>'`** on a 500 ms debounce, through the shape-agnostic `getUserModuleSettings`/`saveUserModuleSettings` pair. **NO MIGRATION, no new table, no new action.** Four disciplines inherited from `app/(app)/analytics/use-analytics-prefs.ts`: read in an EFFECT (never a lazy initialiser — hydration), every storage touch wrapped, the stored value untrusted (the caller's `parse` runs on BOTH copies), and a failed remote save logged and dropped. **Why not `useTableSettings()`**: that provider is mounted once globally with `tableId='rc_in'` and its document is typed `RcInTableSettings` with a setter per field and no arbitrary-key door — storing a Blocking preference through it would mean filing it in the RC IN row AND widening the RC IN type. Same jsonb column, right door. |
| `lens/age-lens-panel.tsx` | **NEW (2026-09-19). The AGE lens body + its `AGE_LENS` registration.** Top to bottom: (1) the yard's **kg-weighted age** in mono (`396.7 days`) with a quiet `as of <date> · oldest <N> days at <BLOCK>` line whose block is a BUTTON that opens that cell (through `onFocusBlock` → the grid's own `handleCellClick`, so the blend-mode and URL behaviour is identical to clicking the cell); (2) the shared ratio bar + the `kg | blocks` switch; (3) one shared toggle row per band, each with its own published `kgWeightedAgeDays` on the quiet second line; (4) a muted `No delivery dates — N blocks, X kg` row when `undated.blockCount > 0`; (5) the shared **Customize bands** disclosure, in DAYS, with one-click chips for the common cuts. **`canShow: () => true`** — no ₱ anywhere in the payload, so Production sees it. **IT COMPUTES NO STATISTIC**: no `reduce`, no `+=`, no division by a total and no `Math.min`/`max` — even `oldestAgeDays`/`oldestBlockLoc` are the server's. Exports **`AgeLensAdapter`**, the one-method port onto `fetchBlockingAgeLens`, defaulted to the live action and injectable only for the gated dev fixture. |
| `lens/age-lens-settings.ts` | **NEW. Pure settings arithmetic for the age lens** — `AgeLensSettings` (`edgeDays`, `bandNames`, `unit`), `DEFAULT_AGE_LENS_SETTINGS` (`[60, 120, 365]`), `parseAgeLensSettings` (**untrusted, FIELD BY FIELD, falling back per field**), `serializeAgeLensSettings` (**defaults OMITTED**, so Reset is a removal), `normalizeEdgeDays` / `addEdgeDay` / `removeEdgeDay` (whole days 1…5000, max 6 **after de-duplication**, **at least one cut line must survive**), `parseEdgeDayInput`, `bandDayKey` / `ageBandLabel` / `yearWord`, `AGE_LENS_QUICK_CUTS` (`30 · 60 · 90 · 120 · 180 · 365 · 730`) and `ageBandRampClass`. **`normalizeEdgeDays` is the PURE TWIN of `actions.ts`'s own normaliser** (that file is `'use server'`, so a synchronous helper cannot leave it): the two agree on the shape they produce and differ only in how they treat rubbish — salvage a stored preference, refuse a live request. **A band name is keyed on the band's own DAY INTERVAL, not its index**, so a name follows its own slice instead of jumping when a cut line is added below it. **`yearWord` reads ONLY exact multiples of 365 as years** — a 400-day cut line stays "Over 400 days" rather than being rounded into "Over 1 year". |
| `lens/lens-ramp.ts` | **THE COLOUR RAMPS, and the only place a band class name or an `r g b` triple is built.** `LensRampId` (`'cost' \| 'age' \| 'category'`), `LENS_RAMP_STOPS` (7 — the ORDINAL ramps), **`LENS_CATEGORY_STOPS` (13)** and **`LENS_CATEGORY_NEUTRAL_STOP` (12)**, `LENS_RAMP_STOP_COUNT`, **`LENS_RAMP_IS_ORDINAL`**, `LENS_RAMP_CLASS_PREFIX` (`lens-band-` / `lens-age-` / **`lens-cat-`**), `LENS_RAMP_RGB`, `rampStop(index, bandCount, ramp?)`, `rampClass`, `rampRgb`, and — added 2026-09-22 for the NOMINAL ramp — **`categoryStop(index, isOthers)`**, **`rampClassAtStop(ramp, stop)`** and **`rampRgbAtStop`** — and, added later the same day for PAPER, a SECOND table **`LENS_PRINT_FILL_RGB`** + **`printFillRgbAtStop(ramp, stop)`**. **`LENS_RAMP_RGB` IS THE SCREEN RAMP AND IS ONLY EVER SEEN AS A 22% WASH; the yard map paints SOLID, so it reads the PRINT table instead** — each entry a white TINT of the same hue (hue angle preserved to within 0.79°), every one ≥ 7.75:1 against black so the loc is black on every fill, the two ordinal ramps strictly monotonic in luminance for greyscale printers, the twelve categorical tints deliberately FLAT at ≈ 0.70 with the `others` neutral alone at 0.58. A separate accessor rather than a flag, so a call site cannot silently be "the screen one on paper". **AN ORDINAL RAMP IS A GRADIENT; A NOMINAL ONE IS A SET OF NAMES.** Price and age bands are ordered, so spreading N bands across seven stops is right. Supplier bands are CATEGORIES — ORNALES is not "more" than PAQUIBOT — so a gradient would invite a reading that does not exist and a positional mapping would MOVE a supplier's colour the moment the reader changed N. The category ramp therefore takes a band's own RANK, with stop 12 a reserved NEUTRAL grey that ONLY `others` wears; the shared legend rows, the ratio bar and the printed sheet accept an explicit `rampStop` so a lens can state its slot while exactly one module still builds the class name. **A ramp is a property of the LENS, not of the frame** — `BlockingLensDefinition.ramp` — because the cost ramp's emerald→rose means cheap→dear on this page and an old block painted red would be read as an expensive one. Stops are chosen by POSITION so both ends are always used (4 bands → `0 · 2 · 4 · 6`). `price-lens-settings.ts`'s `bandRampStop` / `bandRampClass` / `PRICE_LENS_RAMP_STOPS` now delegate here rather than restating it. |
| `lens/lens-shared.ts` | **NEW. The shared lens vocabulary** — `LENS_DEBOUNCE_MS` (250, ONE constant for both lenses), `LENS_EMDASH`, `LensUnit` (`'kg' \| 'blocks'`), and the formatters `formatLensKg` / `formatLensSharePct` / `formatLensDays` / `formatLensWholeDays` / `formatLensBlocks`. **It formats; it does not compute** — `Math.round` for display is the whole of its arithmetic. It exists so two lenses on one page cannot print a kilogram two ways or debounce at two speeds. |
| `lens/lens-settings-popover.tsx` | **NEW (2026-09-21). `LensSettingsPopover` — the gear, and the shell everything that used to BE the sidebar now lives in.** The canonical popover glass (`bg-popover/95 backdrop-blur-lg`), `w-[320px]` (viewport-wide below `lg`), `max-h-[min(70dvh,560px)] overflow-y-auto`, closing on an outside click or Escape (Radix's own dismiss). It owns the SHELL and never a word: every label, figure and dimension is passed in by the lens, the same discipline `lens-customize.tsx` follows. **It floats over the grid ONLY while open**, which is the entire difference from the docked column it replaces. |
| `lens/lens-band-rows.tsx` | **EXTRACTED from the price panel. The band legend, shared by both lenses** — and since 2026-09-21 in TWO shapes: the stacked `LensBandRows` (the Settings popover) and **`LensBandChips`** (the legend bar) plus **`LensExcludedChip`**. The chips are a VARIANT, not a fork: `LensBandChipsProps extends LensBandRowsProps`, the same `aria-pressed` isolate semantics, the same `rampClass` swatch and the same preformatted figures — only the shape differs, and the chip row scrolls (`overflow-x-auto`) rather than wrapping, because a legend that grows a second line pushes the grid down every time a cut line is added. Original note: — `LensBandRows` (one real `<button aria-pressed>` per band, **including an EMPTY one**, swatch from the lens's `ramp`), `LensUnitSwitch` (the `role="group"` kg\|blocks pair) and `LensExcludedRow` (the muted, dashed row for the population that is in NO band: unpriced for Price, undated for Age). Every figure arrives as a preformatted string or as the server's own `sharePct`. |
| `lens/lens-ratio-bar.tsx` | **NEW, EXTRACTED. `LensRatioBar`** — the stacked 12px strip, `role="img"` with an `aria-label` naming every band and its share. **The segment widths ARE the published shares**, written straight into `width`; a NULL or zero share renders nothing rather than a zero-width div. |
| `lens/lens-customize.tsx` | **NEW, EXTRACTED. `LensCustomize`** — the Customize-bands disclosure both lenses put their cut lines behind: the `Collapsible` + its `N/6 cut lines` trigger, the chip row with per-chip removers, an optional **quick-add** row (the age lens's common cuts; Price passes none, so its markup is unchanged), the add box + Add button, the **cap stated as a sentence** rather than a dead button, the per-band rename inputs and the two resets. It owns the SHAPE; every word, number and dimension is passed in by the lens. |
| `lens/lens-refusal-banner.tsx` | **NEW, EXTRACTED. `RefusalBanner`** — the inline, PERSISTENT, copyable refusal (the project's error HARD RULE, satisfied by a banner because a refusal about a panel's own settings would be homeless as a toast the moment the panel closed). Shared so neither lens can quietly lose its Copy button. |
| `../../../dev/table-playground/agelens/` | **NEW, KEPT (not deleted).** `page.tsx` + `agelens-fixture.tsx` — the AGE lens's look rig **and the TWO-LENS rig for the frame**, gated exactly like the `pricelens` sibling (`notFound()` unless `TABLE_PLAYGROUND`, plus `middleware.ts`'s `PUBLIC_PATHS` prefix). It mounts the REAL frame with the REAL `AgeLensPanel` **and** `PriceLensPanel` (each through its adapter port) over static contract-shaped payloads, so the questions Node cannot answer can be looked at with no login: does the age ramp read fresh→old, is a lab-highlighted MC still legible on band 4's purple, do the two tabs feel like one tool, does the docked column still let the grid scroll at 375px. `?bands=2\|3\|4\|5\|7` seeds the cut lines **through the same localStorage key a real reader's settings use**; `?undated=1` adds undated blocks; **`?prices=0` simulates a PRICE-DENIED reader** (the lens list is filtered by each definition's own `canShow`, so the tab strip correctly disappears and Age stands alone). Holds no data access of any kind. |
| `../../../dev/table-playground/lens-fixture-lab.ts` | **NEW (2026-09-22). The THREE price-lens fixtures' warehouse + lab half, in one place.** `FIXTURE_LAB_UNMEASURED`, `fixtureLabStats()`, `fixturePriceBlockByLoc()` and `fixtureWarehouseSubtotals()` — because all three fixtures build a `BlockingPriceLens` **by hand** and the payload gained four per-block keys, a `warehouse_subtotals[]` array and the seven weighted lab means, so three copies is how one of them would start COALESCEing a mean to 0 while the others preserved the null. **The mock cells carry only THREE of the seven readings (`mc`/`ash`/`bdAstm`), so those three are kg-weighted FOR REAL and the other four read `null` with a coverage weight of `0`** — the genuine "no reading in this group" shape, never an invented BD JIS. That mixed coverage is the point: it is the live yard's own shape (all 170 blocks carry MC, 11 read 0 on the other six), so uniform coverage would never exercise the "this column covers less of the band than that one" path. The warehouse comes from `warehouseOfBlockLoc`, never a second prefix parse, and `blockByLoc` is built from the same `bandByBlock` map so the identical-key-set invariant holds in a fixture too. PURE, dev-only. |
| `../../../dev/table-playground/blockinghead/` | **NEW (2026-09-21), KEPT.** `page.tsx` + `blockinghead-fixture.tsx` — the CONTROL STRIP's and the BLEND TABLE's look rig, gated exactly like the `pricelens` / `agelens` siblings (`notFound()` unless `TABLE_PLAYGROUND`, plus `middleware.ts`'s `PUBLIC_PATHS` prefix). It mounts the REAL `BlockingGrid` over a static `BlockingGridData` and the REAL `BlendProposalDialog` over a static facts record, because Node can assert that the strip is a four-track grid with the documented minimums but cannot tell you whether a SECTION MOVES when a mode is switched on, whether the strip scrolls rather than crushes at 1024px, or whether a supplier pill is legible in dark mode. `?prices=0` gives a price-denied reader; `?blend=1` opens the modal with a GREEN, an ORANGE and an em-dash row. Holds no data access of any kind. **ITS FIGURES ARE THE LIVE PAGE'S OWN SHAPE (2026-09-21), because the strip is MEASURED by them** — it occupies **170 of the real 220 slots** (so `77.3%` falls out of the count rather than being typed) and its last block absorbs the rounding residual on both weight and price so the totals land exactly on `10,543.09 t · 170 / 220 · 77.3% · ₱ 389,587,962 · ₱ 36.95`; a rig printing `1,234.00 t` would answer a narrower question than the one being asked, since a 5-digit tonnage and a 9-digit peso total are what set section 3's width. The Proposals badge reads the real `fetchBlendProposalList`, which degrades to an empty list with no session, so it shows `0` rather than a count — its width is reserved (`w-[26px] tabular-nums`), so a single digit either way is the same measurement. |
| `../../../dev/table-playground/pricelens/` | **NEW, KEPT (not deleted).** `page.tsx` + `pricelens-fixture.tsx` — the lens's LOOK RIG, gated exactly like the `rcmprint` sibling (`notFound()` unless `TABLE_PLAYGROUND`, plus `middleware.ts`'s `PUBLIC_PATHS` prefix). It mounts the REAL `BlockingLensPanel` + `PriceLensPanel` (through the adapter port) and the REAL cell classes over a static contract-shaped payload, so the questions Node cannot answer — does the ramp read cheap→expensive, is a lab-highlighted MC still legible on band 3's amber, does the docked column still let the grid scroll at 375px — can be looked at in both themes with no login. `?bands=2|3|4|5|7` seeds the edge offsets **through the same localStorage key a real reader's settings use**; `?unpriced=1` adds unpriced blocks. Holds no data access of any kind. |
| `../_shared/blend-analysis-options.ts` | **NEW (2026-09-21). WHICH ANALYSIS PAGES a proposal carries** — pure. `BlendAnalysisOptions` (`price` · `quality` · `age`), `DEFAULT_BLEND_ANALYSIS_OPTIONS` (**all three ON**), `parseBlendAnalysisOptions` (**untrusted, FIELD BY FIELD, falling back per field** — never "one bad key, everything to defaults"), `serializeBlendAnalysisOptions` (**defaults OMITTED**, so turning everything back on is a REMOVAL), `analysisPages(options, canViewPrices)` — **THE one place the reader's CHOICE meets the reader's PERMISSION** — plus `wantsAnalysis`, `analysisPagesLabel` and `BLEND_ANALYSIS_SETTINGS_MODULE` (`blocking_blend_analysis`). Stored per user in `user_table_settings` through the shape-agnostic pair, so it needs **no migration, no table and no new action**. |
| `../_shared/blend-analysis-text.ts` | **NEW. THE WORDS AND THE FORMATS, shared by the SCREEN and the PRINT** — pure. The screen renders React and the printout builds an HTML string in an iframe, so they cannot share a component; a method note that read one way on screen and another on paper would be two explanations of one statistic. So `naturalMethodNote` (*"Grouped where the prices naturally separate into 3 groups: cut lines at ₱38.97 and ₱44.50 minimise the spread inside each group. Fit 97.6%."*, and the honest degenerate forms), `groupWord` (`low\|mid\|high` → **HIGH / AVERAGE / LOW**, and `ALL ONE GROUP` when there is one), `vsMarketCaption` (**two sentences because there are two rules** — a measured market *rounds up to ₱40*, a TYPED one *is* the line), `vsMarketUnavailableNote`, `unmeasuredNote`, `snapshotGapNote`, `monthName`, and the formatters `fmtKg` / `fmtPeso` / `fmtPesoNum` / `fmtWholePeso` / `fmtSharePct` / `fmtDays` / `fmtWholeDays` / `fmtQuality` / `qualityDecimals` (BD → 3, MC and ASH → 2) live here, once. **It formats and labels; it does not compute** — `toFixed` and `Math.round` plus the single `gvf * 100` unit conversion are the whole of its arithmetic. |
| `../_shared/use-blend-analysis.ts` | **NEW. THE ANALYSIS READ** — one payload per open / version switch / option change, and nothing else. Takes a DISCRIMINATED source (`{kind:'saved', proposalId, versionNo}` or `{kind:'live', blockLocs}`) so it is structurally incapable of sending both (the contract refuses that). **NO DEBOUNCE AT ALL** — its inputs are discrete events, not keystrokes, so a debounce would only be a timer for a remount to destroy (the 2026-09-21 lens stall) — and the guard is the request's own **SIGNATURE**, so a reply for what is still wanted is ALWAYS applied. A stall says so after `LENS_STALL_MS` with Copy and Retry; a refusal KEEPS the previous payload. Exports the `BlendAnalysisAdapter` port, defaulted to the live action and injectable only for the gated dev rig. |
| `../_shared/blend-analysis-sections.tsx` | **NEW. THE ANALYSIS PAGES ON SCREEN** — `BlendAnalysisSections` (the stack) and `BlendAnalysisIncludePopover` (the header's **Include pages** control). Three pages: **Price groups — natural breaks** (a plain-language method note, then HIGH → AVERAGE → LOW, each group a dense table with a SUBTOTAL row and one grand FOOTER from the payload's `overall`, which is what makes it visibly equal the proposal's own raw blend price) plus **Against market** (the PRICE LENS's bands, labelled with the lens's OWN `priceBandLabel` and the reader's own band names, dearest first); **Quality** (three tables — MC, ASH, and BD ASTM **with BD JIS as a second value column**, not a fourth table — highest reading first, with the reader's own WET / ASHY highlight applied through `getLabHighlightText`); **Age** (the AGE LENS's bands via `ageBandLabel`, oldest first, block · batch · balance · age · first delivery · last delivery). Excel Standard throughout: `table-fixed`, explicit pixel widths whose STATED sum is the table's `minWidth`, `font-mono` right-aligned numerics, accounting ₱. **Every subtotal and footer figure is the payload's own** — there is no `reduce`, no `+=` and no division by a total in the file; the one piece of money arithmetic is a per-ROW `kg × ₱/kg`, which contributes to no total. An unmeasured / undated block is listed in a MUTED group with an em dash, **never in the cheapest, cleanest or freshest group**. |
| `../_shared/blend-analysis-print.ts` | **NEW. THE ANALYSIS PAGES ON PAPER** — `buildBlendAnalysisPages(input)` returns one `<section class="apage">` per chosen page and `BLEND_ANALYSIS_PRINT_CSS` carries their rules; both are appended to the existing self-contained iframe document by `buildBlendPrintDocument`'s new fifth argument. **An empty analysis leaves that document byte-identical, including its `<style>` block.** Print-specific rules the screen does not need: **no `<tfoot>`** (Chrome repeats one on every page, so a subtotal and the grand total are `<tbody>` rows), **a group is its own `<tbody>`** with `break-inside: avoid` only while it is SMALL (≤ 4 rows — forcing a 24-row group whole would push a page of white space ahead of it), `break-after: avoid` on every heading and caption, a **7pt font floor** with the padding squeezed first, and the group tints written as inline `rgb(r g b / 0.18)` from `lens/lens-ramp.ts` because **an iframe has no `globals.css`, so a `.lens-band-3` class would print white**. |
| `../_shared/blend-yard-map-print.ts` | **NEW (2026-09-23). THE BLEND PRINT'S YARD MAP** — pure, no React. `BLEND_PRINT_MARGIN_MM` (the blend document's ONE margin, read by its `@page` rule AND by the map's fit), `buildBlendYardMapModel` (the normalized `BlendYardMapModel` BOTH print paths consume — cells, bands, caption, `goneLocs`, `byPriceGroup`), `blendYardMapStops` / `blendYardMapLegend` / `blendYardMapFit`, `BLEND_YARD_MAP_PRINT_CSS` and `buildBlendYardMapPage` (the `<section class="ymap">` HTML). **IT IS THE LENS MAP, NOT A PORT OF IT** — the geometry, the one-page fit (`solveYardMapFit`), the PRINT palette (`printFillRgbAtStop`), the ink rule (`lensYardMapInkOn`) and the four cell kinds (`lensYardMapPaint`) are all imported from `lens/lens-yard-map-model.ts`; a literal `220`/`238` appears nowhere and `WAREHOUSES` is never restated. It adds exactly two decisions — which band a selected block is in, and that a selected block the yard no longer holds is still drawn. **No ₱, no kilogram, no lab reading**, so its Include-pages checkbox is the one that is NOT price-gated. |
| `lens/lens-summary-print.tsx` | **THE PRINTED LENS SUMMARY, REDESIGNED 2026-09-22** — `LensSummaryPrintControl` (the legend bar's **Print** button) + the sheet, over a normalized `LensSummaryPrintModel` each lens builds for itself. The owner's four asks, in his order: the TITLE is **exactly the lens's name** (`Price lens` / `Age lens` / `Supplier lens`) with **no blurb and no subheading**; **ONE terse settings line** under it in the `<fact> · <fact>` style (`Set price ₱46 · ₱46 and up is above set price · cuts −1 · market · by kilograms · printed 2026-09-22 09:04`), the stamp appended by the sheet; the **BAND TABLE** (band · blocks · kg · share · the lens's weighted figure, total as the last `<tbody>` row, its figure cell saying **`avg of priced`** / `avg of dated`) and the **RATIO BAR** kept unchanged, because they are the part he said worked (**the band table's last column grew TWO optional fields later the same day — `bandFigureColumnLabel` and a per-figure `LensPrintAccounting {symbol, amount}` — so the SUPPLIER sheet can head it `₱/kg` in the accounting layout, or `Mixed` for a price-denied reader, while the price and age sheets, which supply neither, stay byte-for-byte what they were**); and the three-column block lists **replaced by ONE FULL-WIDTH TABLE PER BAND, GROUPED BY WAREHOUSE** — `BLOCK · BATCH · BALANCE kg · MC · ASH · BD ASTM · BD JIS · GRIT · VM · FC · <figure>` — with **each band on its own page** (`.lens-print-band { break-before: page }`), a warehouse group per `<tbody>` (`break-inside: avoid` while small, its heading row `break-after: avoid`), a WAREHOUSE SUBTOTAL carrying blocks + kg, and a BAND TOTAL from the payload. **SECOND PASS 2026-09-22 — three PRICE-SHEET-ONLY additions, each behind an OPTIONAL model field so the age and supplier sheets are provably unchanged:** `warehousePages` puts each `WHSE X` on its OWN SHEET under a repeated band running line (the first warehouse rides the band's own break; the BAND TOTAL rides the LAST warehouse's page; `showWarehouseHeadingRow={false}` stops the heading printing twice); `figures` / `totalFigures` fill the subtotal's and the band total's seven lab cells and ₱/kg from `warehouseSubtotals` — a **LOOKUP**, never a computation, NULL an em dash and never a 0, with a coverage note naming only the stats short of the group; and `blockSupplierColumnLabel` adds a SUPPLIER column between BATCH and BALANCE (`Ornales` / `Paquibot 63%` / an em dash), on a SEPARATE width table that sums to exactly 100%. `page1Extra` is a NODE carrying page one's context block, so this sheet still knows nothing about a market series. Spanning several sheets is the deliberate trade for the lab panel. **Band ISOLATION is respected and SAID** (*"Showing 2 of 4 bands"*). **PAGE TWO is the YARD MAP** (2026-09-22, `lens/lens-yard-map-print.tsx`) — every block location in solid band colour, loc centred and big; it exports `LENS_PRINT_MARGIN_MM` so the map's fit arithmetic and the `@page` rule cannot disagree. It reuses the PLATFORM print kit (`GroupPrintStage` + `printCard` + `buildPrintPageRules`, stage PORTALLED to `<body>`) and adds nothing to it; the sheet is explicitly LIGHT (`bg-white` / `text-zinc-*`) because it lays out in the live DOM, with two deliberate exceptions — the swatch and the bar segments use `lens-band-swatch` + the ramp class, whose solid `rgb(var(--lens-hue))` is identical in both themes and identical to the grid. **It formats nothing**: every figure arrives preformatted. |
| `lens/lens-yard-map-model.ts` | **NEW (2026-09-22). THE YARD MAP's CELLS — pure, no React.** `buildLensYardMap({ data, bandOf, isMixed? })` turns the grid's OWN geometry (`../constants`'s `WAREHOUSES`, plus `blocking-grid.tsx`'s `<whse>-<col><row>` slot key — **never a literal 220/238**) into one `LensYardMapCell` per SLOT: `{ loc, lines, occupied, band, mixed }`. Also `lensYardMapPaint(cell, ramp, stopByVisibleBand)` (the FOUR cell kinds — `banded` / `muted` / `nodata` / `empty`; a `banded` fill is `printFillRgbAtStop`, **never** the screen ramp), **`lensYardMapInkOn(rgb)` — the ONE luminance rule, which on the print palette now answers near-black for every fill and whose white branch is therefore unreachable on the map** (kept rather than hardcoded, because a cell, a legend swatch border and a mixed block's dash must all reach the same answer) — `lensYardMapLuminance`, `lensYardMapLines(key, loc, force?)` and the paper palette + `LENS_YARD_MAP_MIN_LOC_PT` / `_LINE_HEIGHT` / `_NODATA_PT` / `_INK_CROSSOVER`. It counts SLOTS and nothing else: no kilogram, no ₱, no age, no supplier, no lab reading. **SHARED WITH THE BLEND PROPOSAL PRINT since 2026-09-23** — the core `buildYardMapCells` (which `buildLensYardMap` is now a two-line wrapper over), the page geometry constants and the two-stage solve `solveYardMapFit` moved HERE from `lens-yard-map-print.tsx` so the blend's non-React print paths can read them; the lens page's own output is unchanged by construction, because none of the inputs moved. |
| `lens/lens-yard-map-print.tsx` | **NEW (2026-09-22). THE YARD MAP PAGE** — `LensYardMapPage`, page TWO of the lens print. Every warehouse as a labelled block of square cells (column numbers along the top, row letters down the side, both small and muted), each occupied slot in the **SOLID** band fill from **`LENS_PRINT_FILL_RGB`** (the PRINT palette — a pale tint of the screen hue, so the loc is BLACK on every cell; the legend swatches read the same accessor, or the legend would describe a different map) with the BLOCK LOC centred in the largest font the cell allows. Solves its one-page promise with the PLATFORM `fitCellGrid` / `fitMonoLabelPt` (`components/shared/print/print-fit.ts`) against `a4LandscapeBox(LENS_PRINT_MARGIN_MM)` — the sheet's own margin, exported so the `@page` rule and the arithmetic cannot disagree. Carries a one-line legend (every shown band, `other bands (not shown)` when isolated, `— no data (N)`, `empty slot`) and NAMES any occupied block whose code is not a slot on this layout. |
| `lens/lens-print-chart.tsx` | **NEW (2026-09-22). A CHART FOR PAPER** — `PrintSeriesChart` (one shape, two uses: a bare LINE for the market series, an AREA-plus-LINE for a price-vs-volume panel), `PrintChartLegend`, the explicit `PRINT_CHART_INK` palette and `LENS_PRINT_CHART_LABEL_PX`. **Hand-drawn SVG rather than recharts, and that is a defect list not a preference:** `/analytics`' charts are `<ResponsiveContainer>` and size themselves from a ResizeObserver callback one frame LATER, so they print an EMPTY BOX under `printCard` (which calls `window.print()` as soon as the stage lays out); their series are theme tokens (`var(--chart-2)`), so a dark-mode reader would print a dark chart onto white paper; and importing them would put recharts in the Blocking bundle for a twelve-point print-only series. **Nothing in `app/(app)/analytics/` was moved or shared — that CONTEXT.md is untouched.** It computes no statistic (scaling a value to a y coordinate is geometry) and formats nothing: every label is a string the model already built, and the file contains no `₱` and no `toLocaleString`. **A `null` BREAKS the line and the area** rather than drawing across it — NULL is never 0. Size is stated by the caller in PIXELS; ink is explicit hex with `print-color-adjust: exact`; **every label reads ONE constant (7 px)**, after the first pass shipped 5.5 px month ticks (~4 pt on paper). |
| `lens/lens-market-model.ts` | **NEW (2026-09-22). BOTH page-one context blocks, as PRINTABLE MODELS** — `buildLensMarketPrintModel()` (the price sheet's MARKET table + chart) and `buildLensSupplierMarketPrintModel()` (the supplier sheet's PRICE vs VOLUME panels + table), plus `printChartDomain()`. **NOT ONE NUMBER IS DERIVED HERE**: every price, kilogram, share, change, direction, correlation and premium is a field of `BlockingMarketContext` / `BlockingSupplierMarket`, rendered verbatim — those functions aggregate as Σ money ÷ Σ priced kg inside `view_analytics_rcin_monthly` / `view_analytics_supplier_monthly`, and a TypeScript copy would be a second definition. What it DOES do is FORMAT (it owns every `₱`, so the two sheets spell none) and work out a CHART DOMAIN, which is an axis range and not a statistic. **`printChartDomain` takes a `floor`** — measured on a real PDF, the 8% pad pushed a VOLUME axis below zero and every panel printed `−41t`; it is a floor, **not** a zero-base, so a price axis still starts near its own minimum. NULL IS NEVER 0 in six places, including `direction` (NULL, never the word *flat*) and `priceVolumeCorr` (`n/a (2 m)` under three priced months). PURE. |
| `lens/lens-market-print.tsx` | **NEW (2026-09-22). PAGE ONE's `MARKET` SECTION** (price lens) — the 12-month table (`MONTH · PHP/KG · KG · DLV · SUPP`), its quarter rollups with the current one flagged, `YEAR TO DATE` and `TRAILING 12 M`, and a line chart of the same twelve months with **the lens's own basis as a dashed reference level**. Table LEFT, chart RIGHT — measured: stacking them pushes a seven-band lens's page one onto a second sheet. **The BASIS's own row is highlighted**, and an aggregate basis (`last_3_months`, `trailing_days`, a typed price) highlights NOTHING, because this table carries no row for it. It formats nothing and spells no `₱`. |
| `lens/lens-supplier-market-print.tsx` | **NEW (2026-09-22). PAGE ONE's `PRICE VS VOLUME` SECTION** (supplier lens) — up to six SMALL MULTIPLES (kilograms as an area, ₱/kg as a line, over the window's own month spine so a quiet supplier gets a GAP) and a table of every supplier the payload returned (`SUPPLIER · KG · PHP/KG WTD · FIRST → LAST · CHANGE · DIR · VOL % · CORR · PREM`) with a footer putting `selectedTotal` beside `windowTotal`. **Each panel autoscales and the caption SAYS so** — the yard's suppliers differ by two orders of magnitude, so a shared volume axis would flatten every small one onto the baseline. **`others` has no panel and no row** (it is a fold, not a supplier; aggregating it here would be a TypeScript average of weighted prices), and a named band with no series is NAMED rather than dropped. **The WHOLE section is absent for a price-denied reader** — it is money end to end including the correlation. It formats nothing and spells no `₱`. |
| `lens/lens-summary-model.ts` | **NEW (2026-09-22). THE ONE BUCKETING behind the printed sheet** — `buildLensSummaryBuckets({ data, bandOf, figureOf, sortKeyOf, formatKg, formatBlocks, excludedFigure })` → `{ byBand: Map<band, LensSummaryWarehouse[]>, excludedRows }`, plus `LENS_SUMMARY_LAB_KEYS` / `_LABELS`, `lensSummaryLab(block)` (**the Excel Standard applied once — BD 3 dp, everything else 2 dp**) and `warehouseOfBlockLoc`. All three lenses call it, because three copies is how the price sheet and the age sheet would order warehouses two different ways. The warehouse order is `Object.keys(WAREHOUSES)` — the grid's own layout, never a second list — with a trailing `-` / `Other` group so a `block_loc` whose prefix is not a warehouse is still counted. **⚠️ IT HOLDS THE ONE SUM IN THE WHOLE LENS DIRECTORY**, the warehouse kilogram subtotal, and it is deliberately ABSENT from `verify-blocking-lens-ui.ts`'s no-sum list: the payload publishes no figure for "band 2's kilograms in warehouse C" at any grain, so that sum has nothing it could disagree with, and the fold is proven to tie back to the band's own published kilograms. **What is still absolutely forbidden and is NOT done: a weighted average.** It gained `buildLensGroupFigures(stats, groupKg, figure, formatKg)` on 2026-09-22 — which RENDERS the seven kg-weighted means `fn_blocking_price_lens` now publishes per (band × warehouse) and per band, and whose only arithmetic is the COMPARISON deciding whether a stat's coverage is short of the group. **The rule did not move: this module may format a figure, it still may not compute one**, and a lens with no such published partition passes no `figuresOf` and prints the blank subtotal row it always did. It also takes an optional `supplierOf` for the price sheet's per-block SUPPLIER cell — omitted, the field is `undefined` and the column does not exist. |
| `lens/supplier-lens-panel.tsx` | **NEW (2026-09-22). The SUPPLIER lens body + its `SUPPLIER_LENS` registration** — lens #3 on the frame, registered AFTER Age. Legend bar: the headline `17 suppliers · 23 mixed`, one shared chip per band (supplier display names, plus `Others (11)`), the shared ratio bar, the muted `No supplier — N` chip, Print, the kg\|blocks switch and the gear. Settings popover: the yard's supplier count and mixed-block count, ONE line saying which figure the tint uses and which the bar uses, the detailed band rows (`N blocks dominant · X kg apportioned · M mixed`), and a **Top suppliers** number input (1…12, default 6) with Apply and Reset. **`canShow: () => true`** — no ₱ anywhere in the payload, so Production sees it. **IT COMPUTES NO STATISTIC**: no `reduce`, no `+=`, no division by a total, and it never `===`-tests the apportioned fold (the contract records a −1.9e-9 kg residue through JSON). Exports **`SupplierLensAdapter`**, the one-method port onto `fetchBlockingSupplierLens`, defaulted to the live action and injectable only for the gated dev fixture. |
| `lens/supplier-lens-settings.ts` | **NEW (2026-09-22). Pure settings arithmetic** — `SupplierLensSettings` (**`topN` + `unit`, and nothing else**), `DEFAULT_SUPPLIER_LENS_SETTINGS` (`{ topN: 6, unit: 'kg' }`), `parseSupplierLensSettings` (**untrusted, FIELD BY FIELD** — an out-of-range, fractional or non-finite `topN` falls back rather than being clamped, because a clamp silently answers a question nobody asked), `serializeSupplierLensSettings` (**defaults OMITTED**), `normalizeTopN` / `setTopN` / `parseTopNInput` (both ends refused with a sentence, never a throw), `supplierBandLabel` (**the supplier's own `display`; `Others (11)` is the UI's word — the payload carries `key: null` / `display: null` on the fold and does not name it**), `supplierBandRampStop` / `supplierBandRampClass`, `SUPPLIER_LENS_RAMP` (`'category'`) and `SUPPLIER_LENS_MIXED_CLASS`. **THERE ARE NO BAND NAMES, and that is deliberate**: a supplier band already has a name, and renaming it would let the legend disagree with the yard about whose charcoal it is. |
| `../../../dev/table-playground/blendanalysis/` | **NEW (2026-09-21), KEPT.** `page.tsx` + `blendanalysis-fixture.tsx` — the ANALYSIS PAGES' look rig, gated exactly like its siblings (`notFound()` unless `TABLE_PLAYGROUND`, plus `middleware.ts`'s `PUBLIC_PATHS` prefix). It mounts the REAL `BlendProposalDialog` — real header actions, real Include-pages popover, real print, real PDF — and swaps only the two data PORTS for static contract-shaped payloads over the owner's own `26 OCT RUN V2` shape (24 blocks, two price clumps, market ₱39.8272 → R 40). **Its adapter answers after a REALISTIC ~300 ms on purpose**: a microtask-resolving stub hid a request race on the lens panels, and a skeleton that never renders cannot be reviewed. `?saved=1` · `?prices=0` (the price-denied reader) · `?pages=quality` (seeded **through the same localStorage key** a real reader's choice uses) · `?unmeasured=1` · `?slow=2000` · `?stall=1` (the watchdog banner). Holds no data access of any kind. |
| `CONTEXT.md` | This file |

## Data

**Primary data source:** `view_blocking_grid` SQL view on Supabase — one row per active batch (STORED/IN-USE) with `block_loc`, `balance`, `total_in`, and all 7 weighted-average lab results (`mc`, `ash`, `bd_astm`, `bd_jis`, `grit`, `vm`, `fc`) pre-computed in SQL.

> **`balance` is self-correcting (migration `20260531041520_fix_blocking_view_balance_from_transactions`).** It is computed directly from the transaction tables as `SUM(deliveries.weight_kg) − SUM(rc_out.weight_kg)`, NOT sourced from the `batches.current_weight` cache. This means the grid shows the true balance even if `current_weight` ever drifts (e.g. an ingestion path double-counts it). The rc_out total is pulled via a correlated subquery (evaluated once per batch, outside the GROUP BY) so the per-delivery `LEFT JOIN` fan-out does not multiply it. `balance` therefore always equals the row's own `total_in` minus realized usage. Background: AUDIT_FINDINGS AF-001 / LEARNING_LEDGER L-005 (a 2026-05-27 deliveries-manager run had imperatively added `current_weight += weight` on top of the trigger's own increment, rendering ~54 t phantom inventory).

**Supplier search source:** **`view_blocking_block_suppliers`** (migration `20260902145145_blocking_block_suppliers.sql`) — one row per `(block_loc, batch_id, supplier_key)` over exactly the blocks `view_blocking_grid` shows, with `supplier_display`, `kg`, `delivery_count`, `share_pct` (0–100), `supplier_count_in_block` and `block_total_in_kg`. It SELECTs FROM `view_blocking_grid` rather than re-deriving the "which batch occupies which slot" rule (the grid resolves it with `DISTINCT ON (location_ref)`), and joins `deliveries` on `batch_code` — the same join and grain the grid's own `total_in` is summed over.

> **Supplier identity is `public.canonical_supplier()`, the ONE definition — never a TS port.** The argument is the P3 origin-stripped form `canonical_supplier(split_part(supplier, ' - ', 1))` so a sundry re-entry booked as `Layupan - JAN-26-BLK9` attributes to LAYUPAN instead of inventing a phantom supplier; a key that still resolves to nothing groups under the literal `UNKNOWN`. **Measured on this view's own population (2026-09-02): 0 of 600 joined delivery rows carry a `' - '` suffix at all and 0 rows change under the strip — a no-op here today, and 0 blocks land in `UNKNOWN`.**
>
> **The ALL/SOME rule lives in the view:** `supplier_count_in_block = 1` → the whole block is one supplier (GREEN), `> 1` → mixed (ORANGE). It is a COLUMN precisely so no caller re-derives it.
>
> **NO ₱ column and none derivable** (asserted: 0 of 10 columns match `php|peso|cost|price|value|amount`), so the supplier search is safe for every role including Production and needs no `canViewPrices()` gate. Posture matches the analytics views: `security_invoker`, `SELECT` to `authenticated` only, `anon` revoked, **no `service_role` grant** (the sync worker does not read it — L-044's arrow direction: a consumer is not a dependency). Verified by actually reading as `authenticated` (succeeds) and as `anon` (denied).
>
> **Proofs (measured 2026-09-02 against the live view):** **202 rows / 170 occupied blocks / 17 distinct suppliers** — far under PostgREST's 1000-row cap (ceiling is 238 blocks × suppliers). Σ `kg` per block = `view_blocking_grid.total_in` on **170 of 170 blocks, max gap 0.00 kg**, and `block_total_in_kg` matches on all 170. Σ `share_pct` per block = 100 with **max deviation 1.0e-16** (3 blocks off by that last numeric digit). `supplier_count_in_block` = `COUNT(*) OVER (PARTITION BY block_loc)` on **all 202 rows, 0 mismatches**. **148 blocks are single-supplier, 22 are mixed**, the most crowded holding 4 suppliers. Reach: ORNALES 76 blocks, PAQUIBOT 61, MERCADO 12, "2023 BACKLOG" 11, LLANTO 9, LAYUPAN 7, SEVILLA 5, then 10 suppliers in 1–4 blocks each.

**Data loading pattern:**
- Grid data fetched via `fetchBlockingGridData()` server action in `blocking-route-view.tsx` (the standalone-route host — Blocking is `/inventory/blocking`, not a tab; the fetch/loading/error/Retry logic was repurposed from the deleted `blocking-lazy-tab.tsx`)
- Detail data (deliveries + usage + notes + avg_cost) fetched on-demand per cell click via `fetchBlockingDetail(batchCode, batchId)`
- PHP/KG is role-gated: Production role users receive `null` for cost data
- Supplier-search data fetched via `fetchBlockingSupplierMap()` (one read of `view_blocking_block_suppliers`), **in parallel with the grid fetch** in `blocking-route-view.tsx` and passed to `BlockingGrid` as `supplierMap`

> **Weight-deduction / true-weight passthrough (display-only — see `DEDUCTIONS_DESIGN.md`).** As of 2026-06-25, `fetchBlockingDetail` and `fetchSingleDelivery` ALSO `SELECT true_weight_kg, deduction_note` from `deliveries` and pass them straight through onto `DeliveryHistoryRecord` / `FullDeliveryRecord` (mapped `?? null`). This is purely additive plumbing — **NOT gated at the action layer** (the two columns are not prices). They drive the **true-weight popover** on the detail panel's delivery-history rows: a tagged row (`true_weight_kg != null`) shows a small `Σ` marker that opens the shared `_shared/true-weight-popover.tsx`. The popover's effective-₱/kg line is the ONLY price-derived value and is gated downstream by the panel's existing `canViewPrices`; the true-weight + note lines are never gated. No balance/aggregate uses these columns.

**Warehouse layout:**

| WHSE | Columns | Rows | Total Slots | Notes |
|------|---------|------|-------------|-------|
| A | 1-20 | A-C | 60 | Standard |
| B | 1-20 | A-B | 40 | Standard |
| C | 1-20 | A-B | 40 | Standard |
| D | 1-20 | A-D | 80 | Standard |
| **Standard total** | | | **220** | Operator's baseline mental model |
| PCA | 15-17 | A-C | 9 | Prepared Charcoal sundrying — physical subdivision of A-15/16/17. Opt-in via filter chip |
| PCB | 15-17 | A-C | 9 | Prepared Charcoal sundrying — physical subdivision of A-15/16/17. Opt-in via filter chip |
| **PC total** | | | **18** | Not counted in the 220 baseline |
| **Grand total** | | | **238** | When PCA + PCB chips are both active |

**"PC" = Prepared Charcoal.** PCA and PCB are physical subdivisions of the A-15/16/17 floor area used for prepared-charcoal sundrying. They are not counted against the 220-slot baseline by default — the operator's existing 220-slot mental model is preserved. PCA/PCB are surfaced via dedicated filter chips next to the WHSE chips (with a thin divider separating them).

> **Future polish (not yet implemented):** Today PCA/PCB are strictly opt-in via the filter chips, so when occupied they will not appear in the default ALL view. Consider an auto-show-when-occupied behavior in a later iteration — if any PCA/PCB cell has a batch, automatically include that warehouse in the default active set on initial render. For now, the operator clicks the PCA or PCB chip to surface those zones.

**Block LOC format:** `{WHSE}-{COL}{ROW}` (e.g., `A-1A`, `C-15A`, `D-20D`, `PCA-15A`, `PCB-17C`). The regex `^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$` is shared between client-side `validateBlockLoc()` in `lib/validation.ts` and DB CHECK constraints.

**Balance text color thresholds (percent of `balance / total_in` — % remaining of total delivered):**
- >= 50%: `text-emerald-400` (green)
- 20-50%: `text-white` (neutral)
- 10-20%: `text-amber-400` (amber)
- < 10%: `text-red-400` (red) + `.balance-critical` pulse animation

**Card backgrounds:** All occupied cells use a single neutral zinc gradient (`.blocking-cell-occupied`) instead of colored heatmap fills. Balance-percentage is communicated via the weight value's font color.

**Lab highlight text colors:** MC, ASH, and BD (`bd_astm`) values on each card use the user's lab highlight settings from `useTableSettings()`. When a value exceeds the configured limit, its font color changes to the highlight color (via `getLabHighlightText()` from `types/table-settings.ts`). Default: white/95 when within limits. BD renders at 3 decimals (vs MC/ASH at 2) and is NOT price-gated.

**BlockData fields:**
- `batch_code`, `batch_id`, `status` (`BlockStatus` — the 4 grid-styled statuses 'STORED' | 'IN-USE' | 'SUNDRYING' | 'SUNDRIED', widened to also accept any string so the RC Movement panel can show a historical CLOSED/FEED batch; the grid narrows it back to `CellStatus` via a safe cast since `view_blocking_grid` only emits the 4), `balance`, `total_in`, `php`
- Lab results: `mc`, `ash`, `bd_astm`, `bd_jis`, `grit`, `vm`, `fc`

### Blend Proposal HISTORY — DATA LAYER (2026-09-02, migration `20260902160452_blend_proposal_history`)

> **SHIPPED END TO END (UI landed 2026-09-03).** The tables, RPCs, views, server actions and
> types below are LIVE and the Blocking page now uses all of them — see **Blend Proposal
> HISTORY — UI** immediately after this section. Plan:
> `.agents/plans/blend-proposal-history-plan.md` (status BUILT).

**THE ONE FACT THAT SHAPES IT.** A proposal is a statement about the yard *on a particular day*.
Balances fall as charcoal is fed, a `block_loc` is reused when a batch empties, lab averages move
as deliveries land. So a version stores **BOTH**: `blocks` (the block list keyed by **`batch_id`** —
the modifiable half, and the identity a later Modify resolves against) and `snapshot` (what the
DATABASE computed at save time — the immutable half, what was actually proposed).

**Tables**
- **`public.blend_proposals`** — the mutable header: `id`, `title` (NOT NULL, non-blank CHECK),
  **`notes` (THE REMARK — Renzo's explicit requirement: every proposal carries a title AND a
  remark; optional in value, first-class in the model, present in both read models and editable
  through the header patch)**, `status` (`draft | planned | fed`), `fed_on`,
  `current_version_no` (the compare-and-set token for APPENDING), `row_version` (the
  compare-and-set token for HEADER edits, bumped by `tr_blend_proposals_touch` →
  `fn_touch_blend_proposal`), soft `archived_at`/`archived_by`, `created_at`/`created_by`
  (**no `ON DELETE` clause** — a profile that authored a plan cannot be deleted out from under
  it), `updated_at`/`updated_by`. A CHECK ties `status = 'fed'` **if and only if** `fed_on IS NOT
  NULL`, so the label and the date can never disagree.
- **`public.blend_proposal_versions`** — history, APPEND-ONLY **EXCEPT via
  `fn_overwrite_blend_proposal_version`, which archives the replaced contents first** (2026-09-25 —
  see **Blend Proposal VERSION OVERWRITE** below): `proposal_id` (FK **ON DELETE
  RESTRICT**), `version_no` (UNIQUE with `proposal_id`), `blocks`, `snapshot`, `snapshot_hash`,
  `change_note`, `parent_version_no`, `created_at`/`created_by`, plus `revision_no` /
  `revised_at` / `revised_by`. **TWO INDEPENDENT LOCKS** (the
  `sync_finding_acks` idiom): no UPDATE/DELETE privilege for any client role, **and** RLS with
  SELECT + INSERT policies and **no update or delete policy at all** — so a future blanket
  `GRANT … ON ALL TABLES IN SCHEMA public` still cannot rewrite history. The INSERT policy is
  `WITH CHECK (created_by = auth.uid())`, so authorship is verified by the database.
- **No hard delete anywhere** — no delete RPC, no DELETE grant, no DELETE policy on either table.
  Archive/restore is the only removal, and the pair ships together because a soft delete you
  cannot undo is not reversibility.
- `service_role` holds **nothing** on either table (the sync worker neither reads nor writes them).

**The snapshot is computed in SQL, never accepted from a client.** `fn_blend_proposal_snapshot`
builds it from `view_blocking_grid` + `fn_blend_proposal()`, lifting every weighted average
**verbatim** so a saved version can never disagree with the live modal. Its shape is exactly the
TypeScript `BlendProposal` interface plus `blocks[].batch_id` and `computed_at`;
`can_view_prices` is deliberately NOT stored (it is a fact about the READER, set per call by the
action). **`fn_blend_production_loss_pct()` now owns the ×1.30 markup** — the constant moved out
of TypeScript because the stored product cost has to be the number the operator saw;
`buildBlendProposal` reads it back in the same `Promise.all` as its other two queries, so there
is ONE definition and no added latency.

**`snapshot_hash` — the idempotency key, and it CANNOT contain a ₱.** `fn_blend_snapshot_hash`
builds a canonical object by **explicit allowlist**, so `php_kg`, `raw_price_per_kg` and
`product_cost_per_kg` are structurally absent rather than filtered out (a runtime guard on the
KEY NAMES — never on the data, so a batch code can't trip it — raises if a money key ever gets
added). Numbers round to 6 dp so an upstream scale change can't masquerade as a changed blend,
and `computed_at` is excluded so the clock alone never invents a version. **Stated consequence:
a change to PRICE ALONE writes no new version** — a version is identified by which blocks were
proposed and what physical/lab state they were in, not by what they cost.

**RPCs** (all SECURITY INVOKER, `SET search_path = public`, EXECUTE revoked from `PUBLIC` + `anon`,
granted to `authenticated` — the audience is every signed-in user, the same as building a proposal
today; ₱ is gated by `canViewPrices()` at the action, not by role here). **A business refusal is
returned as jsonb `{ok:false, reason, message}` written for a human — never a raise.**
- **`fn_save_blend_proposal(p_title, p_block_locs, p_proposal_id, p_expected_version_no, p_change_note, p_notes)`**
  — creates header + v1, or appends `current_version_no + 1` **with the guard inside the UPDATE's
  own WHERE** (never read-then-write). Refuses a blank title, an empty block list, a `block_loc`
  not on the grid (**naming it**), an archived proposal, and a stale or missing version token.
  An identical re-save returns `unchanged:true` and writes no row. `title` and a non-null `notes`
  ride along on an append so a "Save as v4" that also fixed a typo doesn't silently drop the rename.
- **`fn_update_blend_proposal_header(p_id, p_expected_row_version, p_patch)`** — allowlist
  `title, status, fed_on, notes`; a key outside it refuses the WHOLE call; compare-and-set on
  `row_version` in the same statement; `fed` requires `fed_on`, any other status clears it.
- **`fn_archive_blend_proposal(p_id, p_expected_row_version)` / `fn_restore_blend_proposal(...)`**
  — soft only; archiving something already archived is a no-op, not an error.

**Views** (`security_invoker`, `authenticated` SELECT only, `anon` REVOKEd, **no `service_role`**)
- **`view_blend_proposal_list`** — one row per proposal (archived included; filter `is_archived`),
  joined to its CURRENT version: `title`, **`notes`**, `status`, `fed_on`, `current_version_no`,
  `row_version`, `version_count`, `block_count`, `total_balance_kg`, `w_mc`/`w_ash`/`w_bd_astm`,
  the current version's change note + timestamps, and both author names.
- **`view_blend_proposal_versions`** — one row per version (the rail): `is_current`, block count,
  balance, **all seven** weighted lab stats, `change_note`, `parent_version_no`, `snapshot_hash`,
  author.
- **NEITHER VIEW CARRIES A ₱ COLUMN and none is derivable** (asserted: 0 columns match
  `php|price|cost|peso|amount`), so the proposals list and the version rail are safe for every
  role including Production. Prices live only inside a version's `snapshot`.

**Server actions** (in `actions.ts`) — `saveBlendProposal({proposalId?, title, notes?, blockLocs,
expectedVersionNo?, changeNote?})`, `updateBlendProposalHeader(id, expectedRowVersion, patch)`,
`archiveBlendProposal(id, expectedRowVersion?)`, `restoreBlendProposal(id, expectedRowVersion?)`,
`fetchBlendProposalList({includeArchived})`, `fetchBlendProposalVersions(proposalId)`,
`fetchBlendProposalVersion(proposalId, versionNo)`. The read actions degrade to `[]` and log on
failure (the `fetchBlockingSupplierMap` posture); the writers return `{ok:false, message}` shapes
meant for `errorToast()` and never throw for a business refusal.
**`fetchBlendProposalVersion` is the ONE price-bearing read in the feature**: it nulls
`raw_price_per_kg`, `product_cost_per_kg` and **every** `blocks[].php_kg` and sets
`can_view_prices:false` BEFORE the payload leaves the server when `!canViewPrices()` — exactly
what `buildBlendProposal` already does, so the existing dialog renders a saved version with zero
new gating code.

**Types** (in `types.ts`) — `BlendProposalStatus`, `BlendProposalSummary`,
`BlendProposalVersionSummary`, **`SavedBlendProposal`** (= `BlendProposal & { proposal_id,
version_no, title, notes, change_note, created_at, created_by_name, computed_at }`), plus the
result unions `BlendProposalSaveResult`, `BlendProposalWriteResult`, `BlendProposalVersionResult`.
`BlendProposalBlock` gained an **optional** `batch_id?: string | null` — present only on a saved
version, so the live what-if's JSON is unchanged.

**Proofs (measured 2026-09-02 against the live database).** As `authenticated`: UPDATE and DELETE
on `blend_proposal_versions` and DELETE on `blend_proposals` all raise **SQLSTATE 42501**
"permission denied"; an INSERT claiming another profile's `created_by` is refused by the RLS
policy (also 42501). A 3-block proposal (`A-11A`/`A-11B`/`A-11C`, 208,955.00 kg) saved as v1;
re-saving the same three in a different order returned `unchanged:true` with the **same hash**
and the version count stayed **1**. A 2-block save with token 99 returned `stale` naming v1; with
token 1 it wrote **v2**. The v1 snapshot's `block_count`, `total_balance`, all seven weighted
stats and `raw_price_per_kg` (₱40.151192840563757759) are **exactly equal** to
`fn_blend_proposal()` for the same locs, `product_cost_per_kg` = raw × 1.30 exactly, and all
**3 of 3** per-block rows match `view_blocking_grid` field for field including a NULL-safe
`php_kg`. Archived → save refused with `reason:'archived'`; restored → the same save wrote **v3**.
`verify-trigger-grants` and `verify-worker-view-grants` both report **zero findings** (4 views).
The proof proposal `e1c43dbd-5154-4dcf-b51e-e1ce1fae7f60` ("ZZ TEST — blend proposal history
proof", 3 versions) was **ARCHIVED, not deleted — there is no delete**.


### Blend Proposal VERSION OVERWRITE — DATA LAYER (2026-09-25, migrations `20260925075509_blend_proposal_version_overwrite` + `20260925075640_blend_proposal_overwrite_probe_as_of`)

**Renzo's decision:** a user may OVERWRITE ANY EXISTING VERSION IN PLACE — not only the latest —
instead of always appending. "Save as v(N+1)" (`saveBlendProposal`) is **unchanged**; this is an
ADDITIONAL door. His ruling on what gets replaced: overwrite, but **keep a hidden archive copy so
nothing is unrecoverable** (the `deliveries_archive` ethos). **UI shipped 2026-09-25 — the `Save to v{N}` door in the Modify bar; see "Save to v{N} — UI" below.**

**What happened to "append-only".** Both locks on `blend_proposal_versions` STAY: no client role can
UPDATE or DELETE a version by any direct path (re-proven as the real `authenticated` role on
2026-09-25 — UPDATE and DELETE on both tables raise **42501**). The ONE exception is
**`fn_overwrite_blend_proposal_version`**, SECURITY DEFINER (owner `postgres`, which owns the table
and so passes both locks), which **archives the replaced row FIRST, in the same statement** — the
"the SECURITY DEFINER function is the only writer" pattern of `fn_archive_delivery`. The rule is now:
**versions are append-only EXCEPT via `fn_overwrite_blend_proposal_version`, which archives first.**

**Schema**
- `blend_proposal_versions` gains **`revision_no int NOT NULL DEFAULT 1`** (the per-VERSION
  compare-and-set token; 1 = as first saved), **`revised_at`**, **`revised_by`** (FK profiles, no
  `ON DELETE` — the `created_by` reasoning). A CHECK ties them: revision 1 ⇔ `revised_at` NULL ⇔
  `revised_by` NULL.
- **`blend_proposal_version_revisions`** — the hidden archive, one row per REPLACED revision:
  `proposal_id`, `version_no`, `revision_no` (the one that was replaced), `blocks`, `snapshot`,
  `snapshot_hash`, `change_note`, the replaced row's `created_at`/`created_by`/`revised_at`/
  `revised_by` verbatim, plus `archived_at`/`archived_by`. Composite FK `(proposal_id, version_no)`
  → the live version (ON DELETE RESTRICT), UNIQUE `(proposal_id, version_no, revision_no)`.
  **APPEND-ONLY, two locks**: `authenticated` holds SELECT only, RLS with a SELECT policy and **no
  insert/update/delete policy**, so the RPC is the ONLY writer. `anon` and **`service_role` hold
  nothing**. **`snapshot` CARRIES ₱** — nothing reads this table yet; any future server action that
  exposes it must be `canViewPrices()`-gated and null the ₱ before the payload leaves.
- **No unique `snapshot_hash`** (measured: only the PK and `(proposal_id, version_no)`), so
  overwriting v1 into the same blend as v2 is legal — the append path already allows v1 = v3.

**RPC — `fn_overwrite_blend_proposal_version(p_proposal_id uuid, p_version_no int,
p_expected_revision_no int, p_block_locs text[], p_change_note text DEFAULT NULL) → jsonb`.**
SECURITY DEFINER, `SET search_path = public`, EXECUTE revoked from PUBLIC + anon + service_role,
granted to **`authenticated`** only. Requires `auth.uid()` (else `not_authenticated`). The snapshot
is **recomputed in SQL** (`fn_blend_proposal_snapshot` + `fn_blend_snapshot_hash`), never accepted
from a client. Refusals are human jsonb, never a raise, in `fn_save_blend_proposal`'s vocabulary:
`invalid`, `no_blocks`, `not_found`, `archived`, `unknown_version`, `expected_revision_required`,
**`stale`** (with `current_revision_no`), **`unknown_block`** (naming them). Same blend as the
version already holds (price-free hash) → `{ok:true, unchanged:true}` and **nothing written or
archived**. Otherwise ONE statement chain of data-modifying CTEs: `old` (the pre-statement row) →
`upd` (UPDATE with **`revision_no = p_expected_revision_no` inside its own WHERE**, bumps
`revision_no`, stamps `revised_at`/`revised_by`, keeps the old `change_note` when the new one is
blank) → `arch` (INSERT of `old` **joined to `upd`**, so the archive row exists iff the overwrite
happened). **It does NOT touch `blend_proposals.row_version` or `current_version_no`**, so an open
rename or a "Save as v(N+1)" is never staled by an overwrite. Returns `{ok, outcome:'overwritten',
proposal_id, version_no, revision_no}` — **no ₱**. Known consequence: the header's `updated_at`
does not move, so the proposals list (ordered by `updated_at`) does not re-sort on an overwrite.

**THE AS-OF DATE MOVED.** An overwrite recomputes the snapshot TODAY, so a saved version's as-of
instant is now **`coalesce(revised_at, created_at)`**, published ONCE as
**`view_blend_proposal_versions.as_of_at`**. `fn_blend_analysis` (AGE section + market month) and its
two service_role probes were re-created **from their own live definitions with exactly that
substitution** (a guarded DO block that refuses unless the old text occurs the expected number of
times; the live bodies were proven byte-equal to `20260921084500` first). The dialog now passes
`asOfAt`'s Manila date to `fetchBlendBlockFacts` instead of `createdAt`'s. For a version never
overwritten nothing changes. The print's "as proposed" line reads the snapshot's `computed_at`,
which the recompute refreshes, so it follows automatically.

**Views.** `view_blend_proposal_versions` appends `revision_no`, `revised_at`, `revised_by`,
`revised_by_name`, **`as_of_at`**; `view_blend_proposal_list` appends
`current_version_revision_no`, `current_version_revised_at`. Both CREATE OR REPLACE'd and
**`security_invoker` re-asserted in the same file** (reloptions reset — the ops-ledger trap); still
peso-free, `authenticated` only.

**Action + types.** `overwriteBlendProposalVersion({proposalId, versionNo, expectedRevisionNo,
blockLocs, changeNote?}) → BlendProposalOverwriteResult` = `{ok:true, proposalId, versionNo,
revisionNo, unchanged, message?} | {ok:false, reason: BlendProposalOverwriteRefusalReason, message,
currentRevisionNo?, currentVersionNo?, blocks?}`; revalidates only when something was written; no
`canViewPrices()` (no ₱ in or out). `BlendProposalVersionSummary` gains **`revisionNo`,
`revisedAt`, `revisedByName`, `asOfAt`**; `BlendProposalSummary` gains
`currentVersionRevisionNo`, `currentVersionRevisedAt`; `SavedBlendProposal` gains **`revision_no`,
`revised_at`, `revised_by_name`** — `fetchBlendProposalVersion` reads `revision_no` from the **same
row as the snapshot**, so the token the UI hands back can never describe different contents than the
ones on screen. Its ₱ nulling is untouched. **The UI must pass the `revisionNo` it LOADED**, and on
`stale` reload the version.

**Proofs (2026-09-25, live DB, nothing left behind).** `npx tsx scripts/verify-blend-proposal-overwrite.ts`
→ **31 assertions**, over `fn_blend_proposal_overwrite_probe()` (service_role only; runs the whole
scenario in a subtransaction that always raises, so every write rolls back — row counts before =
after, proven each run): overwriting **v1 while v2 is current** succeeds with revision 1 → 2; the one
archive row equals the replaced row **field for field** (blocks, snapshot, hash, note, created/
revised provenance) with `archived_by` = the caller; header `row_version` / `current_version_no`
unchanged and v2 untouched; the old token → `stale` naming revision 2; missing token →
`expected_revision_required`; identical re-save → `unchanged`, **0** new archive rows, no bump, note
kept; identical-to-sibling → overwritten (rev 3); `unknown_block` names `ZZ-NOPE-9`; `no_blocks`,
`unknown_version`, `not_found`, `archived`, `not_authenticated` all human messages; **AS-OF: with both
versions backdated 30 days, v1's analysis reads 2026-08-26 before the overwrite and 2026-09-25
after, while untouched v2 keeps 2026-08-26**; anon and service_role really call the RPC and are
refused; service_role cannot read the archive; catalog posture as above; no money-named key anywhere
in the output. By hand, as the real `authenticated` role in a rolled-back DO block: the RPC
succeeds; UPDATE/DELETE on `blend_proposal_versions` and INSERT/UPDATE/DELETE on the archive all
**42501**; the archive row is SELECT-able; anon and service_role EXECUTE → **42501**.
`verify-trigger-grants` 0 findings, `verify-worker-view-grants` 4 views / 0 findings, and
`verify-blend-analysis` (71), `verify-blend-block-facts` (42), `verify-blend-diff` (23),
`verify-blend-analysis-ui` (97) all still pass.


### Live blend stats — UI (2026-09-25)

Renzo: *"a toolbar that pops up whenever we toggle blend proposal mode on (or when we modify an
existing proposal's selection) … so we have a good idea how the picks are going and not just
randomly clicking."* It is a ROW OF THE EXISTING FLOATING BAR (`blend-action-bar.tsx`), not a
second floating thing, between the Modify banner and the actions.

**What it shows**, dense `text-xs font-mono`, one tile each, in the modal's own labels and decimals:
`Σ/spinner` · **Blocks** · **Total Balance kg** (0 dp) · **Raw ₱/kg** · **Product ₱/kg** (the ×1.30
figure; accounting format, ₱ pinned left) · **MC · ASH · BD ASTM · BD JIS · GRIT · VM · FC** (lab 2 dp,
BD 3 dp). Nothing picked → the strip is one line, *"Pick blocks to see the running blend"*, and no
request is made. **Never crush, always scroll:** every tile has a fixed width and the STRIP scrolls
sideways (`overflow-x-auto min-w-0`) when the bar is narrower than it; the bar itself is clamped to
`100vw − 2rem`, so the page never scrolls sideways (proven at 375 px).

**Every number is the database's.** The hook's `fetcher` port is `buildBlendProposal(locs)` →
`fn_blend_proposal`, THE definition the modal and the saved snapshot use. The two new files contain no
`reduce`, no ×1.30 and no weighting (asserted). The ONE arithmetic is the Modify delta: in a Modify
session each tile carries a third line, the change against the version being modified
(`BlendEditingContext.baseline`, captured from `savedProposal` before Modify clears the viewer), made
by `makeBlendDelta` + `formatSignedDelta` from `lib/blocking/blend-diff.ts` — a subtraction of two
DB-computed figures, NULL → em dash.

**The request discipline (handoff 2026-09-25 learning #4, applied):**
- **Signature, never a counter.** The signature is the sorted, trimmed, de-duplicated block list
  (`blendSelectionSignature`). A reply paints only if `acceptBlendReply(latestSignature, replySignature)`
  — so a slow reply for an older selection landing after a newer one is DISCARDED (proven in the
  browser with a 1.5 s first reply).
- **First read on its own frame, later reads debounced 250 ms.** The first read after the bar is
  enabled (blend mode on, a Modify seed, or the first pick) and a Retry fire immediately; only a CHANGE
  of selection waits out the debounce.
- **The hook lives in `BlockingGrid`**, which the route never remounts on a URL change — not in the
  bar — so the bar mounting/unmounting or a `router.replace` race cannot orphan a request.
- **Keep the last numbers while updating.** While a read is outstanding the tiles dim to 50% (opacity,
  150 ms) and the Σ slot becomes a spinner of the same size — no flicker, no layout jump. Returning to a
  selection whose answer is already on screen does not re-read.
- **Errors are inline and persistent**: a red strip with the full message, **Copy** and **Retry**, and
  the last good figures stay above it (labelled "for an earlier selection"). **A read that never
  answers trips a 12 s watchdog** into the same strip. `buildBlendProposal` itself degrades to an empty
  blend on a DB error, so the strip only sees THROWN failures (network, server action crash).

**Price gating.** `buildBlendProposal` already nulls ₱ for `!canViewPrices()`. The two ₱ tiles render
only when the grid's EFFECTIVE flag (`serverCanViewPrices && showPrices`) AND the reply's
`can_view_prices` are true — for Production they are ABSENT, not an em dash (proven: no ₱ glyph
anywhere in the bar). An em dash in a ₱ tile for a price reader means the blend has no priced block.

**Motion:** the bar keeps `animate-fade-up` and the canonical floating-bar glass
(`bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60`); only opacity animates.

### Save to v{N} — UI (2026-09-25)

Renzo: *"user should be able to modify versions without having to make a new one"* — and
**Save as v(N+1) stays** as a core function. In a Modify session the bar now offers, left to right:
**Save to v{from}** (outline button, pencil) · **Save as v{N+1}** (primary, unchanged) · Save as new ·
Clear. Any version can be overwritten — `from` is the version the operator pressed Modify on.

- **The token.** `BlendEditingContext.fromRevisionNo = savedProposal.revision_no`, captured at Modify
  from the SAME row as the snapshot on screen. `handleOverwriteVersion` calls
  `overwriteBlendProposalVersion({ proposalId, versionNo: fromVersionNo, expectedRevisionNo:
  fromRevisionNo, blockLocs, changeNote })`.
- **The popover IS the confirm step** (no second modal): *"This replaces what v{N} holds with your
  current selection. Its numbers are recalculated as of today, and the previous contents are kept in
  the archive."* The optional note's placeholder says a blank keeps v{N}'s existing note (the RPC's
  rule). The append popover's old *"v{N-1} is never changed"* copy — no longer universally true — now
  reads *"Adds v{N+1} to this proposal; the versions already saved stay exactly as they are."*
- **Outcomes.** `unchanged` → neutral toast *"Identical to v{N} — nothing saved"*, the session stays
  open. Success → success toast, `loadProposals()`, clear editing + selection, and
  `proposalLinkRef(proposalId, N)`. Because Modify already cleared `?proposal=`, that is a FRESH
  navigation, so the route re-reads both the version rail and the snapshot — the viewer can never show
  the cached pre-overwrite contents. `stale` → `errorToast` via `describeOverwriteRefusal` (*"Someone
  else changed v{N} while this edit was open … reopen the proposal, look at what they saved, and redo
  your change"*); `unknown_block` lists the blocks; anything else shows the RPC's own message.
- **Where an edit shows.** The version rail's date is now **`asOfAt`** (coalesce(revised_at,
  created_at)); an overwritten version gets a small pencil on its chip and a muted italic
  *"· edited {date} by {name}"* after the author (tooltip: first saved … by …; contents replaced in place
  since, earlier contents archived). The saved viewer's meta line appends the same `edited {date} by
  {name}`, and the proposals LIST puts a pencil after `v#` when the current version was edited (the
  `v#` column widened 48 → 62 px, table min-width 1098 → 1112 px, still inside the `max-w-6xl` dialog).

**Proofs:** `npx tsx scripts/verify-blend-live-stats-ui.ts` — static source assertions plus a
Playwright pass over the dev fixture **`/dev/table-playground/blendstats`**, which mounts the REAL
`BlendActionBar` + `useBlendLiveStats` with an in-memory fetcher (~300 ms; `?slow=`, `?fail=`, `?hang=`,
`?watchdog=`, `?prices=0`, `?modify=1`). Needs a dev server (`BLEND_STATS_BASE_URL`, default
`http://localhost:3000`) or `--static-only`. Asserts: bar hidden when blend mode is off and shown with
the empty hint (and no request) when on; first pick reads immediately with the modal's decimals;
last figures kept while updating; a stale reply discarded; ₱ tiles absent for a non-price reader;
Copy + Retry on a failed read with the last numbers kept; the watchdog; both save doors present only in
a Modify session, with deltas; no sideways page scroll at 375 px.

### Blend Proposal HISTORY — UI (2026-09-03)

**Everything lives inside the Blocking page as pop-ups**, per the brief. One new dialog, one
extended dialog, one pure module, and two URL params.

**Entry point.** A **Proposals** button (History icon + a badge of NON-archived proposals) sits
beside the Blend Proposal toggle in the sticky header — present in the desktop row, the mobile
`overflow-x-auto` strip, and the condensed `[@media(max-height:500px)]` variant (`Proposals` /
`Saved`). It opens `_shared/blend-proposals-dialog.tsx`.

**URL params — `?proposal=<id>` and `?v=<n>`, following `?block=` exactly.**
`blocking-route-view.tsx` owns them (`useOptimistic` inside a `useTransition`, because the route
is dynamic and a bare `router.replace` would leave the modal shut for a whole server round-trip),
**writes them as a PAIR** through one `handleProposalLinkChange(id, versionNo?)`, and resolves
them into `savedProposal` / `savedVersions`. Two consequences worth stating: switching proposals
can never leave the previous proposal's version number behind, and a hand-edited junk `?v=` is
treated as ABSENT (open the current version) rather than as version 0.
`/inventory/blocking?proposal=<uuid>&v=2` is a shareable, refresh-safe state.

**ONE dialog renders both a live what-if and a saved version.** `dialogOpen = !!proposalId ||
proposalOpen`, `dialogProposal = proposalId ? savedProposal : proposal`. That is what makes a
fresh save able to hand the modal over to the saved viewer **without closing it** — and why the
blend selection is deliberately NOT cleared on that path (the operator is still in blend mode).

| Action | What happens |
|---|---|
| **Save** (fresh blend) | Header popover: **Title (required) + Remark**, Enter confirms, disabled while the title is blank. → `saveBlendProposal` → toast → list reloads (badge increments) → the modal becomes the saved viewer at `v1`. |
| **Version rail** | `v1 · v2 · v3★` chips write `?v=`; the route refetches; the chip's `change_note`, author and date render underneath. |
| **Modify** | Closes the viewer, turns blend mode ON, and seeds `blendSelection` **BY BATCH IDENTITY** (see below). The floating bar grows an `Editing: <title> v3 ×` pill, the unresolved notice, **Save as v(N+1)** and **Save as new proposal**. |
| **Save to v{N}** (2026-09-25) | Overwrites the modified version IN PLACE — see "Save to v{N} — UI" above. |
| **Save as v(N+1)** | Popover prompts for a change note → `saveBlendProposal({proposalId, expectedVersionNo, changeNote})`. `stale` → `errorToast()` naming the version someone else appended and telling you to reopen and redo. `unchanged:true` → an INFO toast ("Identical to vN — nothing saved") and the edit session STAYS OPEN; nothing was lost and there is nowhere to navigate. |
| **Save as new proposal** | The same `SaveNewPopover`, defaulted to `<title> (copy)` — a fork by hand, leaving the original untouched. |
| **Compare with today** | `buildBlendProposal(version's block_locs)` → `compareBlendSnapshots`. Read-only; the snapshot is never written. |
| **Edit** | Popover patching title / remark / status / `fed_on`, through `updateBlendProposalHeader(id, rowVersion, patch)` with the list row's `row_version` as the compare-and-set token. |
| **Archive / Restore** | Soft only, from the viewer header or the list's Restore button. There is no delete anywhere in this feature. |

**THE LOAD-BEARING RULE: Modify resolves by `batch_id`, never by `block_loc`.** A block address is
REUSED — `batches.location_ref` is cleared when a pile empties — so seeding a Modify from block
names would silently re-propose *different charcoal under the same address*, and nothing on
screen would look wrong. `lib/blocking/blend-diff.ts::resolveBlendBlocks` compares the version's
`batch_id` against the live grid's occupant and re-selects ONLY on a match; everything else is
named in the floating bar ("1 of 4 blocks no longer holds the proposed batch: A-9C"). A saved row
with no `batch_id` falls back to `batch_code` (UNIQUE in `batches`, so a real if second-choice
identity); one with neither is `unknown_identity` and is never silently resolved. When NOTHING
resolves, the bar still shows (with an `errorToast` explaining) — that is precisely the moment
the operator needs to know why.

**`lib/blocking/blend-diff.ts` — pure, dependency-free, pinned by `scripts/verify-blend-diff.ts`
(23 assertions, `npx tsx`).** It does TWO things and neither is aggregation: resolve a saved
version against the live grid (above), and SUBTRACT two already-computed blends. Every number it
touches came out of SQL; it never re-weights, never re-sums a balance, never recomputes a
weighted average — an assertion pins that a blend whose parts do not add up is passed through
unchanged rather than "corrected". **NULL ≠ 0 on every delta**: a gated or unpriced ₱ compares to
NULL and renders an em dash, because "we don't know" and "it did not move" are different answers
and the peso column is where confusing them is expensive. `formatSignedDelta(delta, decimals,
grouped)` is the ONE formatter (`+1.23` / `-0.45` / unsigned `0.00` / `—`), with `grouped` for
kilograms so `-55,120` reads like the `174,580` beside it. The live what-if carries no
`batch_id`, so `compareBlendSnapshots` takes the grid's occupancy map to decide which blocks
changed hands.

**Price gating needed NO new code.** `fetchBlendProposalVersion` nulls `raw_price_per_kg`,
`product_cost_per_kg` and every `blocks[].php_kg` and sets `can_view_prices:false` before the
payload leaves the server — exactly what `buildBlendProposal` already does — so the dialog's
existing `proposal.can_view_prices && showPrices` rule covers a saved version, its printout, its
PDF and its comparison. The proposals LIST and the version RAIL carry no ₱ at all.

**Mobile (below `sm`) is READ-ONLY and says so.** Blend Proposal selection is desktop-only today,
so Save / Modify / Edit / Archive are hidden and a one-line note explains it, rather than being
silently absent or offered and then refused. View, compare, print and PDF all work.

### Blend block facts — DATA LAYER (2026-09-21, migration `20260921034512_blend_block_facts_and_price_lens_rounded_up`)

> **BACKEND ONLY so far.** The SQL function, the server action and the types are LIVE and verified;
> the "Selected blocks" table, the saved-version viewer and the landscape print are the next pass.
> **This section IS the contract** — a UI can be built from it without reading any SQL. Proofs:
> `npx tsx scripts/verify-blend-block-facts.ts` (**42 assertions, all passing 2026-09-21**).

**What the owner asked for.** Per selected block in the blend modal — in the LIVE what-if, in a
SAVED version's viewer and in the landscape print-out — two things the table has never shown:
**(a)** the supplier picture in the page's EXISTING vocabulary (**GREEN** = the whole block is one
supplier, **ORANGE** = mixed, showing the **DOMINANT** supplier), and **(b)** the block's age
"since last opened/created" and "since last piled on".

#### WHY THIS IS AN AS-OF FUNCTION AND NOT A COLUMN ON THE SNAPSHOT — read this first

A proposal is **a statement about the yard ON A PARTICULAR DAY**, and a saved version's `snapshot`
is **immutable and HASHED** (`fn_blend_snapshot_hash`). Adding the supplier picture to it would mean
rewriting every stored snapshot, moving every hash, and inventing a new version of every proposal
for what was really a schema change. So **nothing about the saved feature was touched** — not
`fn_blend_proposal_snapshot`, not `fn_blend_snapshot_hash`, not a stored snapshot, not a proposal
table, not a grant on one (the verify script asserts all of that against the migration text).

Instead the answer is **RECONSTRUCTED**: given the batch ids a version already records, and the day
that version was written, rebuild the picture from `deliveries` as they stood on that day.

**Which date to pass for a saved version:** the **Asia/Manila calendar date of the version's AS-OF
instant** — `BlendProposalVersionSummary.asOfAt` (= `view_blend_proposal_versions.as_of_at` =
`coalesce(revised_at, created_at)`, 2026-09-25). It was `createdAt` until versions could be
overwritten in place; an overwrite recomputes the snapshot on the day it happens, so `createdAt`
alone would now ask about the wrong day. For the LIVE modal pass **nothing** — omitted means TODAY in Asia/Manila, which is
what "now" means at the plant.

**KEYED BY `batch_id`, NEVER BY `block_loc`.** A block address is REUSED — `batches.location_ref` is
cleared when a pile empties — so resolving a saved version by block name would silently describe
**different charcoal under the same address** and nothing on screen would look wrong. This is the
same load-bearing rule `lib/blocking/blend-diff.ts::resolveBlendBlocks` already follows, and it is
why `fn_blend_proposal_snapshot` records `blocks[].batch_id` at all. On the live path pass the
grid's occupant of each ticked block; on a saved path pass `snapshot.blocks[].batch_id`.

#### The action — `fetchBlendBlockFacts(batchIds, asOf?)`

```ts
interface BlendBlockSupplierShare {
  key: string;                   // canonical identity — the SAME key the supplier search matches on
  display: string;               // a representative raw spelling; display ONLY, never matching
  kg: number;                    // kilograms into the block at or before the as-of date
  sharePct: number | null;       // PERCENT 0-100. NULL, never 0, when the block weighs nothing
}

interface BlendBlockFacts {
  batchId: string;
  batchCode: string;
  supplierCount: number;                  // 0 when nothing was delivered as of that date
  dominantSupplierKey: string | null;
  dominantSupplierDisplay: string | null;
  dominantSharePct: number | null;        // PERCENT 0-100
  isSingleSupplier: boolean | null;       // THE green/orange rule. null = NEITHER
  suppliers: BlendBlockSupplierShare[];   // biggest kg first. EMPTY ARRAY, never null
  firstDeliveryDate: string | null;       // 'yyyy-MM-dd' — OPENED
  lastDeliveryDate: string | null;        // 'yyyy-MM-dd' — LAST PILED ON
  daysSinceOpened: number | null;         // whole days, asOf - firstDeliveryDate
  daysSinceLastPiled: number | null;      // whole days, asOf - lastDeliveryDate
  deliveryCount: number;
}

type BlendBlockFactsResult =
  | { ok: true;
      asOf: string | null;                       // the date the DATABASE used; null only if NO id matched
      facts: Record<string, BlendBlockFacts> }   // keyed by batchId; an unknown id is ABSENT
  | { ok: false;
      reason: 'not_signed_in' | 'no_batch_ids' | 'too_many_batch_ids' | 'invalid_batch_id'
            | 'invalid_as_of' | 'rpc_error' | 'exception';
      message: string };
```

**THE GREEN/ORANGE RULE IS A COLUMN — `isSingleSupplier`.** `true` = the whole block is that one
supplier (green), `false` = mixed (orange; show `dominantSupplierDisplay` + `dominantSharePct`).
**Never re-derive it from `suppliers.length`.** It is identical in meaning to
`BlockingSupplierMap.byBlock[loc].supplierCount === 1`, and it is PROVEN equal to
`view_blocking_block_suppliers.supplier_count_in_block = 1` on **every batch the grid shows** —
measured 2026-09-21, **167 batches / 199 (block, supplier) pairs, 0 mismatches on the count, 0 on the
flag, and the per-supplier kilograms agree with gap exactly 0.00 kg**. Re-deriving it is how the
blend modal and the Blocking supplier search would eventually disagree about a block.

**SUPPLIER IDENTITY is `canonical_supplier(split_part(supplier, ' - ', 1))`** — the ONE definition,
the same expression `view_blocking_block_suppliers` uses, so both screens name suppliers identically.
A TypeScript port would be a second one that drifts; the verify script asserts `actions.ts` contains
neither `canonical_supplier` nor `split_part`. A key that resolves to nothing is the literal
`UNKNOWN`. The `suppliers` array is ordered **biggest kilograms first**, and a **kg tie breaks on the
alphabetically-first canonical key**, so two equally large suppliers cannot make consecutive calls
disagree about which one is "dominant" (0 such ties in today's yard). Good for a tooltip.

**"OPENED" IS THE FIRST DELIVERY — not the first feeding, and not a closure date** (closure is an
`rc_out` fact and lives in `view_rc_movement_block_actual_price.close_date`). And these two dates are
**NOT an age**: `view_batch_age_days.age_days` — the kg-weighted mean delivery date the **Age lens**
reads — remains THE age of a block, and this function adds no second definition. The two are
reconciled every run: `firstDeliveryDate` / `lastDeliveryDate` are proven **equal to
`view_batch_age_days`' own columns of the same name on all 167 shared batches**, and the two DATED
populations are the same SET.

**THE AS-OF RULE.** Only deliveries with `transaction_date <= asOf` count — a delivery **ON** the
date counts. `asOf` omitted/null = today in Asia/Manila. **It genuinely narrows, and that is proven
on live data, not a fixture:** `AUGUST-26-BLK9` reads **2 suppliers today (ORANGE, Llanto 90.20%)**
and **1 supplier as of 2026-09-10 (GREEN, Llanto 100.00%)**, because its second supplier first
delivered on 2026-09-11. The verify script discovers such a block live through the probe rather than
hard-coding one. A future `asOf` is refused `invalid_as_of`, **measured in Asia/Manila** — PH is
UTC+8, so a UTC-based test would refuse a perfectly ordinary "today" between 16:00 and midnight UTC.

**NULL IS NEVER 0.** A block with **no delivery at or before the as-of date** reads
`supplierCount: 0`, `deliveryCount: 0`, `suppliers: []`, and **NULL** on every dominant field, both
dates, both day counts **and `isSingleSupplier`**. That last one matters most: `false` would paint a
pile nobody has delivered into as **MIXED**, and `0` days would make it look **brand new**.
**UI rule: render such a block un-lensed — no green, no orange, an em dash for the ages.**
(`suppliers` is the ONE exception, an empty **array** rather than null, because a list with nothing
in it is itself a fact and every caller can iterate it safely.)

**AN UNKNOWN ID IS ABSENT, NOT ZERO-FILLED.** A `batchIds` element that is not a row in `batches`
produces **no entry in `facts`**, so the record can be smaller than the list you asked about — the
truthful answer to "tell me about this batch" when there is no such batch. Never fill that gap.

**NO PRICE GATE, AND THAT IS THE POINT.** Nothing in this payload is money and none of it is
derivable into money — suppliers, kilograms, shares, dates and day counts; `cost_basis` is never
read, and no column, argument or jsonb key is money-named (asserted twice, once off the catalog and
once off the live payload). So **`fetchBlendBlockFacts` has NO `canViewPrices()` call and the whole
feature is visible to EVERY role INCLUDING Production** — the same posture as
`view_blocking_block_suppliers` and the Age lens, and the OPPOSITE of the Price lens, whose band
membership alone pins a block's ₱/kg to within a peso. `scripts/verify-blend-block-facts.ts` asserts
the gate's **ABSENCE**, so the asymmetry cannot be "tidied up" by accident. It **does** require a
signed-in user (`auth.getUser()` → `not_signed_in`), like the other non-price reads in `actions.ts`.

**Input rules, all refused before any round trip:** a non-uuid element → `invalid_batch_id`; an empty
list → `no_batch_ids`; more than **250** de-duplicated ids (`BLEND_BLOCK_FACTS_MAX_BATCH_IDS`, one
definition, imported not re-typed) → `too_many_batch_ids`; a date that is not a real `yyyy-MM-dd`
calendar date, or is in the future → `invalid_as_of`. Ids are de-duplicated for you.

**Posture.** `STABLE`, `SECURITY INVOKER`, `SET search_path = public`, EXECUTE revoked from `PUBLIC`
+ `anon`, granted to **`authenticated` only** — and **NOT `service_role`** (no sync worker calls it,
so `verify-worker-view-grants` stays at 4 views / 0 findings, confirmed after this migration). Proven
by really calling it as `anon` and as `service_role` and requiring both to be refused (L-043: prove a
permission by assuming the victim's role).

**Cost, measured before any proof was written** (the 2026-09-14 rule — `set local
statement_timeout='5s'` then `EXPLAIN (ANALYZE, BUFFERS)`, 2026-09-21): **7.3 ms / 953 buffers for a
realistic 3-block blend**, **31.7 ms / 1,451 buffers for all 167 occupied blocks** warm (of which
1.5 ms / 111 buffers is the caller's own grid scan to obtain the ids); 73.5 ms on the very first call,
16 ms of that planning. The dominant cost is `canonical_supplier()` per delivery row. The population
is **bounded BY CONSTRUCTION** — one pass over `deliveries` whatever the id list contains — so a
longer list cannot turn this into a whole-history scan, and the action caps it at 250 regardless.

**The verify script reaches the function through a probe, and why.** It is `authenticated`-only by
design and no verify script holds a user JWT, so **`fn_blend_block_facts_probe()`** (SECURITY
DEFINER, `service_role` **only**, never `authenticated`, never `anon`) is the access bridge — the
same idiom as `fn_blocking_price_lens_probe` / `fn_blocking_age_lens_probe`, both of which this
migration leaves untouched. **It asserts nothing**: it calls the function four times, reads
`view_blocking_block_suppliers` and `view_batch_age_days` independently, discovers the as-of flip
candidate live, and hands everything back so every assertion lives in readable TypeScript. It is
deliberately NOT a whole-database verifier (the 2026-09-14 `fn_ops_ledger_verify()` incident took the
live site down), and it returns **no money value of any kind**.

### Blend analysis — DATA LAYER (2026-09-21, migration `20260921084500_blend_analysis_natural_breaks`)

> **BACKEND ONLY.** The two SQL functions, the server action and the types are LIVE and verified;
> the viewer pages and the print are the next pass. **This section IS the contract** — a UI can be
> built from it without reading any SQL. Proofs: `npx tsx scripts/verify-blend-analysis.ts`
> (**71 assertions, all passing 2026-09-21**).

**What the owner asked for.** In a saved blend proposal, when viewing **and printing**, extra pages
that *"group and arrange blocks according to high priced and low priced and average priced … a
statistical way of properly grouping these as something we can objectively agree to be high and
low"*, another page for **MC, ash and BD**, maybe **age**, tables *"with footers that show totals or
averages when appropriate"*, *"incorporating some of the logic of our price lens into blend
proposal"*.

#### WHY NATURAL BREAKS AND NOT MEAN ± 1 SD — read this first

Mean ± one standard deviation was the obvious answer. It was **measured on the owner's own proposal
and rejected.** `26 OCT RUN V2` v2 holds 24 blocks at a kg-weighted mean of **₱43.56** with SD
**₱5.11**, and the prices sit in **two clumps — ₱36.57…₱42.00 and ₱47.00…₱49.50 — with the mean
landing in the empty gap between them.** So mean ± 1 SD is `[₱38.45, ₱48.67]`, which files a ₱39
block and a ₱48 block together as *"average"*: it puts the two clumps' inner halves in one band and
splits each clump down the middle. The statistic describes a distribution the data does not have.

**WEIGHTED NATURAL BREAKS (Jenks, the 1-D optimal partition)** puts the cut lines where the gaps
actually are, by minimising the **kg-weighted within-group sum of squares**:

> minimise  Σ<sub>groups</sub> Σ<sub>i</sub> `kg`<sub>i</sub> × (`x`<sub>i</sub> − weighted mean of its group)²

On that same proposal it cuts at **₱38.5946 | ₱39.3391** and **₱42.0000 | ₱47.0000** — the second
cut landing exactly in the owner's empty gap — for `low` ₱36.57–38.59 (7 blocks, 433,408 kg, 28.99%,
**₱37.4262**), `mid` ₱39.34–42.00 (5 blocks, 304,406 kg, 20.36%, **₱40.0977**) and `high`
₱47.00–49.50 (12 blocks, 757,293 kg, 50.65%, **₱48.4573**), with **gvf 0.9761**.

**It is EXACT, not a heuristic.** `fn_natural_breaks_3` enumerates **every pair of cut positions**
taken between two **DISTINCT adjacent values** and returns the pair with the lowest score; prefix
sums of `Σw`, `Σwx` and `Σwx²` make each candidate O(1) (`SS = Q − S²/W`). The verify script proves
this by **brute force in TypeScript** over the values the DB returned: no other pair scores lower,
and the documented tie-break picks the same one.

* **THE TIE-BREAK IS PART OF THE CONTRACT:** on equal within-SS the **lowest first cut wins, then
  the lowest second cut.** Without a stated rule two calls on identical data could return different
  groupings and nobody could say which was right. Proven: two identical calls are byte-identical.
* **Weighted by KILOGRAMS, always.** A 74,590 kg block and a 30,115 kg block are not equal opinions
  about what a pile contains — and that weighting is also what makes the group footers agree with
  the blend's own weighted averages.
* **`gvf` = `1 − within_ss / total_ss`**, 0…1, says how clean the split is. **NULL — never 0 — when
  `total_ss` is 0** (one distinct value: there is no variance to explain, and "explained none of it"
  would be a lie).
* **DEGENERATE CASES RETURN FEWER GROUPS, never an empty one and never a fabricated cut.** ≥ 3
  distinct values → 3 groups `low · mid · high`; **2 → 2 groups `low · high`; 1 → ONE group labelled
  `mid`** (it is neither low nor high); nothing measurable → 0 groups with NULL statistics. The
  label vocabulary is **CLOSED** to `{low, mid, high}` so a colour map can be total. **Read
  `groupCount`** — never infer it from `groups.length`.
* Both degenerate cases are proven on **live** blocks the probe discovers (two occupied blocks that
  happen to share one ₱/kg → one group; plus a third at a different price → two).

**AGE IS THE ONE SECTION THAT DOES NOT USE NATURAL BREAKS.** It uses **fixed cut lines in days**
(default **60 / 120 / 365**, the Age lens's own defaults and its exact semantics, including a
NEGATIVE age landing in band 0), because those days are meaningful in themselves and a grouping that
moved with the yard would make "over a year old" mean something different on every proposal.

#### The action — `fetchBlendAnalysis(input)`

```ts
interface BlendAnalysisInput {
  proposalId?: string | null;         // SAVED source
  versionNo?: number | null;          // omitted = the proposal's CURRENT version
  blockLocs?: readonly string[] | null; // LIVE source. EXACTLY ONE SOURCE, never both
  priceEdgeOffsets?: readonly number[] | null;  // default [-1, 0]
  ageEdgeDays?: readonly number[] | null;       // default [60, 120, 365]
  marketPhpKg?: number | null;        // omitted = the market of the blend's OWN month
  roundedUpPhp?: number | null;       // typed market only: pass Math.ceil(typedPrice)
}

interface BlendAnalysis {
  source: 'saved' | 'live';
  asOf: string;                 // yyyy-MM-dd — decided by the DATABASE
  proposalId: string | null;  versionNo: number | null;  title: string | null;
  snapshotComputedAt: string | null;  computedAt: string;
  blockCount: number;  totalKg: number;
  price: BlendAnalysisPriceSection | null;  // NULL when the caller may not see prices
  pricesHidden: boolean;                    // true = `price` was DELETED server-side
  quality: { metrics: BlendQualityMetric[];                 // ['mc','ash','bd_astm','bd_jis']
             byMetric: Record<BlendQualityMetric, BlendQualityNatural> };
  age: BlendAnalysisAgeSection;
}

type BlendAnalysisResult =
  | { ok: true; analysis: BlendAnalysis }
  | { ok: false; reason: BlendAnalysisRefusalReason; message: string };
```

**The three sections, in the shapes a table renders from.** Every group/band carries
`index`, `blockCount`, `kg`, `kgSharePct`, `blockSharePct` and a `blocks[]` list already in the
right order, so a UI renders rows and a footer without folding anything.

| Section | Grouping | Per group / band | `blocks[]` rows, already sorted | Footer (`overall`) |
|---|---|---|---|---|
| `price.natural` | natural breaks on `php_kg` | `label`, `rangeMin`, `rangeMax`, **`kgWeightedPhpKg`**, **`valuePhp`** (Σ kg×₱) | `{batchId, blockLoc, batchCode, kg, phpKg}` — **dearest first** | `kgWeightedPhpKg`, `valuePhp`, `snapshotPhpKg`, `snapshotGap`, `equalsSnapshot` |
| `price.vsMarket` | the **PRICE LENS's** bands | `lowerPhp`/`upperPhp` (**null = OPEN**), `kgWeightedPhpKg`, `valuePhp` | same | `kgWeightedPhpKg`, `valuePhp` |
| `quality.byMetric[m]` | natural breaks on the reading | `label`, `rangeMin`, `rangeMax`, **`kgWeightedValue`** | `{…, value}` — **highest reading first** | `kgWeightedValue`, `snapshotValue`, `snapshotGap`, `equalsSnapshot` |
| `age` | **fixed** cut lines in days | `lowerDays` (0 on band 0), `upperDays` (**null = open above**), `kgWeightedAgeDays` | `{…, ageDays, firstDeliveryDate, lastDeliveryDate, deliveryCount}` — **oldest first** | `kgWeightedAgeDays`, `oldestAgeDays`, `oldestBlockLoc`, `oldestBatchCode` |

`price.natural` and every `quality.byMetric[m]` also carry `groupCount`, `gvf`, `cuts[]` and
`stats` (`n`, `distinctCount`, `totalWeight`, `weightedMean`, `totalSs`, `withinSs`, `betweenSs`,
`candidatesConsidered`). **A `cut` is published three ways — `below`, `above`, `value` (their
midpoint). `above` IS the membership test; the midpoint is for a legend and must never be used as
the test.**

**BD is "higher = denser", and the labels still go by VALUE.** `high` means the larger number on
every metric; whether that reads as "best" or "worst" is the UI's wording decision. Measured on the
owner's proposal: mc gvf 0.8959 · ash 0.8698 · bd_astm 0.8986 · bd_jis 0.8986.

#### SAVED vs LIVE, AND THE AS-OF RULE

**Exactly one source.** `proposalId` (+ optional `versionNo`, default the current version) reads the
**STORED** `blend_proposal_versions.snapshot` **verbatim** — a proposal is a statement about the
yard on a particular day, and its snapshot is immutable and **hashed**, so the analysis is
*reconstructed* from it rather than added to it. **Nothing in the saved feature was touched** (no
table, no snapshot, no hash, no grant; the verify script asserts it against the migration text).
`blockLocs` computes the same thing live from **`fn_blend_proposal_snapshot`, the ONE existing
builder** — its arithmetic is not restated. Both + neither are refusals; a `versionNo` on its own is
`no_source`.

**READING AN ARCHIVED PROPOSAL IS ALLOWED** (only *writing* to one is refused) — the proposals list
shows archived rows, and the as-of proof below runs on one.

**`asOf` is decided by the DATABASE**: the saved version's own **`coalesce(revised_at, created_at)`
in Asia/Manila** (it was `created_at` alone until 2026-09-25, when in-place overwrite made
`revised_at` the day the snapshot was last computed — see **Blend Proposal VERSION OVERWRITE**), or
**today in Asia/Manila** for live. It governs the **AGE section only**, so a
delivery that lands after a proposal was saved can never repaint it. **Proven on live data, with
nothing written:** the archived `ZZ TEST` v3 (as of **2026-09-03**) reads `AUG-26-BLK12`'s last
delivery as **2026-09-01** over **3** deliveries, while the live analysis of the same blocks reads
**2026-09-07** over **4** — and every *unchanged* pile's dates are identical while its age moves by
exactly the number of days between the two as-of dates.

**AGE IS NOT REDEFINED.** It is `view_batch_age_days`' own kg-weighted-mean-delivery-date expression
narrowed by `transaction_date <= asOf`, and at `asOf = today` it equals that view **exactly**
(measured: 24 blocks, 0 mismatches, max gap 0 — including both delivery dates). `ageDays` is
published at **full precision**; **round it for display**, as the Age lens does at 1 decimal.

#### MARKET FOR THE AS-OF MONTH

`vsMarket` is the **price lens's own logic** applied to this blend's blocks — proven to classify all
24 of them into the same bands as `fn_blocking_price_lens` for the same market price, R and edges.

* `marketPhpKg` given → `marketBasis: 'given'`, `marketBasisMonth: null`.
* Omitted → the **`this_month`-style market OF THE BLEND'S OWN MONTH**, read from
  `view_analytics_rcin_monthly.market_avg_price` (THE one definition). A saved version is therefore
  compared with the market of the month it was **saved** in, not with today's — which is the whole
  point of an as-of. Measured: the owner's proposal reads market **₱39.8272** for `2026-09-01`,
  R = 40, and **7 blocks below / 3 at / 14 above** market.
* **`R = roundedUpPhp ?? floor(market) + 1`**, and the UI rule is the price lens's: **for a TYPED
  price pass `Math.ceil(typedPrice)`; for a measured basis pass nothing.** Proven: market 41 with
  the override reads R = 41, without it R = 42.
* **A market that cannot be measured gives `vsMarket: null`** — never ₱0, which would put every
  block above market — **and the reason rides beside it** in `vsMarketUnavailable`
  `{reason:'no_market_price', message, marketBasis, marketBasisMonth}`, because a null cannot carry
  one. Offer a typed price.

#### NULL IS NEVER 0 — the `unmeasured` bucket

**A metric value that is NULL *or ≤ 0* is the NOT-RECORDED placeholder, not a reading.** `php_kg` 0
is the L-008 unpriced placeholder, and **`view_blocking_grid` COALESCEs `avg_ash` / `avg_bd_astm` /
`avg_bd_jis` to 0 — measured, 11 of the yard's 170 occupied blocks read exactly 0 on all three**
(0 of 170 on `mc` or `php_kg`). Charcoal with 0.000 % ash does not exist; calling it the cleanest
block in the blend is the ₱11.01-vs-₱39.99 `avg_cost` bug in a new costume.

Such a block lands in **`unmeasured`** (`blockCount`, `kg`, `noValueCount`, `noWeightCount`,
`blocks[]`), in **NO group**, excluded from every average and from both share denominators. A block
with **no positive weight** is excluded too and counted separately, so a UI can explain the blank.

> **UI RULE: render an unmeasured block un-lensed — no colour, an em dash for the figure. Never put
> it in the cheapest, the cleanest or the freshest group.**

**Checkable invariants, asserted in every section on both sources:**
`Σ groups[].kg + unmeasured.kg === totalKg` (and the same for `blockCount`) ·
`Σ kgSharePct === 100` and `Σ blockSharePct === 100` (±1e-9, over the **measured** population, all
null when nothing is measured) · an **empty** group's weighted figure is **null, never 0** ·
`groupCount === groups.length`.

**`overall.snapshotGap` / `equalsSnapshot` is how the two footers are reconciled.**
`kgWeightedPhpKg` / `kgWeightedValue` is the honest figure over the **measured** blocks;
`snapshotPhpKg` / `snapshotValue` is what the blend itself stored, lifted verbatim. **Gap exactly 0
whenever nothing is unmeasured** (proven on the owner's proposal for the raw price and all four lab
stats), and when something IS, the snapshot's figure is the one dragged down by a 0 — measured live,
a blend containing `B-1A` (ash 0) reads an honest **3.1299** against the snapshot's **2.1273**, and
`equalsSnapshot` is `false`, which is the UI's cue to explain rather than to pick a winner.

#### ₱ LIVES IN ONE SECTION, AND THE GATE IS A DELETION

`sections.price` carries money — group ₱/kg, band edges, Σ kg×₱, and, exactly as the price lens
records, **band membership itself** (knowing a block is in `high` pins its ₱/kg to a range).
`quality` and `age` carry none and none is derivable: readings, kilograms, day counts, shares.

So this action does **not** refuse a price-denied caller the way `fetchBlockingPriceLens` does, and
it does **not** null fields either — **it DELETES the whole section**: `price: null` with
`pricesHidden: true`, and **Production still gets the quality and age pages.** Deleting the section
rather than nulling inside it is what makes the gate total — there is no `bands[].blockCount` left
to read a price distribution off. Asserted twice: statically on the gate's ORDER and shape, and on a
real payload by scanning every key under `quality` + `age` for `php|peso|cost|price|value_php|amount`
(**56 keys, 0 offenders** — while `price` does carry them, so the scan is not vacuous).

> The quality reading is deliberately named `value` / `kgWeightedValue`. A moisture percentage is
> not money, and `value_php` — Σ kg × ₱/kg — is; that is why the money scan looks for `value_php`
> and not for a bare `value`.

**UI rule:** when `pricesHidden`, say so once ("prices are not shown for your role") rather than
rendering an empty page or hiding the tab.

#### Refusals — all jsonb `{ok:false, reason, message}`, never a throw

`not_signed_in` · `both_sources` · `no_source` · `invalid_proposal_id` · `invalid_version_no` ·
`unknown_proposal` · `unknown_version` (names the latest version) · `no_blocks` ·
`too_many_blocks` (cap **250**, `BLEND_ANALYSIS_MAX_BLOCKS`) · **`unknown_block_loc`** (a
`block_loc` with no active batch in it right now — **NAMED**, never silently dropped, because
analysing a set you could not resolve would quietly describe a different blend) ·
`invalid_price_edge` / `no_price_edges` / `too_many_price_edges` (cap 6) · `invalid_age_edge`
(a NULL, a non-positive, or one above 5,000 days) / `no_age_edges` / `too_many_age_edges` (cap 6) ·
`invalid_rounded_up` · `invalid_market_price` · `rpc_error` · `exception`.

**The reason codes are PREFIXED by family** (`invalid_price_edge` vs `invalid_age_edge`) because one
function takes both edge lists and a caller has to know which one it got wrong — a deliberate
divergence from the two lenses, which each use a bare `invalid_edge`. **The messages are the lenses'
own, verbatim.** Integrality of both edge lists and of `roundedUpPhp` is checked **in the action**,
because `int[]` / `int` means Postgres has already rounded `1.5` to `2` before the SQL body runs.

#### Posture and cost

`fn_natural_breaks_3` is **IMMUTABLE, PARALLEL SAFE, reads no table** (proven — no `FROM public.`,
no `now()`); `fn_blend_analysis` is **STABLE, SECURITY INVOKER**. Both pin `search_path = public`,
both revoke `PUBLIC` + `anon`, both grant **`authenticated` only** and **NOT `service_role`** (no
sync worker calls them, so `verify-worker-view-grants` stays at 4 views / 0 findings). Proven by
really calling them as `anon` and as `service_role` and requiring both to be refused (L-043: prove a
permission by assuming the victim's role).

**Cost, measured before any proof was written** (the 2026-09-14 rule — `set local
statement_timeout='5s'` then `EXPLAIN (ANALYZE, BUFFERS)`, 2026-09-21):

| call | time | buffers |
|---|---|---|
| `fn_natural_breaks_3`, 250 distinct values (31,125 candidate pairs) | **57.7 ms** | 754 |
| `fn_natural_breaks_3`, 1,000 values — the hard cap (499,500 pairs) | 726.5 ms | — |
| `fn_blend_analysis`, the owner's SAVED 24-block version | **39.5 ms** | 2,220 |
| `fn_blend_analysis`, LIVE over ALL 170 occupied blocks | **211.9 ms** | 2,931 |
| `fn_blend_analysis`, LIVE over a realistic 3 blocks | 43.2 ms | 3,023 |

**The candidate SEARCH runs on `double precision` prefix sums and every PUBLISHED figure is
recomputed in exact `numeric`, and that split is measured rather than stylistic:** a `numeric[]`
element is varlena, so `arr[k]` walks the array and the "O(1) per candidate" claim is false — the
identical function on numeric prefix sums took **279 ms** at 250 values against 57.7 ms on float8.
Cost is quadratic in DISTINCT values, so `fn_natural_breaks_3` refuses more than **1,000** outright
and the action caps a blend at **250** blocks; both bounds are by construction, since a blend cannot
hold more blocks than the yard has occupied ones.

#### The verify script reaches the functions through TWO probes, and why

They are `authenticated`-only by design and no verify script holds a user JWT — and worse,
**`service_role` holds NOTHING AT ALL on `blend_proposals` / `blend_proposal_versions`**, so the
script cannot even find out which saved versions exist. **`fn_blend_analysis_probe(proposal_id,
version_no)`** (both arguments required, so it is structurally impossible to point it at all of
history) and **`fn_blend_analysis_probe_cases()`** (the version index, capped at 200 with a
`truncated` flag, plus the degenerate and unmeasured cases **discovered from the grid**) are the
bridges — SECURITY DEFINER, `service_role` **only**, never `authenticated`, never `anon`. **Both
assert nothing**; every assertion lives in readable TypeScript, including a **brute-force oracle**
that re-derives the objective function so the optimality claim is a proof rather than a restatement.
They are deliberately NOT whole-database verifiers (the 2026-09-14 `fn_ops_ledger_verify()` incident
took the live site down). Both existing lens probes and the block-facts probe are **untouched**.

> Two sibling verify scripts had to be made MORE precise in the same changeset, not weaker:
> `verify-blocking-age-lens.ts` and `verify-blend-block-facts.ts` each sliced `actions.ts` from
> their own action **to end-of-file** to assert that no `canViewPrices` gate existed in it. That
> worked only while nothing after them carried one. `fetchBlendAnalysis` legitimately does — and its
> block comment names `canViewPrices()` in prose — so both now bound the slice at the file's own
> `// ─── <name> ───` section divider and additionally assert the slice did not leak.

### Blend analysis — UI + PRINT (2026-09-21)

> **THE DATA LAYER IS THE SECTION ABOVE.** This one is what the reader sees and what
> comes out of the printer. Proofs: `npx tsx scripts/verify-blend-analysis-ui.ts`
> (**97 assertions** — 82, plus 15 for the 2026-09-23 yard-map page), which is the UI twin of
> `verify-blend-analysis.ts`'s 71.

**What the owner asked for**, verbatim: *"in the proposals, when printing and viewing saved
blend proposals, add more pages that group and arrange blocks according to high priced and
low priced and average priced … Do another page that talks about mc, ash and bd as well.
Maybe even age? Maybe make those extras an option. Make sure the groups are tables with
footers that show totals or averages when appropriate … incorporating some of the logic of
our price lens into blend proposal to make it printable. In the lens section, would be nice
to also print some kind of summary based on the filter we set."*

#### THE PAGES ARE A PREFERENCE, NOT A PER-PROPOSAL FIELD

An **Analysis** button in the dialog header opens **Include pages** — three checkboxes
(Price groups · Quality (MC · Ash · BD) · Age), **all three ON by default**, stored per user
in `user_table_settings` under `module = 'blocking_blend_analysis'` through the same
`getUserModuleSettings` / `saveUserModuleSettings` pair the two lenses use (`useModuleSettings`,
exported from `lens/use-lens-settings.ts` — ONE storage implementation, two names, no new
table and no migration). The trigger shows the count, and the **Print** button shows `+N` and
says *"the blocks sheet plus 3 extra pages"* on its tooltip: a reader who ticked three pages
and got one sheet would have no way to tell whether the pages or the printer were at fault.

**The chosen pages render as SECTIONS below the Selected Blocks table, in the dialog's own
scroll, and as SEPARATE SHEETS in the print** — one payload, two surfaces, every word and
format shared through `blend-analysis-text.ts`.

#### THE PRICE PAGE IS GATED TWICE, AND THE GATE IS A DELETION EITHER WAY

`analysisPages(options, canViewPrices)` is the ONE place the stored choice meets the reader's
permission, and the flag it takes is the grid's **EFFECTIVE** one (`serverCanViewPrices &&
showPrices`) — so flipping the page's Prices toggle off removes the price page as surely as a
Production role does. Independently, the server has already DELETED `price` from the payload
(`price: null`, `pricesHidden: true`) while still returning `quality` and `age`, so there is
nothing to render even if a gate were missed. The price CHECKBOX is **absent**, not disabled,
for such a reader, and the sections say so once: *"Prices are not shown for your role."*

#### WHAT EACH PAGE SHOWS

| Sheet | Grouping | Tables | Footer |
|---|---|---|---|
| **Price groups — natural breaks** | the payload's `natural` | HIGH → AVERAGE → LOW; blocks priciest first | group SUBTOTAL (blocks · share · kg · weighted ₱/kg · value) + a grand FOOTER from `overall`, which **visibly equals the proposal's own raw blend price** |
| **Against market** / **Against set price** | the PRICE LENS's bands | priciest band first, labelled with the lens's OWN `priceBandLabel` + the reader's band names | band subtotal + grand footer |
| **Quality — MC** · **— ASH** · **— BD ASTM + BD JIS** | natural breaks per metric | **three SHEETS, one per metric**; **BD JIS is a COLUMN in the BD table, not a fourth table** (its groups are cut in different places, so its per-group average would describe a different population — only the blend's own weighted JIS is shown, in the footer) | subtotal with the kg-weighted reading + grand footer |
| **Age** | the AGE LENS's fixed day bands | oldest band first, oldest block first; block · batch · balance · age (1 dp) · first delivery · last delivery | band subtotal (weighted age) + grand footer (weighted age) |

#### ⚠️ ONE TABLE, ONE SHEET (2026-09-22)

The owner's print showed **a heading sitting at the bottom of a page above the TAIL of the
table before it**. The fix is structural rather than a nudge, and it lands in **BOTH** print
paths because the screenshot could not tell you which one he was looking at:

- **the HTML iframe path** — every analysis TABLE is now its own `<section class="apage">`, and
  `.apage { break-before: page }` does the rest. **There is no `<h3>` left**: a sub-heading
  inside a page was precisely the thing that could be stranded. Six tables therefore mean six
  sheets, asserted by counting `<section class="apage">` against `<table class="atab">` on a
  real payload and by requiring every sheet to open with its `<h2>`.
- **the PDF / autoTable path** — `analysisHeading()` calls `doc.addPage()` FIRST, every time,
  and is now called once PER TABLE (including inside the quality loop). The verify script
  asserts there is no other `addPage` in the analysis builder, so there is one rule and not two.

Group header + first rows still travel together as before (a `<tbody>` per group,
`break-inside: avoid` while it is small), and nothing uses a `<tfoot>`.

#### ⚠️ A CAPTION IS A LIST OF FACTS (2026-09-22)

The owner: *"I don't want descriptions like this, straight to the point, not wordy. **Apply to
all sections, not just price.**"* Every caption and method line in
`_shared/blend-analysis-text.ts` — and in the lens print — is now `<fact> · <fact> · <fact>`:

| line | reads |
|---|---|
| price groups | `Cut lines ₱38.97 · ₱44.50 · fit 97.6%` (degenerate: `One group`, or `Cut line ₱x · fit y%`) |
| against market | `Market ₱39.83 (Sep 2026) · ₱40 and up is above` |
| against set price | `Set price ₱45 · ₱45 and up is above` |
| quality | `Cut lines 9.84 · 11.23 · fit 89.6%` (+ `No reading: 2 blocks`, **only when non-zero**) |
| the snapshot gap | `Blend avg 2.13 · excl. no-reading 3.13` |
| age | `As of 2026-09-21 · cuts 60 · 120 · 365 d · oldest 444.5 d C-5B` |

Group and band LABELS are untouched. Three properties are asserted: the banned words
`naturally` · `minimise` · `dearest` · `spread` · `→` appear in **no emitted caption** (proven
over the OUTPUT of all six text functions, not by reading the source) and in none of the three
surfaces' own literals; no caption ends in a full stop; and the ORDERING prose ("Dearest band
first", "Oldest band first", "high → average → low") is gone, because the first row of a table
is not a fact that needs a sentence.

#### ⚠️ A TYPED FIGURE IS A SET PRICE, NEVER "MARKET" (2026-09-22)

`vsMarketHeading(typed)` and `priceBasisNoun(typed)` in `_shared/blend-analysis-text.ts` are
**THE one definition**, and the word *market* must not appear anywhere for a price the operator
typed: market is something MEASURED from deliveries, and calling a typed number by its name
would claim a measurement nobody made. Four surfaces read those two functions — the analysis
page heading, the HTML sheet's `<h2>`, the PDF's title, and the price lens itself (its bar
headline, its `Market is` / `Set price` popover label, that input's `aria-label`, the Customize
disclosure's "pesos from …" wording and the printed settings line, all through one derived
`basisNoun`). A MEASURED basis keeps "market" everywhere. The verify scripts assert the shared
functions are read rather than the label hardcoded, and that no typed-price string contains
`market` in any case.

**The reader's own lens settings drive all of it** — `priceEdgeOffsets` from the price lens's
saved cut lines, `ageEdgeDays` from the age lens's, both band-name documents, and the market:
a **typed** price sends `Math.ceil(typed)` as the cut line exactly as the lens does, while
every MEASURED basis sends nothing so the database compares a saved version with the market of
the month it was SAVED in. The caption then names that month.

**NULL IS NEVER 0, on every page.** An unmeasured (`unmeasured`) or undated (`undated`) block
is listed in a MUTED group with em dashes and is in NO group, out of every average and both
share denominators. When the honest figure and the blend's own stored figure disagree
(`equalsSnapshot === false`) the page prints BOTH and says which population each covers,
rather than picking a winner.

#### THE PRINT'S OWN RULES

The printout is still the one self-contained HTML document in a hidden iframe, A4 **landscape**
at a 10mm margin, `print-color-adjust: exact`. The analysis sheets are appended by
`buildBlendPrintDocument`'s fifth argument and carry: `break-before: page` per page;
`break-after: avoid` on every heading and caption; one `<tbody>` per group, with
`break-inside: avoid` only while the group is small (≤ 4 rows); **no `<tfoot>` anywhere**
(Chrome repeats one on every sheet, so a total in one reads as a duplicated total); a 7pt font
floor; and group tints from `lens/lens-ramp.ts`'s `rampRgb`, because the iframe cannot see
`globals.css`. `LENS_RAMP_RGB` is a deliberate second copy of the fourteen `--lens-hue`
triples, **PROVEN equal to `globals.css` by the verify script** rather than assumed — the
project's standing answer to a constant that must live in two places.

**The PDF carries the same pages**, built from the same payload and the same words through
`pdfText` (jsPDF's Helvetica is WinAnsi, so `₱` is spelled `PHP` and every cell is filtered),
with the subtotal and total as body rows for the same reason.

#### THE YARD MAP PAGE IN THE BLEND PRINT — ADDED 2026-09-23

Renzo: *"I'd also like to see a blocking view in the print of blend proposals, similar to
the ones we made for the lens prints."*

**"Similar to" is implemented as "IS".** The page is drawn from
`lens/lens-yard-map-model.ts` — the same geometry (`WAREHOUSES` through
`buildYardMapCells`), the same one-page solve (`solveYardMapFit`), the same PRINT palette
(`LENS_PRINT_FILL_RGB` via `printFillRgbAtStop`), the same ink rule (`lensYardMapInkOn`,
which on that palette always answers near-black) and the same four cell kinds
(`lensYardMapPaint`). `_shared/blend-yard-map-print.ts` adds two decisions and the HTML;
nothing about the yard's shape or the cell size is stated a second time, and the verify
script asserts the module contains no `WAREHOUSES`, no `fitCellGrid`, no `a4LandscapeBox`
and no slot literal.

**What MOVED to make that possible** (and it is the only thing that moved): the page
geometry constants and the two-stage fit left `lens/lens-yard-map-print.tsx` for the
model, because the lens sheet is a React component laying out in the live DOM while the
blend printout is a self-contained HTML string in an iframe and a jsPDF page — neither can
render the other. `buildLensYardMap` is now a two-line wrapper over the shared
`buildYardMapCells` core, so **the lens prints' output is unchanged by construction rather
than by inspection**; `verify-blocking-lens-ui.ts` stays at **228 assertions**, with two of
them restated to look for the solve where it now lives (and strengthened: the sheet is
additionally proven NOT to own a second copy).

**WHERE IT LANDS:** its own sheet, **directly after `Selected Blocks` and before the
analysis pages**, in BOTH print paths — it describes the block list rather than analysing
it. Measured on the `blendanalysis` rig by driving the REAL Print and Download buttons in
headless Chromium (zero console errors): with the Price page ON, **9 pages in both paths**
— *head · Selected blocks · **Yard map** · Price groups · Against market · MC · ASH · BD ·
Age* — and at `?prices=0`, **7 pages in both paths**, the map still **page 3**. The two
documents agree page for page because they consume the same model.

**⚠️ THE CHROME BUDGET IS THIS SHEET'S OWN, AND THAT WAS MEASURED THE HARD WAY.** The lens
map reserves **40 px** for its heading and legend; this one also carries an as-of caption
and a footnote, and at 40 px the first draft laid out **764.70 px against 718.11 px of
printable height — 46.59 px over**, so its legend printed on a **second sheet**.
`break-inside: avoid` cannot fix that: Chrome cannot avoid breaking what does not fit. So
`solveYardMapFit` gained an optional `reservedHeightPx` (**defaulting to the lens budget,
so the lens pages are untouched**) and `blendYardMapReservedPx()` states what this sheet
actually spends — measured in a real print-media render: `<h2>` 19.80 + 1 px, legend 14.00
+ 3 px, a footnote line 14.00 px **budgeted at TWO so a long block list that wraps cannot
push the page over**, plus 4 px of rounding slack. **Both print paths read that one
budget** (`blendYardMapSolve(model, marginMm)`), which is what lets the jsPDF file print at
its own 40 pt margin without a second copy of the arithmetic. Two things also FOLDED to buy
the cells their size back: the caption rides ON the heading line in the house
`<fact> · <fact>` style, and the two footnotes join into one — budgeting them separately
cost **5.5 px off every cell row** (33.65 px cells with PCA/PCB in, against 37.0 px folded).

**THE COLOUR RULE**

| Cell | Fill |
|---|---|
| a SELECTED block, Price groups page ON and its payload present | that block's own natural-breaks group — **low / average / high → the cost ramp's stops 0 / 3 / 6**, resolved by the same `resolveBandRampStop` the analysis tables use, with a three-entry legend (`LOW · AVERAGE · HIGH`, the words `groupWord()` already owns) |
| a SELECTED block otherwise (page off, price-denied, or the analysis has not arrived) | **ONE accent — the cost ramp's MIDDLE stop 3** (the amber tint `249 201 118`, 13.64:1 against black), legend `Selected block`. The middle on purpose: stop 0's emerald would read "cheap" and stop 6's rose "dear" on a map making no price claim. The stop is STATED on the band (`rampStop`), because a single band at position 0 would otherwise inherit the ramp's cheapest colour |
| any OTHER occupied slot | the lens map's light neutral grey, loc small and dark — the `muted` kind, **with NO dash**, because "not selected" and "we could not place it" are different answers and only the second draws one |
| an EMPTY slot | white with a hairline and a small muted loc |
| **a SELECTED block the yard NO LONGER HOLDS** | the selection fill **plus a dashed inset outline** (the supplier lens's mixed-marker technique, in the ink rather than the hue), a legend entry `dashed = no longer occupied (N)`, and a footnote NAMING the blocks. It is **never dropped** — the proposal said that block, and a map that omitted it would quietly describe a different blend |

**Nothing is computed.** Group membership is a LOOKUP over the payload's own
`price.natural.groups[].blocks[]`; the map carries no kilogram, no ₱, no age and no lab
reading, and the verify script runs the no-`reduce` / no-`+=` / no-`* 100` / no-division
scan over the module.

**THE CAPTION IS THE HONEST PART.** The occupancy is **today's** (it comes from the live
grid payload, handed down as the dialog's new `occupiedLocs` prop — `Object.keys(data)` in
`blocking-grid.tsx`) while the SELECTION is the day the version was proposed. So a saved
version's map reads `Yard occupancy as of today · selection as saved 2026-09-21` (the date
is the snapshot's own `computed_at` through `blendComputedDate`, never the print clock) and
the live modal's reads `Yard occupancy as of today`. Without that line a reader could not
tell whether a grey cell means "fed out since" or "never in the blend".

**THE FOURTH OPTION.** `Yard map` is the fourth **Include pages** checkbox, **default ON**,
persisted in the same `user_table_settings` document through the same untrusted per-field
parser — which is why it needed no migration and no backfill: a document written before it
existed simply says nothing about it, and the parser reads that as the shipped default.
`serializeBlendAnalysisOptions` still omits defaults, so `parse ∘ serialize` is the identity
on all **sixteen** states. It is deliberately **NOT** in `BLEND_ANALYSIS_PAGE_ORDER` and
`analysisPages()` never returns it, and three correct things follow from that one fact: it
renders no on-screen section (print only), `buildBlendAnalysisPages` never builds it, and
**`wantsAnalysis()` stays FALSE when it is the only page ticked**, so a reader who wants
only the map pays no analysis round-trip. It is **NOT price-gated** (it carries no ₱) — a
price-denied reader keeps the map and gets the single accent. The Print button's `+N` is
`includedPageCount()`, THE one definition: 4 with everything on, 3 for a denied reader.

**ONE PAGE, STRUCTURALLY.** `.ymap` carries `break-before: page` **and**
`break-inside: avoid` (+ the legacy `page-break-*` twins), and it deliberately does **not**
wear `.apage`: that stylesheet rides only when there ARE analysis sheets, and the map may be
the only extra sheet a reader ticked. `BLEND_PRINT_MARGIN_MM` (10) is stated once and read
by the document's `@page` rule AND by the solve, so the sheet cannot lay out against a
different box than it prints on.

**THE jsPDF PATH DRAWS THE CELLS NATIVELY — rectangles and text, never a rasterised
screenshot.** There is no DOM to photograph (the PDF is built from the payload in a pure
function that also runs in Node) and the project has no html2canvas; more to the point the
map IS rectangles and five-character labels, so drawing them keeps the text selectable and
the file small — the same reason `buildBlendPdf` exists rather than screenshotting the
modal. It consumes the **same `BlendYardMapModel` object** the HTML sheet does (built once,
in the dialog) and the **same `solveYardMapFit`**; the only thing it adds is the unit
conversion, `PT_PER_PX = 72/96`, since the solve works in CSS px at 96 dpi and jsPDF in
points. Its box is solved against the document's own `marginX`, converted to mm, so the
drawing and the arithmetic cannot disagree. The dashed marker is `setLineDashPattern`, and
the legend rows come from the shared `blendYardMapLegend`.

#### THE LENS SUMMARY PRINT — REDESIGNED 2026-09-22

A **Print** button on the Highlight legend bar prints the ACTIVE lens as configured — see
`lens/lens-summary-print.tsx` and `lens/lens-summary-model.ts` in Files. It is the PLATFORM
print kit (`GroupPrintStage` + `printCard` + `buildPrintPageRules`, portalled to `<body>`), the
sheet is explicitly light, band ISOLATION is respected and stated (`Showing 2 of 4 bands`), and
the footer's figure cell is labelled **`avg of priced`** / `avg of dated` because the price
lens's weighted total covers the priced population while its counts cover the whole yard. **The
button is ABSENT on Price for a reader without the effective price flag** (the panel itself
renders nothing without it) and **present for every role on Age and Supplier** — the Age sheet
carries no money at all, and the Supplier sheet carries exactly one ₱ column, which is the thing
that goes away for such a reader rather than the button (see the next subsection).

The owner's review of the live sheet asked for four changes, and all four landed:

1. **THE TITLE IS THE LENS'S NAME** — exactly `Price lens` / `Age lens` / `Supplier lens`, with
   no blurb and no subheading. (*"It should just be called price lens. No AI-slop
   description/subheading."*)
2. **ONE TERSE SETTINGS LINE** under it, in the same `<fact> · <fact>` style the analysis
   captions moved to the same day — e.g. `Set price ₱46 · ₱46 and up is above set price ·
   cuts −1 · market · by kilograms · printed 2026-09-22 09:04`. The sheet appends the stamp, so
   a lens never has to know the clock.
3. **THE BAND TABLE AND THE RATIO BAR ARE KEPT** unchanged in shape. (*"I like the ratio bar,
   keep that."*)
4. **THE THREE-COLUMN BLOCK LISTS ARE GONE.** Each band now gets its **own page** carrying ONE
   FULL-WIDTH TABLE **grouped by WAREHOUSE** in the grid's own order (A · B · C · D · PCA · PCB,
   then a trailing `Other`), with columns `BLOCK · BATCH · BALANCE kg · MC · ASH · BD ASTM ·
   BD JIS · GRIT · VM · FC · <the lens's figure>`. (*"I don't like the three-column groupings —
   subgroup what fits each band by WAREHOUSE location; spanning multiple pages is fine because
   you can fit more lab analysis data."*)

**The lab readings are READ, never computed.** They come off the grid payload the page already
holds (`view_blocking_grid` rows), joined by `block_loc`, formatted once to the Excel Standard
(BD 3 dp, everything else 2 dp) in `lens-summary-model.ts`. A **WAREHOUSE SUBTOTAL** originally
carried its block count and its kilograms and left **every lab cell BLANK** — a kg-weighted MC over
a partition SQL never computed would have been a second definition of a lab average living in
TypeScript, and a blank cell says "not published" where a computed one would say something untrue.
**Those cells are filled in now, by SQL — see "THE SECOND PASS" below.** The **BAND TOTAL** beside
it has always been the payload's own.

**The one sum, and its exemption.** `lens-summary-model.ts` holds the only accumulation in the
whole lens directory — the warehouse kilogram subtotal — and is deliberately absent from
`verify-blocking-lens-ui.ts`'s no-sum list. The payload publishes no figure for "band 2's
kilograms in warehouse C" at any grain, so that sum has nothing it could disagree with; the fold
is proven to tie back to the band's own published kilograms by a real run of the bucketing over a
synthetic grid, and a weighted average remains flatly banned.

**Paging.** Page one is the title, the settings line, the band table, the ratio bar and — since the
second pass — the lens's own CONTEXT BLOCK; **page two is the YARD MAP** (below); then the BLOCK
pages (one per band, or one per *(band × warehouse)* on the price sheet — see below), and one more
for the excluded population when there is one. A warehouse group is one `<tbody>` with
`break-inside: avoid` while it is small (≤ 6 rows) and its heading row carries `break-after: avoid`,
so a big group may split without stranding its title. No `<tfoot>` anywhere, landscape A4 at 10mm,
**and the sheet's own type floor is 7px** (it prints from the LIVE DOM, so its sizes are Tailwind
`px` rather than the `pt` the iframe prints use — §13 asserts no printed label falls below it).

#### THE SECOND PASS — THE PRICE SHEET'S THREE CHANGES (2026-09-22)

The owner's review of the live sheet asked for three more things. **All three are PRICE-SHEET ONLY,
and that is asserted rather than hoped** — the age and supplier sheets render the same table
component with the same columns, the same widths and the same decimals they always did, because the
model fields that switch these on are OPTIONAL and neither of those two panels passes them.

**1. ONE PAGE PER WAREHOUSE INSIDE A BAND.** Each `WHSE X` heading starts a fresh sheet, with the
band heading repeating above it as a small running line (`.lens-print-band-run`, `break-after:
avoid`), because a page whose only heading is `WHSE C` does not say which band's `WHSE C` it is.
Turned on by `warehousePages: true` on the print model. **The FIRST warehouse of a band rides the
band's own `break-before: page`** and only the later ones take `.lens-print-whse-page`, or every
band would open on a blank sheet. The **BAND TOTAL rides the LAST warehouse's page**, so it is
stated exactly once per band and a reader reaches it by finishing the band rather than turning back.
The EXCLUDED population is deliberately NOT paged this way — it is one short list of blocks the lens
cannot place, and a page each would be a page each for a handful of rows.

It is a real trade (a three-band lens over four warehouses prints twelve block pages instead of
three) and it is the right one HERE because the price sheet now carries a supplier column and seven
weighted subtotal figures per warehouse, so a warehouse group is a self-contained table a reader
takes to the yard. **The `countLabel` follows the paging** — `blockPageCount()` counts per
*(band × warehouse)* when the flag is on — because a count that still said "one page per band"
would be the first thing to go stale.

**The heading is said ONCE.** Measured on a real PDF: with the `<h2>` above and the table's own
`lens-print-whse-head` row both rendering, `WHSE A 10 BLOCKS · 1,047,000 KG` printed twice, one line
apart. The in-table row is what separates one warehouse from the next in the MERGED tables, so it is
a flag (`showWarehouseHeadingRow`, default **true**) rather than a deletion, and only the paged path
turns it off.

**2. THE WAREHOUSE SUBTOTAL'S LAB CELLS ARE FILLED IN — BY SQL.** They were blank on purpose (see
just above); `fn_blocking_price_lens` gained `warehouse_subtotals[]` (migration `20260922093000`),
so the cells became a **LOOKUP** keyed `(bandIndex, warehouse)` and the BAND TOTAL reads its band
row the same way. **The rule did not move — the sheet may RENDER a figure, it still must not COMPUTE
one.** `buildLensGroupFigures` formats what SQL published and the only arithmetic in it is a
COMPARISON; §13 proves that by running it over two groups with the same means and different
kilograms and requiring identical strings.

- **NULL prints an EM DASH, never a 0.** `avg_ash = 0` on the grid means "these deliveries carry no
  ASH figure" — the L-008 placeholder in a lab coat — so SQL excludes the block from the mean and
  publishes NULL. A 0 in a *coverage weight* is a real 0, because zero measured kilograms is a
  measurement.
- **A COVERAGE NOTE names only the stats SHORT of the group**, with their kilograms
  (`ash over 800,000 kg · bd astm over 800,000 kg`), and is empty when every stat covers all of
  them. Each stat has its OWN coverage and they genuinely differ — measured 2026-09-22, all 170
  occupied blocks carry MC while 11 read 0 on ash, both BDs, grit, VM and FC — so one shared "lab
  kg" would be wrong for MC or wrong for the other six on every group in the yard. A stat with NO
  mean already prints a dash, so it is never *also* given a note.
- **A lens with no such published partition passes no `figures` and prints the blank row it always
  did.** The fallback lives in ONE component (`LabCells`), so a subtotal and a band total can never
  disagree about what a missing figure looks like. That is exactly what the AGE and SUPPLIER sheets
  get.

**3. A SUPPLIER COLUMN PER BLOCK, between BATCH and BALANCE.** `Ornales` when the block is the whole
pile, `Paquibot 63%` when it is MIXED, an **em dash** when the batch has no delivery row at all
(NULL — never a placeholder and never `false`; the three payload fields move together). It reads
`blockByLoc[loc].dominantSupplierDisplay` / `.dominantSharePct` / `.isMixed` — **the ALL/SOME rule
is a carried COLUMN and is never re-derived from a list length.** Switched on by
`blockSupplierColumnLabel`; **omitted means the column does not EXIST**, not that it is empty, which
is what keeps the other two tables at their original shape. The table is re-fitted to **exactly
100%** in that mode (7 + 15 + 13 + 10 + 7 × 6.5 + 9.5) as a SEPARATE width table, so `table-fixed`
has nothing to redistribute and no column silently crushes — §13 sums both tables and requires 100.

The supplier sheet gets no such column because its per-block column already IS the supplier, and the
age sheet gets none because its payload carries no supplier fact at all.

#### ⚠️ THE SUPPLIER BAND TABLE'S LAST COLUMN — `₱/KG`, OR `MIXED` (2026-09-22)

Renzo, on the live supplier sheet: *"I don't get the last column — 'kg dominant' — kind of
useless. Replace it with average weighted price or something."* He was right: a band row already
carried **BLOCKS** and **KG**, so a third kilogram figure beside them (`4,542,073 kg dominant`)
said nothing a reader could act on.

**The column is now `kgWeightedPhpKg`** — the band's kg-weighted mean of the grid's own per-block
₱/kg, over the blocks it DOMINATES — in the Excel Standard's **accounting** layout (₱ pinned left,
number pinned right, `tabular-nums`, four decimals as SQL publishes them), with the footer carrying
the whole yard's figure and the qualifier **`avg of priced`**, word for word the price lens's, and
for the same documented asymmetry: the counts cover every occupied block, the price covers the
priced ones. **Read the data-layer section's "THE WEIGHTED ₱/kg — what it IS, and what it is NOT"
before labelling this column anywhere**: it is the price of the blocks a supplier DOMINATES, never
"what we paid ORNALES" — no per-supplier ₱/kg exists in the database, and on a mixed block every
supplier in it shares one price.

**FOR A READER WITHOUT THE EFFECTIVE PRICE FLAG THE COLUMN IS ABSENT — not blank, not ₱0.** It
heads **`MIXED`** instead and carries `mixedBlockCount` per band and for the yard, so the table
keeps its width and a Production reader still gets a last column worth reading rather than a row of
em dashes. The footer's `avg of priced` goes with it: a `Mixed` column counts exactly what its
header says and needs no qualifier. **Nothing else on the sheet moves** — the title, the settings
line, the band rows, the ratio bar, the yard map, the per-band tables and **the Print button itself**
are all unconditional, because the rest of this payload is peso-free and Production is the role that
walks the yard.

**The decision reads BOTH halves, and neither alone** — `caps.canViewPrices && !lens.pricesHidden`,
in one place (`showPrice`, and recomputed as `priced` inside the print memo so the memo depends on
the flag rather than on a value that changed shape). The cap is the grid's EFFECTIVE flag
(`serverCanViewPrices && showPrices`), so flipping the page's own **Prices** toggle off takes the
column away exactly as being Production does; `pricesHidden` is the payload's own statement that the
two ₱ keys were **WITHHELD rather than absent**, which is the only way to tell that apart from a band
that dominates no priced block. **A null prints an em dash and never ₱0** — the L-008 placeholder
mistake in its fifth costume.

**`dominantKg` did not disappear — it moved to the settings popover's detail line**, which now reads
`78 blocks dominant · 4,542,073 kg dominant · 4,397,468 kg apportioned · ₱43.5690/kg · 11 mixed`. It
is still the attribution the grid TINT is drawn from, so it has to stay legible somewhere, and the
popover is where a reader goes to ask what a colour means.

**The shared sheet learned a shape, not a currency.** `LensPrintAccounting` (`{symbol, amount}`,
both the LENS's own preformatted strings) is an OPTIONAL `figureAccounting` beside the plain `figure`,
and `bandFigureColumnLabel` is an optional second heading that falls back to the per-block
`figureColumnLabel`. The price and age lenses supply neither — their band column and their per-block
column genuinely are the same figure at two grains — so **their sheets are byte-for-byte what they
were**, asserted. `lens-summary-print.tsx` still formats nothing: no `toFixed`, no `toLocaleString`,
and not one `₱` glyph in the file.

**Measured on a REAL PDF** (headless Chromium driving the actual Print button on
`/dev/table-playground/supplierlens?pca=1`, 9 pages, A4 landscape, zero console errors), the band
table's header row reads — price-visible —
`BAND · BLOCKS · KG · SHARE · ₱/KG` with `Ornales … 41.8% ₱ 43.5690` and a
`Whole yard … 100.0% ₱ 29.0405` footer over `avg of priced`; and at `?prices=0`,
`BAND · BLOCKS · KG · SHARE · MIXED` with `Ornales … 41.8% 0 mixed` and `Whole yard … 11 mixed`,
no qualifier line. The rig's `?prices=0` drives the payload itself (both ₱ keys nulled,
`pricesHidden: true`), which is what makes the `MIXED` shape reachable at all — before this it only
dropped the PRICE lens from the tab strip.

#### THE YARD MAP PAGE — ADDED 2026-09-22

Renzo, looking at the blank lower half of page one: *“within this page or maybe the next page,
I'd like to see the actual block arrangement in our app to be printed in SOLID colors. This is
purely for location reference, so make the block loc (C-19A, etc.) right in the middle and in BIG
font so it can be fully seen in the print. Make sure it shows ALL blocks in one landscape page.”*

It is on **ALL THREE lenses**, built by `lens/lens-yard-map-model.ts` and drawn by
`lens/lens-yard-map-print.tsx` — see both in Files. **The MODEL is shared with the BLEND
PROPOSAL print since 2026-09-23** (its core `buildYardMapCells`, the page geometry constants
and the two-stage solve `solveYardMapFit`, which moved out of the sheet so a non-React print
path could read them) — see "THE YARD MAP PAGE IN THE BLEND PRINT" below; the lens pages'
own output is unchanged.

**IT IS PAGE TWO, AND THAT WAS MEASURED RATHER THAN PREFERRED.** He offered page one *or* the
next page. Page one's band table is **data-sized** — two bands on a default price lens, up to
seven, up to thirteen on the supplier lens — so a map sharing it would be legible or not
depending on how many cut lines the reader had added. Measured on A4 landscape at a 10mm margin
(718.11 px of printable height): sharing page one leaves ≈518 px once a four-band table and the
bar are in, which solves to a **35.8 px cell at 8.2 pt** with the standard warehouses alone and a
**26.4 px cell at 5.8 pt** once PCA/PCB are in — below the print kit's 7 pt floor. On its own
page the same solve gives **51.53 px (13.64 mm) at 11 pt** and **39.14 px (10.36 mm) at 10 pt**.
`.lens-print-yardmap` carries `break-before: page` **and `break-inside: avoid`**, so “all blocks
in one landscape page” is structurally true, not merely usually true.

**THE GEOMETRY IS THE GRID'S OWN, AND THERE IS NO SECOND COPY OF IT.** Sections come from
`../constants`'s `WAREHOUSES` and each slot key is built the way `blocking-grid.tsx` builds it
(`<whse>-<col><row>`); a literal `220` / `238` appears nowhere in either file and the verify
script asserts it. **PCA/PCB are opt-in INDEPENDENTLY**, exactly as their two filter chips are on
screen: each is drawn iff the grid payload holds a block in it. They **share ONE lane** (side by
side) rather than taking a lane each — three columns wide, a lane apiece spends two full rows of
the height budget on 18 slots and shrinks every other cell on the page from 51.5 px to 28 px.

**FOUR CELL KINDS, AND “GREY” IS TWO OF THEM.**

| Kind | When | How it prints |
|---|---|---|
| `banded` | occupied, in a band the sheet is SHOWING | the band's **PRINT** fill at **FULL opacity** from `LENS_PRINT_FILL_RGB` — a pale tint of the screen hue, not the grid's 22% wash and not the screen saturation — with the loc centred in bold |
| `muted` | occupied, in a band the reader ISOLATED OUT | light neutral grey. The map matches the tables' *“Showing 2 of 4 bands”*; a map that painted the hidden bands would describe a different filter |
| `nodata` | occupied, in NO band (unpriced / undated / unattributed) | the same grey **plus a small `—`**, because *“we don't know”* and *“not selected”* are different answers. Painting it as the cheapest/newest band is the L-008 mistake again |
| `empty` | no block in the slot | white with a hairline and the loc in small muted text — location reference matters for the empty slots too |

A **MIXED** block (supplier lens only, from the view's carried `isMixed` column) keeps its dashed
**inset** outline. On the grid `.lens-cat-mixed` dashes in `var(--lens-hue)` over a 22% wash of
that hue; over a SOLID fill of it the dash would be invisible, so on paper it takes the ink.

##### ⚠️ THE FILLS ARE A **PRINT** PALETTE, NOT THE SCREEN RAMP (2026-09-22, second pass)

Renzo, on the first live map: *"verify these are easy to read when printed on lower-quality
printers. Use simple colours that contrast well from BLACK text — don't use dark colours that clash
with black."* He was pointing at a real defect. `LENS_RAMP_RGB` is the SCREEN ramp and on screen it
is only ever seen as a **22% wash**; the map painted it SOLID, which put **12 of its 27 stops**
below the white/black contrast crossover, so the loc flipped to **WHITE** on about half the map —
and white on deep fuchsia off a tired office laser is precisely the case he was asking about.

So `lens-ramp.ts` gained a **second table**, `LENS_PRINT_FILL_RGB`, read through
`printFillRgbAtStop`, and **every cell AND every legend swatch on this page reads it** — a legend in
the screen saturation beside a pale cell is a legend that describes a different map. The BAND TABLE
on page one keeps the saturated `.lens-cat-N` class, because a pale tint in an 8px table swatch
reads as nothing at all; the two are matchable because **every print fill is a WHITE TINT of its own
screen hue** (`white + t × (hue − white)`), so the hue ANGLE is preserved — measured **max deviation
0.79°** across all 27 stops, asserted ≤ 2°.

**Three properties, all measured, all asserted in `verify-blocking-lens-ui.ts`** (so a future
palette edit fails the check rather than landing quietly on paper):

1. **BLACK INK ALWAYS, at ≥ 7:1.** The worst fill on the whole table is **7.75:1** against black
   (`age` stop 6, the deep-fuchsia tint, L 0.3377); `cost` stop 6 is next at 7.81:1 and the best is
   18.66:1. Every entry sits between **1.9× and 4.9× the crossover**, so `lensYardMapInkOn` — still
   THE one ink rule, kept rather than replaced by a hardcoded black because the ink is a FUNCTION OF
   THE FILL and a cell, a legend swatch border and a mixed block's dashed outline must all reach the
   same answer — returns near-black for every fill the map can produce, and **its white branch is
   structurally unreachable here**.
2. **THE SEQUENTIAL RAMPS STAY MONOTONIC IN TONE.** A greyscale print loses the hue and keeps the
   tone, so "dearer" / "older" must stay readable as "darker". `cost` and `age` both descend
   **strictly** across all seven stops — L 0.8799 → 0.3403 and 0.8831 → 0.3377 — with a minimum
   adjacent gap of **0.0751** / **0.0780**, past the ~0.06 a cheap mono printer needs.
3. **THE NOMINAL RAMP IS DELIBERATELY FLAT.** All twelve categorical tints sit at **L 0.6973 …
   0.7027** (a 0.0054 spread) with the neutral `others` alone at **0.5800**, because a supplier is
   not "more" than another supplier and a tone gradient would invite a reading that does not exist.

**THE STATED CONSEQUENCE, and it is a real limitation rather than a caveat for form's sake: in
GREYSCALE the twelve supplier hues are indistinguishable from one another.** They are told apart by
the **legend**, by the **block loc printed in every cell**, and — for a mixed block — by the
**dashed inset outline**. Measured on a 150 dpi greyscale rasterisation of a real printed page
(`pdftoppm -gray -r 150`): the twelve render at 8-bit greys **211–222** (sky 212, teal 211, amber
217, fuchsia 218, violet 220, rose 221 — about 4% of the range apart, i.e. one tone), while `others`
renders at **201** and an empty slot at **255**, both plainly separate. Every loc reads, and the ink
is `#18181b` on every occupied cell without exception.

**Two pairs therefore rely on the legend rather than on tone, and both are stated rather than
papered over:** the twelve categorical hues among themselves (above), and — **only when a reader
configures SIX or SEVEN price/age bands, never in a default configuration** (3 price bands / 4 age
bands use stops 0,3,6 and 0,2,4,6) — ordinal **stop 1** against the map's muted grey, ΔL **0.0220**
/ **0.0196**. The twelve are separated from that same grey by only **0.0748 … 0.0802**, which clears
the 0.06 floor but not by much; from the neutral `others` by 0.1975, and from an empty slot's white
by ~0.30.

**The threshold itself is not a taste value:** **`sqrt(1.05 × 0.05) − 0.05 ≈ 0.1791`** is the
luminance at which white-on-fill and black-on-fill have the SAME WCAG contrast ratio, so taking the
side with more contrast is optimal by construction. The verify script proves the chosen ink wins on
contrast for **every hue all three ramps declare** — print table and screen table both — and
separately that neither map file so much as mentions `rampRgbAtStop` / `LENS_RAMP_RGB`, since that
one-word edit is what would silently put white ink back on half the map.

**THE FIT IS THE PLATFORM SOLVER, AND WRAPPING BEATS SHRINKING.** `fitCellGrid` solves ONE square
cell edge against both budgets (`min(width ÷ (20 cols + gutter), height ÷ (cell rows + lane
chrome))`) and the smaller wins. A label that still does not fit has two outcomes, and the page
takes the better one: **below `LENS_YARD_MAP_MIN_LOC_PT` (9 pt) every loc is WRAPPED at its
hyphen instead of shrunk** — measured, the PCA/PCB shape solves to 8.5 pt on one line and **10 pt
on two**, so the wrap makes the loc bigger. A multi-letter warehouse (`PCA-15A`, seven characters)
always wraps. **Nothing is ever truncated** — the owner's requirement is that the loc “can be
fully seen”. The height budget subtracts the `nodata` dash, so the one cell carrying a warning
cannot clip it.

**The mono advance is 0.65, not RC Movement's 0.6, and the difference was a real bug.** A map
cell's loc is `font-bold` and the bold face is wider: measured in a browser over a 100-character
run of `A-10A`, regular **0.6039**, bold **0.6298**. Budgeted at 0.6 the five-character locs
(`A-10A`, `B-10A`, `D-10A`) overflowed and the browser wrapped them mid-code — visible in the
first PDF this page produced.

**IT CARRIES A LOCATION AND NOTHING ELSE.** No batch code, no balance, no ₱, no age, no supplier
name, no lab reading; *“purely for location reference”* is the whole specification, and it is also
what leaves the cells big enough to read. Every figure about a band still lives on page one and in
the per-band tables. Because there is no money on it, **the map needs no price consideration of its
own on any of the three lenses** — the price lens's whole Print button is already behind the
effective price flag, the age sheet carries no ₱ anywhere, and the supplier sheet's one ₱ column
lives on page ONE's band table, not here (it swaps to `MIXED` for a price-denied reader; the map is
identical either way).

**Two things it cannot draw, and says so rather than hiding:** an occupied block whose `block_loc`
is not a slot on this layout is NAMED under the map (the trailing `Other` warehouse group's
discipline), and a fit that ever failed would print a sentence instead of a cropped yard.

**Measured on REAL PDFs** (headless Chromium driving the real Print button on
`/dev/table-playground/supplierlens`, `pdfinfo` + a 300 dpi rasterisation of page 2), 12 cases =
3 lenses × PCA/PCB absent|present × isolation off|on: the map is **exactly one page in all 12**,
220 slots drawn standard / 238 with PCA/PCB, cell **51.53 px (13.64 mm) at 11 pt** and **39.14 px
(10.36 mm) at 10 pt**, zero console errors, and page 3 is the first band's table in every case.
The rig's `?pca=1` is what makes the worst case reachable.

**Re-measured after the PRINT palette landed** (same harness, `?pca=1`, price-visible and
`?prices=0`): **9 pages, A4 landscape 841.92 × 594.96 pt, zero console errors**, page 2 the map,
page 3 the first band. A 150 dpi **greyscale** rasterisation of page 2 was then read back: all 34
occupied locs legible, ink `#18181b` on every one of them, the twelve supplier tints at greys
211–222, `others` at 201, empty slots at 255. **Note for anyone re-running this**: `printCard`
clears its own marks on `afterprint` and again after 1000 ms, and headless Chromium fires
`afterprint` on a no-op `window.print()` — so a harness must stub `window.print` and neutralise
those timers before clicking, or `page.pdf()` captures the SCREEN instead of the sheet.

#### PAGE ONE'S CONTEXT BLOCKS — ADDED 2026-09-22

Page one held the title, the settings line, the band table and the ratio bar, and then **half a
sheet of nothing**. The owner, on each lens in turn: *"maybe a deliveries price for the year — an
indication of what the market price is"* (price) and *"utilize the existing price-to-volume graph /
area graph; a table that shows the direction of price per supplier and its relationship with the
volume delivered"* (supplier).

**The shared sheet learns NOTHING about either.** `page1Extra` is a `React.ReactNode`, not a model:
`lens-summary-print.tsx` still formats nothing, spells no currency glyph and knows no market series,
and §13 asserts it never learns the words *market*, *quarter*, *correlation* or *premium*. **A lens
whose context read refused, errored or has not landed passes nothing and page one is exactly what it
was** — a section of empty cells would say the market has no price, which is a different and untrue
statement.

**Both reads are PRINT-ONLY and neither is load-bearing.** They sit in no signature and no
dependency of the classify effect, so they can never delay, cancel or re-trigger a band read; a
failure is swallowed **silently on purpose** — no spinner, no banner, no toast — because nothing on
the screen is waiting on them and an `errorToast()` a reader cannot act on is noise. (The project's
error rule governs errors a user must see; this is a print enrichment that either appears or does
not.)

##### THE PRICE SHEET — `MARKET` (`lens-market-print.tsx`)

`fetchBlockingMarketContext(12)`, fired **ONCE on mount** (empty dependency list): the series is a
fact about deliveries and does not move when a reader drags a cut line, so re-reading it per
settings change would buy nothing and cost a round trip.

A TABLE on the left, a CHART on the right — **measured, not preferred**: the table runs to 19 rows
and the chart is 132 px, so stacking them pushes a seven-band lens's page one onto a second sheet.
Side by side, page one holds, and **the map is still page two**.

- **The table** — one row per month the payload HAS a row for (`MONTH · PHP/KG · KG · DLV · SUPP`),
  then each quarter those months span with the current one flagged `(CURRENT)`, then `YEAR TO DATE`
  and `TRAILING 12 M`. Quarter and span rows carry no supplier count, so that cell is **empty, not
  a zero** — the payload publishes it per month only. A PARTIAL quarter at the window edge says
  `2 of 3 months`, because a one-month group labelled "Q2" reads as a full quarter.
- **THE BASIS'S OWN ROW IS HIGHLIGHTED, and which row that is comes from the basis's OWN window
  anchor** — a calendar month's `fromDate` IS that month's first day, so no date arithmetic happens
  in the panel. `this_quarter` highlights the quarter flagged `isCurrent`. **`last_3_months`,
  `trailing_days` and a TYPED price highlight NOTHING**: they are aggregates this table carries no
  row for, and inventing one would put a figure on the sheet that no view publishes. The caption
  names the basis instead.
- **The chart** is the same twelve monthly ₱/kg as a line, with the lens's own basis drawn as a
  **dashed near-black reference level** — which is the comparison the owner actually asked for. A
  month with kilos but no priced kilos **breaks the line** rather than being drawn at zero.

##### THE SUPPLIER SHEET — `PRICE VS VOLUME` (`lens-supplier-market-print.tsx`)

`fetchBlockingSupplierMarket(12, bandKeys)` — small multiples, one panel per named band supplier
(kilograms as an AREA, ₱/kg as a LINE, up to six), then a table listing **every** supplier the
payload returned: `SUPPLIER · KG · PHP/KG WTD · FIRST → LAST · CHANGE · DIR · VOL % · CORR · PREM`,
with a footer putting the SELECTION's own total beside `windowTotal` so a row is comparable to the
market and not only to its neighbours.

- **⚠️ EACH PANEL SCALES TO ITS OWN RANGE, and the caption says so.** The live yard's suppliers
  differ by two orders of magnitude (ORNALES 5.6M kg against LAYUPAN's 2.84% share), so a shared
  volume axis would flatten every small supplier onto the baseline and answer nothing about its
  direction — which is the question. Per-panel autoscale with the axis numbers PRINTED is the honest
  trade.
- **`others` IS NOT A SUPPLIER**, so it has no panel and no row: the fold has no key, the market
  view is keyed on real canonical suppliers, and aggregating one here would be a TypeScript average
  of weighted prices. Its figures are already on the band table above, on the same page. **A named
  band the payload has no series for is NAMED** in a note, never dropped in silence.
- **NULL IS NEVER 0 and never "flat"** — `n/a (2 m)` under three priced months (two points always
  correlate perfectly), an em dash for an unknown premium or direction, because *flat* is a claim.
- **The MONTH SPINE is the WINDOW's, never the selection's**, so a supplier with a quiet stretch
  gets a GAP on the axis rather than a shorter chart.
- **⚠️ THE WHOLE SECTION IS ABSENT for a reader without the effective price flag** — not blank, not
  zeroed. It is money almost end to end, including `priceVolumeCorr`, which is DERIVED from price
  and is price information however it is labelled; the action refuses, and **the panel does not even
  ask** (`if (!caps.canViewPrices || namedKeysSig === '') return;`). The rest of that sheet — the
  band table with its `MIXED` column, the yard map, every per-band page and the Print button itself
  — is unconditional, because the rest of the payload is peso-free and Production is the role that
  walks the yard.
- **⚠️ THE KEY SIGNATURE'S SEPARATOR IS LOAD-BEARING.** The named band keys are joined into one
  string so the effect can depend on a primitive, and the effect SPLITS it back apart. `join('')`
  would hand the action one character per LETTER — a read that succeeds, matches nothing, and prints
  an empty table naming every band as having no history. It is `SUPPLIER_KEY_SIG_SEP = ''`,
  **written as an escape**: a literal U+0001 typed into the source works and is invisible in a diff,
  which is the same bug wearing a disguise. §13 pins the escape and asserts no raw control byte
  appears in any lens file.

##### THE CHART IS HAND-DRAWN SVG, NOT RECHARTS — and that is a defect list, not a preference

`lens-print-chart.tsx` is one primitive with two uses (a bare line; an area-plus-line).
`/analytics`' `supplier-expand.tsx` draws this exact shape and **nothing was moved or shared out of
it** — `app/(app)/analytics/CONTEXT.md` is untouched, because three properties of THIS surface rule
that component out:

1. **RECHARTS MEASURES, AND THIS SHEET DOES NOT WAIT.** Both analytics charts are
   `<ResponsiveContainer>`, sized from a ResizeObserver callback one frame LATER; `printCard` calls
   `window.print()` as soon as the stage has laid out, so a container that has not measured yet
   prints an empty box.
2. **ITS COLOURS ARE THEME TOKENS.** Every series there is `var(--chart-2)` / `var(--border)`, and
   this sheet lays out in the LIVE DOM — a dark-mode reader would print a dark chart onto white
   paper. The whole sheet is explicit light ink for exactly that reason.
3. **IT WOULD PUT RECHARTS IN THE BLOCKING BUNDLE** for a print-only twelve-point series. The
   Blocking page imports none of it today.

So it follows the printed yard map's own precedent: hand-drawn geometry, explicit hex ink,
`print-color-adjust: exact`, and a size the caller states in **pixels**. It computes no statistic —
scaling a value to a y coordinate is geometry — and **formats nothing**: every label is a string
`lens-market-model.ts` already built.

**Two things measured on real PDFs and fixed:**

- **A VOLUME AXIS MAY NOT RUN BELOW ZERO.** The area domain starts at 0 and the 8% pad then pushed
  its lower bound negative, so every panel printed `548t / 254t / −41t`. `printChartDomain` gained a
  `floor`, applied AFTER the pad, and every call site passes `0`. It is a FLOOR, **not** a zero-base:
  a price axis over ₱39–₱48 still starts near ₱38, because forcing it to zero would flatten the very
  movement the chart exists to show.
- **THE TYPE FLOOR.** The first pass drew axis numbers at 6 px and month ticks at 5.5 (~4 pt on
  paper). All four label sites now read ONE constant, `LENS_PRINT_CHART_LABEL_PX = 7`, and the two
  horizontal pads widened to hold a label at that size (`₱48.50` and `14,145t` are the widest strings
  either axis can produce). §13 also bans any `text-[<7px]` in the five print files.

**Measured on REAL PDFs** (headless Chromium driving the real Print button, seven cases across the
three rigs, zero console errors in all seven): **price 7 pages** (`/pricelens`, 3 bands × A/B/C) and
**9** on the supplier rig with `?pca=1`; **age 6 pages**; **supplier 9 pages**, price-visible and
`?prices=0` alike. Page 1 is one sheet on every one of them, page 2 is the map, and on the price
sheet pages 3+ each open with the repeated band line then `WHSE X …` — measured page firsts:
`WHSE A`, `WHSE B`, `WHSE B`, `WHSE B`, `WHSE C` (and `WHSE D`, `PCA`, `PCB` on the `?pca=1` rig).
The age sheet's pages 3–6 are one per BAND with merged warehouses and no supplier column, unchanged.

### Price lens — DATA LAYER (2026-09-19, migration `20260919025729_blocking_price_lens`)

> **BACKEND ONLY so far.** The two SQL functions, the two server actions and the types are LIVE
> and verified; the UI is the next pass. **This section IS the contract** — a UI can be built from
> it without reading any SQL. Proofs: `npx tsx scripts/verify-blocking-price-lens.ts`
> (**61 assertions, all passing 2026-09-21** — 49 on 2026-09-19, plus 12 for the typed cut line).

**What the owner asked for.** Renzo, 2026-09-19: see the blocking grid *"ratio'd in highlights
based on price filter"* — e.g. choose "above market": if market (what deliveries currently cost)
is 40.23, then **₱41 and up is above market**.

**TWO FUNCTIONS, AND THE SPLIT IS THE DESIGN.** One says what market COSTS right now; the other
TAKES a market price and classifies the yard. The classifier takes the price as an **argument**
so the `manual` basis (a ₱ the operator types — no server call needed) and all four computed
bases go through **ONE** band-and-classify implementation. A second classifier for the typed case
is how "above market" would eventually come to mean two different things.

#### THE PRICE GATE IS A REFUSAL, NOT A NULLING PASS — read this first

Everywhere else on this page a ₱ field is set to `null` before the payload leaves the server.
**That technique cannot work here.** Band membership alone pins a block's ₱/kg to within a peso,
and even `bands[].blockCount` describes the price distribution of the yard — so there is no
price-free half of this payload to hand to Production. Both actions therefore call the canonical
`canViewPrices()` **FIRST** and return `{ ok: false, reason: 'prices_hidden' }` **without touching
the database**. The verify script asserts the ORDER inside each action body (gate before
`createClient()`, gate before `.rpc()`), not merely that the gate appears.

**UI consequence:** on `prices_hidden`, hide the whole lens control — do not retry, do not render
an empty legend, and do not try to salvage the counts.

#### Action 1 — `fetchBlockingMarketBases(trailingDays = 30)`

```ts
type BlockingMarketBasisKey =
  | 'this_month' | 'last_month' | 'last_3_months'
  | 'this_quarter'      // ADDED 2026-09-22 (migration 20260922094500)
  | 'trailing_days';

interface BlockingMarketBasis {
  basisKey: BlockingMarketBasisKey;
  marketPhpKg: number | null;   // NULL, NEVER 0, when the window has no priced market kilos
  pricedKg: number;             // kilograms the price is weighted over (0 is a real answer)
  deliveryCount: number;        // MARKET deliveries in the window, priced or not
  fromDate: string;             // 'yyyy-MM-dd' — window ANCHOR
  toDate: string;               // 'yyyy-MM-dd' — window ANCHOR
}

type BlockingMarketBasesResult =
  | { ok: true; bases: BlockingMarketBasis[]; trailingDays: number }
  | { ok: false; reason: 'prices_hidden' | 'invalid_trailing_days' | 'rpc_error' | 'exception';
      message: string };
```

Returns **exactly FIVE rows** (four before 2026-09-22), in this order: `this_month`, `last_month`,
`last_3_months`, **`this_quarter`**, `trailing_days`. `trailingDays` must be a whole number
**1..400** (default 30); outside that the action refuses `invalid_trailing_days` and the SQL
additionally clamps, so a stale client can never produce a junk window.

**`marketPhpKg` is NULL — never 0 — when that window has no priced market kilos** (the 1st of a
month before anything arrives). Treat NULL as *"cannot measure market this way yet"*, offer another
basis, and **never coerce it**: a lens built on ₱0 would call every block "above market".

##### `this_quarter` — the basis a FIRST-TIME price lens should DEFAULT to (2026-09-22)

The CURRENT Asia/Manila calendar quarter **to date**. The other four could not express it:
`this_month` is noisy in the first days of a month, `last_3_months` is a rolling three wherever the
quarter boundary falls, and `trailing_days` does not align to a quarter at all.

**THE UI STEP IS DONE (2026-09-22).** `DEFAULT_PRICE_LENS_SETTINGS.basis` in
`lens/price-lens-settings.ts` is now **`'this_quarter'`** — the owner's *"on first load, default to
the current quarter's average."* The select offers it as **`This quarter's deliveries`** (NOT the
data layer's first proposal, *"This quarter to date"*: the three calendar bases read as one list
only if they are all spelled as delivery windows), and `PRICE_LENS_BASIS_ORDER` places it after
`last_3_months`.

**⚠️ A SAVED PREFERENCE IS UNTOUCHED, AND THAT IS THE WHOLE SCOPE OF THE FLIP.**
`parsePriceLensSettings` reads `basis` field by field, so a reader who chose `this_month` keeps it;
what moved is the shipped default, which is also the fallback a CORRUPT or ABSENT stored document
lands on. `scripts/verify-blocking-lens-ui.ts` §5 pins **both** halves — the new default, and a
round trip proving every stored basis still survives — and the default is still OMITTED from the
serialized document, so "reset" stays a removal rather than a value that lingers.

**⚠️ A DEV RIG MUST CARRY THE ROW.** `fn_blocking_market_bases` returns `this_quarter` on the live
page, but the three fixtures build `BASES` by hand — and a rig without that row opens the price lens
on a basis it cannot resolve: `activeBasis` is null, no market price is resolved, the classify read
never fires, **no band chip renders and the Print button stays disabled**. It is silent, and it
breaks only the surface a reviewer can actually look at. All three rigs now carry it (₱39.1816 over
2,479,361 kg / 153 deliveries — the live Q3 2026 figure, deliberately distinct from their
`last_3_months` so the highlighted MARKET row is visibly its own), and §13 asserts every rig can
resolve every basis the select offers.

**IT COSTS NO EXTRA READ, and that is arithmetic rather than luck.** The quarter to date is month 1,
2 or 3 of the quarter, so it always spans at most the three months `m2 … m0` the function's existing
`months` CTE already MATERIALIZES for `last_3_months` — the row is a FILTERed aggregate over a CTE
that was already there. Measured: `fn_blocking_market_bases(30)` did not move.

**`from_date`/`to_date` are the QUARTER's own bounds**, so `to_date` is in the FUTURE for an
unfinished quarter — exactly as `this_month`'s already is mid-month. That is the window-ANCHOR
convention, not a bug.

**⚠️ IT SHIFTS AN ORDINAL.** Placed with the calendar bases at position 4, it pushes
`trailing_days` from 4 to 5. Every caller keys by `basisKey` (the action maps rows to `basisKey`,
never to an index) — **read the key, never the index.**

**⚠️ IT IS NUMERICALLY IDENTICAL TO `last_3_months` IN A QUARTER'S THIRD MONTH**, because the
quarter to date then *is* the last three months. Measured 2026-09-22: both **₱39.1816 over
2,479,361 kg / 153 deliveries**. They diverge on 1 October. Do not "simplify" one away on the
strength of a September screenshot — the verify script prints which case is live so a reader of the
log is never surprised by two rows agreeing.

#### Action 2 — `fetchBlockingPriceLens(marketPhpKg, edgeOffsets = [-1, 0], roundedUpPhp?)`

```ts
interface BlockingPriceBand {
  index: number;                 // 0-based, ascending by price
  lowerPhp: number | null;       // null on the FIRST band = open below.  NULL MEANS OPEN, NOT 0
  upperPhp: number | null;       // null on the LAST band  = open above
  blockCount: number;
  kg: number;
  kgSharePct: number | null;     // PERCENT 0-100 of the PRICED population; null if nothing priced
  blockSharePct: number | null;  // PERCENT 0-100 of the PRICED population; null if nothing priced
  kgWeightedPhpKg: number | null; // ADDED 2026-09-21. Σ(kg × ₱/kg) ÷ Σkg for the band.
                                  // NULL, NEVER 0, on an EMPTY band
  // ADDED 2026-09-22 — the seven kg-weighted lab means + their coverage weights.
  // See `BlockingLensLabStats` below; the whole family also rides on `total`
  // and on every `warehouseSubtotals` row.
  wMc: number | null;      mcKg: number;
  wAsh: number | null;     ashKg: number;
  wBdAstm: number | null;  bdAstmKg: number;
  wBdJis: number | null;   bdJisKg: number;
  wGrit: number | null;    gritKg: number;
  wVm: number | null;      vmKg: number;
  wFc: number | null;      fcKg: number;
}

// ADDED 2026-09-22. The same seven figures at three grains — a band, a warehouse
// subtotal and the yard total — so one shape rather than three copies.
interface BlockingLensLabStats {
  wMc: number | null;  mcKg: number;   /* …ash, bdAstm, bdJis, grit, vm, fc… */
}

// ADDED 2026-09-22. One (band × warehouse) group. A pair that holds NO block is
// ABSENT — the one place this lens does not emit an empty group.
interface BlockingPriceWarehouseSubtotal extends BlockingLensLabStats {
  bandIndex: number;                    // indexes into `bands`
  warehouse: string;                    // 'A'…'D' | 'PCA' | 'PCB' | '-'  (see below)
  blockCount: number;
  kg: number;
  kgWeightedPhpKg: number | null;       // over the group's PRICED blocks; NULL never 0
}

// ADDED 2026-09-22. The per-block extras the print's block table needs.
interface BlockingPriceLensBlock {
  blockLoc: string;
  bandIndex: number;                        // same number bandByBlock carries
  warehouse: string;
  dominantSupplierDisplay: string | null;   // RAW spelling ('Ornales'). NULL = no delivery row
  dominantSharePct: number | null;          // % of the block's DELIVERED kilos
  isMixed: boolean | null;                  // NULL — never false — with no supplier at all
}

interface BlockingPriceLens {
  marketPhpKg: number;           // echoed back, so a legend can label itself
  roundedUpPhp: number;          // R — the GIVEN value when you passed one, else floor(market)+1
  edgeOffsets: number[];         // the offsets ACTUALLY used, de-duplicated + ascending
  bands: BlockingPriceBand[];
  bandByBlock: Record<string, number>;   // block_loc -> band index. THE map a cell colours from
  blockByLoc: Record<string, BlockingPriceLensBlock>;  // ADDED 2026-09-22. SAME key set
  warehouseSubtotals: BlockingPriceWarehouseSubtotal[];  // ADDED 2026-09-22
  unpriced: { blockCount: number; kg: number };
  total:    { blockCount: number; kg: number;
              kgWeightedPhpKg: number | null }   // ADDED 2026-09-21 — see the note below
            & BlockingLensLabStats;              // ADDED 2026-09-22
}

type BlockingPriceLensResult =
  | { ok: true; lens: BlockingPriceLens }
  | { ok: false;
      reason: 'prices_hidden' | 'no_market_price' | 'invalid_market_price'
            | 'invalid_rounded_up' | 'invalid_edge'
            | 'no_edges' | 'too_many_edges' | 'rpc_error' | 'exception';
      message: string };
```

**THE R RULE.** `R = floor(market) + 1`. Measured on the live functions: **40.23 → 41**,
**39.8568 → 40**, and **40.00 → 41 as well**. That last case is deliberate and is not an
off-by-one: rounding up even on a whole number keeps the market price **itself** inside the
"at market" band `[R−1, R)` rather than promoting it to "above market", because a block priced at
exactly market is not dearer than market. **R is defined once, in SQL** — the verify script
asserts no `floor`/`Math.floor` exists in the TypeScript.

##### `kgWeightedPhpKg` — WHAT THE BAND COST (2026-09-21, migration `20260921084500`)

The lens could say how many blocks and how many kilograms were in each band, but not what those
kilograms **cost** — so a lens print had to re-weight the band in TypeScript, which CLAUDE.md
forbids. **Additive jsonb keys only: the signature did not change, no existing key moved, and the
verify script asserts the whole key set is exactly what it was plus this one.**

* **Per band:** `Σ(kg × avg_php_kg) ÷ Σkg`. **NULL — never 0 — on an EMPTY band**: no charcoal in
  the band means no price in the band.
* **On `total`: it is weighted over the PRICED population only, while `total.blockCount` /
  `total.kg` still count EVERY occupied block.** The asymmetry is deliberate and is the L-008 rule
  again — an unpriced block's ₱0 is a placeholder, so averaging it in would drag the figure down
  exactly as `batches.avg_cost` once read **₱11.01 against a real ₱39.99**. The counts are a count
  of the yard; the price is a price of what is priced, which is the same population the two share
  denominators already use.

Proven every run by reading `view_blocking_grid` **directly** (service_role holds SELECT on it) and
recomputing each band: measured 2026-09-21 on the live grid, **₱23.8801 / ₱39.4000 / ₱45.4434**
across the three default bands and **₱36.9520** on `total`, 170 of 170 blocks priced, gap 0 in SQL.

##### WAREHOUSE SUBTOTALS, THE SEVEN WEIGHTED LAB MEANS, AND THE SUPPLIER PER BLOCK (2026-09-22, migration `20260922093000`)

The owner, on the print's per-band block tables: the **WAREHOUSE SUBTOTAL** row printed its block
count and its kilograms and then **SEVEN BLANK LAB CELLS**, and he wants the kg-weighted
`MC · ASH · BD ASTM · BD JIS · GRIT · VM · FC` and the weighted ₱/kg there — plus a **SUPPLIER
column** beside each block.

**THOSE CELLS WERE BLANK ON PURPOSE, AND THAT IS WHY THIS IS A MIGRATION AND NOT A PRINT CHANGE.**
`lens/lens-summary-model.ts` says it in its own header: it makes exactly ONE sum (a band's kilograms
per warehouse) and **refuses** to make a weighted average, because *"a kg-weighted MC over a
partition SQL never computed would be a second definition of a lab average living in TypeScript"*.
So SQL now computes the partition. The print may render a figure; it still must not compute one.

**Additive keys only.** The signature did not change, so grants survived (and were re-stated anyway).
**PROVEN byte-identical before/after:** the whole payload's md5 was captured for `(40.23)`,
`(40.23, [-10,-1,0,5])` and `(41, [-1,0], 41)`, then recomputed with the new keys stripped —
`038ec4e6…`, `471721cd…`, `777ca847…`, all three unchanged. The verify script repeats it
structurally (key sets, band by band, block by block) rather than leaning on a hash a legitimate
delivery would move.

**THE WAREHOUSE IS THE PAGE'S OWN RULE, and it is a DUPLICATION that is checked rather than hidden.**
`warehouse` is the `block_loc` prefix before the first dash, upper-cased and trimmed, kept when it is
one of the grid's six warehouses (`WAREHOUSES` in `./constants` — A, B, C, D, PCA, PCB) and otherwise
the **REAL bucket `-`, which sorts last and is a real answer** (a block whose prefix is not a
warehouse is still a block, and dropping it would make the sheet disagree with the band table about
how many blocks the band holds). SQL cannot import a TypeScript constant, so
`scripts/verify-blocking-price-lens.ts` **imports `warehouseOfBlockLoc` and asserts it agrees with
SQL on EVERY block returned** — add warehouse E to the grid and that assertion fails rather than the
E blocks quietly landing in `-`. Measured 2026-09-22: **A 50 · B 34 · C 33 · D 53**, no PCA, no PCB,
no `-`, so those three branches are exercised by the assertion and not by live data.

**THE SUPPLIER IS NOT A NEW DEFINITION — three rules, all READ.** Identity
(`canonical_supplier(split_part(supplier, ' - ', 1))`) and the ALL/SOME rule
(`supplier_count_in_block > 1`) come from `view_blocking_block_suppliers`; the DOMINANT supplier uses
`fn_blend_block_facts`' own order (`kg DESC, supplier_key ASC`) — the **third** consumer of that
order and still not a third rule, proven equal to that function on every block every run.
`dominantSharePct` is the view's own share of the block's **DELIVERED** kilos, deliberately not
re-based onto the balance (within one block the balance is a constant, so the orderings are identical
and re-basing would only invent a second percentage).
**`isMixed` is `boolean | null`, and the NULL is load-bearing:** a block whose batch has no delivery
row has no supplier, so all three fields read NULL — *never* `false`, because "nobody has delivered
into this pile" and "one supplier filled it" are different answers. Measured: no such block can reach
`blockByLoc` today (`avg_php_kg` is derived from the deliveries it does not have, so it would be
`unpriced` and in no band), and the join is a LEFT JOIN anyway.

**A LAB READING OF 0 MEANS "NO READING" AND IS EXCLUDED — never averaged as zero.**
`view_blocking_grid` COALESCEs its seven lab averages to 0, so `avg_ash = 0` means the block's
deliveries carry no ASH figure, not ash-free charcoal — the L-008 placeholder shape in a lab coat.
The predicate is the one `fn_blend_analysis` uses for `unmeasured`: **NULL or ≤ 0.** Therefore

* **`w<Stat>` is NULL — never 0 —** when no block in the group has that reading;
* **`<stat>Kg` is a REAL 0** in that case, because it is a WEIGHT and "zero measured kilograms" is a
  measurement (the `pricedDominantKg` asymmetry again);
* the weight is the grid `balance`, **the same weight `kgWeightedPhpKg` uses**, so the money column
  and the seven lab columns on one row describe the same kilograms.

**EACH STAT HAS ITS OWN COVERAGE AND THEY GENUINELY DIFFER — which is why there are seven weights
and not one.** Measured 2026-09-22: all 170 occupied blocks carry MC while **11 read 0 on ash, both
BDs, grit, VM and FC** — `total.mcKg` **10,575,183 kg** against **9,805,452 kg** for the other six, a
769,731 kg gap. One shared "lab kg" would have been wrong for MC or wrong for the other six on every
group in the yard, and the verify script FAILS if the seven ever collapse to one number.

**FOLDS, and what they buy.**

* `Σ warehouseSubtotals[band].blockCount === bands[band].blockCount` — **exactly**
* `Σ warehouseSubtotals[band].kg === bands[band].kg` — **exactly** (plain sums of balances)
* `Σ bands[].<stat>Kg === total.<stat>Kg` — **exactly**, and that is *why* `total`'s lab means are
  weighted over the PRICED population: a total over a different population could not equal the sum of
  its bands. **The stated consequence: an UNPRICED block's lab readings are not in `total.wMc`.**
  Measured — 0 of 170 blocks are unpriced today, so the two populations coincide and the divergence is
  guarded by the invariant rather than by live data.
* An **EMPTY band contributes NO warehouse rows.** This is the one place the lens does not emit an
  empty group (the print renders a warehouse heading only when it has blocks), so the fold is Σ over
  the rows PRESENT — asserted per band, not merely in total, because a total can tie while two bands
  swap blocks.

Rows arrive in the grid's own warehouse order with `-` last. **Render them as given** — the order is
asserted.

**Live sample, 2026-09-22 (default edges, market 40.23):** 3 bands → **9 warehouse rows**; band 2 /
warehouse D reads **36 blocks · 2,165,218 kg · ₱46.3809** with `wMc` 11.1441 · `wAsh` 4.1789 ·
`wBdAstm` 0.56585 · `wBdJis` 0.58585 · `wGrit` 2.9170 · `wVm` 12.7490 · `wFc` 83.0721, each over the
full 2,165,218 kg. Yard total: `wMc` 11.0242 · `wAsh` 3.7218 · `wBdAstm` 0.58115 · `wBdJis` 0.59158 ·
`wGrit` 2.8345 · `wVm` 12.8341 · `wFc` 83.4461.

**COST, measured before any proof was written.** `fn_blocking_price_lens(40.23)` went
**28.2 ms / 2,013 buffers → 52.2 ms / 2,414**. The new CORE QUERY is **41.6 ms / 661 buffers = 456
(ONE `view_blocking_grid` scan) + 202 (ONE `view_blocking_block_suppliers` scan) + 3**, so the data
read grew by exactly one relation — the same scan the supplier lens already pays, whose ~29 ms is
`canonical_supplier()` per delivery row paid INSIDE that view. The rest of the function's +401 is
plpgsql PLANNING of a materially larger statement, reported rather than rounded away.

**THE GATE DOES NOT MOVE.** The seven lab stats are not money, but they arrive inside a payload that
is, and band membership alone still pins a block's ₱/kg to within a peso — so
`fetchBlockingPriceLens` still REFUSES a `!canViewPrices()` caller. The **supplier lens** is where a
price-denied reader gets a warehouse picture, and it nulls its two ₱ keys instead. That three-way
asymmetry (refuse / null two keys / no gate at all on Age) is asserted in both verify scripts
precisely so nobody flattens it.

##### `roundedUpPhp` — A TYPED PRICE IS THE LINE ITSELF (2026-09-21, migration `20260921034512`)

The R rule above is right for a **MEASURED** market and **wrong for the `manual` basis**. The
operator who types **₱41** means ₱41 and up is above market; `floor(41) + 1` handed them **42**, a
lens one peso looser than the one they asked for. A typed 41 is not a measurement that happens to
be whole — **it IS the cut line.**

> ### THE UI RULE — the only thing a caller has to remember
> * **`manual` basis → pass `roundedUpPhp = Math.ceil(typedPrice)`** (41 → 41, 40.5 → 41).
> * **EVERY measured basis** (`this_month`, `last_month`, `last_3_months`, **`this_quarter`**,
>   `trailing_days`) **→ pass nothing.** R stays computed in exactly one place, in SQL.
>
> The `ceil` belongs to the UI (a lens-settings module), **not** to `actions.ts` — the action does
> no arithmetic and `verify-blocking-price-lens.ts` asserts that no `floor`/`Math.ceil` exists in
> it. `BLOCKING_ROUNDED_UP_MIN_PHP` in `types.ts` carries this rule in a doc comment.

Measured on the live function 2026-09-21, side by side on the same number:

| call | R | bands | ₱41 lands in |
|---|---|---|---|
| `fetchBlockingPriceLens(41)` | **42** | `(−∞,41)` · `[41,42)` · `[42,∞)` | **at market** (88 / 1 / 78 blocks) |
| `fetchBlockingPriceLens(41, [-1,0], 41)` | **41** | `(−∞,40)` · `[40,41)` · `[41,∞)` | **above market** (68 / 20 / 79 blocks) |

**OMITTED, NOTHING CHANGES.** `fn_blocking_price_lens(price, [-1,0], NULL)` returns a payload
**byte-identical** to `fn_blocking_price_lens(price)` — proven by a whole-jsonb `deepEqual` in the
verify script, not by comparing R — so every existing caller, all four computed bases and the whole
stored per-user lens configuration are unaffected. **Nothing in the payload says which rule
produced R**, deliberately: a new key would have broken that identity.

It must be a **whole number of at least 1**; anything else is refused `invalid_rounded_up` with a
human message (checked in the action, because `p_rounded_up_php` is an `int` so SQL has already
rounded 40.5 by the time its body runs — the same asymmetry `edgeOffsets` records, under the same
vocabulary). An **override changes the LEGEND, never the yard**: block counts move between bands,
`total.kg` does not.

**Signature note for anyone reading the migrations:** this was a **DROP + CREATE**, not a
`CREATE OR REPLACE` — Postgres cannot change an argument list in place — so the grants and the
`COMMENT` were **re-applied in the same file**, and `fn_blocking_price_lens_probe` was updated in it
too because that probe names the function **by argument types** (`has_function_privilege(…,
'public.fn_blocking_price_lens(numeric, int[], int)', …)`) and would otherwise fail on every call.
An **overload was rejected**: two functions of that name is two homes for the band logic. The verify
script asserts `lens_overload_count === 1`.

**THE BAND MODEL.** `edgeOffsets` are whole-peso offsets from R. They are de-duplicated and sorted
(in the action **and** in SQL, by the same rule, so the two cannot disagree), **capped at 6**, and
`k` edges give `k + 1` half-open bands `[lower, upper)` — first open below, last open above, each
band's `upperPhp` exactly equal to the next band's `lowerPhp` so no price can fall between two
bands or land in both.

| `edgeOffsets` | bands | meaning |
|---|---|---|
| `[-1, 0]` (default) | 3 | `(−∞, R−1)` below market · `[R−1, R)` **at market** · `[R, +∞)` above market |
| `[-10, -1, 0, 5]` | 5 | `(−∞,R−10)` · `[R−10,R−1)` · `[R−1,R)` · `[R,R+5)` · `[R+5,+∞)` |

**Every band is returned even when it holds no blocks**, so a legend can render the whole scale
without inventing rows.

**THE UNPRICED RULE — NULL IS NEVER ₱0 (L-008).** The per-block price is
`view_blocking_grid.avg_php_kg`, the SAME column the cell already displays — the lens invents no
second block price. That column is `COALESCE(…, 0)`, so a block whose deliveries carry no price
reads 0, which is the **L-008 unpriced placeholder, not free charcoal**. Such a block is
**ABSENT from `bandByBlock`**, counted in `lens.unpriced`, and **excluded from both share
denominators**. **UI rule: render it in its normal un-lensed style — never in the cheapest band.**
Putting it in "below market" is the ₱11.01-vs-₱39.99 `avg_cost` bug in a new costume.

**Invariants you can rely on** (each proven against the live database every run):
`Σ bands[].blockCount + unpriced.blockCount === total.blockCount` · the same for `kg` with **gap
exactly 0** · `Σ kgSharePct === 100` and `Σ blockSharePct === 100` (±1e-9, over the PRICED
population) · the banded population IS the grid's priced positive-balance blocks · `Object.keys(bandByBlock).length + unpriced.blockCount === total.blockCount`.
Scope is **occupied blocks with a POSITIVE balance** — a negative balance is misattribution
(CLAUDE.md records 77 batches carrying −3.22M kg) and has no price story.

**REFUSALS are data, never throws** — pass `message` straight to `errorToast()`:

| `reason` | when | what the UI should do |
|---|---|---|
| `prices_hidden` | `!canViewPrices()` | hide the whole feature; never retry |
| `no_market_price` | the chosen basis has no priced market kilos (its `marketPhpKg` is null) | offer another basis / the manual box |
| `invalid_market_price` | ≤ 0, NaN or Infinity | fix the typed value |
| `invalid_rounded_up` | a given `roundedUpPhp` that is not a whole number ≥ 1 | fix the typed price (`Math.ceil` it) |
| `invalid_edge` | a non-integer or NULL offset | reject the edge input |
| `no_edges` | empty edge list | keep at least one edge |
| `too_many_edges` | more than 6 **distinct** offsets | drop one |
| `rpc_error` / `exception` | database unreachable | `errorToast()` + retry |

> **One deliberate asymmetry, stated because a reader will notice it.** `p_edge_offsets` is
> declared `int[]`, so Postgres has already rounded `1.5` to `2` before the function body runs and
> the *non-integer* refusal is structurally unreachable in SQL. It is therefore enforced in the
> **server action**, which is where it IS decidable, under the SQL's own `invalid_edge` reason
> rather than a second vocabulary. SQL still refuses a NULL element (same reason), so a direct RPC
> caller is not unguarded.

**LIVE NUMBERS, measured 2026-09-19** (the market prices are the only ₱ this layer's proofs print):

| basis | market ₱/kg | priced kg | deliveries | window |
|---|---|---|---|---|
| `this_month` | 39.8568 | 566,870 | 37 | 2026-09-01 → 2026-09-30 |
| `last_month` | 39.9698 | 824,027 | 50 | 2026-08-01 → 2026-08-31 |
| `last_3_months` | 39.1187 | 2,292,401 | 138 | 2026-07-01 → 2026-09-30 |
| `trailing_days` (30) | 39.9680 | 834,743 | 52 | 2026-08-21 → 2026-09-19 |

On `this_month`, **R = 40**, default edges: below `(−∞,39)` **61 blocks / 3,999,138 kg / 38.1965%
kg / 36.3095% blocks** · at market `[39,40)` **7 / 446,572 / 4.2653% / 4.1667%** · above `[40,∞)`
**100 / 6,024,189 / 57.5382% / 59.5238%**. Total **168 blocks / 10,469,899 kg**, **unpriced 0 / 0**
(so today the unpriced branch is exercised only by the invariants, not by live data — do not read
that as "it cannot happen").

**Where the numbers come from — nothing with a home is re-derived.** "Market" is the weighted
average ₱/kg of MARKET-class PRICED deliveries (`fn_delivery_class(...) = 'market'` **and**
`cost_basis > 0`, `SUM(cost_basis × weight_kg) / SUM(weight_kg)`), and that statistic already lives
in **`view_analytics_rcin_monthly.market_avg_price`** — so `this_month` and `last_month` **SELECT
it verbatim** and `last_3_months` divides `Σ market_php_total` by `Σ market_priced_kg` (never the
mean of three monthly averages). The verify script proves all three against a direct read of that
view **in the same call**, so the lens and the `/analytics` matrix cannot drift apart. Only
`trailing_days` reads `deliveries` directly, with the identical predicate and expression, on the
Asia/Manila calendar date and with **no upper bound** so a future-dated delivery is never invisible
(hence `toDate` reads as today but is an ANCHOR, not a filter).

**Posture.** Both functions are `STABLE`, `SECURITY INVOKER`, `SET search_path = public`, EXECUTE
revoked from `PUBLIC` + `anon`, granted to **`authenticated` only** — and **NOT `service_role`**
(no sync worker calls them, so `verify-worker-view-grants` stays at 4 views / 0 findings, confirmed
after this migration). Proven by really calling them as `anon` and as `service_role` and requiring
both to be refused (L-043: prove a permission by assuming the victim's role).

**Cost, measured before any proof was written** (the 2026-09-14 rule — `set local
statement_timeout='5s'` then `EXPLAIN (ANALYZE, BUFFERS)`): `fn_blocking_price_lens` **13.5 ms**
warm (85.4 ms / 1,939 buffers before the `MATERIALIZED` CTE hints, 4.8 ms / 454 after — the grid is
now scanned exactly once); `fn_blocking_market_bases(30)` **105.9 ms** (330.7 ms / 1,291 buffers
before reading the analytics view once, 133.4 ms / 176 after); the 400-day trailing ceiling 21.9 ms
/ 97 buffers on its own. **The `MATERIALIZED` hints are load-bearing, not decoration** — `blk` is
read by four downstream CTEs and `months` by three, and an inlined CTE is re-executed per
reference. Both populations are bounded BY CONSTRUCTION (one row per occupied block, 238 slots
maximum; the delivery window clamped to 400 days), so neither can grow into a whole-history scan.

**The verify script reaches the functions through a probe, and why.** Both are
`authenticated`-only by design and no verify script holds a user JWT, so
**`fn_blocking_price_lens_probe(int)`** (SECURITY DEFINER, `service_role` **only**, never
`authenticated`, never `anon`) is the access bridge — the same idiom as
`fn_ops_ledger_verify_campaign`. **It asserts nothing**: it calls the two functions a fixed number
of times, reads the same statistics independently, and hands everything back so every assertion
lives in readable TypeScript. It is deliberately NOT a whole-database verifier (the 2026-09-14
`fn_ops_ledger_verify()` incident took the live site down).

**Per-user lens CONFIG is the FRONTEND's job and needs NO migration.** The chosen basis, the
trailing-day N, a manual ₱, the edge offsets and any band names/colours belong in the existing
**`user_table_settings`** JSONB under the blocking module via `useTableSettings()` — that column is
a free-form `settings` jsonb with no per-key schema and no CHECK constraint, so an extra key needs
no schema change. **No table was added for it.** (Shipped 2026-09-19 through
`getUserModuleSettings`/`saveUserModuleSettings` under `module = 'blocking_lens_price'` rather than
through `useTableSettings()` itself — same column, and the reason for the difference is recorded in
`lens/use-lens-settings.ts`'s header and in the Files table above.)

### Market CONTEXT — DATA LAYER (2026-09-22, migration `20260922094500_blocking_market_context_and_supplier_market`)

**What it is for.** The price lens says what the yard looks like TODAY against ONE number. It cannot
say whether that number is high or low — and a print that wanted to would have to average a price in
TypeScript. So the series is computed where every other market figure already is.

#### The action — `fetchBlockingMarketContext(months = 12)`

```ts
interface BlockingMarketMonth {
  month: string;                 // 'yyyy-MM-01'
  marketPhpKg: number | null;    // NULL, NEVER 0, with no priced market kilos
  marketKg: number;
  marketPricedKg: number;
  deliveryCount: number;         // ALL market deliveries that month, priced or not
  activeSuppliers: number;
}

interface BlockingMarketQuarter {
  quarterKey: string;            // '2026-Q3' — stable + sortable
  label: string;                 // 'Q3 2026' — ready to print
  quarterStart: string;
  marketPhpKg: number | null;
  marketKg: number;
  marketPricedKg: number;
  deliveryCount: number;
  monthCount: number;            // 1 or 2 ⇒ PARTIAL at the window edge. RENDER THIS.
  firstMonth: string;
  lastMonth: string;
  isCurrent: boolean;            // its figure EQUALS the `this_quarter` BASIS
}

interface BlockingMarketSpan {    // yearToDate + trailing12m
  marketPhpKg: number | null;  marketKg: number;  marketPricedKg: number;
  deliveryCount: number;  monthCount: number;
  fromDate: string;  toDate: string;   // toDate is the END OF THE CURRENT MONTH, not today
}

interface BlockingMarketContext {
  monthsRequested: number;
  asOf: string;                              // the Asia/Manila anchor date
  months: BlockingMarketMonth[];             // ASCENDING. See the spine rule below.
  quarters: BlockingMarketQuarter[];         // the quarters `months` spans, ascending
  yearToDate: BlockingMarketSpan;
  trailing12m: BlockingMarketSpan;
  latestMonth: BlockingMarketMonth & { isCurrentMonth: boolean };
  monthsAvailable: number;                   // rows in ALL of history (50 today)
  monthsReturned: number;                    // min(monthsRequested, monthsAvailable)
}

type BlockingMarketContextResult =
  | { ok: true; context: BlockingMarketContext }
  | { ok: false; reason: 'prices_hidden' | 'invalid_months' | 'rpc_error' | 'exception';
      message: string };
```

**NOTHING IS A SECOND DEFINITION.** Every figure is SELECTed or summed from
`view_analytics_rcin_monthly` (analytics Phase 1), which OWNS "monthly average purchase price", and
every aggregate is **Σ `market_php_total` ÷ Σ `market_priced_kg`** — *never* the mean of monthly
averages, which would weight a light month equally with a heavy one. The verify script proves each
month row field-for-field against that view read independently, and asserts each quarter is NOT the
naive mean of its months whenever those differ.

**THE SPINE IS ROWS, NOT A CALENDAR.** `months` is **the last N months that HAVE a row**, ascending —
not the last N calendar months. That view has one row per month that had a delivery, so zero-filling
a dead month from `view_analytics_flow_monthly` would invent **₱0 months**: the L-008 mistake with a
calendar instead of a price. Read `monthsAvailable` / `monthsReturned` to say *"12 of 50"*.

**A QUARTER AT THE WINDOW EDGE IS PARTIAL.** `monthCount` is what says so — a 12-month window
starting mid-quarter shows a one-month quarter, which without the count reads as a full one. Print it.
`isCurrent` flags the quarter that has not finished, which is partial for a different reason.

**`yearToDate` / `trailing12m` are DATE-bounded, not row-bounded**, because "this year" and "the last
12 calendar months" are date questions — so they are unaffected by `monthsRequested`. Their `toDate`
is the **END of the current month**, the same window-ANCHOR convention `this_month` already uses,
because the rows aggregated are whole months and a `toDate` of today would misdescribe them.

**`latestMonth` is the most recent month WITH a row and is not necessarily the current one.** Read
`isCurrentMonth` before labelling it "this month".

**`months` is 1…36, REFUSED not clamped** (`invalid_months`; NULL is refused rather than defaulted,
because a caller that passed NULL meant something). The bases function *clamps* its `trailingDays`
because it `RETURNS TABLE` and has no channel for a readable refusal; this returns jsonb, so it
refuses the way every lens does.

**THE WHOLE PAYLOAD IS MONEY, so the gate is a REFUSAL** — `canViewPrices()` FIRST, before
`createClient()`, returning `{ ok:false, reason:'prices_hidden' }` without touching the database.
There is no price-free half worth keeping.

**Live sample, 2026-09-22 (N = 12):** months **12 of 50**, 2025-10 → 2026-09
(**₱44.9159 → ₱39.8805**); quarters **Q4 2025 ₱45.3439 · Q1 2026 ₱47.7866 · Q2 2026 ₱43.2958 ·
Q3 2026 ₱39.1816 (current)**; YTD **₱44.5762** over 9 months; trailing 12m **₱44.8002** over 12.
**`quarters.find(isCurrent).marketPhpKg` === the `this_quarter` basis, and
`trailing12m.marketPhpKg` === `BlockingSupplierMarket.windowTotal.marketPhpKg` at N = 12** — both
asserted, so three surfaces can never publish three versions of one number.

**COST: ~240 ms / 1,039 buffers**, and the analytics view is read **exactly once**
(`src AS MATERIALIZED`, six CTEs reference it). The milliseconds are that view's own
`Seq Scan on deliveries` with `fn_delivery_class` per row. **The window does NOT reduce it and
cannot** — the date bound filters already-grouped output — and making it cheaper would mean
re-deriving "market" against the raw table, which is the second definition this function exists to
avoid. Bounded by construction: ~1 row per calendar month, forever.

**THE PROBE IS SPLIT FROM THE SUPPLIER ONE, AND THAT IS A STRUCTURAL RULE NOW.**
`fn_blocking_market_context_probe()` (SECURITY DEFINER, `service_role` only) covers the market half;
`fn_blocking_supplier_market_probe()` covers the supplier half. **One function holding both TIMED OUT
AT 20 s** — not because any figure is slow (the identity block 87 ms, a context call 240 ms, a
supplier call 290 ms) but because fourteen references to two expensive `security_invoker` views
inside ONE `jsonb_build_object` are fourteen executions the planner interleaves. That is the
2026-09-14 `fn_ops_ledger_verify()` shape arriving a second time, and it got the same answer: **split
by concern, and assign every forwarded call to a VARIABLE so it is its own statement.** Measured
after the split: **2.93 s and 2.77 s**.

### Price lens — UI (2026-09-19)

> **SHIPPED.** The data layer above is consumed by a **reusable LENS FRAME**: a docked panel with a
> registry, of which **Price is the first and today the only** lens. Supplier and Age are the two
> the owner named next and are NOT built — see **REGISTERING A SECOND LENS** at the end.
> Proofs: `npx tsx scripts/verify-blocking-lens-ui.ts` (static + pure-function) beside
> `npx tsx scripts/verify-blocking-price-lens.ts` (the live data layer, 61).
>
> **UPDATE 2026-09-19 — AGE is no longer unbuilt on the data side.** Its view, SQL function,
> server action and types are LIVE and verified (49 assertions); only the panel + registry entry
> remain. Contract: **Age lens — DATA LAYER**, immediately after this section.

**Entry point.** A **Highlight** button (Highlighter icon + an ON/OFF pill, styled exactly like the
Prices and Blend Proposal toggles beside it) in the sticky header. It opens a **DOCKED PANEL, not a
modal** — a modal would cover the grid the lens exists to light up.

**Docking.** At `lg`+ the warehouse sections and the panel are a flex ROW: the grid column is
`min-w-0 flex-1`, the panel a `shrink-0` 300px `sticky` column. **`min-w-0` is load-bearing** — it
is what makes the grid column GIVE when the panel takes its width, and because each warehouse
section already carries its own `overflow-x-auto` and `.blocking-grid-cols` already floors every
track at 104px, it gives by SCROLLING, never by crushing a cell ("never crush, always scroll" is
preserved, not dodged). Below `lg` the panel becomes a bottom sheet and the page is a single column
again.

**Grid behaviour.**

| State | Every cell |
|---|---|
| Lens open, **no band picked** | Every PRICED occupied block wears its band's tint + ring. This IS the "ratio'd" view. Unpriced blocks and empty slots are left exactly as they look with no lens open — nothing is dimmed, because the picture is a distribution and not a filter. |
| Lens open, **≥1 band picked** | The picked bands keep their tint and gain `.lens-band-picked` (a louder ring, same hue). **Everything else — occupied, empty, and unpriced — takes the shared `.spotlight-dimmed`.** |
| Clear / close / Escape | All lens styling goes. |

**THE UNPRICED RULE IS THE ONE THAT MATTERS.** A block with no price is ABSENT from
`lens.bandByBlock`; the classifier returns `null` for it, which the grid renders as *un-lensed*.
Painting it as the cheapest band would be the ₱11.01-vs-₱39.99 `avg_cost` bug in a new costume. It
is reported on its own muted row (`No price yet — N blocks, X kg`), never inside a band and never
as ₱0.

**Panel body, top to bottom.** (1) the **Market is** select + the figure + "rounds up to ₱R" + a
quiet coverage line (priced kg / delivery count / window) so an early-month thin basis is visible;
a basis with a NULL market says so plainly and points at the other bases and the typed box.
(2) one **toggle row per band** — swatch, auto label (`Below market, under ₱39` / `At market,
₱39.00 to ₱39.99` / `Above market, ₱40 and up`, with `₱45 and up`-style labels for extra bands
unless the reader named them), share %, and `N blocks · X kg` on a second quiet line. (3) a
**stacked ratio bar** with a **kg | blocks** switch that changes the bar AND the row percentages
together. (4) the unpriced row. (5) **Customize bands**.

**NOTHING IS SUMMED IN TYPESCRIPT.** Every kilogram, count, share and membership is the server
payload's, rendered verbatim; the ratio-bar segment widths ARE the published shares (which SQL
guarantees sum to 100). There is no `reduce`, no `+=` and no `Math.floor` in any lens file —
`verify-blocking-lens-ui.ts` asserts the absence, because a re-derivation would type-check
perfectly and let the picture disagree with the bands it describes.

**Customize bands.** A disclosure: add a cut line (an integer −50…+50 ₱ from the rounded market),
remove one (**including the default −1 and 0** — at least one edge must survive, because with none
there is a single band holding the whole yard, which is the same picture as no lens), rename a band,
and Reset. The **6-edge cap is stated inline** rather than shown as a disabled button with no
explanation. **A band name is keyed on the band's two OFFSETS from R, not its index**, so a name
follows its own interval instead of jumping to a different slice of the yard when a cut line is
added below it. Band colours are assigned by POSITION across the ramp and are not user-picked in v1.

**MUTUAL EXCLUSIVITY — the lens JOINS the existing rule.** Opening a lens resets `statusFilter` to
`ALL` and clears the supplier search; clicking any status/lab chip or choosing a supplier closes the
lens. Only ONE marking vocabulary is ever on screen, so a band tint can never be read as a status
glow or a supplier ring. On a cell the precedence is **lens → supplier → status** (belt-and-braces;
the exclusivity means the later two are already inactive). **Blend Proposal is unaffected** — a
blend-selected cell keeps its `ring-2 ring-primary` and its checkmark badge over a lens tint exactly
as it does over the supplier ring.

**PRICE GATING.** The button renders only when at least one lens `canShow`s, and `PRICE_LENS.canShow`
is `caps.canViewPrices` where `caps` is built from the grid's **EFFECTIVE** flag
(`serverCanViewPrices && showPrices`). So a Production user never sees the button while Price is the
only lens; once a peso-free lens exists the button stays for every role and only the Price tab is
absent. Flipping the page's **Prices toggle OFF while the lens is open closes it and clears every
tint on the same interaction** — and that is implemented against the REGISTRY (`lensId && !activeLens`),
not against the price flag, so a future lens with a different `canShow` gets the behaviour for free.
A `prices_hidden` refusal from either action closes the panel **quietly** — no toast, no retry, no
empty legend: it is a fact about the reader, not an error they can act on. The panel additionally
returns `null` if it is ever rendered without the flag. The security boundary remains the SERVER:
both actions refuse before touching the database.

**Deep link.** `?lens=price`, driven by `blocking-route-view.tsx` exactly as `?block=` /
`?supplier=` / `?proposal=` are (optimistic + `useTransition`, because the route is dynamic). **Band
selection is deliberately NOT in the URL** — it is a moment of looking, not a statement worth
sharing, and it resets when the cut lines move.

**Errors.** A `{ok:false}` refusal renders as an INLINE banner with a **Copy** button and a Retry
(the project's error HARD RULE, satisfied by a banner because a refusal about this panel's own
settings would be homeless as a toast the moment the panel closed) — and the **previous tint stays**,
because a refusal about new settings is not a reason to blank the picture on screen. A thrown error
goes to `errorToast()`. No lens file calls sonner's `toast.error` directly.

**Keyboard / a11y.** Band rows are real `<button>`s with `aria-pressed`; the kg|blocks pair is a
`role="group"` of `aria-pressed` buttons; the ratio bar is `role="img"` with an `aria-label` naming
every band and its share (its accessible text alternative); the tab strip is a real
`role="tablist"`. **Escape closes the lens and nothing else**: the handler defers while the detail
drawer is open (so Escape closes the drawer first and the lens on the next press — the
`supplier-search.tsx` step-back idiom) and defers to any Radix popper/dialog/listbox the key press
belongs to.

#### REGISTERING A LENS — THREE ARE REGISTERED, AND THE THIRD PROVED THE CLAIM

Three steps, and **nothing in `blocking-grid.tsx` or `blocking-route-view.tsx` moves**. That
was a prediction when the price lens shipped; the SUPPLIER lens (2026-09-22) is the
measurement. It needed **two files, one line of `registry.ts` and one block of `globals.css`**
— and not one character of the grid, the route view, the frame, the legend rows, the ratio bar
or the settings popover. The one thing it *did* add to the shared layer is the optional
`rampStop` on `LensBandRow` / `LensRatioSegment` / `LensSummaryBand`, because a NOMINAL ramp
cannot be positional; price and age omit it and are byte-identical.

Three steps:

1. Write `lens/<id>-lens-panel.tsx` exporting a component that takes `BlockingLensPanelProps` and
   publishes a `BlockingLensClassifier` through `onClassifierChange` (return `null` from the
   classifier for any cell that should stay un-lensed — a block the lens cannot PLACE, which is
   never the same as placing it in the first band). Keep a `lens/<id>-lens-settings.ts` beside it
   for the pure half: the settings type, an **untrusted field-by-field parser**, a serializer that
   OMITS defaults, and the label maths.
2. Export a `BlockingLensDefinition` beside it — `id`, `label`, `icon`, `blurb`, **`ramp`**,
   `canShow`, `Panel`. A peso-free lens reads `canShow: () => true`. A new ORDINAL ramp means
   seven `--lens-hue` stops in `globals.css` (joining the shared tint rule, after
   `.blocking-cell-occupied`) plus its prefix in `lens/lens-ramp.ts` — or reuse an existing one.
   A **NOMINAL** ramp is the `category` shape: declare its stops, add its prefix, set
   `LENS_RAMP_IS_ORDINAL` to `false`, and pass each band's own `rampStop` into the shared rows,
   bar and printed sheet. **Never re-use a hue that already MEANS something on this grid** — the
   supplier search's emerald (`16 185 129`, the whole block is that supplier) and orange
   (`249 115 22`, only some of it is) are asserted out of the categorical palette.
3. Add it to `BLOCKING_LENSES` in `lens/registry.ts`. Order is TAB order, and the FIRST entry a
   reader may see is what the Highlight button opens for them.

**Render the body out of the SHARED pieces rather than writing a fourth legend.** They exist
because two lenses drifting apart is the failure mode, not because there was too much code:

| Piece | What it owns |
|---|---|
| `lens/lens-band-rows.tsx` | `LensBandRows` (one `aria-pressed` button per band, empty bands included), `LensUnitSwitch` (kg\|blocks), `LensExcludedRow` (the muted row for the population in NO band) |
| `lens/lens-ratio-bar.tsx` | `LensRatioBar` — widths ARE the published shares, `role="img"` + a naming `aria-label` |
| `lens/lens-customize.tsx` | `LensCustomize` — the disclosure, the chip row, an optional quick-add row, the add box, the cap AS A SENTENCE, the rename inputs, both resets |
| `lens/lens-refusal-banner.tsx` | `RefusalBanner` — persistent, with Copy and an optional Retry |
| `lens/lens-shared.ts` | `LENS_DEBOUNCE_MS` (250), `LensUnit`, and every kg / share / days formatter |
| `lens/lens-ramp.ts` | `rampClass(ramp, index, bandCount)` and `rampClassAtStop(ramp, stop)` — **the only place a `.lens-*` class name is built** |
| `lens/lens-summary-model.ts` | `buildLensSummaryBuckets` — band → warehouse → rows for the printed sheet, plus the seven lab columns and their decimals |

A lens then gets, for free: a tab in the strip (which appears the moment this reader may be offered
more than one lens), the docking and the bottom-sheet behaviour, per-user settings under
`blocking_lens_<id>` via `useLensSettings`, the Escape handling, the `?lens=<id>` deep link, the
**fallback to another visible lens** when this one stops resolving, the mutual exclusivity with the
status and supplier spotlights, and the Clear/close lifecycle.

**Three rules a new lens must not break**, each of which `scripts/verify-blocking-lens-ui.ts`
asserts: it computes **no statistic** (no `reduce`, no `+=`, no division by a total — every kg,
share and average comes out of SQL); it reports the population it cannot place on **its own muted
row**, never inside a band; and its errors go through **`errorToast()`** or the shared banner,
never sonner's `toast.error`.

### Age lens — DATA LAYER (2026-09-19, migration `20260919133042_blocking_age_lens`)

> **SHIPPED.** The view, the SQL function, the server action and the types are LIVE and verified,
> and the UI landed the same day as lens #2 on the frame — see **Age lens — UI** immediately after
> this section. **This section IS the contract.** Proofs:
> `npx tsx scripts/verify-blocking-age-lens.ts` (**49 assertions, all passing 2026-09-19**).

**What it is.** Tint every occupied block by how OLD its charcoal is, with a ratio of the yard per
age band. Owner-approved default cut lines: **60 / 120 / 365 DAYS → four bands** (up to 60 days ·
60–120 · 120–365 · over a year), user-configurable.

#### ⚠️ THERE IS NO PRICE GATE, AND THAT IS THE POINT — read this first

The price lens **refuses** a `!canViewPrices()` caller before touching the database, because band
membership there pins a block's ₱/kg to within a peso. **That argument has no analogue here.**
`fn_blocking_age_lens` publishes days, kilograms, counts and percentages; `view_batch_age_days` has
no cost/price/value column; no money figure is derivable from any of it. Asserted, not promised —
the verify script recursively scans every key of the live payload against
`/php|peso|cost|price|value|amount/i` and finds none.

So **the Age lens is visible to EVERY role INCLUDING Production**, which is the role that actually
walks the yard. `fetchBlockingAgeLens` deliberately contains **no `canViewPrices` call**, and the
verify script asserts that ABSENCE so nobody "tidies up" the asymmetry with its sibling. When you
register it in `lens/registry.ts`, its definition reads **`canShow: () => true`**.

It still requires a signed-in user, the same way `fetchBlockDataForBatch` does, and refuses
`not_signed_in` if the session has expired.

#### THE ONE-DEFINITION RULE — age is NOT a new number

Age is the batch's **kg-weighted MEAN DELIVERY DATE** carried by its remaining balance:

```
age_days = as_of − Σ(weight_kg × delivery_date) ÷ Σ(weight_kg)
```

**There is NO FIFO and none is possible** — `rc_out` records which BATCH kilos left, never which
delivery within it, so a FIFO age would be fiction dressed as precision. Deliveries into one batch
cluster within days, so the error is small against ages in the hundreds of days.

That expression already lives in `view_analytics_aging_watchlist.age_days` and
`view_analytics_aging_eom.age_days`. It is now lifted arm for arm into **`public.view_batch_age_days`**
(one row per `batch_code` with at least one dated delivery: `age_days`, `mean_daynum`,
`mean_delivery_date`, `delivered_kg`, `delivery_count`, `first_delivery_date`, `last_delivery_date`,
`as_of_date`), which is what the lens reads.

**Why a view and not "SELECT age FROM the watchlist" — measured, not assumed.** The watchlist's
population is `status <> 'CLOSED' AND current_weight > 1000` — open piles **over a tonne**, because
it is a list of piles worth walking out to. The grid's population is every occupied block with a
**positive** balance. Measured 2026-09-19: all **168 of 168** grid blocks are watchlist rows, 0
outside, min grid balance **8,557 kg** — but they coincide **by luck, not by rule.** A block is fed
down day by day, and a nearly-empty block legitimately drops under a tonne while still holding its
slot; reading age from the watchlist would then silently report it as **undated**, i.e. "this pile
has no deliveries", about a pile that plainly has them. The tonne floor says what is worth LISTING,
not what has an AGE.

**`view_analytics_aging_watchlist` was deliberately NOT re-pointed** at the new view: it is a
₱-bearing view `/analytics` reads live, `CREATE OR REPLACE VIEW` **resets `reloptions`** (so
`security_invoker` would have to be re-asserted — the trap that bit `view_ops_ledger_campaign_kpis`
twice), and its own `del` CTE computes six other columns in the same grouped scan. So the expression
exists in two places and **drift is proven impossible rather than assumed**: the verify script joins
the two and requires a gap of **exactly 0** on every batch both cover (measured: **170 batches, 0
mismatches, max gap 0.0000000000000000**). Edit one copy and that assertion fails and names the other.

#### The action — `fetchBlockingAgeLens(edgeDays = [60, 120, 365])`

```ts
interface BlockingAgeBand {
  index: number;                    // 0-based, ascending by age
  lowerDays: number;                // 0 on the FIRST band — a LABEL, and NEVER null
  upperDays: number | null;         // null on the LAST band = OPEN ABOVE, never 0 days
  blockCount: number;
  kg: number;
  kgSharePct: number | null;        // PERCENT 0-100 of the DATED population; null if none dated
  blockSharePct: number | null;     // PERCENT 0-100 of the DATED population; null if none dated
  kgWeightedAgeDays: number | null; // NULL, never 0, on an empty band. Full precision
}

interface BlockingAgeLens {
  asOf: string;                          // 'yyyy-MM-dd', the Asia/Manila calendar date
  edgeDays: number[];                    // the cut lines ACTUALLY used, de-duped + ascending
  bands: BlockingAgeBand[];
  bandByBlock: Record<string, number>;   // block_loc -> band index. THE map a cell colours from
  ageByBlock: Record<string, number>;    // block_loc -> age in days, ROUNDED TO 1 DECIMAL
  undated: { blockCount: number; kg: number };
  total: {
    blockCount: number;
    kg: number;                          // includes undated kg, so the folds add up to the yard
    kgWeightedAgeDays: number | null;    // weighted over the DATED kilos only
    oldestAgeDays: number | null;
    oldestBlockLoc: string | null;
  };
}

type BlockingAgeLensResult =
  | { ok: true; lens: BlockingAgeLens }
  | { ok: false;
      reason: 'not_signed_in' | 'invalid_edge' | 'no_edges' | 'too_many_edges'
            | 'rpc_error' | 'exception';
      message: string };
```

**THE BAND MODEL.** `edgeDays` are cut lines in **DAYS** — positive whole numbers, **1…5000**,
de-duplicated and sorted (in the action **and** in SQL, by the same rule, so the two cannot
disagree), **capped at 6 after de-duplication**. `k` cut lines give `k + 1` half-open `[lower, upper)`
bands, each band's `upperDays` exactly equal to the next band's `lowerDays`.

| `edgeDays` | bands | meaning |
|---|---|---|
| `[60, 120, 365]` (default) | 4 | `[0,60)` up to 60 days · `[60,120)` · `[120,365)` · `[365,∞)` over a year |
| `[365]` | 2 | `[0,365)` · `[365,∞)` |
| `[30,60,90,120,180,365]` | 7 | the 6-cut-line maximum |

**Band 0 starts at 0 — but membership is NOT a lower-bound lookup.** It is *"how many cut lines has
this age passed"*, which is total by construction, so a **NEGATIVE** age (a future-dated delivery,
which nothing filters out) lands in band 0 rather than matching no band and vanishing out of the
folds. `lowerDays: 0` is a label for the reader, not the test. **Every band is returned even when it
holds no blocks**, so a legend can render the whole scale.

**ROUNDING, because it has a visible edge case.** `ageByBlock` is rounded to **1 decimal** (it is a
figure a cell shows) while the band was decided on the **exact** fractional age. So a block at 59.97
days reads `60.0` while sitting in band 0 — correct, not an off-by-one. **Never re-derive a band
from `ageByBlock`.** Band and total `kgWeightedAgeDays` are full precision; round them for display.

**THE UNDATED RULE — NULL IS NEVER 0 DAYS.** A block whose batch has **no dated delivery** has no
age. It is **ABSENT from `bandByBlock` and `ageByBlock`**, counted in `lens.undated`, and **excluded
from both share denominators and from every weighted age**. **UI rule: render it in its normal
un-lensed style — never in the freshest band**, and report it on its own muted row (`No delivery
dates — N blocks, X kg`). Painting it as "brand new" is the ₱11.01-vs-₱39.99 `avg_cost` bug in its
third costume, and it is the exact mirror of the price lens's `unpriced` bucket. (Live today: **0
undated blocks** — so the branch is exercised only by the invariants, not by live data. Do not read
that as "it cannot happen".)

**Invariants you can rely on** (each proven against the live database every run):
`Σ bands[].blockCount + undated.blockCount === total.blockCount` · the same for `kg` with **gap
exactly 0** · `Σ kgSharePct === 100` and `Σ blockSharePct === 100` (±1e-9, over the DATED
population) · bands contiguous from 0 with the last open above · the banded population IS the grid's
dated positive-balance blocks · `Object.keys(bandByBlock).length + undated.blockCount === total.blockCount`
· `bandByBlock` and `ageByBlock` have identical key sets · **the AGE lens and the PRICE lens describe
ONE yard** (same `total.blockCount` and same `total.kg`, gap 0 — asserted through both probes).
Scope is **occupied blocks with a POSITIVE balance**, the same population the price lens classifies —
a negative balance is misattribution (CLAUDE.md records 77 batches carrying −3.22M kg) and has no
age story.

**REFUSALS are data, never throws** — pass `message` straight to `errorToast()` (or the panel's
inline Copy banner, as the price lens does):

| `reason` | when | what the UI should do |
|---|---|---|
| `not_signed_in` | no session | reload / re-auth; not a lens problem |
| `invalid_edge` | a cut line that is not a whole number, is ≤ 0, or is > 5,000 days | reject the input |
| `no_edges` | empty cut-line list | keep at least one cut line |
| `too_many_edges` | more than 6 **distinct** cut lines | drop one |
| `rpc_error` / `exception` | database unreachable | `errorToast()` + retry |

> **The same deliberate asymmetry the price lens has.** `p_edge_days` is declared `int[]`, so
> Postgres rounds `59.5` to `60` before the function body runs and the *non-integer* refusal is
> structurally unreachable in SQL. It is enforced in the **server action**, where it IS decidable,
> under the SQL's own `invalid_edge` reason rather than a second vocabulary. SQL still refuses a
> NULL element, a non-positive and an over-5,000 cut line, so a direct RPC caller is not unguarded.

**LIVE NUMBERS, measured 2026-09-19** (`as_of` 2026-09-19, default cut lines):

| band | interval | blocks | kg | kg share | block share | wtd age |
|---|---|---|---|---|---|---|
| 0 | `[0, 60)` | 22 | 1,275,018 | 12.1779% | 13.0952% | 26.72 d |
| 1 | `[60, 120)` | 15 | 984,057 | 9.3989% | 8.9286% | 84.69 d |
| 2 | `[120, 365)` | 76 | 4,627,611 | 44.1992% | 45.2381% | 224.05 d |
| 3 | `[365, ∞)` | 55 | 3,583,213 | 34.2240% | 32.7381% | 836.97 d |

**Total 168 blocks / 10,469,899 kg**, yard-wide weighted age **396.6891 days**, oldest **1,176.0 days
at B-7B**, **undated 0 / 0**. The 6-cut-line lens splits the same yard 13 · 9 · 9 · 6 · 25 · 51 · 55.
Note the total is **byte-identical to the price lens's** `total` — that is the "one yard" assertion.

**Posture.** `view_batch_age_days` is `security_invoker`, `authenticated` SELECT only, `anon`
REVOKEd, **no `service_role`**. `fn_blocking_age_lens` is `STABLE`, `SECURITY INVOKER`,
`SET search_path = public`, EXECUTE revoked from `PUBLIC` + `anon`, granted to **`authenticated`
only** — and **NOT `service_role`** (no sync worker reads any of it, so
`verify-worker-view-grants` stays at 4 views / 0 findings, confirmed after this migration). Proven by
really calling the function as `anon` and as `service_role` and requiring both to be refused
(L-043: prove a permission by assuming the victim's role), and the view's `security_invoker` is
checked **live** from `pg_class.reloptions` because `CREATE OR REPLACE VIEW` resets it.

**Cost, measured before any proof was written** (the 2026-09-14 rule — `set local
statement_timeout='5s'` then `EXPLAIN (ANALYZE, BUFFERS)`): the per-batch age fold alone **2.57 ms /
76 buffers** (659 batch codes) · `view_blocking_grid` alone **2.85 ms / 451** · the lens's core query
**8.05 ms / 530** · `SELECT fn_blocking_age_lens()` warm **14.3 ms / 2,095** (the excess is plpgsql
planning across its eight statements; execution is the 530). `530 = 451 + 76 + 3`, so the grid is
scanned once and the age fold runs once. **Honest note on the `MATERIALIZED` hints: removing them
changes nothing here** — 530 buffers / 8.1 ms either way, because Postgres 12+ already materializes a
CTE referenced more than once and `src` is referenced three times. Unlike the price lens (85.4 ms →
4.8 ms), these are **explicit insurance** against a future edit leaving a single reference to an
expensive subtree, not a measured win. Do not claim otherwise. Both populations are bounded BY
CONSTRUCTION (one row per occupied block, 238 slots maximum; one row per batch code with a delivery,
659 today).

**The verify script reaches the function through a probe, and why.** It is `authenticated`-only by
design and no verify script holds a user JWT, so **`fn_blocking_age_lens_probe()`** (SECURITY
DEFINER, `service_role` **only**, never `authenticated`, never `anon`) is the access bridge — the same
idiom as `fn_blocking_price_lens_probe`, which was **left untouched**. **It asserts nothing**: it
calls the lens 10 times, recomputes the grid's totals and the default band split longhand and
independently, joins the age view to the watchlist, and hands everything back so every assertion
lives in readable TypeScript. It returns **no money value of any kind**.

**WHAT THE UI STILL HAS TO BUILD** (nothing below exists yet): `lens/age-lens-panel.tsx` +
`lens/age-lens-settings.ts` (the pure twin of `price-lens-settings.ts` — cut-line add/remove/
normalize, band naming keyed on the band's own **two day bounds** rather than its index, and a
kg|blocks unit switch), a `BlockingLensDefinition` with **`canShow: () => true`**, and one line in
`BLOCKING_LENSES`. **Per-user settings need NO migration** — they go in the existing
`user_table_settings` jsonb under `module = 'blocking_lens_age'` via `useLensSettings`, exactly as
the price lens does. `normalizeEdgeDays` could **not** be exported from `actions.ts` for the UI to
share: that file carries `'use server'`, so every export must be an async server function — hence
the pure twin in `lens/age-lens-settings.ts`, which is also what the price lens does.

#### ⚠️ THE AGE LENS GAINED NOTHING ON 2026-09-22, AND ITS PRINT'S LAB CELLS STAY BLANK

`fn_blocking_price_lens` now publishes `warehouseSubtotals[]` with the seven **kg-weighted** lab means
and a `warehouse` / supplier trio per block (migration `20260922093000`). **`fn_blocking_age_lens` did
not, and that is a real asymmetry rather than an oversight** — nobody asked the age print for a lab
subtotal, and the figures are not free: they cost one extra scan of
`view_blocking_block_suppliers` for the supplier half and a per-stat FILTER set for the lab half.

So on the AGE (and SUPPLIER) print, `lens/lens-summary-model.ts`'s original rule is **still binding in
full**: it makes exactly ONE sum (a band's kilograms per warehouse) and a warehouse subtotal's seven
lab cells are left **BLANK**, because *"a kg-weighted MC over a partition SQL never computed would be a
second definition of a lab average living in TypeScript"*. **A blank cell says "not published"; a
computed one would say something untrue.**

If the age print ever wants those figures, the fix is the one the price lens took — **add the keys to
`fn_blocking_age_lens` and read them** — not to compute them in the print because the price sheet has
them. `scripts/verify-blocking-lens-ui.ts` still asserts that no lens file sums a kilogram or derives
a share, with `lens-summary-model.ts`'s one warehouse subtotal as the single stated exception.


### Age lens — UI (2026-09-19)

> **SHIPPED**, as lens **#2** on the frame the price lens built. Proofs:
> `npx tsx scripts/verify-blocking-lens-ui.ts` (static + pure-function, now covering both lenses)
> beside `npx tsx scripts/verify-blocking-age-lens.ts` (the live data layer, 49).

**What it answers.** "Show me the charcoal that has been sitting." Every occupied block is tinted by
how OLD it is, with a ratio of the yard per age band, cut by default at **60 / 120 / 365 days**.

**Panel body, top to bottom.** (1) the **yard's own kg-weighted age** in mono (`396.7 days`, one
decimal on screen and the full figure on hover, because the bands were cut on the exact fractional
ages), a quiet `as of 2026-09-19 · oldest 1,176 days at B-7B` line **whose block is a button that
opens that cell**, and one sentence saying the average is weighted by the kilograms still in each
block. (2) the stacked **ratio bar** with the **kg | blocks** switch. (3) one **toggle row per band**
— swatch, label, share %, and a quiet `22 blocks · 1,275,018 kg · avg 26.7 d` second line carrying
**that band's own published weighted age**. (4) the **undated** row, when there is one. (5)
**Customize bands**.

**Labels.** `Up to 60 days` · `60 to 120 days` · `120 to 365 days` · `Over 1 year`. A bound that is
an EXACT multiple of 365 reads as years (`Over 1 year`, `1 year to 2 years`); everything else stays
in days, so a 400-day cut line reads `Over 400 days` and is never rounded into "over a year". A
two-sided span reads as years only when BOTH bounds are exact, because a mixed `120 days to 1 year`
makes the reader convert one end to compare it with the other. A name the reader typed always wins,
and it is keyed on the band's own **day interval** rather than its index.

**Customize bands.** A cut line is a whole number of **days**, 1…5,000, and the disclosure offers
one-click chips for the cuts people actually ask for — `30 · 60 · 90 · 120 · 180 · 365 · 730` —
showing only the ones not already on the scale, because a chip whose single outcome is "that cut
line is already there" exists to refuse. At most **6** cut lines, de-duplicated first and stated as
a sentence rather than a disabled button; at least one must survive (with none there is a single
band holding the whole yard, which is the same picture as no lens). Reset restores `[60, 120, 365]`.

**THE UNDATED RULE IS THE ONE THAT MATTERS**, and it is the price lens's unpriced rule in its third
costume. A block whose batch has no dated delivery is ABSENT from `bandByBlock`/`ageByBlock`; the
classifier returns `null` for it, which the grid renders as *un-lensed*, and it is reported on its
own muted `No delivery dates — N blocks, X kg` row with a line explaining that it is out of every
percentage and average. **Painting it as the freshest band would say "brand new" where the truth is
"we don't know"** — the ₱11.01-vs-₱39.99 `avg_cost` bug again. (Live today: 0 undated blocks, so the
branch is exercised by the fixture's `?undated=1` and by the data layer's invariants, not by live
data. Do not read that as "it cannot happen".)

**NOTHING IS COMPUTED IN TYPESCRIPT** — not a kilogram, not a share, not a weighted age, and not the
oldest block either (`oldestAgeDays` / `oldestBlockLoc` are the payload's, so the panel never sorts
or scans). There is no `reduce`, no `+=`, no division by a total and no `Math.min`/`Math.max` in any
age file; `verify-blocking-lens-ui.ts` asserts the absence, because a re-derivation would type-check
perfectly and let the picture disagree with the bands it describes.

**THE CELL TOOLTIP.** While the lens is active an occupied cell's native `title` gains
`"224.1 days old (average of what's in the block)"`, read from `ageByBlock`. It **EXTENDS the title
the cell already carried** (the supplier mix, joined with ` · `) rather than replacing it, and it is
absent for a block the lens cannot place. No new hover system was introduced: adding a real tooltip
to 220 cells is a different and much more expensive decision, so the lens rides the mechanism that
was already there, through `BlockingLensClassification.title` + `resolveLensCellTitle`.

**NO PRICE GATE, AND NO ₱ ANYWHERE.** `AGE_LENS.canShow` is `() => true`; the panel never mentions
`canViewPrices`; the action has no gate and must not grow one. See the data-layer section's own
warning. The visible consequences: **the Highlight button now renders for every role** (it was
price-gated in effect while Price was the only lens), Production sees Age and only Age, and a
price-viewer sees a two-tab strip.

**Colour.** Its own ramp, `.lens-age-0` … `.lens-age-6`, sky → blue → indigo → violet → purple →
fuchsia. It shares **no hue** with the cost ramp on purpose: emerald→rose means cheap→dear on this
page, so a red old block would be read as an expensive one. The ramp is declared on the
REGISTRATION (`ramp: 'age'`) and every shared piece derives its swatch from that id, so the frame
and the grid know nothing about either scale. Stops are chosen by POSITION, so the 4-band default
uses `0 · 2 · 4 · 6` and both ends of the scale are always in play.

**Data flow.** `fetchBlockingAgeLens(edgeDays)` runs when the lens mounts and whenever the cut lines
change, **debounced 250 ms** (the one shared `LENS_DEBOUNCE_MS`) and **race-safe via a request
token**, so a slow earlier reply can never overwrite a fast later one. A refusal **keeps the
previous tint** and renders inline with **Copy + Retry**; a thrown error goes to `errorToast()`.
Settings live under `module = 'blocking_lens_age'`, its own `user_table_settings` row.

**Everything else is the frame's and is unchanged**: the docking, the bottom sheet below `lg`,
Escape stepping back one rung, the mutual exclusivity with the status/lab and supplier spotlights,
and the Blend Proposal ring + checkmark riding over a lens tint exactly as they do over a supplier
ring.

### Supplier lens — DATA LAYER (2026-09-22, migrations `20260922011759_blocking_supplier_lens` + `20260922051500_blocking_supplier_lens_weighted_price`)

> **BACKEND SHIPPED.** The SQL function, the probe, the server action and the types are LIVE and
> verified. **This section IS the contract** a frontend pass should build against.
> Proofs: `npx tsx scripts/verify-blocking-supplier-lens.ts` (**65 assertions, all passing
> 2026-09-22** — 48 before the ₱ keys).
>
> **⚠️ CHANGED 2026-09-22 — THE LENS NOW CARRIES MONEY, IN EXACTLY TWO KEYS.** The owner looked at
> the supplier-lens print's band table and said its last column (*"SUPPLIER · 4,542,073 kg
> dominant"*) told him nothing the two columns beside it had not, and asked for *"average weighted
> price or something"*. So every band and `total` gained **`kgWeightedPhpKg`** and
> **`pricedDominantKg`**. Two consequences a reader must not miss: this action **now has a
> `canViewPrices()` gate** (a NULLING of those two keys — see below), and **nothing else in the
> payload moved** (measured: the whole old payload was captured before applying and compared key by
> key against the new one with the two new keys removed — **0 differing keys on N = 1, 6 and 12**).

**What it is.** The THIRD lens on the Highlight frame beside Price and Age: tint every occupied
block by WHICH SUPPLIER it holds, with a ratio of the yard per supplier. Owner-approved direction —
*"top suppliers as bands, colour each block by its biggest supplier, mark mixed blocks."* Bands are
the **top N suppliers of the CURRENT YARD** (N configurable **1…12, default 6**) plus **one `others`
band** folding everyone else.

#### ⚠️ THE PRICE GATE IS A NULLING OF EXACTLY TWO KEYS — read this first

Until 2026-09-22 this payload carried no money at all and the action deliberately had **no**
`canViewPrices()` call. It now carries **exactly two** ₱-bearing keys — `kgWeightedPhpKg` and
`pricedDominantKg`, on each band and on `total` — and **nothing else in it is money or derivable
into money**: the rest is supplier names, kilograms, counts, percentages and block addresses, and a
supplier's name beside a kilogram total says nothing about what it cost.

So `fetchBlockingSupplierLens` **nulls those two and returns everything else**, with
**`pricesHidden: true`** beside them. **The Supplier lens therefore stays fully usable by EVERY role
INCLUDING Production — the role that walks the yard** — which is the whole reason it was built
without a gate in the first place. Register it in `lens/registry.ts` with **`canShow: () => true`**
exactly as before; it also still requires a signed-in user and refuses `not_signed_in`.

**The three lenses now sit at three different points, and each is right for its own payload:**

| lens | gate | why |
|---|---|---|
| **Price** | **REFUSES** before touching the DB (`prices_hidden`) | band membership *is* price — a block's band pins its ₱/kg to within a peso, so there is no price-free half |
| **Supplier** | **NULLS two keys**, returns the rest, sets `pricesHidden` | band membership is a SUPPLIER; only the two ₱ keys are money |
| **Age** | **NO gate at all** | nothing in its payload is money and none is derivable |

The supplier lens's shape is the **`fetchBlendAnalysis` idiom** (that one deletes its whole `price`
SECTION and still returns `quality` + `age`) narrowed from a section to two keys. Asserted, not
promised: the verify script requires the gate to EXIST, to null **exactly** those two keys (it counts
the `canView ?` sites — four, no more), to set `pricesHidden`, to **fail closed** on a throw, and to
carry **no `prices_hidden` refusal reason**; it recursively scans every key of the live payload and
requires the money-named set to be **precisely those two**; and it separately re-asserts that the
AGE lens still has none, so the three-way asymmetry cannot be flattened by someone tidying up.

**Gate ORDER, and why it differs from the price lens.** It runs **after** the RPC and **before** the
payload is assembled — the `fetchBlendAnalysis` placement, because the non-price half is still wanted
so there is nothing to save by refusing early, and keeping the gate beside the mapping makes the
nulling readable. Ordering is **not** a security question here (the RPC result is nulled either way);
it **is** one for `fetchBlockingPriceLens`, which is why that one gates before `createClient()`.

#### THE ONE-DEFINITION RULE — three rules are READ, none is restated

| the question | who owns the answer | how the reuse is proven |
|---|---|---|
| Who is this supplier? | `view_blocking_block_suppliers` — `canonical_supplier(split_part(supplier,' - ',1))` | the migration **never calls** `canonical_supplier` or `split_part` (asserted); it SELECTs the view |
| Is this block ALL or SOME? | that view's `supplier_count_in_block` column | `isMixed` is carried, and asserted `=== supplierCount > 1` on every block |
| Which supplier is "the" one? | `fn_blend_block_facts` — order `kg DESC, supplier_key ASC` | **0 mismatches on all 170 batches**, on the dominant key, the count AND single-vs-mixed |

Per-block supplier kilograms and shares are checked against the view on **all 203 `(block, supplier)`
pairs — 0 mismatches**. The dominance tie rule is unambiguous: within one block the balance is a
constant, so ordering by delivered kg and ordering by `share_pct` are the SAME order.

#### ⚠️ THERE ARE **TWO** KILOGRAM ATTRIBUTIONS AND THE UI MUST NOT MIX THEM

The one genuinely new decision in this feature, forced by a measurement. A block belongs to ONE band,
but a mixed block's kilos belong to SEVERAL suppliers — so *"how many blocks does ORNALES own"* and
*"what share of the yard is ORNALES"* are different questions with different answer shapes.

| use this | for this | why |
|---|---|---|
| `dominantBlockCount` / `dominantKg` | **the grid TINT** and any block count | the blocks where this supplier is biggest, and their WHOLE balance |
| `apportionedKg` | **the yard-share RATIO BAR** | this supplier's own slice of every block it appears in |

**MEASURED 2026-09-22: 8 of the yard's 17 suppliers dominate NO block at all** — MERCADO alone
appears in 11 blocks and dominates none of them. A lens publishing only dominance would say Mercado
holds 0 kg, which is false; one publishing only apportioned kg could not colour a cell. A
`dominantKg` of **0 is a real measurement, not a missing value** — it is NOT null-preserving.

**`apportionedKg` is a slice of the BALANCE, not the delivered total.** `view_blocking_block_suppliers.kg`
is kilograms DELIVERED, so it sums to the grid's `total_in`, which exceeds the balance by every
kilogram ever fed out of an occupied block — **a structural gap that grows on every feeding**.
Measured twice ninety minutes apart on 2026-09-22: delivered **10,576,307 kg** both times, balance
**10,543,087 → 10,515,408 kg**, gap **33,220 → 60,899 kg**. The delivered figure is not discarded —
it rides as **`apportionedDeliveredKg`**, which folds to `total_in` (asserted) and so is a *third*
number again. Do not size a bar from it.

**THE PRO-RATA IS AN APPORTIONMENT, NOT A MEASUREMENT, and it must be labelled that way.** There is
NO FIFO by supplier and none is possible — `rc_out` records which BATCH kilos left, never whose —
the identical argument `view_analytics_aging_eom` records for age. So `apportionedKg` on a block that
has been fed is an *estimate* of whose charcoal remains. It is exact on every block never fed (the
gap above is 0.58% of the yard), and `dominantKg` needs no apportionment ever.

#### ⚠️ THE WEIGHTED ₱/kg — what it IS, and what it is NOT (2026-09-22)

**`kgWeightedPhpKg` = the kg-weighted mean of `view_blocking_grid.avg_php_kg`** — the same per-block
price the Blocking cell displays, never a second definition of what a block cost — **taken over the
band's DOMINANT blocks**, i.e. exactly the population `dominantBlockCount` / `dominantKg` describe.
That choice is what makes it *the price of the kilograms on its own row*.

> **IT IS NOT THE PRICE OF THIS SUPPLIER'S CHARCOAL, AND IT CANNOT BE.** `avg_php_kg` is a price per
> **BLOCK**; no per-supplier ₱/kg exists in the database and none is derivable, because `rc_out`
> records which BATCH kilos left and never *whose*. So on a **mixed** block every supplier in it
> shares one price, and a supplier that dominates nothing has **no price figure at all** (null beside
> a real `apportionedKg`). **Label it accordingly** — "price of the blocks they dominate", never
> "what we paid ORNALES".

**Why dominance and not `apportionedKg`.** Weighting a block's real price by a *pro-rata estimate*
would put an estimate inside a money figure — and the figure would then not describe the kilograms on
its own row. (Asserted: the migration's executable SQL never multiplies `avg_php_kg` by an apportioned
quantity.)

**PRICED BLOCKS ONLY — the L-008 rule, and the predicate is the price lens's word for word.**
`avg_php_kg` **null or ≤ 0 is the unpriced placeholder, not a ₱0 block**; averaging it in adds weight
to the denominator and nothing to the numerator, which is exactly how `batches.avg_cost` came to read
**₱11.01 against a real ₱39.99**. The predicate is literally `(g.avg_php_kg IS NULL OR g.avg_php_kg <= 0)`
— the same string `fn_blocking_price_lens` uses to decide its `unpriced` bucket, asserted in both
files — so the two lenses can never disagree about which blocks have a price.

**`pricedDominantKg` is the WEIGHT the mean was taken over**, published so the coverage is visible.
**Compare it with `dominantKg` and SAY SO** when it is smaller ("₱43.5690 over 4.5M of 4.6M kg"),
rather than implying the price covers the whole band.

**THREE blank-vs-zero rules the UI must not conflate:**

| reading | means | how to tell |
|---|---|---|
| `kgWeightedPhpKg` null, `pricedDominantKg` **0** | the band dominates **no priced block** — no charcoal with a price means no price | `pricesHidden === false` |
| `kgWeightedPhpKg` null, `pricedDominantKg` **null** | **WITHHELD** from a price-denied reader | `pricesHidden === true` |
| `pricedDominantKg` **0** with `dominantKg > 0` | the band's blocks are all unpriced | a real measurement, print "no price yet" |

Never print a blank as **₱0**. Same key name, same NULL rule, same population asymmetry as
`BlockingPriceBand.kgWeightedPhpKg` — **one name, one meaning, across both lenses.**

**On `total`** the pair is weighted over the **PRICED ATTRIBUTED** blocks while `total.blockCount` and
`total.kg` still count **every** occupied block, priced or not — the deliberate asymmetry
`fn_blocking_price_lens` records: the counts are a count of the yard, the price is a price of what is
priced. An **unattributed** block cannot carry a price anyway (no deliveries ⇒ no `avg_php_kg`), which
is measured every run (`price_check.unattributed_priced_count` must be 0), so the two populations
coincide.

> **MEASURED 2026-09-22, and this is the honest limit of the live proof: all 170 occupied blocks carry
> a price today**, so `pricedDominantKg` equals `dominantKg` on every band and the NULL / partial-
> coverage branch is exercised by the invariants and the SQL text, **not** by live data — exactly as
> the `unattributed` bucket already is. That is not "it cannot happen": an unpriced delivery is a
> normal daily stage (L-039), so a band **will** eventually price only part of its balance. That is
> precisely why the weight is published beside the price.

#### The action — `fetchBlockingSupplierLens(topN = 6)`

```ts
interface BlockingSupplierSlice {          // one supplier inside one block, for a tooltip
  key: string; display: string;
  kg: number;                              // DELIVERED — sums to the block's total_in
  sharePct: number;                        // PERCENT 0-100 of delivered kg; sums to 100
  balanceKg: number;                       // pro-rata slice of the balance; sums to block kg
}

interface BlockingSupplierBand {
  index: number;                           // 0-based, DESC by apportionedKg; others is LAST
  key: string | null;                      // null on the others band — read isOthers
  display: string | null;                  // null on the others band
  isOthers: boolean;
  supplierCount: number;                   // 1 on a named band; the fold size on others
  supplierKeys: string[] | null;           // ONLY on the others band, so the UI can name it
  dominantBlockCount: number;              // TINT / block counts. A real 0 is possible
  dominantKg: number;                      // TINT. A real 0 is possible
  apportionedKg: number;                   // RATIO BAR — use this one
  apportionedDeliveredKg: number;          // folds to total_in, NOT to total.kg
  kgSharePct: number | null;               // PERCENT on APPORTIONED kg; null if none attributed
  blockSharePct: number | null;            // PERCENT on DOMINANT blocks; null if none attributed
  mixedBlockCount: number;
  kgWeightedPhpKg: number | null;          // ₱/kg over the band's PRICED DOMINANT blocks.
                                           //   NULL never 0. null+pricesHidden = WITHHELD
  pricedDominantKg: number | null;         // the WEIGHT that mean used. Real 0 when nothing
                                           //   priced; null only when WITHHELD
}

interface BlockingSupplierLens {
  topN: number;
  bands: BlockingSupplierBand[];
  bandByBlock: Record<string, number>;               // block_loc -> band index. THE tint map
  blockByLoc: Record<string, BlockingSupplierBlock>; // same key set as bandByBlock
  unattributed: { blockCount: number; kg: number };
  total: {
    blockCount: number; kg: number;
    supplierCount: number;                 // an others band exists IFF this exceeds topN
    mixedBlockCount: number;
    attributedBlockCount: number; attributedKg: number;
    kgWeightedPhpKg: number | null;        // the YARD's ₱/kg, over the PRICED blocks only —
                                           //   while blockCount/kg above count them ALL
    pricedDominantKg: number | null;        // = Σ bands[].pricedDominantKg, exactly
  };
  pricesHidden: boolean;                   // TRUE = the two ₱ keys were WITHHELD, not absent
}

// BlockingSupplierBlock: blockLoc · batchId · batchCode · bandIndex ·
//   dominantSupplierKey · dominantSupplierDisplay · dominantSharePct | null ·
//   isMixed · supplierCount · kg (BALANCE) · suppliers: BlockingSupplierSlice[]

type BlockingSupplierLensResult =
  | { ok: true; lens: BlockingSupplierLens }
  | { ok: false; reason: 'not_signed_in' | 'invalid_top_n' | 'rpc_error' | 'exception';
      message: string };
```

**THE BAND MODEL.** Suppliers are ranked by `apportionedKg` **DESC**, then `display` ASC, then
`supplierKey` ASC — the last is unique, so the order is **TOTAL** and two equally large suppliers
cannot make consecutive calls disagree. The first N get a band each at index `0…N-1`; every remaining
supplier folds into ONE `others` band at index N, **present iff `total.supplierCount > topN`**
(asserted both ways). A named band always holds exactly one supplier and publishes **no**
`supplierKeys`; `others` publishes the list and carries `key: null` / `display: null` — **the UI owns
the "Others" label**, the payload does not name it. The ranking does not depend on N (asserted: the
first six named at N=12 are the same six, in the same order, as at N=6).

> Measured 2026-09-22: ranking by apportioned kg and by delivered kg give the **identical order on
> all 17 suppliers today**. They are not the same rule and may diverge; the apportioned one ships.

**THE UNATTRIBUTED RULE.** A block whose batch has **no delivery row at all** has no supplier. It is
**ABSENT from `bandByBlock` and `blockByLoc`**, counted in `lens.unattributed`, and excluded from both
share denominators — the exact mirror of the price lens's `unpriced` and the age lens's `undated`.
**UI rule: render it in its normal un-lensed style and NEVER fold it into `others`** — that would
assert a supplier we do not have — and report it on its own muted row. (Live today: **0 unattributed
blocks**, so the branch is exercised by the invariants, not by live data. Do not read that as "it
cannot happen".)

**Invariants you can rely on** (each proven against the live database every run):
`Σ dominantBlockCount + unattributed.blockCount === total.blockCount` · `Σ dominantKg +
unattributed.kg === total.kg` · `Σ apportionedKg + unattributed.kg === total.kg` · `Σ
apportionedDeliveredKg === the grid's total_in` (a *different* number) · `Σ kgSharePct === 100` and
`Σ blockSharePct === 100` over the ATTRIBUTED population · band indices contiguous from 0 with
`others` last and at most one · every block's slices sum to its `kg` and to 100% · the dominant
supplier IS the biggest slice · **the SUPPLIER, AGE and PRICE lenses describe ONE yard** (same
`total.blockCount`, same `total.kg`, gap 0 — asserted through all three probes) · **`Σ
pricedDominantKg === total.pricedDominantKg` EXACTLY, at every N** (a plain sum of balances over a
partition, so there is no division in it) · **every published `kgWeightedPhpKg` === `Σ(balance ×
avg_php_kg) ÷ Σ(balance)` over that band's PRICED dominant blocks**, recomputed INDEPENDENTLY off
`view_blocking_grid` in exact `numeric` by the probe — **gap 0 on all 7 bands and on `total`** · the
money-named key set of the whole payload is **precisely `kg_weighted_php_kg` + `priced_dominant_kg`**,
and neither appears on a block or a supplier slice.

> **⚠️ THE APPORTIONED FOLD IS NOT BIT-EXACT — do not write `===` against it.** `dominantKg` is a
> plain sum of balances, so it folds **exactly 0.00**, as do the block counts and the delivered fold.
> `apportionedKg` multiplies by `sharePct`, itself a `numeric` division truncated at a finite scale,
> so the slices carry that residue: **5.9e-14 kg against a 10,515,408 kg yard** measured in SQL (six
> parts in 10²¹), and **−1.9e-9 kg** once the payload has been through JSON and JavaScript doubles.
> The verify script therefore sources its exactness claim from **gaps the probe computes in `numeric`**
> and bounds this one at 1e-6 kg. Compare with a tolerance; never "correct" a band to make a total tie.

**REFUSALS are data, never throws** — pass `message` straight to `errorToast()` (or the panel's
inline Copy banner, as the price lens does):

| `reason` | when | what the UI should do |
|---|---|---|
| `not_signed_in` | no session | reload / re-auth; not a lens problem |
| `invalid_top_n` | `topN` absent, not a whole number, below 1, or above 12 | reject the input |
| `rpc_error` / `exception` | database unreachable | `errorToast()` + retry |

> **The same deliberate asymmetry the price and age lenses have.** `p_top_n` is declared `int`, so
> Postgres rounds `6.5` to `7` before the function body runs and the *non-integer* refusal is
> structurally unreachable in SQL. It is enforced in the **server action**, where it IS decidable,
> under the SQL's own `invalid_top_n` reason. SQL still refuses NULL, `< 1` and `> 12`, so a direct
> RPC caller is not unguarded — and **a NULL `p_top_n` is REFUSED, never silently defaulted to 6**
> (omitting the argument is what gets the default).

**LIVE NUMBERS, measured 2026-09-22** (top 6; `dom` = dominance, `apn` = apportioned):

| band | supplier | dom blocks | dom kg | apportioned kg | kg share | block share | mixed | **₱/kg (priced dom)** |
|---|---|---|---|---|---|---|---|---|
| 0 | ORNALES | 78 | 4,542,073 | 4,397,468 | 41.8193% | 45.8824% | 11 | **43.5690** |
| 1 | PAQUIBOT | 58 | 3,803,259 | 3,821,834 | 36.3451% | 34.1176% | 0 | **37.1574** |
| 2 | 2023 BACKLOG | 11 | 769,731 | 769,731 | 7.3200% | 6.4706% | 0 | **17.6566** |
| 3 | LLANTO | 7 | 448,643 | 394,437 | 3.7510% | 4.1176% | 6 | **29.9501** |
| 4 | SEVILLA | 5 | 306,246 | 306,246 | 2.9124% | 2.9412% | 0 | **19.0265** |
| 5 | LAYUPAN | 6 | 407,800 | 299,111 | 2.8445% | 3.5294% | 5 | **20.7090** |
| 6 | **OTHERS (11)** | 5 | 237,656 | 526,581 | 5.0077% | 2.9412% | 1 | **33.0862** |

**Total 170 blocks / 10,515,408 kg / 17 suppliers / 23 mixed / unattributed 0, yard ₱36.9339/kg over
10,515,408 priced kg.** Note the total is **byte-identical to the price and age lenses'** — that is
the "one yard" assertion. N=1 → 2 bands, N=6 → 7, N=12 → 13.

The **₱ spread is the point of the column** — ₱17.6566 (2023 BACKLOG) to ₱43.5690 (ORNALES) against a
yard mean of ₱36.9339, which is information the two kilogram columns beside it genuinely did not
carry. `pricedDominantKg` equals `dominantKg` on every band today (all 170 blocks priced), so the
coverage is 100% everywhere; **that will not stay true** and the UI must print the weight when it
diverges. **The live function is always the authority for these figures** — the invariants, not the
numbers, are what this section guarantees.

**Posture.** `fn_blocking_supplier_lens` is `STABLE`, `SECURITY INVOKER`, `SET search_path = public`,
EXECUTE revoked from `PUBLIC` + `anon`, granted to **`authenticated` only** — and **NOT
`service_role`** (no sync worker reads it, so `verify-worker-view-grants` stays at 4 views / 0
findings, confirmed after this migration). Proven by really calling it as `anon` and as
`service_role` and requiring both to be refused (L-043: prove a permission by assuming the victim's
role). Exactly **one** overload may exist (asserted) — a second would be a second home for the band
logic. The migration is **strictly additive**: it does not `CREATE OR REPLACE` the price lens, the
age lens, `fn_blend_block_facts` or `view_blocking_block_suppliers`, and asserts it does not — that
view's `security_invoker` is also checked **live** from `pg_class.reloptions`, because
`CREATE OR REPLACE VIEW` resets it.

**Cost, measured before any proof was written** (the 2026-09-14 rule — `set local
statement_timeout='5s'` then `EXPLAIN (ANALYZE, BUFFERS)`): `view_blocking_block_suppliers` alone
**36.7 ms / 239 buffers** warm (its first call 120.7 ms — `canonical_supplier()` per delivery row is
the whole cost, and it is paid inside that view) · `view_blocking_grid` alone **2.4 ms / 455** · the
lens's core query **29.7 ms / 679** · `SELECT fn_blocking_supplier_lens(6)` warm **48.0 ms / 2,174**
(first call 168.5 ms; the excess over 679 is plpgsql planning, execution is the 679). `679 = 455 + 221
+ 3`, so the grid is scanned once and the supplier view once. **Honest note on the `MATERIALIZED`
hints: removing them changes essentially nothing** — the equivalent un-hinted query measured **35.5 ms
/ 680 buffers**, because Postgres 12+ already materializes a CTE referenced more than once and every
CTE here is. They are **explicit insurance** against a future edit leaving a single reference to an
expensive subtree, exactly as the age lens records, and **unlike** the price lens (85.4 ms → 4.8 ms)
they did not buy the number. Both populations are bounded BY CONSTRUCTION (one row per occupied block,
238 slots maximum; one row per `(block, supplier)` pair, 203 today).

**Cost of the two ₱ keys, measured the same way on 2026-09-22 — and the number that moved is reported
rather than rounded away.** The **core query did not move at all: 680 buffers before, 680 after**
(40.8 → 43.4 ms), and the plan after the change still shows ONE `view_blocking_grid` scan (453) and
ONE `view_blocking_block_suppliers` scan (218) with the identical CTE structure — **no new relation is
touched.** `avg_php_kg` is a column that view already computes and `src` already scans, so carrying it
costs one more column in an existing 170-row CTE, and the two aggregates are FILTERed sums over `dom`,
a 170-row CTE already MATERIALIZED and already scanned by `dom_by_band`. **`SELECT
fn_blocking_supplier_lens(6)` did move: 2,174 → 2,294 buffers (+120), 47.9 → 52.6 ms warm** (109.4 and
88.4 ms on the first two calls after the replacement — cold plpgsql planning, the same shape the
original migration records at 168.5 cold vs 48.0 warm). Since the core query's buffer count is
unchanged, **that +120 is plpgsql PLANNING of a slightly larger statement, not data**.

**The verify script reaches the function through a probe, and why.** It is `authenticated`-only by
design and no verify script holds a user JWT, so **`fn_blocking_supplier_lens_probe()`** (SECURITY
DEFINER, `service_role` **only**) is the access bridge — the same idiom as the price, age and
blend-facts probes, all three of which were **left untouched**. **It asserts nothing**: it calls the
lens 8 times, recomputes the grid's totals and the per-supplier yard aggregation longhand and
independently, reads `view_blocking_block_suppliers` and `fn_blend_block_facts` so the one-definition
proofs are agreements rather than tautologies, and computes the **fold gaps in exact `numeric`**.

**Its `price_check` (2026-09-22) is the independent witness to the two ₱ keys**: it recomputes the
weighted mean and its weight longhand off `view_blocking_grid`, joined to the lens's OWN published
band membership (already proven correct by the two one-definition reads, so what gets a second witness
is the *weighted average* — the only new arithmetic), and returns **GAPS in exact `numeric` that must
be 0**, plus kilogram weights, counts and two is-null flags that make a NULL gap decidable instead of
ambiguous. **NARROWED CLAIM:** the probe used to state it returned *no money value of any kind*; it
**forwards** the lens payload, which now carries the two ₱ keys, so it does return those two.
Everything the probe itself **computes** is still money-free — gaps that must be 0, kilograms, counts
and booleans.

> **The paragraph below is the ORIGINAL 2026-09-22 build brief and is now HISTORY — the UI shipped
> the same day; see "Supplier lens — UI" immediately after this section.** It is kept because the
> colour reasoning in its last two sentences is still the rule. **The one thing it does NOT cover is
> the ₱ column added later that day**: the band table and the print's band table should render
> `kgWeightedPhpKg` (and say the coverage from `pricedDominantKg` when it is below `dominantKg`), the
> column must be **absent** — not blank, not ₱0 — when `pricesHidden` is true, and the lens itself
> must still render in full for that reader.

**WHAT THE UI STILL HAS TO BUILD** (nothing below exists yet): `lens/supplier-lens-panel.tsx` +
`lens/supplier-lens-settings.ts` (the pure twin of `price-lens-settings.ts` / `age-lens-settings.ts`
— the N stepper, band naming keyed on the band's **supplier key** rather than its index, and a
kg|blocks unit switch **which must switch between `apportionedKg` and `dominantBlockCount`, i.e.
between the two attributions**), a `BlockingLensDefinition` with **`canShow: () => true`**, and one
line in `BLOCKING_LENSES`. **Per-user settings need NO migration** — they go in the existing
`user_table_settings` jsonb under `module = 'blocking_lens_supplier'` via `useLensSettings`, exactly
as the other two lenses do. Note the panel needs a **colour per supplier**, not a sequential ramp:
unlike price and age bands, these bands are nominal categories with no order that a gradient could
mean — and the existing supplier spotlight's green/orange already means ALL/SOME, so reusing those
two hues for band identity would collide.

### Supplier MARKET — DATA LAYER (2026-09-22, migration `20260922094500_blocking_market_context_and_supplier_market`)

**What it is for.** The supplier lens says *whose* charcoal is in the yard. This says what each of
them has been **charging** and how much they have been **sending**, so the supplier print's context
block can state *"ORNALES is 40% of the yard and has come DOWN 11.7% over the year"* without a
TypeScript average anywhere.

#### The action — `fetchBlockingSupplierMarket(months = 12, supplierKeys?)`

```ts
interface BlockingSupplierMarketPoint {
  month: string;                     // 'yyyy-MM-01'
  kg: number;                        // may legitimately be 0 on a sundry-only row
  pricedKg: number;
  avgPricePhpKg: number | null;      // the view's own column. NULL, NEVER 0
  premiumPhpKg: number | null;       // + = paid ABOVE the month's market. NULL, NEVER 0
  shareOfMonthPct: number | null;    // PERCENT 0-100 of the month's market kilograms
  deliveryCount: number;
}

interface BlockingSupplierMarketSummary {
  monthsActive: number;              // months with a REAL purchase (kg > 0)
  totalKg: number;  totalPricedKg: number;  deliveryCount: number;
  kgWeightedPhpKg: number | null;    // Σ₱ ÷ Σ priced kg — NEVER the mean of monthly averages
  firstMonth: string | null;  lastMonth: string | null;   // first/last ACTIVE month
  firstPrice: number | null;  lastPrice: number | null;
  priceChangePhpKg: number | null;
  priceChangePct: number | null;     // NULL when firstPrice is NULL or 0
  kgChangePct: number | null;        // last vs first ACTIVE month
  priceVolumeCorr: number | null;    // Pearson corr(price, kg). NULL under 3 priced months
  corrMonthCount: number;            // read this BEFORE printing the correlation
  direction: 'up' | 'down' | 'flat' | null;   // ±2% dead band. NULL, never 'flat', with no change
  avgPremiumPhpKg: number | null;    // PRICED-KG-WEIGHTED. The only legal way to average it
}

interface BlockingSupplierMarket {
  monthsRequested: number;  asOf: string;
  fromMonth: string | null;  toMonth: string | null;
  directionDeadBandPct: number;               // 2.0 — READ IT, never hardcode the threshold
  supplierKeysRequested: string[] | null;     // NULL = every active supplier
  months: string[];                           // THE WINDOW'S spine — see below
  suppliers: Array<{ key: string; display: string;
                     series: BlockingSupplierMarketPoint[];
                     summary: BlockingSupplierMarketSummary }>;   // total kg DESC, then key
  supplierCount: number;
  windowTotal:   { marketKg: number; marketPricedKg: number;
                   marketPhpKg: number | null; deliveryCount: number };  // the WHOLE window
  selectedTotal: { /* same shape */ };                                    // the SELECTION
}

type BlockingSupplierMarketResult =
  | { ok: true; market: BlockingSupplierMarket }
  | { ok: false; reason: 'prices_hidden' | 'invalid_months' | 'no_suppliers'
              | 'too_many_suppliers' | 'rpc_error' | 'exception';
      message: string };
```

**NOTHING IS A SECOND DEFINITION.** Every figure is aggregated from
`view_analytics_supplier_monthly` (analytics Phase 3), which owns supplier identity, the per-supplier
weighted price, `share_of_month_pct` and `premium_php_kg`, and which joins its month baseline **FROM**
the Phase-1 view — which is exactly what makes a share and a premium structurally incapable of
disagreeing with the `/analytics` matrix. **MARKET deliveries only:** a sundry re-entry and a re-cook
fee are never supplier volume.

**IDENTITY AGREES WITH THE LENS — MEASURED, NOT ASSUMED, and the interesting half is the non-zero.**
The lens keys on `canonical_supplier(split_part(supplier, ' - ', 1))` and this on
`canonical_supplier(supplier)` — **different expressions**, so handing `BlockingSupplierBand.key`
straight in is a claim that needs proving. Three measurements, all 2026-09-22, all asserted every run:

* **16 of the 68 distinct supplier strings DO change under the strip** (the sundry re-entries carrying
  a `- <BATCH>` suffix). This is asserted to be **> 0** on purpose — if the strip ever became a no-op
  the next assertion would pass **vacuously**.
* **NOT ONE of the 1,683 MARKET deliveries carries any of those 16 strings.** That is the claim the
  frontend relies on, and it is checked as *"no market delivery is in the differing set"*, which needs
  no class call at all while the set stays disjoint.
* **All 17 of the yard's supplier keys are keys this view knows — 0 unknown** (27 canonical suppliers
  in all history), and every non-`others` band key is one of them.

**ONE HONEST NAMING DIFFERENCE:** the analytics view publishes only the CANONICAL name, so
`display === key` here (`ORNALES`). The prettier raw spelling (`Ornales`) lives on
`BlockingSupplierBand.display`. **Take the label from the lens and join on `key`** — this payload does
not invent a name it does not have.

**THE MONTH SPINE IS THE WINDOW'S, NOT THE SELECTION'S — and that was found by TESTING.** With the
key filter applied to the source CTE, asking for a supplier that sold nothing returned an **EMPTY
`months[]`**: a chart with no axis to draw the gap on. The filter moved downstream (which costs
nothing — it never reduced the view scan, only the rows the CTE carried), and for the same reason
there are **TWO totals**: `windowTotal` is the whole window's market, *unaffected* by
`supplierKeysRequested`, so a supplier row is comparable to **the market** rather than to its
neighbours in a filtered call; `selectedTotal` is the selection's own. **Asserted: they are equal
when nothing is filtered, and `windowTotal` does NOT move under a filter.** Live: window
**14,112,678 kg**, a top-3 selection **11,161,270 kg (79.1%)**.

**A KEY THAT MATCHES NOTHING RETURNS NO ENTRY, never a zero-filled row** — inventing one would put a
supplier on a chart it is absent from. Compare what you asked for against
`market.suppliers.map(s => s.key)`. `supplierKeys` is de-duplicated and blank-stripped **before** the
40-entry cap is measured, and a list that strips to nothing is refused `no_suppliers` (never silently
read as "everyone"); omitting the argument entirely *is* "everyone".

**NULL IS NEVER 0, in five places.** A price, a premium, a correlation, a change and a **direction**
are each NULL rather than zero when the thing they describe does not exist — and `direction` is NULL
rather than `'flat'`, because *flat is a claim*. Kilograms and counts are real 0s, because they are
weights.

* **`priceVolumeCorr` is NULL below THREE priced active months** — two points always correlate
  perfectly, so a two-month ±1 is arithmetic and not a finding. Read `corrMonthCount`. It is proven
  equal to Postgres' own `corr()` recomputed independently (max |gap| **1.9e-15** across 18
  suppliers, 0 null-disagreements). **It is ₱-DERIVED**, so it sits inside the price gate however it
  is labelled.
* **`direction` reads `priceChangePct` with a ±2% DEAD BAND**, published as
  `directionDeadBandPct` so a UI can label it and the verify script can pin it: month-to-month noise
  on a weighted purchase price is routinely a peso, and calling every wobble a trend is how a chart
  starts lying.
* **`avgPremiumPhpKg` is PRICED-KG-WEIGHTED and may only ever be** — CLAUDE.md's rule, load-bearing
  here: a month's market price *is* the priced-kg-weighted mean of its suppliers' prices, so an
  unweighted average of the premium column is meaningless. The verify script asserts it is NOT the
  unweighted mean whenever the two differ.

**THE GATE IS A REFUSAL, AND THE ALTERNATIVE WAS CONSIDERED.** A nulled variant would leave a
per-supplier monthly kilogram series with its share and count — and
`view_digest_rcin_supplier_daily` and `fn_blocking_supplier_lens` **already publish exactly that to
every role**, at grains that suit their own screens. A third, half-blank copy buys a denied reader
nothing and costs the payload a second meaning. So this follows `fetchBlockingPriceLens` (refuse
before `createClient()`), **not** `fetchBlockingSupplierLens` (null two keys, ship the rest). The
three-way asymmetry is asserted in both verify scripts.

**Live sample, 2026-09-22 (N = 12, 18 suppliers over 12 months; N = 36 → 25 over 36):**

| supplier | total kg | ₱/kg (wtd) | direction | Δ price | corr | premium |
|---|---|---|---|---|---|---|
| ORNALES | 5,620,744 | ₱44.9225 | down | −11.67% | 0.264 (12m) | +0.4968 |
| PAQUIBOT | 4,026,404 | ₱45.5444 | down | −10.07% | 0.597 (12m) | +0.8267 |
| TAG-AT | 1,514,122 | ₱44.3977 | down | −12.36% | 0.735 (12m) | −0.3792 |

**COST: ~290 ms / 1,521 buffers**, analytics view read **exactly once**. Bounded by construction:
**267 (supplier × month) rows inside the 36-month maximum** against 281 for all of history — three
orders of magnitude under PostgREST's 1,000-row cap. The window filters already-grouped output, so
narrowing it saves nothing; making it cheaper would mean re-deriving "market".

**Probe:** `fn_blocking_supplier_market_probe()` (SECURITY DEFINER, `service_role` only). It asserts
nothing — it forwards four calls (including a key-filtered one on the three REAL biggest suppliers
and a key that matches nothing), reads the view's own 36-month rows, recomputes `corr()` and the
identity agreement independently, and hands everything back. It is **separate** from
`fn_blocking_market_context_probe()` because one function holding both halves timed out at 20 s — see
that section for the rule.

### Supplier lens — UI (2026-09-22)

> **SHIPPED**, as lens **#3** on the frame the price lens built and the age lens proved
> extensible. Proofs: `npx tsx scripts/verify-blocking-lens-ui.ts` (**198 assertions** — 167
> on 2026-09-22, plus 19 for the YARD MAP page, 8 for the band table's ₱/kg · Mixed column
> and 4 for the print palette, all the same day) beside
> `npx tsx scripts/verify-blocking-supplier-lens.ts` (the live data layer, **65**). Look rig:
> `/dev/table-playground/supplierlens` — `?top=`, `?unattributed=1`, `?prices=0`, and
> **`?pca=1`** (stock in PCA/PCB, which is what makes the printed yard map's worst-case
> geometry reachable).
>
> **⚠️ THE DATA LAYER MOVED LATER THE SAME DAY** — the section immediately above is no longer
> "unchanged": the payload gained the two ₱ keys and `pricesHidden`, and this panel reads
> `caps.canViewPrices` in **exactly one place** for **exactly one decision** (the printed band
> table's last column — see "THE SUPPLIER BAND TABLE'S LAST COLUMN" under the lens print). The
> lens itself, its bands, its kilograms, its ratio bar, its yard map and its **Print button**
> stay unconditional and must stay so.

**What it answers.** "Whose charcoal is in my yard." Every occupied block is tinted by the
supplier that holds the MOST of it, with a ratio of the yard per supplier, cut at the top
**N** (1…12, default 6) plus one `others` fold.

**Legend bar, left to right.** the headline `17 suppliers · 23 mixed` (both the payload's own
figures) · one shared chip per band, labelled with the supplier's `display` and `Others (11)`
for the fold, each carrying its share · the shared ratio bar · a muted `No supplier — N` chip
when there is one · Print · the `kg | blocks` switch · the gear.

**Settings popover, top to bottom.** (1) the yard's supplier count, how many blocks hold more
than one supplier, and ONE line saying *which figure the tint uses and which the bar uses*.
(2) the detailed band rows, whose quiet second line reads `78 blocks dominant · 4,542,073 kg
dominant · 4,397,468 kg apportioned · ₱43.5690/kg · 11 mixed` — **both attributions named,
because they legitimately disagree**. The `kg dominant` term lives HERE and nowhere else since
the printed band table swapped it for the ₱/kg (2026-09-22): it is still the attribution the
TINT is drawn from, and the popover is where a reader goes to ask what a colour means. The ₱/kg
term is dropped for a reader without the effective price flag, and dropped for a band with no
price — never printed as ₱0.
(3) the muted no-supplier row. (4) **Top suppliers**: a number input 1…12 with Apply and
Reset. There is no Customize-bands disclosure, because there are no cut lines to move.

#### ⚠️ THE TWO KILOGRAM ATTRIBUTIONS, AND WHERE EACH ONE IS ALLOWED TO APPEAR

The one genuinely new decision on the UI side, and it is forced by the data layer's own
measurement: **8 of the yard's 17 suppliers dominate NO block at all** (MERCADO appears in 11
blocks and dominates none). So *"how many blocks does ORNALES own"* and *"what share of the
yard is ORNALES"* are different questions.

| surface | reads | why |
|---|---|---|
| the grid TINT, and every block COUNT | `bandIndex` / `dominantBlockCount` / `dominantKg` | a cell can only be ONE colour, so it is the biggest supplier's |
| the RATIO BAR, and the kg share | `apportionedKg` via `kgSharePct` | a mixed block's kilos belong to several suppliers |

**The `kg | blocks` switch therefore does not re-scale one number — it switches between the
two attributions** (`kgSharePct` ↔ `blockSharePct`), which is why the popover says so outright
rather than leaving a reader to assume. `verify-blocking-lens-ui.ts` asserts the classifier
never reads an apportioned figure and that a printed block count is always the dominant one.

**Never `===` the apportioned fold.** The contract records a **−1.9e-9 kg** residue once the
payload has been through JSON and JavaScript doubles; the panel compares nothing and totals
nothing, and the verify script asserts the absence of such a test.

#### THE MIXED MARKER — a DASHED INSET OUTLINE, and why that shape

A block whose charcoal came from more than one supplier wears `.lens-cat-mixed` on top of its
band tint: `outline: 1.5px dashed rgb(var(--lens-hue) / 0.95)` at `outline-offset: -3px`, plus
the full split on the cell's native `title` (`Llanto 71% · Ornales 22% · Sevilla 6%`). Each of
those three words was a choice:

- **DASHED**, because every other marking on this grid is solid — both supplier-search glows,
  every status glow, the lens tint's own inset ring and `.lens-band-picked`. A broken line is a
  shape nothing else on the page uses.
- **an OUTLINE** rather than a `box-shadow`, so it cannot fight the tint rule's shadow or the
  picked band's louder one. A mixed block that is ALSO isolated wears both and neither is lost.
- **INSET**, so it cannot be read as the **BLEND-SELECTION** marking — which is a solid
  `ring-2 ring-primary` plus a filled primary circle carrying a checkmark at the **top-right**.
  Different shape, different colour (the band's hue, never `--primary`), different position.
  The verify script asserts all four of those differences.

**`isMixed` is the VIEW's carried `supplier_count_in_block > 1`, never `suppliers.length`** —
the data layer states that outright and the UI honours it; the verify script asserts the panel
never reads a list length.

#### EXCLUSIVITY WITH THE SUPPLIER SEARCH — already true, and now stated

Opening any lens resets `statusFilter` to `ALL` and drops the supplier spotlight in the SAME
`URLSearchParams` write, and choosing a supplier clears the lens's tint on that frame. Both
halves were already generic in `blocking-grid.tsx` / `blocking-route-view.tsx`, so the supplier
lens inherited them with **no change** — but the pairing matters more here than for the other
two, because the search's emerald/orange glow and a supplier BAND tint would otherwise be two
supplier vocabularies on one screen. They can never both be on.

#### COLOUR — a NOMINAL palette, twelve hues and a reserved grey

`.lens-cat-0` … `.lens-cat-12`: sky · violet · rose · amber · teal · fuchsia · lime · indigo ·
cyan · pink · yellow · blue, then **zinc as a reserved NEUTRAL that only `others` wears**. A
band takes the stop matching its own RANK, so a supplier's colour does not move when N changes,
and the fold never wears a supplier's identity. They JOIN the shared tint rule, so they inherit
the measured 22% (light) / 30% (dark) alpha and the inset-ring technique verbatim.
`LENS_RAMP_RGB.category` is a deliberate second copy for the iframe printout and is **proven
equal to `globals.css`** by `verify-blend-analysis-ui.ts`.

**UNATTRIBUTED IS NOT `OTHERS`.** A block whose batch has no delivery at all has no supplier:
it is absent from `bandByBlock`, the classifier returns `null`, the cell keeps its normal
un-lensed look, and it is reported on its own muted row. Folding it into `others` would assert
a supplier we do not have — the ₱11.01-vs-₱39.99 `avg_cost` mistake in its fourth costume.

**Persistence** is `user_table_settings` under `module = 'blocking_lens_supplier'`, through the
existing `useLensSettings` — **no migration**, exactly as the other two lenses.

**Everything else is the frame's and is unchanged**: the docking, the bottom sheet below `lg`,
Escape stepping back one rung, the `?lens=supplier` deep link, the fallback to another visible
lens, and the Blend Proposal ring + checkmark riding over a lens tint.

### The CONTROL STRIP, the LEGEND BAR and the blend table's supplier columns (2026-09-21)

> **SHIPPED.** Four changes from the owner's review of the LIVE page, plus a SECOND
> PASS on the strip's own layout (see "A `flex-wrap` ROW'S MAX-CONTENT" below). Proofs:
> `npx tsx scripts/verify-blocking-lens-ui.ts` (**144 assertions**, up from 114 — five
> of the originals were RESTATED in the first pass and TWO MORE in the second, each for
> a stated reason and each listed below).
> Look rigs: `/dev/table-playground/blockinghead` (the strip, the blend table),
> `/dev/table-playground/pricelens` + `/agelens` (the bar and the popover).

#### ⚠️ THE LESSON — THE LENS NEVER RESOLVED ON THE REAL PAGE, AND WHY

The owner's screenshot: the Price lens, basis **Set a price = ₱41**, stuck for ever on
*"Sorting the yard into bands…"* with **no tint, no error, no Retry**. The database was
fine (`fn_blocking_price_lens(41)` answers in milliseconds), and the feature had only
ever been exercised in the no-session fixture, whose adapter resolves in a microtask.
**Three things had to be true together, and each of them is a rule worth keeping.**

1. **ONE INTERACTION MUST BE ONE NAVIGATION.** `openLens` applied the
   mutual-exclusivity rule by calling TWO writers in the same tick —
   `onSupplierFilterChange?.(null)` and then the lens writer. Both built a URL from the
   SAME stale `searchParams`, so one carried `lens=price` and the other did not; the two
   `router.replace` navigations settled independently and the `useOptimistic` mirror in
   `blocking-route-view.tsx` flipped `lensId` between `'price'` and `null` as they did.
   Every flip UNMOUNTED and remounted the lens body. **The rule now lives in the ROUTE**:
   `handleLensChange` drops `supplier` and `handleSupplierChange` drops `lens`, each in
   the same `URLSearchParams`, each in a single write.
2. **A DEBOUNCE HAS NO BUSINESS GATING THE FIRST LOOK.** Every request was created
   inside a 250 ms `setTimeout` whose cleanup runs on unmount, so a panel remounted
   within a quarter of a second **never issued one at all**. The first request now fires
   on the mount frame with no timer to lose; only SUBSEQUENT changes are debounced.
3. **A RACE GUARD MUST BE A SIGNATURE, NOT A COUNTER.** The old guard was a monotonic
   `tokenRef`, which discarded a reply whose token had merely moved — *even when that
   reply was for exactly the request still wanted*. That is what made the stall
   **unrecoverable**: recovery depended on yet another effect run. The guard is now the
   request's own signature, so **a reply for what is currently wanted is ALWAYS
   applied**, and a superseded reply is still dropped.

And a fourth, which is why nobody could diagnose it from the screenshot: **an eternal
spinner is not an error state.** Both lenses now arm a watchdog (`LENS_STALL_MS`, 8 s,
well past the measured 13.5 ms / 105.9 ms server cost) that replaces the spinner with
the shared PERSISTENT, COPYABLE banner and a Retry — the project's error HARD RULE,
satisfied inline. The watchdog is cleared the moment a reply lands, payload or refusal.

**Both lenses carry all four**, because they are the same file twice: the age lens had
the identical defect and it was fixed in the same change.

#### THE TYPED CUT LINE — `₱41 and up is above`, not `₱42`

The `manual` basis now sends `manualRoundedUpPhp(typed)` = `Math.ceil(typed)` as
`fetchBlockingPriceLens`'s third argument; every MEASURED basis sends nothing and
`R = floor(market) + 1` stays in SQL. The panel's own line says which rule produced R —
**`₱41 and up is above`** for a typed price, **`rounds up to ₱40`** for a measured one.
The `ceil` lives in `lens/price-lens-settings.ts`, the pure module, and the verify script
now allows exactly ONE `Math.ceil` in the whole `lens/` directory (`Math.floor` stays
banned everywhere — that is the market rule and it is SQL's).

#### THE CONTROL STRIP — four sections, and none of them moves

The owner: the controls *"just move around and overflow/wrap into weird locations"* when
a mode activates. They were one `flex-wrap justify-between` row, so anything that grew or
shrank by a pixel re-flowed every cluster after it. The strip is now
**`.blocking-controls-strip`** (globals.css): a CSS grid with four explicit tracks and
three 1px divider tracks, in the owner's order —

| # | Section (`data-blocking-strip-section`) | Track | Holds |
|---|---|---|---|
| 1 | `filters` | `minmax(232px, max-content)` | supplier search + ALL · WHSE A–D · PCA · PCB |
| 2 | `status` | `minmax(236px, max-content)` | Stored · In-Use · Sundrying · Sundried · Empty \| Wet · Ashy |
| 3 | `totals` | `minmax(180px, max-content)` | Total Balance · Occupied · Utilization · Total Value · Wtd Avg PHP/KG |
| 4 | `modes` | `minmax(200px, max-content)` | Prices · Highlight · Proposals · Blend Proposal |

**A grid item cannot leave its track**, so a section may wrap only INSIDE itself and can
never reorder or spill into a neighbour. Roomy → natural widths, nothing wraps. Tight →
tracks fall to the minimums and each section wraps within its own slot. Narrower than the
sum → the wrapper's `overflow-x-auto` engages and the strip SCROLLS (never crush, always
scroll). Below `sm` the four sections STACK in the same order and the dividers hide.

**WHY A MODE TOGGLE NO LONGER MOVES ANYTHING**, which is the actual complaint: every
ON/OFF pill and the Proposals count badge are `w-[26px] tabular-nums` (they were
`min-w-[16px]`, i.e. content-sized), and **the two price totals keep RESERVED slots** —
rendered `invisible` rather than removed — for anyone who MAY see prices, so the page's
Prices toggle cannot resize section 3 either. A reader who may never see prices has no
slot to reserve and simply gets a narrower section; there is no toggle for them to move
it with. **Measured in a real browser, section boxes `[x,y,w,h]` before and after
toggling all four modes, at 1512 / 1280 / 1024 px: byte-identical every time.**

#### ⚠️ SECOND PASS — A `flex-wrap` ROW'S MAX-CONTENT IS ITS ONE-LINE WIDTH

The four-track grid was right and it still starved three of its own sections. The
owner's next screenshot, the LIVE page at 1790px with prices on: `Total Balance ·
Occupied · Utilization · Total Value` on line one and **`Wtd Avg PHP/KG` alone on
line two**; `Prices · Highlight · Proposals` then **`Blend Proposal` alone**; and a
wide empty hole to the right of the supplier search. *"It's still a bit weird
looking."*

**MEASURED, in a browser, before touching anything.** A section's track is
`minmax(<min>, max-content)`, and **section 1 was a `flex-wrap` row holding the
search AND the seven warehouse chips — so its max-content was the width of all of
them on ONE line, 620px, although it has always RENDERED as search-over-chips in
444.** The four max-contents summed to **2,174px against 1,766px of real room**, so
the grid shrank every track toward its minimum by its share of the freedom: the
totals and the modes, which cannot wrap tidily, wrapped — and **214px of slack sat
stranded inside section 1**, which is the hole in the screenshot. The deficit and
the hole were the same 200-odd pixels seen from both ends.

**The lesson generalises past this strip: a section that always renders stacked must
be BUILT stacked, or it starves its neighbours.**

Three changes, and each one is a track:

| Section | Was | Is | max-content |
|---|---|---|---|
| 1 filters | one `flex-wrap` row | **`.blocking-strip-filters`** — a single-column grid: search, then chips | 620 → **384** |
| 3 totals | `flex-wrap`, `minmax(180px, …)` | `sm:flex-nowrap` on a **`max-content`** track — one line, always | 516 → 468, **1 row** |
| 4 modes | `flex-wrap`, `minmax(200px, …)` | **`.blocking-strip-modes`** — a grid of `max-content` columns, 4 across or **2 × 2**, never 3 + 1 | 543 → **295** (2 col) |

The one-row rule for the modes is a **container query on the strip's own scroller**
(`container-type: inline-size; container-name: blockingstrip`), because "is there
room" is a question about the strip and not about the viewport, and `data-mode-count`
tells it whether this reader has three buttons or four — CSS cannot count children.
Spare width now goes to `justify-content: space-between`, i.e. into the spaces
BETWEEN the sections; a `1fr` track anywhere here would put it back inside one.

**The totals were tidied in the same pass.** Each cell is `flex flex-col items-end`,
so the label and the value each shrink to their own content and the five figures
share one right edge; the gaps came down from 16px to 10px; and the two ₱ cells give
their VALUE its own stated width (92px / 52px). That last one is the thing the owner
singled out: `Peso` is a `justify-between` accounting layout, which is right inside a
box sized for the number and wrong when the box is as wide as the words **`Wtd Avg
PHP/KG`** above it — 84px of label over a 40px figure left the ₱ glyph hanging ~40px
off to the left of its own number.

**Measured after, same harness, at 2400 / 1950 / 1800 / 1512 / 1366 / 1280 / 1024 /
375 px, light and dark, price-visible and price-denied.** At the owner's width:
section 1's stranded slack **214px → 0**, the totals **2 rows → 1**, the modes
**2 rows → a 2 × 2**, status one row, no page scroll, and all four mode toggles still
move **nothing**. One row of four modes arrives at ~1910px of strip width (2400 and
1950 measured four across). Below ~1300px of viewport the strip's own scroller
engages instead of anything crushing — the stated cost of the totals never wrapping,
and the documented behaviour of this grid.

#### THE LEGEND BAR AND THE SETTINGS POPOVER — the grid got its width back

The owner: the right sidebar was *"completely static and not minimizable … taking up
precious space; we want to see the entire blocking as much as possible."* The docked
300px column is gone. In its place:

* a **LEGEND BAR** — the strip's second row, sticky with it, one line at every width:
  lens switch (only when this reader may be offered more than one) · the headline in a
  few words (`Market ₱39.86 → ₱40+ above` · `Yard 396.7 d avg`) · one CHIP per band,
  which ARE the isolate toggles (`aria-pressed`, same behaviour as the old rows) ·
  a thin inline ratio bar · the unpriced/undated chip when non-zero · a **Problem** chip
  when a read refused or stalled · kg\|blocks · **Settings** (gear) · Clear · close.
  Chips overflow by HORIZONTAL SCROLL, never by wrapping. While a read is in flight the
  bar shows a quiet `…` — **never an empty bar**.
* a **SETTINGS POPOVER** behind the gear, holding what the sidebar body held: the
  "Market is" basis + coverage line (or the age headline with its oldest-block button),
  the detailed band rows (count · kg · avg), Customize bands, and the refusal banner.
  It floats over the grid ONLY while open and is never the default state.

Everything else is unchanged and was kept deliberately: `?lens=price|age`, the mutual
exclusivity with the status and supplier spotlights, the Prices-off → Age fallback,
Production seeing Age only, Escape deferring to the detail drawer (and now to the
popover), and the classifier seam.

#### THE BLEND TABLE — SUPPLIER · OPENED · LAST PILED

`fetchBlendBlockFacts(batchIds, asOf?)` now feeds three columns after BATCH in the live
modal, the saved-version viewer, the print and the PDF:

* **SUPPLIER**, in the page's existing vocabulary — **GREEN** (the `.spotlight-supplier-all`
  emerald family) when `isSingleSupplier === true`, showing the name; **ORANGE** (the
  `.spotlight-supplier-some` family) when `false`, showing the DOMINANT supplier and its
  share (`Llanto 71%`) with the full split on the `title`; **`null` → a plain em dash,
  no colour at all.** `isSingleSupplier` IS the rule — `suppliers.length` is never used
  for colour, and the verify script asserts the string does not appear in either file.
* **OPENED** / **LAST PILED** — `daysSinceOpened` / `daysSinceLastPiled` as `38 d`, the
  date on the `title`. **NULL IS NEVER 0**: an unknown age is a dash, never "brand new".

**Keyed by `batch_id`, never by `block_loc`** (a block address is reused when a pile
empties): a saved version uses its snapshot's own ids, the live modal uses
`batchIdByLoc`, which the grid builds from the grid payload. **A SAVED version passes the
Asia/Manila date of its own version's `asOfAt` (= `coalesce(revised_at, created_at)`) as
`asOf`** and the table says so —
*"Supplier and age as of 2026-09-21"* — under the table, in the printout and in the PDF;
the live modal passes nothing, which means today. The read is once per open / version
switch and race-safe on its own signature; the table renders IMMEDIATELY with em dashes
in reserved-width columns (`w-[120px]` / `w-[54px]` / `w-[58px]`) so nothing jumps as the
figures land, and the min-width grew 640 → **872px** (the sum of the column minimums)
inside the existing `overflow-x-auto`. These columns carry **no ₱** and show for every
role including Production; the PHP/KG column keeps its existing gate everywhere.

**THE PRINT IS NOW A4 LANDSCAPE** — fifteen columns cannot fit portrait without dropping
the type below legibility. Padding is squeezed before the font and the floor is **7pt**
(the header row; the body is 8.5pt). The supplier pills keep their COLOUR on paper
(`print-color-adjust: exact` is already on `body` in the shared `PRINT_CSS`); printing
them grey would throw away the one thing the column is for. **Measured with headless
Chrome at the 24-block size: the table fits the page WIDTH comfortably and the whole
document runs to TWO pages** (summary + lab stats + pricing + 24 rows), the break falling
after the 23rd row. A price-denied print carries zero `PHP/KG` and keeps all three new
columns.

#### The five RESTATED assertions (none was weakened)

1. **`Math.floor`/`Math.ceil` banned in every lens file** → `Math.floor` still banned
   everywhere; exactly ONE `Math.ceil`, in `manualRoundedUpPhp`. A typed price is the cut
   line; the measured rule is still SQL's.
2. **"`openLens` calls the supplier writer"** → "`openLens` issues ONE navigation, and
   the ROUTE's lens writer drops `supplier` in the same params". Same behaviour, one
   write instead of two — the write that caused the stall.
3. **"choosing a supplier calls `closeLens()`"** → "choosing a supplier drops the lens
   TINT on the same frame" (and must NOT write a second URL). Same behaviour, same frame.
4. **"the tab STRIP renders only above one lens"** → the same gate on the bar's lens
   SWITCH, now a ternary because the single-lens case falls through to a plain label
   rather than to nothing.
5. **"a stale reply cannot overwrite a fresh one (the request TOKEN)"** → "a reply for
   the LATEST request is ALWAYS applied; a stale one is dropped", and the monotonic
   counter is now explicitly forbidden. This restatement IS the fix: the old property
   was true of a guard that also threw away replies it still wanted.

## State Management

| State | Type | Default | Purpose |
|---|---|---|---|
| `selectedLocKey` | `string \| null` | `null` | Currently selected cell for detail panel |
| `activeWarehouses` | `Set<string>` | `new Set(['A','B','C','D'])` | Warehouse filter — which warehouse sections are visible |
| `statusFilter` | `'ALL' \| 'STORED' \| 'IN-USE' \| 'SUNDRYING' \| 'SUNDRIED' \| 'EMPTY' \| 'WET' \| 'ASHY'` | `'ALL'` | Status/lab quality spotlight filter — dims non-matching cells |
| `blendMode` | `boolean` | `false` | Blend Proposal mode toggle (top-right of sticky header). When ON, cell clicks multi-select instead of opening the detail panel |
| `blendSelection` | `Set<string>` | `new Set()` | block_locs currently in the blend selection. Cleared when blend mode toggles off OR the proposal sheet closes |
| `proposalOpen` / `proposalLoading` / `proposal` | `boolean` / `boolean` / `BlendProposal \| null` | `false` / `false` / `null` | Blend Proposal sheet open state, in-flight flag, and the result from `buildBlendProposal()` |
| `supplierFilter` | `string \| null` | `null` | **Active supplier (canonical key).** NOT React state in the grid — it is a PROP driven from the URL param **`?supplier=<key>`** by `blocking-route-view.tsx`, exactly the way `?block=` is driven (optimistically mirrored with `useOptimistic` inside a `useTransition`, because this route is dynamic and a bare `router.replace` would leave the grid un-highlighted for a whole server round-trip). Deep-linkable and refresh-safe: `/inventory/blocking?supplier=ORNALES&block=A-1A` is a valid, shareable state |
| `proposals` / `proposalsLoading` / `proposalsOpen` | `BlendProposalSummary[]` / `boolean` / `boolean` | `[]` / `false` / `false` | Saved proposals (fetched ONCE **with archived rows included** — the "Show archived" switch and the header badge both filter client-side), the list dialog's in-flight flag, and whether it is open |
| `comparisonState` | `{ key; value: BlendComparison } \| null` | `null` | "Compare with today", **stored WITH the version it describes** (`<proposalId>:<versionNo>`) and read back only for that version. Derivation, not an effect that resets — there is no frame in which a stale comparison could paint against new numbers |
| `editing` | `BlendEditingContext \| null` | `null` | The Modify session: `proposalId`, `title`, `notes`, **`expectedVersionNo`** (the compare-and-set token captured when Modify started), `fromVersionNo` (what the pill shows) and the `BlendResolution` behind the "no longer hold the proposed batch" notice. Cleared when blend mode toggles off, on the pill's ×, and after a successful v(N+1) |
| `headerBusy` / `saving` / `listBusyId` | `boolean` / `boolean` / `string \| null` | `false` / `false` / `null` | In-flight flags for the header patch + archive, for a save, and for a per-row Restore |
| `proposalId` / `savedProposal` / `savedVersions` / `savedLoading` | props | `null` / `null` / `[]` / `false` | NOT grid state — driven from **`?proposal=<id>&v=<n>`** by `blocking-route-view.tsx`, which also RESOLVES them into a version (same division as `?block=` and the supplier map) |
| `lensId` | prop (`string \| null`) | `null` | **Which HIGHLIGHT LENS panel is open.** NOT grid state — driven from **`?lens=<id>`** by `blocking-route-view.tsx`, the same optimistic `useOptimistic`-inside-`useTransition` shape as `?block=` / `?supplier=` / `?proposal=`. Resolved through the registry (`resolveLens`), so an unknown id opens nothing. **CHANGED 2026-09-19 — an id this reader may not be offered now FALLS BACK to the first lens they can see, quietly** (a shared `?lens=price` link opened by Production lands on Age; flipping the page's Prices toggle off while Price is open switches to Age rather than closing the panel), and closes only when the registry offers this reader nothing at all. Written against the REGISTRY, never against the price flag, so a third lens with a different `canShow` gets it free. Band SELECTION is deliberately NOT a param — it is a moment of looking, not a statement worth sharing |
| `lensClassifier` | `{ fn: BlockingLensClassifier \| null }` | `{ fn: null }` | The open lens's published classifier — the ONE thing the grid knows about a lens. Wrapped in a one-key object because a bare `useState<fn>` would treat the classifier as a state UPDATER and call it with the previous value. Cleared by `closeLens()`, by the fallback effect above, AND by the panel's own unmount effect, so no tint can outlive the panel that drew it. Since 2026-09-19 a classification may also carry a `title` line, read per cell by `resolveLensCellTitle` and MERGED with the cell's existing supplier-mix `title` |
| `settingsOpen` (per lens) | `boolean` | `false` | **The Settings popover**, inside each lens panel — the gear's disclosure, holding everything that used to be the docked sidebar's body. Not the grid's and not the frame's: a lens owns its own settings, so a second lens gets the gear for free |
| `lensStalled` / `wantRef` / `firstDoneRef` (per lens) | `boolean` / `string` ref / `boolean` ref | `false` / `''` / `false` | **The 2026-09-21 stall fix.** `wantRef` is the SIGNATURE of the request the panel currently wants — a reply matching it is ALWAYS applied, a superseded one is dropped (it replaced a monotonic token that also discarded replies it still wanted). `firstDoneRef` makes the FIRST request fire on the mount frame with no timer for a remount to destroy. `lensStalled` is the watchdog (`LENS_STALL_MS`), which turns an eternal spinner into the shared copyable banner with a Retry |
| `facts` / `factsAsOfUsed` / `factsWantRef` | `Record<batchId, BlendBlockFacts>` / `string \| null` / `string` ref | `{}` / `null` / `''` | **The blend modal's supplier dominance + the two block ages.** Fetched once per open / per version switch and race-safe on the same signature discipline the lenses use. A refusal leaves em dashes — these columns are additive context and never fail the modal, the print or the PDF |
| `analysisOptions` | `BlendAnalysisOptions` | `{price:true, quality:true, age:true}` | **Which ANALYSIS PAGES the blend dialog shows and prints.** Not grid state — the dialog's own document, stored per user under `module = 'blocking_blend_analysis'` via `useModuleSettings`. Parsed as UNTRUSTED field by field; defaults omitted on save, so turning everything back on is a removal. ANDed with the effective price flag by `analysisPages()` |
| `analysis` / `analysisLoading` / `analysisRefusal` / `analysisStalled` | `BlendAnalysis \| null` / `boolean` / `string \| null` / `boolean` | `null` / `false` / `null` / `false` | **The analysis payload**, from `useBlendAnalysis` — one read per open / version switch / option change, fired on the MOUNT FRAME and guarded by the request's own SIGNATURE (no debounce: the inputs are discrete events). A refusal keeps the previous payload and is shown inline with Copy; a stall becomes the same banner with Retry after `LENS_STALL_MS` |
| `settings` (supplier lens) | `{ topN, unit }` | `{ topN: 6, unit: 'kg' }` | The SUPPLIER lens's own `user_table_settings` row, `module = 'blocking_lens_supplier'` — **no migration**, exactly as the other two. **There is no `bandNames`**: a supplier band already has a name, and renaming it would let the legend disagree with the yard about whose charcoal it is. `unit` is not a display choice but a choice of ATTRIBUTION — `kg` reads the APPORTIONED share, `blocks` the DOMINANT one |
| `printModel` (per lens) | `LensSummaryPrintModel \| null` | `null` | **The printed lens summary's model**, built inside each lens panel because only the lens knows what its settings mean. Null while the payload has not arrived, which disables the bar's Print button. Respects band isolation and carries preformatted strings only |
| `showPrices` | `boolean` | `true` | **Price-visibility display preference** (the "Prices" Eye/EyeOff toggle). Persisted to `localStorage` key **`blocking_show_prices`** (`'false'` = hidden; anything else = shown). Hydrated from storage in a post-mount `useEffect` (state starts `true` to avoid SSR/CSR hydration mismatch). HIDE-ONLY — the effective price flag is `serverCanViewPrices && showPrices`, so it can never reveal beyond the server gate |

## Key Behaviors

- **THE CONTROL STRIP — four fixed sections, and a mode toggle never moves one (2026-09-21)** — `.blocking-controls-strip` is a CSS grid with four explicit tracks (filters · status/lab · totals · modes) and three 1px divider tracks, in that order. A section may wrap only INSIDE its own track, can never reorder and can never spill; below `sm` the four sections stack in the same order. **Two tracks are ELASTIC** (`minmax(232px, max-content)` / `minmax(236px, max-content)`) and are where the give is; **two are RIGID** (`max-content`) because their content cannot shrink — the totals are one nowrap line and the modes a fixed-column grid. Spare width becomes even space BETWEEN the sections (`justify-content: space-between`), never slack inside one; narrower than the sum and the wrapper SCROLLS rather than crushing (measured: the strip's own scroller engages below ~1300px of viewport). Every ON/OFF pill and the Proposals badge is fixed-width (`w-[26px] tabular-nums`) and the two price totals keep RESERVED (`invisible`) slots for anyone who may see prices, so switching a mode changes a colour and never a width — measured before/after all four toggles at 2400/1950/1800/1512/1366/1280/1024/375px, light and dark, price-visible and price-denied: byte-identical section boxes every time
- **A `flex-wrap` ROW'S MAX-CONTENT IS ITS ONE-LINE WIDTH — a section that always renders stacked must be BUILT stacked, or it starves its neighbours (2026-09-21, second pass)** — the lesson from the owner's 1790px screenshot, in which the totals wrapped 4 + 1 and the modes 3 + 1 while a 214px hole sat beside the supplier search. Section 1 was ONE `flex-wrap` row holding the search AND the seven warehouse chips, so its max-content was **620px measured** although it always rendered as search-over-chips in 444; the four tracks therefore asked for 2,174px against 1,766px of real room and the grid shrank every one of them. **Section 1 is now an explicit two-row block** (`.blocking-strip-filters`, a single-column grid: search, then chips) and asks for **384px**; the totals row is `sm:flex-nowrap` on a `max-content` track so the fifth stat can never drop to a line of its own; and the modes are `.blocking-strip-modes`, a grid of `max-content` columns — **4 across or a clean 2 × 2, never a ragged 3 + 1** — switched by a CONTAINER query on the strip's own scroller (`container-name: blockingstrip`), with `data-mode-count` telling the CSS whether this reader has three buttons or four, since CSS cannot count children. Measured at the owner's width: filters slack **214px → 0**, totals **2 rows → 1**, modes **2 rows → 2 × 2**, and one row of four from ~1910px of strip width up
- **THE LENS LEGEND BAR replaced the docked sidebar (2026-09-21)** — the lens is now the strip's second sticky row: lens switch · headline · one CHIP per band (the isolate toggles) · a thin ratio bar · the unpriced/undated chip · a Problem chip on a refusal or stall · kg\|blocks · **Settings** (gear) · Clear · close, on ONE line that scrolls rather than wraps. The detail — market basis, the band rows with their counts and averages, Customize, the refusal banner — lives in the Settings POPOVER, which floats over the grid only while open. **The grid is full width again**
- **The blend modal's SUPPLIER · OPENED · LAST PILED columns (2026-09-21)** — after BATCH: a GREEN pill when `isSingleSupplier === true`, ORANGE with the dominant supplier + share when `false`, a plain em dash when `null`; then the two ages as `38 d`, dates on the `title`, NULL never 0. Keyed by `batch_id` (a block address is reused), and a SAVED version asks about the Asia/Manila date of its own version and says so. No ₱ — every role sees them. The print is A4 LANDSCAPE and keeps the pill colours
- **THE ANALYSIS PAGES in the blend dialog (2026-09-21)** — an **Analysis** button in the header opens **Include pages** (Price groups · Quality · Age, all three ON by default, remembered per user under `blocking_blend_analysis`); the chosen pages render as sections below the blocks table AND as separate sheets in the printout and the PDF, with the Print button showing `+N`. Groups read HIGH → LOW on every table, each with a SUBTOTAL row and one grand FOOTER taken from the payload's own `overall` — **nothing is summed, averaged or shared out in TypeScript**. The price page is dropped for any reader without the EFFECTIVE price flag, and the payload they receive has no `price` section at all. An unmeasured or undated block sits in a muted "no reading" group with an em dash, never in the cheapest, cleanest or freshest group
- **THE LENS SUMMARY PRINT (2026-09-21, REDESIGNED 2026-09-22)** — a **Print** button on the Highlight legend bar prints the active lens as configured. Page one: the title (**exactly `Price lens` / `Age lens` / `Supplier lens`, no blurb**), ONE terse settings line, the band table (its total labelled **`avg of priced`** / `avg of dated`) and the ratio bar. **Page two is the YARD MAP** — all 220 slots (238 with PCA/PCB), every occupied block in the SOLID band colour with its `block_loc` centred in the biggest font the cell allows, isolated-out and un-lensed blocks in neutral grey (the latter with a `—`), empty slots white, on ONE landscape sheet. Then **one page per band**, each carrying a full-width table **grouped by WAREHOUSE** with the seven lab readings (`MC · ASH · BD ASTM · BD JIS · GRIT · VM · FC`) read off the grid payload, a warehouse subtotal of blocks + kg whose **lab cells are deliberately BLANK** (never a TypeScript weighted average), and a band total from the payload. **Band isolation is respected and stated** ("Showing 2 of 4 bands"). Absent on Price for a reader without the effective price flag; present for every role on Age and Supplier
- **Warehouse filter chips** — ALL/WHSE A/B/C/D toggle buttons in global header. Individual chips toggle on/off. If all deselected, auto-reverts to ALL. Global stats recalculate for visible warehouses only
- **Weighted average stats** — Each warehouse header shows all 7 lab result weighted averages (weighted by balance): MC, ASH, BD ASTM, BD JIS, GRIT, VM, FC. Also shows weighted PHP/KG (gated via the EFFECTIVE `canViewPrices` = server gate AND the `showPrices` toggle)
- **Prices visibility toggle** — Eye/EyeOff "Prices" button in the top-right controls (default ON). Hide-only presenter/privacy switch — see **Role-Gating → Price-Visibility Toggle**. Hides ALL ₱ across Blocking (cells, detail panel, blend modal, and every print/PDF export) when OFF; the effective flag is always `serverCanViewPrices && showPrices`; persisted to `localStorage` `blocking_show_prices`; the control is hidden entirely for server-gated no-price users
- **Clickable status badges** — Stored (blue), In-Use (amber), Sundrying (orange), Sundried (violet), Empty (muted) buttons in global header and warehouse headers. Click toggles spotlight filter, click again deselects to ALL
- **Lab quality filters** — Wet (blue, MC exceeds limit) and Ashy (amber, ASH exceeds limit) buttons in global header after status badges, separated by a divider. Use lab highlight settings from `useTableSettings()` to determine which cells match. When filter is active on empty cells, they are always dimmed
- **Supplier search + supplier spotlight** — Type a supplier, hit Enter, and every block that supplier filled lights up: **GREEN (`.spotlight-supplier-all`) when the block is ENTIRELY theirs, ORANGE (`.spotlight-supplier-some`) when they share it**, everything else — occupied or empty — takes the existing `.spotlight-dimmed`. **The ALL/SOME test is `byBlock[loc].supplierCount === 1`, i.e. the view's own `supplier_count_in_block`; never `shares.length`.** Data comes from `fetchBlockingSupplierMap()` (see Data); the grid does no aggregation, only a count of map entries for the chip's "all N · some M". Every occupied cell also carries a native `title` with its supplier mix (`ORNALES 62% · PAQUIBOT 38%`) whether or not a search is active — cheap, and it answers "who is in this block" on hover.
- **Highlight lens (the docked panel)** — a **Highlight** button in the sticky header opens a DOCKED panel (a 300px sticky column beside the grid at `lg`+, a bottom sheet below it), never a modal. **THREE lenses are registered: Price, Age and Supplier** (2026-09-22), and the frame renders a tab strip only once this reader may be offered more than one of them. With nothing picked every classified occupied block wears its band's tint+ring (the "ratio'd" view — a distribution, so nothing is dimmed); picking bands isolates them and everything else takes the shared `.spotlight-dimmed`. Clear / close / Escape removes all lens styling. **A block the lens cannot place is left exactly as it looks with no lens open** — unpriced for Price, undated for Age, no-delivery-at-all for Supplier — never painted as the cheapest, the freshest, or as `Others`
- **The AGE lens (2026-09-19)** — tint every occupied block by **how old its charcoal is**: the batch's kg-weighted MEAN DELIVERY DATE carried by its remaining balance, cut by default at **60 / 120 / 365 days → four bands** and configurable up to 6 cut lines (1…5,000 days) with one-click chips for `30 · 60 · 90 · 120 · 180 · 365 · 730`. The panel leads with the yard's own weighted age (`396.7 days`) and a quiet `as of <date> · oldest <N> days at <BLOCK>` line **whose block is a button that opens that cell**, through the grid's own `handleCellClick`. Each band row also carries **its own** published weighted age, so "the 120–365 band averages 224 days" is a lookup rather than a calculation. While the lens is active a cell's native hover title gains `"<N> days old (average of what's in the block)"` from `ageByBlock` — an EXTRA line on the title the cell already had, not a new hover mechanism on 220 cells
- **AGE IS VISIBLE TO EVERY ROLE, INCLUDING PRODUCTION, and that is the point** — `AGE_LENS.canShow` is `() => true` because nothing in `fetchBlockingAgeLens`'s payload is money and none of it is derivable into money (asserted, not promised: the data-layer verify scans every key of the live payload for a money-ish name). Production is the role that actually walks the yard. **So the Highlight BUTTON now renders for every role** — it used to be price-gated in effect, because Price was the only lens and its `canShow` IS the price flag — and only the Price **tab** is absent for a reader who cannot see prices. Do not "tidy up" the asymmetry between the two lenses' gates
- **Switching tabs, and the two FALLBACKS** — the panel body is keyed by lens id, so switching UNMOUNTS one lens and MOUNTS the next: the grid tint swaps immediately, band selection resets, and each lens keeps its own persisted settings (`module = 'blocking_lens_price'` / `'blocking_lens_age'`, one `user_table_settings` row each — `saveUserModuleSettings` REPLACES a row, so a shared key would make each save erase the other). `?lens=age` deep-links. **A lens this reader may not be offered falls back to the first one they can see, QUIETLY**: `?lens=price` opened by Production lands on Age with no toast, and flipping the page's **Prices toggle OFF while Price is open switches to Age** rather than closing the panel — the reader asked to look at the grid through something, and one of the two is still theirs. The previous tint is dropped on the same interaction either way, and the panel closes only when the registry offers this reader nothing at all
- **The SUPPLIER lens (2026-09-22)** — tint every occupied block by **whose charcoal is in it**, banded by the top **N** suppliers of the current yard (1…12, default 6) plus one `others` fold. **⚠️ TWO KILOGRAM ATTRIBUTIONS, and the UI must not mix them**: the grid TINT and every block COUNT are DOMINANCE (`bandIndex` / `dominantBlockCount` / `dominantKg` — the blocks where a supplier is biggest, and their whole balance), while the RATIO BAR and the kg share are APPORTIONED (`apportionedKg` via `kgSharePct` — each supplier's own slice of every block it appears in). They are different questions, not two scalings: measured 2026-09-22, **8 of the yard's 17 suppliers dominate NO block at all**, so a dominance-only lens would say MERCADO holds 0 kg (false) and an apportioned-only one could not colour a cell. The `kg | blocks` switch therefore switches BETWEEN the two, and the Settings popover says so in one line. A **MIXED** block (`isMixed`, the view's own carried `supplier_count_in_block > 1` — never `suppliers.length`) wears a **dashed inset outline** in its band hue, with the full split on its native title; it is deliberately a different shape, colour and position from the blend-selection ring + checkmark. **Colour is NOMINAL, not a gradient**: twelve `.lens-cat-*` hues taken by RANK, plus a reserved zinc NEUTRAL that only `others` wears, and neither of the supplier SEARCH's two hues (emerald = the whole block, orange = only some of it). A block whose batch has **no delivery at all** has no supplier: it is un-lensed and reported on its own muted row, **never folded into `others`**
- **SUPPLIER IS VISIBLE TO EVERY ROLE, INCLUDING PRODUCTION** — `SUPPLIER_LENS.canShow` is `() => true` for the same reason Age's is: `cost_basis` is never read, `avg_php_kg` is never selected, and a supplier's name beside a kilogram total says nothing about what it cost (asserted, not promised — the data-layer verify scans every key of the live payload for a money-ish name and greps the SQL). A price-viewer sees a three-tab strip, Production a two-tab one
- **The three lenses share everything EXCEPT their ramp and their gate** — the band legend, the stacked ratio bar, the kg\|blocks switch, the "in no band" row, the inline refusal banner and the Customize disclosure are one implementation each in `lens/lens-*.tsx`. What is deliberately NOT shared is the **colour ramp** (`.lens-band-*` emerald→rose for cost, `.lens-age-*` sky→fuchsia for age — a red old block would be read as an expensive one) and the **price gate** (there is no money in the age payload). A lens declares its scale as `ramp` on its registration, and every shared piece derives its swatch class from that id, so no panel and no component spells a `.lens-*` class itself
- **The THREE markings are MUTUALLY EXCLUSIVE** — opening a lens resets `statusFilter` to `ALL` and clears the supplier; clicking any status/lab chip or choosing a supplier CLOSES the lens; picking a supplier resets `statusFilter` to `ALL`; clicking any status/lab chip (global header or warehouse header) clears the supplier. Only one spotlight vocabulary is ever on screen, so a green ring can never be mistaken for a status color. **Blend Proposal is unaffected**: a blend-selected cell keeps its checkmark badge over the supplier ring (verified). Note the supplier ring is unlayered CSS and therefore beats Tailwind's layered `ring-2` on the same cell — the checkmark is what marks the selection there, exactly as the pre-existing status spotlight already behaved.
- **Search bar placement** — **Desktop (sm+): the leftmost cluster INSIDE the sticky header's chip row** (it is a text entry, so it reads as the start of the filter row). **Phone (below sm): its own full-width row ABOVE the sticky header** — it cannot live inside the header there, because the mobile header is a `flex-nowrap overflow-x-auto` strip and `overflow-x: auto` computes overflow-y to auto too, which would clip the suggestion panel inside a scrolling box. The component is therefore rendered TWICE (one `max-sm:hidden`, one `sm:hidden`), which is deliberate: filter state lives in the URL, so the two instances cannot disagree — but a DOM query for the input matches two nodes, so tests must qualify with `:visible`.
- **Spotlight effect** — When status/lab filter active: non-matching cells get `opacity: 0.3; pointer-events: none` (`.spotlight-dimmed`), matching cells get colored glow ring (`.spotlight-stored`, `.spotlight-in-use`, `.spotlight-empty`, `.spotlight-wet`, `.spotlight-ashy`). All transitions 150ms
- **Sticky global header** — `sticky top-0 z-30` with glass effect `bg-card/95 backdrop-blur-sm`. Has a **condensed variant on short viewports** — see the phone-landscape bullet below
- **Neutral card backgrounds** — all occupied cells use `.blocking-cell-occupied` (zinc gradient) instead of colored heatmap fills. Balance percentage is communicated via font color on the weight value
- **Cell click** — toggles detail panel open/closed. Clicking same cell again closes. Clicking different cell switches content
- **Selected state** — outline ring on selected cell via `.blocking-cell.selected` CSS class
- **Critical pulse** — balance text in critical cells (< 10%) pulses with 2s animation via `.balance-critical` class
- **Cell hover** — `scale(1.08)` transform with shadow (CSS-only, no JS)
- **Detail panel** — slides from right (**full-width on phones, `sm:w-[520px]`**, `h-dvh`) with cubic-bezier easing, body scroll locked while open. **Delivery-card style metrics** — Row 1: 3-col grid with Balance cell (value + percentage + thin 1px progress bar + 0/total range), PHP/KG cell, Est. Value cell (role-gated; grid collapses to 1-col when prices hidden). Row 2: 7 flex lab result cells matching DeliveryHistoryDialog pattern (`text-[8px]` labels, `text-xs font-mono font-bold` values, centered in bordered rounded cells). **Inline notes** — single-line display (StickyNote icon + "Notes:" + truncated text + pencil edit icon, ~24px height), expands to compact textarea with Save/Cancel on edit. **Scrollable content area** (`flex-1 min-h-0 overflow-y-auto`) contains delivery history and usage history. **Each history `<table>` sits in its own `rounded-md overflow-x-auto` box** so a wide (price-role, 9-col) row scrolls horizontally instead of clipping against the panel root's `overflow-hidden` (shared benefit — RC Movement renders this same panel). Delivery table: tighter cells (`px-1.5 py-1`, `text-[10px]` body, `text-[9px]` headers) with Date, Supplier, Sacks, Weight, PHP/KG (role-gated), MC, BD, ASH + action column with Info + Edit icons on hover + total footer row. **"Edit All" button** in header. Usage table below with same tight sizing. No sticky footer (Est. Value moved to metrics grid). Designed to fit iPad Mini 6 portrait (~1080px) without scrolling to see delivery history.
- **"Edit All" deep-link contract (`editBatch` + `editView`)** — "Edit All Deliveries"/"Edit All Usage" navigate to `/inventory?tab=<view>&search=<code>&year=all&editBatch=<code>&editView=<view>` (view = `deliveries` \| `usage`). On `/inventory` BOTH the Deliveries (RC IN) and Usage (RC OUT) tables are always mounted and BOTH read `?editBatch=` — `editView` is the discriminator that tells the right one to act. The Deliveries table consumes the param only when `editView === 'deliveries'` (a **missing** `editView` defaults to `'deliveries'` for backward-compat with older deep links); the Usage table only when `editView === 'usage'`. The matching consumer strips **both** `editBatch` **and** `editView` via `replaceState`; the non-matching table leaves them untouched. The route hosts (`blocking-route-view`, `rc-movement-route-view`) own the `router.push` — the panel does NOT push when `onNavigateToBatch` is provided (see panel contract above).
- **Print** — Printer-icon button in the panel header (action group next to Close) triggers `handlePrint()`. Instead of toggling/printing the live DOM, it **generates a standalone HTML document** (`buildPrintDocument()` — its own `<html><head><style>…</style></head>` with minimal black-on-white print CSS) from the data the panel already has, writes it into a **hidden same-origin iframe** (`printViaIframe()`), and calls `iframe.contentWindow.print()`. Because the printed document is a fresh, isolated document, it is completely immune to the app's dark mode, Tailwind, portals/overlays, transforms, and the slide-over's `fixed` positioning — which is what made the old `@media print` approach print like a screenshot. The document contains ONLY the open block's details: title, WHSE/Col/Row + status subtitle, Summary + Quality definition rows, optional Notes, and bordered Delivery + Usage tables with right-aligned numerics and total rows. User-provided strings are HTML-escaped (`escapeHtml()`). Price fields (PHP/KG, Est. Value, delivery PHP/KG, usage Avg Price) are gated by the same `canViewPrices && blockData.php !== null` flag the panel uses (passed into the builder) — a Production user prints no ₱ data. The iframe self-removes on `afterprint` (60s fallback); an iframe-creation failure surfaces a persistent, copyable `errorToast()`. No popup window is opened, so popup-blockers are a non-issue
- **Escape key** — closes detail panel
- **Blend Proposal mode** — A **"Blend Proposal" toggle** (Layers icon + ON/OFF pill) sits in the **top-right of the sticky global header**, OFF by default. **When ON:** clicking an occupied block toggles it into a multi-select set (`blendSelection`) instead of opening the detail panel; empty slots are NOT selectable (the click is a no-op). Selected occupied cells get a `ring-2 ring-primary` ring + a small primary checkmark badge (top-right of the cell); the normal panel-selection ring is suppressed while in blend mode. **Floating action bar** (`animate-fade-up`, bottom-center, floating-bar glass `bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60`) appears while blend mode is ON with ≥1 block selected — shows the selected count, a **Build Proposal** button, and a **Clear** button. **Build Proposal** calls `buildBlendProposal(blockLocs)` and opens the **`BlendProposalDialog`** (`../_shared/blend-proposal-dialog.tsx`) — a **wide centered modal** (Dialog `max-w-4xl`/`max-h-[85vh]`, NOT a side sheet) — with the result. The modal's **Selected Blocks table shows all 7 per-block lab results** (MC/ASH/BD ASTM/BD JIS/GRIT/VM/FC) alongside balance + role-gated PHP/KG, in the Excel-dense style (horizontal scroll if it overflows). On action throw, surfaces `errorToast()` (persistent + Copy) and closes the modal. The modal header has a **Download PDF button** (Download icon → label Popover → saves a **vector/text** PDF named `YYMMDD - {label}.pdf`, e.g. `260619 - 4x8 RUN.pdf`; jsPDF + jspdf-autotable, gating identical to print) and a **Print button** (Printer icon → clean self-contained native document via the shared hidden-iframe plumbing `./print-utils`) — both outputs include the per-block lab columns. **In-modal deselect:** each block row has an X that removes it from the blend — the **grid owns the source-of-truth `blendSelection`** (`handleRemoveBlendBlock`): it drops the block from the Set (so the grid cell rings stay in sync) and re-runs `buildBlendProposal` for the reduced set, live-updating the modal's weighted stats / total / count / prices (table dims + header spinner during the re-fetch; failures → `errorToast()`). Removing the last block closes the modal and clears the selection. **Toggling blend mode OFF clears the selection; closing the proposal modal (Escape / overlay / close) clears the selection.** The normal click-to-open-detail flow, spotlight status filter, and heatmap are untouched when blend mode is OFF. **Price gating** is end-to-end via the returned `proposal.can_view_prices` flag + null checks — no client role lookup — and applies identically to the on-screen modal AND the printed document; the per-block LAB columns are never gated
- **Responsive** — `overflow-x-auto` on grid wrapper for smaller screens
- **Mobile (below `sm`, additive — desktop `sm`+ untouched)** — (1) each warehouse section switches to FIXED 44px cell tracks via `.blocking-grid-cols` so the grid finally scrolls horizontally (instead of crushing 20 cols to ~13px) with thumb-tappable cells; (2) the row-label column + top-left corner pin left via `.blocking-rowlabel-frozen` (opaque `bg-card`, frozen-edge border) so the row letter stays visible while cells scroll; (3) the sticky global summary header collapses from a wrapping `justify-between` cluster row into a single `max-sm:flex-nowrap max-sm:overflow-x-auto` horizontal-scroll strip (clusters get `max-sm:shrink-0`; the orphan-prone top-level `h-5 w-px` dividers are `max-sm:hidden`). Blend Proposal stays desktop-only
- **Phone landscape / short viewport — condensed sticky header (`[@media(max-height:500px)]`, additive; tall viewports byte-for-byte unchanged)** — The trigger is viewport **HEIGHT, not width**: a phone in landscape is ~390-430px TALL but ~750-930px WIDE, so the `max-sm` width rules never fire there while the sticky header still ate ~25% of the screen before a single grid row appeared. `max-height:500px` catches every phone landscape (iPhone SE 320 → 15 Pro Max 430) and deliberately **misses iPad mini landscape (744px tall), which keeps the FULL header**. Approximate header height at 390px-tall: **~83px → ~48px**.
  - **The clusters still WRAP — never horizontal-scroll** (unlike the `max-sm` strip). Keeping the stat figures on screen while the grid scrolls is the entire point of the sticky header; a scroll strip would hide them.
  - **What condenses:** container padding (`px-4 py-2.5` → `px-2 py-1`) + row gap; `justify-between` → `justify-start` so wrapped rows pack left; the orphan-prone top-level dividers hide; the in-cluster dividers shorten (`h-5`/`h-8` → `h-3`); the **stat figures** (`GlobalStat`) collapse from a stacked label-over-value block (~32px) to ONE inline baseline-aligned line (~12px) with abbreviated uppercase labels — **Total Balance→BAL, Occupied→OCC, Utilization→UTIL, Total Value→VAL, Wtd Avg PHP/KG→₱/KG** — at `text-[9px]` label / `text-[10px]` value. This stat collapse is where most of the vertical saving comes from. The two toggles shorten their word labels only (Prices→icon+ON/OFF pill, "Blend Proposal"→"Blend") to buy wrap-width.
  - **What does NOT condense:** the interactive warehouse chips and status/lab pills keep their exact hit areas — tap targets never degrade. Only spacing and the non-interactive stat text shrink.
  - **Implementation:** the variants live in the **`SHORT` const map** at the top of `blocking-grid.tsx` and in three small components at the bottom — **`GlobalStat`** (label+value, tall-stacked / short-inline via a `tallOnly`/`shortOnly` span swap), **`StatDivider`**, and **`Peso`** (accounting ₱-left/number-right; the `flex justify-between` moved from the value div onto an inner block-level flex span — same intrinsic sizing, so desktop is visually identical). The SHORT strings **must stay literal** — Tailwind scans raw source text for class candidates, so a runtime-concatenated variant would never be generated (verified: all 20 variants compile into the `@media (max-height:500px)` block).
- **Cell content** — loc key (status-colored badge: blue=STORED, amber=IN-USE, orange=SUNDRYING, violet=SUNDRIED), 2-line batch name, balance (color-coded by percentage: emerald >= 50%, white 20-50%, amber 10-20%, red < 10%), then bottom metrics in order ₱ → ASH → BD → MC: PHP/KG (price-gated), ASH% (lab-highlight colored), BD (`bd_astm`, 3-decimal, lab-highlight colored, ungated), MC% (lab-highlight colored)
- **Cell text defaults** — `text-white` for batch name, loc key, and PHP/KG. MC, ASH, and BD (`bd_astm`) use lab highlight text color when value exceeds limit, fallback to `text-white/95`. All rendered on neutral zinc gradient backgrounds
- **Legend labels** — balance text color samples: "> 50%" (emerald), "10-20%" (amber), "< 10%" (red)
- **Balance formatting** — uses `formatKg()` everywhere (>= 1000 -> Xk, else Xkg)
- **Utilization colors** — reversed: >75% = red (almost full, warning), >50% = amber, <=50% = green (plenty of room)
- **Detail panel balance bar** — progress bar max uses `total_in` (actual total delivered), not hardcoded 100,000

### Role-Gating

- **Production role:** PHP/KG hidden in grid cells, detail panel metric card, delivery table cost column, and footer estimated value. These fields render as `--` or are omitted entirely. **The server (`fetchBlockingGridData`) nulls `php`/`avg_php_kg` AND returns `canViewPrices: false` BEFORE the payload reaches the client** — the network response carries no ₱ for Production. This server gate is canonical and is NEVER weakened by the client toggle below.
- **All other roles:** Full visibility of all cost and pricing data.

### Price-Visibility Toggle (presenter / privacy — hide-only)

- **What it is:** an **Eye/EyeOff "Prices" toggle** in the Blocking top-right controls (next to the Blend Proposal toggle, same styling), default **ON** (prices shown). It is a **CLIENT-SIDE DISPLAY PREFERENCE that can ONLY HIDE prices, never reveal them.** It layers ON TOP of the server gate.
- **Effective flag everywhere = `serverCanViewPrices && showPrices`.** `BlockingGrid` computes this once and passes it down as `canViewPrices`; the blend modal receives `showPrices` separately and ANDs it with `proposal.can_view_prices`. No place uses the raw `showPrices` alone to decide visibility, and the toggle is never used to widen the server flag (it's ANDed second).
- **Hidden for no-price users.** The toggle control renders ONLY when the server says the user can view prices (`serverCanViewPrices` / `proposal.can_view_prices` true). A Production user (server-gated, ₱ already nulled) never sees the toggle — it would be a no-op for them.
- **What turning it OFF hides — everywhere in Blocking:** (1) grid cell PHP/KG line; (2) detail panel PHP/KG, Est. Value, delivery PHP/KG column, usage Avg Price column, **and those fields in its print document** (the panel receives the effective `canViewPrices`); (3) blend modal per-block PHP/KG column, raw blended price, product cost, and the whole pricing/formula section; (4) **all exports** — the detail-panel print doc, the blend print doc (`buildBlendPrintDocument(proposal, showPricesPref)`), and the blend PDF (`buildBlendPdf`/`downloadBlendPdf(proposal, label, showPricesPref)`) exclude every ₱ field. Lab columns/stats are NEVER hidden by the toggle.
- **Persistence:** `localStorage` key **`blocking_show_prices`** (`'false'` = hidden). Survives reloads; hydrated post-mount to avoid hydration mismatch; corrupt/missing value fails open to "shown" (still safe — the server gate bounds it).

## CSS (globals.css)

The blocking system is defined at the bottom of `app/globals.css`:
- `.blocking-cell-occupied` — neutral zinc gradient background for all occupied cells with light/dark variants
- `.blocking-grid-cols` — **breakpoint-gated grid template** for each warehouse section. Below `sm` (<640px) the tracks are FIXED (`20px repeat(var(--blocking-cols), 44px)`) so the section overflows its `p-2 overflow-x-auto` wrapper and finally scrolls horizontally with ≥44px thumb-tappable cells; at `sm`+ it reverts to `20px repeat(var(--blocking-cols), minmax(0,1fr))` (the original fit-to-width layout — desktop byte-for-byte unchanged). The column count is passed via the inline CSS custom property `--blocking-cols` (20 standard, 3 PCA/PCB)
- `.blocking-rowlabel-frozen` — **mobile-only (`max-width:639px`) frozen row-label column.** Pins the 20px row-label column + the top-left corner cell `sticky left-0 z-10` with a SOLID `var(--card)` background (OPAQUE per the frozen-pane rule — never glass) and a `.frozen-edge`-style right border/shadow, so the row letter stays visible while the cells scroll horizontally. The rule lives entirely inside the max-width query, so desktop (where the 1fr grid fits its box and never scrolls) is untouched
- `.heat-critical`, `.heat-depleting`, `.heat-healthy`, `.heat-full` — legacy gradient backgrounds (kept for backward compat, no longer used by grid cells)
- `.blocking-cell` — base cell styles (border-radius, transition, cursor)
- `.blocking-cell:hover` — scale transform
- `.blocking-cell.selected` — outline ring with dark mode variant
- `blocking-critical-pulse` keyframe — pulsing animation for critical balance text
- `.balance-critical` — standalone pulse class for balance text when < 10%
- `.spotlight-dimmed` — `opacity: 0.3; pointer-events: none` with 150ms transition
- `.spotlight-stored` — blue glow ring (`box-shadow`) with `.dark` variant for stronger glow
- `.spotlight-in-use` — amber glow ring (`box-shadow`) with `.dark` variant
- `.spotlight-sundrying` — orange glow ring (`box-shadow`) with `.dark` variant
- `.spotlight-sundried` — violet glow ring (`box-shadow`) with `.dark` variant
- `.spotlight-empty` — muted glow ring (`box-shadow`) with `.dark` variant
- `.spotlight-wet` — blue glow ring for WET lab quality filter with `.dark` variant
- `.spotlight-ashy` — amber glow ring for ASHY lab quality filter with `.dark` variant
- `.spotlight-supplier-all` — **emerald** glow ring: the block is ENTIRELY the searched supplier (`supplierCount === 1`), `.dark` variant stronger
- `.spotlight-supplier-some` — **orange** glow ring: the block holds the searched supplier alongside others, `.dark` variant stronger
  > Both sit AFTER `.blocking-cell-occupied` in `globals.css`, which is load-bearing: same specificity, so source order decides, and an occupied cell's own `box-shadow` would otherwise win. (That is exactly why the pre-existing `.spotlight-stored`/`-in-use`/… — declared BEFORE it — show their glow only on EMPTY cells.) Both are plain `box-shadow`, no animation: cells are never animated.
- **`.blocking-controls-strip`** — the four-section CONTROL STRIP (2026-09-21). A CSS grid whose tracks are `minmax(232px, max-content) 1px minmax(236px, max-content) 1px max-content 1px max-content`, so each section owns a slot it cannot leave and wraps only inside itself. The first two are **ELASTIC** and fall back to a stated MINIMUM when the viewport is tight (S1 232px — the supplier search's own width, chips wrapping under it; S2 236px — two rows of status/lab pills); the last two are **RIGID `max-content`** and have no stated minimum on purpose, since a nowrap line and a fixed-column grid cannot shrink and a number for them would never apply. `justify-content: space-between` gives the spare width to the spaces BETWEEN sections — a `1fr` track anywhere here would strand it inside one, which is the bug the second pass fixed — and the wrapper's `overflow-x-auto` scrolls rather than crushing below the sum (measured: below ~1300px of viewport). A `@media (max-width: 639px)` block collapses it to `minmax(0, 1fr)` (the four sections stack in the same order) and hides `.blocking-strip-divider`. The two minimums, the two rigid tracks, the absence of a `fr` and the `space-between` are all asserted in `scripts/verify-blocking-lens-ui.ts` so a later edit cannot quietly let a section crush or hoard
- **`.blocking-strip-scroller`** — the strip's `overflow-x-auto` wrapper, and also the QUERY CONTAINER (`container-type: inline-size; container-name: blockingstrip`). "Does the strip have room for one row of mode buttons?" is a question about the strip's own width, so it is asked of the strip and not of the viewport — the page's padding, and any future sibling, cannot put the answer out by a few pixels
- **`.blocking-strip-filters`** — section 1 as an explicit TWO-ROW block: a single-column grid holding the supplier search then the warehouse chips. **This is the second pass's whole fix**: as one `flex-wrap` row its max-content was the width of everything on ONE line (620px measured) although it always rendered stacked in 444, so it asked for 176px it never used and every neighbour shrank. Built stacked it asks for 384px — the wider of its two rows. The chip row itself stays `flex-wrap`, because this track legitimately falls to 318px at 1512 and to its 232px floor below that, and a nowrap chip row would then spill out of its own track
- **`.blocking-strip-modes`** — section 4 as a grid of `max-content` columns, `justify-items: start` so each button keeps its own width. **TWO columns by default** — a clean 2 × 2 for a price-viewer's four buttons, 2 + 1 for a price-denied reader's three — and ONE ROW above a measured `@container blockingstrip (min-width: …)` threshold, 1540px for three buttons and 1910px for four. `data-mode-count` on the section is what lets three straighten out sooner than four, since CSS cannot count children. A wrapping flex row is what packed them 3 + 1, which is what the owner photographed
- **`.lens-band-0` … `.lens-band-6`** — the PRICE LENS's colour ramp, cheapest (emerald) → dearest (rose) through lime/yellow/amber/orange/red. Each stop declares only a `--lens-hue` triple; ONE shared rule then paints the marking, so the ramp is data and the look lives in one place. A band's stop is chosen by POSITION (`lens/price-lens-settings.ts::bandRampStop`), so a three-band lens uses stops **0 · 3 · 6** and never the ramp's first three.
  - **It TINTS rather than replaces**: the hue rides at 22% (light) / 30% (dark) alpha over the cell's existing zinc gradient, so the text contrast the cell already has — including a lab-highlight red on MC/ASH — stays essentially at its baseline. The solid inset ring carries the identification.
  - It is a **tint + ring**, a different KIND of marking from every `.spotlight-*` above (a pure glow ring), so even side by side a band could not be read as a status glow. Both themes; plain `background-image`/`box-shadow`; **no animation** (these land on up to 238 cells at once), only the same `opacity`/`box-shadow` transition every spotlight uses.
  - **`.lens-band-picked`** — a band the reader isolated: same hue, louder ring. **`.lens-band-swatch`** — a solid fill for the legend chips and the ratio-bar segments, which cannot carry a 22% wash.
  > **All nine rules sit AFTER `.blocking-cell-occupied`**, for exactly the reason the supplier spotlights do, and `.lens-band-picked` / `.lens-band-swatch` sit after the seven stops because they override them. `scripts/verify-blocking-lens-ui.ts` asserts the whole ordering — moved above, the tints silently lose to the cell's own background and the lens paints nothing, with no runtime symptom at all.
- **`.lens-age-0` … `.lens-age-6`** — the AGE LENS's colour ramp (2026-09-19), freshest (sky) → oldest (deep fuchsia) through blue/indigo/violet/purple/fuchsia. **It shares no hue with the cost ramp, on purpose**: green→amber→red already means cheap→dear on this page, so tinting a 900-day-old block red would be read as "expensive" — a fact about a different column. The 4-band default takes stops `0 · 2 · 4 · 6`.
  - **The age classes JOIN the cost ramp's grouped tint rule rather than declaring their own**, so they inherit the measured 22% (light) / 30% (dark) alpha and the inset-ring technique verbatim — which is what keeps a lab-highlight red on MC/ASH at the contrast it was measured at. A second copy of those rules is how one ramp quietly ends up darker than the other.
  - `.lens-band-picked` and `.lens-band-swatch` are **hue-agnostic** (they read `--lens-hue`), so both ramps get the isolated-band ring and the legend swatch for free — there is no `.lens-age-picked`.
  > The seven age stops sit AFTER `.blocking-cell-occupied` for the same load-bearing reason, and `scripts/verify-blocking-lens-ui.ts` additionally asserts that **no age hue is a cost hue** and that every age class is inside the shared tint rule.

- **`.lens-cat-0` … `.lens-cat-12`** — the SUPPLIER LENS's **NOMINAL** palette (2026-09-22), and the first ramp on this page that is not a gradient. sky · violet · rose · amber · teal · fuchsia · lime · indigo · cyan · pink · yellow · blue, then **`.lens-cat-12` zinc, a reserved NEUTRAL that ONLY the `others` fold wears**.
  - **IT IS IDENTITY-MAPPED, NOT POSITIONAL.** Suppliers are categories — ORNALES is not "more" than PAQUIBOT — so a band takes the stop matching its own RANK (`lens/lens-ramp.ts::categoryStop`). A positional mapping would MOVE a supplier's colour the moment the reader changed how many are named, and a gradient would invite an ordering that does not exist.
  - **TWO HUES ARE DELIBERATELY ABSENT: emerald `16 185 129` and orange `249 115 22`** — those are `.spotlight-supplier-all` / `.spotlight-supplier-some` above, which already mean "the whole block is this supplier" and "only some of it is". Reusing either for band IDENTITY would collide with a meaning this page has. `scripts/verify-blocking-lens-ui.ts` asserts both triples stay out, that all thirteen slots are distinct, and that the list matches `LENS_RAMP_RGB.category` exactly.
  - **They JOIN the shared tint rule** (they are added to both the light and the `:is(.dark)` selector lists) rather than declaring their own, so they inherit the measured 22% / 30% alpha and the inset-ring technique verbatim — the same discipline the age ramp follows, and for the same reason.
  - All thirteen sit AFTER `.blocking-cell-occupied`, the same load-bearing ordering the other two ramps and both supplier spotlights carry.
- **`.lens-cat-mixed`** — the SUPPLIER lens's MIXED marker: `outline: 1.5px dashed rgb(var(--lens-hue) / 0.95)` at `outline-offset: -3px`, declared after the tint rules. **DASHED** because every other marking on this grid is solid; **an OUTLINE** so it cannot fight the tint's `box-shadow` or `.lens-band-picked`'s louder one (a mixed block that is also isolated wears both); **INSET** so it can never be read as the BLEND-SELECTION marking, which is a solid `ring-2 ring-primary` plus a filled primary circle with a checkmark at the TOP-RIGHT. No animation, like every cell marking. See **Supplier lens — UI** → "THE MIXED MARKER".

> **Print is NOT in `globals.css`.** The Blocking detail printout is fully self-contained in `blocking-detail-panel.tsx` (`buildPrintDocument()` ships its own inline print CSS inside the generated iframe document). No print rules live in `globals.css` — the earlier `@media print` / `.print-only` / `#blocking-print-root` approach was removed because toggling the live DOM leaked dark-mode/Tailwind/transforms and printed like a screenshot.

## Prop Chain (Spotlight)

`BlockingGrid` (owns `statusFilter` + `lensClassifier`, reads `labHighlights` from `useTableSettings()`, receives `supplierFilter`/`supplierMap`/`lensId` as props) -> `WarehouseSection` (gets `statusFilter`, `onToggleStatus`, `labHighlights`, `supplierKey`, `supplierByBlock`, **`lensClassifier`**) -> `WarehouseRow` (gets `statusFilter`, `labHighlights`, `supplierKey`, `supplierByBlock`, **`lensClassifier`**) -> `OccupiedCell` (gets the final `spotlightClass` — **`lensClass ?? supplierClass ?? statusClass`**, in that precedence — plus `supplierMix` for the title and `labHighlights` for MC/ASH text colors) / `EmptyCell` (gets the same resolved `spotlightClass`)

**Three lenses hang off that one seam (2026-09-22).** `BLOCKING_LENSES` is `[PRICE_LENS, AGE_LENS, SUPPLIER_LENS]`; the grid still holds exactly two things (which lens is open, and the classifier it published) and knows no band, no price, no age and no supplier. Registering the third needed **two new files, one line of `registry.ts` and one block of `globals.css`** — nothing in `blocking-grid.tsx`, `blocking-route-view.tsx`, the frame or any shared piece, which is the claim the frame was built to make.

**The lens half of that chain, sideways (updated 2026-09-21 — the frame is a BAR):** the open lens's PANEL owns its own settings and its own fetches and publishes one function upward — `onClassifierChange(classifier)` -> `BlockingLensPanel` passes it straight through -> `BlockingGrid` holds it in `lensClassifier` -> `WarehouseRow` calls `resolveLensCellClass(lensClassifier, locKey)` **and `resolveLensCellTitle(lensClassifier, locKey)`** per cell (the second feeds `OccupiedCell`'s new `lensTitle` prop, which is JOINED with the existing `supplierMix` into the cell's one native `title` — an empty result stays `undefined`, so a cell with neither carries no `title` attribute at all). **One prop goes the other way:** `BlockingGrid` passes `onFocusBlock={handleCellClick}` -> `BlockingLensPanel` -> the active lens, so a lens that NAMES a block (the age lens's oldest pile) opens it through the grid's own click path — one handler, so blend mode and the URL writer behave identically from both doors. The grid therefore knows no band, no price and no basis, which is what makes a second lens a registration rather than another branch in `blocking-grid.tsx`. **Where the frame now RENDERS changed and nothing else did:** `BlockingLensPanel` is the second row of the one `sticky top-0 z-30` wrapper that also holds the control strip, not a `shrink-0` column beside the warehouse sections — so the grid is no longer a `min-w-0 flex-1` item and gets 100% of the width. **One more prop goes sideways inside the lens:** the panel renders its bar items into the frame's row and its settings into `LensSettingsPopover`, both from the SAME component, so a lens still owns exactly one state machine and one fetch lifecycle.

**The blend modal's chain:** `BlockingGrid` (builds `batchIdByLoc` from the grid payload) -> `BlendProposalDialog` (`batchIdByLoc` + the optional `factsAdapter` port, defaulted to `fetchBlendBlockFacts`) -> one race-safe read per open/version -> `BlockRow` (`facts`) -> `SupplierPill`. The SAME record is handed to `buildBlendPrintDocument` and `downloadBlendPdf` rather than re-fetched, so the three surfaces cannot disagree.

## Dependencies

- `@/lib/utils` — `cn()` for class merging
- `@/lib/supabase/server` — Supabase client for data fetching in server actions
- `@/lib/auth` — `getUserRole()` for role-based access control (PHP/KG gating)
- `@/components/providers/table-settings` — `useTableSettings()` for lab highlight settings (used in blocking grid for MC/ASH text colors and WET/ASHY spotlight filters)
- `@/types/table-settings` — `getLabHighlightText()`, `LabMetric`, `LabHighlightSpec` types
- `view_blocking_grid` SQL view on Supabase — pre-computed blocking data
- `view_blocking_block_suppliers` SQL view on Supabase — per-block supplier breakdown for the supplier search (no ₱, so ungated)
- `lucide-react` — `X`, `Pencil`, `Check`, `StickyNote`, `Loader2`, `ChevronDown`, `ChevronUp`, `Info`, `ExternalLink`, `Printer` icons (+ `Layers`, `Calculator` for the Blend Proposal toggle/bar/sheet)
- `@/components/ui/command` (+ `cmdk`) — the supplier search combobox in `supplier-search.tsx`
- `@/components/ui/dialog` — Shadcn Dialog for the Blend Proposal result modal (`BlendProposalDialog`)
- `@/components/ui/popover`, `@/components/ui/input`, `@/components/ui/button` — the Download-PDF label prompt (Popover + Input + Cancel/Download buttons) in the Blend Proposal modal header
- `jspdf` + `jspdf-autotable` — vector/text PDF generation in `blend-proposal-pdf.ts` (the Download-PDF output; NOT html2canvas/rasterization). **PERF-4: loaded LAZILY** — `blend-proposal-dialog.tsx` does `await import('./blend-proposal-pdf')` inside the Download-click handler (not a static top import), so jsPDF ships in its own async chunk (~442 KB) instead of the eager blocking bundle. The jspdf-free filename helpers (`sanitizeLabel`/`composeBlendPdfFilename`, used synchronously for the live preview + validity) were split into **`../_shared/blend-proposal-filename.ts`** and are imported statically; `blend-proposal-pdf.ts` re-exports them for its node/test path.
- `date-fns` (`format`) — `yyMMdd` filename date + `yyyy-MM-dd` subtitle in the blend PDF
- `../_shared/print-utils` — shared `escapeHtml`/`peso`/`printViaIframe`/`PRINT_CSS` used by BOTH the detail-panel printout and the blend-proposal printout
- `@/components/shared/detail-drawer-skeleton` — platform-layer `Skeleton` primitive + `DetailDrawerSkeletonBody` / `DetailDrawerSkeleton` (the drawer skeleton the panel renders in its opt-in `loading` state, and the shell a lazily-imported host uses as its Suspense fallback). Zero tenant knowledge — the geometry/easing/z-index of `DetailDrawerSkeleton`'s shell is kept byte-identical to the panel's own so a chunk-resolve swap is a content swap, not a jump
- `@/lib/toast` — `errorToast()` for the Build Proposal failure path (persistent + Copy), and for a THROWN error in the price lens (a `{ok:false}` refusal uses the lens panel's inline Copy banner instead)
- `@/lib/actions/table-settings` — **`getUserModuleSettings` / `saveUserModuleSettings`**, the shape-agnostic per-(user, module) jsonb pair, used by `lens/use-lens-settings.ts` under `module = 'blocking_lens_<id>'`. NO migration, no new table, no new action
- `@/components/ui/select`, `@/components/ui/collapsible` — the price lens's "Market is" basis picker and its "Customize bands" disclosure
- `lucide-react` (lens) — `Highlighter` (the header button), `Coins` (the Price lens's icon), `Sliders`, `Plus`, `RotateCcw`, `Copy`, `Loader2`, `X`
- `@/components/ui/dialog` — Shadcn Dialog for edit delivery dialog
- `@/components/ui/tooltip` — Tooltip for Edit All button and metric hover (in detail panel)
- `@/components/ui/button`, `@/components/ui/input`, `@/components/ui/label` — form components in edit dialog
- `@/app/(app)/inventory/rc-in/actions` — `bulkUpdateDeliveries()` for saving delivery edits with audit trail
- `@/app/(app)/inventory/rc-in/components/DeliveryHistoryDialog` — reused for per-delivery info view in detail panel
- `next/navigation` — `useRouter()` for deep-linking to the batch's deliveries/usage with search filter
- **No tab-shell dependency.** The detail panel previously called `useInventoryTab().setActiveTab` directly for the "Edit All" tab switch. That coupling is **removed** — the panel now emits the `INVENTORY_NAVIGATE_EVENT` window event (or calls the injected `onNavigateToBatch` prop), and `InventoryTabProvider` translates it into the tab switch. This is what makes the panel safe to render outside the inventory tab shell (Phase 2 standalone routes).

## Integration

Blocking is reached via the **standalone route `/inventory/blocking`** (NOT a tab). `page.tsx` → `BlockingRouteView` fetches data on mount via `fetchBlockingGridData()`, drives `?block=` selection, and passes `data`, `canViewPrices`, the controlled `selectedLocKey`/`onSelectBlock`, and `onNavigateToBatch` to `BlockingGrid`. (The old in-tab `BlockingLazyTab` wrapper was deleted this wave; its fetch/loading/error logic moved into `BlockingRouteView`.)

## See Also

- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN (Delivery Master Log) — data source for delivery history in detail panel
- `app/(app)/inventory/rc-out/CONTEXT.md` — RC OUT (Inventory Usage) — data source for usage history in detail panel
- `app/(app)/inventory/rc-movement/CONTEXT.md` — RC Movement (Daily Feed Matrix) — **reuses `BlockingDetailPanel`** (via the optional `blockData` prop) and **`fetchBlockDataForBatch`** to open this module's slide-over from a clickable block column header
- `CLAUDE.md` — BLOCKING feature section with full warehouse layout and data source documentation
- **Lens data layers (SQL + proofs).** Price: `supabase/migrations/20260919025729_blocking_price_lens.sql`
  + `supabase/migrations/20260921034512_blend_block_facts_and_price_lens_rounded_up.sql` (the typed
  cut line) + `scripts/verify-blocking-price-lens.ts` (61). Age:
  `supabase/migrations/20260919133042_blocking_age_lens.sql` + `scripts/verify-blocking-age-lens.ts`
  (49). The age migration also adds **`public.view_batch_age_days`**, THE one definition of how old a
  batch is — shared in spirit with `view_analytics_aging_watchlist` / `view_analytics_aging_eom`, and
  proven equal to the watchlist's `age_days` on every batch both cover (gap exactly 0) on every run.
- **Blend block facts (SQL + proofs).**
  `supabase/migrations/20260921034512_blend_block_facts_and_price_lens_rounded_up.sql` (§1–§3) +
  `scripts/verify-blend-block-facts.ts` (42). That ONE migration carries both 2026-09-21 jobs — the
  new `fn_blend_block_facts` / `fn_blend_block_facts_probe`, and the price lens's typed cut line,
  which forced a DROP + CREATE of `fn_blocking_price_lens` (grants + COMMENT re-applied in the same
  file, and `fn_blocking_price_lens_probe` re-created because it names the function by argument
  types). The blend-facts half re-uses `canonical_supplier()` and reconciles its two delivery dates
  with `view_batch_age_days`, so neither supplier identity nor block age grows a second definition.
