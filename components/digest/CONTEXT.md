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
| `open-blocks.tsx` | `'use client'` | `openBlocks` | Compact card grid — one card per currently **IN-USE** block (`status = 'IN-USE'`), `block_loc` ascending: header + "volume left" bar + 7-stat lab mini-grid + optional gated ₱/kg line. **Each card is a clickable, keyboard-accessible control** — activating it opens the ESTABLISHED Blocking slide-over **`BlockingDetailPanel`** (`@/app/(app)/inventory/_shared/blocking-detail-panel`) **IMMEDIATELY**, on the click frame, and runs `fetchBlockDataForBatch(batchId)` (`@/app/(app)/inventory/blocking/actions`) concurrently — see "**Optimistic drawers**" below; this band is the pattern's REFERENCE IMPLEMENTATION. One panel open at a time; `onNavigateToBatch` OMITTED (panel's internal fallback handles "Edit All"). The **embedded per-block deliveries ledger was REMOVED** (it crammed the half-width column) — that data now lives in the slide-over. Card ₱/kg display is INFERRED from whether any `phpKg` is non-null (Production gets all-null → no ₱ renders); the PANEL uses the `canViewPrices` the action returns. Renders `null` when empty. **Surfaced near the top** of the digest. It used to be the half-width right-hand cell of a two-column snapshot row shared with the retired `schedule-preview`; since 2026-08-28 it spans the full width and the `sm:grid-cols-2` card grid simply gets more room. |
| `kpi-hero.tsx` | `'use client'` | `kpis`, `dayStatus` | State-aware stat-card grid (rc_in/rc_out/production/power/net_flow). Each card consults `dayStatus[kpi.key]`: **`reported`** → number + delta badge + sparkline (as before; `net_flow` stays neutral "expected drift", never red — its inputs' lateness is reported by their OWN cards, and repeating it here would count one missing report as two problems); **`awaiting`/`stale`/`idle`** → a `StateCard` with a state label + left severity rail + chip and **no sparkline** ("no active series"), replacing the misleading `0`. **LAG-BY-DESIGN cards (2026-08-03)** — production / power / rc_out are filed the morning AFTER, so their card is anchored to the stream's latest REPORTED day and carries an `AsOfChip` ("Aug 1") **on the value row** (not beside the label — at 5-up that ellipsised "PRODUCTION") plus a qualifier sub-line ("2 days ago"). The amber treatment (amber rail + amber chip + "N reports due") fires ONLY off `status.missedDays` — WORKING days of outstanding reports — never off "today has no row". An overdue (`stale`) card keeps the alarm (red rail, red "Report overdue" chip, "N working days behind" in the sparkline slot) but now also shows the last real reading + "last reported Jul 29" instead of a blank. The phone tap-detail is a **centered `Dialog`**, not a bottom `Sheet` (short fixed content — see "Dialog vs Sheet" below); `MobileKpiCard` mirrors the same date line ("Aug 1 · 1 report due") at `text-[10px]`, card `min-h-[84px]`. **NET FLOW is anchored to the last COMPLETE day (2026-08-04, Renzo's decision)** — it used to sit on the operational date, where RC In already carries today's deliveries and RC Out (filed the morning after) does not, so the card rendered "everything in, nothing out" as a large positive (it read **+10,695 kg** on 2026-08-03 for exactly that reason). Subtracting a stream that has not spoken yet is not a net flow, it is one side of one. It now anchors to `min(rc_in.through, rc_out.through)` and carries the standard `AsOfChip` **only when that trails the operational date**, so a caught-up day looks unchanged. Verified live 2026-08-04: both streams through Aug 3 → anchor Aug 3, **−21,726 kg** (10,695 in − 32,421 out), delta against Aug 1's +22,038, no chip because nothing is behind. **DRILL-DOWN (2026-08-28): ALL FIVE tiles are clickable**, via `ExpandableTile`, which wraps the EXISTING card in a real `<button>` without touching a pixel of it (pointer cursor, hover ring, focus ring, and a `Maximize2` glyph that fades in on hover/focus — opacity + ring only, so the card's own `hover-lift` keeps running underneath). It began as RC IN alone and rolled out to rc_out / production / net_flow / power in the same idiom. On a phone the condensed grid is unchanged; the tap-detail Dialog's "Open detailed chart" button now fires for every one of the five and CLOSES the KPI dialog first — two stacked Radix dialogs fight over the focus trap. **`DRILLDOWN_KPIS` is a Set, not a per-card boolean, because THREE call sites branch on it**; `openDrilldown(key)` maps a key to its controller's `open`. The five `useDrilldown(...)` calls are NAMED and unconditional rather than built from the `kpis` array — the card list comes from the server, so a data-driven hook count would break the rules of hooks the first time a stream drops out of the payload. **A non-`reported` card is still expandable** (the modal's shortest range is 30 days, and "why is this blank" is when the history is wanted). The net-flow card keeps its "expected drift" tooltip but drops `cursor-help` when wrapped (`KpiCard interactive`) — a help cursor on a real button says the wrong thing. |
| `drilldown/use-drilldown.ts` | `'use client'` (hook) | — | The state machine every drill-down shares: open state, range, data, loading, error, a monotonic **request token** and Retry. `open()` flips the modal open AND starts the fetch in the SAME tick — it never awaits. `data` is cleared before every request so the modal can never flash the previous range under a new title, and `close()` bumps the token so a late reply can't repopulate a shut modal. Returns `modalProps` to spread. Direct port of the optimistic-drawer contract below, drawer → modal. |
| `drilldown/drilldown-modal.tsx` | `'use client'` | — | **The chassis.** A glass Dialog (`DialogContent`'s own base IS the canonical modal glass, so it is inherited not re-declared), near-full on a phone and `sm:max-w-[min(960px,92vw)]` up, `max-h-[88dvh]`, flex column: header (title + description + **range toggle, which lives OUTSIDE the scroll body so it stays usable mid-request**) · scrolling body · optional footer (module link + a caveat note). Owns the OPEN-FIRST contract — `DrilldownChartSkeleton` (chart-shaped, built from the shared `Skeleton` primitive, deterministic bar heights so it can't twitch on a re-render) while loading, then a 150ms `animate-fade-in` on the body — and the persistent, copyable, retryable failure banner (project HARD RULE; an inline banner in place of a toast because the modal is where the user is looking). Also exports the small body pieces every drill-down reuses: `DrilldownStat`, `DrilldownSection`, `DRILLDOWN_AXIS_TICK`, `drilldownTooltipChrome` — deliberately the SAME tokens `digest-charts.tsx` uses, so an expanded chart reads as the big version of the small one. **Entrance is Radix's own `data-[state=open]:animate-in fade-in-0 zoom-in-95`, NOT `animate-modal-enter`** — visually the same fade+scale, but they set the same `animation` shorthand and `.animate-modal-enter` sits OUTSIDE Tailwind's `@layer utilities` in `globals.css`, so it would win the cascade unconditionally and take the `data-[state=closed]` EXIT animation with it (the modal would snap shut). One entrance animation, owned by the primitive. |
| `drilldown/series-parts.tsx` | `'use client'` | — | **The shared body parts**, lifted verbatim from the RC IN reference so the five volume drill-downs have ONE definition each of: the **truncation notice** ("every figure below is a floor" + which module has the complete ledger), the **bar + rolling-mean chart** (`VolumeSeriesChart`), and the **ranked breakdown rail with share bars** (`BreakdownRail`, leader at full strength / rest at 55%). Plus the bucket vocabulary — `bucketNoun`, `rollingLabel` ("7-day avg" / "3-month avg") — and `asOfNote`, the header suffix stating which day a lag-by-design stream's figures run through. **`avgColor` is a PROP, not a constant, and that is load-bearing:** the chart tokens rotate hue between themes, so the mean line must be picked against the bar colour in BOTH — `--chart-4` (yellow in light) reads clearly over `--chart-2` teal bars but all but vanishes over `--chart-1` orange ones, measured in the browser. Callers on `--chart-1` (RC OUT, Production) pass `--chart-3`. RC IN was MIGRATED onto these parts in the same change rather than left as a fifth near-copy; its `RcInPoint.kg` is mapped to `VolumePoint.value` at the call site because the payload is stable and five other fields read `kg`. |
| `drilldown/rc-in-drilldown.tsx` | `'use client'` | — (fetches) | The RC IN body + its wired `RcInDrilldownModal`. Summary strip (total · avg per active bucket · peak · supplier count) · a **bar chart of kg received with a rolling-average line** (7-bucket at day granularity, 3 at month; the mean INCLUDES zero days, which is what makes it an average of the period rather than of the busy days) · a **ranked by-supplier rail** with share bars (chosen over stacked bars — 35 suppliers do not stack legibly), keyed on the CANONICAL supplier (`canonical_supplier()`, applied in SQL — see the adapter notes below) and rendered in the UPPER casing SQL returns, matching RC IN's other supplier surfaces · the last 10 underlying deliveries at Excel-Standard density (`table-fixed`, `px-2 py-1`, `h-8`, `text-xs`, mono right-aligned numerics, `min-w-[590px]` = 410px fixed + a 180px floor for the flexible Supplier column) · "Open RC IN →". **No ₱ anywhere** — the action never selects `cost_basis`, so this surface has nothing to gate and is safe for every role including Production. |
| `drilldown/rc-in-price-drilldown.tsx` | `'use client'` | — (fetches) | The RC In price body + its wired `RcInPriceDrilldownModal`. Summary strip (latest · low/high · mean · biggest swing, where a price RISE is coloured as the ADVERSE direction — this is a purchase price) · a dual-axis chart (₱/kg line on the left, bucket-over-bucket % as bars on the right with a zero `ReferenceLine`) reusing the small card's **padded ₱ domain** so the low never reads as zero · the last 10 buckets in accounting format (₱ pinned left, number right). **`restricted: true` renders an explicit "Price data is restricted for your role" panel**, never an empty chart — the payload genuinely carries no ₱ (gated server-side). At month granularity a footer note names the different market-purchase population (see the adapter). |
| `drilldown/rc-out-drilldown.tsx` | `'use client'` | — (fetches) | The RC OUT body + `RcOutDrilldownModal`. Summary strip (total fed · avg per active day · peak · batch count) · the shared bar+rolling-mean chart in the digest's **"Fed" hue** (`--chart-1`, matching the Feed In vs Out card — an expanded chart must not recolour the series it expands) · a **ranked by-BATCH rail**, never by destination: measured, the window is 93.8% MAIN by row and 94.9% by kg, so a destination rail would draw one bar and say nothing. Each rail row carries the batch's **heaviest block** (`B12 +2` when it was fed from several) and, ONLY when the batch went somewhere other than MAIN, an amber destination badge — the case actually worth seeing. `blockLoc` NULL means `rc_out` stored a BLANK (491 of 1,266 windowed rows), rendered "—" with "Block not recorded" on hover, never an empty string. Recent 10 `rc_out` rows (date · batch · block · dest · weight, `min-w-[570px]`). Header carries the as-of. "Open RC OUT →". **No ₱** — the computed `rc_out_avg_price` / `rc_out_avg_wtd_value` columns are never selected. |
| `drilldown/production-drilldown.tsx` | `'use client'` | — (fetches) | The PRODUCTION body + `ProductionDrilldownModal`. Summary strip (total produced · avg per active day · peak · grades, with the sack total as the grade cell's sub-line) · shared chart (`--chart-1`, the grade chart's base hue) · **ranked by-GRADE rail** with run counts · recent 10 runs (date · shift · grade · weight · sacks, `min-w-[520px]`). **SACKS ARE NULLABLE AND NULL IS NOT ZERO** — 218 of 324 windowed runs record none, so an absent count renders "—" with "Sacks not recorded for this run" on hover and the summary reads "sacks not recorded" in muted tone; a **footer note states the coverage** ("recorded on 106 of 324 runs") whenever it is partial, so nobody totals the column and believes it describes every run. Header carries the as-of (production is filed the morning after — the tile already says "yesterday" and the modal must not quietly undo that). "Open Production →". No ₱. |
| `drilldown/power-drilldown.tsx` | `'use client'` | — (fetches) | The POWER body + `PowerDrilldownModal`. Summary strip (total kWh · avg per active day · peak · meter count) · shared chart (`--chart-3`) · **ranked by-METER rail** · recent 10 `electricity_readings` (date · meter · kWh, `min-w-[400px]`; a null `consumption_kwh` is "—", never a fabricated 0). **A ONE-BAR RAIL IS CORRECT DATA, NOT AN EMPTY STATE** — BUNKHOUSE and PUMP were last reported 2025-12-12, so any 30d/90d window legitimately contains MAIN alone; it renders plainly, with no apology, and the "Meters" stat's tooltip explains the 1. The series is `sum(consumption_kwh)`, the exact column the POWER tile sums, so the modal total always equals the tile. Header carries the as-of. "Open Electricity →". No ₱. |
| `drilldown/flow-drilldown.tsx` | `'use client'` | — (fetches) | **ONE modal, TWO triggers** — the NET FLOW KPI tile and the Feed In vs Out chart card both open `FlowDrilldownModal`, differing by a single `emphasis` prop (`"net"` → the net bars lead, lines ride behind at 0.7 opacity / 1.25px; `"flow"` → the lines lead at 2px and the bars recede to 0.28). They are the same two series and the same arithmetic; two components would be two definitions of "net" and would eventually disagree about a number the whole page is anchored on. **A different chart from the card's:** ONE `ComposedChart`, one shared axis (the net IS the difference of the other two, so a second scale would make a bar and the gap above it mean different things) — net as **sign-coloured bars** over a zero `ReferenceLine`, plus the received/fed lines in the card's own `--chart-2` / `--chart-1`. **The sign fills are `--color-emerald-500` / `--color-red-500`, deliberately NOT `--chart-N`:** a sign is a semantic, not a series identity, and `--chart-5` is red in dark mode but AMBER in light, so a drawdown bar would have read "warning orange" for every light-mode reader. **No breakdown rail** — the breakdown of a net is its two inputs, so the range totals for Received and Fed sit side by side instead, each linking to its own module. Stat strip: net (± with "stock built up / drawn down") · avg net per active bucket (active = either side moved; a bucket where nothing happened is a closed plant, not a zero-net bucket) · biggest surplus · biggest deficit. Recent 10 buckets (date · received · fed · net). Footer carries the **existing** drift wording verbatim from the net-flow KPI tooltip — reused, not re-authored. No ₱. |
| `digest-charts.tsx` | `'use client'` | `flow`, `price`, `grades`, `productionHours` | Recharts, **two stacked sub-rows** (`flex flex-col gap-3`): **Row 1** = Feed In vs Out (`ComposedChart` — no-report / no-delivery days stay **null** so the line never plunges to zero, but the lines **connect smoothly across** them via `connectNulls={true}` for one continuous stroke, not gaps) + RC In price ₱/kg (line — omitted entirely when `price` is empty, which is how price-denied roles see it; the ₱ YAxis uses a **data-driven padded domain** `[min − max(range·0.6, 1.5), max + max(range·0.25, 0.5)]` rounded to whole ₱ so the low floats off the axis floor instead of reading as zero); the row is `lg:grid-cols-2` only when price is shown so a gated flow chart spans full width. **Row 2** = **Production by grade** (stacked bar, pivots long→wide, segments multi-shift grades by `fillOpacity`) paired LEFT with the **`ProductionHoursChart`** RIGHT — a dedicated `lg:grid-cols-2` sub-row so the two production panels are ALWAYS side-by-side regardless of whether the price chart above is present (grade spans full width only when `productionHours` is empty). Stacks single-column on mobile. **REMOVED 2026-08-28:** the `weekPlan` prop and the flow chart's `planByDate` overlay — the faint "planned rest" band and amber "awaiting report" marker were both driven by the retired `production_schedule` plan. Nothing left in the data distinguishes a planned rest from an unfiled report, so the chart no longer claims to; the null-gap + bridging stroke never depended on the plan and are unchanged. **DRILL-DOWN (2026-08-28):** `ChartCard` gained an optional **`onExpand`** prop. When supplied, its header button stops being the phone-only "same chart, bigger" `DialogTrigger` and becomes an ALL-SIZES button calling `onExpand` — and that card's phone `DialogContent` is not rendered at all, so a card never has two expand affordances. **Two cards pass it: RC In price** (`priceDrilldown.open`) and **Feed In vs Out** (`flowDrilldown.open`, opening the SHARED flow modal with `emphasis="flow"`). Both production panels are untouched and keep the phone-only dialog. The flow controller here is a SECOND `useDrilldown(getFlowDrilldown)` instance beside the KPI tile's — deliberately: two independently-opened surfaces must own separate range selections and separate in-flight tokens. The shared thing is the MODAL, not the state. |
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

## Optimistic drawers — open first, load second (2026-08-28)
**A drawer opened by a click must slide out ON THE CLICK FRAME.** `open-blocks`
used to do the opposite on purpose — it awaited `fetchBlockDataForBatch` and only
then set `selected`, so the panel arrived already full ("one clean slide-in, no
empty-panel flash"). The cost was a whole round-trip of dead time on every click,
which reads as a broken button: 99% of the time the expectation is a drawer, so
the drawer is what the click must produce. **The band is now the reference
implementation of the pattern Renzo wants spread through the app.**

The mechanics, all of them worth copying:
- **`selected` flips on the click frame** with `panelBlockData` cleared, so the
  drawer can never flash the previously-opened block's numbers, and the panel's
  opt-in `loading` prop paints a **layout-matched skeleton** (not a lone centered
  spinner) whose section rhythm matches the real panel — see
  `components/shared/detail-drawer-skeleton.tsx`.
- **Skeleton → data is a 150ms `animate-fade-in`** on the panel's four section
  wrappers (opacity-only, reduced-motion safe). React reuses the same DOM nodes
  across the swap, so the content fades in place with no height jump and the
  slide keeps running through it.
- **Failure keeps the drawer OPEN** with a persistent inline banner carrying
  **Copy** + **Retry** (`error` / `onRetry` props). An inline banner with Copy
  satisfies the project's error HARD RULE in place of a toast — the drawer is
  where the user is looking. A silently blank panel is the one outcome the state
  exists to prevent.
- **Race safety is a REQUEST TOKEN, not a batch-id compare.** `requestRef`
  increments per click; a reply whose token is stale is dropped. Keyed on a token
  because re-clicking the SAME block after a failure must also invalidate the
  first attempt — and `handleClose` bumps it too, so a reply that lands after the
  drawer shuts can never repopulate it.
- **The FIRST click pays the chunk download too**, so the panel is loaded with
  `React.lazy` + `Suspense` rather than `next/dynamic`: a `next/dynamic`
  `loading` component receives no props, so it cannot know the drawer should be
  open and would render nothing. The Suspense fallback is the SAME skeleton
  drawer (`DetailDrawerSkeleton`), so a click that beats the chunk still opens
  instantly. The import still starts at hydration (the portal is permanently
  mounted), so this is a guard, not the common path.
- **The card lost its pending affordance** (the old `animate-pulse` + `disabled`
  ring). Feedback now lives in the drawer; a card that also pulsed only competed
  with it, and `disabled` briefly made the just-clicked control unfocusable.

## Drill-downs — "expand this tile" (2026-08-28)

The same open-first contract, applied to a **modal** instead of a slide-over.
`components/digest/drilldown/` is the chassis; a card supplies only a fetcher and
a body. **Adoption is five lines** (the chassis header carries the snippet):
one `useDrilldown(fetcher)`, an `onClick` on the tile, and one wired modal.

**What a drill-down shows — the universal set, prototyped on RC IN and RC In
price:** a range toggle (30d · 90d · This year) · a real chart, bigger and
longer than the card's · a summary stat strip · ONE breakdown dimension · the
last ~10 underlying rows at Excel-Standard density · a link into the owning
module. A **lag-by-design** surface (RC OUT, Production, Power — all filed the
morning after) additionally states its **as-of date in the header**, via
`asOfNote`, for the same reason the KPI tile carries an `AsOfChip`: an axis that
simply ends at the operational date reads as "today" and quietly undoes the
tile's honesty. It joins the description only once the payload lands — the
skeleton cannot know it, and a placeholder date would be worse than a line that
grows by four words.

**Coverage (2026-08-28 rollout).** Every KPI tile and two of the four chart
cards now open one: `rc_in` · `rc_out` · `production` · `net_flow` · `power`
(tiles) and RC In price · Feed In vs Out (cards). **NET FLOW and Feed In vs Out
share ONE modal component** reached from two triggers, differing only by an
`emphasis` prop — see the `flow-drilldown.tsx` row above for why two components
would have been two definitions of "net". The shared body parts live in
`drilldown/series-parts.tsx`; RC IN was migrated onto them in the same change so
nothing is a fifth near-copy.

**The data layer is `app/(app)/drilldown-actions.ts`** — server actions, the
adapter to the chassis's port (`lib/digest/drilldown-types.ts`, which is where
the types live because a `'use server'` module may export nothing but async
functions). Two rules govern it and they pull in opposite directions on purpose:

- **A weighted average is read from SQL, never computed here.** The price
  series is `view_digest_daily_price` (day) / `view_delivery_monthly_analytics.avg_price`
  (month). Those two views describe slightly DIFFERENT market-purchase
  populations, so at month granularity the modal prints a footer note saying
  which one it is showing rather than presenting two definitions as one number.
- **RC IN's kg BUCKETS are a plain SUM, and they are bucketed in TypeScript** —
  because the canonical daily view (`view_digest_daily_flow`) is windowed to
  120 days in SQL and cannot reach "this year", and because **PostgREST
  aggregate functions are DISABLED on this project** (a `weight_kg.sum()`
  select returns `PGRST123`). The rollup REPRODUCES the view's definition
  exactly (`sum(weight_kg) GROUP BY transaction_date` over `deliveries`,
  unfiltered) — the same definition over a wider window, not a second one.
  **Measured 2026-08-28: 90 of 90 days agree, zero mismatches.** If this grows a
  second consumer, promote it to a windowed SQL view rather than copying it.
- **SUPPLIER IDENTITY IS A DEFINITION, SO IT LIVES IN SQL (2026-08-28).** The
  ranking reads **`view_digest_rcin_supplier_daily`** (migration
  `20260828032427`), one row per `(transaction_date, canonical supplier)`,
  grouped by **`public.canonical_supplier(supplier)`** — the ONE definition of
  supplier identity, the same function every Summaries by-supplier view uses.
  Until this landed the rail grouped RAW `deliveries.supplier` strings here, so
  `"Ornales"` (405 rows / 6,132,881 kg) and `"ORNALES"` (22 rows / 325,652 kg,
  June 2026) ranked as two suppliers and the joint-vendor misdeclares
  (`"Mercado / Ornales"`, `"Compra/Paquibot"`, …) folded into nothing —
  measured over YTD 2026 the rail listed **43 entries where there are 35
  suppliers**. Porting those ILIKE clauses into TypeScript was rejected: a
  second definition drifts the first time a spelling is added to the function,
  and the digest would then rank differently from Summaries with nothing to say
  why. The adapter only SUMS the per-day rows up to per-supplier totals — same
  class as the bucketing above; it never inspects a supplier string. The view
  carries **no ₱ column** and none is derivable, so it needs no price gate, and
  it is **not granted to `service_role`** (the worker does not read it —
  L-044's arrow direction; `verify-worker-view-grants.ts` stays at 4 views).
  Its window is a **trailing 400 days**, chosen over a `date_trunc('year')`
  floor because that floor serves only "This year": on 5 January it sits at 25
  December while the 90-day range still reaches back to ~7 October.
- **THE OTHER THREE BREAKDOWN VIEWS (2026-08-28, migration
  `20260828074001`)** — the data layer for the RC OUT, PRODUCTION and POWER
  drill-downs landed ahead of their UI and is now **wired** (`getRcOutDrilldown`
  / `getProductionDrilldown` / `getPowerDrilldown`), in the same idiom as the supplier view
  above (trailing 400-day Manila window, `security_invoker`, `authenticated`
  SELECT only, `anon` revoked, no `service_role` grant, **no ₱ column**, so none
  of them needs a `canViewPrices()` gate):
  - **`view_digest_rcout_batch_daily`** — `(transaction_date, batch_code,
    block_loc, destination)` → `kg`, `feeding_count`. **The rail ranks by BATCH,
    not by `destination`**: measured, the window is 93.8% MAIN by row and 94.9%
    by kg, so a destination rail would print one bar and say nothing.
    `destination` is carried as a column (measured free — 1,255 rows either way)
    so a SUNDRY move is still distinguishable from plant feed. `block_loc` is
    NULL when unrecorded, because `rc_out` stores a BLANK there (491 of 1,266
    windowed rows) and a blank renders as a missing label. **Watch the row
    budget: 1,255 / 400d, 830 for 2026 YTD — this grain runs ~4.2 rows per
    operating day, so a late-in-year "This year" read can reach the 1000-row
    cap. Fold this read into the `truncated` test the same way the supplier read
    already is.**
  - **`view_digest_production_grade_daily`** — `(transaction_date, grade)` →
    `kg`, `run_count`, `shift_count`, `sacks`, `runs_with_sacks`. `sacks` is
    **NULLABLE, never 0-filled** (218 of 324 windowed runs have none) — render
    "not recorded", never "0 bags", and use `runs_with_sacks` to qualify it.
    282 rows / 400d.
  - **`view_digest_power_meter_daily`** — `(reading_date, meter)` → `kwh`,
    `raw_diff_kwh`, `reading_count`. `kwh` is `sum(consumption_kwh)`, the exact
    column the POWER tile sums, so the modal total always equals the tile.
    **A one-bar rail here is correct, not a bug**: BUNKHOUSE and PUMP were last
    reported 2025-12-12, so 30d/90d ranges legitimately show MAIN alone. 545
    rows / 400d.
  - **NET FLOW and Feed In vs Out get NO view** — `getFlowDrilldown` derives
    both as RC IN daily (the supplier view summed per day) minus RC OUT daily
    (the batch view summed per day), and ONE fetcher serves both triggers.
    Measured across the 121-day flow window: in 121/121, out 121/121,
    net 121/121 against `view_digest_daily_flow`. Its `truncated` covers BOTH
    reads, because a net computed from one truncated side and one complete side
    is not a floor — it is actively wrong.
- Every read is explicitly `.limit(ROW_CAP)` and any one hitting it sets
  `truncated`, which the modal renders as "every figure below is a floor"
  (`TruncatedNotice` — one definition, named per surface: deliveries /
  feedings / runs / readings). **RC OUT is the one where the flag genuinely
  bites**: its batch-day grain runs ~4.2 rows per operating day (1,255 / 400d,
  830 for 2026 YTD), so a late-in-year "This year" read can reach the cap. That
  view read is ordered DESC so a capped read keeps the MOST RECENT buckets —
  the right-hand edge of the chart is where the reader is looking, and the
  banner says outright that every figure is a floor.
  **`ROW_CAP` is 1000 because PostgREST's own cap is 1000** (verified live: a
  `?limit=1500` on `deliveries` returns exactly 1000 rows). It was 1500, which
  made the flag INERT — the server truncated first, the read came back short of
  the cap, and a floor would have been reported as a total.
- The **"Recent deliveries" table deliberately shows the RAW STORED spelling**
  of `supplier`, not the canonical name the rail ranks by. Those rows are the
  underlying RECORDS — what someone would open in RC IN — so folding the name
  there would misreport the data. The rail answers "who supplied us"; the table
  answers "what does the row say". Do not "fix" the mismatch.

**Price gating** is the usual boundary: `getRcInPriceDrilldown` resolves
`canViewPrices()` first and returns an EMPTY `restricted: true` payload for a
denied role, which the body renders as an explicit restricted panel.
`getRcInDrilldown` never selects `cost_basis`, so RC IN has no ₱ to gate.

The panel's side of this is **opt-in and default-off** — see
`app/(app)/inventory/_shared/blocking-detail-panel.tsx` (header comment + the
`loading` prop doc) and `app/(app)/inventory/blocking/CONTEXT.md`. Its other four
call sites pass neither `loading` nor `error` and are unchanged.

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
- `components/shared/detail-drawer-skeleton.tsx` — the platform-layer `Skeleton` primitive + the drawer skeleton shell/body behind the optimistic-open pattern above. `open-blocks` uses the whole drawer shell; `drilldown/drilldown-modal.tsx` uses the bare `Skeleton` primitive to build its chart-shaped one.
- `lib/digest/drilldown-types.ts` — the drill-down contract (client- and server-safe; NOT in `types.ts`, which is the digest page payload).
- `app/(app)/drilldown-actions.ts` — the drill-down server actions. The second place a digest band reaches a server action directly (the first is open-blocks → `blocking/actions`).
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
