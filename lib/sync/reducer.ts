/**
 * Pure reducer helpers for the durable "Run Sync" modal (Wave 4B).
 *
 * These are the load-bearing, framework-free transformations that turn raw
 * Supabase Realtime rows (`sync_run_events` INSERTs, `sync_runs` terminal UPDATEs)
 * into the card state machine `SyncPanelBody` / `SyncEmployeeCard` render. They are
 * factored OUT of the React hook (`components/sync/useSyncRun.ts`) so they can be
 * unit-driven with recorded Realtime payload shapes WITHOUT a browser or the worker
 * (see `scripts/verify-sync-reducer.ts`).
 *
 * Everything here is deterministic and side-effect-free — no React, no network.
 */

import {
  RUN_TRACK_REPORT_TYPE,
  SYNC_REPORTS,
  type SyncCardState,
  type SyncCardStatus,
  type SyncProgressEvent,
  type SyncProgressStage,
  type SyncReportType,
  type SyncRunEventRow,
  type SyncRunReportResult,
} from '@/app/(app)/sync/types'

export const VALID_STAGES: readonly SyncProgressStage[] = [
  'fetch',
  'extract',
  'classify',
  'apply',
  'reconcile',
  'finalize',
]

export const VALID_REPORT_TYPES: ReadonlySet<string> = new Set<string>(
  SYNC_REPORTS.map((r) => r.type)
)

export function freshCard(type: SyncReportType): SyncCardState {
  return {
    type,
    status: 'idle',
    classify: null,
    apply: null,
    error: null,
    stage: null,
    pct: 0,
    statusLine: null,
    warn: false,
    log: [],
  }
}

/**
 * Project a raw `sync_run_events` row into a digestible `SyncProgressEvent`, or
 * null if the row is malformed / not a status beat (defensive — a bad worker write
 * must never crash the reducer). Mirrors the SSE-era `parseProgressLine`
 * digestibility guard: a label that looks like a traceback is dropped.
 */
export function projectEvent(row: SyncRunEventRow): SyncProgressEvent | null {
  const stage = row.stage
  if (typeof stage !== 'string' || !VALID_STAGES.includes(stage as SyncProgressStage)) {
    return null
  }
  const label = typeof row.label === 'string' ? row.label : ''
  if (!label || label.startsWith('Traceback') || label.includes('File "') || label.length > 140) {
    return null
  }
  const pctNum = typeof row.pct === 'number' ? row.pct : Number(row.pct)
  const pct = Number.isFinite(pctNum) ? Math.max(0, Math.min(100, Math.round(pctNum))) : 0
  const detail = typeof row.detail === 'string' && row.detail.trim() ? row.detail : undefined
  // `error` was introduced 2026-08-07 (the price-file beat that used to lie at `warn`
  // level). Widened here rather than left to the `=== 'warn' ? … : 'info'` ternary,
  // which would have silently DOWNGRADED an error beat to info — re-creating the exact
  // "loud thing rendered quiet" bug it was added to fix.
  const level: SyncProgressEvent['level'] =
    row.level === 'error' ? 'error' : row.level === 'warn' ? 'warn' : 'info'
  return { stage: stage as SyncProgressStage, pct, label, detail, level }
}

/** Is this event row the top-level workflow's own ("_run") track? */
export function isRunTrack(row: SyncRunEventRow): boolean {
  return row.report_type === RUN_TRACK_REPORT_TYPE
}

/** Does this event row target a real report card? */
export function eventReportType(row: SyncRunEventRow): SyncReportType | null {
  const rt = row.report_type
  if (typeof rt !== 'string' || !VALID_REPORT_TYPES.has(rt)) return null
  return rt as SyncReportType
}

/**
 * Fold one projected progress event into a card. Pure: returns the NEXT card. `pct`
 * is monotonic (never decreases); a card already in a terminal status keeps it
 * (a late progress beat can't un-finish a done/failed card). The `apply` stage
 * flips a still-running card into `applying`.
 */
export function applyEventToCard(card: SyncCardState, ev: SyncProgressEvent): SyncCardState {
  const statusLine = ev.detail ? `${ev.label} · ${ev.detail}` : ev.label
  const terminal =
    card.status === 'done' ||
    card.status === 'gate-failed' ||
    card.status === 'error' ||
    card.status === 'stopped'
  const status: SyncCardStatus = terminal
    ? card.status
    : ev.stage === 'apply'
      ? 'applying'
      : 'classifying'
  return {
    ...card,
    status,
    stage: ev.stage,
    pct: Math.max(card.pct, ev.pct),
    statusLine,
    // An `error` beat must render AT LEAST as loudly as a warn. The card exposes a
    // single boolean, so both non-info levels set it.
    warn: ev.level === 'warn' || ev.level === 'error',
  }
}

/** Derive a terminal card status from a per-report result. */
export function deriveCardStatus(_type: SyncReportType, rep: SyncRunReportResult): SyncCardStatus {
  if (rep.status) return rep.status
  const classify = rep.classify
  if (classify && (!classify.ok || classify.gate_failures.length > 0)) return 'gate-failed'
  if (rep.apply && !rep.apply.ok) return 'error'
  return 'done'
}

/** Compose a copyable gate-failure / apply-error string from a per-report result. */
export function gateErrorFrom(rep: SyncRunReportResult): string | null {
  const gf = rep.classify?.gate_failures
  if (gf && gf.length > 0) {
    return gf.map((g) => `[${g.gate}] ${g.detail}`).join('\n\n')
  }
  const errs = rep.apply?.errors
  if (errs && errs.length > 0) return errs.join('\n')
  return null
}
