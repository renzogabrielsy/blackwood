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
otherwise silently tw-merge away a `pt-`&#91;`env(…)`&#93; class), and only the shell + shared
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

## BUG-011 — Block closure should be a RECONCILED field (gsheet ⇄ PROPOSED cross-check)
**Status:** OPEN — **vision/direction from Renzo 2026-07-17**, phased. Phase 1 (foundation)
shipping now; Phase 2 (reconciliation) is the target. · **Effort:** Phase 2 = M–L · **Severity:** medium

- **Context:** a block closes when a feeding remark says CLOSED (DB trigger
  `fn_process_blackwood_usage` → `fn_is_close_remark`). The close remarks live in BOTH the
  gsheet RC_OUT tab and the PROPOSED daily report, but under the **R4b cutover** the gsheet
  stopped writing `rc_out`, so gsheet close remarks were being DROPPED (that's the immediate
  bug — C-12A/AUG-25-BLK2 marked CLOSED on the gsheet 2026-07-08, still IN-USE in the DB).
- **Renzo's stated end-goal (verbatim):** *"I do eventually want gsheet and proposed daily
  to work hand in hand in identifying which block is closed or active. Hence why I want it
  to crosscheck."* → closure/active is just ONE MORE field in the platform's existing
  multi-source reconciliation model (extract → reconcile → diff-case → arbitrate), exactly
  like RC IN / RC OUT / Blocking already are.
- **Phase 1 ✅ SHIPPED 2026-07-17** (migration `20260720032956_harden_batch_close_close_only`,
  applied live; verified the 460 existing CLOSED batches were UNCHANGED — hardening only
  prevents future reopen, never re-evaluates existing rows; worker 497 tests + parity 12/12).
  C-12A/AUG-25-BLK2 confirmed staged to auto-close on the next sync (gsheet close-scan reads
  the whole RC OUT tab, no date window, not settlement-filtered). **Requires a Fly worker
  redeploy for the scan to run.** Details:
  `CLOSING_PHRASES` helper used by BOTH the gsheet close-scan and the PROPOSED extractor;
  `fn_close_batch(batch_id)` as the single close primitive; the gsheet RC_OUT close-scan
  writes `batches.status` ONLY (never rc_out — R4b sole-writer preserved); trigger hardened
  close-only + exact-match. Result: EITHER witness can close a block (monotonic, uncontested
  close = just close). These are the reusable primitives Phase 2 sits on.
- **Phase 2 (THE CROSS-CHECK — target, NOT yet built):** make "closed?" a reconciled field:
  - both witnesses agree closed → close, corroborated (high confidence);
  - one closed, other silent → close, note the witness (Phase-1 behavior);
  - **genuine conflict** (e.g. gsheet marks CLOSED on 7/8 but PROPOSED shows the block STILL
    FED after that date) → NOT a close — a **disagreement → a Sync Review diff case** for
    human arbitration, identical to how a value diff is handled today. Reuses the
    adjudicator/case/Sync-Review machinery (see `SYNC_RECONCILIATION_MODEL.md`).
  - Extends the existing Blocking per-block + grand-total cross-check to carry a
    closed/active status column, so the operator sees agree/disagree at a glance.
- **Why phased, not all-at-once:** Phase 1 unblocks the real dropped-signal today; Phase 2
  is a reconciliation-model addition that should be designed against
  `SYNC_RECONCILIATION_MODEL.md`, not bolted on.

---

## BUG-012 — Cenapro Bulk Add modal destroys drafted rows (no close-guard + reset-on-reopen)
**Status:** ✅ FIXED (code landed 2026-07-21, `feat/mobile-pwa`, `3848145`) · **Effort:** M · **Severity:** high (repeated real data loss — Renzo lost ~20 drafted production rows more than once)

- **Symptom:** while drafting a batch of Cenapro production rows in the **Bulk Add modal**
  (`app/(app)/cenapro/production/bulk-add-modal.tsx`), pressing Escape or clicking outside
  the Dialog wiped everything typed; reopening the modal showed a blank 8-row sheet with no
  recovery. Renzo lost ~20 drafted rows on multiple occasions.
