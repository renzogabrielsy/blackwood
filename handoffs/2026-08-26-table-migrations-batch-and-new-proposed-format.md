# 2026-08-26 — Seven table migrations live, sync hardening, and the new PROPOSED format

> Continues `2026-08-17-universal-table-stage-1d-slices-1-2.md`, which ended with slices 1–2 of
> the first migration. This handoff spans several working days (08-18 → 08-26): the module became
> a product, seven screens migrated, the sync gained the ack ledger + three hardening fixes, and
> Renzo introduced a new employee report format that is NOT yet implemented on the worker side.

---

## TL;DR

**Seven screens are fully "table migrated"** (Renzo's term — memory `table_migration_definition.md`:
v2 default + inline editing + period controls, one `feat/<screen>-v2-default` branch per screen):
ICTC RC IN, RC OUT (editing still pending), Cenapro QC, Cenapro Deliveries, ICTC Production
Daily / Electricity / Trucks. All live on `main` @ `9bbb9cf`, Vercel deployed. **Renzo is now in an
observation window — "let's observe these the next few days."**

**The next concrete action is NOT code**: wait for Renzo's testing feedback. The next *build*
actions, in his stated priority: (1) RC OUT inline editing (pattern = RC IN's), (2) the new
PROPOSED-format sync work (proposed and approved in principle, NOT built — see below),
(3) RC Movement flip + Cenapro Production ledger when he calls them.

---

## What shipped this span (all merged to `main`, all deployed)

### The table module became "a mini product" (branch `feat/universal-table`, retired)
- Default-on everywhere: right-click menu (mutating items ABSENT on read-only cells, not
  disabled), the bottom-right SUM/AVG/COUNT pill (published by `BlackwoodTable` itself via
  `useOptionalStatusBar`), one-box selection (perimeter border, no inner borders; anchor ring
  suppressed inside multi-cell), column resize (session-local without `onSettingsChange`),
  universal sort/filter (focus ON, endless OFF — chrome rows hide while a sort/filter is active),
  cells clip (`overflow-hidden`; a bare-string `format` clips without ellipsis — wrap in `<span>`).
- Seams: `ColumnSpec.cellClass` (whole-cell tint, merges UNDER state tints), `rowCopy: false`,
  `onHeaderClick`, `subLabel`, `headerWrap`/`labelNode`, `sizing: 'fill'` (slack distributed
  INSIDE `useTableColumns` so sticky offsets derive from rendered widths — the stretch-overlap
  bug's real fix; `'content'` default), `renderHeaderSlot`, per-cell `addressable`.
- Retired v2s: Flecon Bags (ICTC) and Cenapro Flec Inventory — Renzo: "too niche."
- RC Movement v2: headers pixel-match the live matrix (batch over block-loc via `subLabel`),
  header click opens `BlockingDetailPanel` (the existing production panel — its write paths gate
  themselves; mounted on Renzo's explicit instruction, reasoning recorded at the mount site).
  **Flip deliberately NOT done** (Renzo: leave it for now).

### The migrations (each on its own branch, each merged + deployed)
- `feat/rc-in-out-v2-default` — RC IN + RC OUT flip; RC IN inline editing (whole-row saves via
  `bulkUpdateDeliveries`; the lab-panel shallow-merge trap — `to_jsonb(d) || v_data` — means the
  FULL `lab_results` panel is always reassembled; a price-blind role cannot save AT ALL, by
  design, until a partial-patch action exists); shared `PeriodPicker` (`?year=&month=`, absence =
  page default, `all` always explicit).
- `feat/qc-ledger-v2-default` — QC flip + editing (metrics route to the GROUP with `rowVersion`
  CAS whatever row they were typed on; WT per draw; `overlayMetrics` because the RPC REPLACES the
  reading; drafts through `cenapro_add_partner_draw` with `draw-entry-rows.tsx`'s own validators
  called verbatim); the `?m=` ⇄ `?year=&month=` dual URL grammar with a one-hop canonicalising
  redirect entering the v1 branch; **columns rearranged to the production ledger's exact order**
  (muscle memory — `QC_COLUMNS` in the pure save module, asserted against production's `COLS`
  parsed OFF DISK; `#` and BATCH imported as un-typeable placeholders).
- `feat/cenapro-deliveries-v2-default` — flip + scope toggle + `PeriodPicker` in the bar's
  trailing slot (built in an agent WORKTREE while the main repo held another branch — the
  guardian committed from the worktree and gated on the merge commit).
- `feat/production-tabs-v2-default` (current branch) — Daily/Electricity/Trucks editing + flip
  (ONE branch for three tabs — they share one page; a stated deviation from one-branch-per-screen).
  Daily: run figures → run row, downtime/waste → the SHIFT's single row (walk-to-primary,
  asserted); refuses identity edits on saved rows, grade 4X8, shift-field disagreement between
  two rows of one shift. `saveBulkDailyLedger` is NOT transactional → the failure toast says
  "shifts before the failure are already stored — reload", never "nothing was written".
  Electricity/Trucks: staged-not-transactional actions, whole-row payloads (the end≥start
  "constraints" the error translator names DO NOT EXIST in any migration — the plan enforces
  them), natural-key collision sweep pre-flight. **`onSaveSuccess={onRefresh}` is load-bearing on
  all three views** — the tabs hold rows in client state, so `router.refresh()` cannot repaint a
  save; the wire-up was done in-session after both editing agents flagged it.

### Sync work (branch `feat/sync-rc-in-recovery`, merged)
- **The ack ledger** (`sync_finding_acks`, migration `20260819025647`): append-only, two locks
  (no UPDATE/DELETE grant AND no policy — note Supabase default-privileges required an explicit
  `REVOKE ALL` first or "append-only" is a comment). The sync NEVER reads it to decide what to
  REPORT — filtering happens at the glass. `findingIdentity(f)` in `lib/sync/findings.ts` is the
  one fingerprint+content_hash definition (portable SHA-256 in `lib/sync/portable-hash.ts`,
  differential-tested against `node:crypto`). Decision cards in the panel: [Acknowledge],
  [Same truck], [Keep mine], [Take the source] (→ `releaseDeliveryRows` over
  `fn_release_delivery_rows` — writes NO delivery data, clears the stamp). Hide-until-changed:
  a card returns with "CHANGED SINCE YOU LOOKED" when its content hash moves.
- **BUG-026**: Stop now tears down the Gmail socket (abort gate in `gmailSession.ts`; cancel
  aborts BEFORE `DBOS.cancelWorkflow`); one run at a time (`runGate.ts`); slow Gmail search = a
  finding (45s budget), never an abort. Fly deploys v18/v19.
- **BUG-027**: a batch-location conflict (23505 on `idx_unique_active_batch_per_location`) is a
  HELD row (`batch_location_conflict`), not a crash killing the whole gsheet write. The
  plain-language sweep: all 16 apply-error sites lead with an operator sentence
  (`lib/operatorError.ts`), raw DB text one line down. Renzo: "these errors have to be way more
  understandable to a normal user" — that is now a standing bar for ANY user-facing sync text.
- **L-044** (earlier in span): the worker could not read `view_digest_stream_status` /
  `view_digest_unpriced_deliveries` (grant gap across the `security_invoker` closure) and bare
  catches turned 403s into "nothing to report" — BOTH sync alarms had never fired. Fixed +
  `scripts/verify-worker-view-grants.ts` guards it by READING as service_role.

---

## Critical learnings (non-obvious, worth not re-deriving)

1. **The live Daily ledger has THREE silent data losses** (found building v2, still live in
   Classic): downtime edits have NEVER saved (`shift_hrs: null` gates the whole write),
   `sacks_bags` (102 rows) and waste remarks (63 rows) are NULLED on every save. A task chip was
   filed. v2 preserves all three. Also: **19 stored runs are grade `4X8`**, which
   `saveBulkDailyLedger`'s `VALID_GRADES` refuses though the DB allows it — in Classic one such
   row makes a whole period unsaveable; ask Renzo whether 4X8 is legitimate (one-line fix).
2. **Client-state tabs cannot be refreshed by `router.refresh()`** — any v2 grid mounted under a
   lazy tab that fetches via server-action-into-useState NEEDS `onSaveSuccess={onRefresh}` or a
   save reads as lost. Pattern to check on every future migration.
3. **The flipped-page registry conflict is STRUCTURAL** — every v2-default branch adds one entry
   to `scripts/verify-table-core.ts`; two branches in flight = one guaranteed merge conflict
   whose resolution is the union, and the registry scan itself proves the union right.
4. **`tail -1` lies about the verify scripts** — `verify-daily-grid` and
   `verify-electricity-trucks-grid` print their summary BEFORE a trailing blank line; grep for
   "assertions" instead.
5. **Lint baseline bookkeeping**: the canonical number is `npm run lint` at the repo root with no
   stale worktrees present — 167 problems / 28 errors (the +1 over 166 is the untracked
   `workers/sync/dist` artifact). Agent worktrees under `.claude/worktrees/` pollute it into the
   thousands; remove them (`git worktree remove`) before measuring.
6. **A NUL byte inside a template literal** is invisible and survives review — the
   electricity/trucks verify script now scans its subject files for control characters.

---

## The NEW PROPOSED format (proposed, approved in principle, NOT BUILT)

Renzo restructured the employees' PROPOSED DAILY REPORT (sample:
`~/Documents/1A WORK FILES/260824 PROPOSED DAILY REPORT.xlsx`) and instructed Ivy, MC, Pretchel
and Angel to prefix filenames with the report date as `YYMMDD` (e.g. `260824`).

**What the file changes:** layout is IDENTICAL to the old format (extractor reads cached formula
values → zero extraction change needed). The per-section header (B3/B12/B21/B30/B39) is now a
FORMULA: `UPPER(TEXT(BLOCK_DATE,"mmm-yy") & "-BLK" & TRIM(SUBSTITUTE(BLOCK_NO,"#","")))` — kills
the L-042 shorthand class at the source. The workbook appears month-scoped (August tabs only).
It also carries machine-readable close signals (`REMARKS: DONE`, `DONE FEEDING — <supplier>`,
per-block MC/ASH) — the PROPOSED-side witness the closure-reconciliation vision (BUG-011) lacked.

**Agreed with Renzo but NOT yet in his file:** the FEED fix — the formula should branch on the
WHSE # cell: `IF(ISNUMBER(SEARCH("FEED",B5)),"-FEED","-BLK")` (SEARCH = case-insensitive
substring, so FEEDING AREA / FEEDING all match; DB feed convention is already 3-letter `AUG-` so
`mmm` matches exactly). A three-tier RECOOKED variant was offered; **Renzo has not yet said
which variant he adopted** — the sync's header cross-check must encode the SAME rule, so confirm
before building.

