# Bug Ledger

> Persistent, structured bug ledger. Each entry is written to be executed **cold by a
> future Opus session** — root cause with file:line evidence, an exact fix spec, effort,
> and risks. Investigated read-only on 2026-07-17 (2× Sonnet agents, on-device iPhone
> screenshots from Renzo as the trigger). **No fix below has been executed yet** unless
> its Status says so. Update Status + add a dated note when a fix ships.
>
> House rules that bind every fix here: additive-only for mobile (`hidden sm:block` /
> `sm:hidden`), desktop never regresses; `errorToast()` for errors; aggregations live in
> SQL, never TS; CONTEXT.md updated in the same changeset.

---

## The design rule these bugs share: **"Never crush, always scroll"**

> A dense data table/grid must never compress cell content below its intrinsic minimum.
> Give every `table-fixed` table (and every CSS grid of data cells) an explicit
> **min-width equal to the sum of its column minimums**, wrap it in `overflow-x-auto`,
> and let the wrapper scroll horizontally when the viewport is narrower. **Never rely on
> a bare `w-full` + one `w-auto`/unset/`minmax(0,1fr)` column to absorb leftover space —
> that column is the one that silently crushes.** Fill when roomy, scroll when tight.

Correct reference implementations already in-repo: `rc-movement-matrix.tsx`
(`width:'max-content'` + full colgroup) and `flecon-bags-view.tsx` (computed
`minWidth = W_DATE + W_PARTICULAR + n×MIN_BAG_W`).

**When BUG-001/BUG-004 ship, add this rule to CLAUDE.md's UI Design System section.**

---

## BUG-001 — Schedule full-table sheet: Setup/Grades column crushed to ~20px
**Status:** OPEN · **Effort:** S · **Severity:** high (flagship digest surface on phone)

- **Symptom (iPhone):** in the "Production schedule · next 10 days" bottom sheet, the
  Setup/Grades column renders ~1 character wide.
- **Root cause (confirmed):** `components/digest/schedule-preview-mobile.tsx:77` passes
  `minWidthClass="min-w-[640px]"` to `ScheduleTable`. Fixed columns in
  `components/digest/schedule-table.tsx:11-21` sum to **620px**; `setup` is the lone
  `w-auto` column. Under `table-fixed`, table resolves to max(container, 640) and Setup
  gets the leftover: **640 − 620 = 20px**. Exact math, not a rendering quirk.
- **Fix spec:** raise to `min-w-[820px]` (620 + ~200px floor for setup label + grade-tons
  line) in `schedule-preview-mobile.tsx:77`. Also pass an explicit `minWidthClass` from
  the desktop caller `components/digest/schedule-preview.tsx:49` (currently omits it —
  works by ambient luck, not contract).
- **Also fix (same rule, violator audit):**
  | File:line | Crushing column | Fixed sum |
  |---|---|---|
  | `components/digest/digest-footer-band.tsx:76,79` | `w-auto` Stream | 162px |
  | `components/digest/trucks-summary.tsx:41,44` | `w-auto` Plate | 200px |
  | `components/sync/cases/RunGroupedList.tsx:229-234` | unset 3rd `<col>` | 240px |
  | `components/sync/cases/SourceDiffCard.tsx:153-162` | Provenance `<th>` | 130+92+84+120(+104) |
  | `components/sync/cases/FindingDetailCards.tsx:175-181` (+`:303`) | Where `<th>` | 330px |
  | `app/(app)/production/electricity/electricity-grid.tsx:515` | ALL cols compress (no min-width) | 688px |
  For each: add a table-level min-width = fixed sum + a sane floor for the flexible
  column, inside an `overflow-x-auto` wrapper. (Electricity's mobile answer is already
  the card view; the min-width protects the `sm`+ table.)

## BUG-002 — Digest detail bottom-sheets hug the bottom on short content
**Status:** OPEN · **Effort:** S · **Severity:** medium (UX polish, daily-use surface)

- **Symptom (iPhone):** tapping a KPI card or chart-expand opens a bottom Sheet whose
  content is short (one card / one chart) — it sits as a small bar pinned to the bottom
  with a huge dimmed void above. Renzo: make these **centered modals** on mobile.
- **Root cause (confirmed):** `components/ui/sheet.tsx:56-57` — `side="bottom"` is
  `h-auto` anchored `bottom-0`; callers only cap (`max-h-[85/90dvh]`), never set a min.
  Call sites: `components/digest/kpi-hero.tsx:411-414`, `digest-charts.tsx:118-120`.
