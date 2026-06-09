# Daily Sync Digest — Module Context

## Purpose
The page at `/` (`app/(app)/page.tsx`) is the **Daily Sync Digest** — a modern,
server-rendered operational + ingestion-health summary. It replaced the old
modular widget dashboard (drag/resize ReactGridLayout grid), which is now
**archived** at `_archived/dashboard-v1/` (restorable via git history).

The digest marries two views, stacked top→bottom (decision: "both, stacked"):
1. **Today's operations** — the latest business day's numbers (RC In/Out,
   production, power, net flow), with trailing sparklines and deltas.
2. **Sync health** — what the ingestion "employees" (gsheet-sync,
   deliveries-manager, rc-out-manager, production-manager) pulled in, sourced
   from `audit_logs` provenance + diffs.

It is **tenant/domain code** (charcoal-shaped), unlike the archived platform-layer
widget grid. The backend contract is fixed; the UI only shapes already-computed
values into views.

## Files
- `page.tsx` — **async Server Component**. Calls `getDigestData()` once and
  composes the six bands. Thin: fetch + layout only. No `'use client'`.
- `components/digest/format.ts` — pure display formatters (`fmtKg`, `fmtKwh`,
  `fmtPhpNumber`, `fmtDeltaPct`, `fmtByUnit`, `relativeTime`, `diffValue`).
  No aggregation (HARD RULE — that lives in SQL views).
- `components/digest/digest-header.tsx` — `'use client'`. Sub-band header
  ("As of {operationalDate}") + glass freshness pill colored by `meta.freshness`
  (fresh=green pulsing dot / recent=amber / stale=muted). Relative sync time
  recomputes on the client and ticks every 60 s.
- `components/digest/kpi-hero.tsx` — `'use client'`. Responsive stat-card grid
  from `data.kpis` (rc_in, rc_out, production, power, net_flow). Each card: label,
  big mono value + unit, delta badge (▲/▼), optional `sub` line, recharts area
  sparkline (`isAnimationActive={false}`). `net_flow` is visually distinct
  (dashed/muted, neutral delta coloring, "expected drift" tooltip — never red).
  Uses `stagger-children` + `hover-lift`. ALL cards always render (no
  card-hiding); the empty state shows only when `kpis` is empty. **Sparkline
  zero-skip:** the four operational spark SERIES (`rc_in`, `rc_out`,
  `production`, `power`) drop zero-value days so a 0 day doesn't plunge the area
  chart to the floor and ruin the line — see queries.ts (Data below). This is a
  spark-only transform: card values and `avg7` are unaffected, and `net_flow`'s
  spark is left intact (a 0 net day is meaningful).
- `components/digest/digest-charts.tsx` — `'use client'`. Recharts 2-col grid:
  **Feed In vs Out** (dual area, `connectNulls` keeps zero days flat),
  **RC In price ₱/kg** (line), **Production by grade** (stacked bar — pivots
  long `GradePoint[]` to wide rows). All colors are `var(--chart-1..5)` tokens
  (dark-mode safe). Glass tooltip via theme tokens.
  **Grade-by-shift:** `GradePoint` now carries an optional `shift` ('M'|'E'|'N',
  from `view_digest_grades.shift`). `pivotGrades` segments a grade into per-shift
  series (`grade·shift` keys, e.g. `3X50·M`) ONLY when that grade has >1 distinct
  shift in the window — single-shift/shift-less grades stay one clean bar with a
  bare-grade legend label. Color is assigned per GRADE (shared hue); shifts
  within a grade are distinguished by a stepped `fillOpacity` (1 → 0.7 → 0.45).
  All series share one `stackId` (pre-ordered grade→shift), so each day still
  reads as a single stacked column across grades, with shift sub-segments
  contiguous inside each grade band. Legend hides when there's ≤1 series.
- `components/digest/trucks-summary.tsx` — `'use client'`. Excel-Standard dense
  table of trucks that logged a trip (`ttl_km > 0`) on the operational date,
  busiest first. Columns: Plate / Distance (km) / Fuel (L) — numerics `font-mono`
  tabular-nums right-aligned, `px-2 py-1`, `h-8` rows, `text-xs`. Remarks (when
  present) shown via a dotted-underline plate + shadcn Tooltip on hover. Wrapped
  in a `ChartCard`-style glass frame (`bg-card/95 backdrop-blur … hover-lift`).
  **Renders `null` when no truck moved that day** (skips the band, matching how
  other bands avoid hollow cards). Rendered between the charts and the sync band
  in `page.tsx`. Source: `data.trucks` (see Data below).
- `components/digest/sync-summary.tsx` — Server component. Compact header from
  `data.latestSync`: "{date} · {n} new · {n} updated (· {n} removed)" + per-
  employee count chips (`byEmployee`).
- `components/digest/activity-feed.tsx` — `'use client'`. The changelog: up to
  ~40 most-recent `ActivityItem`s. Each row = op pill (INSERT green / UPDATE
  amber / DELETE red) + relative time + employee badge + provenance tag + table +
  note (truncated at 120 chars, click to expand) + diff chips ("field: old → new"
  mono). **Not animated per-row** (single container fade only — follows the
  "never animate 100+ instances" rule). `ActivityItem.id` is used ONLY as a
  React key (opaque hashed int, not a DB id).