**The implementation plan (proposed to Renzo, he said "let's observe these the next few days"):**
1. Verify/extend `batchCodeFallbacks` covers ALL 12 month-prefix pairs (formula emits `mmm`:
   JUN/JUL/AUG/MAR/SEP; DB mixes JUNE/JULY/AUGUST/MARCH/SEPT) — the safety net; without it a
   formula-named new batch and a Sheet-named one become duplicate batches.
2. Mail clerk: optional leading-`YYMMDD` filename parse → freshness witness (newest-file
   tiebreak beats email recency; stale-filename finding). Never required (legacy files).
3. PROPOSED extractor: re-derive expected header from BLOCK DATE + BLOCK NO + WHSE rule, compare
   to the header text, `attention` finding on mismatch (catches overtyped/dead formulas). Header
   still wins for extraction.
4. (Later) DONE-marker close corroboration — informational only, never auto-close from one witness.
All worker-side → **needs a Fly deploy** (`cd workers/sync && npm run deploy` after merge).

**Open questions for Renzo:** FEED/BLK vs RECOOKED formula variant; is the workbook now
fresh-per-month; which report does Angel send.

---

## Current state / open items

- **Working, live, in Renzo's observation window:** the seven migrated screens.
- **RC OUT editing** — not built; the RC IN pattern (`rc-in-grid-v2-save.ts`) is the template,
  `fn_bulk_update_usage` the existing save path. First build action when Renzo confirms RC IN.
