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
  composes the bands. Thin: fetch + layout only. No `'use client'`.
  **Render order, top→bottom:** (DigestHeader + **SyncLauncher**) header row →
  **OpenBlocks** (surfaced at the very top) → KpiHero → DigestCharts →
  TrucksSummary → **BagInventory** → (SyncSummary + ActivityFeed) →
  DigestFooterBand.
  The header row is a `flex justify-between` wrapper: DigestHeader takes the
  remaining width (`flex-1`), and `<SyncLauncher />` (client component from
  `components/sync/`) sits right-aligned. **This is where the Daily Sync launcher
  lives** — a privileged-only "Run Sync" button that opens the sync **modal**,
  replacing the retired floating button. See `app/(app)/sync/CONTEXT.md`.
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
  **RC In price ₱/kg** (line — skipped entirely when `price` is empty, which
  happens for price-denied roles since the series is gated server-side),
  **Production by grade** (stacked bar — pivots
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
- `components/digest/open-blocks.tsx` — **Server component** (no interactivity;
  Batch sub-label uses a native `title` tooltip, not shadcn Tooltip). A COMPACT
  at-a-glance **card grid** — one card per currently **IN-USE** block
  (`status = 'IN-USE'`), `block_loc` ascending — chosen because only a few blocks
  are ever in-use, so cards read better than a dense table. Responsive grid
  `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`. Each card, top→bottom:
  **(1) header** — prominent `blockLoc` (`font-mono text-lg`) over a muted,
  truncated `batchCode` sub-label (`title={batchCode}`), with a status dot+label
  top-right (IN-USE `bg-primary` / else `bg-muted-foreground/40`);
  **(2) the centerpiece "volume left" bar** — big `fmtKg(balanceKg)` + "kg left"
  with "{pct}% remaining" and an "of {total}" sub-caption; fraction =
  `balanceKg / totalInKg`, **guarded for `totalInKg === 0`** and **clamped [0,1]**;
  a `h-2.5 rounded-full bg-muted` track holds a fill whose static width is the
  inline `style={{ width: `${pct}%` }}` (server-rendered) and which **grows from
  the LEFT on mount via `transform: scaleX`** (class `animate-status-grow` +
  `origin-left` to override the utility's default `right center` origin — NEVER
  animates width); fill tint by depletion via `depletionFill()` —
  `< 0.20 → bg-red-500`, `< 0.50 → bg-primary`, `≥ 0.50 → bg-emerald-500`;
  **(3) a compact 7-stat lab mini-grid** (`grid-cols-4`) — MC · ASH · BD ASTM ·
  BD JIS · GRIT · VM · FC, each a tiny uppercase label over a mono value, 2 dp for
  MC/ASH/GRIT/VM/FC and 3 dp for BD ASTM/JIS;
  **(4) an optional gated ₱/kg line**. Wrapped in the same glass card frame as
  trucks-summary (`bg-card/95 backdrop-blur … hover-lift`), and each card carries
  its own `hover-lift` (cards, not rows — allowed). **Price gating is INFERRED**
  (no `canViewPrices` flag on the contract): `showPrice =
  openBlocks.some(b => b.phpKg !== null)` — when every card is null (Production
  role gated server-side) NO ₱ element renders ANYWHERE; when shown, `phpKg === 0`
  → `—` ("no priced deliveries", distinct from `null` = gated). Motion:
  `animate-fade-up` + `hover-lift` on the outer band, `stagger-fast` on the card
  grid (small ≤-handful group — allowed, NOT the 100+-instance table case), and
  the bar fill's one-shot `animate-status-grow` scaleX. **Renders `null` when
  empty.** Rendered at the **very top** of the digest (right after the header,
  before the KPI hero) in `page.tsx`. Source: `data.openBlocks` (see Data below).
- `components/digest/bag-inventory.tsx` — **Server component** (pure display,
  mirrors open-blocks). A compact at-a-glance **chip group** — one chip per
  FLECON bag type (label + balance), `sort_order` ascending (backend order
  preserved, never re-sorted/re-summed in TS). Zero-balance chips render
  dimmed (`opacity-70`); non-zero chips read prominent. **No price data anywhere
  in this domain — nothing gated.** Glass card frame (`bg-card/95 backdrop-blur
  … hover-lift`), `stagger-fast` on the chip group (small group — allowed).
  **Renders `null` when there are no bag types.** Rendered between the trucks
  band and the sync band in `page.tsx`. Source: `data.fleconBags` (balances from
  `view_flecon_bag_balance`; see Data below).
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
  - Stream freshness is fed by `view_digest_stream_freshness` (one row per stream).
    Each stream's `through_date` = max transaction/reading date on its OWN table,
    EXCEPT **production**: its `through_date` = max `production_shifts.transaction_date`
    that has ≥1 `production_runs` row (actual OUTPUT). This is deliberate — a shift is
    also created by the WASTE report (`production_waste` FKs `shift_id`), so keying on
    the raw shift date would report Production as current whenever waste is fresh even
    though output ingestion (MC's Daily Production Report) has stalled. See migration
    `20260714000000_digest_stream_freshness_production_output.sql`.

## Data
- **Source:** `getDigestData(): Promise<DigestData>` from `lib/digest/queries.ts`
  (server-only). Reads `view_digest_*` SQL views + `view_digest_audit_enriched`,
  the `truck_readings` table for the trucks band, `view_blocking_grid` for the
  open-blocks band, and `view_flecon_bag_balance` for the bag-inventory band.
  The contract in
  `lib/digest/types.ts` is intentionally stable — extend it deliberately (as with
  `trucks` / `GradePoint.shift`) and keep `queries.ts` to light mapping only (all
  aggregation stays in SQL views per the HARD RULE).
- **Contract shape** (`lib/digest/types.ts`): `DigestData = { meta, kpis, flow,
  price, grades, latestSync, activity, flags, monthToDate, trucks, openBlocks,
  fleconBags }`.
  - `meta` — `operationalDate`, `prevOperationalDate`, `lastSyncAt`, `freshness`,
    `streams[]` (per-stream `throughDate` + `ok|warn`).
  - `kpis[]` — `{ key, label, value, unit, prevValue, deltaPct, spark[], sub? }`.
    The four operational `spark[]` series (rc_in/rc_out/production/power) are
    built with zero-value days FILTERED OUT (pre-`tail`) so a 0 day doesn't dip
    the sparkline to the floor; `net_flow.spark` keeps all days. `value`/`avg7`
    are computed from the full series and are NOT affected by this spark filter.
  - `flow[]` — `{ date, in, out }` (kg, ~30 d).  `price[]` — `{ date, phpPerKg }`
    (₱ = gated by `canViewPrices()`: EMPTY array for price-denied roles).
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
  - `openBlocks[]` — `{ blockLoc, batchCode, status, balanceKg, totalInKg, mc, ash,
    bdAstm, bdJis, grit, vm, fc, phpKg }`. Currently **IN-USE** blocks, `block_loc`
    ascending. `totalInKg` (total RC-IN ever delivered to the block) is the
    "volume left" bar denominator (`balanceKg / totalInKg`).
    Queried from `view_blocking_grid` (all aggregation is the view's job — light
    passthrough only): `.eq('status', 'IN-USE').order('block_loc', asc)`.
    The `.eq()` filter is load-bearing — the view ALSO returns
    STORED/SUNDRYING/SUNDRIED (outside this band's contract: OPEN blocks = the
    ones actively being fed/consumed), so they're excluded in the query.
    Current-state, NOT date-keyed (independent of `operationalDate`). `phpKg` is **gated by
    `canViewPrices()`** (`lib/auth.ts`): nulled SERVER-SIDE for the Production role
    before the payload leaves; a visible-but-`0` value means "no priced deliveries"
    (distinct from `null` = gated).
  - `fleconBags[]` — `{ bagTypeId, code, label, sortOrder, opening, totalIn,
    totalOut, balance, lastMovementDate }`. One entry per bag type,
    `sort_order` ascending. Row-level passthrough from `view_flecon_bag_balance`
    (all aggregation is the view's job). **No price data** — nothing gated.

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
  on the KPI grid, `hover-lift` on cards/charts. The Open Blocks band is a small
  card grid (≤ a handful), so it uses `stagger-fast` + per-card `hover-lift`
  (allowed for small groups), and each card's volume bar fill grows from the left
  on mount via `animate-status-grow` (`transform: scaleX`, `origin-left`) — never
  animating width. The activity feed stays a single container fade with rows
  using only a `transition-colors` hover and no per-row entrance (the
  "never animate 100+ instances" rule).
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