- **Root cause (two independent bugs, both in the modal):**
  1. **No close-guard.** The shadcn `Dialog`'s `onOpenChange` was wired straight to the
     parent's close setter, so Escape and outside-click fired `onOpenChange(false)`
     unconditionally — no "you have unsaved rows" gate. `bulk-add-modal.tsx:435`
     (`<Dialog open={open} onOpenChange={onOpenChange}>`).
  2. **Reset-on-reopen.** A `useEffect(() => { if (open) setRows(Array.from({length: 8}, createEmptyRow)); … }, [open])` (`bulk-add-modal.tsx:96-102`) reset the draft rows to
     8 blanks every time `open` became `true` — so even if you reopened to recover, the
     drafts were already destroyed with no backup anywhere (state-only, never persisted).
- **Fix (Phase 2A — modal RETIRED, entry moved to a loss-proof IN-LIST draft zone):**
  - Deleted `bulk-add-modal.tsx`. Bulk entry is now IN-LIST blank rows on the endless Ledger
    (the "Google Sheets" model): a single toolbar **"Add rows"** button reveals a maintained
    pool of blank draft rows appended below the last committed row IN THE SAME `TableVirtuoso`
    list (scroll DOWN into an effectively-infinite, self-topping-up supply). They render
    through the same `itemContent` as committed rows (`DraftRowCells`), so columns align, and
    it's **INLINE (no Dialog)** so Escape/outside-click have nothing to close (Escape only
    reverts the current cell).
  - **Recycling-safe (the non-negotiable):** draft data lives in the endless sheet's
    PARENT-OWNED `draftRows` array (keyed by position) — NEVER row-local — so virtuoso
    recycling an off-screen half-typed row rehydrates it from the array (the flat-list
    equivalent of `production-daily-block.tsx`'s parent-owned drafts Map). `firstItemIndex`
    (top prepend) and the bottom blank-append are orthogonal.
  - **Mirrored to `localStorage`** (`cenapro-ledger-drafts:v1:<user-id>`, debounced 300ms,
    storage-versioned, restored on mount, cleared ONLY on a confirmed Save/Discard) →
    tab-close, crash, navigation, reload, and lock/unlock all preserve drafts.
  - Save validates via `mapBulkRowToDirty` (persistent copyable `errorToast` + red rails on
    offending rows, HARD RULE) and commits via the EXISTING
    `saveProductionEvents(dirtyRows, [])`; on success it clears drafts + mirror and calls
    the new `useLedgerWindow.refreshNewest()` so the saved rows land at the bottom without a
    full reload. Discard-all is the ONE destructive action (gated behind an `AlertDialog`).
  - **One-button behavior:** the "Add rows" button jumps to the true latest first
    (`reset({kind:'latest'})`) if you're on an old month, THEN reveals blanks — so drafts
    never append to a mid-history window (no separate "jump to latest" affordance).
- **Files:** NEW `app/(app)/cenapro/production/draft-entry-zone.tsx`; edited
  `production-endless-sheet.tsx` (lock/unlock + draft state + localStorage + Save bar),
  `use-ledger-window.ts` (`refreshNewest`), `production-ledger-grid.tsx` (retired the modal
  mount + button → "Add rows in the sheet →" affordance); DELETED `bulk-add-modal.tsx`.
- **Verification:** `npm run build` ✓, lint clean on the changed files. The interactive
  draft-loss gauntlet (Escape/click-out/lock/reload survival, Save-lands-at-bottom, invalid-row
  block, Discard confirm, period-jump gate) is **live-verify PENDING** — the route is behind
  Google OAuth and the agent can't sign in; reasoned static walkthrough only.

---

## BUG-013 — Cenapro focus Daily Block silently discards unsaved edits on a view/scope/period switch ✅ FIXED (2026-07-22)

- **Where:** `app/(app)/cenapro/production/production-daily-block.tsx` (the focus-scope W6/W7
  editable pivot) rendered inside `production-ledger-grid.tsx`. Surfaced as the **severe finding**
  of the 2026-07-22 Phase-3b pre-analysis (virtualization/gap audit).
- **Symptom:** The Daily Block owns its OWN unsaved-edit state in its INNER `DailyBlockToolbar`
  (Save/Discard). The OUTER grid toolbar's axis controls (`CenaproPeriodPicker` /
  `ViewModeSwitcher` / `ScopeToggle`) only guarded on the LEDGER grid's `isDirty` (`rows`), which
  stays false in daily view. So with unsaved pivot edits, clicking a different view/scope or a new
  period `router.replace`d the URL → the page remounted the block → **all unsaved edits vanished
  with no warning.**
