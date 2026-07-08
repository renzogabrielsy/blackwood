# Sync Reconciliation Model — "No source is truth; the human arbitrates diffs"

_2026-07-07. The governing model for how Blackwood's daily sync combines multiple fallible sources into the database. Replaces the "Sheet-wins" source-priority policy. Motivated by the L-037 incident: gsheet-sync's Sheet-wins silently overwrote a **correct** proposed-report feeding (20,932 kg) with the Google Sheet's cross-block cumulative (31,745 kg), over-stating rc_out by 32,195 kg across two days with no human ever seeing a choice. The one-line principle is canonical in `CLAUDE.md` → "Sync Integrity"._

## The principle

1. **No ingest source is authoritative.** The Google Sheet, the PROPOSED DAILY REPORT, the RC MOVEMENT sheet, delivery emails, and Czarina pricing are all fallible witnesses to the same physical events. None wins by default.
2. **Extraction must be exact.** An extractor captures what its source *literally says*, per natural key — no interpretation, no cross-record arithmetic, no borrowing a value from a neighbouring row. Each source also emits its own **self-consistency signals** (see below) so the reconciler can weight witnesses.
3. **Agreements auto-apply; disagreements are arbitrated by the human — in the app.** When sources agree on a field, it writes. When they disagree, the sync **never picks a winner** — it raises a **diff case** the operator resolves in Sync Review.
4. **Every run ends CLEAN or DIFFS-PENDING.** Never a silent overwrite.

## Why this is mostly already built

The adjudicator work (P1–P6 + Run Triage) gave us the entire *arbitration* half: persistent cases, a review page grouped by run, per-case chat with a read-only investigator, confirm-gated resolution with provenance audit, and a known-issues ledger. **Diff cases are just a new `kind` of case.** What's genuinely new is the *reconciliation* half: extracting every source into a comparable shape and detecting field-level disagreements before any write.

## The three stages

### Stage 1 — Extract (robust, per-source)
Each report's extractor produces, per natural key, a **source record**: the exact field values that source states, plus **self-consistency flags**. Examples of self-consistency signals:
- **rc_out proposed:** `STRT − END == DAY TOTAL` per block; leg-to-leg continuity (a block's STRT == the prior same-slot block's END). (This is the L-037 balance guard — it belongs HERE, as a source-validity signal, not as a write gate.)
- **Any source:** required fields present, parses cleanly, dates valid, weights positive.
A source record that fails its own consistency check is not dropped — it's carried with a `self_consistent: false` mark, which becomes a tie-breaker the reconciler and the operator can see ("the Google Sheet value fails its own balance check; the proposed report's passes").

### Stage 2 — Reconcile (cross-source, per natural key + field)

**Granularity (LOCKED in R1, 2026-07-07):** rc_out reconciles at the fine key `(transaction_date, batch, block_loc, destination)` on the **SUM of weight across legs** — the physically meaningful "how much did this batch/block get today," robust to sources splitting legs differently. **Sources join at different grains:** the proposed report and Google Sheet compete at the fine key; the **RC MOVEMENT sheet is coarser — a per-DATE grand total only** (no per-block detail), so it participates one level up as a **date-level corroboration witness**: for a fine disagreement on date D, the engine rolls each fine source's whole-day rc_out total and checks which matches the movement day total. That rollup match is the L-037 discriminator (proposed's day total reconciles to movement; gsheet's over-stated total does not).

For each natural key, gather every source that has an opinion on it, field by field. Per field, one of:
- **Agree** (all present sources equal, within tolerance) → **accept**, queue for the clean apply.
- **Single-source** (only one source has it) → accept, tagged single-source (visible, low-friction).
- **Disagree** → **diff**: emit a `source_diff` case. No auto-pick, ever — even when one source corroborates another (corroboration becomes a *recommendation*, never a decision).

Reconciliation runs as a new worker stage after all report extractions, before any write. It is pure and deterministic.

### Stage 3 — Arbitrate (human, in Sync Review)
- Agreements → written by the deterministic apply path (audit + provenance), exactly as today.
- Each `source_diff` case shows the natural key, the field, and each source's competing value with its provenance + self-consistency mark. The operator clicks **"use this value"** (or edits — the P5 edit-then-apply path). The pick writes deterministically, logs a ruling, and the ledger remembers it so a *recurring identical* diff can be pre-annotated next run (never auto-applied without the trust phase).
- The **investigator can pre-recommend** a winner per diff (it already did this by hand for L-037: "the movement sheet corroborates the proposed report's 20,932; the Google Sheet's 31,745 fails the balance check"). Advisory only.

## Sync output contract

A run resolves to exactly one of:
- **CLEAN** — every field reconciled and applied; zero diffs. (The common, boring, good outcome.)
- **DIFFS PENDING** — N `source_diff` cases (plus any existing held/gate cases) in Sync Review, grouped by run, triaged by root cause. Nothing silently overwritten.

## Data model (reuse, minimal new)

