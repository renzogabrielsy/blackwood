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
| `format.ts` | — (pure) | — | Display-only formatters: `fmtKwh`, `fmtDeltaPct`, `fmtByUnit`, `relativeTime`, `diffValue` (defined here) + `fmtKg`, `fmtPhpNumber` (**re-exported from `@/lib/format-utils`** — DUP-5 single-homed the canonical round-and-group kg/₱ formatters there; digest components still `import … from "./format"` unchanged). No aggregation. Client- and server-safe. |
| `digest-header.tsx` | `'use client'` | `meta` | Sub-band header ("As of {operationalDate}") + glass freshness pill (fresh/recent/stale). Relative sync time ticks every 60 s client-side. |
| `open-blocks.tsx` | Server | `openBlocks` | Compact card grid — one card per currently **IN-USE** block (`status = 'IN-USE'`), `block_loc` ascending: header + "volume left" bar + 7-stat lab mini-grid + optional gated ₱/kg line. Price display is INFERRED from whether any `phpKg` is non-null (Production gets all-null → no ₱ renders). Renders `null` when empty. **Surfaced at the very top** of the digest. |
| `kpi-hero.tsx` | `'use client'` | `kpis` | Responsive stat-card grid (rc_in/rc_out/production/power/net_flow). Each card: label, big mono value, delta badge, recharts area sparkline (no animation). `net_flow` styled neutral ("expected drift", never red). |
| `digest-charts.tsx` | `'use client'` | `flow`, `price`, `grades` | Recharts grid: Feed In vs Out (dual area), RC In price ₱/kg (line — omitted entirely when `price` is empty, which is how price-denied roles see it), Production by grade (stacked bar, pivots long→wide, segments multi-shift grades by `fillOpacity`). |
| `trucks-summary.tsx` | `'use client'` | `trucks` | Excel-Standard dense table of trucks that logged a trip (`ttl_km > 0`) on the operational date, busiest first. Renders `null` on a no-movement day. |
| `bag-inventory.tsx` | Server | `fleconBags` | Compact chip group — one chip per FLECON bag type (label + balance), `sort_order` ascending. Zero-balance chips dimmed. No price data. Renders `null` when no bag types. |
| `sync-summary.tsx` | Server | `latestSync` | Compact header: "{date} · {n} new · {n} updated (· {n} removed)" + per-employee count chips (`byEmployee`). Owns the `employeeLabel()` key→friendly-name map. |
| `activity-feed.tsx` | `'use client'` | `activity` | The changelog: up to ~40 recent `ActivityItem`s — op pill (INSERT/UPDATE/DELETE) + relative time + employee + provenance + table + note + diff chips. NOT animated per-row (single container fade). |
| `digest-footer-band.tsx` | Server | `flags`, `monthToDate` (+ `meta.streams` for freshness) | 3-col final band: Flags (severity chips), Stream freshness (dense table), Month-to-date card. |

## Draft dashboard (`draft/` — proposal, not live)
The `components/digest/draft/` subfolder + the route `app/(app)/dashboard-draft/`
are a **DRAFT proposal** (registered in the navbar, superseded the old static mock
`public/verbose-dashboard.html`). It reworks the digest around operational-day
**states** — resolving the "misleading zero" (a planned rest, an unfiled report, and
a stale stream all rendered `0` today). It reuses the LIVE `getDigestData()` adapter
for real KPIs/flow/meta and stands in for the not-yet-ingested PROD SCHED tab with a
labeled constant. When a real PROD SCHED extractor + `view_digest_day_status` view
land, the two `lib/digest/*-draft`/`day-status` modules should fold into SQL.

| File | Client? | Role |
|------|---------|------|
| `lib/digest/prod-schedule-draft.ts` | pure | **DRAFT constant** — July 2026 PROD SCHED plan (`ProdSchedDay[]`), `SETUP_REFERENCE`, `ORDER_COMMITMENTS` + `getPlanForDate` / `getWeekPlan` / `getMonthPlan`. Delete when the tab is ingested. |
| `lib/digest/day-status.ts` | pure | The "misleading zero" resolver — `resolveKpiDayStatus()` → `reported`/`awaiting`/`rest`/`stale`/`idle` (rc_in = procurement → `idle`, not late; net_flow stays neutral). `resolveScheduleRowState()` for the schedule table. |
| `draft/status-tokens.ts` | pure | Shared chip/rail/label class maps per state (emerald/amber/red/muted + violet for the PLAN layer). |
| `draft/plant-status-header.tsx` | `'use client'` | Operational-date status bar: running/rest beacon, planned setup, projected t, fed kg, last-sync freshness (ticks). |
| `draft/draft-kpi-hero.tsx` | `'use client'` | State-aware KPI cards — `reported` mirrors the live hero; `awaiting`/`rest`/`stale`/`idle` show a state label + severity rail + chip + ghosted projection instead of a misleading zero (no sparkline). |
| `draft/draft-flow-chart.tsx` | `'use client'` | Recharts `ComposedChart` — rest days = **gap** (`connectNulls={false}`, no plunge) + faint band; awaiting days = amber marker. |
| `draft/week-strip.tsx` | Server | 7-day plan-vs-actual strip (planned vs actual bars, rest dashed, today ringed). |
| `draft/schedule-table.tsx` | Server | Month plan-vs-actual table (Excel Standard density, sticky header) + orders & setup-reference rails. |

The route's actual-production tons are queried in the page (`getActualTonsByDate` —
sums `production_runs.ttl_kg` by parent shift `transaction_date`, /1000; a DRAFT
TS-side rollup that a real view would own). Price gating is inherited from
`getDigestData()`; the draft surfaces no ₱.

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
