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
| `format.ts` | — (pure) | — | Display-only formatters: `fmtKwh`, `fmtDeltaPct`, `fmtByUnit`, `relativeTime`, `diffValue` (defined here) + `fmtKg`, `fmtPhpNumber` (**re-exported from `@/lib/format-utils`** — DUP-5 single-homed the canonical round-and-group kg/₱ formatters there; digest components still `import … from "./format"` unchanged). **Grade helpers** (`GradeTon` type, `parseGradeTons` — defensive JSONB → `{grade,tons}[]` heaviest-first, drops null/zero; `fmtGradeTons`; `gradeTonsTitle`) shared by `schedule-preview.tsx` AND the full-month `schedule-month-view.tsx`. No aggregation. Client- and server-safe. |
| `shell.ts` | — (pure) | — | `HOME_SHELL_CLS` — the one page-shell container class string shared by `app/(app)/page.tsx` (both `?view=` branches) and `app/(app)/production/schedule/page.tsx`. Its only job is to stop the schedule's two entry points from drifting apart; not a component, no tenant knowledge. |
| `digest-header.tsx` | `'use client'` | `meta` | Sub-band header ("As of {operationalDate}") + glass freshness pill (fresh/recent/stale). Relative sync time ticks every 60 s client-side. |
| `plant-status-header.tsx` | `'use client'` | `plantStatus` (+ `meta`, `fedKg`) | Operational-date status bar: running/rest **beacon** (pulsing when running), planned setup, projected tons, fed kg, last-sync freshness (ticks every 60 s) + a streams-behind note. Renders a neutral "no plan on record" state when `plantStatus` is null. Glass card + `animate-fade-up`. |
| `status-tokens.ts` | — (pure) | — | Shared chip / severity-rail / label class maps per operational-day state (`STATE_CHIP`, `STATE_RAIL`, `STATE_LABEL`, `BEACON_DOT`). emerald/amber/red/muted + violet for the PLAN layer. Consumed by `kpi-hero`, `week-strip`, `plant-status-header`. Client- and server-safe. |
| `open-blocks.tsx` | `'use client'` | `openBlocks` | Compact card grid — one card per currently **IN-USE** block (`status = 'IN-USE'`), `block_loc` ascending: header + "volume left" bar + 7-stat lab mini-grid + optional gated ₱/kg line. **Each card is a clickable, keyboard-accessible control** — activating it calls `fetchBlockDataForBatch(batchId)` (`@/app/(app)/inventory/blocking/actions`) and opens the ESTABLISHED Blocking slide-over **`BlockingDetailPanel`** (`@/app/(app)/inventory/_shared/blocking-detail-panel`, lazy-loaded via `next/dynamic`, `ssr:false`) with the full balance / quality / delivery + usage history. Mirrors the RC Movement matrix's click→fetch→panel pattern; one panel open at a time; `onNavigateToBatch` OMITTED (panel's internal fallback handles "Edit All"). The **embedded per-block deliveries ledger was REMOVED** (it crammed the half-width column) — that data now lives in the slide-over. Card ₱/kg display is INFERRED from whether any `phpKg` is non-null (Production gets all-null → no ₱ renders); the PANEL uses the `canViewPrices` the action returns. Renders `null` when empty. **Surfaced near the top** of the digest (half-width, paired beside `schedule-preview`). |
| `kpi-hero.tsx` | `'use client'` | `kpis`, `dayStatus` | State-aware stat-card grid (rc_in/rc_out/production/power/net_flow). Each card consults `dayStatus[kpi.key]`: **`reported`** → number + delta badge + sparkline (as before; `net_flow` stays neutral "expected drift", never red); **`awaiting`/`rest`/`stale`/`idle`** → a `StateCard` with a state label + left severity rail + chip + ghosted projection and **no sparkline** ("no active series"), replacing the misleading `0`. The phone tap-detail is a **centered `Dialog`**, not a bottom `Sheet` (short fixed content — see "Dialog vs Sheet" below). |
| `digest-charts.tsx` | `'use client'` | `flow`, `price`, `grades`, `productionHours`, `weekPlan` | Recharts, **two stacked sub-rows** (`flex flex-col gap-3`): **Row 1** = Feed In vs Out (rest-day-aware `ComposedChart` — rest / no-report / no-delivery days stay **null** so the line never plunges to zero, but the lines **connect smoothly across** them via `connectNulls={true}` for one continuous stroke, not gaps; a `planByDate` map built from `weekPlan` still adds a faint band on rest days and an amber marker on awaiting days as background context) + RC In price ₱/kg (line — omitted entirely when `price` is empty, which is how price-denied roles see it; the ₱ YAxis uses a **data-driven padded domain** `[min − max(range·0.6, 1.5), max + max(range·0.25, 0.5)]` rounded to whole ₱ so the low floats off the axis floor instead of reading as zero); the row is `lg:grid-cols-2` only when price is shown so a gated flow chart spans full width. **Row 2** = **Production by grade** (stacked bar, pivots long→wide, segments multi-shift grades by `fillOpacity`) paired LEFT with the **`ProductionHoursChart`** RIGHT — a dedicated `lg:grid-cols-2` sub-row so the two production panels are ALWAYS side-by-side regardless of whether the price chart above is present (grade spans full width only when `productionHours` is empty). Stacks single-column on mobile. `ChartCard` gained an optional `legend` slot for the flow chart's custom band swatches. |
| `production-hours-chart.tsx` | `'use client'` | `productionHours` | **Work & downtime hours** as a **stacked bar chart** (sibling to the Production-by-grade chart it pairs beside — same recharts + `ChartCard`-style chrome: `ResponsiveContainer`/`BarChart`, `CartesianGrid`, `AXIS_TICK` axes, `tooltipChrome`, `maxBarSize={28}`, `isAnimationActive={false}`). One stacked bar per day over the last 14 days (`GRADE_DAYS` window, ascending → same left→right day order as the grade chart), X = MM-DD date, Y = hours. **Stack: `workHrs` is the base segment (calm `var(--chart-1)`, matching the grade chart's base hue); `downtimeHrs` stacks ON TOP** in a contrasting amber warning cap (`var(--chart-4)`) with the rounded top corners, so the small downtime reads as a distinct cap on the ~12-hr work bar. Legend "Work hrs" / "Downtime"; tooltip shows both values in hrs. Digest card chrome (`rounded-xl border bg-card/95 backdrop-blur hover-lift`), title "Work & downtime hours", subtitle "last 14 days · hrs". No totals footer (the bars convey it). Renders `null` when `productionHours` is empty. No ₱ → no gating. Shared chart chrome intentionally duplicates `digest-charts.tsx` so the two panels read as siblings. |
| `schedule-preview.tsx` | Server | `schedulePreview`, `schedulePendingConflicts` | Compact Excel-Standard **Production Schedule** band — a rolling **10-day** window (operational date → +9 days), a **half-width card** pairing beside `OpenBlocks` on wide screens (see `app/(app)/CONTEXT.md` snapshot row). Owns only the card chrome + header link, which reads as an ACTION — "Open month plan to edit →" from `sm` up, "Open full month plan →" below `sm` where the month surface is read-only (this link is how most people discover the plan is editable at all); the dense table itself is the shared `ScheduleTable`. **Responsive:** the full table renders inline at `sm`+ (`hidden sm:block`); on phones (`sm:hidden`) `SchedulePreviewMobile` takes over (condensed list + tap-to-expand sheet). **Pending-conflict indicator (Phase B):** optional `pendingConflicts` prop → a quiet amber "N pending upstream change(s)" chip in the header linking to `/?view=schedule`; **0 renders nothing**. The card renders for a non-zero count even when `rows` is empty (tables omitted) so a parked conflict can't sit unread. Renders `null` when both are empty. No ₱ → no gating. |
| `home-view-toggle.tsx` | `'use client'` | — | The `/` **view switcher** — segmented "Digest" \| "Schedule" control writing `?view=digest\|schedule` (house pattern: `useSearchParams` + `router.replace`, NOT nuqs; `Suspense`-wrapped as App Router requires). `digest` is the default so it DROPS the param (and the schedule-only `month` cursor with it). The active `view` arrives as a server-parsed prop → correct highlight on first paint. Phones get full-width 44px segments; `sm`+ is an inline pill. Rendered at the top of BOTH views by `app/(app)/page.tsx`. **Pending UI:** writing the param re-runs the SERVER page (the digest re-queries Supabase, ~1-3s), so `router.replace` is wrapped in `useTransition` and the segment highlight is driven by `useOptimistic(view)` — the target segment goes active on the click's frame and carries a `Loader2` until the payload lands (`aria-busy` on the tablist). Without this the toggle looked dead for seconds and then flipped — the #1 reported no-feedback case. React reverts the optimistic value to the server `view` when the transition settles. Mirrors `app/(app)/cenapro/production/period-picker.tsx`. |
| `schedule-month-view.tsx` | **Server (async)** | — (queries directly) | The full **month plan-vs-actual** schedule — the ex-`/production/schedule` page body, moved into the digest world (BUG-003: it wrongly inherited the production tab shell). Rendered by BOTH entry points — `/` under `?view=schedule` AND the standalone `/production/schedule` route — in the SAME `HOME_SHELL_CLS` container (`shell.ts`), with the same data loading. **Two doors, one surface; no fork.** (BUG-003 was the production TAB SHELL leaking onto the schedule, not the URL; that shell now lives in the `app/(app)/production/(tabs)/` route group which the schedule route sits outside of.) **Domain layer, not the digest adapter** — it queries **`view_production_schedule_state`** (the ownership-aware read model) + **`view_production_schedule_conflicts`** + `view_digest_prod_actual_tons` + `view_digest_daily_hours` DIRECTLY (aggregation still in SQL; the month-total footer is a display sum). It **fetches and shapes only** — rows go to the `'use client'` `ScheduleMonthGrid`, which owns all interaction; the client never touches Supabase. Renders NO page container — the host owns the shell. Props: `month` (`?month=YYYY-MM`, validated; defaults to the operational month), `basePath` + `extraParams` → the prev/next month hrefs (`/` passes `{ view: 'schedule' }`). Also renders the month-nav bar, the 4-swatch owner legend (Joseph / Sheet / You / Actual) and an amber "N pending upstream changes" chip when the month has parked proposals. Phone (`sm:hidden`): `ScheduleCardsMobile`, READ-ONLY, with an honest "read-only on this screen — editable on a tablet or desktop" note (the ONE place editing genuinely does not exist, so the hint names the screen size instead of pointing at a grid that is not rendered). No ₱ → no gating. |
| `schedule-month-grid.tsx` | `'use client'` | — | **The editable month grid (Phase B).** Built on the shared **Blackwood Table** primitives (`GridCell`, `EditInput`, `useGridEditSession`, `useGridKeyboardNav` + `createCoordinateNavResolver`) — no second editing engine. Columns: Date · Day · **Setup** · Grades · **Shifts** · **Proj t** · Act t · Act hrs · Var · Status · **Owner** · **Remarks** · actions; the four bold ones are editable (`SCHEDULE_COLUMN_MAP`), `grades` is READ-ONLY (JSONB, no editor yet). `table-fixed` + explicit px widths summing to `min-w-[1340px]` inside `overflow-x-auto` ("never crush, always scroll"). Edits are staged as per-day **drafts**; each dirty day saves via one `saveScheduleDay` call carrying the `row_version` that row was READ with. **Ownership legibility BEFORE commit:** the Owner chip previews the flip (`Sheet` struck-through → `You?` in sky with a ring), the row gets a sky left rail + tint, and a sticky glass save bar names every day whose ownership is about to move ("Take ownership & save N"). **Editability affordance (2026-07-30):** every editable GridCell carries `cursor-cell` + `EDITABLE_CELL_HOVER_CLS` (`hover:bg-sky-500/10` + `hover:ring-1 hover:ring-inset hover:ring-sky-500/40`, `transition-colors duration-150`) — reusing the house `cursor-cell` idiom and `DatePickerCell`'s tint-on-hover, NOT a per-cell pencil icon (31×4 icons of noise). The hover half is suppressed on the ACTIVE cell so it can never out-specify that cell's `ring-2 ring-primary` selection ring. A leading muted hint line names the four editable columns and the click/type · F2 · Enter · Esc model BEFORE the ownership warning. **Frozen days** (`effective_owner==='actual'`) render plain `<td>`s — no GridCell, no cue, nothing to click — plus a padlock and a "frozen" hint. **Revert:** human-owned, unreported days get a one-click `RotateCcw` → `AlertDialog` → `releaseScheduleDay`. **Conflicts:** an amber marker in the Owner cell opens `ScheduleConflictDialog`. Errors always via `errorToast()` (persistent + Copy), and a failed save's typed values are embedded in the toast because the draft is discarded. Motion: container `animate-fade-up` only; rows never animate (`transition-all duration-150` hover). |
| `schedule-conflict-dialog.tsx` | `'use client'` | — | Arbitration for a day whose upstream change the sync withheld. Renders a **precise field-by-field diff** (Field \| Yours \| Joseph proposes) driven by `view_production_schedule_conflicts.changed_fields` — never two opaque JSON blobs. Two outcomes, the ONLY callers that pass `clear_pending: true`: **Take Joseph's** (`takeUpstreamProposal` — writes his values + clears the pending; the day stays human-owned and the sync's own rule-4 *reclaim* hands ownership back next run because the values now match) and **Keep mine** (`keepMineClearPending` — clears the pending, values untouched). Says out loud when only read-only fields (grades) differ. |
| `schedule-types.ts` | — (pure) | — | The row contract shared by the server view and the client grid: `ScheduleGridRow` (plan + actual + `owner`/`effectiveOwner`/`isReported`/`rowVersion`/`conflict`), `ScheduleConflict`, `ScheduleConflictSide`, `ScheduleEditableField`, `SCHEDULE_COLUMN_MAP` (visual col → editable field; **must stay in lockstep with the grid's `<th>`/`<td>` order**), `scheduleFieldToString`. |
| `schedule-owner.ts` | — (pure) | — | Ownership vocabulary + presentation tokens mirroring the DB CHECK on `production_schedule.owner`: `ScheduleOwner`, `toScheduleOwner` (narrows an untrusted DB string), `OWNER_LABEL` / `OWNER_CHIP` / `OWNER_HINT` (the hover sentence explaining why the row behaves as it does), `isScheduleDayEditable`. Colour idiom follows `status-tokens.ts` — violet Joseph, muted Sheet, **sky** You (amber is already "today/awaiting"), emerald Actual. |
| `schedule-cards-mobile.tsx` | `'use client'` | — | **Phone read layer** (`sm:hidden`) for `schedule-month-view.tsx` — a **full-month** list of the shared `ScheduleRowCard` with the `Act hrs` / `Var` fields the digest preview omits. Fed the month view's SAME `rows` (single source of truth, no refetch). Moved here from `app/(app)/production/schedule/` with the schedule itself. |
| `schedule-table.tsx` | — (client-safe, no `'use client'`) | — | The shared **dense schedule table** extracted from `schedule-preview.tsx` so BOTH the desktop card AND the mobile bottom sheet render identical markup. Columns: Date · Day · **Setup / grades** · Sh · **Total t** · Act t · **Act hrs** · Status · Src. Setup cell stacks per-grade tonnage (`parseGradeTons`/`fmtGradeTons`/`gradeTonsTitle`); today's row accent-tinted, rest days dashed; Status/Src chips as before. **Every body `<tr>` has a fixed `h-[44px]` + `align-top` so rows are UNIFORM height regardless of whether the optional grades sub-line renders** — days without a grade breakdown (and rest days) reserve the same two-line space instead of collapsing to one line (the height fits the setup + grades case with headroom; nothing clips). Props: `rows`, `maxHeightClass` (scroll cap), `minWidthClass` (keeps column widths so the wrapper scrolls sideways instead of crushing). Also exports `fmtTons`. No server-only imports (importable by the client mobile component). |
| `schedule-preview-mobile.tsx` | `'use client'` | `schedulePreview` | **Phone-only** condensed schedule view (`sm:hidden`). A compact stacked list of the nearest **5** days rendered via the shared `ScheduleRowCard` + a **"View full table" bottom `Sheet`** (`side="bottom"`) rendering the full `ScheduleTable` (`min-w-[640px]`, sideways-scroll inside the sheet). The "View full table" trigger is `h-10 px-3` (comfortable tap target). No ₱ → no gating. |
| `schedule-row-card.tsx` | `'use client'` | — | The shared phone schedule `<li>` row (extracted from `schedule-preview-mobile.tsx`) so BOTH the digest preview list AND the full-month `ScheduleCardsMobile` list render identical rows. Props: `ScheduleRowCardData` (date/dow/shifts/setup/gradeTons/projected/actual/state/isToday + **optional** `actualHrs`/`variance`, which the digest preview omits and the month view supplies). No ₱ → no gating. |
| `week-strip.tsx` | Server | `weekPlan` | This-week plan-vs-actual strip — one card per day of the operational date's week: dow + date, setup, a violet planned bar over a chart-1 actual bar, and a state chip (Reported / Today / Planned). Rest days render dashed + "planned rest"; today gets a `ring`. Uses the pre-resolved `WeekDayPlan.state`. Rendered **near the top** of the digest (under the plant-status band); its heading links to `/?view=schedule`. |
| `trucks-summary.tsx` | `'use client'` | `trucks` | Excel-Standard dense table of trucks that logged a trip (`ttl_km > 0`) on the operational date, busiest first. Renders `null` on a no-movement day. A truck's `remarks`, when present, are revealed by tapping the underlined plate — a **tap-native `Popover`** (not a hover-only `Tooltip`) so touch users can read them too. |
| `bag-inventory.tsx` | Server | `fleconBags` | Dense **Excel-Standard stock summary table** — one row per FLECON bag type, `sort_order` ascending (the workbook's C→P sheet-column order = the operator's mental model; NEVER re-sorted). Columns: **Bag type · Opening · In · Out · Balance · Last move** — i.e. the movement workbook's `Forwarded Balance → movements → Current Balance` collapsed to one row per type. Replaced the old `flex-wrap` chip group, which showed ONLY `balance` and threw away the other four fields the adapter already supplies. Numeric vocabulary is borrowed verbatim from the full ledger (`flecon-bags-view.tsx`) so the band and the page read as one product: `fmtInt` **blank-for-zero** (Excel blanks-are-zero) on Opening/In/Out, emerald `In`, red `Out` rendered with the REAL minus glyph `−` (U+2212) over the view's POSITIVE `total_out` magnitude, `Balance` emphasized (`font-semibold`, red when negative). `Last move` is `MM-dd` via date-fns `parseISO`+`format` (parseISO, never `new Date()`, so a date-only string can't drift a day), em-dash when the type has never moved. Zero-balance rows keep their POSITION (row-order stability matters to spreadsheet users) but render dimmed. Card header links to `/inventory/flecon-bags` ("Full ledger →"). **No per-row animation** (CLAUDE.md forbids animating table rows — the old `stagger-fast` was removed); card keeps `animate-fade-up`, rows get `transition-all duration-150` hover only. Card carries `min-w-0` so the table scrolls INSIDE its card instead of widening the page. No aggregation, no totals row (summing different bag capacities is meaningless). No price data. Renders `null` when no bag types. |
| `sync-summary.tsx` | Server | `latestSync` | Compact header: "{date} · {n} new · {n} updated (· {n} removed)" + per-employee count chips (`byEmployee`). Owns the `employeeLabel()` key→friendly-name map. |
| `activity-feed.tsx` | `'use client'` | `activity` | The changelog: up to ~40 recent `ActivityItem`s — op pill (INSERT/UPDATE/DELETE) + relative time + employee + provenance + table + note + diff chips. NOT animated per-row (single container fade). |
| `digest-footer-band.tsx` | Server | `flags`, `monthToDate` (+ `meta.streams` for freshness) | 3-col final band: Flags (severity chips), Stream freshness (dense table), Month-to-date card. |
| `digest-auto-refresh.tsx` | `'use client'` | — (side-effect only) | Renders `null`. Subscribes ONCE to Supabase Realtime on `public.sync_runs` (INSERT + UPDATE, no filter) and calls `router.refresh()` when a changed row reaches a TERMINAL status (`isTerminalRunStatus`, `@/app/(app)/sync/types`) — re-running the digest RSC (`getDigestData()`) and patching the DOM in place so the board never shows stale pre-sync numbers (critical on the installed PWA). Idempotent via a `useRef(Set<runId>)` (Realtime UPDATE `payload.old` carries only the PK, so the previous status is unreadable — the Set is how repeat UPDATEs for one run don't re-refresh), + an ~800ms debounce that coalesces the queued→running→terminal burst / near-simultaneous report finishes into ONE refresh. No polling and no mount-time catch-up (Realtime fires only for post-subscribe changes → an already-terminal run at load never triggers a refresh-loop). Mounted once by `app/(app)/page.tsx` (digest branch only). |

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

## Mobile / responsive
Responsive pass over the existing design system — **desktop (`sm`+/`lg`+) output is
unchanged**; phone behavior is layered below via additive classes + a few small
mobile components. Heavy widgets **condense on phones and tap-to-expand** into either
a centered `Dialog` or a bottom `Sheet` — see the rule below. Per-band:
- **`kpi-hero.tsx`** — `sm`+ full-card grid unchanged; phones get a condensed 2-up
  `MobileKpiCard` grid, tap → centered `Dialog` with the full `KpiCard`/`StateCard`.
- **`week-strip.tsx`** — phones = horizontal snap-scroll strip
  (`min-w-[8.5rem] snap-start` cards); `sm`+ = original grid.
- **`schedule-preview.tsx` / `schedule-table.tsx` / `schedule-preview-mobile.tsx`**
  — desktop table inline; phones = condensed list + full-table bottom sheet.
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
- **`Sheet` (keep):** `schedule-preview-mobile`'s full-table sheet and the
  `MobileCardList` detail sheets — tall scrolling content, where the bottom-sheet
  drag affordance is correct.

### Table min-widths ("never crush, always scroll")
Per `CLAUDE.md` → UI Design System. Every dense digest table declares a min-width =
its fixed-column sum + a floor for the flexible column, inside `overflow-x-auto`:
`schedule-table.tsx` takes a **required-by-convention `minWidthClass`** (620px fixed
+ 200px setup floor → **`min-w-[820px]`**, passed by BOTH the desktop
`schedule-preview.tsx` caller and the mobile sheet — never omitted, since the lone
`w-auto` Setup column is what crushed); `trucks-summary` `min-w-[320px]` (200 + 120
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

## Dependencies
- `lib/digest/queries.ts` / `lib/digest/types.ts` — the data contract (do not edit lightly).
- `recharts` — sparklines (kpi-hero) + the three charts (digest-charts).
- `@/lib/utils` (`cn`), `@/components/ui/tooltip` (shadcn), `lucide-react` (flag icons).
- `app/globals.css` — `--chart-1..5`, `--popover`, motion utilities, glass classes.

## See Also
- [Home Daily Sync Digest](../../app/(app)/CONTEXT.md) — the page shell + full `DigestData` contract and per-band data notes.
- `CLAUDE.md` → **Home Digest** — render-order table and price-gating rule.
- `_archived/dashboard-v1/README.md` — the previous widget dashboard these bands replaced.
