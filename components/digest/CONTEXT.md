# Digest Bands — Home Daily Sync Digest UI

## Purpose
The presentation components for the home page at `/` (the **Daily Sync Digest**).
Each file is one band: a self-contained display component that consumes ONE slice
of the `DigestData` object returned by `getDigestData()` (`lib/digest/queries.ts`).
Bands never touch Supabase and never aggregate — all totals/running values are
computed in the `view_digest_*` SQL views (project HARD RULE). These components
only shape already-computed numbers into views. The page shell that composes them
in order is `app/(app)/page.tsx` (an async Server Component).

> **Tenant/domain code (charcoal-shaped).** These bands are the digest's
> presentation layer, not platform-generic widgets (the widget dashboard they
> replaced is archived at `_archived/dashboard-v1/`). See `app/(app)/CONTEXT.md`
> for the band-by-band data contract and `CLAUDE.md` → **Home Digest** for the
> render-order table.

## Files
| File | Client? | `DigestData` slice | Role |
|------|---------|--------------------|------|
| `format.ts` | — (pure) | — | Display-only formatters: `fmtKwh`, `fmtDeltaPct`, `fmtByUnit`, `relativeTime`, `diffValue` (defined here) + `fmtKg`, `fmtPhpNumber` (**re-exported from `@/lib/format-utils`** — DUP-5 single-homed the canonical round-and-group kg/₱ formatters there; digest components still `import … from "./format"` unchanged). **Grade helpers** (`GradeTon` type, `parseGradeTons` — defensive JSONB → `{grade,tons}[]` heaviest-first, drops null/zero; `fmtGradeTons`; `gradeTonsTitle`) shared by `schedule-preview.tsx` AND the full `/production/schedule` page. No aggregation. Client- and server-safe. |
| `digest-header.tsx` | `'use client'` | `meta` | Sub-band header ("As of {operationalDate}") + glass freshness pill (fresh/recent/stale). Relative sync time ticks every 60 s client-side. |
| `plant-status-header.tsx` | `'use client'` | `plantStatus` (+ `meta`, `fedKg`) | Operational-date status bar: running/rest **beacon** (pulsing when running), planned setup, projected tons, fed kg, last-sync freshness (ticks every 60 s) + a streams-behind note. Renders a neutral "no plan on record" state when `plantStatus` is null. Glass card + `animate-fade-up`. |
| `status-tokens.ts` | — (pure) | — | Shared chip / severity-rail / label class maps per operational-day state (`STATE_CHIP`, `STATE_RAIL`, `STATE_LABEL`, `BEACON_DOT`). emerald/amber/red/muted + violet for the PLAN layer. Consumed by `kpi-hero`, `week-strip`, `plant-status-header`. Client- and server-safe. |
| `open-blocks.tsx` | `'use client'` | `openBlocks` | Compact card grid — one card per currently **IN-USE** block (`status = 'IN-USE'`), `block_loc` ascending: header + "volume left" bar + 7-stat lab mini-grid + optional gated ₱/kg line. **Each card is a clickable, keyboard-accessible control** — activating it calls `fetchBlockDataForBatch(batchId)` (`@/app/(app)/inventory/blocking/actions`) and opens the ESTABLISHED Blocking slide-over **`BlockingDetailPanel`** (`@/app/(app)/inventory/_shared/blocking-detail-panel`, lazy-loaded via `next/dynamic`, `ssr:false`) with the full balance / quality / delivery + usage history. Mirrors the RC Movement matrix's click→fetch→panel pattern; one panel open at a time; `onNavigateToBatch` OMITTED (panel's internal fallback handles "Edit All"). The **embedded per-block deliveries ledger was REMOVED** (it crammed the half-width column) — that data now lives in the slide-over. Card ₱/kg display is INFERRED from whether any `phpKg` is non-null (Production gets all-null → no ₱ renders); the PANEL uses the `canViewPrices` the action returns. Renders `null` when empty. **Surfaced near the top** of the digest (half-width, paired beside `schedule-preview`). |
| `kpi-hero.tsx` | `'use client'` | `kpis`, `dayStatus` | State-aware stat-card grid (rc_in/rc_out/production/power/net_flow). Each card consults `dayStatus[kpi.key]`: **`reported`** → number + delta badge + sparkline (as before; `net_flow` stays neutral "expected drift", never red); **`awaiting`/`rest`/`stale`/`idle`** → a `StateCard` with a state label + left severity rail + chip + ghosted projection and **no sparkline** ("no active series"), replacing the misleading `0`. |
| `digest-charts.tsx` | `'use client'` | `flow`, `price`, `grades`, `productionHours`, `weekPlan` | Recharts, **two stacked sub-rows** (`flex flex-col gap-3`): **Row 1** = Feed In vs Out (rest-day-aware `ComposedChart` — rest / no-report / no-delivery days stay **null** so the line never plunges to zero, but the lines **connect smoothly across** them via `connectNulls={true}` for one continuous stroke, not gaps; a `planByDate` map built from `weekPlan` still adds a faint band on rest days and an amber marker on awaiting days as background context) + RC In price ₱/kg (line — omitted entirely when `price` is empty, which is how price-denied roles see it; the ₱ YAxis uses a **data-driven padded domain** `[min − max(range·0.6, 1.5), max + max(range·0.25, 0.5)]` rounded to whole ₱ so the low floats off the axis floor instead of reading as zero); the row is `lg:grid-cols-2` only when price is shown so a gated flow chart spans full width. **Row 2** = **Production by grade** (stacked bar, pivots long→wide, segments multi-shift grades by `fillOpacity`) paired LEFT with the **`ProductionHoursTable`** RIGHT — a dedicated `lg:grid-cols-2` sub-row so the two production panels are ALWAYS side-by-side regardless of whether the price chart above is present (grade spans full width only when `productionHours` is empty). Stacks single-column on mobile. `ChartCard` gained an optional `legend` slot for the flow chart's custom band swatches. |
| `production-hours-table.tsx` | Server | `productionHours` | Compact Excel-Standard **Work & downtime hours** table paired BESIDE the Production-by-grade chart. Columns **Date · Work hrs · Downtime hrs**; one row per day over the last 14 days (`GRADE_DAYS` window, ascending → same left→right day order as the grade chart), MM-DD date, `font-mono` right-aligned numerics, `text-xs`. Downtime > 0 tinted amber, else muted dash. Capped `max-h-[220px] overflow-y-auto` with a sticky `.frozen-row` header + sticky `.frozen-row-bottom` **TTL footer** (SUM of work + downtime hrs across the window — a presentational display sum, the per-day figures are SUMmed in `view_digest_daily_hours`). Digest card chrome (`rounded-xl border bg-card/95 backdrop-blur hover-lift`), title "Work & downtime hours", subtitle "last 14 days · hrs". Renders `null` when `productionHours` is empty. No ₱ → no gating. |
| `schedule-preview.tsx` | Server | `schedulePreview` | Compact Excel-Standard **Production Schedule table** — a rolling **10-day** window (operational date → +9 days), sized as a **half-width scroll card** (`max-h-[340px] overflow-auto` + sticky `frozen-row` header) that pairs beside `OpenBlocks` on wide screens (see `app/(app)/CONTEXT.md` snapshot row). Columns: Date · Day · **Setup / grades** · Sh · **Total t** · Act t · **Act hrs** · Status · Src. **Act hrs** = `SchedulePreviewRow.actualHrs` (actual reported work hours, `view_digest_daily_hours.work_hrs`), right of Act t; most rows are null in this forward-looking window → muted dash, expected. The Setup cell stacks a muted **per-grade tonnage** breakdown (`3X50 21t · 4X8 5t`, heaviest first, single-line truncate + full `title`) beneath the setup name; **Total t** is the day total (`projectedTons`). Rows are `align-top` (grade line makes working rows 2-line); rest days show a clean dash, no grade line. Today's row accent-tinted; Status chip reuses `STATE_CHIP`/`STATE_LABEL`, Src chip is violet **Joseph** when `source` starts with `joseph:` else muted **Sheet**. Grades parsed via `parseGradeTons`/`fmtGradeTons`/`gradeTonsTitle` (`./format`). Renders `null` when empty. No ₱ → no gating. |
| `week-strip.tsx` | Server | `weekPlan` | This-week plan-vs-actual strip — one card per day of the operational date's week: dow + date, setup, a violet planned bar over a chart-1 actual bar, and a state chip (Reported / Today / Planned). Rest days render dashed + "planned rest"; today gets a `ring`. Uses the pre-resolved `WeekDayPlan.state`. Rendered **near the top** of the digest (under the plant-status band); its heading links to `/production/schedule`. |
| `trucks-summary.tsx` | `'use client'` | `trucks` | Excel-Standard dense table of trucks that logged a trip (`ttl_km > 0`) on the operational date, busiest first. Renders `null` on a no-movement day. |
| `bag-inventory.tsx` | Server | `fleconBags` | Compact chip group — one chip per FLECON bag type (label + balance), `sort_order` ascending. Zero-balance chips dimmed. No price data. Renders `null` when no bag types. |
| `sync-summary.tsx` | Server | `latestSync` | Compact header: "{date} · {n} new · {n} updated (· {n} removed)" + per-employee count chips (`byEmployee`). Owns the `employeeLabel()` key→friendly-name map. |
| `activity-feed.tsx` | `'use client'` | `activity` | The changelog: up to ~40 recent `ActivityItem`s — op pill (INSERT/UPDATE/DELETE) + relative time + employee + provenance + table + note + diff chips. NOT animated per-row (single container fade). |
| `digest-footer-band.tsx` | Server | `flags`, `monthToDate` (+ `meta.streams` for freshness) | 3-col final band: Flags (severity chips), Stream freshness (dense table), Month-to-date card. |

