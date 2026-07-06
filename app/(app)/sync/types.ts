/**
 * Shared types for the in-app "Run Sync" panel — the CLI contract between the
 * Next.js server actions and the Python sync orchestrators
 * (`.claude/skills/sync-ictc/scripts/sync_*.py`).
 *
 * These mirror the FIXED CLI contract the backend agent is building against.
 * Do NOT drift these shapes without coordinating with the sync-ictc scripts:
 *   classify stdout -> ClassifyResult
 *   apply    stdout -> ApplyResult
 *
 * This file is import-safe from both server actions ('use server') and client
 * components (it is pure types + const data, no server-only imports).
 */

/** The six sync report types, in daily-run order. */
export type SyncReportType =
  | 'gsheet'
  | 'deliveries'
  | 'rc_out'
  | 'production'
  | 'flecon'
  | 'rc_movement'

/** Static catalog describing each employee card in the panel. */
export interface SyncReportMeta {
  type: SyncReportType
  /** Python script basename under `.claude/skills/sync-ictc/scripts/`. */
  script: string
  /** Human label shown on the card. */
  label: string
  /** One-line description of what this employee ingests. */
  blurb: string
  /**
   * Read-only reports never call `--phase apply` (the auditor). The panel must
   * never attempt to apply these.
   */
  readOnly: boolean
}

/**
 * Canonical catalog + run order. gsheet FIRST and alone (source of truth), then
 * the four writers in parallel, then the read-only auditor last.
 */
export const SYNC_REPORTS: readonly SyncReportMeta[] = [
  {
    type: 'gsheet',
    script: 'sync_gsheet.py',
    label: 'Google Sheet',
    blurb: 'Source of truth — RC IN + RC OUT from the shared Sheet.',
    readOnly: false,
  },
  {
    type: 'deliveries',
    script: 'sync_deliveries.py',
    label: 'Deliveries (RC IN)',
    blurb: 'RC DELIVERIES email + Czarina price enrichment.',
    readOnly: false,
  },
  {
    type: 'rc_out',
    script: 'sync_rc_out.py',
    label: 'RC OUT',
    blurb: 'PROPOSED DAILY REPORT — feedings into rc_out.',
    readOnly: false,
  },
  {
    type: 'production',
    script: 'sync_production.py',
    label: 'Production',
    blurb: 'MC + Ivy reports — shifts, runs, downtime, waste.',
    readOnly: false,
  },
  {
    type: 'flecon',
    script: 'sync_flecon.py',
    label: 'FLECON Bags',
    blurb: 'Empty jumbo-bag stock (replace-by-date).',
    readOnly: false,
  },
  {
    type: 'rc_movement',
    script: 'audit_rc_movement.py',
    label: 'RC Movement Audit',
    blurb: 'Read-only feeding-total cross-check.',
    readOnly: true,
  },
] as const

/** Which report types classify+apply in parallel after gsheet. */
export const PARALLEL_WRITERS: readonly SyncReportType[] = [
  'deliveries',
  'rc_out',
  'production',
  'flecon',
]

export function metaFor(type: SyncReportType): SyncReportMeta {
  const meta = SYNC_REPORTS.find((r) => r.type === type)
  if (!meta) throw new Error(`Unknown sync report type: ${type}`)
  return meta
}

// ============================================================
// CLI contract — classify phase
// ============================================================

export interface GateFailure {
  gate: string
  detail: string
}

export interface ClassifyCounts {
  noop: number
  insert: number
  update: number
  flagged: number
}

export interface RowPreview {
  action: string
  natural_key: string
  summary: string
}

export interface ClassifyResult {
  report_type: string
  ok: boolean
  gate_failures: GateFailure[]
  counts: ClassifyCounts
  rows_preview: RowPreview[]
  classified_path: string
  source: Record<string, unknown>
  watermark: string | null
}

// ============================================================
// CLI contract — apply phase
// ============================================================

