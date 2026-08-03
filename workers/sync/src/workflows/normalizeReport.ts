/**
 * normalizeReport.ts — the ASSEMBLY-BOUNDARY normalizer (bug-fix, 2026-07-06).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Each report's `runReport(...)` returns a FLAT apply result:
 *     { report_type, ok, inserts, updates, [replaced_dates], held: HeldRow[],
 *       labeled, watermark_updated, errors }
 * plus its own classify block (counts/gate_failures/watermark).
 *
 * The FRONTEND (app/(app)/sync/types.ts + lib/sync/reducer.ts + SyncEmployeeCard +
 * HeldRows) reads a DIFFERENT, NESTED shape per report — `SyncRunReportResult`:
 *     { classify: ClassifyResult | null, apply: ApplyResult | null }
 * where `ApplyResult.applied` is a NESTED `{inserts, updates, replaced_dates}` object
 * (ALWAYS present on any non-null apply), and `held` is the FULL `HeldRow[]` ROWS —
 * not a count. That nested contract is the frozen SYNC_CLI_CONTRACT.md apply envelope.
 *
 * The old `ReportEnvelope` (reportWorkflow.ts) collapsed `held` to a COUNT, flattened
 * `applied`, and dropped `classify` entirely — so applied counts + the Held-for-review
 * section never populated, and a gate-failed report rendered nothing.
 *
 * This module maps EVERY report's `runReport()` return into `SyncRunReportResult`, so
 * what `runSync` writes to `sync_runs.result.reports[<type>]` is EXACTLY what the
 * frontend reads. It touches ONLY apply-result SHAPING + classify assembly — never the
 * report classify/extract/parity paths (those stay byte-identical).
 *
 * The types here are the WORKER-SIDE MIRROR of the frontend types. They MUST stay in
 * lockstep with app/(app)/sync/types.ts (`SyncRunReportResult`, `ClassifyResult`,
 * `ApplyResult`, `HeldRow`, `ApplyApplied`). The unit harness
 * (test/normalizeReport.test.ts) + scripts/verify-sync-reducer.ts assert both sides
 * describe the same JSON.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Worker-side mirror of the frontend contract (app/(app)/sync/types.ts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror of the frontend `HeldRow`. The three legacy fields are always present;
 * the three enrichment fields (kind/row/source_index, 2026-07-06) are optional and
 * passed through verbatim so the app adjudicator gets a decision-grade payload.
 * See src/reports/held.ts for the authoritative construction + the HeldKind enum.
 */
export interface HeldRow {
  reason: string;
  natural_key: string;
  detail: string;
  /** Normalized flag category the app keys its DB lookup off of. */
  kind?: string;
  /** Structured KEY fields for the adjudicator + DB lookup. NEVER a ₱/cost field. */
  row?: Record<string, unknown>;
  /** The former row index — retained for the apply-input mapping. */
  source_index?: string | number;
}

/** Mirror of the frontend `GateFailure`. */
export interface GateFailure {
  gate: string;
  detail: string;
}

/** Mirror of the frontend `ClassifyCounts`. */
export interface ClassifyCounts {
  noop: number;
  insert: number;
  update: number;
  flagged: number;
}

/** Mirror of the frontend `RowPreview`. */
export interface RowPreview {
  action: string;
  natural_key: string;
  summary: string;
}

/**
 * Mirror of the frontend `ClassifyResult`. The reducer/cards read `ok`,
 * `gate_failures`, `counts`, `watermark`; `rows_preview`/`classified_path`/`source`
 * are carried for contract-completeness (the worker has no per-row preview or
 * classified-file path, so they default to empty — the UI never depends on them).
 */
export interface ClassifyResult {
  report_type: string;
  ok: boolean;
  gate_failures: GateFailure[];
  counts: ClassifyCounts;
  rows_preview: RowPreview[];
  classified_path: string;
  source: Record<string, unknown>;
  watermark: string | null;
  /** Extra per-report breakdowns the CLI carried under top-level keys (per_mode /
   *  per_section / severity). Optional — the reducer ignores unknown keys. */
  [key: string]: unknown;
}

