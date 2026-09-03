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
  AwaitingBatchAssignment,
  BatchClose,
  BlockDiff,
  HeldRow,
  PriceNote,
  ProductionBatchStart,
  ProductionHumanEdit,
  DeliveryHumanEdit,
  ReportArtifact,
  ReportNotReceived,
  ScheduleConflict,
  SingleSourceOverdue,
  SlowGmailSearch,
  SourceDiff,
  SourceTabNote,
  StaleStream,
  StaleStreamCheck,
  SyncReportType,
  SyncRunResult,
  UnpricedOverdue,
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
 * Flatten every production-batch changeover a run announced
 * (`result.reports.production.apply.production_batch_starts`, 2026-08-03). Only the
 * `production` report ever fills it, but the fold is generic + guarded so a hand-built
 * or pre-feature result simply yields []. Pure — panel-visibility only; these are NOT
 * folded into durable cases (same treatment as `auto_created_batches`).
 */
export function collectProductionBatchStarts(result: SyncRunResult): ProductionBatchStart[] {
  const reports = result.reports
  if (!reports) return []

  const out: ProductionBatchStart[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.production_batch_starts ?? []) out.push(note)
  }
  return out
}

/**
 * Flatten every production row a run REFUSED to overwrite because a human edited it
 * (`result.reports.production.apply.production_human_edits`, 2026-08-03 human-edit
 * latch). Only the `production` report ever fills it, but the fold is generic + guarded
 * so a hand-built or pre-feature result simply yields []. Pure — panel-visibility only;
 * these are NOT folded into durable cases (same treatment as `production_batch_starts`).
 */
export function collectProductionHumanEdits(result: SyncRunResult): ProductionHumanEdit[] {
  const reports = result.reports
  if (!reports) return []

  const out: ProductionHumanEdit[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.production_human_edits ?? []) out.push(note)
  }
  return out
}

/**
 * Flatten every DELIVERY a run REFUSED to overwrite because a human edited it
 * (`result.reports.<deliveries|gsheet>.apply.delivery_human_edits`, 2026-08-08 deliveries
 * human-edit latch).
 *
 * TWO reports fill this, not one — the emailed RC DELIVERIES report and the Google Sheet's
 * Sheet-wins pass both write `deliveries` — which is exactly why the fold is a loop over
 * every report rather than a lookup of one. Guarded, so a hand-built or pre-feature result
 * simply yields []. Pure — panel-visibility only; these are NOT folded into durable cases
 * (there is nothing to retry: the row is already correct).
 */
export function collectDeliveryHumanEdits(result: SyncRunResult): DeliveryHumanEdit[] {
  const reports = result.reports
  if (!reports) return []

  const out: DeliveryHumanEdit[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.delivery_human_edits ?? []) out.push(note)
  }
  return out
}

/**
 * Flatten every DELIVERY-PRICE note a run raised
 * (`result.reports.deliveries.apply.price_notes`, 2026-08-07).
 *
 * This fold is the reason the price step can no longer fail quietly. Before it, the only
 * evidence that a price file had failed was a single progress beat that said the file was
 * "unavailable" when it was in fact sitting right there with an unrecognized tab name —
 * and progress beats do not outlive the run. Now every price outcome lands in the durable
 * result and reaches the panel through `flattenRunFindings`.
 *
 * Only the `deliveries` report ever fills it, but the fold is generic + guarded so a
 * hand-built or pre-feature result simply yields []. Pure — panel-visibility only; these
 * are NOT folded into durable cases (same treatment as `production_human_edits`).
 */
export function collectPriceNotes(result: SyncRunResult): PriceNote[] {
  const reports = result.reports
  if (!reports) return []

  const out: PriceNote[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.price_notes ?? []) out.push(note)
  }
  return out
}

/**
 * Flatten every delivery a run found still unpriced more than a day on
 * (`result.reports.deliveries.apply.unpriced_overdue`, 2026-08-07). The overdue rule
 * lives in `view_digest_unpriced_deliveries`; this only carries the rows the worker read
 * from it. Guarded and generic, same contract as `collectPriceNotes`.
 */
export function collectUnpricedOverdue(result: SyncRunResult): UnpricedOverdue[] {
  const reports = result.reports
  if (!reports) return []

  const out: UnpricedOverdue[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.unpriced_overdue ?? []) out.push(note)
  }
  return out
}

/**
 * Flatten every delivery a run saw weighed in with NO PILE ASSIGNED YET
 * (`result.reports.deliveries.apply.awaiting_batch_assignment`, 2026-08-13, L-042).
 *
 * These used to be reported MALFORMED, which is what "row could not be read" means to an
 * operator — for a row that is merely not filled in yet and normally fills itself in later
 * the same day. Like `collectPriceNotes` and `collectUnpricedOverdue` these are NOT folded
 * into durable cases: panel/report visibility only, so nothing has to be closed by hand.
 */