export interface ApplyApplied {
  inserts: number
  updates: number
  /** COUNT of dates whose rows were replaced (flecon REPLACE-BY-DATE). A number,
   *  matching the worker + SYNC_CLI_CONTRACT — not an array. */
  replaced_dates: number
}

/**
 * The normalized held-flag categories (worker-side src/reports/held.ts is the SoT).
 * The app adjudicator switches its targeted, read-only DB lookup on `kind`.
 */
export type HeldKind =
  | 'sub_watermark_suspected_dup'
  | 'cross_batch_reassignment'
  | 'unmapped_batch_code'
  | 'unmapped_bag_type_code'
  | 'location_occupied'
  | 'malformed'
  | 'low_confidence'
  | 'already_exists'
  | 'gate_failure'
  | 'unmapped_or_missing_columns'
  | 'below_since_floor'
  | 'unresolved_shift'
  | 'unresolved_batch_id'
  | 'flagged'
  | 'other'

/**
 * One held row. The three legacy fields are always present; the enrichment fields
 * (kind/row/source_index, 2026-07-06) are optional and carry a decision-grade
 * payload for "Ask Claude". `natural_key` is a HUMAN label (never a raw index) and
 * doubles as the stable per-row key the recommendation map re-keys by. `row` NEVER
 * contains a ₱/cost field (price gating). Worker mirror: normalizeReport.ts.
 */
export interface HeldRow {
  reason: string
  natural_key: string
  detail: string
  /** Normalized flag category — keys the adjudicator's DB lookup. */
  kind?: HeldKind
  /** Structured KEY fields for the adjudicator + DB lookup. NEVER a ₱/cost field. */
  row?: Record<string, unknown>
  /** The former row index — retained for the apply-input mapping. */
  source_index?: string | number
}

export interface ApplyResult {
  report_type: string
  ok: boolean
  /** May be ABSENT on a gate-failure / errored apply envelope (nothing applied).
   *  Consumers MUST guard `apply?.applied` before reading counts. */
  applied?: ApplyApplied
  held: HeldRow[]
  labeled: boolean
  watermark_updated: boolean
  errors: string[]
}

// ============================================================
// Durable progress contract — Supabase Realtime (Wave 4B)
// ============================================================
//
// The old transport was an SSE stream that spawned Python on Renzo's laptop and
// forwarded `##SYNC_PROGRESS` stderr lines. That is RETIRED. Progress now lives in
// two Supabase tables the DBOS worker writes and the browser watches over Realtime:
//   - `sync_runs`        — one row per "Run Sync" click (lifecycle + terminal result)
//   - `sync_run_events`  — the live progress feed (one row per beat)
// See supabase/migrations/20260704000000_sync_runs_and_events.sql.

/** The coarse pipeline stages a progress event can report. */
export type SyncProgressStage =
  | 'fetch'
  | 'extract'
  | 'classify'
  | 'apply'
  | 'reconcile'
  | 'finalize'

/**
 * One decoded progress event. In the SSE era this was a `##SYNC_PROGRESS` stderr
 * line; now it is projected from a `sync_run_events` row. The digestible-language
 * shape is IDENTICAL, so the card reducer is unchanged.
 */
export interface SyncProgressEvent {
  stage: SyncProgressStage
  /** Integer 0–100. */
  pct: number
  /** Plain-English activity — what to show as the status line. */
  label: string
  /** Optional specifics appended muted after the label. */
  detail?: string
  level: 'info' | 'warn'
}

/**
 * Lifecycle status of a durable sync run (mirrors the `sync_run_status` enum).
 * `cancelled` is a NEUTRAL terminal state (the Stop button) — a stopped run keeps
 * every already-written row (no rollback) and reads as "Stopped", never error-red.
 */
export type SyncRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'cancelled'

/** The terminal statuses — a run in one of these will emit no further events. */
export const TERMINAL_RUN_STATUSES: readonly SyncRunStatus[] = [
  'succeeded',
  'failed',
  'partial',
  'cancelled',
] as const

export function isTerminalRunStatus(s: SyncRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(s)
}

