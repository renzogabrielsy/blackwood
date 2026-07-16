# Handoff — 2026-06-05 — Sync Digest Dashboard + Editable Daily Block Pivot (write-back) + June ICTC Sync

> **For the next session.** If the user says **"view latest handoff file"**, "where did we leave off", or "what's the current state", read this first.
>
> **Lineage:** continues `2026-06-04-ictc-sync-lean-validated-rc-movement-matrix.md`. That handoff's open items (L-009 audit grant, block-loss sign) were NOT the focus this session — they remain open/minor. This was a large feature + sync session.

---

## TL;DR

Three big things shipped, all committed + pushed to `origin/dev` (5 commits, tree clean):
1. **Replaced the modular widget dashboard at `/` with a "Daily Sync Digest"** — a stacked operational + sync-health view fed by new `view_digest_*` SQL views. The old widget system was **archived, not deleted** (`_archived/dashboard-v1/`).
2. **Built the Cenapro "Daily Block" pivot view** (`production-daily-block.tsx`) — rebuilds the bosses' PROD-2026 spreadsheet (W6/W7 variants), then made it a **fully editable pivot that writes back to the ledger** (`cenapro_production_events`) via the EXISTING `saveProductionEvents` action — no new backend. Plus spreadsheet keyboard nav + active-cell highlight.
3. **Ran the gsheet-first ICTC sync** — DB now **current through June 4** (RC IN, RC OUT, Production), and resolved two historical data-integrity issues per the source sheets.

**Next concrete action:** nothing is mid-flight. Pick from the open follow-ups: enable RLS on the 7 exposed production tables (task chip filed), or fix the root-cause extractor bug (it derives the wrong batch from block-dates and needs a remap every sync — task chip filed). Also 3 uncommitted agent-memory/ledger files should be committed (see Git state).

---

## What shipped

### A. Sync Digest dashboard (commit `4b9f6e7`)
Replaced `app/(app)/page.tsx` (was the ReactGridLayout widget grid) with a server-rendered digest.
- **New data layer:** `lib/digest/types.ts` (the `DigestData` contract), `lib/digest/queries.ts` (`getDigestData()` — server-only, shapes the views). All aggregation in SQL.
- **New SQL views** (migration `supabase/migrations/20260604000000_create_digest_views.sql` + a follow-up windowing/sundry migration): `view_digest_daily_flow / _daily_price / _grades / _daily_production / _daily_power / _operational_days / _stream_freshness / _mtd / _audit_enriched / _latest_sync*`, plus **`view_supplier_deliveries`** (canonical "real supplier purchase" = excludes SUNDRY source/batch + cost_basis>0).
- **New UI:** `components/digest/*` (digest-header, kpi-hero, digest-charts, sync-summary, activity-feed, digest-footer-band, format.ts). Rewrote `app/(app)/CONTEXT.md`.
- **Archived (git mv, NOT deleted):** `components/dashboard/`, `components/widgets/`, `lib/widgets/`, `lib/dashboard/`, old top-level `app/(app)/actions.ts` → `_archived/dashboard-v1/` + `_archived` added to tsconfig exclude. `react-grid-layout`/`recharts` kept installed.

### B. Cenapro ledger UX (commit `543ced5`)
`app/(app)/cenapro/production/`:
- **Bulk-add Excel date auto-format** — `lib/paste-utils.ts` `normalizeTypedDate(input, defaultYear)` ("6/2"→"2026-06-02"); wired into `bulk-add-modal.tsx` on Tab/Enter/blur; year from `selectedPeriod.batch_year`.
- **Enter-anchor keyboard nav** in `bulk-add-modal.tsx` (Tab run remembers its start column; Enter returns to it on the next row).
- **Warehouse-first row highlight** in `production-ledger-grid.tsx`: RED = withdrawal from a real warehouse, BLUE = WHSE 3 (DVO), NONE = unplaced. Priority: **Unplaced > WHSE 3 > disposition**. (Was disposition-only before.)
- NOTE: the Daily Block's **view-mode switcher** also lives in `production-ledger-grid.tsx` but landed in this commit (shared-file hunk).