- **Not migrated by choice:** RC Movement (flip pending Renzo's eye test), Cenapro Production
  ledger (last heavyweight), Blocking (never), the W6/W7 pivots (module can't express merged
  rowSpan — documented), liquidation/read-only tables (out of scope).
- **Sync watch-fors:** the D-20D held delivery (`AUG-26-BLK11` wants D-20D; `JUNE-26-BLK6` was
  IN-USE there — by Aug-24's tab it fed down to 557 kg with REMARKS "DONE", so the Sheet's
  close-scan should free it within days and the held row files itself; Renzo said DO NOT close it
  manually). The four ₱0 deliveries from 08-14 re-priced when the fixed price-file matcher ran.
  The flecon fail-open `catch { settledDates = new Set() }` chip
  (`workers/sync/src/reports/flecon/index.ts:321`) is still open — fail-closed fix approved in
  principle, not built.
- **Cosmetic/platform debt:** `cellClass` dark-mode variant can beat the selection tint (documented,
  small); `TableSummaryRow.cells?` / `ColumnSpec.group` header-band seams still unbuilt.

## Git state

- `main` @ `9bbb9cf` — everything above merged; Vercel production deployed from it; Fly worker on
  v19 (`7edd55b` stamp — nothing under `workers/sync/` changed since).
- Current branch `feat/production-tabs-v2-default` @ `3a0e1fd` (one `chore(memory)` ahead of its
  merged state — rides along on any next promotion). All migration branches pushed; none deleted.
- Standing dirty files (never commit): `.claude/agent-memory-local/**` ×2, `supabase/.temp/cli-latest`.

## Next concrete action

**Nothing to build until Renzo reports back.** When he does: (a) his verdict on the migrated
screens → RC OUT editing next (`feat/rc-out-editing` or fold into the existing branch pattern);
(b) his formula-variant answer + a few days of employees actually sending `YYMMDD`-prefixed
files → build the three-part PROPOSED-format plan above on a `feat/sync-*` branch, remembering
the Fly deploy. If a sync misbehaves meanwhile: the runbook is `sync_runs` → `sync_run_events`
(column `at`, not `created_at`) → Fly logs → the stored workbooks in the `sync-inbox` bucket
(`<runId>/<key>/`), and the gsheet is downloadable unauthenticated via the file id in
`workers/sync/src/reports/gsheet/download.ts`.
