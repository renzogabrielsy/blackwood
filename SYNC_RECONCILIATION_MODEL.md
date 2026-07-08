# Sync Reconciliation Model — "No source is truth; the human arbitrates diffs"

_2026-07-07. The governing model for how Blackwood's daily sync combines multiple fallible sources into the database. Replaces the "Sheet-wins" source-priority policy. Motivated by the L-037 incident: gsheet-sync's Sheet-wins silently overwrote a **correct** proposed-report feeding (20,932 kg) with the Google Sheet's cross-block cumulative (31,745 kg), over-stating rc_out by 32,195 kg across two days with no human ever seeing a choice. The one-line principle is canonical in `CLAUDE.md` → "Sync Integrity"._

## The principle

1. **No ingest source is authoritative.** The Google Sheet, the PROPOSED DAILY REPORT, the RC MOVEMENT sheet, delivery emails, and Czarina pricing are all fallible witnesses to the same physical events. None wins by default.
2. **Extraction must be exact.** An extractor captures what its source *literally says*, per natural key — no interpretation, no cross-record arithmetic, no borrowing a value from a neighbouring row. Each source also emits its own **self-consistency signals** (see below) so the reconciler can weight witnesses.
3. **Agreements auto-apply; disagreements are arbitrated by the human — in the app.** When sources agree on a field, it writes. When they disagree, the sync **never picks a winner** — it raises a **diff case** the operator resolves in Sync Review.
4. **Every run ends CLEAN or DIFFS-PENDING.** Never a silent overwrite.

## Refinements locked with Renzo (2026-07-07 PM)

Six clarifications from the design review that reshape the scope and close the pitfalls found so far:

1. **Reconciliation applies to only THREE reports — RC IN, RC OUT, Blocking** (the ones with a Google Sheet tab overlapping an email). **Production and Flecon are single-source**: they **auto-write as long as they pass a validity ruleset** (`SYNC_VALIDITY_RULESET.md`), and only stop for a human on a *rule violation* (a `rule_violation` case naming the broken rule). This is the answer to the single-witness-friction problem — inherently single-source reports are never "held forever," they're rule-gated.
2. **Blocking is a two-level balance check, not one number.** Per-block (`ΣIN − ΣOUT` == the Sheet's block figure, and `>= 0`) AND grand-total (all blocks sum correctly). They catch different errors: a weight mis-attributed *between* two blocks nets to zero in the total but shows up per-block. "Every block matches AND the total matches" = genuinely balanced. Blocking is also the **integration check** that ties RC IN and RC OUT together (it's derived from both), so it catches inconsistencies *between* those two reports that same-fact reconciliation can't.
3. **Pending vs Held (kills the single-witness friction).** Because the proposed report reports *yesterday*, a normal sync has yesterday's data double-witnessed (email + Sheet → writes) and today's data single-witnessed (Sheet only). A lone witness where the **second source is merely not-yet-arrived** is a **`pending` state that auto-clears next run** when the corroborating source shows up — NOT a human-review case. Only a genuine disagreement, or an *overdue/missing* expected source, escalates to a held case. So the rolling 1-day hold is invisible.
4. **Fix the silent miss with `batch_id`, and make "unresolvable" loud.** Cross-source alignment resolves each source's batch to a `batch_id` (not code-string matching). A batch that **can't** resolve to exactly one id → a **case, never a silent single-source pass** (this removes the "silent" from the silent miss). A read-only Claude call may *suggest* the likely match on genuinely ambiguous alignments — advisory, deterministic-first.
5. **Ambiguous diffs get an explainer, not a dead-end.** When a diff maps cleanly into the pick harness → the deterministic pick UI (no model). When it's outside the pick UI's scope (unequal legs, tangled mapping) → a **one-shot Haiku/Sonnet explainer** (not a chatbot) states plainly what's tangled, rendered with the **Copy button** (existing error-toast rule) so its output pastes straight into a debugging chat. Reuses the investigator infra in a bounded mode; Haiku default, Sonnet on escalation.
6. **Feed check scope:** the FEED-block balance/leg check needs **RC OUT + proposed report only** (feed is an rc_out concept). The three reconciled reports run in **independent lanes** (each vs its own sources) — NOT one joint match — with Blocking as the invariant that connects RC IN and RC OUT.

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
- **Single-source, second witness expected but not yet arrived** → **`pending`** — auto-clears next run when the corroborating source shows up (see Refinement 3). NOT a review case.
- **Single-source, second witness overdue/missing** → held case (a real signal).
- **Disagree** → **diff**: emit a `source_diff` case. No auto-pick, ever — even when one source corroborates another (corroboration becomes a *recommendation*, never a decision).
- **Batch won't resolve to one `batch_id`** → case, never a silent pass (Refinement 4).

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
| **R4a — Close the R4 prerequisites** | Before any cutover: `batch_id` resolution (Refinement 4), FEED-block keying (`(date,batch,dest)`), capture gsheet extract once, and the `pending` vs `held` split (Refinement 3). | Prereqs; no write change yet. |
| **R4b — Retire Sheet-wins (rc_out)** | Remove gsheet-sync's authoritative overwrite for rc_out; reconciliation drives rc_out writes (agreements apply, diffs → cases, pending auto-clears). This is the clobber fix — the manual June correction stops being at risk. See **R4b design (below)** — the window/single-witness policy is load-bearing. | The real cutover, rc_out only. |
| **RB — Block-balance cross-check** | Read the Sheet Blocking tab (already downloaded, currently ignored) + `view_blocking_grid`; two-level check (Refinement 2) → `block_diff` cases. The highest-leverage net (independent of the transaction data). | New source of truth-checking. |
| **RC-IN — Extend reconciliation to RC IN** | deliveries: Sheet RC IN + deliveries email; pricing stays single-source. Same cutover shape as R4b. | After rc_out proves out. |
| **RS — Single-source rulesets** | Production + Flecon auto-write gated by `SYNC_VALIDITY_RULESET.md`; a rule violation → `rule_violation` case. (Refinement 1.) | No reconciliation — rule-gated. |
| **R-EXPLAIN — Ambiguous-diff explainer** | The Haiku/Sonnet one-shot explainer + Copy-export for diffs outside the pick UI's scope. (Refinement 5.) | Bounded reuse of the investigator. |
| **R5 — Trust phase (optional, later)** | Only after the ledger has demonstrably agreed with the operator's picks for weeks: allow a *proven-identical, previously-ruled* diff to auto-apply the remembered pick. Explicitly deferred. | Mirrors the adjudicator's deferred auto-resolve. |