## Operational-day states (the "misleading zero" fix, now LIVE)
The digest resolves each stream/day to ONE of five states so a bare `0` carries
meaning: **`reported`** (real value → number + delta), **`awaiting`** (plant ran
but the report hasn't landed → amber, ghosted projection), **`rest`** (0 shifts,
calm — zero is correct), **`stale`** (stream overdue → red), **`idle`** (rc_in
procurement, not shift-bound → neutral). This was promoted from a draft proposal
(`components/digest/draft/` + `app/(app)/dashboard-draft/`, both now deleted) into
the real bands, fed by REAL data.

| File | Client? | Role |
|------|---------|------|
| `lib/digest/day-status.ts` | pure | The state resolvers — `resolveKpiDayStatus()` → `reported`/`awaiting`/`rest`/`stale`/`idle` (rc_in = procurement → `idle`, not late; net_flow stays neutral) + `resolveScheduleRowState()` for the week strip. Also **owns the `ProdSchedDay` / `PlannedShifts` type** (moved here when the frozen `prod-schedule-draft.ts` constant was retired — the plan now comes from the `production_schedule` table via `getDigestData()`). |

The live adapter (`getDigestData()`) computes `plantStatus`, per-KPI `dayStatus`,
and the 7-day `weekPlan` server-side from the `production_schedule` table joined
with `view_digest_prod_actual_tons` (actual tons SUM in SQL). The presentation
bands (`plant-status-header`, state-aware `kpi-hero`, rest-day-aware
`digest-charts` flow chart, `week-strip`) consume those slices — no plan constant,
no TS aggregation. Price gating is inherited from `getDigestData()`; none of these
bands surface ₱.

