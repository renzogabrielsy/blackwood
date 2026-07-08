/**
 * types.ts — shared types for the Sync Reconciliation Model (R1, rc_out first).
 *
 * See SYNC_RECONCILIATION_MODEL.md → "R1 — Reconciliation layer" and CLAUDE.md →
 * "Sync Integrity — Multi-Source Reconciliation". Governing principle: NO ingest source
 * is authoritative. Each source is a fallible witness; the reconciler detects field-level
 * disagreements and NEVER picks a winner (a corroboration hint is advisory only — the
 * human arbitrates in Sync Review).
 *
 * GRANULARITY (the R1 design decision — documented in ./CONTEXT.md):
 *   Fine reconciliation key = (transaction_date, batch, block_loc, destination), reconciled
 *   field = SUM of weight_kg across every feeding leg at that key. proposed + gsheet emit
 *   records at this grain. The RC MOVEMENT sheet reports ONLY per-DATE grand totals
 *   (no per-block detail), so a movement record is carried at the coarser (transaction_date)
 *   grain and participates ONLY as a date-level CORROBORATION witness — it is never itself
 *   reconciled into a fine agreement/diff. This is pure + deterministic; no I/O.
 */

/** The three rc_out witnesses R1 reconciles. Extensible per report in later phases. */
export type RcOutSource = "proposed" | "gsheet" | "movement";

/** The only table R1 targets. */
export type ReconcileTable = "rc_out";

/**
 * Natural key at the reconciliation granularity.
 *  - Fine records (proposed, gsheet): batch + block_loc are set; destination defaults "MAIN".
 *  - Date-level records (movement): batch = block_loc = destination = null — a whole-day total.
 */
export interface RcOutNaturalKey {
  transaction_date: string; // ISO "YYYY-MM-DD"
  batch: string | null; // batch identity (resolved batch_id or batch_code); null = date-level
  block_loc: string | null; // null = date-level (movement)
  destination: string | null; // "MAIN" default for fine records; null = date-level
}

/**
 * One raw per-LEG row that contributed to a source's summed opinion at a natural key.
 *
 * A source's fine `weight_kg` opinion is the SUM across the feeding legs at that key
 * (L-037 leg-splitting robustness). R3 (the pick-source resolution, app/(app)/sync/
 * diff-plan.ts) needs those underlying legs — not just the sum — to translate "pick
 * source S" into the right per-leg DB writes (EDIT a mismatched leg / INSERT a missing
 * one / soft-remove an over-stated one). So each SourceRecord (and each SourceOpinion)
 * carries the legs that summed to it. movement has no per-block legs → empty.
 *
 * NEVER carries a ₱/cost field (price gating) — rc_out has none anyway.
 */
export interface SourceLegRow {
  transaction_date: string;
  /** The source's raw batch code for this leg (resolved to batch_id at write time). */
  batch_code: string | null;
  /** Pre-resolved batch id when the source already carries it (proposed post-classify). */
  batch_id?: string;
  block_loc: string | null;
  destination: string;
  weight_kg: number;
  production_batch?: string | null;
  remarks?: string | null;
}

/**
 * One source's opinion about ONE natural key, as fed into the reconciler. The extractor
 * layer (Stage 1) builds these — exactly what the source literally states, per key, plus
 * its own self-consistency verdict. The reconciler treats `fields` generically so more
 * reconciled fields can be added later without an engine change.
 *
 * For rc_out the load-bearing fine field is `weight_kg` (the summed feeding for that key).
 * A movement record carries `raw_charcoal_fed_kls` (the day grand total).
 */
