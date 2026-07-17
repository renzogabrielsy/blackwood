# Bug Ledger

> Persistent, structured bug ledger. Each entry is written to be executed **cold by a
> future Opus session** — root cause with file:line evidence, an exact fix spec, effort,
> and risks. Investigated read-only on 2026-07-17 (2× Sonnet agents, on-device iPhone
> screenshots from Renzo as the trigger). Check each entry's **Status** — update it + add
> a dated note when a fix ships.
>
> **2026-07-17: BUG-001…005 are all ✅ FIXED and shipped.** BUG-006 below is OPEN and
> needs a decision from Renzo (not a bug to just go fix).
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
**Status:** ✅ FIXED (`3fd0d94`, 2026-07-17) · **Effort:** S · **Severity:** high (flagship digest surface on phone)

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
**Status:** ✅ FIXED (`3fd0d94`, 2026-07-17) · **Effort:** S · **Severity:** medium (UX polish, daily-use surface)

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
**Status:** ✅ FIXED (Wave B, 2026-07-17 — PRIMARY approach shipped) · **Effort:** M · **Severity:** medium (IA/UX)

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
**Status:** ✅ FIXED (`3fd0d94`, 2026-07-17) · **Effort:** S · **Severity:** medium

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
**Status:** ✅ FIXED (writer `3fd0d94` + live DB repair, 2026-07-17) · **Effort:** S–M · **Severity:** high (data canonicalization — will
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

## BUG-006 — `rc_out` rows with empty-string / NULL `production_batch` (legacy 2024)
**Status:** ✅ FIXED (live DB backfill, 2026-07-17) — Renzo chose option (b), backfill from
`transaction_date`'s month, conditional on "if it doesn't destroy/modify any modern data"
· **Effort:** S · **Severity:** low

> **Resolution (2026-07-17):** 178 rows backfilled (`UPDATE … SET production_batch =
> UPPER(TO_CHAR(transaction_date,'FMMonth')) WHERE (production_batch IS NULL OR = '')
> AND transaction_date < '2025-01-01'`) — doubly guarded so it could not touch a valued
> or modern row. **Renzo's condition was PROVEN**: a before/after fingerprint of every
> 2025+ campaign value came back byte-identical across all 12 months; blanks now 0; total
> rows conserved 2,057→2,057; rowcount 178 read via a CTE-wrapped `RETURNING` (MCP
> `execute_sql` returns no rowcount for a bare UPDATE — remember this).
>
> ⚠️ **These 178 labels are INFERRED, not recovered.** `production_batch` is a *campaign*
> notion, not a calendar month — campaigns straddle month boundaries. Evidence found
> during the backfill: a pre-existing 2024 row dated **2024-09-30 is labeled OCTOBER**
> (left untouched — it had a value). The blank rows carried no campaign signal, so
> month-from-date was the only available inference. Do not treat the backfilled 2024
> labels as authoritative campaign assignments.
>
> No visible effect today: the picker filters `campaign_year >= 2025`, so 2024 is excluded
> either way. This was hygiene. `rc_out` has no audit trigger (verified: 0 `audit_logs`
> rows) — the pre-flight snapshot in the agent's report is the only recovery reference.

- **Discovered:** 2026-07-17, incidentally, while sweeping for month abbreviations during
  the BUG-005 data repair. Not reported by a user; nothing is visibly broken today.
- **Finding (SQL-verified):** `rc_out.production_batch` has **118 rows = `''`** (empty
  string, 2024-03-01→2024-09-28) and **60 rows = `NULL`** (2024-01-01→2024-06-01). All are
  legacy 2024 rows predating the campaign convention. They are NOT abbreviations, so they
  were deliberately left untouched by the BUG-005 repair (canonicalizing them would have
  been guessing at what campaign they belong to).
- **Why it matters (mildly):** these rows can't key into any campaign
  (`encodeCampaign()` = `${production_batch}-${year}`), so they'd render as a blank/absent
  campaign in the RC Movement picker. The picker already filters `campaign_year >= 2025`,
  so 2024 rows are excluded today — which is why nothing is visibly broken.
- **The decision needed:** are these (a) fine as-is (2024 predates campaigns; leave them),
  (b) worth backfilling from `transaction_date`'s month, or (c) worth a distinct sentinel
  (e.g. `LEGACY`)? **Do not pick one without asking Renzo** — it's a data-semantics call
  about what those 2024 rows *meant*, not a canonicalization with an obviously-right answer.
- **If backfilling is chosen:** the pattern mirrors BUG-005 step 2 (a targeted UPDATE via
  supabase-backend-engineer, `rc_out` has no audit trigger, verify row-count conservation
  before/after).

## BUG-007 — Safe-area gaps left after the edge-to-edge rebuild (known, unfixed)
**Status:** OPEN (known gaps, deliberately deferred) · **Effort:** S each · **Severity:** low

Context: 2026-07-17 we re-enabled `viewport-fit=cover` (required — without it iOS
PILLARBOXES the app in landscape, black bars both sides) and rebuilt safe-area handling
**centrally**: `app/globals.css` defines `.safe-t/.safe-b/.safe-l/.safe-r/.safe-x`
(deliberately UNLAYERED so they outrank Tailwind's cascade layer — a caller's `p-0` would
otherwise silently tw-merge away a `pt-[env(...)]`), and only the shell + shared
primitives apply them. Contract: **backgrounds paint edge-to-edge, content is padded
clear; never re-apply `env()` at a call site — extend the primitive.**

Surfaces still NOT covered (flagged by the implementing agent, not yet hit by a user):
1. **Radix `DropdownMenuContent` / `PopoverContent` / `TooltipContent`** — portalled +
   `fixed`, so they bypass the shell. Radix collision-detection keeps them inside the
   *viewport*, which is NOT the *safe area* → a bottom-anchored dropdown can tuck under
   the home indicator, and a landscape one under the notch. Fix: same treatment as
   `sheet.tsx`/`dialog.tsx` — add insets to those three shared primitives.
2. **Sonner `<Toaster position="bottom-right">`** (`app/layout.tsx`) — uncovered; a toast
   may sit under the home indicator / notch in landscape. NOTE the Error-Toast HARD RULE
   means errors persist until dismissed, so an unreachable Copy button is a real (if
   unlikely) failure. Fix: Sonner accepts offset/style props.
3. **`black-translucent` forces WHITE status-bar text.** Correct over the dark navbar, but
   a full-height left/right Sheet or the blocking detail panel in LIGHT mode puts white
   text over a light `bg-background`. Cosmetic contrast risk inherent to the
   cover+translucent pairing. Fix options: dark scrim behind the status bar on those
   surfaces, or reconsider the pairing.
4. **`dialog.tsx`'s `max-h` clamp is inert** unless the caller sets `overflow-y-auto`
   (most do). Global `overflow-y-auto` was deliberately NOT added — it computes
   `overflow-x: auto` and risks spurious desktop scrollbars (violating "desktop unaffected").

## BUG-008 — App-wide 2-3s "dead click" latency (region + round-trips + no pending UI)
**Status:** ✅ FIXED (2026-07-17) — but see the OPEN follow-ups below · **Severity:** high (felt on every navigation)

- **Symptom (Renzo, on-device):** click the home Digest↔Schedule toggle, or a digest block →
  **2-3s of nothing** (no spinner, no animation), then it flips. App-wide, not one screen.
  His theory: "Supabase calls take a bit — maybe they need spinners."
- **Diagnosis (measured, and his instinct was right for a reason neither of us guessed):**
  1. **Query execution was NEVER the problem** — `EXPLAIN ANALYZE view_blocking_grid` = 104ms.
  2. **The functions were in the wrong hemisphere.** No `vercel.json` existed → per Vercel's
     docs, *"Vercel Functions default to running in the `iad1` (Washington, D.C.) region"* —
     while Supabase is `ap-northeast-1` (Tokyo). Every DB call crossed the Pacific (~180ms).
  3. **~6 SEQUENTIAL round-trips per `/` navigation**: middleware `getUser()` → layout
     `getUser()` → digest wave 1 → `subRes` → `truckRes` → schedule wave. 6 × 180ms ≈ 1.1s
     of pure network before any query ran.
  4. **Zero pending UI** — `home-view-toggle.tsx:54` called `router.replace()` bare; no
     `useTransition`, and no `loading.tsx` on `/`, `/inventory`, `/summaries`, `/sync/cases`.
     12 files wrote the URL with no feedback. So the app *looked* dead during the wait.
- **Fixes shipped:**
  1. `vercel.json` → `"regions": ["hnd1"]` — Tokyo, the **same AWS region as Supabase**
     (`hnd1` == `ap-northeast-1`). Round-trips go ~180ms → single-digit ms. **The big one.**
     Tokyo beats Singapore here: browser→function is paid ONCE, function→DB SIX times.
  2. `lib/digest/queries.ts` — **4 waves → 2.** Waves 2/3/4 (`subRes`, `truckRes`, schedule)
     all genuinely depend on `operationalDate` from wave 1, so they can't join it — but they
     don't depend on *each other*, so they now fire as one `Promise.all`. Also: the schedule
     queries used to run TWICE (7-day week + 10-day preview); the preview range contains the
     week range, so `weekPlan` now slices the preview → **6 queries → 4**, identical rows.
  3. `idx_rc_out_batch_id` (migration `20260717031201`) — the FK was unindexed; the blocking
     view's correlated subquery was Seq Scanning `rc_out` **166 times** (~340k rows). After:
     **exec 33.6→6.96ms, buffers 5,922→445 (13×)**, Seq Scan → Bitmap Index Scan.
  4. `useTransition` + `useOptimistic` on the toggle, summaries switcher, blocking
     `?block=`, and the rc-movement campaign picker → the target goes active **on the click's
     frame**. Plus `loading.tsx` for the 4 uncovered routes.
- ⚠️ **Route-group loading trap (caught during the fix, worth remembering):**
  `app/(app)/loading.tsx` sits at the ROUTE-GROUP level, so every sibling without its own
  loading file INHERITS it — the digest skeleton would have leaked onto `/settings`,
  `/notifications`, `/price-demos`, `/edit/[auditLogId]`. Four containment skeletons were
  added. **Any new route under `(app)` needs its own `loading.tsx` or it renders the digest
  shape.** Documented in `app/(app)/CONTEXT.md`.

## BUG-009 — `view_digest_operational_days` recomputed 10+ times per digest load
**Status:** OPEN — the real remaining server-side lever · **Effort:** M · **Severity:** medium

- **Finding (measured 2026-07-17, during the BUG-008 index work):**
  `view_digest_operational_days` is **embedded in 9 of the 15 digest views**, and
  `view_digest_daily_flow` evaluates it **twice internally** — so ONE `/` page load
  recomputes it **10+ times**. Each evaluation is a WindowAgg over ~4,711 rows UNION'd
  from 4 tables.
- **Not an index problem** — it's structural. Options: materialize it (a matview refreshed
  by the sync), or restructure the view graph so it's computed once and joined.
