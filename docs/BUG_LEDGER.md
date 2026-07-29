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

## BUG-015 — FLECON bag sync silently dropped rows, discarded its own cross-check, and could WIPE a day ✅ FIXED (2026-07-27, uncommitted)
**Status:** ✅ FIXED (uncommitted) · **Effort:** M · **Severity:** HIGH (silent production data loss + a wrong inventory balance shown for 6 months)

Three independent defects in the same pipeline. Together they let real bag movements go
missing, made the app show a **physically impossible `ZAMBOANGA_BAG = −127`**, and let an
older copy of the workbook delete a real day with no audit trail.

### A — Silent drop of out-of-window rows (the data bug)
- **Symptom:** `ZAMBOANGA_BAG` balance of **−127** (a negative physical bag count) on
  `/inventory/flecon-bags` and in the home digest's bag band.
- **Root cause:** `workers/sync/src/reports/flecon/extract.ts` dropped every row dated before
  `since` and only bumped a bare counter, `droppedBeforeSince`. That counter never became a
  warning, a held row, or a run finding, and never reached `sync_runs.result`. The operator's
  `JANUARY 2026` tab has a **year typo in cell A75** — it reads `2025-01-31` instead of
  `2026-01-31`, and rows 76–79 inherit it by date carry-forward. `2025-01-31` is below every
  watermark, so five real movements were refused on every run since January and nobody was told:

  | Sheet row | Particular | Bag type | Qty |
  |---|---|---|---|
  | 75 | FIBC "ECOPACK" BEIGE … (BRANDNEW) | ECOPACK_BEIGE | +100 |
  | 76 | ZAMBOANGA DELIVERED EMPTY BAG | ZAMBOANGA_BAG | +128 |
  | 77 | RS 1 ZAMBOANGA | ZAMBOANGA_BAG | −1 |
  | 78 | RETURNED BAG FROM BAGGED 3X50 TO PP SACKS | KOREA_WHITE_SUNDRY | +18 |
  | 79 | USED BAG OF SUNDRY | KOREA_WHITE_SUNDRY | −14 |

  Net +100 / +127 / +4 — matching the measured drift against the sheet's own balance row exactly.
- **Fix (extraction stays exact — the typo is NEVER auto-corrected):** the extractor now also
  returns `sheet_year` and `flagged_rows[]` (row, particular, bag type, qty, `dropped`,
  `out_of_year`). `apply.ts` turns them into held rows: `out_of_year_date` (kind `malformed`) for
  a date outside the tab's year — the loud one — and `dropped_before_since_unrecorded` (kind
  `below_since_floor`) for an in-year sub-floor date **the DB has never recorded**. Ordinary
  settled history stays silent, so the everyday run is unchanged.

### B — `balance_crosscheck` computed on every run and thrown away
- **Root cause:** `classify.ts` computed DB-view-balance minus the sheet's own running-balance
  row per bag type on **every** run and had been correctly emitting −100 / −4 / −127 for three
  weeks. `grep balance_crosscheck` outside `reports/flecon` returned **zero hits**;
  `normalizeReport.ts` never carried it into the run result. This single gap is why defect A ran
  for six months instead of one day.
- **Fix:** any non-zero drift now raises ONE held row (`balance_crosscheck_drift`, kind
  `flagged`) naming every drifting bag type and both numbers. **Still a finding, never a write
  gate** — flecon is single-source and `specs/flecon.md` §4 fixes the cross-check as informational.

### C — A stale workbook could silently WIPE a day (most dangerous)
- **Root cause (three compounding parts):**
  1. `makeFleconFetcher` takes the newest **email** carrying an xlsx — which can still be an
     older **revision** of the cumulative workbook. Days it lacks classify `DATE_CHANGED` with
     `movements: []`.
  2. `apply.ts` then did `deleteByDate(...)` followed by a *conditional* insert — **two separate
     HTTP calls, not transactional**.
  3. The audit row was only written when `ins.length > 0`, so a zero-row wipe left **nothing**
     behind.
- **Confirmed fired in production 3×**, signature `applied {inserts: 0, replaced_dates: 1}` with
  `counts {update: 1}`: 2026-07-06 03:04 and 03:35 (stored workbook shrank 368234 → 367607 →
  367589 bytes), and **2026-07-23 06:43, which wiped 2026-07-22** (383843 → 383775 bytes) — that
  date showed zero movements in the app for ~19 hours. Each self-healed only because the wiped
  date happened to stay inside the next run's `watermark − 3 days` window. **A wiped middle date
  would have been gone permanently.**