## Known gaps to close BEFORE the R4 cutover (found in R2)

R2 runs in shadow (observation only), so these are safe today but MUST be resolved before reconciliation drives writes:

1. **FEED blocks are invisible to the fine key.** The proposed extractor emits `block_loc = null` for FEED blocks (e.g. JUNE-26-FEED2/FEED3), so they can't form `(date, batch, block, dest)` and are **skipped** by reconciliation in R2. Consequence: of the real L-037 diffs, only the standard-block one (MARCH-26-BLK5) is caught from live extracts; the FEED-block over-statements are not. **R4 fix:** for null-block feed rows, key on `(date, batch, dest)` (the feed batch_code is itself the discriminator) — or accept date-level reconciliation for feed. Decide before cutover.
2. **Batch-code alignment is best-effort.** R2 aligns sources with `canonicalBatchKey` (smallest uppercased alias over primary+fallbacks). A batch whose conventions don't share an alias set splits into two single-source Agreements (silently no diff) rather than a false diff — safe for shadow, wrong for a write gate. **R4 fix:** resolve to `batch_id` before reconciling, not code-string alignment.
3. **gsheet is re-downloaded in the shadow step** (`reports/gsheet/download.ts` fetches bytes but does not persist to Storage, despite a runSync comment implying otherwise). Harmless now (one extra GET/run). **R4:** capture the gsheet extract once and route it through reconciliation instead of re-downloading.

**Also settled in R2 (orchestration reality):** the three sources do NOT co-locate — each report is an isolated crash-safe DBOS child workflow that returns only a normalized envelope, never raw rows. Reconciliation therefore re-derives sources in its own durable step. A normal run routinely has only a SUBSET of witnesses present (gsheet always; proposed + movement depend on that day's emails arriving) — the engine drops absent witnesses gracefully, but R4's write policy must define behavior when a field has only ONE witness that day (currently: single-source Agreement → would auto-apply; confirm that's desired per field, or require ≥2 witnesses for certain fields).

## R4b design — the window / single-witness policy (LOCKED from R4a findings, 2026-07-07)

R4a exposed the one thing that will make-or-break the cutover, and it's subtle:

**In a single run, the Google Sheet carries the ENTIRE history; the proposed report carries ~ONE day.** So for almost every date, the *only* witness present in a run is the Sheet. If R4b auto-applied single-witness Sheet values, that would be **Sheet-wins under a new name — it re-creates the exact L-037 clobber.** Therefore:

1. **Reconciliation only ACTS on a bounded recent window** — the date span the proposed extract actually covers (+ a small buffer), because that is the only window where a second witness can exist. R4a ships a shadow-safe stopgap (`RECONCILE_WINDOW_DAYS = 14`); **R4b must replace the fixed number with a bound tied to the proposed extract's real span.**
2. **Outside the window, Sheet-only data is SETTLED** — it was reconciled when it was fresh (its proposed report was present in an earlier run). R4b must **leave it untouched** — never re-write it just because the Sheet still lists it. (This is the L-034 compare-window lesson resurfacing one layer up.)
3. **A lone Sheet witness INSIDE the window = pending/hold, never auto-apply.** Only a genuine ≥2-source agreement auto-writes. A single witness (even recent) waits for its second source (pending) or becomes a case when overdue.
4. **Ambiguous batch (2+ candidates) needs its own resolution path** — it's a batch-mapping decision, not a value pick, so it can't ride the `source_diff` pick harness as-is. R4b (or the explainer phase) needs a small "which batch did you mean" resolution.
5. **A missing batch lookup must degrade safely at cutover** — in shadow an empty lookup just floods `unresolved_batch` cases; when reconciliation drives writes, a missing lookup must *block that report's writes* (fail safe), not silently mismap.

**Net R4b rule:** auto-write only ≥2-source agreements inside the proposed window; everything else is pending, a case, or settled-and-untouched. That is what ends the clobber without re-introducing it.

## What it does NOT change
Deterministic extraction + parity harness (each source still golden-tested), the confirm-gated write path, price gating, never-delete / never-auto-create-batches, and the "human approves every write" posture. Reconciliation makes the *disagreement* visible; it never makes the *decision*.

## See also
- **`SYNC_VALIDITY_RULESET.md`** — the per-report validity rules that gate single-source auto-writes (Production, Flecon) and the self-consistency checks for the reconciled reports. Inferred from our sync history; awaiting Renzo's confirmation on the ⚠️ rows.