- **Why deferred:** BUG-008 already changed 4 variables (region, waves, index, UI). Measure
  after the region fix lands before restructuring the view graph on a guess.
- Related, NOT worth fixing at current size (evidence gathered, no action): the digest's
  audit flag-scan uses four **leading-wildcard** ILIKEs (`%flag%` etc.) over 3,078 rows —
  a btree can never serve those; it'd need a `pg_trgm` GIN index. Fine at this scale.
- Also found and NOT swept in: **`deliveries.batch_code` is an unindexed FK** — but every
  consumer needs all deliveries and the planner correctly picks a Hash Join, so an index
  would go unused. Deliberately not added (don't index-spam the schema).

## BUG-010 — Hygiene backlog (small, known, deliberately deferred)
**Status:** OPEN · **Effort:** S each · **Severity:** low

1. **`middleware.ts` → `proxy.ts`** — Next.js 16 deprecation warning on every dev-server
   start. Purely a naming convention change (Renzo asked 2026-07-17 whether it caused the
   latency — **it does not**; renaming changes nothing about the `getUser()` round-trip that
   lives there). Worth clearing before it hardens into an error in a future major. Read the
   Next migration guide rather than guessing the export signature.
2. **`types/supabase.ts` drift** — `view_digest_daily_hours` (migration `20260715120000`) is
   applied to the DB but was never regenerated into the types file. Pre-existing; found
   during the index work and deliberately not swept into an unrelated migration.
3. **Double/triple `getUser()` per request** — `middleware.ts:31` AND
   `app/(app)/layout.tsx:13` both call it (a network hop to Supabase Auth each), and
   `sync/cases/page.tsx` makes a third. Cheap now that the function is colocated in `hnd1`;
   was a meaningful slice of the 2-3s from `iad1`. Collapsing them is an **auth** change —
   reason about it deliberately, don't fold it into a perf pass.
4. **Supabase migration history is MCP-stamped, not CLI-stamped** — remote history
   (`20260715031120`) doesn't match local CLI filenames (`20260715120000_...`), so
   `supabase db push` would misread history. Use MCP `apply_migration` (what the 2026-07-17
   index migration did) until this is reconciled.

---

## Fixed entries

All of BUG-001…BUG-005 shipped 2026-07-17 on `feat/mobile-pwa`. Full entries are kept
above (with their ✅ FIXED status + hash) rather than moved, since their root-cause
analysis is the most useful record — this section is the index:

| Bug | Shipped | Commit |
|---|---|---|
| BUG-001 — schedule sheet + 6 table min-width violators ("never crush, always scroll") | 2026-07-17 | `3fd0d94` |
| BUG-002 — digest KPI/chart sheets → centered Dialogs | 2026-07-17 | `3fd0d94` |
| BUG-003 — schedule moved into the digest world (`/?view=digest\|schedule`) | 2026-07-17 | Wave B |
| BUG-004 — blocking grid `minmax(104px,1fr)` (scroll, don't crush) | 2026-07-17 | `3fd0d94` |
| BUG-005 — month-name canonicalization (writer + live DB repair) | 2026-07-17 | `3fd0d94` + DB |

**BUG-005 verified end-to-end:** picker now shows ONE `JULY` campaign with 14 feed days
(was `Jul 8d` + `July 6d`); 2,057 `rc_out` rows before → 2,057 after (re-labelled, none
lost); zero abbreviated month names remain; Python oracle rebuilt, parity 12/12, 486 tests pass.

**Still unverified on-device (the honest last mile):** BUG-004's landscape look at both a
20-col and a 3-col PCA/PCB warehouse, and the two new digest Dialogs on a real phone.
Everything was verified statically (tsc + lint + build green) — the 338px→340px cap
arithmetic is exact, but a real-device pass is still the last word.
