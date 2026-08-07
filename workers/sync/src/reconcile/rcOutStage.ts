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
import type { BatchLookup } from "../reports/rc_out/classify.js";
import { reconcileRcOut, proposedLegsSelfConsistent } from "./rcOut.js";
import { isKnownPatioAlias, normalizeProposedBlock } from "./blockAliases.js";
import type { BlockReconciliation } from "./blockBalance.js";
import type { BatchClose } from "../lib/gsheetCloseScan.js";
import type { ScheduleConflict } from "../reports/prodSchedule/plan.js";
import type { StaleStream } from "../lib/streamStaleness.js";
import type { ReportArtifact } from "../reports/excel/artifact.js";
import {
  LAG_DAYS,
  type Agreement,
  type AttributionDiff,
  type ReconcileResult,
  type SingleSourceOverdue,
  type SourceDiff,
  type SourceLegRow,
  type SourceRecord,
  type UnresolvedBatch,
} from "./types.js";

/** The rows the stage buckets. All three extracts are OPTIONAL — a source absent from a run
 *  (no PROPOSED email, no MOVEMENT email) simply contributes no records. */
export interface RcOutReconcileInput {
  /** Raw PROPOSED DAILY REPORT block-sections (one row per block-section = one leg). */
  proposed?: ProposedRow[];
  /** Raw Google Sheet RC OUT rows (extractGsheet(...).rc_out.rows). */
  gsheetRcOut?: RowDict[];
  /** RC MOVEMENT per-date grand totals (extractMovement(...).date_to_fed_kls). */
  movementByDate?: Record<string, number>;
  /**
   * R4a — batch_code → batch_id map (the rc_out report's `dbWindow.batch_lookup`). Sources are
   * now aligned by RESOLVED batch_id, not code strings, so two conventions that map to the same
   * batch align (no silent miss) and a code that can't resolve surfaces as a case (Deliverable
   * 1). When empty, every fine row is unresolvable (0 candidates) → all become `unresolved_batch`.
   */
  batchLookup?: BatchLookup;
  /**
   * R4a — the sync run's calendar date (YYYY-MM-DD), threaded from the run row. Drives the
   * single-witness pending vs held_overdue split (Deliverable 3). Absent → no disposition.
   */
  runDate?: string;
  /** Overdue threshold in days. Default LAG_DAYS. */
  lagDays?: number;
}

/** The additive result channel written to `sync_runs.result.reconciliation.rc_out`. */
export interface RcOutReconciliation {
  /** The field-level disagreements to surface as `source_diff` cases. */
  diffs: SourceDiff[];
  /** Count of agreements (auto-appliable in R4b; telemetry only in shadow). */
  agreements: number;
  /**
   * R4a — count of single-witness facts INSIDE the lag window (self-clear next run when the
   * second source arrives). Telemetry ONLY — no case (Deliverable 3/4).
   */
  pending: number;
  /** R4a — single-witness facts OLDER than the lag window → `single_source_overdue` cases. */
  heldOverdue: SingleSourceOverdue[];
  /** R4a — batches that could not resolve to one batch_id → `unresolved_batch` cases. */
  unresolvedBatches: UnresolvedBatch[];
  /**
   * Second-pass attribution matcher — pairs of single-witness facts that are almost
   * certainly the SAME physical feeding under two different batch/block attributions
   * (see ./rcOut.ts § "Second-pass attribution matcher" + ./CONTEXT.md). Each pair
   * REPLACES the two single-witness facts it consumed, so they do NOT also appear in
   * `heldOverdue` / count toward `pending`. → `attribution_diff` cases (dismiss-only, v1).
   */
  attributionDiffs: AttributionDiff[];
  /**
   * Patio block-name aliases (./blockAliases.ts) — count of PROPOSED rows this run whose
   * raw descriptive block_loc (e.g. "16A NEAR WALL") matched a known alias and was
   * normalized to the Sheet's coded block (e.g. "PCA-16A") before bucketing. Telemetry
   * ONLY — feeds the run-summary visibility line
   * (`workflows/runSync.ts::reconcileRcOutShadow`); never a case, never a write.
   */
  patioAliasesApplied: number;
}