/** Mirror of the frontend `ApplyApplied` — the NESTED applied-counts object. */
export interface ApplyApplied {
  inserts: number;
  updates: number;
  /** COUNT of dates whose rows were replaced (flecon REPLACE-BY-DATE). A number. */
  replaced_dates: number;
}

/**
 * One batch the sync auto-created this apply (2026-07-11 policy — see
 * lib/batchAutoCreate.ts). Mirror of the frontend `AutoCreatedBatch`. NEVER a
 * ₱/cost field (avg_cost is always null on an auto-created batch).
 */
export interface AutoCreatedBatchNote {
  batch_code: string;
  location_ref: string;
  mode?: "rc_in" | "rc_out";
  transaction_date: string | null;
  block_loc: string | null;
  source_row: string | number | null;
}

/**
 * One production-batch CHANGEOVER a run announced (2026-08-03 — see
 * reports/production/productionBatch.ts). Mirror of the frontend
 * `ProductionBatchStart`. NEVER a ₱/cost field.
 */
export interface ProductionBatchStartNote {
  transaction_date: string;
  new_batch: string;
  previous_batch: string;
  derivation: string;
  source_sheet: string;
}

/**
 * Mirror of the frontend `ApplyResult`. `applied` is ALWAYS present on any non-null
 * apply (default zeros) so the card never sees a missing `applied` — even on a
 * gate-failure / error path where nothing was written. `held` carries the ROWS.
 * `auto_created_batches` is ALWAYS present (default []) — the run-visibility list of
 * batches the sync auto-created this apply.
 */
export interface ApplyResult {
  report_type: string;
  ok: boolean;
  applied: ApplyApplied;
  held: HeldRow[];
  labeled: boolean;
  watermark_updated: boolean;
  errors: string[];
  auto_created_batches: AutoCreatedBatchNote[];
  /** Production-batch changeovers this apply announced. ALWAYS present (default []). */
  production_batch_starts: ProductionBatchStartNote[];
}

/** Terminal card status the worker may pre-decide (mirror of frontend SyncCardStatus). */
export type SyncCardStatus =
  | "idle"
  | "classifying"
  | "applying"
  | "done"
  | "gate-failed"
  | "error"
  | "stopped";

/**
 * Mirror of the frontend `SyncRunReportResult` — the per-report unit written to
 * `sync_runs.result.reports[<type>]`. This is THE canonical shape.
 *   - Read-only auditor (rc_movement_audit) + dryRun apply → `apply: null`.
 *   - A report that never ran (no source email) still returns a `classify` with zero
 *     counts and `apply` reflecting the empty write (or null in dryRun).
 */
