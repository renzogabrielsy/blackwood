/**
 * rcOutStage.ts — R2 SHADOW wiring for the rc_out reconciliation engine.
 *
 * This is the bridge between the REAL extracted rows (proposed + gsheet + movement)
 * and the pure R1 engine (`./rcOut.ts`). It buckets each source's rows into R1
 * `SourceRecord`s at the LOCKED fine key `(transaction_date, batch, block_loc,
 * destination)` summed on `weight_kg`, then runs `reconcileRcOut`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHADOW-ONLY (R2). This layer OBSERVES; it never writes. Agreements are NOT applied
 * here (that is R4's cutover). It only produces `SourceDiff` descriptors so real
 * disagreements surface as `source_diff` cases in Sync Review. The existing gsheet /
 * proposed / movement classify+apply paths are untouched — this consumes their
 * already-extracted rows and is otherwise inert.
 *
 * PURE + deterministic: no DB, no network, no I/O. The runSync IO wrapper does the
 * extraction (re-reading the same workbooks the reports read) and hands the rows here.
 * That keeps this core unit-testable with synthetic rows (see test/reconcile/rcOutStage.test.ts)
 * and keeps the report code byte-for-byte unchanged.
 *
 * GRANULARITY: see ./CONTEXT.md and ./types.ts. proposed + gsheet compete at the fine
 * key; movement is a per-DATE corroboration witness only.
 */
import type { ProposedRow } from "../reports/rc_out/extract.js";
import type { RowDict } from "../reports/gsheet/deductions.js";
import { reconcileRcOut, proposedLegsSelfConsistent } from "./rcOut.js";
import type { ReconcileResult, SourceDiff, SourceLegRow, SourceRecord } from "./types.js";

/** The rows the stage buckets. All three are OPTIONAL — a source absent from a run
 *  (no PROPOSED email, no MOVEMENT email) simply contributes no records. */
export interface RcOutReconcileInput {
  /** Raw PROPOSED DAILY REPORT block-sections (one row per block-section = one leg). */
  proposed?: ProposedRow[];
  /** Raw Google Sheet RC OUT rows (extractGsheet(...).rc_out.rows). */
  gsheetRcOut?: RowDict[];
  /** RC MOVEMENT per-date grand totals (extractMovement(...).date_to_fed_kls). */
  movementByDate?: Record<string, number>;
}

/** The additive result channel written to `sync_runs.result.reconciliation.rc_out`. */
export interface RcOutReconciliation {
  /** The field-level disagreements to surface as `source_diff` cases. */
  diffs: SourceDiff[];
  /** Count of agreements (auto-appliable in R4; telemetry only in R2). */
  agreements: number;
}

/** The top-level reconciliation channel on the run result (extensible per table). */
export interface ReconciliationChannel {
  rc_out: RcOutReconciliation;
}

const MAIN = "MAIN";

/**
 * Canonicalize a batch identity to a single comparable key so proposed and gsheet
 * bucket TOGETHER even when they carry different month-prefix conventions (the
 * batch_code_conventions problem: "MARCH-26-BLK5" vs "MAR-26-BLK5"). Both extractors
 * emit `batch_code_primary` + `batch_code_fallbacks`; the UNION of those aliases is the
 * same set for the same physical batch, so the lexicographically-smallest uppercased
 * alias is a stable common key for either source. Returns null when no code is present
 * (that row cannot participate at the fine key).
 */
export function canonicalBatchKey(
  primary: string | null | undefined,
  fallbacks: readonly string[] = [],
): string | null {
  const cands = [primary, ...fallbacks]
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim().toUpperCase());
  if (cands.length === 0) return null;
  cands.sort();
  return cands[0];
}

interface Bucket<T> {
  date: string;
  batch: string;
  block: string;
  dest: string;
  rows: T[];
}

/** Group rows by the fine key, skipping any row that cannot form one. */
function bucketBy<T>(
  rows: readonly T[],
  keyOf: (r: T) => { date: string | null; batch: string | null; block: string | null; dest: string } | null,
): Bucket<T>[] {
  const map = new Map<string, Bucket<T>>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k || k.date === null || k.batch === null || k.block === null) continue;
    const ks = [k.date, k.batch, k.block, k.dest].join("\u0000");
    const b = map.get(ks);
    if (b) b.rows.push(r);
    else map.set(ks, { date: k.date, batch: k.batch, block: k.block, dest: k.dest, rows: [r] });
  }
  return [...map.values()];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Bucket PROPOSED block-sections into fine SourceRecords. Each block-section is a leg;
 * a bucket sums `weight_kg` across its legs (L-037 leg-splitting robustness) and derives
 * `selfConsistent` from the L-037 balance rule over those legs' STRT/END/DAY TOTAL.
 * FEED blocks (block_loc null) cannot form a fine key and are skipped — a known R2 limit
 * (documented in ./CONTEXT.md; R4 broadens the key).
 */
