# 2026-08-26 — Cenapro QC/flecon feedback batch + the flecon stale-email jam

> Same day as `2026-08-26-table-migrations-batch-and-new-proposed-format.md` — this is the
> observation-window feedback session. Renzo's four asks, verbatim: (1) QC ledger columns he
> "can't seem to manipulate/edit (specifically the empty ones below where we add entries)";
> (2) QC ledger cell coloring "SAME AS prod ledger" + "allows us to add entries pertaining to
> flecon bags (as in adding into our inventory, not just partner draws)"; (3) "cenapro flecon
> bag doesnt give us the option to add grades"; (4) "look into flecon bag sheet of ictc as
> well as i believe it isnt properly syncing all the columns."

Branch: `feat/cenapro-qc-flecon-fixes` (off `main` @ `b1dde47`).

---

## TL;DR

All four are done. (1) was a real platform mouse-gate bug plus two invisible imported lanes,
fixed at both layers. (2a) QC v2 now paints PLANT/MACH badges exactly as the production
ledger does. (2b) `cenapro_add_partner_draw` now accepts MACH=FLEC → a `flec_bagging`
production event (an inventory IN) from the QC ledger — DB, server action, composer and v2
sheet all wired, with FOUR client guard sites lifted (the fourth, `qc-grid-v2-save.ts::
machineCodes`, was a validator that would have refused what the DB accepts). (3)
`public.cenapro_grades` + `cenapro_add_grade` (INSERT-only) + an Add-grade popover on the
Flec Inventory STARTING block; every grade list is now dimension-driven with `GRADE_CODES`
merged UNDERNEATH as a monotone floor. (4) **ICTC flecon data was never out of sync** —
every column reconciles exactly; the real problem was a permanently jammed stale email
making every run `partial`, fixed worker-side (BUG-028) + the settled-dates read is now
fail-closed (closes the fail-open chip at `flecon/index.ts:321`).

## What shipped

### QC v2 blank-row editability + coloring (frontend)
- Root cause, proven by browser reproduction on a throwaway dev route: all 15 typeable
  lanes were fine; the two IMPORTED lanes (`#`, BATCH) (a) painted NOTHING on a blank row
  (`Row.tsx` renders `format` only with row data) so they looked like broken empty cells,
  and (b) a **platform bug** — a click on a non-addressable/non-selectable cell parked the
  caret without moving the selection, so two rectangles showed and Delete/copy/paste acted
  on the old cell. Fixed in `lib/hooks/use-table-interaction.ts` (no caret from a click on
  a cell that is neither addressable nor selectable; a click on other non-selectable
  columns clears the selection) + `importedCellClass` in the QC grid paints the two lanes
  on blank rows via `cellClass` (the ONE seam that fires with `row === null`).
- Coloring: production v2 badges exactly two lanes — PLANT (`plantBadgeClass`) and
  CCC/FLEC (`cccFlecBadgeClass`); QC now mirrors both through the documented lane mapping
  (`ccc`⇄`mach`), plus the same mono/bold plain treatment elsewhere. One color source:
  `app/(app)/cenapro/badges.ts`.

### Flec bagging from the QC ledger (DB + full client)
- Migration `20260826071705_cenapro_qc_ledger_flec_bagging.sql`: MACH aliases
  FLEC/BAG/BAGGING/FLEC BAGGING/FLEC_BAGGING → `flec_bagging` + NULL equipment. Bag
  fields follow the DIRECTION: `needsBags = bagging OR source-FLEC` (warehouse WHSE
  1/2/5/7 + flec_count required, side optional w/ notice). SRC=FLEC + MACH=FLEC refused
  (`invalid`, a self-loop that would double-count in `flec_ledger`). Blank machine stays
  `wrong_surface`. Everything else (batch/plant/dates/duplicates/audit `qc_ledger`)
  unchanged. Proven live-then-ROLLBACK incl. `flec_in` visible in `cenapro_flec_ledger`.
- Client: THREE guard sites in `qc/actions.ts` share one `needsBagFields`; ONE alias
  definition `isBaggingMachine`/`BAGGING_MACHINE_CODES` in `lib/cenapro/ccc-analysis.ts`
  (+ `BAGGING_MACHINE_CODE = 'FLEC'` — the offer vs the five-spelling accept);
  composer MACH offers FLEC last; **fourth site** `machineCodes()` in
  `qc-grid-v2-save.ts` widened so the v2 MACH cell accepts what the DB accepts.