- `components/digest/digest-footer-band.tsx` — Server component. 3-col final band:
  **Flags** (alert chips by severity info/warn/critical, lucide icons),
  **Stream freshness** (Excel-standard dense table: label · through-date · status
  dot ok-green/warn-amber), **Month-to-date** card (rcInKg / rcOutKg /
  productionKg / netKg in kg format; net row muted).

## Data
- **Source:** `getDigestData(): Promise<DigestData>` from `lib/digest/queries.ts`
  (server-only). Reads `view_digest_*` SQL views + `view_digest_audit_enriched`,
  plus the `truck_readings` table for the trucks band. The contract in
  `lib/digest/types.ts` is intentionally stable — extend it deliberately (as with
  `trucks` / `GradePoint.shift`) and keep `queries.ts` to light mapping only (all
  aggregation stays in SQL views per the HARD RULE).
- **Contract shape** (`lib/digest/types.ts`): `DigestData = { meta, kpis, flow,
  price, grades, latestSync, activity, flags, monthToDate, trucks }`.
  - `meta` — `operationalDate`, `prevOperationalDate`, `lastSyncAt`, `freshness`,
    `streams[]` (per-stream `throughDate` + `ok|warn`).
  - `kpis[]` — `{ key, label, value, unit, prevValue, deltaPct, spark[], sub? }`.
    The four operational `spark[]` series (rc_in/rc_out/production/power) are
    built with zero-value days FILTERED OUT (pre-`tail`) so a 0 day doesn't dip
    the sparkline to the floor; `net_flow.spark` keeps all days. `value`/`avg7`
    are computed from the full series and are NOT affected by this spark filter.
  - `flow[]` — `{ date, in, out }` (kg, ~30 d).  `price[]` — `{ date, phpPerKg }`.
  - `grades[]` — `{ date, grade, kg, shift? }` (long form; UI pivots to wide for
    stacking; `shift` = 'M'|'E'|'N'|undefined, segments multi-shift grades).
  - `latestSync` — `{ date, insertCount, updateCount, deleteCount, byEmployee[] }`.
  - `activity[]` — `{ id, at, table, operation, note, employee, provenance, diff[] }`.
  - `flags[]` — `{ kind, severity, message, date? }`.
  - `monthToDate` — `{ label, rcInKg, rcOutKg, productionKg, netKg }`.
  - `trucks[]` — `{ plateNo, ttlKm, fuelLiters, remarks }`. Queried directly from
    the `truck_readings` TABLE (not a `view_digest_*` view) in `getDigestData()`:
    `.eq('reading_date', operationalDate).gt('ttl_km', 0).order('ttl_km', desc)`.
    `ttl_km` is a GENERATED column (= end_km − start_km); `> 0` ⇒ "had a trip".
    Keyed on the SAME `operationalDate` as the KPIs (fetched after it resolves,
    same pattern as the `rcInSub` follow-up query). Empty array ⇒ band hidden.

## Key Behaviors
- **Freshness pill** — green pulsing dot when synced today, amber within ~3 d,
  muted otherwise; relative time recomputed client-side.
- **Net-flow neutrality** — `net_flow` KPI never moralizes drift: neutral delta
  color + dashed surface + "continuous-flow drift is expected" tooltip. The
  feed tank balances month-end, not daily (project rule).
- **Zero/empty handling** — every band has a tasteful empty state ("No data",
  "—", "No recent sync activity") and never crashes on missing streams.
- **Single-series production** — the stacked-bar chart detects ≤1 resulting
  series (after grade×shift pivoting) and renders one bar with no legend.
- **Sparkline zero-skip** — the `rc_in`/`rc_out`/`production`/`power` spark
  series omit zero-value days (filtered pre-`tail` in queries.ts) so a 0 day
  doesn't sink the area chart; cards/`avg7`/`net_flow` spark are unaffected.
- **Trucks band** — lists trucks with `ttl_km > 0` on the operational date; the
  whole band disappears on a no-movement day (renders `null`).
- **Motion** — `animate-fade-up` on header/feed container, `stagger-children`
  on the KPI grid, `hover-lift` on cards/charts. Activity rows use only a
  `transition-colors` hover, no per-row entrance.
- **Navbar** — `/` returns `null` from `getBreadcrumb()`, so the left side stays
  empty (no redundant title). The digest renders its own sub-band header only.

## Dependencies
- `lib/digest/queries.ts` / `lib/digest/types.ts` — data contract (do not edit).
- `recharts` — sparklines + the three charts (also used by the archived widgets).
- `lib/utils` (`cn`), `components/ui/tooltip` (shadcn), `lucide-react` (flag icons).
- `app/globals.css` — `--chart-1..5`, `--popover`, motion utilities, glass classes.

## See Also
- `_archived/dashboard-v1/README.md` — the previous widget dashboard (archived).
- `components/NAVBAR.md` — `/` has no breadcrumb entry (left side empty).
- `CLAUDE.md` — Motion & Glass, Excel Standard, Error Toasts hard rule.