- **Fix (all three):**
  1. **Refuse a stale workbook** — if the attachment's `date_max` is older than
     `MAX(flecon_bag_movements.transaction_date)`, the whole apply refuses: no writes, no
     watermark, no Gmail label, plus a `stale_workbook` held row (kind `gate_failure`) and a
     classify `gate_failures` entry so the panel card settles to *gate-failed*.
  2. **A date that resolves to zero rows is a HOLD, not a write** (`delete_to_empty_blocked`,
     kind `gate_failure`). A day is never deleted on the strength of an absent section.
  3. **Atomic replace + always audit** — new RPC `fn_flecon_replace_date(p_date, p_rows)`
     (migration `20260727060000`, mirroring the transactional `fn_bulk_update_*` RPCs) does the
     DELETE + INSERT in ONE transaction and returns `{deleted, deleted_first_id, inserted,
     first_id}`, so the `REPLACE` audit row is written for **every** replace — falling back to a
     DELETED row's id when the insert returns none, i.e. exactly the wipe case.

### One-time data repair (2026-07-27)
The 5 mis-dated movements were inserted by hand at `transaction_date = 2026-01-31` with
`source_row` 75–79, under a double-guarded `WHERE` (no-op on re-run), with a
`write_ingestion_audit` row recording it as a human-arbitrated backfill and quoting the A75 typo.
Audit log id **`a6293bf8-26b2-4207-98a4-6134f0f08fb7`**. Balances moved exactly as predicted and
nothing else changed (543 pre-existing rows untouched, 548 total):

| Bag type | Before | After | Sheet's own balance row |
|---|---|---|---|
| ECOPACK_BEIGE | 0 | **100** | 100 |
| KOREA_WHITE_SUNDRY | 302 | **306** | 306 |
| ZAMBOANGA_BAG | **−127** | **0** | 0 |

No bag type has a negative balance any more.

### ~~Known limitation (deliberate)~~ → CLOSED by BUG-020 (2026-07-29)
A normal run's `since` (`watermark − 3 days`) never reaches January, so the backfilled rows were
safe day to day — but **a watermark reset would re-run from 2026-01-01 and replace-by-date would
delete them again**, because the extractor still (correctly) refuses to import the mis-dated
rows. Renzo has since decided **NOT** to have cell A75 corrected (the present-day totals are
already accurate and chasing a months-old cell edit is not worth it), so the arbitration was made
durable in the database instead — see **BUG-020** below (`flecon_bag_date_settlements`).

### Files
`workers/sync/src/reports/flecon/{extract,apply,index}.ts` · `workers/sync/src/lib/db.ts`
(`replaceFleconDate`) · `workers/sync/src/workflows/{reportDeps,reportWorkflow}.ts` ·
`supabase/migrations/20260727060000_fn_flecon_replace_date.sql` ·
`workers/sync/test/reports/flecon-guards.test.ts` (11 tests) · `workers/sync/specs/flecon.md`
(§2a / §3a / §5a) · `app/(app)/inventory/flecon-bags/CONTEXT.md`.

**Verification:** worker `npm run typecheck` ✓ · `npm test` 528/528 ✓ · `npm run parity` 12/12 ✓
(classify envelope untouched by design) · root `npx tsc --noEmit` ✓ · `verify-findings` 12 ✓ ·
`verify-sync-reducer` 22 ✓ · `verify-adjudication` 10 ✓ · RPC round-trip proven on a scratch date
and cleaned up.

**Note for the next agent:** all five new held reasons reuse **existing** `HeldKind` values. The
kind enum is frontend-locked — `app/(app)/sync/types.ts` plus three exhaustive
`Record<HeldKind, …>` maps (`components/sync/cases/labels.ts`, `lib/sync/findings.ts`,
`app/(app)/sync/adjudication.ts`). Reclassify via `reason`/`detail`/`row`, never a new kind.

---

## BUG-016 — Two writers, one guard: the Sheet path blind-inserted a duplicate delivery ✅ FIXED (2026-07-27, uncommitted)
**Status:** ✅ FIXED (uncommitted) · **Effort:** S · **Severity:** HIGH (silent phantom inventory + inflated RC IN / MTD totals, undetectable from the app)

A time-of-check/time-of-use race between the two pipelines that both write `deliveries`.
It produced a real duplicate that inflated a block by **24,024 kg** and would have kept
producing more on any day both writers touched the same row.

### Symptom
Block **C-11B** read **84,753 kg** in the app (`view_blocking_grid`) against **60,729 kg**
on the Google Sheet — a 24,024 kg gap, exactly one truckload. RC IN and month-to-date
totals were inflated by the same amount. Nothing in the app flagged it: both rows were
individually valid, so no gate, no held row, no finding fired.

### Root cause (confirmed, with timestamps)
Two rows existed for `2026-07-14` / Ornales / `JULY-26-BLK7` / `C-11B` / truck `MAV 9202`
/ 24,024 kg / 685 sacks. **Both carried the identical remark describing ONE weighing** —
`"MAV 9202 net kilos of 24,385 - 1.48%(ASH) = 24,024"` — so this was one physical truck,
not two deliveries:

