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

/** Mirror of the frontend `HeldRow`. */
export interface HeldRow {
  reason: string;
  natural_key: string;
  detail: string;
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
 * Mirror of the frontend `ApplyResult`. `applied` is ALWAYS present on any non-null
 * apply (default zeros) so the card never sees a missing `applied` — even on a
 * gate-failure / error path where nothing was written. `held` carries the ROWS.
 */
export interface ApplyResult {
  report_type: string;
  ok: boolean;
  applied: ApplyApplied;
  held: HeldRow[];
  labeled: boolean;
  watermark_updated: boolean;
  errors: string[];
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

/** Coerce a raw held entry (typed reason unions, optional detail) → contract HeldRow. */
function toHeldRow(h: unknown): HeldRow {
  const o = (h ?? {}) as Record<string, unknown>;
  return {
    reason: str(o.reason),
    natural_key: str(o.natural_key),
    detail: str(o.detail),
  };
}

/** Coerce a raw held array (any of the ports' HeldEntry/HeldRow shapes) → HeldRow[]. */
export function toHeldRows(v: unknown): HeldRow[] {
  return Array.isArray(v) ? v.map(toHeldRow) : [];
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
export function failedReportResult(reportType: string, message: string): SyncRunReportResult {
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
      held: [],
      labeled: false,
      watermark_updated: false,
      errors: [message],
    },
    status: "error",
    error: message,
  };
}