## Data
- **Single source:** `getDigestData(): Promise<DigestData>` (`lib/digest/queries.ts`,
  server-only). The contract lives in `lib/digest/types.ts`; extend it deliberately
  and keep `queries.ts` to light mapping only. Reads `view_digest_*` views +
  `view_digest_audit_enriched`, the `truck_readings` table (trucks), `view_blocking_grid`
  (open blocks), and `view_flecon_bag_balance` (bag inventory).
- **Price gating (security boundary):** ₱ data (`price[]`, `openBlocks[].phpKg`) is
  nulled/emptied SERVER-SIDE in `getDigestData()` when `!canViewPrices()` — the
  bands only ever *infer* visibility (e.g. open-blocks: "if every `phpKg` is null,
  render no ₱"). Never re-derive the price gate in a band. See `app/(app)/CONTEXT.md`
  Data section + `CLAUDE.md` → Price gating.

## Key Behaviors
- **Presentation-only.** No band sums, re-sorts, or re-aggregates its slice — SQL
  views own all aggregation. Bands render rows in server array order.
- **Empty-state discipline.** Bands that can be empty render `null` to skip the
  band entirely (open-blocks, trucks-summary, bag-inventory) or show a tasteful
  "No data / —" placeholder; nothing crashes on missing streams.
- **Motion (per `CLAUDE.md` Motion & Glass rules).** Glass card frames
  (`bg-card/95 backdrop-blur … hover-lift`); `animate-fade-up` on band reveals;
  `stagger-children` on the KPI grid; `stagger-fast` on the small open-blocks /
  bag-inventory groups (allowed — ≤ a handful, NOT the 100+-instance table case);
  the open-block volume bar grows from the left via `animate-status-grow`
  (`transform: scaleX`, `origin-left` — never animates width). The activity feed is
  a single container fade with per-row `transition-colors` hover only.
- **Recharts** with `isAnimationActive={false}` on sparklines; theme-token colors
  (`var(--chart-1..5)`) for dark-mode safety.

## Dependencies
- `lib/digest/queries.ts` / `lib/digest/types.ts` — the data contract (do not edit lightly).
- `recharts` — sparklines (kpi-hero) + the three charts (digest-charts).
- `@/lib/utils` (`cn`), `@/components/ui/tooltip` (shadcn), `lucide-react` (flag icons).
- `app/globals.css` — `--chart-1..5`, `--popover`, motion utilities, glass classes.

## See Also
- [Home Daily Sync Digest](../../app/(app)/CONTEXT.md) — the page shell + full `DigestData` contract and per-band data notes.
- `CLAUDE.md` → **Home Digest** — render-order table and price-gating rule.
- `_archived/dashboard-v1/README.md` — the previous widget dashboard these bands replaced.
