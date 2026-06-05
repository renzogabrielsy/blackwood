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
  Uses `stagger-children` + `hover-lift`.
- `components/digest/digest-charts.tsx` — `'use client'`. Recharts 2-col grid:
  **Feed In vs Out** (dual area, `connectNulls` keeps zero days flat),
  **RC In price ₱/kg** (line), **Production by grade** (stacked bar — pivots
  long `GradePoint[]` to wide rows; single-grade case hides the legend and
  renders one bar series gracefully). All colors are `var(--chart-1..5)` tokens
  (dark-mode safe). Glass tooltip via theme tokens.
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
  (server-only). Reads `view_digest_*` SQL views + `view_digest_audit_enriched`.
  **Do not edit** `lib/digest/types.ts` or `lib/digest/queries.ts` — fixed contract.
- **Contract shape** (`lib/digest/types.ts`): `DigestData = { meta, kpis, flow,
  price, grades, latestSync, activity, flags, monthToDate }`.
  - `meta` — `operationalDate`, `prevOperationalDate`, `lastSyncAt`, `freshness`,
    `streams[]` (per-stream `throughDate` + `ok|warn`).
  - `kpis[]` — `{ key, label, value, unit, prevValue, deltaPct, spark[], sub? }`.
  - `flow[]` — `{ date, in, out }` (kg, ~30 d).  `price[]` — `{ date, phpPerKg }`.
  - `grades[]` — `{ date, grade, kg }` (long form; UI pivots to wide for stacking).
  - `latestSync` — `{ date, insertCount, updateCount, deleteCount, byEmployee[] }`.
  - `activity[]` — `{ id, at, table, operation, note, employee, provenance, diff[] }`.
  - `flags[]` — `{ kind, severity, message, date? }`.
  - `monthToDate` — `{ label, rcInKg, rcOutKg, productionKg, netKg }`.

## Key Behaviors
- **Freshness pill** — green pulsing dot when synced today, amber within ~3 d,
  muted otherwise; relative time recomputed client-side.
- **Net-flow neutrality** — `net_flow` KPI never moralizes drift: neutral delta
  color + dashed surface + "continuous-flow drift is expected" tooltip. The
  feed tank balances month-end, not daily (project rule).
- **Zero/empty handling** — every band has a tasteful empty state ("No data",
  "—", "No recent sync activity") and never crashes on missing streams.
- **Single-grade production** — the stacked-bar chart detects ≤1 grade and
  renders one bar series with no legend.
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