- **`source_diff` case** = a `sync_held_cases` row, `kind='source_diff'`. `row` jsonb: `{ natural_key, field, table, sources: [{ source, value, provenance, self_consistent, corroborated_by[] }], recommended?: {source, why} }`.
- **Resolution** = the existing confirm-gated resolve, extended with a **"pick source S's value"** action (a thin specialization of edit-then-apply: the chosen value flows through the same deterministic write + `write_ingestion_audit` provenance = "diff resolved via Sync Review by <user>: picked <source>").
- **Ledger** = existing `sync_case_rulings`; a diff's fingerprint = hash of `{natural_key, field, the competing values}` so an *identical* recurring disagreement is recognized (and a *changed* one re-alarms), same discipline as L-034/the case fingerprint.

## What this retires / changes

- **gsheet-sync "Sheet-wins" is DELETED.** The Google Sheet becomes one source feeding reconciliation, not an authority that overwrites. (Until this ships, hold gsheet rc_out writes — a run re-clobbers the L-037 manual correction.)
- The email "auditor" roles (rc-movement-auditor) become **first-class sources** in reconciliation rather than side-channel cross-checks.
- Existing single-source case kinds (unmapped batch, malformed, gate failures) are unchanged and coexist with `source_diff`.

## Phased build

| Phase | Deliverable | Notes |
|---|---|---|
| **R1 — Reconciliation layer (rc_out first)** | A pure worker stage that takes the extracted source records for rc_out from proposed + gsheet + movement, compares per natural key + field, and emits agreements vs `source_diff` descriptors. Self-consistency signals (incl. the L-037 balance guard) feed it. Unit-tested against the real L-037 case (proposed 20,932 vs gsheet 31,745 → one diff, movement corroborates proposed). | No writes yet; pure + golden-tested. |
| **R2 — `source_diff` cases + fan-out** | Persist diffs as `source_diff` cases (fingerprint, sources payload); the run-completion fan-out (`ensureCasesForRun`) includes them; triage clusters them. | Reuses P1/T1. |
| **R3 — Sync Review pick UI** | The case detail renders competing source values with a "use this" control per field; wire to a `resolveDiff` action through the deterministic write path. Investigator pre-recommendation shown. | Reuses P4/P5. |
| **R4 — Retire Sheet-wins + generalize** | Remove gsheet-sync's authoritative overwrite; route gsheet rc_out/rc_in through reconciliation. Then extend sources per report (deliveries: proposed + gsheet + Czarina pricing; production; flecon). | The real cutover. |
| **R5 — Trust phase (optional, later)** | Only after the ledger has demonstrably agreed with the operator's picks for weeks: allow a *proven-identical, previously-ruled* diff to auto-apply the remembered pick. Explicitly deferred. | Mirrors the adjudicator's deferred auto-resolve. |

## Known gaps to close BEFORE the R4 cutover (found in R2)

R2 runs in shadow (observation only), so these are safe today but MUST be resolved before reconciliation drives writes:

1. **FEED blocks are invisible to the fine key.** The proposed extractor emits `block_loc = null` for FEED blocks (e.g. JUNE-26-FEED2/FEED3), so they can't form `(date, batch, block, dest)` and are **skipped** by reconciliation in R2. Consequence: of the real L-037 diffs, only the standard-block one (MARCH-26-BLK5) is caught from live extracts; the FEED-block over-statements are not. **R4 fix:** for null-block feed rows, key on `(date, batch, dest)` (the feed batch_code is itself the discriminator) — or accept date-level reconciliation for feed. Decide before cutover.
2. **Batch-code alignment is best-effort.** R2 aligns sources with `canonicalBatchKey` (smallest uppercased alias over primary+fallbacks). A batch whose conventions don't share an alias set splits into two single-source Agreements (silently no diff) rather than a false diff — safe for shadow, wrong for a write gate. **R4 fix:** resolve to `batch_id` before reconciling, not code-string alignment.
3. **gsheet is re-downloaded in the shadow step** (`reports/gsheet/download.ts` fetches bytes but does not persist to Storage, despite a runSync comment implying otherwise). Harmless now (one extra GET/run). **R4:** capture the gsheet extract once and route it through reconciliation instead of re-downloading.

**Also settled in R2 (orchestration reality):** the three sources do NOT co-locate — each report is an isolated crash-safe DBOS child workflow that returns only a normalized envelope, never raw rows. Reconciliation therefore re-derives sources in its own durable step. A normal run routinely has only a SUBSET of witnesses present (gsheet always; proposed + movement depend on that day's emails arriving) — the engine drops absent witnesses gracefully, but R4's write policy must define behavior when a field has only ONE witness that day (currently: single-source Agreement → would auto-apply; confirm that's desired per field, or require ≥2 witnesses for certain fields).

## What it does NOT change
Deterministic extraction + parity harness (each source still golden-tested), the confirm-gated write path, price gating, never-delete / never-auto-create-batches, and the "human approves every write" posture. Reconciliation makes the *disagreement* visible; it never makes the *decision*.