/** The top-level reconciliation channel on the run result (extensible per table).
 *  `rc_out` is the same-fact rc_out reconciliation (R1–R4b). `blocking` is the RB
 *  block-balance cross-check (`./blockBalance.ts`) — an ORTHOGONAL, read-only net.
 *  `batch_closes` is the gsheet close-scan outcome (`../lib/gsheetCloseScan.ts`) — batches
 *  flipped IN-USE→CLOSED from a Google Sheet RC OUT close remark the R4b cutover would
 *  drop. `schedule_conflicts` is the production-PLAN Stage-3c outcome
 *  (`../reports/prodSchedule/plan.ts`) — days a human owns whose upstream (Joseph) value
 *  the sync WITHHELD and parked instead of applying. `stale_streams` is the freshness
 *  watch (`../lib/streamStaleness.ts`) — streams that have missed a planned working day,
 *  read straight off `view_digest_stream_status`. Unlike the others it is not about what
 *  this run WROTE; it is about what never arrived, which is exactly the failure a clean
 *  run hides. All are OPTIONAL: a run may carry any, all, or (on failure) none. */
export interface ReconciliationChannel {
  rc_out?: RcOutReconciliation;
  blocking?: BlockReconciliation;
  batch_closes?: BatchClose[];
  schedule_conflicts?: ScheduleConflict[];
  stale_streams?: StaleStream[];
  /**
   * The Excel sync report generated for this run (`../reports/excel/generate.ts`),
   * 2026-08-07. Unlike every other member this is not something the sync OBSERVED — it is
   * a pointer to the workbook the run produced, written on EVERY terminal run so the panel
   * can offer the download without a second query. It becomes a FINDING only when
   * `ok:false`; a reporting tool that can break the thing it reports on is worse than no
   * tool, so generation never fails a run — it just says so.
   */
  report_artifact?: ReportArtifact;
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

/**
 * R4a Deliverable 1 — resolve a source's batch identity to a batch_id via the SAME
 * primary-then-fallbacks lookup the rc_out classify path uses. This MIRRORS (does not import —
 * that fn is `ProposedRow`-typed and unexported) `reports/rc_out/classify.ts::resolveBatchId`,
 * the exact idiom already mirrored by `proposedLegsSelfConsistent` for the balance guard. Key
 * match is EXACT (no normalize), matching the classify resolver.
 *
 * It ALSO detects ambiguity the write-path resolver hides: it returns the DISTINCT set of
 * batch_ids that ANY of {primary, ...fallbacks} map to. Exactly one → resolved. Zero (no code
 * matched) or 2+ (codes point at DIFFERENT batches) → UNRESOLVED — the caller must emit an
 * `unresolved_batch` marker, never a silent single-source Agreement (Refinement 4).
 */
export function resolveBatchCandidates(
  primary: string | null | undefined,
  fallbacks: readonly string[] = [],
  lookup: BatchLookup = {},
): { batchId: string | null; candidates: string[] } {
  const codes = [primary, ...fallbacks].filter(
    (c): c is string => typeof c === "string" && c.trim().length > 0,
  );
  const ids = new Set<string>();
  for (const code of codes) {
    if (code in lookup) ids.add(lookup[code]);
  }
  const candidates = [...ids];
  return { batchId: candidates.length === 1 ? candidates[0] : null, candidates };
}

/** Fine-bucket key separator + FEED sentinel (null block). Built with String.fromCharCode so the
 *  SOURCE file carries NO raw control byte AND no \uXXXX escape (component values can't contain a
 *  NUL) — the null delimiter is created only at runtime. */
const SEP = String.fromCharCode(0);
const FEED_SENTINEL = String.fromCharCode(0) + "FEED";

/** Canonical fine-bucket key. R4a: a null block (FEED) keys on (date, batch_id, dest) — the
 *  feed batch is its own discriminator (Deliverable 2); standard blocks keep their block_loc. */
function fineBucketKey(date: string, batchId: string, block: string | null, dest: string): string {
  return [date, batchId, block ?? FEED_SENTINEL, dest].join(SEP);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Merge an UnresolvedBatch into a map keyed by (date, batch_code) — collapsing the same
 *  unresolvable code across legs AND across sources into ONE marker (→ one case). */
function mergeUnresolvedInto(map: Map<string, UnresolvedBatch>, u: UnresolvedBatch): void {
  const k = u.transaction_date + SEP + u.batch_code;
  const e = map.get(k);
  if (!e) {
    map.set(k, { ...u, candidates: [...u.candidates], sources: [...u.sources] });
    return;
  }
  e.weight_kg = round2(e.weight_kg + u.weight_kg);
  for (const c of u.candidates) if (!e.candidates.includes(c)) e.candidates.push(c);
  for (const s of u.sources) if (!e.sources.includes(s)) e.sources.push(s);
  if (e.block_loc === null && u.block_loc !== null) e.block_loc = u.block_loc;
}

/** A fine bucket keyed by RESOLVED batch_id; block MAY be null (FEED). */
interface FineBucket<T> {
  date: string;
  batchId: string;
  block: string | null;
  dest: string;
  rows: T[];
}

/**
 * R4a Deliverable 1+2 — resolve each row's batch to a batch_id and bucket the RESOLVED rows by
 * the fine key `(date, batch_id, block, dest)` (block null = FEED). Rows whose batch can't
 * resolve to exactly one id are collected as UnresolvedBatch markers, never a silent
 * single-source pass. Rows with NO batch code at all cannot form ANY key and are skipped (an
 * extraction gap, not an `unresolved_batch`).
 */
function resolveAndBucket<T>(
  source: "proposed" | "gsheet",
  rows: readonly T[],
  lookup: BatchLookup,
  fieldsOf: (r: T) => {
    date: string | null;
    primary: string | null;
    fallbacks: string[];
    block: string | null;
    dest: string;
    weight: number;
  },
): { buckets: FineBucket<T>[]; unresolved: UnresolvedBatch[] } {
  const bucketMap = new Map<string, FineBucket<T>>();
  const unresolvedMap = new Map<string, UnresolvedBatch>();

  for (const r of rows) {
    const f = fieldsOf(r);
    if (!f.date) continue;
    const codes = [f.primary, ...f.fallbacks].filter(
      (c): c is string => typeof c === "string" && c.trim().length > 0,
    );
    if (codes.length === 0) continue; // no batch stated → cannot form any key (as R2)

    const { batchId, candidates } = resolveBatchCandidates(f.primary, f.fallbacks, lookup);
    if (batchId === null) {
      mergeUnresolvedInto(unresolvedMap, {
        transaction_date: f.date,
        batch_code: f.primary ?? codes[0],
        candidates,
        block_loc: f.block,
        destination: f.dest,
        weight_kg: f.weight,
        sources: [source],
      });
      continue;
    }

    const ks = fineBucketKey(f.date, batchId, f.block, f.dest);
    const b = bucketMap.get(ks);
    if (b) b.rows.push(r);
    else bucketMap.set(ks, { date: f.date, batchId, block: f.block, dest: f.dest, rows: [r] });
  }

  return { buckets: [...bucketMap.values()], unresolved: [...unresolvedMap.values()] };
}

/**
 * Bucket PROPOSED block-sections into fine SourceRecords keyed by RESOLVED batch_id. A bucket
 * sums `weight_kg` across its legs (L-037 leg-splitting robustness) and derives `selfConsistent`
 * from the L-037 balance rule over those legs' STRT/END/DAY TOTAL. FEED rows (block_loc null)
 * now reconcile too — keyed on (date, batch_id, dest) (R4a Deliverable 2). Returns the records
 * plus any UnresolvedBatch markers (Deliverable 1).
 *
 * PATIO BLOCK ALIASES (./blockAliases.ts, 2026-07-13): before keying, a proposed row's raw
 * descriptive block_loc (e.g. "16A NEAR WALL") is passed through `normalizeProposedBlock` —
 * a known patio alias resolves to the Sheet's coded block (e.g. "PCA-16A"), so the bucket
 * key (and therefore the resulting SourceRecord's `naturalKey.block_loc`) aligns with
 * gsheet's OWN already-coded rows (`bucketGsheetRcOut`, which needs no aliasing — it is
 * already coded). An unrecognized block_loc passes through unchanged. This is ONLY a
 * keying change — the underlying `SourceLegRow.block_loc` on each leg (below) keeps the
 * ORIGINAL descriptive string for audit/display, since this layer never writes and the
 * alias exists solely to stop false reconciliation cases.
 */
export function bucketProposed(
  rows: readonly ProposedRow[],
  lookup: BatchLookup = {},
): { records: SourceRecord[]; unresolved: UnresolvedBatch[]; patioAliasesApplied: number } {
  const patioAliasesApplied = rows.reduce(
    (acc, r) => acc + (isKnownPatioAlias(r.block_loc ?? null) ? 1 : 0),
    0,
  );
  const { buckets, unresolved } = resolveAndBucket("proposed", rows, lookup, (r) => ({
    date: r.transaction_date ?? null,
    primary: r.batch_code_primary ?? null,
    fallbacks: r.batch_code_fallbacks ?? [],
    block: normalizeProposedBlock(r.block_loc ?? null),
    dest: r.destination || MAIN,
    weight: r.weight_kg ?? 0,
  }));

  const records = buckets.map((b) => {
    const sum = round2(b.rows.reduce((acc, r) => acc + (r.weight_kg ?? 0), 0));
    const legs = b.rows.map((r) => ({
      strt_bal_kg: r.strt_bal_kg,
      end_bal_kg: r.end_bal_kg,
      day_total_kg: r.day_total_kg,
    }));
    const sc = proposedLegsSelfConsistent(legs);
    // The raw legs the sum is built from — R3's per-leg write-plan input. batch_id is the
    // RESOLVED id (shadow re-extract does not run classify, so use the reconciler's resolution).
    const legRows: SourceLegRow[] = b.rows.map((r) => ({
      transaction_date: r.transaction_date,
      batch_code: r.batch_code_resolved ?? r.batch_code_primary ?? null,
      batch_id: b.batchId,
      block_loc: r.block_loc,
      destination: r.destination || MAIN,
      weight_kg: r.weight_kg ?? 0,
      production_batch: r.production_batch,
      remarks: r.remarks,
    }));
    const blkLabel = b.block ? " @ " + b.block : " (FEED)";
    const rec: SourceRecord = {
      source: "proposed",
      naturalKey: { transaction_date: b.date, batch: b.batchId, block_loc: b.block, destination: b.dest },
      fields: { weight_kg: sum },
      rows: legRows,
      selfConsistent: sc.selfConsistent,
      provenance:
        `PROPOSED DAILY REPORT ${b.date} batch ${b.batchId}${blkLabel} — ` +
        `${b.rows.length} leg(s) summed to ${sum} kg`,
    };
    if (sc.note) rec.selfConsistencyNote = sc.note;
    return rec;
  });

  return { records, unresolved, patioAliasesApplied };
}

/**
 * Bucket Google Sheet RC OUT rows into fine SourceRecords keyed by RESOLVED batch_id. gsheet has
 * NO balance columns, so `selfConsistent` is true by default (it cannot fail a check it lacks —
 * ./types.ts). Rows sum per fine key exactly like proposed; FEED rows (null block) reconcile too.
 */
export function bucketGsheetRcOut(
  rows: readonly RowDict[],
  lookup: BatchLookup = {},
): { records: SourceRecord[]; unresolved: UnresolvedBatch[] } {
  const { buckets, unresolved } = resolveAndBucket("gsheet", rows, lookup, (r) => ({
    date: (r.transaction_date as string | null) ?? null,
    primary: (r.batch_code_primary as string | null | undefined) ?? null,
    fallbacks: (r.batch_code_fallbacks as string[] | undefined) ?? [],
    block: (r.block_loc as string | null) ?? null,
    dest: (r.destination as string | null) || MAIN,
    weight: (r.weight_kg as number | null) ?? 0,
  }));

  const records = buckets.map((b) => {
    const sum = round2(b.rows.reduce((acc, r) => acc + ((r.weight_kg as number | null) ?? 0), 0));
    const legRows: SourceLegRow[] = b.rows.map((r) => ({
      transaction_date: (r.transaction_date as string | null) ?? b.date,
      batch_code: (r.batch_code_primary as string | null | undefined) ?? null,
      batch_id: b.batchId,
      block_loc: (r.block_loc as string | null) ?? null,
      destination: (r.destination as string | null) || MAIN,
      weight_kg: (r.weight_kg as number | null) ?? 0,
      production_batch: (r.production_batch as string | null) ?? null,
      remarks: (r.remarks as string | null) ?? null,
    }));
    const blkLabel = b.block ? " @ " + b.block : " (FEED)";
    return {
      source: "gsheet",
      naturalKey: { transaction_date: b.date, batch: b.batchId, block_loc: b.block, destination: b.dest },
      fields: { weight_kg: sum },
      rows: legRows,
      selfConsistent: true,
      provenance: `Google Sheet RC OUT ${b.date} batch ${b.batchId}${blkLabel} = ${sum} kg`,
    } satisfies SourceRecord;
  });

  return { records, unresolved };
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

/**
 * Build the SourceRecord set for a run from the three real extracts, plus the cross-source
 * UnresolvedBatch markers. proposed + gsheet resolve to batch_id (R4a); their unresolved markers
 * are merged by (date, batch_code) so one unresolvable code is ONE marker regardless of source.
 */
export function buildRcOutSourceRecords(
  input: RcOutReconcileInput,
): { records: SourceRecord[]; unresolved: UnresolvedBatch[]; patioAliasesApplied: number } {
  const lookup = input.batchLookup ?? {};
  const p = bucketProposed(input.proposed ?? [], lookup);
  const g = bucketGsheetRcOut(input.gsheetRcOut ?? [], lookup);
  const m = movementSourceRecords(input.movementByDate ?? {});

  const merged = new Map<string, UnresolvedBatch>();
  for (const u of [...p.unresolved, ...g.unresolved]) mergeUnresolvedInto(merged, u);

  return {
    records: [...p.records, ...g.records, ...m],
    unresolved: [...merged.values()],
    patioAliasesApplied: p.patioAliasesApplied,
  };
}

/** Provenance line for a single-source overdue fact (the Agreement carries no provenance). */
function singleSourceProvenance(a: Agreement): string {
  const k = a.naturalKey;
  const blk = k.block_loc ? " @ " + k.block_loc : " (FEED)";
  const v = typeof a.value === "number" ? String(a.value) : String(a.value);
  return `${a.sources[0]} ${k.transaction_date} batch ${k.batch ?? "?"}${blk} = ${v}`;
}

/**
 * The stage entrypoint: bucket the three real extracts, run the R1 engine (threading runDate for
 * the pending/held split), and return the additive channel. Pure — the runSync wrapper handles
 * extraction + persistence. Splits single-source agreements into a `pending` count (telemetry,
 * NO case) vs `heldOverdue` facts (→ `single_source_overdue` cases), and surfaces batch-resolution
 * failures as `unresolvedBatches` (→ `unresolved_batch` cases). Multi-source agreements + diffs
 * are unchanged.
 */
export function reconcileRcOutStage(input: RcOutReconcileInput): RcOutReconciliation {
  const { records, unresolved, patioAliasesApplied } = buildRcOutSourceRecords(input);
  const result: ReconcileResult = reconcileRcOut(records, {
    runDate: input.runDate,
    lagDays: input.lagDays,
  });

  let pending = 0;
  const heldOverdue: SingleSourceOverdue[] = [];
  for (const a of result.agreements) {
    if (!a.singleSource) continue;
    if (a.disposition === "pending") {
      pending++;
    } else if (a.disposition === "held_overdue") {
      heldOverdue.push({
        naturalKey: a.naturalKey,
        field: a.field,
        table: "rc_out",
        source: a.sources[0],
        value: a.value,
        provenance: singleSourceProvenance(a),
        ageDays: a.ageDays ?? 0,
        lagDays: input.lagDays ?? LAG_DAYS,
      });
    }
    // disposition undefined → settled history (or no runDate): neither pending nor a case.
  }

  return {
    diffs: result.diffs,
    agreements: result.agreements.length,
    pending,
    heldOverdue,
    unresolvedBatches: unresolved,
    attributionDiffs: result.attributionDiffs,
    patioAliasesApplied,
  };
}