- **Fix spec:** swap Sheet → centered `Dialog` in exactly those two spots (the KPI
  mobile-detail sheet ~`kpi-hero.tsx:397-444` and ChartCard's expand ~`digest-charts.tsx:76-131`).
  Both triggers are already `sm:hidden`, so the swap is unconditional per component — no
  `useMediaQuery` needed. Copy the header pattern from `SyncLauncher.tsx`'s dual-surface
  precedent. **KEEP bottom sheets** for tall/scrolling content (schedule full table,
  MobileCardList details) — the rule is: short fixed content → Dialog; long scrolling
  content → Sheet.

## BUG-003 — Production Schedule renders inside the production tab shell
**Status:** OPEN · **Effort:** M (primary) / S (fallback) · **Severity:** medium (IA/UX)

- **Symptom:** `/production/schedule` shows the Daily·Electricity·Trucks bottom tab bar
  under a page that isn't one of those tabs. Renzo wants the schedule to live in the
  **digest world**: a view toggle on `/` — digest board ↔ production schedule — same
  concept as the app's other URL-driven view switchers.
- **Root cause (confirmed):** `app/(app)/production/layout.tsx` unconditionally wraps all
  of `production/**` (tab provider + PeriodPicker header + `ProductionSheetTabs` footer);
  `schedule/` inherits it with no opt-out.
- **Fix spec (PRIMARY — matches Renzo's ask):** `/` gains `?view=digest|schedule`
  (house pattern: `summaries-client.tsx` `?view=period|supplier`). Extract the schedule
  table from `app/(app)/production/schedule/page.tsx` into a reusable server component;
  `/` renders digest bands or the schedule view per the param (client shell mirrors
  `SummariesShell`). Keep `/production/schedule` as redirect (or deep-link alias).
  Re-point 3 hrefs: `app/(app)/page.tsx:72`, `components/digest/schedule-preview.tsx:40`,
  `components/navbar.tsx:64` (breadcrumb entry — suppress/adjust title for `view=schedule`).
- **Fallback (S):** route-group escape — move `layout.tsx` + `daily/ electricity/ trucks/`
  (+ `production/page.tsx`'s ProductionView) into `app/(app)/production/(tabs)/`;
  `schedule/` stays outside the group, URL unchanged, tab bar gone. Doesn't achieve the
  digest-toggle end-state; use only if (b) is too much scope in the moment.

## BUG-004 — Blocking grid on iPhone landscape: crushed cells, no horizontal scroll
**Status:** OPEN · **Effort:** S · **Severity:** medium

- **Symptom (iPhone landscape):** blocking cells clipped/"sides cut", grid won't h-scroll.
- **Root cause (confirmed):** at ≥640px (landscape iPhone qualifies),
  `app/globals.css:505-509` switches `.blocking-grid-cols` to `minmax(0,1fr)` — no floor,
  grid always fits its box, wrapper `overflow-x-auto` inert, 20 columns crush; each
  `.blocking-cell` is `overflow:hidden` (`globals.css:398-405`) so content clips → reads
  as "sides cut". **NOT a notch/safe-area issue** (verified: `viewport-fit=cover` is
  deliberately absent, so the layout viewport already excludes unsafe areas).
- **Fix spec:** `app/globals.css:507` → `minmax(104px, 1fr)` (reuse the tuned 104px floor
  from the <640px block). Fill when roomy (wide desktop unchanged in practice), scroll
  when tight — the BUG-001 rule applied to CSS grid.
- **Edge case to verify after:** `blocking-grid.tsx:958` caps PCA/PCB (3-col) sections at
  `max-w-[280px]`; 20+3×104=332px min now exceeds it → short internal scroll inside that
  box. Visual-check both warehouse types at landscape width.

## BUG-005 — Duplicate campaign: "Jul 2026" AND "July 2026" in the RC Movement picker
**Status:** OPEN · **Effort:** S–M · **Severity:** high (data canonicalization — will
recur monthly and pollute campaign-keyed views/URLs until fixed)

- **Symptom:** campaign picker lists `Jul 2026 8d` and `July 2026 6d` as two campaigns.
- **Root cause (confirmed, SQL-verified):** `rc_out.production_batch` holds BOTH
  `JUL` (28 rows, 2026-07-07→07-15) and `JULY` (137 rows, 2025-06-28→2026-07-06). Also a
  stray `APR` (1 row, 2026-04-30) vs `APRIL` (208). Two writers, two conventions:
  - `workers/sync/src/reports/rc_out/extract.ts:332-336` (PROPOSED report extractor)
    derives the batch from `MONTH_ABBR_B` (3-letter) with full-name overrides ONLY for
    May/June (a ported quirk of `extract_proposed_daily.py:292-300`) → emits `JUL`.
  - `workers/sync/src/reports/gsheet/extract.ts:341` reads the Sheet cell literally →
    historically full names (`JULY`).
  `encodeCampaign()` (`app/(app)/inventory/rc-movement/actions.ts:128-137`) keys on the
  raw string → `JUL-2026` ≠ `JULY-2026` → two picker entries.
- **Fix spec (layered, in order):**
  1. **Writer canonicalization (the real fix):** in `rc_out/extract.ts:332-336`, replace
     the abbreviation array with full month names (extend the May/June override to all 12) —
     ideally ONE shared month-name normalizer used by both extractors so they structurally
     can't diverge. Mirror the fix in the Python oracle (`extract_proposed_daily.py:292-300`)
     if still live. Note: this file is documented as a line-for-line Python port — note the
     deviation in `workers/sync/specs/PORTING_DECISIONS.md`.
  2. **Data repair (run AFTER the writer fix ships, via supabase-backend-engineer):**
     `UPDATE rc_out SET production_batch='JULY' WHERE production_batch='JUL';`
     `UPDATE rc_out SET production_batch='APRIL' WHERE production_batch='APR';`
     Risk: any shared `?campaign=JUL-2026` URL silently falls back to default (acceptable —
     bug is days old).
  3. **Optional view hardening:** month-name CASE normalization in
     `view_rc_movement_campaign_options` + siblings (defensive band-aid; writer fix is primary).
- **Scoping note:** this is a **canonicalization bug**, not a source disagreement — it
  does NOT route through Sync Review arbitration. Both witnesses agree on the fact; one
  writer fails to normalize its spelling. Left unfixed, gsheet classify
  (`workers/sync/src/reports/gsheet/classify.ts:176-184`) will raise a pointless diff
  case every time the Sheet catches up to a PROPOSED-written month.

---

## Fixed entries

*(move entries here with the shipping commit hash when done)*
