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
  replaced_dates: string[]
}

export interface HeldRow {
  reason: string
  natural_key: string
  detail: string
}

export interface ApplyResult {
  report_type: string
  ok: boolean
  applied: ApplyApplied
  held: HeldRow[]
  labeled: boolean
  watermark_updated: boolean
  errors: string[]
}

// ============================================================
// SSE progress contract — the live stream shape
// ============================================================

/**
 * The FROZEN progress-event contract. Each Python script flushes ONE line per
 * event on stderr, prefixed by the sentinel below, containing exactly this JSON:
 *
 *   ##SYNC_PROGRESS {"stage":"classify","pct":42,"label":"Comparing against the database…","detail":"195 already recorded","level":"info"}
 *
 * Any other stderr line is treated as a raw technical-log line (never a status
 * line). stdout stays the single machine-JSON result object (contract unchanged).
 */
export const SYNC_PROGRESS_SENTINEL = '##SYNC_PROGRESS ' as const

/** The coarse pipeline stages a progress event can report. */
export type SyncProgressStage =
  | 'fetch'
  | 'extract'
  | 'classify'
  | 'apply'
  | 'reconcile'
  | 'finalize'

/** One decoded `##SYNC_PROGRESS` event. */
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
 * The terminal SSE `result` event payload. Mirrors what the old server action
 * returned (parsed stdout), plus the transport metadata the client needs to
 * decide gate-failure vs error and to surface stderr on a crash.
 */
export interface SyncStreamResult {
  /** Process exit code (0 = clean). */
  exitCode: number
  /** Parsed stdout as the phase's contract object, or null if unparseable. */
  json: ClassifyResult | ApplyResult | null
  /** Last chunk of stderr (technical), for a copyable crash detail. */
  stderrTail: string
}

// ============================================================
// Adjudication (Anthropic) — held-row recommendations
// ============================================================

export type AdjudicationVerdict = 'apply' | 'skip' | 'needs-human'

export interface HeldRowRecommendation {
  natural_key: string
  verdict: AdjudicationVerdict
  reason: string
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
