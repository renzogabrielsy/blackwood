/**
 * types.ts — the FROZEN Wave-3 port contract (defined by Wave 2 / M2).
 *
 * Every per-report TS port MUST export `classifyCase` with EXACTLY this
 * signature from `src/reports/<type>/index.ts`. The parity runner
 * (`npm run parity`) discovers report types by the existence of that directory
 * and calls `classifyCase` for each fixture case, canonicalizes the result the
 * same way it canonicalizes the Python oracle, and diffs the two.
 *
 * DO NOT change this interface without updating the parity runner AND every
 * existing port in lockstep — Wave-3 is built against these words.
 *
 * ---------------------------------------------------------------------------
 * Why these three parameters
 * ---------------------------------------------------------------------------
 * The Python oracle path is, universally: `extract_*(xlsx) -> classify_*(...)`.
 * The classify step consumes (a) the extractor output (derived from one or more
 * workbooks), (b) a snapshot of the DB rows it would otherwise self-fetch, and
 * (c) a few scalar knobs (`since`, `watermark`, gsheet `mode`). We pass exactly
 * those three things so the TS port can run its OWN extract->classify internally
 * and produce an envelope structurally identical to the oracle's.
 *
 *  - `workbookPaths`: role -> absolute path. Roles are per-type and match the
 *    Mail Clerk's manifest report keys, e.g.:
 *      deliveries        -> { primary, czarina? }
 *      rc_out            -> { primary, movement? }
 *      production        -> { mc?, ivy? }         (either may be absent)
 *      flecon            -> { primary }
 *      gsheet            -> { primary }            (one workbook, two tabs)
 *      rc_movement_audit -> { movement }
 *    A role absent from the map means "that source email did not arrive this
 *    run" — the port must handle it exactly as the Python orchestrator does
 *    (early-return / empty-side extract), NOT throw.
 *
 *  - `dbWindow`: the snapshot of every DB input the classify step consumes,
 *    keyed by a stable role name (see DbWindow below). This is what makes the
 *    harness reproducible OFFLINE forever — the runner feeds the SNAPSHOT to
 *    both engines, never the live DB.
 *
 *  - `opts`: the scalar knobs the orchestrator computes before classify.
 * ---------------------------------------------------------------------------
 */

export type ReportType =
  | "deliveries"
  | "rc_out"
  | "deliveries_gsheet" // reserved; gsheet is dual-mode, see note below
  | "gsheet"
  | "flecon"
  | "production"
  | "rc_movement_audit";

/**
 * A per-case snapshot of every DB input the classify step reads. Keys are
 * role names, values are whatever shape the Python `--*-json` flag expects
 * (usually a `list[dict]` or a `{code: id}` map). The runner loads
 * `fixtures/<type>/db_window/<case>.json` verbatim into this object. Unused
 * roles are simply omitted per type.
 *
 * Canonical role keys per type (matches the Python offline flags):
 *   deliveries         : { deliveries: Row[] }                         (--db-rows-json)
 *   rc_out             : { rc_out: Row[], batch_lookup: Record<string,string>,
 *                          rc_out_sums?: Record<string,number> }
 *   gsheet             : { deliveries: Row[], rc_out: Row[],
 *                          batch_lookup: Record<string,string> }
 *   flecon             : { movements: Row[], bag_types: Row[],
 *                          view_balance: Row[] }
 *   production         : { shifts: Row[], runs: Row[], downtime: Row[],
 *                          waste: Row[], electricity: Row[], trucks: Row[] }
 *   rc_movement_audit  : { rc_out_sums: Record<string,number> }
 */
export type DbWindow = Record<string, unknown>;

export interface ClassifyOpts {
  /** Window floor (YYYY-MM-DD). Always supplied; each pipeline computes it. */
  since: string;
  /**
   * Live data watermark (MAX(date)) for pipelines that pass one (rc_out).
   * `null` = no watermark (fresh/empty table). Omitted for pipelines that
   * have no watermark concept (gsheet, flecon uses `since` only).
   */
  watermark?: string | null;
  /** gsheet only: which tab to classify. */
  mode?: "rc_in" | "rc_out";
  /** Extra per-type scalar knobs may be added here; ports ignore unknown keys. */
  [key: string]: unknown;
}

/**
 * The classify envelope — the unit of parity. This mirrors the Python
 * `classify_envelope(...)` shape (orchestrator_common.py) for the writer
 * pipelines; flecon/production/audit use their own top-level shapes, which the
 * canonicalizer treats generically (it never assumes these exact keys). We type
 * it loosely on purpose: parity is by-VALUE after canonicalization, not by
 * TS structural typing.
 */
export interface ClassifyEnvelope {
  report_type?: string;
  ok?: boolean;
  gate_failures?: unknown[];
  counts?: Record<string, number>;
  rows_preview?: unknown[];
  watermark?: unknown;
  codified_rules_applied?: unknown[];
  [key: string]: unknown;
}

/**
 * THE FROZEN PORT ENTRYPOINT. Wave-3 implements one of these per type.
 *
 * Contract:
 *  - Pure w.r.t. the DB: reads ONLY `dbWindow`, never a live connection.
 *  - Reads workbooks ONLY from `workbookPaths` (absolute paths).
 *  - Returns the classify envelope (NOT the apply result). The parity harness
 *    gates on classify output; apply parity is covered separately in M3.
 *  - Deterministic: same inputs -> byte-identical output after canonicalization.
 *  - Throws only on genuinely unrecoverable input; a missing optional workbook
 *    role is normal (mirror the Python early-return/empty-side behavior).
 */
export type ClassifyCase = (
  workbookPaths: Record<string, string>,
  dbWindow: DbWindow,
  opts: ClassifyOpts,
) => Promise<ClassifyEnvelope>;
