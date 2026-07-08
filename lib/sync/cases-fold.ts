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
  HeldRow,
  SourceDiff,
  SyncReportType,
  SyncRunResult,
} from '../../app/(app)/sync/types'

export interface CollectedHeld {
  reportType: SyncReportType
  held: HeldRow
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