export interface SourceRecord {
  source: RcOutSource;
  naturalKey: RcOutNaturalKey;
  /** Field values this source states for this key. A field is an "opinion" iff present and non-null. */
  fields: Record<string, number | string | null>;
  /**
   * The raw per-leg rows that summed to this record's `weight_kg` opinion. Carried
   * through to the `SourceDiff` so R3 can compute a per-leg write plan. Optional /
   * empty for a movement (date-level) record, which has no per-block legs.
   */
  rows?: SourceLegRow[];
  /**
   * Did this record pass its OWN internal-consistency check? For a proposed record this is
   * the L-037 balance guard (every leg's STRT − END == DAY TOTAL, and same-slot continuity).
   * A source with no self-check (gsheet has no balance columns) is `true` by default — it
   * cannot fail a check it does not have. `false` is a tie-breaker the reconciler can see.
   */
  selfConsistent: boolean;
  /** Human note explaining a `selfConsistent:false` (e.g. the balance-integrity reason). */
  selfConsistencyNote?: string;
  /** Where this value came from, for the audit trail (e.g. "PROPOSED DAILY REPORT 2026-06-10, D-11B legs 10813+20932"). */
  provenance: string;
}

/** One competing value inside a diff, with its provenance + self-consistency + who backs it. */
export interface SourceOpinion {
  source: RcOutSource;
  value: number | string | null;
  provenance: string;
  selfConsistent: boolean;
  /** Other independent sources whose evidence backs THIS value (direct match or movement rollup). */
  corroboratedBy: RcOutSource[];
  /**
   * The raw per-leg rows that summed to this opinion's `value` — the write-plan input
   * for R3's pick-source resolution. Empty for a movement opinion (no per-block legs).
   */
  rows: SourceLegRow[];
}

/** A field where all present sources agree (or only one source has an opinion). Auto-appliable. */
export interface Agreement {
  naturalKey: RcOutNaturalKey;
  field: string;
  table: ReconcileTable;
  value: number | string | null;
  /** Every source that stated this (agreeing) value. */
  sources: RcOutSource[];
  /** True when only ONE source had an opinion (accepted, but visibly low-corroboration). */
  singleSource: boolean;
  /**
   * R4a — for a SINGLE-source fact, its recency disposition (pending vs held_overdue).
   * Set ONLY when the engine was given a `runDate` AND the fact is inside the eligibility
   * window. Multi-source agreements never carry a disposition; a single-source fact that is
   * settled history (older than the window) also carries none. Undefined when runDate absent.
   */
  disposition?: SingleSourceDisposition;
  /** runDate − transaction_date, in whole days. Present iff `disposition` is set. */
  ageDays?: number;
}

/** Advisory winner hint. NEVER a decision — the human still picks in Sync Review. */
export interface Recommendation {
  source: RcOutSource;
  why: string;
}

// ---------------------------------------------------------------------------
// R4a — single-witness disposition + unresolved-batch marker (cutover prereqs).
// ---------------------------------------------------------------------------

/**
 * The recency disposition of a SINGLE-witness fact (Refinement 3, SYNC_RECONCILIATION_MODEL.md).
 *  - `pending`      — the second expected source just hasn't arrived yet (the fact is recent).
 *                     Self-clears next run when the corroborating source shows up. NO case.
 *  - `held_overdue` — single witness but the fact is older than the lag window (the second
 *                     source should have arrived). A real missing-witness signal → a case.
 */
export type SingleSourceDisposition = "pending" | "held_overdue";

/**
 * Days a single-witness fact may go un-corroborated before it is "overdue". The PROPOSED
 * report reports ~yesterday, so a 1-day lag is normal; 2 = that lag + a buffer. Named + tunable.
 */
export const LAG_DAYS = 2;

/**
 * DEPRECATED (R4a stopgap, superseded by R4b). The R4a shadow used a FIXED N-day lookback
 * from the run date as the outer "settled history" bound. R4b REPLACES it with a window
 * tied to the PROPOSED extract's real date span (see `WINDOW_BUFFER_DAYS` +
 * `reconcileRcOut`): the Sheet carries all history but a second witness can only exist where
 * the proposed report reaches, so the proposed span IS the actionable window. The engine no
 * longer reads this constant; it is retained only for back-reference. Do not reintroduce a
 * fixed lookback — that is the very thing that would re-create "Sheet-wins under a new name".
 */