export function bucketProposed(rows: readonly ProposedRow[]): SourceRecord[] {
  const buckets = bucketBy(rows, (r) => ({
    date: r.transaction_date ?? null,
    batch: canonicalBatchKey(r.batch_code_primary, r.batch_code_fallbacks),
    block: r.block_loc ?? null,
    dest: r.destination || MAIN,
  }));

  return buckets.map((b) => {
    const sum = round2(b.rows.reduce((acc, r) => acc + (r.weight_kg ?? 0), 0));
    const legs = b.rows.map((r) => ({
      strt_bal_kg: r.strt_bal_kg,
      end_bal_kg: r.end_bal_kg,
      day_total_kg: r.day_total_kg,
    }));
    const sc = proposedLegsSelfConsistent(legs);
    // The raw legs the sum is built from — R3's per-leg write-plan input.
    const rows: SourceLegRow[] = b.rows.map((r) => ({
      transaction_date: r.transaction_date,
      batch_code: r.batch_code_resolved ?? r.batch_code_primary ?? null,
      batch_id: r.batch_id,
      block_loc: r.block_loc,
      destination: r.destination || MAIN,
      weight_kg: r.weight_kg ?? 0,
      production_batch: r.production_batch,
      remarks: r.remarks,
    }));
    const rec: SourceRecord = {
      source: "proposed",
      naturalKey: { transaction_date: b.date, batch: b.batch, block_loc: b.block, destination: b.dest },
      fields: { weight_kg: sum },
      rows,
      selfConsistent: sc.selfConsistent,
      provenance:
        `PROPOSED DAILY REPORT ${b.date} ${b.batch} @ ${b.block} — ` +
        `${b.rows.length} leg(s) summed to ${sum} kg`,
    };
    if (sc.note) rec.selfConsistencyNote = sc.note;
    return rec;
  });
}

/**
 * Bucket Google Sheet RC OUT rows into fine SourceRecords. gsheet has NO balance
 * columns, so `selfConsistent` is true by default (it cannot fail a check it lacks —
 * ./types.ts). Rows sum per fine key exactly like proposed.
 */
export function bucketGsheetRcOut(rows: readonly RowDict[]): SourceRecord[] {
  const buckets = bucketBy(rows, (r) => {
    const date = (r.transaction_date as string | null) ?? null;
    const batch = canonicalBatchKey(
      r.batch_code_primary as string | null | undefined,
      (r.batch_code_fallbacks as string[] | undefined) ?? [],
    );
    const block = (r.block_loc as string | null) ?? null;
    const dest = (r.destination as string | null) || MAIN;
    return { date, batch, block, dest };
  });

  return buckets.map((b) => {
    const sum = round2(b.rows.reduce((acc, r) => acc + ((r.weight_kg as number | null) ?? 0), 0));
    // The raw gsheet legs the sum is built from — R3's per-leg write-plan input.
    const rows: SourceLegRow[] = b.rows.map((r) => ({
      transaction_date: (r.transaction_date as string | null) ?? b.date,
      batch_code:
        (r.batch_code_primary as string | null | undefined) ?? null,
      block_loc: (r.block_loc as string | null) ?? null,
      destination: (r.destination as string | null) || MAIN,
      weight_kg: (r.weight_kg as number | null) ?? 0,
      production_batch: (r.production_batch as string | null) ?? null,
      remarks: (r.remarks as string | null) ?? null,
    }));
    return {
      source: "gsheet",
      naturalKey: { transaction_date: b.date, batch: b.batch, block_loc: b.block, destination: b.dest },
      fields: { weight_kg: sum },
      rows,
      selfConsistent: true,
      provenance: `Google Sheet RC OUT ${b.date} ${b.batch} @ ${b.block} = ${sum} kg`,
    } satisfies SourceRecord;
  });
}

/** One date-level movement SourceRecord per date (the corroboration witness). */
export function movementSourceRecords(byDate: Record<string, number> = {}): SourceRecord[] {
  return Object.entries(byDate).map(([date, total]) => ({
    source: "movement",
    naturalKey: { transaction_date: date, batch: null, block_loc: null, destination: null },
    fields: { raw_charcoal_fed_kls: total },
    selfConsistent: true,
    provenance: `RC MOVEMENT ${date} day total = ${total} kg`,
  }));
}

/** Build the full SourceRecord set for a run from the three real extracts. */
export function buildRcOutSourceRecords(input: RcOutReconcileInput): SourceRecord[] {
  return [
    ...bucketProposed(input.proposed ?? []),
    ...bucketGsheetRcOut(input.gsheetRcOut ?? []),
    ...movementSourceRecords(input.movementByDate ?? {}),
  ];
}

/**
 * The stage entrypoint: bucket the three real extracts, run the R1 engine, and return
 * the additive channel. Pure — the runSync wrapper handles extraction + persistence.
 */
export function reconcileRcOutStage(input: RcOutReconcileInput): RcOutReconciliation {
  const records = buildRcOutSourceRecords(input);
  const result: ReconcileResult = reconcileRcOut(records);
  return { diffs: result.diffs, agreements: result.agreements.length };
}
