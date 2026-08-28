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
| `format.ts` | — (pure) | — | Display-only formatters: `fmtKwh`, `fmtDeltaPct`, `fmtByUnit`, `relativeTime`, `diffValue`, `fmtShortDate`, `fmtDayAge`, `fmtMissedDays`, `fmtReportsDue` (defined here) + `fmtKg`, `fmtPhpNumber` (**re-exported from `@/lib/format-utils`** — DUP-5 single-homed the canonical round-and-group kg/₱ formatters there; digest components still `import … from "./format"` unchanged). No aggregation. Client- and server-safe. **REMOVED 2026-08-28:** the grade helpers (`GradeTon`, `parseGradeTons`, `fmtGradeTons`, `gradeTonsTitle`) — they parsed the `production_schedule.grades` JSONB and their only consumers were the retired schedule bands. |
| `shell.ts` | — (pure) | — | `HOME_SHELL_CLS` — the page-shell container class string for `app/(app)/page.tsx`. It has its own module for a historical reason (it once had to keep `/?view=schedule` and `/production/schedule` pixel-identical — BUG-003); with those retired there is ONE consumer plus `app/(app)/loading.tsx`, which must reproduce the same container for its skeleton. Not a component, no tenant knowledge. |
| `digest-header.tsx` | `'use client'` | `meta` | Sub-band header ("As of {operationalDate}") + glass freshness pill (fresh/recent/stale). Relative sync time ticks every 60 s client-side. |
| `plant-status-header.tsx` | `'use client'` | `meta`, `fedKg` | Operational-date bar: the date + weekday, kg fed (RC Out), last-sync freshness (ticks every 60 s) + a streams-behind note. Glass card + `animate-fade-up`. **REDUCED 2026-08-28:** it used to open with a running/rest **beacon** and carry **Planned setup** + **Projected out**, all from the retired `production_schedule` plan, and to accept a `plantStatus` prop. None of the three is derivable from activity — `fedKg` on the operational date is normally 0 because RC Out is filed the following morning, so a beacon driven off it would announce "plant at rest" on an ordinary working day. The band now reports only what it can observe; a confident wrong status is worse than none. |
| `status-tokens.ts` | — (pure) | — | Shared chip / severity-rail / label class maps per operational-day state (`STATE_CHIP`, `STATE_RAIL`, `STATE_LABEL`). emerald/amber/red/muted. Consumed by `kpi-hero`. Client- and server-safe. **TRIMMED 2026-08-28:** `rest` / `planned` / `today` and `BEACON_DOT` went with the production plan; `StatusKey` now mirrors `DayState` in `lib/digest/day-status.ts` EXACTLY, which is the point — a token map carrying states nothing can produce invites a dead branch. |
| `open-blocks.tsx` | `'use client'` | `openBlocks` | Compact card grid — one card per currently **IN-USE** block (`status = 'IN-USE'`), `block_loc` ascending: header + "volume left" bar + 7-stat lab mini-grid + optional gated ₱/kg line. **Each card is a clickable, keyboard-accessible control** — activating it calls `fetchBlockDataForBatch(batchId)` (`@/app/(app)/inventory/blocking/actions`) and opens the ESTABLISHED Blocking slide-over **`BlockingDetailPanel`** (`@/app/(app)/inventory/_shared/blocking-detail-panel`, lazy-loaded via `next/dynamic`, `ssr:false`) with the full balance / quality / delivery + usage history. Mirrors the RC Movement matrix's click→fetch→panel pattern; one panel open at a time; `onNavigateToBatch` OMITTED (panel's internal fallback handles "Edit All"). The **embedded per-block deliveries ledger was REMOVED** (it crammed the half-width column) — that data now lives in the slide-over. Card ₱/kg display is INFERRED from whether any `phpKg` is non-null (Production gets all-null → no ₱ renders); the PANEL uses the `canViewPrices` the action returns. Renders `null` when empty. **Surfaced near the top** of the digest. It used to be the half-width right-hand cell of a two-column snapshot row shared with the retired `schedule-preview`; since 2026-08-28 it spans the full width and the `sm:grid-cols-2` card grid simply gets more room. |
| `kpi-hero.tsx` | `'use client'` | `kpis`, `dayStatus` | State-aware stat-card grid (rc_in/rc_out/production/power/net_flow). Each card consults `dayStatus[kpi.key]`: **`reported`** → number + delta badge + sparkline (as before; `net_flow` stays neutral "expected drift", never red — its inputs' lateness is reported by their OWN cards, and repeating it here would count one missing report as two problems); **`awaiting`/`stale`/`idle`** → a `StateCard` with a state label + left severity rail + chip and **no sparkline** ("no active series"), replacing the misleading `0`. **LAG-BY-DESIGN cards (2026-08-03)** — production / power / rc_out are filed the morning AFTER, so their card is anchored to the stream's latest REPORTED day and carries an `AsOfChip` ("Aug 1") **on the value row** (not beside the label — at 5-up that ellipsised "PRODUCTION") plus a qualifier sub-line ("2 days ago"). The amber treatment (amber rail + amber chip + "N reports due") fires ONLY off `status.missedDays` — WORKING days of outstanding reports — never off "today has no row". An overdue (`stale`) card keeps the alarm (red rail, red "Report overdue" chip, "N working days behind" in the sparkline slot) but now also shows the last real reading + "last reported Jul 29" instead of a blank. The phone tap-detail is a **centered `Dialog`**, not a bottom `Sheet` (short fixed content — see "Dialog vs Sheet" below); `MobileKpiCard` mirrors the same date line ("Aug 1 · 1 report due") at `text-[10px]`, card `min-h-[84px]`. **NET FLOW is anchored to the last COMPLETE day (2026-08-04, Renzo's decision)** — it used to sit on the operational date, where RC In already carries today's deliveries and RC Out (filed the morning after) does not, so the card rendered "everything in, nothing out" as a large positive (it read **+10,695 kg** on 2026-08-03 for exactly that reason). Subtracting a stream that has not spoken yet is not a net flow, it is one side of one. It now anchors to `min(rc_in.through, rc_out.through)` and carries the standard `AsOfChip` **only when that trails the operational date**, so a caught-up day looks unchanged. Verified live 2026-08-04: both streams through Aug 3 → anchor Aug 3, **−21,726 kg** (10,695 in − 32,421 out), delta against Aug 1's +22,038, no chip because nothing is behind. |
| `digest-charts.tsx` | `'use client'` | `flow`, `price`, `grades`, `productionHours` | Recharts, **two stacked sub-rows** (`flex flex-col gap-3`): **Row 1** = Feed In vs Out (`ComposedChart` — no-report / no-delivery days stay **null** so the line never plunges to zero, but the lines **connect smoothly across** them via `connectNulls={true}` for one continuous stroke, not gaps) + RC In price ₱/kg (line — omitted entirely when `price` is empty, which is how price-denied roles see it; the ₱ YAxis uses a **data-driven padded domain** `[min − max(range·0.6, 1.5), max + max(range·0.25, 0.5)]` rounded to whole ₱ so the low floats off the axis floor instead of reading as zero); the row is `lg:grid-cols-2` only when price is shown so a gated flow chart spans full width. **Row 2** = **Production by grade** (stacked bar, pivots long→wide, segments multi-shift grades by `fillOpacity`) paired LEFT with the **`ProductionHoursChart`** RIGHT — a dedicated `lg:grid-cols-2` sub-row so the two production panels are ALWAYS side-by-side regardless of whether the price chart above is present (grade spans full width only when `productionHours` is empty). Stacks single-column on mobile. **REMOVED 2026-08-28:** the `weekPlan` prop and the flow chart's `planByDate` overlay — the faint "planned rest" band and amber "awaiting report" marker were both driven by the retired `production_schedule` plan. Nothing left in the data distinguishes a planned rest from an unfiled report, so the chart no longer claims to; the null-gap + bridging stroke never depended on the plan and are unchanged. |
| `production-hours-chart.tsx` | `'use client'` | `productionHours` | **Work & downtime hours** as a **stacked bar chart** (sibling to the Production-by-grade chart it pairs beside — same recharts + `ChartCard`-style chrome: `ResponsiveContainer`/`BarChart`, `CartesianGrid`, `AXIS_TICK` axes, `tooltipChrome`, `maxBarSize={28}`, `isAnimationActive={false}`). One stacked bar per day over the last 14 days (`GRADE_DAYS` window, ascending → same left→right day order as the grade chart), X = MM-DD date, Y = hours. **Stack: `workHrs` is the base segment (calm `var(--chart-1)`, matching the grade chart's base hue); `downtimeHrs` stacks ON TOP** in a contrasting amber warning cap (`var(--chart-4)`) with the rounded top corners, so the small downtime reads as a distinct cap on the ~12-hr work bar. Legend "Work hrs" / "Downtime"; tooltip shows both values in hrs. Digest card chrome (`rounded-xl border bg-card/95 backdrop-blur hover-lift`), title "Work & downtime hours", subtitle "last 14 days · hrs". No totals footer (the bars convey it). Renders `null` when `productionHours` is empty. No ₱ → no gating. Shared chart chrome intentionally duplicates `digest-charts.tsx` so the two panels read as siblings. |
| `trucks-summary.tsx` | `'use client'` | `trucks` | Excel-Standard dense table of trucks that logged a trip (`ttl_km > 0`) on the operational date, busiest first. Renders `null` on a no-movement day. A truck's `remarks`, when present, are revealed by tapping the underlined plate — a **tap-native `Popover`** (not a hover-only `Tooltip`) so touch users can read them too. |
| `bag-inventory.tsx` | Server | `fleconBags` | Dense **Excel-Standard stock summary table** — one row per FLECON bag type, `sort_order` ascending (the workbook's C→P sheet-column order = the operator's mental model; NEVER re-sorted). Columns: **Bag type · Opening · In · Out · Balance · Last move** — i.e. the movement workbook's `Forwarded Balance → movements → Current Balance` collapsed to one row per type. Replaced the old `flex-wrap` chip group, which showed ONLY `balance` and threw away the other four fields the adapter already supplies. Numeric vocabulary is borrowed verbatim from the full ledger (`flecon-bags-view.tsx`) so the band and the page read as one product: `fmtInt` **blank-for-zero** (Excel blanks-are-zero) on Opening/In/Out, emerald `In`, red `Out` rendered with the REAL minus glyph `−` (U+2212) over the view's POSITIVE `total_out` magnitude, `Balance` emphasized (`font-semibold`, red when negative). `Last move` is `MM-dd` via date-fns `parseISO`+`format` (parseISO, never `new Date()`, so a date-only string can't drift a day), em-dash when the type has never moved. Zero-balance rows keep their POSITION (row-order stability matters to spreadsheet users) but render dimmed. Card header links to `/inventory/flecon-bags` ("Full ledger →"). **No per-row animation** (CLAUDE.md forbids animating table rows — the old `stagger-fast` was removed); card keeps `animate-fade-up`, rows get `transition-all duration-150` hover only. Card carries `min-w-0` so the table scrolls INSIDE its card instead of widening the page. No aggregation, no totals row (summing different bag capacities is meaningless). No price data. Renders `null` when no bag types. |
| `sync-needs-you.tsx` | **Server (async)** | — (reads `getSyncNeedsYou()`) | The **"N need you"** chip beside the sync band's heading, linking to `/sync/cases?run=<latest run id>`. It is the Run Sync panel's OWN count, not a second one: `app/(app)/sync/needs-you.ts::getSyncNeedsYou()` runs the same `flattenRunFindings` → `countDecisionsNeedingYou` (`lib/sync/decision-cards.ts`) over the same `sync_finding_acks` ledger the panel filters with, so the badge can never claim a number the screen it points at disagrees with. **Renders `null`** at zero, for a non-privileged reader (the role gate is server-side, so their browser never receives the markup) and on ANY failure — a badge is a nudge, and a missing nudge costs a click while a fabricated one sends someone hunting for work that is not there. Wrapped in its own `<Suspense fallback={null}>` in `app/(app)/page.tsx` so the extra `sync_runs` read never delays the band. Not part of `DigestData` and not fetched by `getDigestData()`: this is a Sync-module read that the digest merely hosts. No ₱. |
| `sync-summary.tsx` | Server | `latestSync` | Compact header: "{date} · {n} new · {n} updated (· {n} removed)" + per-employee count chips (`byEmployee`). Owns the `employeeLabel()` key→friendly-name map. |
| `activity-feed.tsx` | `'use client'` | `activity` | The changelog: up to ~40 recent `ActivityItem`s — op pill (INSERT/UPDATE/DELETE) + relative time + employee + provenance + table + note + diff chips. NOT animated per-row (single container fade). |
| `digest-footer-band.tsx` | Server | `flags`, `monthToDate` (+ `meta.streams` for freshness) | 3-col final band: Flags (severity chips), Stream freshness (dense table), Month-to-date card. |
| `digest-auto-refresh.tsx` | `'use client'` | — (side-effect only) | Renders `null`. Subscribes ONCE to Supabase Realtime on `public.sync_runs` (INSERT + UPDATE, no filter) and calls `router.refresh()` when a changed row reaches a TERMINAL status (`isTerminalRunStatus`, `@/app/(app)/sync/types`) — re-running the digest RSC (`getDigestData()`) and patching the DOM in place so the board never shows stale pre-sync numbers (critical on the installed PWA). Idempotent via a `useRef(Set<runId>)` (Realtime UPDATE `payload.old` carries only the PK, so the previous status is unreadable — the Set is how repeat UPDATEs for one run don't re-refresh), + an ~800ms debounce that coalesces the queued→running→terminal burst / near-simultaneous report finishes into ONE refresh. No polling and no mount-time catch-up (Realtime fires only for post-subscribe changes → an already-terminal run at load never triggers a refresh-loop). Mounted once by `app/(app)/page.tsx` (digest branch only). |

## Operational-day states (the "misleading zero" fix, now LIVE)
The digest resolves each stream/day to ONE of four states so a bare `0` carries
meaning: **`reported`** (real value → number + delta), **`awaiting`** (a same-day
stream has no row yet → amber), **`stale`** (stream overdue → red), **`idle`**
(rc_in procurement, not shift-bound → neutral). This was promoted from a draft
proposal (`components/digest/draft/` + `app/(app)/dashboard-draft/`, both now
deleted) into the real bands, fed by REAL data.

> **`rest` was REMOVED on 2026-08-28** with the production plan, and the ghosted
> `projectedTons` on an `awaiting` card with it. `rest` was the ONE state that
> could not be resolved from activity — only `production_schedule` knew a quiet
> Sunday was a *planned* rest rather than a missing report. Inferring it from "no
> rows today" would have been a guess dressed as a fact, so a quiet day now reads
> `idle`/`reported` like any other. See `_archived/prod-schedule-v1/`.

### Lag-by-design streams (2026-08-03) — read this before touching the KPI states
**Most streams are reported a day BEHIND, and that is not a fault.** MC's Daily
Production Report (production + electricity + trucks) and the PROPOSED DAILY
REPORT (rc_out) both describe YESTERDAY. Keying those cards to the operational
date made PRODUCTION and POWER read "Awaiting report" every working day and only
fill in retroactively — a sync that landed 14,296 kg for 08-01 left the board
looking untouched on 08-03. **RC In is the exception:** procurement is weighed and
recorded same-day, so it keeps the operational date and its `idle` state.

The classification is a DB fact, not a hardcoded UI list:
`view_digest_stream_registry.reports_next_day`. The rules:

- A lag-by-design card is anchored to the stream's **latest reported day**
  (`through_date`, from SQL) and always renders that date. Its delta compares
  against `prev_reported_date`, not against `prevOperationalDate` — otherwise
  Aug 1 would be compared to Aug 1 and read a flat 0%.
- **"Older than expected" is `missedDays`** = WORKING days strictly between
  `through_date` and the operational date. The operational date itself is
  excluded, so today's not-yet-due report is never late. Counted in SQL
  (`view_digest_stream_status.missed_working_days`). **Its definition changed
  underneath us on 2026-08-28** — a working day used to mean
  `production_schedule.shifts > 0`; with the plan retired, SQL derives it from
  days on which another stream reported. Same column, same contract up here: this
  layer only branches on the number. Back-tested over 239 days x 5 streams:
  **1,188 of 1,195 stream-days keep the identical verdict** (six new fires, each
  a rest day the plant demonstrably worked while that stream stayed silent; one
  lost), so the ladder below is unchanged in meaning and marginally more
  sensitive. **Known blind spot:** a day on which NO stream reported cannot be
  known to have been a working day, so a total plant-wide outage now reads as a
  holiday and raises nothing. Structural — with the plan retired nothing records
  INTENT to run — and not fixable at this layer, which sees only the scalars SQL
  hands it. Guessing intent from absence is precisely what `rest` was removed
  for.
- **The ladder:** `0` → calm `reported`, dated. `1` → still `reported` (the real
  number leads) with an amber rail/chip and "1 report due". `>= 2` → `stale`,
  red, "Report overdue" + the last reading + "N working days behind".
- **`awaiting` is deliberately NOT emitted for lag-by-design streams.** "Today
  has no row" is their steady state, so `awaiting` could otherwise occupy the
  entire working day — the exact bug. It stays live for same-day streams.
- The same `missedDays` measure drives `StreamFreshness.status` and the
  `stale_stream` flag, so the footer and the hero can never disagree.

| File | Client? | Role |
|------|---------|------|
| `lib/digest/day-status.ts` | pure | The state resolvers — `resolveKpiDayStatus()` → `reported`/`awaiting`/`stale`/`idle` (rc_in = procurement → `idle`, not late; net_flow stays neutral) + `resolveKpiAnchorDate()` / `resolveKpiPrevDate()` / `streamForKpi()` (which DAY a card's number belongs to). Exports the `LATE_AFTER_MISSED_DAYS` (1) / `OVERDUE_AFTER_MISSED_DAYS` (2) thresholds. **REMOVED 2026-08-28** with the production plan: the `rest` state, the `plan` argument, the `ProdSchedDay` / `PlannedShifts` types, and `ScheduleRowState` / `resolveScheduleRowState()`. **Where the logic lives:** every ROW-SET fact (latest/previous reported day, missed-working-day count) is computed in SQL; this module only BRANCHES over those scalars. Do not reintroduce a TS scan of the daily series to find "the latest day with data". **DERIVED cards (2026-08-04):** `DERIVED_KPI_INPUTS` maps a card to the streams it is computed from (`net_flow` → `rc_in` + `rc_out`), and `resolveCompleteThroughDate()` / `resolveCompletePrevDate()` anchor it to the last day **all** of them reported — the MINIMUM of their `through_date`s, valid because `through_date` is a high-water mark, so the earliest one is the latest date none of them can still change. The previous comparison day is the BINDING (furthest-behind) stream's `prevReportedDate`, not one calendar day back, which would land on a rest day half the time. |

The live adapter (`getDigestData()`) computes per-KPI `dayStatus` server-side from
the stream-status view alone; the state-aware `kpi-hero` consumes it. Price gating
is inherited from `getDigestData()`; none of these bands surface ₱.

It used to also compute `plantStatus`, the 7-day `weekPlan` and the 10-day
`schedulePreview` from the `production_schedule` table joined with
`view_digest_prod_actual_tons`. All three left the contract on 2026-08-28, and
wave 2 of the adapter is two queries lighter as a result.

## Mobile / responsive
Responsive pass over the existing design system — **desktop (`sm`+/`lg`+) output is
unchanged**; phone behavior is layered below via additive classes + a few small
mobile components. Heavy widgets **condense on phones and tap-to-expand** into either
a centered `Dialog` or a bottom `Sheet` — see the rule below. Per-band:
- **`kpi-hero.tsx`** — `sm`+ full-card grid unchanged; phones get a condensed 2-up
  `MobileKpiCard` grid, tap → centered `Dialog` with the full `KpiCard`/`StateCard`.
- **`digest-charts.tsx`** — `ChartCard` has a phone-only expand button
  (`sm:hidden`) → same chart taller in a centered `Dialog` (the `children` element is
  reused in both spots; the modal chart mounts only while open). The `Maximize2`
  trigger is `size-9` with `-m-1` compensation (≥44px tap target that doesn't bulk
  the header row).
- **`open-blocks.tsx`** — cards already stack 1-up; the shared `BlockingDetailPanel`
  is now `w-full sm:w-[520px]` (full-width on phones).
- **`trucks-summary` / `bag-inventory` / `sync-summary` / `activity-feed` /
  `digest-footer-band`** — responsive-only (already `table-fixed w-full` /
  `flex-wrap` / stacking grids); no condense/expand needed. (`trucks-summary`
  remarks use a tap-native `Popover`, not a hover-only `Tooltip`, so touch users
  can read them.) `bag-inventory`'s 6-column table is narrow enough
  (`min-w-[592px]`) to sideways-scroll inside its own card on a phone — no
  separate mobile component, unlike the 14-column full ledger.
See `app/(app)/CONTEXT.md` → "Mobile / responsive" for the page-shell details and
the `prefers-reduced-motion` guard added to `globals.css`.

### Dialog vs Sheet (tap-to-expand surfaces)
**Short, fixed-height content → centered `Dialog`. Tall, scrolling content → bottom
`Sheet`.** A `side="bottom"` sheet is `h-auto` anchored to `bottom-0`, so short
content renders as a thin bar pinned to the bottom under a large dimmed void.
- **`Dialog`:** `kpi-hero`'s KPI tap-detail (one card), `digest-charts`' `ChartCard`
  expand (one chart). Both triggers are already `sm:hidden`, so the swap is
  unconditional per component — **no `useMediaQuery`**.
- **`Sheet` (keep):** the `MobileCardList` detail sheets — tall scrolling content,
  where the bottom-sheet drag affordance is correct.

### Table min-widths ("never crush, always scroll")
Per `CLAUDE.md` → UI Design System. Every dense digest table declares a min-width =
its fixed-column sum + a floor for the flexible column, inside `overflow-x-auto`:
`trucks-summary` `min-w-[320px]` (200 + 120
plate floor); `digest-footer-band`'s `StreamTable` `min-w-[300px]` (162 + 138 stream
floor); `bag-inventory` **`min-w-[604px]`** (`MIN_W`, = 424px of fixed numeric
columns + a **180px floor for the flexible Bag type column** — the one column with
no explicit width, therefore the one that would crush). Each of these tables ALSO
needs its card to carry `min-w-0`, or the flex/grid parent sizes to the table's
min-content and the PAGE scrolls sideways on tablet portrait instead of the table
scrolling inside its own card (commits `9471122` / `5d92772`).

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
  `stagger-children` on the KPI grid; `stagger-fast` on the small open-blocks
  card group (allowed — ≤ a handful, NOT the 100+-instance table case; it was
  REMOVED from `bag-inventory` when that band became a TABLE — table rows are
  never animated);
  the open-block volume bar grows from the left via `animate-status-grow`
  (`transform: scaleX`, `origin-left` — never animates width). The activity feed is
  a single container fade with per-row `transition-colors` hover only.
- **Recharts** with `isAnimationActive={false}` on sparklines; theme-token colors
  (`var(--chart-1..5)`) for dark-mode safety.
- **Focus never scrolls (2026-08-05).** `HTMLElement.focus()` is specified to scroll its
  target into view with block AND inline **`"center"`** through every scrolling ancestor,
  and `"center"` always computes a target — so it fires even when the element is already
  fully visible, re-centring the row and dragging the whole page. **A `.focus()` on a grid
  wrapper or cell without `{ preventScroll: true }` is a bug** — see "Focus must never
  scroll" in `components/shared/grid/CONTEXT.md`. (The digest's own editable grid, the
  schedule month grid, was where this was found; it was retired on 2026-08-28, but the
  rule outlives it and the shared `EditInput` is guarded.)
  - Note for anyone adding sticky frozen columns to a digest table: that forces
    `border-collapse: separate`, and in the separated-borders model the CSS spec paints
    borders on table CELLS ONLY — every `<tr>`/`<tbody>`/`<col>` border goes inert in the
    same instant. Move them onto the cells with a `[&>*]:border-b
    [&>*]:border-b-<side-specific-colour>` child variant, never back onto the `<tr>`, and
    never "fix" it by flipping to `collapse` (that makes a sticky column lose its edges).

## Dependencies
- `lib/digest/queries.ts` / `lib/digest/types.ts` — the data contract (do not edit lightly).
- `recharts` — sparklines (kpi-hero) + the three charts (digest-charts).
- `@/lib/utils` (`cn`), `@/components/ui/tooltip` (shadcn), `lucide-react` (flag icons).
- `app/globals.css` — `--chart-1..5`, `--popover`, motion utilities, glass classes.
- **REMOVED 2026-08-28** — the three tenant-layer plan-module imports (`@/lib/production/setup-projection`, `@/app/(app)/production/schedule/actions`, `@/app/(app)/production/setups/actions` + `@/components/production/setup-form-dialog`). They were the ONLY place a digest band reached into a domain module's write path, and they went with the schedule editor. No band imports from `app/(app)/production/` any more.
- **Sync band only** (`sync-needs-you.tsx` — the one band that reaches into the Sync module):
  - `@/app/(app)/sync/needs-you` (`getSyncNeedsYou`) → `lib/sync/findings.ts` + `lib/sync/decision-cards.ts`. The count is the Run Sync panel's, computed once, in one place. Never re-derive "how many findings need a human" here.

## See Also
- [Home Daily Sync Digest](../../app/(app)/CONTEXT.md) — the page shell + full `DigestData` contract and per-band data notes.
- [Production module](<../../app/(app)/production/CONTEXT.md>) — the Daily · Electricity · Trucks tabs and the human-edit latch.
- `_archived/prod-schedule-v1/README.md` — the retired production plan: the month grid, the week strip, the 10-day preview, the setup library and their DB objects.
- [Sync module](<../../app/(app)/sync/CONTEXT.md>) — the decision cards, the acknowledgement ledger and `getSyncNeedsYou()` behind the "N need you" chip.
- `CLAUDE.md` → **Home Digest** — render-order table and price-gating rule.
- `_archived/dashboard-v1/README.md` — the previous widget dashboard these bands replaced.