| id | created_at | cost_basis | writer |
|---|---|---|---|
| `8a5e95f3-d4a8-4af0-9b3b-e618a4e36360` | 2026-07-15 01:36:01Z | 36.00 | email path (`reports/deliveries/apply.ts`) |
| `a10720f4-a21a-42f3-9f38-de8cc5395478` | 2026-07-15 03:43:56Z | 0.00 | Sheet path (`reports/gsheet/apply.ts`) |

Only ONE of the two write paths guarded against duplicates:

- `reports/deliveries/apply.ts:184` (email) → `db.insertIfAbsent("deliveries", …, ["transaction_date","batch_code","truck_plate","weight_kg","sacks"])` — re-queries the DB **immediately before** inserting.
- `reports/gsheet/apply.ts` (Sheet) → plain `db.insert("deliveries", …)` with **no last-instant check**. The file's own header comment asserted this was deliberate: *"db.insert(), NOT insertIfAbsent — the classifier's fresh-DB-window decision is the idempotency guard."*

That reasoning holds only while gsheet is the **sole** writer of the table. It is not. The
Sheet path decides "this row is NEW" from a DB snapshot read at the **start** of its run,
then writes blind. The email path inserted at 01:36; the Sheet path — still acting on its
pre-01:36 snapshot — inserted the second copy 2h07m later. **A snapshot cannot see a
writer that arrives after it was taken; only a last-instant re-check can.**

