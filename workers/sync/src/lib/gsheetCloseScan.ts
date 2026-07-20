/**
 * gsheetCloseScan.ts — PURE planner for the Google-Sheet RC OUT batch-close scan.
 *
 * WHY THIS EXISTS (the R4b close-remark gap). A batch is closed (feeding finished) when
 * an rc_out row carries a closing remark ("CLOSED" / "DONE" / …). The DB does this
 * automatically via the `fn_process_blackwood_usage` trigger — BUT only for rc_out rows
 * that actually get WRITTEN. Under the R4b cutover the gsheet-sync no longer writes
 * rc_out (the PROPOSED report is the sole rc_out writer, see reconcile-r4b), so a "CLOSED"
 * remark typed into the Google Sheet's RC OUT tab is structurally dropped and never
 * reaches the trigger — the batch stays IN-USE forever.
 *
 * This planner closes that gap WITHOUT writing rc_out: it decides, from the gsheet RC OUT
 * rows + the live batch directory, which batches to flip IN-USE→CLOSED (a `batches.status`
 * only write, applied by the caller via the SECURITY DEFINER `fn_close_batch`). It is a
 * MONOTONIC state flip on a machine-verifiable signal (the sheet says CLOSED and nothing
 * contradicts it) — NOT a source disagreement, so it is NOT a reconciliation diff case
 * (SYNC_RECONCILIATION_MODEL.md: batch identity/state exceptions write through directly).
 *
 * PURE: zero I/O. The caller supplies the resolved batch directory and applies the closes.
 * Deterministic → unit-testable without a DB.
 */
import { isClosingRemark } from "./closingRemarks.js";

/** The subset of an extracted gsheet RC OUT row this scan reads (`reports/gsheet/extract.ts`
 *  extractRcOut RowDict). NEVER a ₱/cost field. */
export interface GsheetRcOutRowLike {
  transaction_date?: string | null;
  batch_code_primary?: string | null;
  batch_code_fallbacks?: readonly string[] | null;
  block_loc?: string | null;
  weight_kg?: number | null;
  remarks?: string | null;
  _source_row?: number | null;
}

/** A live batch's identity + current state, as the caller resolves it from `batches`. */
export interface BatchDirEntry {
  id: string;
  status: string;
  location_ref: string | null;
}

/** One batch to flip IN-USE→CLOSED this run. */
export interface PlannedClose {
  batch_id: string;
  /** The batch_code that actually matched the directory (primary or a fallback alias). */
  batch_code: string;
  /** The primary code the sheet row named (may differ from `batch_code` via alias). */
  requested_code: string;
  location_ref: string | null;
  transaction_date: string | null;
  block_loc: string | null;
  source_row: number | null;
}

/** A closing remark whose batch_code could not be matched to any live batch. */
export interface UnmatchedClose {
  requested_code: string | null;
  transaction_date: string | null;
  block_loc: string | null;
  source_row: number | null;
}

export interface CloseScanPlan {
  /** Batches to flip to CLOSED (currently NOT closed) — one entry per batch (deduped). */
  closes: PlannedClose[];
  /** Rows whose batch was matched but is ALREADY CLOSED — a silent no-op, counted only. */
  alreadyClosed: number;
  /** Rows asserting CLOSED whose batch_code matched no live batch — surfaced as a warning. */
  unmatched: UnmatchedClose[];
}

/**
 * The app-facing surfaced record for one close-scan outcome, carried on
 * `result.reconciliation.batch_closes` and flattened into a RunFinding
 * (`lib/sync/findings.ts::fromBatchClosed`). `matched:true` = a batch was actually closed
 * (info); `matched:false` = the sheet asserted CLOSED but no live batch matched (attention).
 * NEVER a ₱/cost field.
 */
export interface BatchClose {
  /** The matched batch_code (matched=true) or the requested code (matched=false). */
  batch_code: string | null;
  location_ref: string | null;
  transaction_date: string | null;
  block_loc: string | null;
  source_row: number | null;
  matched: boolean;
}

/** Flatten a plan's closes + unmatched into the channel record list (order: closes, then unmatched). */
export function toChannelBatchCloses(plan: CloseScanPlan): BatchClose[] {
  const out: BatchClose[] = [];
  for (const c of plan.closes) {
    out.push({
      batch_code: c.batch_code,
      location_ref: c.location_ref,
      transaction_date: c.transaction_date,
      block_loc: c.block_loc,
      source_row: c.source_row,
      matched: true,
    });
  }
  for (const u of plan.unmatched) {
    out.push({
      batch_code: u.requested_code,
      location_ref: null,
      transaction_date: u.transaction_date,
      block_loc: u.block_loc,
      source_row: u.source_row,
      matched: false,
    });
  }
  return out;
}

/** Ordered candidate codes for a row: primary first, then each fallback (de-duped, non-empty). */
function candidateCodes(row: GsheetRcOutRowLike): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (c: string | null | undefined) => {
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  push(row.batch_code_primary);
  for (const fb of row.batch_code_fallbacks ?? []) push(fb);
  return out;
}

/**
 * Plan which batches to close from the gsheet RC OUT rows.
 *
 * @param rows       extracted gsheet RC OUT rows (order preserved; first close wins per batch)
 * @param batchByCode  live batch directory keyed by batch_code → {id, status, location_ref}
 */
export function planGsheetCloses(
  rows: readonly GsheetRcOutRowLike[],
  batchByCode: Readonly<Record<string, BatchDirEntry>>,
): CloseScanPlan {
  const closes: PlannedClose[] = [];
  const unmatched: UnmatchedClose[] = [];
  const closedBatchIds = new Set<string>();
  let alreadyClosed = 0;

  for (const row of rows) {
    if (!isClosingRemark(row.remarks)) continue;

    const codes = candidateCodes(row);
    let matched: { code: string; entry: BatchDirEntry } | null = null;
    for (const code of codes) {
      const entry = batchByCode[code];
      if (entry) {
        matched = { code, entry };
        break;
      }
    }

    if (!matched) {
      unmatched.push({
        requested_code: row.batch_code_primary ?? null,
        transaction_date: row.transaction_date ?? null,
        block_loc: row.block_loc ?? null,
        source_row: row._source_row ?? null,
      });
      continue;
    }

    const { entry } = matched;
    if (entry.status === "CLOSED") {
      alreadyClosed += 1;
      continue;
    }
    if (closedBatchIds.has(entry.id)) continue; // another closing row already planned it
    closedBatchIds.add(entry.id);
    closes.push({
      batch_id: entry.id,
      batch_code: matched.code,
      requested_code: row.batch_code_primary ?? matched.code,
      location_ref: entry.location_ref,
      transaction_date: row.transaction_date ?? null,
      block_loc: row.block_loc ?? null,
      source_row: row._source_row ?? null,
    });
  }

  return { closes, alreadyClosed, unmatched };
}
