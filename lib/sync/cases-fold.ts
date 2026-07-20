/**
 * cases-fold.ts — a PURE fold from a terminal SyncRunResult to a flat list of the
 * held rows it contains, tagged with their report type.
 *
 * Held rows live ONLY inside `result.reports[type].apply.held`. Both `reports` and
 * `apply` may be absent (M0/M1 manifests, read-only auditors, dryRun / gate-failed
 * applies), and `apply.held` may itself be missing — every level is guarded. No
 * supabase import: the fan-out action (cases.ts) calls this then fingerprints +
 * upserts each entry, but this step is testable with no DB.
 */
import type {
  AttributionDiff,
  AutoCreatedBatch,
  BatchClose,
  BlockDiff,
  HeldRow,
  SingleSourceOverdue,
  SourceDiff,
  SyncReportType,
  SyncRunResult,
  UnresolvedBatch,
} from '../../app/(app)/sync/types'

export interface CollectedHeld {
  reportType: SyncReportType
  held: HeldRow
}

export interface CollectedAutoCreatedBatch {
  reportType: SyncReportType
  note: AutoCreatedBatch
}

/**
 * Flatten every auto-created batch across all reports in a run result
 * (`result.reports[type].apply.auto_created_batches`, 2026-07-11 policy). Returns
 * [] when the result has no `reports`, or when nothing was auto-created.
 */
export function collectAutoCreatedBatches(result: SyncRunResult): CollectedAutoCreatedBatch[] {
  const reports = result.reports
  if (!reports) return []

  const out: CollectedAutoCreatedBatch[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    const notes = report.apply?.auto_created_batches ?? []
    for (const note of notes) out.push({ reportType: key, note })
  }
  return out
}

/**
 * Flatten every held row across all reports in a run result. Returns [] when the
 * result has no `reports` (nothing per-report to persist yet).
 */
export function collectHeldRows(result: SyncRunResult): CollectedHeld[] {
  const reports = result.reports
  if (!reports) return []

  const out: CollectedHeld[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    const held = report.apply?.held ?? []
    for (const h of held) {
      out.push({ reportType: key, held: h })
    }
  }
  return out
}

/**
 * Flatten the R2 SHADOW reconciliation diffs from a run result. Diffs live only in
 * `result.reconciliation.rc_out.diffs` (additive channel — absent on pre-R2 runs, on
 * runs with nothing to compare, and when the shadow stage failed). Every level guarded.
 * Pure — the fan-out (cases.ts) fingerprints + upserts each one.
 */
export function collectSourceDiffs(result: SyncRunResult): SourceDiff[] {
  return result.reconciliation?.rc_out?.diffs ?? []
}

/**
 * Flatten the R4a `unresolved_batch` markers (batches that could not resolve to one batch_id).
 * Lives only in `result.reconciliation.rc_out.unresolvedBatches` (optional additive field —
 * absent on pre-R4a runs). Every level guarded. Pure — cases.ts fingerprints + upserts each.
 */
export function collectUnresolvedBatches(result: SyncRunResult): UnresolvedBatch[] {
  return result.reconciliation?.rc_out?.unresolvedBatches ?? []
}

/**
 * Flatten the R4a `single_source_overdue` facts (a lone witness whose second source is overdue).
 * `pending` facts are NOT here — they are a telemetry count only. Lives in
 * `result.reconciliation.rc_out.heldOverdue` (optional additive field). Pure.
 */
export function collectSingleSourceOverdue(result: SyncRunResult): SingleSourceOverdue[] {
  return result.reconciliation?.rc_out?.heldOverdue ?? []
}

/**
 * Flatten the RB `block_diff` descriptors (the Sheet Blocking tab vs the computed
 * view_blocking_grid). Lives only in `result.reconciliation.blocking.blockDiffs` (optional
 * additive channel — absent on pre-RB runs, on runs with no Blocking tab, and when the
 * shadow stage failed). Every level guarded. Pure — cases.ts fingerprints + upserts each.
 */
export function collectBlockDiffs(result: SyncRunResult): BlockDiff[] {
  return result.reconciliation?.blocking?.blockDiffs ?? []
}

/**
 * Flatten the gsheet close-scan outcomes (batches closed from a Google Sheet RC OUT close
 * remark + unmatched warnings). Lives only in `result.reconciliation.batch_closes` (optional
 * additive field — absent on runs that closed nothing or predate the close-scan). Pure.
 */
export function collectBatchCloses(result: SyncRunResult): BatchClose[] {
  return result.reconciliation?.batch_closes ?? []
}

/**
 * Flatten the second-pass `attribution_diff` pairings (two single-witness facts that are
 * almost certainly the same physical feeding under two different batch/block
 * attributions). Lives in `result.reconciliation.rc_out.attributionDiffs` (optional
 * additive field — absent on pre-this-feature runs). Every level guarded. Pure.
 */
export function collectAttributionDiffs(result: SyncRunResult): AttributionDiff[] {
  return result.reconciliation?.rc_out?.attributionDiffs ?? []
}