export interface SyncRunReportResult {
  classify: ClassifyResult | null;
  apply: ApplyResult | null;
  status?: SyncCardStatus;
  error?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loose input shapes — what each report's runReport() actually returns. We read
// these defensively (every field guarded) so a shape drift degrades to zeros, never
// a crash at the assembly boundary.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A report classify block as returned by the writer ports (deliveries/rc_out/…).
 * Loose + read defensively — every field guarded in `normalizeClassify`. No index
 * signature so the concrete port classify types assign structurally.
 */
interface RawClassify {
  report_type?: string;
  ok?: boolean;
  gate_failures?: ReadonlyArray<{ gate?: unknown; detail?: unknown }>;
  counts?: { noop?: number; insert?: number; update?: number; flagged?: number };
  watermark?: string | null;
}

/**
 * A flat apply result as returned by the writer ports' apply.ts. Loose superset of
 * every port's apply return (deliveries/rc_out/production/flecon/gsheet) — the shared
 * fields plus flecon's `replaced_dates`. No index signature (see RawClassify).
 */
interface RawApply {
  report_type?: string;
  ok?: boolean;
  inserts?: number;
  updates?: number;
  /** flecon only — dates replaced (REPLACE-BY-DATE). */
  replaced_dates?: number;
  held?: unknown;
  labeled?: boolean;
  watermark_updated?: boolean;
  errors?: unknown;
  /** gsheet (top-level) / rc_out — batches auto-created this apply. */
  auto_created_batches?: unknown;
  /** production only — batch changeovers announced this apply. */
  production_batch_starts?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion helpers — every field guarded (a bad worker write must never crash the
// assembly; it degrades to a safe default).
// ─────────────────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str) : [];
}

/** Coerce a raw held entry (typed reason unions, optional detail) → contract HeldRow.
 *  Passes the enrichment fields (kind/row/source_index) through when present. */
function toHeldRow(h: unknown): HeldRow {
  const o = (h ?? {}) as Record<string, unknown>;
  const out: HeldRow = {
    reason: str(o.reason),
    natural_key: str(o.natural_key),
    detail: str(o.detail),
  };
  if (typeof o.kind === "string") out.kind = o.kind;
  if (o.row && typeof o.row === "object" && !Array.isArray(o.row)) {
    out.row = o.row as Record<string, unknown>;
  }
  if (typeof o.source_index === "string" || typeof o.source_index === "number") {
    out.source_index = o.source_index;
  }
  return out;
}

/** Coerce a raw held array (any of the ports' HeldEntry/HeldRow shapes) → HeldRow[]. */
export function toHeldRows(v: unknown): HeldRow[] {
  return Array.isArray(v) ? v.map(toHeldRow) : [];
}

/** Coerce a raw auto-created-batch entry → contract AutoCreatedBatchNote. Every
 *  field guarded — a bad/missing entry degrades to safe defaults, never a crash. */
function toAutoCreatedBatch(v: unknown): AutoCreatedBatchNote {
  const o = (v ?? {}) as Record<string, unknown>;
  const mode = o.mode === "rc_in" || o.mode === "rc_out" ? o.mode : undefined;
  const sourceRow =
    typeof o.source_row === "string" || typeof o.source_row === "number" ? o.source_row : null;
  return {
    batch_code: str(o.batch_code),
    location_ref: str(o.location_ref),
    ...(mode ? { mode } : {}),
    transaction_date: typeof o.transaction_date === "string" ? o.transaction_date : null,
    block_loc: typeof o.block_loc === "string" ? o.block_loc : null,
    source_row: sourceRow,
  };
}

/** Coerce a raw auto-created-batches array → AutoCreatedBatchNote[]. */
function toAutoCreatedBatches(v: unknown): AutoCreatedBatchNote[] {
  return Array.isArray(v) ? v.map(toAutoCreatedBatch) : [];
}

/** Coerce a raw batch-changeover entry → contract ProductionBatchStartNote. Every
 *  field guarded — a bad/missing entry degrades to safe defaults, never a crash. */
function toProductionBatchStart(v: unknown): ProductionBatchStartNote {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    transaction_date: str(o.transaction_date),
    new_batch: str(o.new_batch),
    previous_batch: str(o.previous_batch),
    derivation: str(o.derivation),
    source_sheet: str(o.source_sheet),
  };
}

/** Coerce a raw batch-changeover array → ProductionBatchStartNote[]. */
function toProductionBatchStarts(v: unknown): ProductionBatchStartNote[] {
  return Array.isArray(v) ? v.map(toProductionBatchStart) : [];
}

/** Coerce a raw gate_failures array → contract GateFailure[]. */
function toGateFailures(v: unknown): GateFailure[] {
  if (!Array.isArray(v)) return [];
  return v.map((g) => {
    const o = (g ?? {}) as Record<string, unknown>;
    return { gate: str(o.gate), detail: str(o.detail) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The normalizers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a writer report's classify block → contract `ClassifyResult`. Carries the
 * fields the reducer reads (ok/gate_failures/counts/watermark) plus any extra top-level
 * breakdown keys (per_mode/per_section) untouched, and fills the required-but-unused
 * contract fields (rows_preview/classified_path/source) with safe empties.
 */
export function normalizeClassify(
  reportType: string,
  raw: RawClassify | null | undefined,
  extra?: Record<string, unknown>,
): ClassifyResult {
  const c = raw ?? {};
  const counts = c.counts ?? {};
  return {
    report_type: str(c.report_type) || reportType,
    ok: c.ok !== false, // default true
    gate_failures: toGateFailures(c.gate_failures),
    counts: {
      noop: num(counts.noop),
      insert: num(counts.insert),
      update: num(counts.update),
      flagged: num(counts.flagged),
    },
    rows_preview: [],
    classified_path: "",
    source: {},
    watermark: typeof c.watermark === "string" ? c.watermark : null,
    ...(extra ?? {}),
  };
}

/**
 * Normalize a writer report's FLAT apply result → contract `ApplyResult`. `applied` is
 * ALWAYS present (nested, default zeros); `held` is the full ROWS. `null` in →
 * read-only/dryRun/no-apply. Coerces the flecon `replaced_dates` when present.
 */
export function normalizeApply(
  reportType: string,
  raw: RawApply | null | undefined,
): ApplyResult | null {
  if (raw == null) return null;
  return {
    report_type: str(raw.report_type) || reportType,
    ok: raw.ok !== false, // default true
    applied: {
      inserts: num(raw.inserts),
      updates: num(raw.updates),
      replaced_dates: num(raw.replaced_dates),
    },
    held: toHeldRows(raw.held),
    labeled: Boolean(raw.labeled),
    watermark_updated: Boolean(raw.watermark_updated),
    errors: strArray(raw.errors),
    auto_created_batches: toAutoCreatedBatches(raw.auto_created_batches),
    production_batch_starts: toProductionBatchStarts(raw.production_batch_starts),
  };
}

/**
 * Build the canonical per-report `SyncRunReportResult` from a report's classify + flat
 * apply. `apply === null` (or `undefined`) → read-only auditor / dryRun. The `extra`
 * bag is merged into the classify block (per_mode/per_section/severity carriers).
 */
export function toReportResult(params: {
  reportType: string;
  classify: RawClassify | null | undefined;
  apply?: RawApply | null;
  classifyExtra?: Record<string, unknown>;
  status?: SyncCardStatus;
  error?: string | null;
}): SyncRunReportResult {
  const classify = normalizeClassify(params.reportType, params.classify, params.classifyExtra);
  const apply = params.apply === undefined ? null : normalizeApply(params.reportType, params.apply);
  const result: SyncRunReportResult = { classify, apply };
  if (params.status) result.status = params.status;
  if (params.error != null) result.error = params.error;
  return result;
}

/**
 * The FAILURE-ISOLATION result: a report that THREW. Contract-shaped so the card
 * renders an error (not a crash) — classify present with ok:false so the reducer's
 * `deriveCardStatus` settles to 'error'/'gate-failed', `applied` zeros present.
 */
export function failedReportResult(
  reportType: string,
  message: string,
  /**
   * Optional held rows to surface alongside the failure. `apply.errors` is NOT part of
   * the panel's honest findings list (`lib/sync/findings.ts::flattenRunFindings` reads
   * held rows + the reconciliation channels), so a failure that an operator must ACT on
   * — e.g. "Gmail connection limit hit, wait and retry" — passes one `gate_failure` row
   * here to become a visible finding. Uses the EXISTING HeldKind vocabulary; that enum
   * is frontend-locked, so new categories are expressed via `reason`/`detail`.
   */
  held: HeldRow[] = [],
): SyncRunReportResult {
  return {
    classify: {
      report_type: reportType,
      ok: false,
      gate_failures: [],
      counts: { noop: 0, insert: 0, update: 0, flagged: 0 },
      rows_preview: [],
      classified_path: "",
      source: {},
      watermark: null,
    },
    apply: {
      report_type: reportType,
      ok: false,
      applied: { inserts: 0, updates: 0, replaced_dates: 0 },
      held,
      labeled: false,
      watermark_updated: false,
      errors: [message],
      auto_created_batches: [],
      production_batch_starts: [],
    },
    status: "error",
    error: message,
  };
}