- NOT built, deliberately: a confirm on `already_exists` — `unique_tag` excludes weight
  and flec_count, so `p_allow_duplicate` cannot rescue that collision (recorded in
  CONTEXT.md).

### Grades addable + dimension-driven (DB + Flec Inventory + QC options)
- Migration `20260826072202_cenapro_grades_accessor_and_add.sql`:
  `public.cenapro_grades` (SELECT-only accessor) + `public.cenapro_add_grade` (INSERT-only,
  codes canonicalized via `fn_canon_token` so `3x50` can never open a second grade; no
  update/delete RPC — grade_code is a text FK on all production events).
- Flec Inventory: grade rows data-driven (server-fetched, threaded down), Add-grade
  popover on the STARTING grid header (code + optional display name; refusals =
  the RPC's own sentence via `errorToast`), amber degraded banner on a failed grade read
  (kept OUT of `loadError` so the page never claims to be broken when only the list is
  short). `OpeningBalanceCellChange.grade` widened to `string`.
- `loadQcDrawOptions` reads `cenapro_grades` in parallel with the fact table;
  **`GRADE_CODES` is a FLOOR merged underneath, never replaced** — the grade list is the
  QC sheet's VALIDATOR, so its failure mode must be monotone (a degraded read can only be
  as permissive as before, never stricter). Pinned by `verify-qc-draw-cells` check #46.

### The flecon "not syncing" investigation + worker fix (BUG-028)
- Measured: every bag column's balance matches Ivy's freshest workbook exactly (running
  balance row Q=222/R=367/V=207 == DB). Columns C–X all map; Y–AC empty. Nothing missing.
- The actual symptom: Ivy's 08-24 email (uid 126413) kept being re-fetched — its workbook
  tops out 2026-08-21 vs DB watermark 08-25, the `stale_workbook` gate correctly refused
  it, and because the gate failed it was never labeled processed → re-refused on EVERY
  run → every run `partial` since 08-25.
- Worker fixes (`workers/sync/src/reports/flecon/`): (1) a STRICTLY-older attachment is
  labeled processed after refusal (nothing written; seen once as `partial`, then never
  again; null-max workbooks deliberately keep firing); (2) the gate message names the
  whole-sheet max date (`wholeSheetMaxDate()`, out-of-year rows excluded) instead of
  "(no dated rows)" — comparison now correct by construction, not coincidence; (3) the
  settled-dates read FAILS CLOSED (refuse the whole flecon report, never proceed with an
  empty settled set that replace-by-date could delete through) — closes the fail-open
  chip; recording a NEW settlement stays best-effort. Specs/RUNBOOK/BUG_LEDGER updated;
  worker tests 57 files / 861 pass; parity 3/3 clean; container-build gate OK.

## Critical learnings
1. **A closed-domain cell list is a validator before it is a picker** — widening the write
   path without widening the list refuses rows the database accepts. Bit twice in one hour
   (machines in `qc-grid-v2-save`, grades in `loadQcDrawOptions`). Candidate CLAUDE.md
   line — Renzo to accept/reword/drop (deliberately not added by agents).
2. **`ColumnSpec.cellClass` is the only seam that paints a draft row** (`format` never runs
   with a null row) — any future column read-only-on-blank hits the same invisibility trap.
3. A refusal path that skips labeling turns one bad email into a permanent `partial` — the
   L-044 shape again: the alarm was true once and then became pure noise.

## Open / next
- **Fly deploy required** for the worker fix: `cd workers/sync && npm run deploy` (done
  this session if the deploy line in the final report says so — otherwise IT HAS NOT
  SHIPPED and runs stay `partial`).
- Renzo to eyeball live: QC blank-row entry incl. MACH=FLEC bagging (needs login — not
  browser-verified), the Add-grade popover, badge coloring.
- rc_movement `serious` drift (1 date) also contributed `partial` on 08-26 runs — a real
  reconciliation alarm for the Sync panel, untouched by this session.
- The proposed CLAUDE.md validator-vs-picker line (learning 1) awaits Renzo's call.
