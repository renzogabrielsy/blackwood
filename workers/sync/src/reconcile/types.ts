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
}

/** Advisory winner hint. NEVER a decision — the human still picks in Sync Review. */
export interface Recommendation {
  source: RcOutSource;
  why: string;
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
}