/**
 * A `sync_run_events` row exactly as it arrives over Realtime (or a mount-time
 * catch-up query). All fields are nullable to mirror the table (defensive — a
 * malformed worker write must never crash the reducer). `report_type` keys the
 * card; the sentinel `'_run'` is the top-level workflow's own progress track.
 */
export interface SyncRunEventRow {
  id: number
  run_id: string
  report_type: string | null
  stage: string | null
  pct: number | null
  label: string | null
  detail: string | null
  level: string | null
  at: string | null
}

/** The report-type sentinel the worker uses for the top-level run's own track. */
export const RUN_TRACK_REPORT_TYPE = '_run' as const

/**
 * A `sync_runs` row as it arrives over Realtime / a catch-up query. `result` and
 * `error` are only populated on the terminal transition.
 */
export interface SyncRunRow {
  id: string
  requested_by: string | null
  status: SyncRunStatus
  started_at: string | null
  finished_at: string | null
  result: SyncRunResult | null
  error: string | null
  created_at: string | null
}

/**
 * The terminal `sync_runs.result` contract the worker writes and the modal reads.
 *
 * The worker (M3) fills `reports[<type>]` with the SAME `ClassifyResult` /
 * `ApplyResult` objects the old CLI produced — so the downstream held-aggregation
 * + narration logic (and `SyncPanelBody` / `HeldRows`) are untouched. During
 * M0/M1 the worker instead writes a Mail-Clerk manifest (no `reports` key); the
 * reducer treats a result with no `reports` as "run finished, nothing per-report
 * to show yet" and simply clears the busy state.
 */
export interface SyncRunReportResult {
  classify: ClassifyResult | null
  apply: ApplyResult | null
  /** Terminal card status the worker decided for this report, if any. */
  status?: SyncCardStatus
  /** Full error text (gate detail / crash) for the inline block + Copy. */
  error?: string | null
}

export interface SyncRunResult {
  /** Per-report terminal results, keyed by report type. Absent in M0/M1. */
  reports?: Partial<Record<SyncReportType, SyncRunReportResult>>
  /** Optional pre-narrated summary (else the app narrates client-side). */
  summary?: string | null
  /** Anything else the worker attaches (manifest, counts) — inspected loosely. */
  [key: string]: unknown
}

// ============================================================
// Adjudication (Anthropic) — held-row recommendations
// ============================================================

export type AdjudicationVerdict = 'apply' | 'skip' | 'needs-human'

export interface HeldRowRecommendation {
  natural_key: string
  verdict: AdjudicationVerdict
  reason: string
  /** A short summary of the read-only DB finding that grounds the verdict (e.g.
   *  "identical 2026-06-30 MAIN 5,820kg row already in DB (id abc)"). Optional —
   *  absent for kinds with no lookup (malformed / low_confidence). */
  evidence?: string
}

// ============================================================
// Panel-facing aggregate result per report
// ============================================================

/** Lifecycle state of a single employee card during a run. */
export type SyncCardStatus =
  | 'idle'
  | 'classifying'
  | 'applying'
  | 'done'
  | 'gate-failed'
  | 'error'
  /** The run was Stopped mid-flight — a NEUTRAL terminal (not error-red). Rows
   *  already written are kept; the card just settles calmly to "Stopped". */
  | 'stopped'

/** What a single card holds after (or during) a run. */
export interface SyncCardState {
  type: SyncReportType
  status: SyncCardStatus
  classify: ClassifyResult | null
  apply: ApplyResult | null
  /** Full error text (incl. stderr) for the inline error block + Copy. */
  error: string | null

  // --- live progress (populated from the SSE stream) ---
  /** Latest reported stage, or null before the first progress event. */
  stage: SyncProgressStage | null
  /** 0–100 progress; drives the scaleX bar. */
  pct: number
  /** Plain-English status line (label + optional detail). Null → fall back to the busy verb. */
  statusLine: string | null
  /** True when the latest progress event was level:'warn' — tints the status line amber. */
  warn: boolean
  /** Technical stderr lines for the collapsible log (capped). */
  log: string[]
}