export function collectAwaitingBatchAssignments(
  result: SyncRunResult,
): AwaitingBatchAssignment[] {
  const reports = result.reports
  if (!reports) return []

  const out: AwaitingBatchAssignment[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.awaiting_batch_assignment ?? []) out.push(note)
  }
  return out
}

/**
 * Flatten every source workbook a run opened and could not fully read
 * (`result.reports[type].apply.source_tab_notes`, 2026-09-03, L-048).
 *
 * The channel exists because the ONLY record of a skipped worksheet used to be a string in
 * `soft_warnings`, which is not on the findings path — so a workbook the sync could open
 * and got NOTHING out of was indistinguishable from a quiet day. Like `collectPriceNotes`
 * and `collectAwaitingBatchAssignments` these are NOT folded into durable cases: the moment
 * the tab names parse the finding stops firing, so there would be nothing to close by hand.
 */
export function collectSourceTabNotes(result: SyncRunResult): SourceTabNote[] {
  const reports = result.reports
  if (!reports) return []

  const out: SourceTabNote[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.source_tab_notes ?? []) out.push(note)
  }
  return out
}

/**
 * Every report whose SOURCE FILE never arrived this run
 * (`result.reports[type].apply.report_not_received`, 2026-08-18, L-044).
 *
 * Unlike its siblings this is a SINGLE optional object per report, not an array — a report
 * either arrived or it did not — so the fold is a presence check rather than a spread. Same
 * guarded, generic contract as `collectPriceNotes` otherwise, and equally not folded into
 * durable cases: the moment the report shows up the finding stops firing on its own, so
 * there would be nothing to close by hand.
 */
export function collectReportsNotReceived(result: SyncRunResult): ReportNotReceived[] {
  const reports = result.reports
  if (!reports) return []

  const out: ReportNotReceived[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const note = reports[key]?.apply?.report_not_received
    if (note && typeof note === 'object') out.push(note)
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
 * Flatten the production-PLAN conflicts (Stage 3c: days a human edited in-app whose
 * upstream/Joseph value the sync WITHHELD and parked in
 * `production_schedule.pending_upstream`). Lives only in
 * `result.reconciliation.schedule_conflicts` (optional additive field — absent on runs
 * that parked nothing and on every run predating the conditional refresh). Pure, guarded.
 *
 * HISTORICAL (2026-08-28): the production plan was retired, so no live run emits this
 * channel any more. The fold STAYS because stored run payloads still carry it and the
 * Sync panel renders past runs; `scripts/verify-schedule-conflict-fold.ts` is the proof
 * that path still works. See `_archived/prod-schedule-v1/`.
 */
export function collectScheduleConflicts(result: SyncRunResult): ScheduleConflict[] {
  return result.reconciliation?.schedule_conflicts ?? []
}

/**
 * Flatten the freshness watch (Stage 3e: streams that have missed a planned working day).
 * Lives only in `result.reconciliation.stale_streams` (optional additive field — absent on
 * runs where every stream is current and on every run predating the watch). Pure, guarded.
 */
export function collectStaleStreams(result: SyncRunResult): StaleStream[] {
  return result.reconciliation?.stale_streams ?? []
}

/**
 * The freshness watch's own failure, when it had one (2026-08-18, L-044).
 *
 * Returns null on every healthy run — the member is written ONLY on failure, so absence
 * means the check ran and `collectStaleStreams` carries its answer. Guarded + pure.
 *
 * This is the collector that makes `stale_streams: []` honest: without it, "nothing is
 * late" and "the view returned 42501" are the same empty array, which is precisely how the
 * watch stayed dead and unnoticed from the day it was built.
 */
export function collectStaleStreamCheck(result: SyncRunResult): StaleStreamCheck | null {
  const c = result.reconciliation?.stale_stream_check
  return c && typeof c === 'object' ? c : null
}

/**
 * Gmail searches that blew the worker's per-search budget (2026-08-19, BUG-026). Absent on
 * every run where the mailbox behaved, and on every run that predates the budget. Guarded
 * + pure.
 *
 * This is the one collector whose subject is the sync's OWN behaviour rather than the
 * plant's — it answers "was it slow, or was it stuck?", which nothing in the result could
 * answer on the day that question cost two overlapping IMAP sessions.
 */
export function collectSlowGmailSearches(result: SyncRunResult): SlowGmailSearch[] {
  return result.reconciliation?.gmail_slow_searches ?? []
}

/**
 * Read the Excel-report artifact pointer for this run
 * (`result.reconciliation.report_artifact`, 2026-08-07). Absent on every run that predates
 * the report generator, and on a run whose result was never assembled (a crash before
 * finalize). Guarded + pure.
 *
 * NOTE this returns the pointer whether generation SUCCEEDED or FAILED — the caller decides
 * what to do with it. `flattenRunFindings` raises a finding only for a failure; the
 * successful pointer exists so the panel can link to the download without a second query.
 */
export function collectReportArtifact(result: SyncRunResult): ReportArtifact | null {
  const a = result.reconciliation?.report_artifact
  return a && typeof a === 'object' ? a : null
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
