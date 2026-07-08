# Reconcile — Sync Reconciliation Model (R1)

## Purpose
The pure, standalone reconciliation engine for the multi-source sync model
(`SYNC_RECONCILIATION_MODEL.md` → phase **R1**; `CLAUDE.md` → "Sync Integrity —
Multi-Source Reconciliation"). **No ingest source is authoritative.** This layer takes the
extracted **source records** for one table from every witness, compares them per natural
key + field, and emits **agreements** (auto-appliable) vs **`source_diff` descriptors**
(human-arbitrated). It NEVER picks a winner — a recommendation is advisory only.

R1 is **pure + deterministic**: no DB, no writes, no worker wiring. R2 persists diffs as
`source_diff` cases; **R3a** (shipped 2026-07-08, app-side) resolves them — a reviewer PICKS which
source is authoritative and the pick becomes per-leg `rc_out` writes + a `pick_source` ruling (see
below); R3b (frontend) renders the pick UI. **R4b** (shipped 2026-07-08) is the CUTOVER — gsheet
stops writing `rc_out`, this layer becomes the flagging authority, and the window is now the
proposed-span (see the R4b section). Anchored on the **L-037** incident.

## Files
- `types.ts` — `SourceRecord` (input), `Agreement` / `SourceDiff` / `SourceOpinion` /
  `Recommendation` (output), `RcOutNaturalKey`, `ReconcileOptions`.
- `rcOut.ts` — `reconcileRcOut(records, opts?)` engine + `proposedLegsSelfConsistent(legs)`
  Stage-1 helper (mirrors — does not import — `classify.ts::balanceIntegrity`).
- `rcOutStage.ts` — **R2 SHADOW wiring.** The pure bridge from REAL extracted rows to the
  engine: `bucketProposed` / `bucketGsheetRcOut` / `movementSourceRecords` /
  `buildRcOutSourceRecords` / `reconcileRcOutStage`. Buckets each source at the fine key,
  sums `weight_kg`, sets `selfConsistent`, runs `reconcileRcOut`. Also `canonicalBatchKey`
  (aligns month-prefix conventions) and the `ReconciliationChannel` result type (now
  `{ rc_out?, blocking? }` — both optional, so RB can ride alongside rc_out).
- `blockBalance.ts` — **RB engine (block-balance cross-check).** See the RB section below.
- Tests: `../../test/reconcile/rcOut.test.ts` (engine; L-037 golden + edges),
  `../../test/reconcile/rcOutStage.test.ts` (bucketing → engine; L-037 through synthetic extracts),
  `../../test/reconcile/blockBalance.test.ts` (RB engine; two-level check + L-037 conceptual),
  `../../test/reports/gsheet/blocking.test.ts` (the Sheet Blocking-tab extractor).

## Granularity decision (the core R1 call)
**Fine reconciliation key = `(transaction_date, batch, block_loc, destination)`**, reconciled
on the **SUM of `weight_kg`** across every feeding leg at that key.

Rationale: a batch can be fed in multiple legs on one day (L-037: MARCH-26-BLK5 @ D-11B fed
10,813 + 20,932), and legs have no stable identity across sources — per-leg matching is
fragile. The physically meaningful cross-source quantity is "how much did this block get on
this day," which is the leg SUM. It is robust to sources splitting legs differently and it
exactly captures L-037 (proposed 31,745 vs gsheet 42,558).

### Source grains (Step-1 findings)
| Source | Native grain | Fields available to match on |
|---|---|---|
| **proposed** (`reports/rc_out`) | per block-section per day (legs already summed to a block/day `weight_kg`/`day_total_kg`); carries `strt_bal_kg`/`end_bal_kg` → self-consistency | `transaction_date`, resolved `batch_id`/`batch_code`, `block_loc`, `destination`, `weight_kg`, `production_batch`, `remarks` |
| **gsheet** (`reports/gsheet` rc_out) | per row = per (date, batch, destination, block); **no balance columns** | `transaction_date`, `batch_code`, `block_loc`, `destination`, `weight_kg`, `production_batch`, `remarks` |
| **movement** (`reports/rc_movement_audit`) | **per-DATE grand total only** (`date_to_fed_kls`, summed across all blocks + cross-month tabs); NO per-block/per-batch detail | `transaction_date`, `raw_charcoal_fed_kls` |

**Key nuance / flag:** the RC MOVEMENT sheet is **coarser** than the fine key — it has no
per-block detail. So movement does **not** compete at the fine key; it is carried at the
`(transaction_date)` grain and consumed **only as a date-level corroboration witness**. For a
fine weight disagreement on date D, the engine sums each fine source's whole-day rc_out total
for D and checks which matches the movement day total — that source's competing value is
marked `corroboratedBy: ['movement']`. In L-037, proposed's daily rollup matches movement;
gsheet's (over-stated) does not → proposed is recommended, gsheet flagged as the outlier.

## Reconciliation rule (per natural key + field)
- **0 opinions** → skip. **1 opinion** → `Agreement { singleSource: true }`.
- **≥2, all equal within tolerance** (weights: 1 kg) → `Agreement { singleSource: false }`.
- **≥2, disagree** → `SourceDiff` (never auto-applied). Each `SourceOpinion` carries its
  value, provenance, `selfConsistent`, and `corroboratedBy[]` (direct same-key match, or the
  movement day-rollup for the additive `weight_kg` field).

## Recommendation (advisory only)
Emitted **only when exactly one** opinion is BOTH `selfConsistent` AND corroborated. That is
the L-037 shape (proposed passes its balance check and movement corroborates its daily total;
gsheet is uncorroborated). Ambiguous fields get no hint and reach the human bare. Never a
decision.

## Self-consistency
`SourceRecord.selfConsistent` is supplied by the Stage-1 extractor. For proposed it is the
L-037 balance guard (every leg `STRT − END == DAY TOTAL`, within 1 kg). gsheet has no balance
columns, so it is `true` by default (cannot fail a check it lacks). `proposedLegsSelfConsistent`
is a convenience mirror of `classify.ts::balanceIntegrity` for R2 to build the flag with —
`classify.ts` is not modified and its guard is not exported.

## R2 — SHADOW wiring (shipped 2026-07-08)
`rcOutStage.ts` feeds this engine REAL extracted rows and captures the diffs — **observation
only, zero writes.** Agreements are NOT applied (that is R4); Sheet-wins is NOT removed (R4).

**Bucketing** (`buildRcOutSourceRecords`): group the proposed extract's block-sections and the
gsheet rc_out rows into `(date, batch, block, destination)` buckets, sum `weight_kg` per bucket,
and set proposed `selfConsistent` from `proposedLegsSelfConsistent` over the bucket's legs. gsheet
is `selfConsistent:true` (**no balance columns — nothing to check**). Build one movement
`SourceRecord` per date from `date_to_fed_kls` (date-level corroboration witness). Batch identity
is unified by `canonicalBatchKey` (the lexicographically-smallest uppercased alias across
`batch_code_primary` + `batch_code_fallbacks`, so `MARCH-…` and `MAR-…` bucket together).

**Wiring** (`workflows/runSync.ts::reconcileRcOutShadow`, one DBOS step after all reports, before
`finishRun`): re-extracts the three witnesses — proposed + movement from the Mail-Clerk **Storage**
manifest, gsheet **re-downloaded** (it self-downloads in its own report; there is no Storage copy)
— then calls `reconcileRcOutStage`. Chosen over threading rows out of the isolated report
child-workflows because it touches **zero** report classify/apply/extract code (the byte-for-byte
shadow guarantee) and is crash-safe (re-derives from durable sources in its own step). Cost: one
extra Sheet download + two Storage reads per run. The whole step is guarded — **any failure →
absent channel, never a failed run.** Each extraction is independently guarded, so a missing
PROPOSED/MOVEMENT email just drops that witness.

**Result channel** (additive, survives normalizeReport untouched — it sits alongside `reports`):
```
result.reconciliation = { rc_out: { diffs: SourceDiff[], agreements: number } }
```

**App fan-out** (`app/(app)/sync/cases.ts::ensureCasesForRun`): `collectSourceDiffs` folds the
diffs into `sync_held_cases` rows `kind='source_diff'`, `report_type='rc_out'`, `natural_key` = a
human label (`sourceDiffNaturalKey`, e.g. `MAR-26-BLK5 @ D-11B · 2026-06-10 · weight`), `row` = the
full `SourceDiff`, fingerprint = `sourceDiffFingerprint` (hash of `{natural_key, field, sorted
competing values}`; weights rounded to integer kg so jitter doesn't re-alarm). They flow through the
EXISTING run-triage + Sync Review automatically (generic case detail; the per-field PICK control is R3).

**Known R2 limits (mostly CLOSED in R4a below):** (1) FEED blocks skipped — **FIXED in R4a**
(null block now keys on `(date, batch_id, dest)`). (2) code-string alignment — **FIXED in R4a**
(batch_id resolution). (3) The gsheet re-download is a second snapshot of the Sheet (negligible
skew within one run; observational anyway) — R4b's cutover routes gsheet THROUGH reconciliation,
capturing the extract once.

## R4a — cutover prerequisites (shipped 2026-07-08, still SHADOW)
Four prereqs before R4b retires Sheet-wins. **No write/apply/Sheet-wins behavior changed** —
this makes reconciliation smarter and more visible only. Parity stays 12/12.

**Deliverable 1 — batch_id alignment (Refinement 4).** `rcOutStage.ts::resolveBatchCandidates`
resolves each source's `(primary + fallbacks)` to a batch_id via a `batch_code → batch_id`
lookup — MIRRORING (not importing — it's `ProposedRow`-typed + unexported)
`reports/rc_out/classify.ts::resolveBatchId`. The fine key's `batch` is now the RESOLVED
batch_id, so two conventions (`MARCH-…` / `MAR-…`) that map to the same id align (no silent
miss). It ALSO detects ambiguity the write-path resolver hides: it returns the DISTINCT set of
ids any code maps to — **exactly one → resolved; 0 (no match) or 2+ (codes → different batches)
→ UNRESOLVED**, emitted as an `UnresolvedBatch` marker, never a silent single-source pass. The
`canonicalBatchKey` alias helper is retained (tested) but SUPERSEDED for keying.

**Deliverable 2 — FEED-block keying.** A row with `block_loc = null` (FEED) now keys on
`(date, batch_id, dest)` — the feed batch is its own discriminator. `isFine` no longer requires a
non-null block; only movement (batch null) is excluded. The June-10 FEED2/FEED3 over-statements
now reconcile too, not just standard-block BLK5.

**Deliverable 3 — pending vs held (Refinement 3).** The engine takes a `runDate` (threaded from
the run row — NEVER Date.now() in a DBOS step) and tags each SINGLE-witness fact:
`pending` (age ≤ `LAG_DAYS` = 2 → self-clears next run, NO case) vs `held_overdue` (age > LAG_DAYS
→ a case). An outer window guard drops DEEP history (outside the window) as settled — WITHOUT it,
gsheet's full-history extract would flood `held_overdue` every run. **(R4a shipped this as a fixed
`RECONCILE_WINDOW_DAYS` = 14 lookback; R4b REPLACED it with the proposed-span window — see the R4b
section below.)**
Multi-source agreements never carry a disposition; movement is date-level only and does NOT make a
fact single-witnessed. The stage splits these into a `pending` count (telemetry) + `heldOverdue[]`.

**Deliverable 4 — fan-out.** The channel now carries `{ diffs, agreements, pending, heldOverdue,
unresolvedBatches }`. App fan-out (`app/(app)/sync/cases.ts`) folds `unresolvedBatches` →
`kind='unresolved_batch'` cases (fingerprint = code+date+sorted-candidates; identity-based) and
`heldOverdue` → `kind='single_source_overdue'` cases (fingerprint = key+field+source, value-
independent so it self-clears when the 2nd witness arrives). `pending` = a count only, no case.
`source_diff` is unchanged. All ride the existing triage + Sync Review rails.

**Wiring** (`workflows/runSync.ts::reconcileRcOutShadow`): the shadow step now also builds the
`batch_code → batch_id` lookup (from `batches`, guarded) and reads `runDate` via
`DbClient.getSyncRunCreatedAt(runId)` (a fixed stored value → replay-safe), threading both into
`reconcileRcOutStage`. Both are guarded — an empty lookup means every batch is `unresolved_batch`;
a missing runDate means single-source facts get no disposition. Neither can fail the run (shadow).

## R4b — retire Sheet-wins for rc_out (shipped 2026-07-08, the FIRST live-write change)

The cutover. gsheet-sync **stops writing `rc_out`**; the PROPOSED report becomes the sole
rc_out writer and this reconciliation layer is the flagging authority. This is a **subtraction**,
not a rewrite. Gated behind `SYNC_RCOUT_RECONCILE_CUTOVER` (`src/lib/env.ts`), **DEFAULT ON**.

**What was disabled (surgical).** In `../reports/gsheet/apply.ts::applyGsheet`, the mode loop now
skips the `rc_out` mode **whole** when the cutover is ON — no NEW inserts, no Sheet-wins
`VALUE_CHANGED` UPDATEs, no held rows (`per_mode.rc_out.cutover_skipped = true`, telemetry only).
The single flag check lives at that ONE boundary; `applyFromCompact` is unchanged. **`rc_in`
falls through untouched** — the gate is `if (mode === "rc_out" && cutoverRcOut)`, so deliveries
writes are byte-identical in both flag states. OFF = the exact prior path (the `continue` is never
hit), which is what keeps the old rc_out apply behavior available as a one-line revert.

**Window policy (LOCKED — replaces the R4a fixed 14-day stopgap).** The actionable window is now
the **PROPOSED extract's real date span** (`min..max transaction_date` among proposed fine
records) **± `WINDOW_BUFFER_DAYS` (=2)** — computed inside `reconcileRcOut` from the records
themselves (pure). Rationale: the Sheet carries ALL history but a second witness can only exist
where the proposed report reaches, so the proposed span IS the only range where a lone Sheet
witness is actionable. **No proposed extract this run → empty window → nothing is acted on** (a
lone recent Sheet row is NEVER auto-dispositioned — that would be Sheet-wins under a new name /
re-create L-037). Inside the window the pending/held split is unchanged (age ≤ `LAG_DAYS` →
pending, else held_overdue). `RECONCILE_WINDOW_DAYS`/`ReconcileOptions.windowDays` are retired
(the const is kept deprecated for back-reference; the option was removed, replaced by
`windowBufferDays`). `classifySingleSource` now takes the `ReconcileWindow | null` + buffer.

**Fail-safe (cutover ON only).** `workflows/runSync.ts::reconcileRcOutShadow` tracks whether the
`batch_code→batch_id` lookup built successfully (`batchLookupOk`). With the cutover ON, an
empty/failed lookup would make every fine row unresolvable and flood `unresolved_batch` cases, so
the step **skips rc_out reconciliation for that run and emits ONE `reconcile` diagnostic** (never
a flood, never a mismap). Proposed's own writes are unaffected (it has its own resolver). With the
cutover OFF the R4a shadow behavior is preserved (an empty lookup just yields unresolved markers).

**Unchanged:** the channel shape (`{ diffs, agreements, pending, heldOverdue, unresolvedBatches }`),
the app fan-out (`app/(app)/sync/cases.ts`), R3a pick-source resolution, and classify/parity
(the cutover is APPLY-only; parity is CLASSIFY-only → 12/12 untouched).

## R3a — pick-source resolution (shipped 2026-07-08, app-side)
Lives entirely in the app (`app/(app)/sync/diff-plan.ts` PURE + `resolve.ts` `'use server'`), NOT in
this worker package — the worker only EMITS the `SourceDiff` (its `SourceOpinion.rows` carry the raw
per-leg rows R3 needs). A reviewer picks WHICH source is authoritative for a natural key;
`computeDiffWritePlan` translates that into a per-leg `rc_out` write plan (EDIT-preferred: greedy
equal-weight noop matching → the clean L-037 1-1 remainder is one edit; source-only legs → insert;
DB-only legs → soft-remove weight→0, never delete; anything messy → `ambiguous`, routes the human to
the P5 edit-then-apply fallback). `proposePickSource` persists the plan (no write); `executeDiffResolution`
re-reads it, applies each step under `write_ingestion_audit` provenance, and records a
`sync_case_rulings` `action='pick_source'` row — the durable human correction R4 will consult to stop
"Sheet-wins" from re-clobbering it. **Why `SourceLegRow` exists** (`types.ts`): a fine `weight_kg`
opinion is the SUM across feeding legs, so R3 needs the underlying legs, not just the sum, to know
which leg to edit/insert/zero. movement (date-level) has no per-block legs → empty `rows`.

## RB — block-balance cross-check (shipped 2026-07-08, SHADOW / read-only)

An **INDEPENDENT, ORTHOGONAL** net — NOT same-fact reconciliation. It compares the
operator's hand-kept **Sheet Blocking tab** (never read before RB) against the app's
**computed** `view_blocking_grid` (balance = ΣRC_IN − ΣRC_OUT). Because the computed side is
derived from BOTH transaction reports, it ties RC IN and RC OUT together and is anchored
OUTSIDE the transaction data — it would have caught L-037 from a different angle (a block's
operator balance vs its DB-derived balance). **Read-only: produces `block_diff` descriptors,
writes NOTHING to inventory tables.** A real fix corrects the underlying rc_in/rc_out via the
existing paths — there is NO bespoke block resolver (RB v1: a `block_diff` case can be
dismissed or investigated; the investigator's `query_table` already allows `view_blocking_grid`).

**The real Sheet Blocking tab (investigated 2026-07-08 against the live workbook).** Tab name
`"Blocking"`, 971 rows × 33 cols. It is a **2-D visual grid** mirroring the physical warehouse,
NOT a flat table:
- **col A** ("INVENTORY TONS") holds the whole-inventory grand total in **TONS** a few rows
  down (e.g. `10289.082`); ×1000 = kg. (It is literally the sum of the grid, so it doubles as
  an extraction-completeness anchor — our Sheet sum must equal it.)
- The grid is a stack of **11 bands** (one per physical warehouse row: WHSE A rows A/B/C, B
  rows A/B, C rows A/B, D rows A/B/C/D). Each band is **6 stacked rows**: `LABEL` (col 7 = the
  row letter; cols 8..27 = block_loc strings `A-1A..A-20A`; a **PCA/PCB** mini-grid extends at
  cols 31..33), then `BLOCK` (batch_code per block), `BALANCE` (kg — a SUMIFS over the Sheet's
  OWN RC IN/RC OUT tabs, so a per-block diff = the Sheet's transaction data diverges from the
  DB), then `BD`/`ASH`/`MC` (lab, not reconciled). block_loc + batch + balance for one block
  share the same **COLUMN**; vacant slots have a loc header but no cached formula result → null
  → skipped. Live snapshot: 167 occupied blocks, Σ balances = 10,289,082 kg = A4 exactly.

**Files.**
- `../reports/gsheet/blocking.ts` — `extractBlockingTab(sheet)` → `{ blocks: SheetBlock[],
  statedGrandTotalKg, warnings, source_rows }`. A LABEL row is any row with ≥1 block_loc-shaped
  string at/after col 8; batch = row+1, balance = row+2, same column. Exact-scrape, no
  cross-record math. Handles standard + PCA/PCB columns uniformly. `BLOCK_LOC_REGEX` mirrors
  (does not import) the unexported one in `extract.ts`.
- `blockBalance.ts` — `reconcileBlockBalance(sheet, computed, opts)` → `{ blockDiffs, totals }`.
  PURE (no DB/imports). Two-level check: **B1** per-block balance (tol `blockBalanceTolKg`
  **=1 kg**, the fine net), **B2** grand total Σsheet vs Σcomputed (tol `grandTotalTolKg`
  **=100 kg**, the coarse backstop), **B3** multi_batch (computed `activeBatchCount ≥ 2`),
  **B4** batch identity (alias-aware, `MARCH-…≡MAR-…` via a local `MONTH_CANONICAL` mirroring
  extract.ts). **Why both B1 + B2:** a weight mis-attributed between two blocks nets to zero in
  the total (B2 silent) but shows per-block (B1 fires) — proven in the test. block_loc is
  normalized trim+UPPERCASE on both sides. A **negative computed balance alone is a soft-warn,
  NOT a diff** (Ruleset O7 — usually a late delivery); but a *disagreement* with the Sheet on
  that block still is. A block present on only one side → a presence `balance` diff.

**Shadow wiring** (`../workflows/runSync.ts::reconcileBlockBalanceShadow`, a DBOS step after the
rc_out shadow): re-downloads the Sheet, extracts the Blocking tab, reads `view_blocking_grid`
(balance + batch_code) and `batches` (per-loc non-CLOSED count for B3) over REST, runs the
engine, and returns the `BlockReconciliation`. Fully guarded → **absent channel on any failure
or no Blocking tab; never fails a run and never writes.** runSync merges it into
`result.reconciliation.blocking` (alongside `rc_out`).

**App fan-out** (`app/(app)/sync/cases.ts`): `collectBlockDiffs` folds `blockDiffs` into
`sync_held_cases` rows `kind='block_diff'`, `report_type='blocking'`, `natural_key` =
`blockDiffNaturalKey` (`"A-9C · balance"`, `"D-11B · batch"`, `"GRAND TOTAL · blocking"`),
`row` = the full `BlockDiff`, fingerprint = `blockDiffFingerprint` (canonicalHash of
`{kind, block_loc, rounded sheet/computed kg (+ competing batches / count)}`; a grand_total diff
→ one case per run). Rides the EXISTING triage + Sync Review + investigator rails. Verify:
`scripts/verify-block-diff-fold.ts`.

## See also
- `SYNC_RECONCILIATION_MODEL.md` (owner: Renzo) — the phased plan (R1–R5).
- `../reports/rc_out/classify.ts::balanceIntegrity` — the L-037 self-consistency source.
- `../reports/rc_movement_audit/extract.ts` — the movement `date_to_fed_kls` grain.
- `LEARNING_LEDGER.md` L-037 — the motivating incident.