- **Root cause:** the block's dirty signal never reached the controls that navigate away from it.
- **Fix:** lift a dirty signal. `ProductionDailyBlock` gained an `onDirtyChange?(dirty)` prop
  (reports `hasChanges`, clears on unmount); `production-ledger-grid.tsx` tracks `dailyDirty` and
  guards all three axis controls with `guardDirty = isDirty || dailyDirty`. `ViewModeSwitcher` /
  `ScopeToggle` gained `disabled`/`disabledHint` (matching the period picker's existing pattern) —
  a dirty block now dims + blocks the switch with a "Save or discard your edits before switching…"
  hint instead of silently discarding. The SAME guard pattern is applied to the new endless pivot
  editor (its own `totalDirty`).
- **Files:** `production-daily-block.tsx`, `production-ledger-grid.tsx`, `ledger-controls.tsx`.
- **Verification:** `npm run build` ✓, lint clean. Live-verify PENDING (Google-OAuth-gated route —
  can't sign in from tooling; validated via build + code walkthrough).

---

## BUG-014 — Home digest scrolls the whole document sideways in iPad-Mini portrait (navbar "black bar") ✅ FIXED (2026-07-23, uncommitted)
**Status:** ✅ FIXED (uncommitted) · **Effort:** S · **Severity:** medium (flagship home surface on tablet portrait)

- **Symptom (iPad Mini, ~744px portrait; also ~768px iPad portrait):** the home digest (`/`)
  overflows horizontally — the entire DOCUMENT scrolls sideways. Tell: the always-dark navbar
  shows a **black bar on its right** (navbar bg is viewport-wide, document is wider, scrolling
  right reveals empty space past it). Only in the `640px ≤ w < 1024px` band (`sm` on, `lg` off),
  where the desktop digest layout is active but some element exceeds the viewport width.
- **Root cause (two parts):**
  1. **No document-level horizontal clamp anywhere.** `app/(app)/app-shell.tsx` wrapped
     `{children}` in `flex-1 min-h-0 flex flex-col safe-x` — no `min-w-0`, no `overflow-x` guard.
     So ANY overflowing descendant dragged the whole document wide. (globals.css / layouts add no
     clamp either.)
  2. **Best-supported specific overflower (pending on-device confirmation):** the newly-added
     `components/digest/shipments-band.tsx` incomplete-shipment row — the customer-name span was
     `shrink-0` (un-truncated), so a long customer name summed with the readiness chip past the
     card width and forced the row (→ card → section → document) wider than the viewport. All other
     wide digest bands were verified statically as already contained (schedule-preview / trucks /
     footer tables each scroll inside their own `overflow-x-auto`; charts + week strip collapse to
     one column / `min-w-0` cards below `lg`; open-blocks lab row is `grid-cols-6` = `minmax(0,1fr)`,
     shrinkable).
- **Fix:**
  1. **Backstop (guaranteed):** `app-shell.tsx` wrapper → add `min-w-0 overflow-x-clip`. `clip`
     (not `hidden`) on purpose: it does not create a scroll container and does not force
     `overflow-y: auto`, so vertical page scroll and descendant `position: sticky` (frozen table
     headers/footers) keep working. Wide tables scroll inside their own wrappers, so clamping the
     outer document does not touch their internal horizontal scroll.
  2. **Root-cause (defensive):** `shipments-band.tsx` customer span `shrink-0` → `min-w-0
     max-w-[45%] shrink truncate`; readiness chip capped `max-w-[45%] shrink`. Row can no longer
     force overflow regardless of customer-name length.
- **Files:** `app/(app)/app-shell.tsx`, `components/digest/shipments-band.tsx`.
- **Verification:** `npm run build` ✓ (compiled successfully). Live-verify PENDING — the digest is
  Google-SSO-gated AND `getDigestData()` needs Supabase Postgres (unreachable from the sandbox), so
  the 744px render could not be driven from tooling. Part 1 is high-confidence from code reasoning;
  **Renzo must confirm on the iPad Mini (portrait) that the navbar black bar is gone AND that no
  band's right edge is now clipped** (esp. ShipmentsBand).

### 2026-07-23 follow-up — two bands were still clipping (the `min-w-0`-chain fix)
- **On-device result (Renzo, iPad Mini portrait ~744px):** Part 1 backstop CONFIRMED working — no
  document side-scroll, no navbar black bar. BUT two bands still overflowed their card and were
  **clipped** by `overflow-x-clip` (poked past the card right edge): (1) the **Production schedule**
  snapshot band, (2) **Open Blocks**.
- **Root cause (the classic missing-`min-w-0`):** both are grid items of the A4 snapshot `<section
  className="grid …">` in `app/(app)/page.tsx`. Grid items default to `min-width: auto`, so each
  item's **min-content forced the grid track wide**: for SchedulePreview that's the `min-w-[820px]`
  table (its own `overflow-auto` never engaged because the ancestor chain wasn't width-constrained),
  for OpenBlocks the 2-up (`sm:grid-cols-2`) card row's intrinsic width. With no document scroll
  (Part 1) the excess simply clipped.
- **Fix (add `min-w-0` down the chain so items can shrink to the section width):**
  - `app/(app)/page.tsx` — A4 `<section>` grid: `grid` → `grid min-w-0`.
  - `components/digest/schedule-preview.tsx` — card root `flex flex-col` → `flex min-w-0 flex-col`;
    the `hidden sm:block` wrapper around `<ScheduleTable>` → `hidden min-w-0 sm:block`. Now the card
    shrinks to 696px and the 820px table **scrolls horizontally inside its own `overflow-auto` card**
    (the intended "never crush, always scroll" behavior — swipe left/right within the card).
  - `components/digest/open-blocks.tsx` — card root `flex flex-col` → `flex min-w-0 flex-col`. The
    grid item now shrinks; internally the band is `grid-cols-1 sm:grid-cols-2` (`minmax(0,1fr)`,
    shrinkable) so at 744px each card is ~342px (roomier than its ~305px desktop half-width column) —
    it **fits, no clip**. Internals audited: `grid-cols-6` lab row = `minmax(0,1fr)` ✓, header's
    variable part (batch code) already `min-w-0 truncate` ✓, kg figure + bar are short/`w-full` — no
    further sub-element needed a guard.
- **Part 1 UNTOUCHED** — the `min-w-0 overflow-x-clip` backstop on `app-shell.tsx` remains exactly
  as shipped; this follow-up only makes the two bands contain properly so nothing clips.
- **Verification:** `npm run build` ✓ (compiled successfully in 6.5s). Live re-verify PENDING —
  Renzo re-checks on the iPad Mini after deploy: schedule table should swipe-scroll within its card,
  Open Blocks should fit, nothing clipped at any card's right edge.

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
| BUG-012 — Cenapro Bulk Add modal draft-loss → retired for a loss-proof draft entry zone | 2026-07-21 | `3848145` |
| BUG-013 — Cenapro focus Daily Block silent edit-loss on view/scope/period switch → lifted dirty-nav guard | 2026-07-22 | _(uncommitted — Phase 3b)_ |

**BUG-005 verified end-to-end:** picker now shows ONE `JULY` campaign with 14 feed days
(was `Jul 8d` + `July 6d`); 2,057 `rc_out` rows before → 2,057 after (re-labelled, none
lost); zero abbreviated month names remain; Python oracle rebuilt, parity 12/12, 486 tests pass.

**Still unverified on-device (the honest last mile):** BUG-004's landscape look at both a
20-col and a 3-col PCA/PCB warehouse, and the two new digest Dialogs on a real phone.
Everything was verified statically (tsc + lint + build green) — the 338px→340px cap
arithmetic is exact, but a real-device pass is still the last word.
