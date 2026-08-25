/**
 * held.ts — the shared held-row ENRICHMENT vocabulary (2026-07-06).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Held rows used to carry only `{ reason, natural_key, detail }` where
 * `natural_key` was a raw row INDEX (an integer like `8`, `17`, `26`). When the
 * app's "Ask Claude" adjudicator was handed those three thin fields it produced
 * generic advice ("confirm it's genuinely absent") because it had NO row data, NO
 * DB comparison, and NO rule meaning.
 *
 * This module gives every apply.ts a single place to build a DECISION-GRADE held
 * row:
 *   - `kind`         — a NORMALIZED flag category (a small enum) the app keys its
 *                      per-row DB lookup off of.
 *   - `natural_key`  — a HUMAN label (never an index), e.g.
 *                      "2026-06-30 · JUNE-26-FEED5 · MAIN · 5,820 kg".
 *   - `row`          — the KEY fields a human + a DB lookup need (report-specific).
 *                      NEVER any ₱/cost field (price gating — these are write
 *                      decisions, not cost views).
 *   - `source_index` — the FORMER index, kept for the apply-input mapping so
 *                      nothing that referenced the integer index is lost.
 *
 * This ONLY changes how held rows are DESCRIBED. It never changes WHICH rows are
 * held — that decision lives in each report's classify/apply and is untouched.
 *
 * The `HeldRow` shape here is the WORKER-SIDE MIRROR of the frontend `HeldRow`
 * (app/(app)/sync/types.ts). Both must stay in lockstep — normalizeReport.ts
 * passes these rows through verbatim.
 */

/**
 * The normalized held-flag categories. Every per-report `reason` string maps to
 * exactly one of these. The app's adjudicator switches its targeted DB lookup on
 * `kind`, so this enum is the contract between the worker (which tags) and the app
 * (which looks up evidence).
 */
export type HeldKind =
  | "sub_watermark_suspected_dup" // rc_out L-019 — settled-date NEW past the watermark
  | "cross_batch_reassignment" // gsheet/deliveries — collides on date/truck/weight, different batch/loc
  | "unmapped_batch_code" // rc_out/gsheet/deliveries — no batch_id for the code
  | "unmapped_bag_type_code" // flecon — a bag-type code with no dimension row
  | "location_occupied" // deliveries/gsheet — block_loc already holds an active batch
  /**
   * BUG-027 (2026-08-25) — the SAME physical clash as `location_occupied`, but raised
   * with BOTH sides named: which batch wanted the block, which batch already holds it,
   * its balance, and when it was last fed. `location_occupied` says only "the slot is
   * taken"; every writer now raises this instead, because a person cannot act on the
   * first sentence and can act on the second. Kept as a SEPARATE kind rather than
   * re-worded in place so an old acknowledgement of the vague hold does not silently
   * answer the specific one (the fingerprint is (reportType, kind, natural_key)).
   */
  | "batch_location_conflict"
  | "malformed" // any — required field missing / unparseable
  | "low_confidence" // gsheet — NEW row below the confidence floor
  | "already_exists" // any — idempotent skip (natural key already in DB)
  | "gate_failure" // any — a HARD safety gate tripped; nothing written
  | "unmapped_or_missing_columns" // flecon — a bag-type COLUMN could not be mapped
  | "below_since_floor" // flecon — a settled date below the since floor
  | "unresolved_shift" // production — a child row with no resolvable shift_id
  | "unresolved_batch_id" // rc_out — NEW without a resolved batch_id
  | "flagged" // catch-all for a classifier FLAG with no finer kind
  | "other"; // unknown / not-yet-categorized

/**
 * A structured, DECISION-GRADE held row. The three legacy fields
 * (`reason`/`natural_key`/`detail`) are preserved for back-compat; the three new
 * fields (`kind`/`row`/`source_index`) are what make the adjudicator useful.
 *
 * NOTE: `row` must NEVER contain a ₱/cost field (`cost_basis`, any `*_price`,
 * `avg_cost`, …). Held rows are shown to every privileged role and fed to a
 * lookup — keep them cost-free.
 */
export interface HeldRow {
  /** Legacy per-report reason (kept so nothing that read it breaks). */
  reason: string;
  /** A HUMAN label for the row (never an index). */
  natural_key: string;
  detail: string;
  /** The normalized flag category the adjudicator keys its DB lookup off of. */
  kind?: HeldKind;
  /** The KEY fields the adjudicator + a DB lookup need. NEVER a ₱/cost field. */
  row?: Record<string, unknown>;
  /** The FORMER row index — retained for the apply-input mapping. */
  source_index?: string | number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-label builders — one per report grain. All cost-free by construction.
// ─────────────────────────────────────────────────────────────────────────────

/** Thousands-separated integer kg (e.g. 5820 → "5,820"). Blank for null. */
export function fmtKg(v: unknown): string {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  if (!Number.isFinite(n)) return "";
  // Round to at most 2dp, drop trailing zeros, then group thousands.
  const rounded = Math.round(n * 100) / 100;
  const [intPart, fracPart] = String(rounded).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${grouped}.${fracPart}` : grouped;
}

/** Join non-empty parts with the middot separator the panel uses. */
export function label(parts: Array<unknown>): string {
  return parts
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter((s) => s.length > 0)
    .join(" · ");
}

/**
 * rc_out human key: "2026-06-30 · JUNE-26-FEED5 · MAIN · 5,820 kg".
 * Prefers the resolved batch_code; falls back to the primary code.
 */
export function rcOutKey(row: {
  transaction_date?: unknown;
  batch_code_resolved?: unknown;
  batch_code_primary?: unknown;
  destination?: unknown;
  weight_kg?: unknown;
  day_total_kg?: unknown;
}): string {
  const bc = row.batch_code_resolved ?? row.batch_code_primary ?? null;
  const w = row.weight_kg ?? row.day_total_kg ?? null;
  const kg = fmtKg(w);
  return label([
    row.transaction_date,
    bc,
    row.destination ?? "MAIN",
    kg ? `${kg} kg` : null,
  ]);
}

/**
 * deliveries human key:
 * "2026-07-02 · JULY-26-BLK9 · A-19C · 21,789 kg · MAN 3625".
 */
export function deliveriesKey(row: {
  transaction_date?: unknown;
  batch_code?: unknown;
  block_loc?: unknown;
  weight_kg?: unknown;
  truck_plate?: unknown;
}): string {
  const kg = fmtKg(row.weight_kg);
  return label([
    row.transaction_date,
    row.batch_code,
    row.block_loc,
    kg ? `${kg} kg` : null,
    row.truck_plate,
  ]);
}

/** flecon human key: "2026-07-02 · <bag type>" (bag type = code, if we have one). */
export function fleconKey(date: unknown, bagType?: unknown): string {
  return label([date, bagType]);
}