### C. Daily Block pivot view + editable write-back (commits `57b0e50` = view, `60663a3` = nav+highlight)
`app/(app)/cenapro/production/production-daily-block.tsx` (the session's biggest file, ~900 lines).
- **View-mode switcher** `?view=ledger|daily-w6|daily-w7` (legacy `?view=daily`→`daily-w6`). W6 sources = TNK 1-4 + W6; W7 = W7. **FLEC/DVO excluded** (production OUTPUT only).
- **Pivot layout** (rebuilds PROD-2026): PROD_DATE → SHIFT → GRADE → SOURCE → **RECV DATE** (each leaf = one "pull"). Real `rowSpan` merges on Date/Shift/Grade/Source. Source shown once, recv dates stacked chronologically. Fixed equipment columns (always C1-C4, RK1-RK4) + Bagging + Sub + Total, grouped headers (Crushers|Kilns|Bagging|Totals). Excel column widths, uniform `ROW_H` (h-7), 2-tier header (identity `rowSpan=2`), 1px gridlines + 2px soft day-box, per-day footer total, hover "add row" drawer, MIN_DAY_ROWS=6 padded rectangle.
- **EDITABLE (Phase 1 + 2)** — writes back via the EXISTING `saveProductionEvents(dirtyRows, deletedIds)` (contract: `.agents/notes/daily-block-writeback-contract.md`). Phase 1: edit/clear/insert numbers on existing rows; column-aware popover (crushers/kilns → Source; bagging → Source+Warehouse+Side+Flec); `plant_code` auto-stamped from the view. Phase 2: editable filler rows = new pulls (typeahead identity + weights), add-day affordance. Collision cells (>1 event for the 9-col key) locked 🔒.
- **Keyboard nav** via a `data-navid` DOM registry: Tab/Shift+Tab/Enter (with Enter-anchor)/arrows/Esc; **active-cell highlight** `ring-2 ring-primary ring-inset z-20` (matches the ledger).
- Excel-fidelity: typeahead identity cells (native `<datalist>`, NOT `<Select>`), placeholder clears on focus, `EDIT_INPUT` contract so editing never changes row height.

### D. ICTC data sync (database-only, no commits — see "Critical learnings")
gsheet-first, **parallel named agents** (gsheet-sync + deliveries-manager + rc-out-manager + production-manager + rc-movement-auditor), PROPOSE → approve → EXECUTE, **no Workflow tool**.
- **RC IN:** 8 deliveries (June 3-4), **5 new batches** JUNE-26-BLK1/2/3/FEED1/FEED2, all priced (₱38-40.50).
- **RC OUT:** 5 feeds (June 3-4), reconciliation **0 kg drift**. 3 feeds needed a **batch remap** (extractor derived a closed block-date batch; used the active slot occupant — see learnings).
- **Production:** 2 shifts + run/downtime/2×waste/electricity/2×trucks. Truck watermark unstuck 5/26→6/03.
- **2 data-integrity fixes (per the sheets):**
  - **FEB-25-BLK8** (2025-04-30): seed-import **duplicate** (two identical 2,336 rows 0.13s apart) → deleted one, corrected survivor to **7,306** (Sheet truth), APRIL/null.
  - **May-26 MAY-26-FEED5 misattribution:** the 5/30 gsheet run posted two feeds onto the already-closed FEED5 (drove it −19,827). Reassigned 5/27 feed (13,330)→**MAY-26-FEED6** (balances 0); deleted a 6,000 wrong-weight duplicate + reassigned 5/26 feed (6,497)→**MARCH-26-BLK3**. **5/26 now totals 45,167 = operator RC MOVEMENT exactly; FEED5 = 0.**
  - **Backend resync** of stale cached `current_weight`: MAY-26-FEED5→0, MAY-26-FEED6→0, MARCH-26-BLK3→3,540 (migration `resync_current_weight_post_rc_out_reassign_jun`).
- New ledger entries **L-010** (extractor wrong-block-date batch → prefer active slot occupant), **L-011** (FEED misattribution: reassign by source feed-area row, halt on quantity conflict), **L-012** ("follow the sheets" resolution: delete wrong-weight row + reassign source-weight row, DELETE only with explicit approval).

---

## Critical learnings (highest value)

1. **PostgREST caps reads at 1,000 rows by default.** The digest's `view_digest_daily_flow` emitted 2,163 rows (2020→2026); only the first 1,000 (ascending = oldest) came back, so the chart showed **March 2023** and the KPI lookups for the current day returned 0/flatline. **Fix: window the views in SQL** (trailing 120 days anchored to the operational/max-data date, NOT `CURRENT_DATE` — data lags). Any view that can exceed 1,000 rows MUST be windowed or paged.
2. **"Editable pivot" is tractable because the pivot grain ≈ event grain.** Of 760 `(batch_year,batch,prod_date,shift,grade,source,recv_date,disposition,equipment)` cells, only **5 map to >1 event** (4 are FLEC, excluded from W6/W7) → ~1 collision cell in the editable views (locked). So a pivot cell = one ledger row; edits map deterministically to insert/update/delete via the **existing** `saveProductionEvents`. No new backend. `unique_tag`/`batch_year` are filled by a BEFORE-INSERT trigger (`fn_set_unique_tag`), so a pivot INSERT needs nothing the cell can't supply. Full contract: `.agents/notes/daily-block-writeback-contract.md`.
3. **"Weird black outline on some cells" = `border-foreground` (near-black) on the day-box.** Frozen/pivot tables: the day-outline must be `border-border` at 2px (stand out by WEIGHT not COLOR). Never `border-foreground/*` on cell edges.
4. **No-height-expand-on-edit:** an inline `<input>` must match the static cell's exact `text-[11px] px-1.5 leading-none`, `bg-transparent border-0 outline-none focus:ring-0 h-full [min-height:0] appearance-none`. Otherwise the row jumps taller when the caret appears. Codified as the `EDIT_INPUT` constant.
5. **Excel typeahead = native `<datalist>`, not a `<Select>`.** Type-to-filter, free text, no dropdown chrome — matches the bulk-add pattern. Placeholders must be cleared on focus (native ones persist until a keystroke).
6. **The extractor keeps deriving the WRONG batch** from a block's date/number when the physically-active slot occupant is a newer batch (root cause of the 3 RC-OUT remaps AND the FEED5 misattribution). Recurs **every sync**. Task chip filed to fix `extract_proposed_daily.py` to prefer the active slot occupant. L-010.
7. **`current_weight` cache drifts on DELETE/reassign of CLOSED batches** — the maintenance trigger only re-fires on fresh INSERT. The transaction balances stay correct; only the cached column lags, and `view_blocking_grid` reads it. Resync = `UPDATE batches SET current_weight = SUM(in)−SUM(out)` for the named batches. This has now happened twice → task chip filed for a reusable resync RPC.
8. **"Follow the sheets"** is the user's tie-breaker for data conflicts — make the DB match the source feed/movement sheets, including deleting a wrong-weight DB row in favor of the sheet's single correct row (L-012).

---

## Current state

### ✅ Working / verified
- **`tsc --noEmit` + `npm run build` clean** after every change. 5 commits pushed to `origin/dev`, tree clean (except 3 agent-memory files — see Git state).
- **Digest** live at `/`. **Daily Block** live + editable (Phase 1 + 2), keyboard nav + highlight. (UI verified by build + payload traces; the user eyeballed it live across many iterations and approved.)
- **DB current through June 4** (RC IN, RC OUT, Production). All reconciliations 0-drift. The two data-integrity fixes verified (5/26=45,167, FEED5=0, FEB-25-BLK8=7,306). `current_weight` resynced for the 3 touched batches.

### ⚠️ Deferred / known issues (none blocking)
- **RLS disabled on 7 production tables** (`production_*`, `electricity_readings`, `truck_readings`, `ingestion_watermarks`) — exposed to anon key. Task chip filed (enable RLS + add authenticated SELECT policies matching deliveries/rc_out).
- **2 more current_weight-drifted CLOSED batches** (FEB-26-BLK23, JAN-26-SUNDRY7) — flagged, untouched (hidden from Blocking since closed).
- **Extractor wrong-block-date-batch bug** — recurs every sync; task chip filed.
- **No audit trigger on any cenapro table** — editable-pivot writes produce no `audit_logs` (the email agents write audit rows manually via MCP per L-009).
- **Cross-year `batch_year` edge** in pivot inserts — trigger derives year from recv_date; harmless for same-year periods, would mis-bucket a Dec-batch-received-in-Jan. `ProductionEventDirtyRow` has no `batch_year` field to override.
- **Daily Block Phase-2 polish (optional):** filled draft cells don't show the blue "staged" ring that Phase-1 inserts do.

---

## Open decisions
- Whether/when to enable RLS on the 7 tables (security).
- Whether to build the reusable `current_weight` resync RPC + fix the extractor root cause (both task chips) vs keep hand-fixing.
- Carried over from 2026-06-04 (minor, untouched): L-009 audit_logs grant for the lean gsheet apply path; the RC-Movement-matrix block-loss sign.

## Next concrete action
No work is mid-flight. Highest-value next steps, in order: (1) **fix the extractor wrong-batch derivation** (`extract_proposed_daily.py` — prefer active slot occupant over block-date code) to stop the per-sync remaps; (2) **enable RLS** on the 7 production tables; (3) commit the 3 uncommitted agent-memory/ledger files. Lower priority: reusable current_weight resync RPC, Daily-Block staged-ring polish.

## Git state
- **Branch `dev`** — pushed, in sync with `origin/dev`, **working tree CLEAN (all committed)**.
- This session's commits: `4b9f6e7` (digest) · `543ced5` (ledger UX) · `57b0e50` (daily block) · `b37a681` (chore + june-sack-projection.pdf) · `60663a3` (keyboard nav + active-cell highlight) · `81aa530` (docs: this handoff + TIMELINE + sync ledger learnings L-010/011/012 + agent-memory).
- The ICTC sync was **database-only** (Supabase writes) — no app-code changes; the agent learnings it produced are committed in `81aa530`.

---

*End of handoff — 2026-06-05 — Sync Digest dashboard shipped, Cenapro Daily Block built into a fully editable round-trip pivot (the "type into a pivot, it lands in the ledger" feature), and the June ICTC sync landed the DB through June 4 with two source-driven data-integrity fixes. Next: extractor wrong-batch fix + RLS.*