export const RECONCILE_WINDOW_DAYS = 14;

/**
 * R4b — buffer (days) added on EACH side of the proposed extract's date span to form the
 * reconciliation window. The proposed report reports ~yesterday, so today's Sheet-only rows
 * sit just past the proposed max; a small buffer keeps them inside the window (→ `pending`)
 * instead of prematurely "settled". 2 = the normal 1-day proposed lag + slack. Tunable.
 */
export const WINDOW_BUFFER_DAYS = 2;

/**
 * A source's batch that could not resolve to EXACTLY ONE batch_id (Refinement 4). Zero
 * candidates = the code matches no batch; 2+ = the code + its fallbacks map to DIFFERENT
 * batches (ambiguous). Either way it must NOT silently become a single-source Agreement — it
 * surfaces as an `unresolved_batch` case so a human maps/creates the batch. NEVER a ₱ field.
 */
export interface UnresolvedBatch {
  transaction_date: string;
  /** The batch code the source(s) stated that failed to resolve to one batch_id. */
  batch_code: string;
  /** Distinct batch_ids the code + its fallbacks resolved to: 0 (no match) or 2+ (ambiguous). */
  candidates: string[];
  block_loc: string | null;
  destination: string;
  /** Summed weight across the rows carrying this unresolvable batch (context only). */
  weight_kg: number;
  /** Which witnesses stated this unresolvable batch. */
  sources: RcOutSource[];
}

/**
 * A single-witness fact whose second source is OVERDUE (older than the lag window, inside the
 * eligibility window). Surfaced as a `single_source_overdue` case. Distinct from a `pending`
 * fact (recent, no case) and from a multi-source Agreement. NEVER carries a ₱/cost field.
 */
export interface SingleSourceOverdue {
  naturalKey: RcOutNaturalKey;
  field: string;
  table: ReconcileTable;
  source: RcOutSource;
  value: number | string | null;
  provenance: string;
  /** runDate − transaction_date, in whole days (> lagDays by construction). */
  ageDays: number;
  /** The lag threshold in effect for this run (for the human message). */
  lagDays: number;
}

/** A field where present sources disagree. Emitted as a `source_diff` case in R2. No auto-pick. */
export interface SourceDiff {
  naturalKey: RcOutNaturalKey;
  field: string;
  table: ReconcileTable;
  sources: SourceOpinion[];
  recommended?: Recommendation;
}

export interface ReconcileResult {
  agreements: Agreement[];
  diffs: SourceDiff[];
}

export interface ReconcileOptions {
  /** kg tolerance for comparing two fine weight opinions. Default 1 (rc_out weights are integer kg). */
  weightTolKg?: number;
  /** kg tolerance for the movement day-total vs a source's daily rollup. Default 1. */
  dayRollupTolKg?: number;
  /** The additive weight field that reconciles against the movement day total. Default "weight_kg". */
  weightField?: string;
  /** The movement record's day-total field. Default "raw_charcoal_fed_kls". */
  movementTotalField?: string;
  /**
   * R4a — the sync run's calendar date (YYYY-MM-DD). Threaded from the run row — NEVER
   * Date.now() inside a DBOS step (a step must be deterministic on replay). Drives the
   * single-witness pending vs held_overdue split. When absent, single-source facts get no
   * disposition (back-compat: the engine behaves exactly as R1/R2).
   */
  runDate?: string;
  /** Overdue threshold in days. Default LAG_DAYS. */
  lagDays?: number;
  /**
   * R4b — buffer (days) on each side of the PROPOSED extract's date span that forms the
   * actionable window. Default WINDOW_BUFFER_DAYS. (Replaces the R4a fixed `windowDays`
   * lookback, which was removed — the window is now derived from the proposed span itself.)
   */
  windowBufferDays?: number;
}
