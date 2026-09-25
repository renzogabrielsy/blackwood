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
  ExtractionNote,
  BatchAliasNote,
  BatchClose,
  BlockDiff,
  HeldRow,
  PriceNote,
  ProductNote,
  ProductionBatchStart,
  ProductionHumanEdit,
  DeliveryHumanEdit,
  DowntimeNote,
  WasteGapNote,
  RcMovementDrift,
  RcOutBackfill,
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

/** One drifting movement day, paired with the rc_out rows the same run held on it. */
export interface CollectedRcMovementDrift {
  drift: RcMovementDrift
  /** rc_out rows this run HELD on the same day — the likely explanation of the gap. */
  heldOnDate: HeldRow[]
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
 * Flatten every row the RC DELIVERIES extractor refused to treat as a delivery
 * (`result.reports.deliveries.apply.extraction_notes`, 2026-09-25, L-054) — stray rows
 * (a weight with no supplier/plate of its own, e.g. a sum typed under the table) and
 * impossible weights. Like `collectAwaitingBatchAssignments` these are NOT folded into
 * durable cases: the workbook is cumulative, so each note restates itself every run until
 * the cell is fixed, and there is nothing to close by hand.
 */
export function collectExtractionNotes(result: SyncRunResult): ExtractionNote[] {
  const reports = result.reports
  if (!reports) return []

  const out: ExtractionNote[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.extraction_notes ?? []) out.push(note)
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
/**
 * Flatten every note the `products` report raised about the SHAPE of the PRODUCTS
 * INVENTORY sheet (`result.reports.products.apply.product_notes`, 2026-09-07).
 *
 * Like `collectSourceTabNotes` and `collectPriceNotes` these are NOT folded into durable
 * cases: a grade added, renamed, or gone is a fact about the sheet's tabs, and the moment
 * the tabs line up again the note stops firing, so there would be nothing to close by hand.
 */
export function collectProductNotes(result: SyncRunResult): ProductNote[] {
  const reports = result.reports
  if (!reports) return []

  const out: ProductNote[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.product_notes ?? []) out.push(note)
  }
  return out
}

/**
 * Every below-watermark feeding a run WROTE because a second witness corroborated the
 * gap (`result.reports.rc_out.apply.rc_out_backfills`, 2026-09-07, L-049). Only the
 * `rc_out` report fills it, but the fold is generic + guarded so a pre-feature or
 * hand-built result simply yields []. Pure — panel-visibility only; NOT a durable case
 * (nothing is pending: the row was written).
 */
export function collectRcOutBackfills(result: SyncRunResult): RcOutBackfill[] {
  const reports = result.reports
  if (!reports) return []

  const out: RcOutBackfill[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.rc_out_backfills ?? []) out.push(note)
  }
  return out
}

/**
 * Every row a run filed against the batch already occupying its block because the derived
 * code differed only by the two-digit year (`result.reports[type].apply.batch_alias_notes`,
 * 2026-09-07, L-049). Guarded + generic; pure. Not a durable case — the row was written,
 * and the note exists so a human can overrule the identity call.
 */
export function collectBatchAliasNotes(result: SyncRunResult): BatchAliasNote[] {
  const reports = result.reports
  if (!reports) return []

  const out: BatchAliasNote[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.batch_alias_notes ?? []) out.push(note)
  }
  return out
}

/**
 * One entry per day the RC MOVEMENT sheet and `rc_out` disagree, paired with the rc_out
 * rows this SAME run HELD on that day (2026-09-07, L-049).
 *
 * The pairing is the whole point. On 2026-09-03 the auditor reported the database 8,158 kg
 * short and the rc_out writer held a row for exactly 8,158 kg — two halves of one sentence
 * that were published in different places and never joined, so the operator read a bare
 * count. Joining them here (a pure fold over the run result) means the finding can say
 * "the held row for D-8A accounts for it" instead of "2 drift date(s)".
 */
export function collectRcMovementDrifts(result: SyncRunResult): CollectedRcMovementDrift[] {
  const drifts = result.reports?.rc_movement?.classify?.rc_movement_drifts ?? []
  if (!drifts.length) return []

  // Every rc_out row this run held, indexed by the day it belongs to.
  const heldByDate = new Map<string, HeldRow[]>()
  for (const h of result.reports?.rc_out?.apply?.held ?? []) {
    const d = h.row?.transaction_date
    if (typeof d !== 'string' || !d) continue
    const list = heldByDate.get(d)
    if (list) list.push(h)
    else heldByDate.set(d, [h])
  }

  return drifts.map((drift) => ({ drift, heldOnDate: heldByDate.get(drift.date) ?? [] }))
}

/**
 * Flatten every downtime day whose two halves disagree — MC's hand-written DURATION cell
 * against her own list of time ranges (`result.reports.production.apply.downtime_notes`,
 * L-051). Only the `production` report fills it, but the fold is generic + guarded so a
 * hand-built or pre-feature result simply yields [].
 *
 * Like `collectSourceTabNotes` these are NOT folded into durable cases: the row was
 * written with the ranges' figure either way, so there is nothing held and nothing to
 * close by hand — the note stops firing the moment the sheet's two halves agree.
 */
export function collectDowntimeNotes(result: SyncRunResult): DowntimeNote[] {
  const reports = result.reports
  if (!reports) return []

  const out: DowntimeNote[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.downtime_notes ?? []) out.push(note)
  }
  return out
}

/**
 * Flatten every waste row Ivy's cumulative workbook states that the database is missing
 * or disagrees with, found below the sync window (`apply.waste_notes`, L-052). Only the
 * `production` report fills it; the fold is generic + guarded so a pre-feature or
 * hand-built result simply yields [].
 *
 * Like the downtime notes these are NOT folded into durable cases — Ivy's workbook is
 * cumulative, so the note restates itself every run until the row is repaired and stops
 * on its own the moment it is. There is nothing to close by hand.
 */
export function collectWasteGapNotes(result: SyncRunResult): WasteGapNote[] {
  const reports = result.reports
  if (!reports) return []

  const out: WasteGapNote[] = []
  for (const key of Object.keys(reports) as SyncReportType[]) {
    const report = reports[key]
    if (!report) continue
    for (const note of report.apply?.waste_notes ?? []) out.push(note)
  }
  return out
}

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