Both `workers/sync/specs/gsheet.md` (§5 "Idempotency mechanism", porting trap #4) and
`specs/SHARED.md` §2.5 documented the asymmetry as intentional — and gsheet.md explicitly
flagged that fixing it "would ALSO fix a latent race-condition risk … a possible
improvement opportunity", requiring "an explicit human decision". Renzo made that decision
on 2026-07-27, after the latent risk turned into real data.

### Data repair (done)
Deleted `a10720f4-…` (the **unpriced** copy — keeping the priced row preserves cost data).
Verified before/after: C-11B `84,753 → 60,729` (matches the Sheet), all 165 other blocks
byte-identical (md5 of `view_blocking_grid` unchanged), all 688 other batches unchanged,
row count for that date+block now 1. `deliveries` has an AFTER DELETE audit trigger
(`log_delivery_changes`) which wrote the `audit_logs` DELETE row with a full snapshot; its
`comment` was then stamped with the authorization + root cause.

> **Trigger defect found while verifying — ✅ FIXED 2026-07-27, see BUG-016a below.**
> `fn_update_blackwood_state` is a **BEFORE** DELETE trigger, and its DELETE branch
> recomputed `current_weight` as `SUM(deliveries WHERE batch_code = OLD.batch_code)` —
> **without excluding `OLD.id`**. At BEFORE-DELETE time the row still exists, so the
> recompute included the row being deleted and landed one row stale: after this delete it
> wrote `current_weight = 84,753` (the pre-delete sum) instead of 60,729.

### Fix (shipped in this changeset)
`workers/sync/src/reports/gsheet/apply.ts` — the Sheet path now uses `insertIfAbsent` for
NEW rows, with the **same natural keys** the email writers use so both paths agree on what
"the same delivery" is (exported as `GSHEET_DELIVERIES_NATURAL_KEY` /
`GSHEET_RC_OUT_NATURAL_KEY`). The 2026-07-11 auto-create helpers
(`writeRcInDelivery`/`writeRcOutRow`) are guarded too.

**A skip is not silent success.** A guard hit surfaces as a held row using the email path's
**existing** vocabulary — `reason` and `kind` both `already_exists`, detail
`"idempotent skip (natural key already in DB)"`. No new `HeldKind` was invented (that enum
is frontend-locked — see the BUG-015 note above). `ModeApplyResult.skipped[]` gained an
optional `reason` so `applyGsheet` passes that word through instead of the generic
`"skipped"`; every other skip is unchanged. In the auto-create path a duplicate now holds
as `already_exists` rather than being mis-reported as `unmapped_batch_code`, which would
have sent an operator down the wrong diagnosis.

**Inherited trade-off (deliberate, `lib/db.ts:13`):** the natural key cannot distinguish
two genuinely-identical truckloads on the same date/batch/truck/weight/sacks, so a real
second truckload matching all five fields is suppressed. The email path has always
accepted this; matching it keeps the two paths consistent. Crucially a suppressed row is
**HELD — visible and re-appliable by a human** — whereas the pre-fix blind insert produced
a silent, invisible duplicate. The two paths now fail the same way, which is the point.

**rc_out finding — guarded, but inert today (stated rather than blindly mirrored).** Under
the default `SYNC_RCOUT_RECONCILE_CUTOVER=on`, `applyGsheet` skips the rc_out mode
**whole** (R4b cutover), so gsheet does not write `rc_out` in production and the race is
not currently live there. The guard was still added because that flag is a documented
one-line revert: with `SYNC_RCOUT_RECONCILE_CUTOVER=off`, gsheet's rc_out loop and the
PROPOSED writer (`reports/rc_out/apply.ts`, already using `insertIfAbsent`) both target
`rc_out` — the identical two-writer shape that caused this bug. Cost is zero while the
path is skipped and correct when it isn't.

### Files
- `workers/sync/src/reports/gsheet/apply.ts` — the guard + held surfacing + rewritten header comment
- `workers/sync/test/reports/gsheet-idempotency.test.ts` (new, 12 tests) — suppression, surfacing, key-parity with the email writers, no-regression, the real race replayed, and the cutover-still-skips case
- `workers/sync/test/reports/gsheet.test.ts`, `workers/sync/test/reports/gsheet-autocreate.test.ts` — stubs gained `insertIfAbsent` (they only implemented `insert`)
- `workers/sync/specs/gsheet.md`, `specs/SHARED.md`, `specs/PORTING_DECISIONS.md` — the asymmetry is now recorded as retired

**Gates:** worker `typecheck` clean · `vitest` 540/540 · `npm run parity` 12/12 (apply-layer
only; `classify.ts` untouched, so no `expected-deviations.json` entry is required).

---

## BUG-016a — `fn_update_blackwood_state`'s DELETE branch left `current_weight` one row stale ✅ FIXED (2026-07-27, migration applied live)
**Status:** ✅ FIXED (migration applied to prod + drifted batches backfilled) · **Effort:** S · **Severity:** medium (stored-field corruption on every delivery delete; no user-facing number was wrong)

The defect BUG-016's verification pass turned up, fixed under Renzo's explicit authorization
on 2026-07-27.

### Root cause
`tr_blackwood_delivery` is `BEFORE INSERT OR UPDATE OR DELETE ON deliveries`. In the DELETE
branch the two `deliveries` sub-selects aggregated **without excluding `OLD.id`**. Because the
trigger fires *before* the row is removed, the deleted row was still visible to them, so every
delivery delete wrote a `current_weight` too high by exactly that row's `weight_kg` and an
`avg_cost` still weighted by it. The same function's location-clearing branch, a few lines
below, already filtered `AND id != OLD.id` and carried a comment naming this exact hazard — the
weight/avg_cost recompute simply never got the same treatment.

### Fix
`supabase/migrations/20260727070000_fix_blackwood_state_delete_excludes_old_row.sql` —
`CREATE OR REPLACE`, adding `AND id <> OLD.id` to the two `deliveries` sub-selects in the DELETE
branch and nothing else. The `rc_out` sub-select in that branch is deliberately untouched
(deleting a delivery changes no rc_out row). INSERT / UPDATE / location-clearing branches
reproduced byte-for-byte; `prosecdef = false` and `SET search_path = public` verified preserved
after apply. Applied via MCP `apply_migration` (remote history is MCP-stamped — see BUG-010 #4).

### Empirical proof the fix works
Insert → observe → delete → observe, inside a `DO` block terminated by `RAISE EXCEPTION` so the
whole transaction (including the audit rows the insert generated) rolled back:

```
weight:   pre=60729.00  post_insert=61729.00  post_delete=60729.00   restored ✓
avg_cost: pre=36.00     post_insert=37.02     post_delete=36.00      restored ✓
```

`post_insert` is precisely what the OLD code computed on delete (it summed every row including
the one being deleted), so the pre-fix result would have been 61,729 / 37.02 — the fix is what
changed the outcome.

### Backfill (4 batches, 83,308 kg of drift removed)
Corrected from SQL truth (`SUM(deliveries.weight_kg) − SUM(rc_out.weight_kg)`), derived entirely
in one guarded `UPDATE … FROM` — never in TypeScript:

| Batch | Status | `current_weight` before | after | drift removed |
|---|---|---|---|---|
| `FEB-26-BLK23` | CLOSED | 37,265.00 | **119.00** | 37,146.00 |
| `JULY-26-BLK6` | STORED | 94,739.00 | **70,715.00** | 24,024.00 |
| `JULY-26-FEED1` | CLOSED | −19,605.00 | **0.00** | −19,605.00 |
| `JAN-26-SUNDRY7` | CLOSED | −5,069.00 | **−2,536.00** | −2,533.00 |

Proof of containment: 689 batches total, the other **685 are byte-identical** (md5 of
`batch_code:current_weight:avg_cost:status` unchanged at `3992fd83…`); post-sweep
`batches_still_drifting = 0`. `batches` has **no** audit trigger, so four
`write_ingestion_audit` rows carry the trail: `d226ecf7-5a7d-48cd-9013-36c50891af24`,
`7a0bf904-d3d5-43cf-889e-9ffd0b7034a6`, `cd404c08-6d87-4dad-ae6b-ba6da4aa1cca`,
`04e2a437-245a-41ed-a261-35981d144880`.

**Not drift, deliberately untouched:** `NOV-25-BLK7` (block `D-15A`) is CLOSED holding
5,418 kg — and 51,315 − 45,897 = 5,418 exactly, i.e. it *matches* SQL truth. A closed batch
legitimately retains residual logged weight (evaporation loss / *resiko*, confirmed by Renzo).
A drift-based sweep never surfaces it.

**This drift had been resynced twice before without the root cause being fixed** —
migrations `20260531041615_resync_current_weight_for_drifted_active_batches` and
`20260605063716_resync_current_weight_post_rc_out_reassign_jun`. The 2026-05-31 one explicitly
flagged `JAN-26-SUNDRY7 −2,533` as drift it was "intentionally NOT auto-fixing… flagged for
human review" — the same batch, the same −2,533, still drifting 8 weeks later, now corrected.
That is what a symptom-only repair buys you; this entry fixes the writer.

**`avg_cost` deliberately NOT backfilled.** None of the four batches' `avg_cost` divergence
traces to the fixed DELETE defect, and **208 of 689 batches** diverge from the delivery-weighted
average because the INSERT branch maintains a *running* average against `current_weight` (net of
rc_out) while the DELETE/UPDATE branches recompute a *delivery-weighted* average — two competing
definitions. Correcting 4 of 208 would have created an arbitrary partial state in a user-visible
₱ field (the blocking detail panel reads `batches.avg_cost`). See BUG-018.

### Blast radius
None user-facing. `view_blocking_grid` computes balance live from
`SUM(deliveries) − SUM(rc_out)` and does **not** read `current_weight` (the 2026-05-31
phantom-inventory fix). This was hygiene on a stored field.

---

## BUG-017 — Same BEFORE-trigger staleness in the UPDATE branch's `batch_code`-change path
**Status:** OPEN — found 2026-07-27 while backfilling BUG-016a; **deliberately not fixed** (out of the authorized scope, and not fixable with the one-line idiom) · **Effort:** S–M · **Severity:** medium

- **Finding:** in `fn_update_blackwood_state`'s UPDATE branch, when `batch_code` changes, both
  recomputes read `deliveries` *before* the row has moved:
  - the **OLD** batch's recompute still sees the departing row → left **too high** by its weight;
  - the **NEW** batch's recompute cannot see it yet → left **too low** by its weight.
- **Proof it fires in production:** delivery `a10720f4-…` was UPDATEd on 2026-07-22 from
  `JULY-26-BLK6`/`C-11A` → `JULY-26-BLK7`/`C-11B` (audit `ebf06243-005d-49d6-9fc2-6f44ff2019d4`).
  `JULY-26-BLK6` was left **+24,024 kg** high — one of the four batches backfilled in BUG-016a.
  (`JULY-26-BLK7`'s matching −24,024 was masked by the later BUG-016 hand-correction.)
- **Why not folded into the BUG-016a migration:** the OLD side is a one-liner (`AND id <> OLD.id`),
  but the NEW side is **not** — it needs the not-yet-visible NEW row folded into the sum, which
  the existing idiom cannot express. Rewriting a second branch of a core production trigger
  inside a targeted fix to a different branch is exactly the regression risk that migration warns
  against. Renzo's 2026-07-27 authorization named the DELETE branch specifically.
- **Fix spec (for whoever picks this up):** in the `OLD.batch_code IS DISTINCT FROM NEW.batch_code`
  block, add `AND id <> OLD.id` to the OLD-batch `deliveries` sub-selects, and for the NEW batch
  add `NEW.weight_kg` / `NEW.cost_basis * NEW.weight_kg` to the respective sums (equivalently: move
  the whole recompute to an AFTER trigger, where both sides are simply true — the cleaner fix, but
  a bigger change since the function also handles INSERT/DELETE and returns OLD/NEW).
  Then re-run the drift sweep and backfill.

---

## BUG-018 — `batches.avg_cost` has two competing definitions (208 of 689 batches diverge)
**Status:** OPEN — data-semantics call, needs Renzo (do not "fix" unilaterally) · **Effort:** S (repair) / M (decide) · **Severity:** low

- **Finding (2026-07-27, sweeping for BUG-016a):** the INSERT branch of
  `fn_update_blackwood_state` maintains `avg_cost` as a **running** weighted average blended
  against `current_weight` (which is net of rc_out consumption), while the DELETE and UPDATE
  branches **recompute** it as a plain delivery-weighted average
  (`SUM(cost_basis × weight_kg) / SUM(weight_kg)`). The two disagree whenever a batch has been fed
  from, so a batch's `avg_cost` depends on which branch last touched it. **208 of 689 batches**
  currently differ from the delivery-weighted average.
- **Why it mostly doesn't bite:** the pricing views deliberately avoid this column and recompute
  from `deliveries.cost_basis` — `view_rc_out_closed_blocks`, the rc_movement fed-price and
  campaign views all say so in their migration headers ("NOT batches.avg_cost, which is stale").
- **Where it IS visible:** the blocking detail slide-over (`app/(app)/inventory/blocking/actions.ts`
  reads `batches.avg_cost`, role-gated), `view_rc_movement`'s `php_per_kg` (`MAX(b.avg_cost)`),
  and Jarvis batch lists.
- **The decision needed:** pick ONE definition. Delivery-weighted (matching every other price
  surface) is the obvious candidate, which would mean changing the INSERT branch to recompute
  rather than blend, plus a 208-row backfill. That changes ₱ numbers a user can see, so it is
  Renzo's call, not an agent's.

---

## BUG-019 — The sync opened 7 IMAP sessions per run and blew Gmail's connection cap ✅ FIXED (2026-07-28, uncommitted)
**Status:** ✅ FIXED · **Effort:** M · **Severity:** critical (every sync run failed in 3–5s; production outage)

### Symptom
Every sync run failed after 3–5 seconds. `imapflow` threw a generic `Error: Command
failed`. The real error object, extracted by hand:

```
serverResponseCode:   ALERT
response:             3 NO [ALERT] Too many simultaneous connections. (Failure)
responseText:         Too many simultaneous connections. (Failure)
responseStatus:       NO
authenticationFailed: true      ← imapflow sets this even though it is NOT an auth failure
```

### Root cause — the rule the code stated but never enforced
`workers/sync/src/lib/gmail.ts` has carried this header since Wave 4A:

> *SINGLE-CONNECTION SESSION REUSE: the Mail Clerk depends on ONE IMAP session for all
> four report types … Do NOT open a client per report.*

Nothing enforced it. Three call sites each built their own `GmailClient.fromEnv()`:

| Call site | Sessions per run |
|---|---|
| `workflows/mailClerk.ts:307` — the intended shared session | 1 ✅ |
| `workflows/reportDeps.ts::makeLabeler` — a NEW session on EVERY label application | 4 ❌ |
| `workflows/reportDeps.ts::makeFleconFetcher` — its own | 1 ❌ |
| `reports/prodSchedule/josephEmail.ts` — its own ("one extra sequential login is harmless") | 1 ❌ |

**7+ per run**, against Gmail's ~15-simultaneous-connection cap per account. Two
compounding defects made it worse:

- **`isAuthFailure` believed `authenticationFailed`.** imapflow's `handleAuthError`
  stamps that boolean on ANY failure raised during the auth phase — including this
  refusal. So `connect()` took the genuine-auth path: it force-re-minted the OAuth token
  and **opened a SECOND connection**, doubling connection burn on the exact failure
  caused by too many connections.
- **`close()` early-returned when `this.connected` was false.** A client whose
  `connect()` threw part-way never released its socket — leaking the very resource
  being exhausted.

### The misdiagnosis it caused (the expensive part)
Because the informative text never reached the logs — `Error: Command failed` is all
anyone saw — and because `authenticationFailed: true` pointed at auth, this was
diagnosed as an **auth failure for a full day**. It triggered an unnecessary
**App Password → OAuth2/XOAUTH2 migration** (2026-07-27, see `specs/SHARED.md` §1.1),
which fixed nothing because auth was never broken. *The lesson: when a library hands you
a generic message, log its structured fields before believing any boolean it sets.*

### The fix (four parts)
1. **One session per run, enforced.** New `workers/sync/src/lib/gmailSession.ts` — a
   process-scoped, reference-counted broker. Nothing in `src/` constructs a
   `GmailClient` any more; every caller uses `withGmailSession(fn)`, and
   `runSync.ts::runSyncGuarded` wraps the run body in `withGmailRunLease(...)` so ONE
   session spans Stage 1 → the parallel writers → Stage 3c, closed exactly once in a
   `finally`. Threading the clerk's live client through was not possible: each report is
   its own DBOS child workflow with serializable-only params. Concurrency-safe because
   the broker serializes the connect decision and every `GmailClient` method holds
   `imap.getMailboxLock` across its whole critical section.
2. **Connection limit ≠ auth failure.** `isConnectionLimitFailure()` is checked first and
   always wins; `isAuthFailure()` now leads with `err.oauthError` (set only when the
   XOAUTH2 SASL exchange itself failed — the reliable discriminator) and treats
   `authenticationFailed` as the weakest, last signal. The refusal gets a **bounded**
   backoff instead (`[5s, 15s]`, 2 retries, strictly sequential with the prior socket
   discarded first) and never a token re-mint.
3. **`close()` always releases the socket.** Unconditional teardown of any constructed
   `ImapFlow` — LOGOUT when live, hard `close()` otherwise, `close()` after a logout too.
   Idempotent, never throws.
4. **The real error is surfaced.** `GmailOperationError` carries `responseText` /
   `serverResponseCode` / `responseStatus` / `executedCommand` and puts them in the
   message. A connection-limit failure produces a plain-English progress beat and a
   `gate_failure` held row ("Gmail refused the connection — too many are open … wait a
   few minutes and run the sync again") so it lands in `flattenRunFindings`.
   `redactImapCommand()` drops `AUTHENTICATE`/`LOGIN` arguments outright — credentials
   are never logged, and `logger: true` is explicitly NOT the way to debug IMAP.

### Files
`workers/sync/src/lib/gmailSession.ts` (new) · `workers/sync/src/lib/gmail.ts` ·
`workers/sync/src/workflows/mailClerk.ts` · `workers/sync/src/workflows/reportDeps.ts` ·
`workers/sync/src/workflows/reportWorkflow.ts` · `workers/sync/src/workflows/normalizeReport.ts` ·
`workers/sync/src/workflows/runSync.ts` · `workers/sync/src/reports/prodSchedule/josephEmail.ts` ·
`workers/sync/specs/SHARED.md` §1.8–1.9.

### Verification
26 new tests (`test/lib/gmailSession.test.ts`, `test/lib/gmailConnectionLimit.test.ts`) —
`imapflow` and the client are mocked, **zero live IMAP calls** (Gmail was at its ceiling;
every attempt would have prolonged the outage). Proven by test, not asserted: a full
run's Gmail work opens **1** session with the lease and **7** without it; peak live
sessions never exceeds 1; the connection-limit error mints the token exactly ONCE.
Worker: typecheck clean, **566 tests pass** (was 540), **parity 12/12**.

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
| BUG-016a — `fn_update_blackwood_state` DELETE branch excluded `OLD.id`; 4 batches / 83,308 kg backfilled | 2026-07-27 | migration `20260727070000` (applied live) |
| BUG-019 — 7 IMAP sessions per run blew Gmail's connection cap; "too many connections" misread as an auth failure | 2026-07-28 | _(uncommitted)_ |

**BUG-005 verified end-to-end:** picker now shows ONE `JULY` campaign with 14 feed days
(was `Jul 8d` + `July 6d`); 2,057 `rc_out` rows before → 2,057 after (re-labelled, none
lost); zero abbreviated month names remain; Python oracle rebuilt, parity 12/12, 486 tests pass.

**Still unverified on-device (the honest last mile):** BUG-004's landscape look at both a
20-col and a 3-col PCA/PCB warehouse, and the two new digest Dialogs on a real phone.
Everything was verified statically (tsc + lint + build green) — the 338px→340px cap
arithmetic is exact, but a real-device pass is still the last word.

---

## BUG-020 — FLECON: the January backfill was undeletable-by-luck, the balance cross-check read too early, and the out-of-year warning lied ✅ FIXED (2026-07-29, uncommitted)
**Status:** ✅ FIXED (uncommitted) · **Effort:** M · **Severity:** HIGH (latent data loss) + MEDIUM (two recurring false alarms)

Three related defects, all in the BUG-015 code shipped 2026-07-27/28. They are corrections
to that work, not new ground.

### 1 — A watermark reset would have deleted the hand-backfilled January rows
- **Root cause:** the five movements repaired on 2026-07-27 (`2026-01-31`, `source_row`
  75–79, audit `a6293bf8-26b2-4207-98a4-6134f0f08fb7`) survived only because a normal run's
  `since` (`watermark − 3 days`) never reaches January. Reset the watermark and the flecon
  first-run floor drops to `2026-01-01`; the extractor again (correctly) refuses the rows
  the sheet dates `2025-01-31`, so `2026-01-31` resolves to the sheet's contents alone and
  REPLACE-BY-DATE deletes the backfill. **Renzo has decided NOT to have cell A75 corrected**
  — the present-day totals are already right — so the arbitration had to become a DB fact.
- **Fix:** new table **`flecon_bag_date_settlements`** (migration
  `20260729060000_flecon_bag_date_settlements.sql`), the direct sibling of
  `rc_out_date_settlements`: PK `transaction_date`, corroboration columns
  (`db_movement_count`, `db_net_qty`), `reason`, `settled_at`, `settled_by_run_id`
  **and** `settled_by_audit_log_id` (both FK `ON DELETE SET NULL` — losing a pruned run or
  audit row must never un-settle a date). RLS on, `authenticated` SELECT only, service role
  is the sole writer. **Seeded with `2026-01-31`**, pointing at the arbitration audit log.
  A settled date is skipped **entirely**: `reports/flecon/index.ts::runReport` filters it out
  of BOTH the extract rows and the DB compare-set before classify (filtering only the sheet
  side would leave an empty-day `DATE_CHANGED`, i.e. `delete_to_empty_blocked`, not a skip),
  and `apply.ts` carries a defence-in-depth skip so "never deleted" is true of the apply on
  its own.
- **Automatic settlement is deliberately narrow.** flecon is single-source — there is no
  second per-date witness the way rc_out has the RC MOVEMENT sheet — so NOOP days are never
  auto-settled (the sheet is editable history; settling a NOOP would freeze out a legitimate
  future edit). The worker settles by itself in exactly one machine-verifiable case: an
  out-of-year sheet-row group whose movements **already exist in the DB, movement for
  movement, under the tab's own year** — i.e. the arbitration provably already happened.
  Pure core `workers/sync/src/reports/flecon/settlement.ts::computeFleconSettlements`.

### 2 — The balance cross-check compared PRE-write app balances to a POST-write sheet
- **Root cause:** `balance_crosscheck` is computed in `classify.ts` from
  `view_flecon_bag_balance` read **before** the run's own writes, and compared against the
  sheet's **already-updated** running-balance row. Every run that imported new movements
  therefore reported phantom drift. Proven on run `da9f2714-8836-418f-8594-1ec4883ea98e`
  (2026-07-29): FG_ALL_BLACK "app 6 vs sheet 156", KOREA_WHITE_SUNDRY "app 306 vs sheet 282",
  ZAMBOANGA_BAG "app 0 vs sheet 160" — the live DB now reads **156 / 282 / 160**, matching
  the sheet exactly on all three. All three had movements dated 2026-07-27, the day that run
  imported.
- **Fix:** the finding is now produced **after** the write loop, against a **fresh** balance
  read injected as `FleconApplyDeps.readBalances` (apply.ts still never imports a DB
  singleton). `recomputeCrosscheckRows()` swaps the app side and recomputes
  `drift = app − sheet` over the same code set. **The tolerance was NOT widened** — any
  non-zero drift is still reported; only the read moved. Classify's envelope is untouched, so
  parity is unaffected. An offline caller with no `readBalances` keeps the old rows.

### 3 — The out-of-year warning asserted something that was no longer true
- **Root cause:** `out_of_year_date`'s detail read *"These rows were NOT imported and never
  will be while the date reads 2025-01-31"*. False since 2026-07-27 — they were backfilled.
- **Fix:** once the CORRECTED (tab-year) date is settled, the finding is **suppressed
  entirely** — the arbitration is on record and the rows are protected. Suppression maps the
  mis-dated row through `correctedDate(row.date, sheet_year)`, because the flagged row carries
  the TYPO date, not the settled one. A genuinely new, un-arbitrated out-of-year date still
  fires at full volume (pinned by test).

### Files
`supabase/migrations/20260729060000_flecon_bag_date_settlements.sql` ·
`workers/sync/src/reports/flecon/{settlement.ts (new),index.ts,apply.ts}` ·
`workers/sync/src/lib/db.ts` (`readFleconSettledDates`, `insertFleconSettlements`) ·
`workers/sync/src/workflows/reportDeps.ts` (dry-run proxy must block the new writer — same
prototype fall-through hazard as `replaceFleconDate`) ·
`workers/sync/test/reports/flecon-settlement.test.ts` (19 tests) ·
`workers/sync/test/workflows/reportDeps.test.ts` · `workers/sync/specs/flecon.md` (§6a) ·
`app/(app)/inventory/flecon-bags/CONTEXT.md` · `CLAUDE.md` · `types/supabase.ts`.

**Verification:** migration applied live via MCP and seeded (2026-01-31, 5 movements, net
+231, audit `a6293bf8-…`) · the 5 backfill rows still present · balances ECOPACK_BEIGE 100 /
FG_ALL_BLACK 156 / KOREA_WHITE_SUNDRY 282 / ZAMBOANGA_BAG 160 · worker `npm run typecheck` ✓ ·
`npm test` **586/586** ✓ (was 566) · `npm run parity` **12/12** ✓ · root `npx tsc --noEmit` ✓.

**Note for the next agent:** settlement is a **one-way ratchet**, same accepted edge case as
`rc_out_date_settlements` — a later correction to a settled date needs a manual `DELETE FROM
flecon_bag_date_settlements`. No new `HeldKind` was added (the enum is frontend-locked).
