/**
 * findings.ts — the SINGLE HONEST LIST of everything a sync run flagged.
 *
 * THE BUG THIS FIXES: the Daily Sync panel's "Held for review" reads ONLY
 * `result.reports[*].apply.held`. A run that flagged TEN things showed the operator
 * ONE — the other nine lived in `result.reconciliation` (rc_out source diffs, single-
 * source-overdue facts, unresolved batches; the Blocking cross-check's per-block +
 * grand-total diffs) and became durable cases via `ensureCasesForRun`, but never
 * surfaced in the panel glance. This module flattens ALL of them into one array so the
 * panel can show the true count.
 *
 * PURE + CLIENT-SAFE by construction: imports ONLY the shared contract types
 * (`app/(app)/sync/types`) and the pure collectors (`./cases-fold`). NO server imports,
 * NO `node:crypto` (so it ships in the client bundle — unlike `./fingerprint`). Every
 * level is guarded; it never throws and is deterministic (same run → same list).
 *
 * This is the READ model for the panel. Persistence (durable cases, fingerprints,
 * rulings) stays in `cases.ts` / `fingerprint.ts`; this file computes nothing durable.
 */
import type {
  AttributionDiff,
  AutoCreatedBatch,
  BatchClose,
  BlockDiff,
  HeldRow,
  PriceNote,
  ProductionBatchStart,
  ProductionHumanEdit,
  RcOutSource,
  ScheduleConflict,
  SingleSourceOverdue,
  SourceDiff,
  StaleStream,
  SyncReportType,
  SyncRunResult,
  UnpricedOverdue,
  UnresolvedBatch,
} from '../../app/(app)/sync/types'
import {
  collectAttributionDiffs,
  collectAutoCreatedBatches,
  collectBatchCloses,
  collectBlockDiffs,
  collectHeldRows,
  collectPriceNotes,
  collectProductionBatchStarts,
  collectProductionHumanEdits,
  collectScheduleConflicts,
  collectSingleSourceOverdue,
  collectSourceDiffs,
  collectStaleStreams,
  collectUnpricedOverdue,
  collectUnresolvedBatches,
} from './cases-fold'

/** How loud a finding is — drives the panel's ordering + tint. */
export type FindingSeverity = 'info' | 'attention' | 'high'

/**
 * ONE flagged thing from a run, in plain, operator-facing language. Everything the
 * panel needs to render a row without re-deriving anything from the raw result.
 */
export interface RunFinding {
  /** Stable, run-local key (kind + natural identity). Deterministic; safe as a React key. */
  key: string
  /** The normalized category (the held `kind`, or the reconciliation kind). */
  kind: string
  /** A plain-English phrase for the kind (no engineer jargon). */
  kindLabel: string
  /** Which file/report raised it, in plain words ("Google Sheet — RC IN", "Blocking cross-check"). */
  source: string
  /** One-line summary of the specific problem. */
  title: string
  /** Where it is — a row number, or block+date+batch, or "grand total". */
  location: string
  /** The ACTUAL values (weights, the two sides of a diff, batch code, date). NEVER a ₱/cost. */
  data: Record<string, unknown>
  /** Plain "why this was flagged", jargon-free. */
  reason: string
  /** How much attention it needs. */
  severity: FindingSeverity
}

// ============================================================================
// Plain-language label tables (no engineer jargon — mirrors HeldRows KIND_LABEL).
// ============================================================================

/** Plain phrase per held-row kind. Fallback is a title-cased kind. */
const HELD_KIND_LABEL: Record<string, string> = {
  unmapped_batch_code: 'New batch code — nothing to map to',
  unmapped_bag_type_code: 'Unknown bag type',
  cross_batch_reassignment: 'Batch moved blocks',
  sub_watermark_suspected_dup: 'Possible duplicate (older than last sync)',
  location_occupied: 'Block already occupied',
  malformed: 'Row could not be read',
  low_confidence: 'Low-confidence extraction',
  already_exists: 'Already in the database',
  gate_failure: "Totals don't match — nothing saved",
  unmapped_or_missing_columns: 'Missing or unreadable columns',
  below_since_floor: 'Older than the sync window',
  unresolved_shift: 'Shift could not be matched',
  unresolved_batch_id: 'Batch could not be matched',
  flagged: 'Flagged for review',
  other: 'Needs review',
}

/** Plain source label per report type. */
const REPORT_SOURCE_LABEL: Record<SyncReportType, string> = {
  gsheet: 'Google Sheet',
  deliveries: 'Delivery email (RC IN)',
  rc_out: 'Proposed daily report (RC OUT)',
  production: 'Production report',
  flecon: 'FLECON bag report',
  rc_movement: 'Movement sheet',
}

/** Plain label per rc_out reconciliation witness. */
const RC_OUT_SOURCE_LABEL: Record<RcOutSource, string> = {
  proposed: 'Proposed daily report',
  gsheet: 'Google Sheet',
  movement: 'Movement sheet',
}

function titleCase(kind: string): string {
  return kind
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function heldKindLabel(kind: string | undefined): string {
  const k = kind ?? 'other'
  return HELD_KIND_LABEL[k] ?? titleCase(k)
}

// ============================================================================
// Small safe readers (loose — the `row`/`data` come from JSONB).
// ============================================================================

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtKg(v: unknown): string {
  const n = num(v)
  return n == null ? '—' : `${Math.round(n).toLocaleString('en-US')} kg`
}

// ============================================================================
// Held-row severity (by kind).
// ============================================================================

function heldSeverity(kind: string | undefined): FindingSeverity {
  switch (kind) {
    case 'gate_failure':
      return 'high'
    case 'unmapped_batch_code':
    case 'unmapped_bag_type_code':
    case 'location_occupied':
    case 'unresolved_shift':
    case 'unresolved_batch_id':
    case 'cross_batch_reassignment':
    case 'malformed':
    case 'unmapped_or_missing_columns':
      return 'attention'
    default:
      return 'info'
  }
}

// ============================================================================
// Builders — one per finding source. All pure + guarded.
// ============================================================================

/** Plain source label for a held row (append the RC IN/RC OUT lane for gsheet rows). */
function heldSource(reportType: SyncReportType, row: Record<string, unknown> | undefined): string {
  const base = REPORT_SOURCE_LABEL[reportType] ?? titleCase(reportType)
  if (reportType === 'gsheet') {
    const mode = row ? str(row.mode) : null
    if (mode === 'rc_in') return `${base} — RC IN`
    if (mode === 'rc_out') return `${base} — RC OUT`
  }
  return base
}

function fromHeld(reportType: SyncReportType, held: HeldRow): RunFinding {
  const kind = held.kind ?? 'other'
  const row = (held.row ?? {}) as Record<string, unknown>
  const batchCode = str(row.batch_code)
  const date = str(row.transaction_date)
  const block = str(row.block_loc)
  const weight = row.weight_kg

  // A one-line title: prefer a batch/weight sentence, fall back to the reason.
  let title: string
  if (kind === 'unmapped_batch_code' && batchCode) {
    title = `New batch "${batchCode}" isn't in the database yet`
  } else if (batchCode) {
    title = `${heldKindLabel(kind)} — batch ${batchCode}`
  } else {
    title = held.reason || heldKindLabel(kind)
  }

  // Location: date + block when we have them, else the human natural key.
  const locParts = [date, block].filter(Boolean) as string[]
  const location = locParts.length ? locParts.join(' · ') : held.natural_key || '—'

  const data: Record<string, unknown> = { natural_key: held.natural_key }
  if (batchCode) data.batch_code = batchCode
  if (date) data.transaction_date = date
  if (block) data.block_loc = block
  if (weight != null) data.weight_kg = num(weight)
  if (held.detail) data.detail = held.detail

  return {
    key: `held:${reportType}:${held.natural_key}`,
    kind,
    kindLabel: heldKindLabel(kind),
    source: heldSource(reportType, held.row),
    title,
    location,
    data,
    reason: held.reason || held.detail || heldKindLabel(kind),
    severity: heldSeverity(kind),
  }
}

function sourceDiffKeyLabel(diff: SourceDiff): string {
  const k = diff.naturalKey
  const batch = k.batch ?? '(no batch)'
  const block = k.block_loc ?? '(no block)'
  const dest = k.destination && k.destination !== 'MAIN' ? ` → ${k.destination}` : ''
  return `${batch} @ ${block}${dest} · ${k.transaction_date}`
}

function fromSourceDiff(diff: SourceDiff): RunFinding {
  const k = diff.naturalKey
  const field = diff.field === 'weight_kg' ? 'weight' : diff.field
  const srcs = diff.sources
    .map((s) => `${RC_OUT_SOURCE_LABEL[s.source] ?? s.source} ${diff.field === 'weight_kg' ? fmtKg(s.value) : String(s.value)}`)
    .join(' vs ')
  const rec = diff.recommended
    ? `${RC_OUT_SOURCE_LABEL[diff.recommended.source] ?? diff.recommended.source} looks right (advisory only)`
    : 'no clear winner — you decide'

  return {
    key: `source_diff:${sourceDiffKeyLabel(diff)}:${diff.field}`,
    kind: 'source_diff',
    kindLabel: 'Sources disagree',
    source: 'RC OUT — cross-check (proposed vs sheet vs movement)',
    title: `${k.batch ?? '(no batch)'} @ ${k.block_loc ?? '(no block)'}: sources disagree on ${field}`,
    location: `${k.block_loc ?? '(no block)'} · ${k.transaction_date}`,
    data: {
      transaction_date: k.transaction_date,
      batch: k.batch,
      block_loc: k.block_loc,
      destination: k.destination,
      field: diff.field,
      sources: diff.sources.map((s) => ({ source: s.source, value: s.value })),
      recommended: diff.recommended ?? null,
    },
    reason: `${srcs} — ${rec}.`,
    severity: 'attention',
  }
}

function fromOverdue(o: SingleSourceOverdue): RunFinding {
  const k = o.naturalKey
  const field = o.field === 'weight_kg' ? 'weight' : o.field
  const srcLabel = RC_OUT_SOURCE_LABEL[o.source] ?? o.source
  const value = o.field === 'weight_kg' ? fmtKg(o.value) : String(o.value)

  return {
    key: `single_source_overdue:${k.batch ?? '?'}@${k.block_loc ?? '?'}:${k.transaction_date}:${o.field}:${o.source}`,
    kind: 'single_source_overdue',
    kindLabel: 'Only one source reported',
    source: `RC OUT — only ${srcLabel} reported`,
    title: `${k.batch ?? '(no batch)'} @ ${k.block_loc ?? '(feed)'}: only ${srcLabel} reported this ${field}`,
    location: `${k.block_loc ?? '(feed)'} · ${k.transaction_date}`,
    data: {
      transaction_date: k.transaction_date,
      batch: k.batch,
      block_loc: k.block_loc,
      destination: k.destination,
      field: o.field,
      source: o.source,
      value: o.value,
      ageDays: o.ageDays,
      lagDays: o.lagDays,
    },
    reason: `${srcLabel} states ${value}; no second source after ${o.ageDays} day(s).`,
    severity: 'info',
  }
}

/** Short identity for one side of an attribution_diff — code preferred over the raw id. */
function attributionSideName(s: { batch_code?: string | null; batch: string | null }): string {
  return s.batch_code ?? s.batch ?? '(no batch)'
}

function fromAttributionDiff(a: AttributionDiff): RunFinding {
  const proposedName = attributionSideName(a.proposed)
  const gsheetName = attributionSideName(a.gsheet)
  const kg = fmtKg(a.weight_kg)

  return {
    key: `attribution_diff:${a.transaction_date}:${a.destination}:${proposedName}:${gsheetName}`,
    kind: 'attribution_diff',
    kindLabel: 'Sources disagree on attribution',
    source: 'RC OUT — cross-check (proposed vs sheet)',
    title: `${kg} on ${a.transaction_date}: same feeding, different batch/block`,
    location: `${a.transaction_date}${a.destination !== 'MAIN' ? ` → ${a.destination}` : ''}`,
    data: {
      transaction_date: a.transaction_date,
      destination: a.destination,
      weight_kg: num(a.weight_kg),
      proposed: { batch: a.proposed.batch, batch_code: a.proposed.batch_code ?? null, block_loc: a.proposed.block_loc },
      gsheet: { batch: a.gsheet.batch, batch_code: a.gsheet.batch_code ?? null, block_loc: a.gsheet.block_loc },
    },
    reason: `Both sources report ${kg} on ${a.transaction_date}, but disagree on which batch/block it came from — proposed says ${proposedName} @ ${a.proposed.block_loc ?? '(feed)'}, the sheet says ${gsheetName} @ ${a.gsheet.block_loc ?? '(feed)'}.`,
    severity: 'attention',
  }
}

function fromUnresolvedBatch(u: UnresolvedBatch): RunFinding {
  const kindOfMiss =
    u.candidates.length === 0
      ? 'no matching batch in the database'
      : `${u.candidates.length} possible batches (ambiguous)`
  const srcs = [...u.sources].sort().map((s) => RC_OUT_SOURCE_LABEL[s] ?? s).join(', ')

  return {
    key: `unresolved_batch:${u.batch_code}:${u.transaction_date}`,
    kind: 'unresolved_batch',
    kindLabel: 'Batch code can’t be matched',
    source: 'RC OUT — batch mapping',
    title: `Batch "${u.batch_code}" can't be matched to a stored batch`,
    location: u.transaction_date,
    data: {
      batch_code: u.batch_code,
      transaction_date: u.transaction_date,
      block_loc: u.block_loc,
      destination: u.destination,
      weight_kg: num(u.weight_kg),
      candidates: u.candidates,
      sources: u.sources,
    },
    reason: `${fmtKg(u.weight_kg)} on ${u.transaction_date} (from ${srcs}) — ${kindOfMiss}. Map or create the batch.`,
    severity: 'attention',
  }
}

/** Plain source label per report type, with the gsheet mode appended when present
 *  (mirrors `heldSource`, but this note carries its OWN `mode` field, not a row). */
function autoCreatedSource(reportType: SyncReportType, mode: 'rc_in' | 'rc_out' | undefined): string {
  const base = REPORT_SOURCE_LABEL[reportType] ?? titleCase(reportType)
  if (reportType === 'gsheet' && mode) return `${base} — ${mode === 'rc_in' ? 'RC IN' : 'RC OUT'}`
  return base
}

function fromAutoCreatedBatch(reportType: SyncReportType, note: AutoCreatedBatch): RunFinding {
  const locParts = [note.transaction_date, note.block_loc].filter(Boolean) as string[]
  const location = locParts.length ? locParts.join(' · ') : (note.source_row != null ? `row ${note.source_row}` : '—')

  return {
    key: `batch_auto_created:${reportType}:${note.mode ?? ''}:${note.batch_code}:${note.source_row ?? ''}`,
    kind: 'batch_auto_created',
    kindLabel: 'New batch created automatically',
    source: autoCreatedSource(reportType, note.mode),
    title: `New batch "${note.batch_code}" created automatically (${note.location_ref})`,
    location,
    data: {
      batch_code: note.batch_code,
      location_ref: note.location_ref,
      transaction_date: note.transaction_date,
      block_loc: note.block_loc,
      source_row: note.source_row,
    },
    reason:
      `The batch code was pattern-valid (a real month + year + block/feed number) but new to ` +
      `the database, so the sync created it and wrote the row automatically — nothing to do here.`,
    severity: 'info',
  }
}

function fromBlockDiff(d: BlockDiff): RunFinding {
  const isGrand = d.kind === 'grand_total'
  const label =
    d.kind === 'grand_total'
      ? 'Total inventory mismatch'
      : d.kind === 'batch_mismatch'
        ? 'Block holds a different batch'
        : d.kind === 'multi_batch'
          ? 'Block has multiple active batches'
          : 'Block balance mismatch'

  const where = isGrand ? 'grand total' : d.block_loc ?? '(no block)'
  const title = isGrand
    ? 'Total inventory: the Sheet and the app disagree'
    : `Block ${d.block_loc ?? '?'}: ${label.toLowerCase()}`

  return {
    key: isGrand ? 'block_diff:grand_total' : `block_diff:${d.block_loc}:${d.kind}`,
    kind: 'block_diff',
    kindLabel: label,
    source: 'Blocking cross-check',
    title,
    location: where,
    data: {
      subkind: d.kind,
      block_loc: d.block_loc,
      sheet_kg: d.sheet_kg,
      computed_kg: d.computed_kg,
      delta: d.delta,
      sheet_batch: d.sheet_batch ?? null,
      computed_batch: d.computed_batch ?? null,
      active_batch_count: d.active_batch_count ?? null,
    },
    reason: d.detail,
    severity: isGrand ? 'high' : 'attention',
  }
}

/** A batch closed (or a close asserted-but-unmatched) from a Google Sheet RC OUT close
 *  remark (the R4b close-scan). matched → info "closed automatically"; unmatched →
 *  attention "couldn't find the batch". */
function fromBatchClose(bc: BatchClose): RunFinding {
  const locParts = [bc.transaction_date, bc.block_loc].filter(Boolean) as string[]
  const location = locParts.length ? locParts.join(' · ') : (bc.source_row != null ? `row ${bc.source_row}` : '—')
  const code = bc.batch_code ?? '(unknown)'

  if (bc.matched) {
    return {
      key: `batch_closed:${bc.batch_code}:${bc.transaction_date ?? ''}:${bc.block_loc ?? ''}`,
      kind: 'batch_closed',
      kindLabel: 'Batch closed automatically',
      source: 'Google Sheet — RC OUT',
      title: `Batch "${code}" closed — feeding marked done on the Sheet`,
      location,
      data: {
        batch_code: bc.batch_code,
        location_ref: bc.location_ref,
        transaction_date: bc.transaction_date,
        block_loc: bc.block_loc,
        source_row: bc.source_row,
      },
      reason:
        `The Google Sheet's RC OUT tab marked this batch closed, so the sync flipped its status ` +
        `to CLOSED — a status-only change, nothing to do here.`,
      severity: 'info',
    }
  }

  return {
    key: `batch_close_unmatched:${bc.batch_code}:${bc.transaction_date ?? ''}:${bc.block_loc ?? ''}`,
    kind: 'batch_close_unmatched',
    kindLabel: 'Close remark with no matching batch',
    source: 'Google Sheet — RC OUT',
    title: `Sheet marked "${code}" closed, but no such batch exists`,
    location,
    data: {
      batch_code: bc.batch_code,
      transaction_date: bc.transaction_date,
      block_loc: bc.block_loc,
      source_row: bc.source_row,
    },
    reason:
      `The Sheet asked to close this batch, but its code doesn't match any batch in the ` +
      `database — nothing was closed. Check the batch code on that row.`,
    severity: 'attention',
  }
}

/** Plain phrase per production-plan field (no column names in the operator's face). */
const SCHEDULE_FIELD_LABEL: Record<string, string> = {
  shifts: 'shifts',
  setup: 'line setup',
  projected_tons: 'planned tons',
  grades: 'per-grade tons',
  remarks: 'notes',
}

/** "shifts and line setup" / "shifts, line setup and planned tons". */
function fieldList(fields: readonly string[]): string {
  const words = fields.map((f) => SCHEDULE_FIELD_LABEL[f] ?? f)
  if (words.length <= 1) return words[0] ?? 'this day'
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** Rightwards arrow (written as an escape so the source stays byte-clean, per the
 *  serializer convention further down this file). */
const ARROW = '\u2192'

/** Compact "shifts 2 → 0" pairs for the plain reason line. */
function fieldDeltas(c: ScheduleConflict): string {
  return c.changed_fields
    .map((f) => {
      const show = (v: unknown) =>
        v == null || v === '' ? 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return `${SCHEDULE_FIELD_LABEL[f] ?? f} ${show(c.current?.[f])} ${ARROW} ${show(c.proposed?.[f])}`
    })
    .join('; ')
}

/**
 * A production-PLAN day the sync refused to overwrite because a human edited it in the
 * app. Joseph's proposed value is PARKED (`production_schedule.pending_upstream`), not
 * applied — the operator picks. `attention`, never auto-resolved: this is the schedule's
 * instance of the project-wide "disagreements are arbitrated by a human" rule.
 */
function fromScheduleConflict(c: ScheduleConflict): RunFinding {
  return {
    key: `schedule_conflict:${c.plan_date}`,
    kind: 'schedule_conflict',
    kindLabel: 'Schedule day you edited — the plan email disagrees',
    source: 'Production schedule (Joseph Go)',
    title: `${c.plan_date}: your edit was kept — Joseph's schedule proposes a different ${fieldList(c.changed_fields)}`,
    location: c.plan_date,
    data: {
      plan_date: c.plan_date,
      source_rev: c.source_rev,
      changed_fields: c.changed_fields,
      current: c.current,
      proposed: c.proposed,
    },
    reason:
      `You edited this day in the app, so the sync did NOT overwrite it. Joseph's latest ` +
      `schedule proposes ${fieldDeltas(c)}. Nothing changed — pick which one stands.`,
    severity: 'attention',
  }
}

/**
 * A report stream that has gone QUIET — it has missed at least one planned working day.
 *
 * Every other finding describes something this run saw. This one describes something it
 * did NOT see, which is the failure a clean run hides: a sync where a stream simply never
 * arrived looks exactly like a sync on a quiet day. RC OUT sat 5 days stale in July 2026
 * for precisely that reason.
 *
 * The lateness arithmetic is `view_digest_stream_status.missed_working_days` — rest days
 * and not-yet-due next-day reports are already excluded there, so any row that reaches
 * here is genuinely late. Nothing to resolve in-app: the fix is upstream, in somebody's
 * inbox. `attention` at one day, escalating to `high` once a stream has missed three,
 * by which point it is not a late report, it is a broken pipe.
 */
function fromStaleStream(s: StaleStream): RunFinding {
  const days = s.missed_working_days === 1 ? '1 working day' : `${s.missed_working_days} working days`
  const last = s.through_date
    ? `Its last report covers ${s.through_date}`
    : 'It has never reported'
  return {
    key: `stale_stream:${s.stream}`,
    kind: 'stale_stream',
    kindLabel: 'Report stream has gone quiet',
    source: s.label,
    title: `${s.label} has missed ${days}`,
    location: s.through_date ?? '—',
    data: {
      stream: s.stream,
      through_date: s.through_date,
      operational_date: s.operational_date,
      missed_working_days: s.missed_working_days,
      reports_next_day: s.reports_next_day,
    },
    reason:
      `${last}, and ${days} of planned production have passed since without one. ` +
      `Rest days and reports that aren't due yet are already excluded, so this is a real gap. ` +
      `Nothing is wrong with the sync — the report has not arrived. Chase the sender.`,
    severity: s.missed_working_days >= 3 ? 'high' : 'attention',
  }
}

/**
 * A production-batch CHANGEOVER: MC's report marked the last runs of the batch that
 * was running (`ENDING`) and the first runs of a brand-new one (`STARTING`) on the
 * same day. The new batch's NAME is written nowhere in the workbook, so the sync
 * derived it — this is the confirmation prompt. Once a month at most; the rows DID
 * write, so this is never a held row.
 */
function fromProductionBatchStart(s: ProductionBatchStart): RunFinding {
  const derivedHow =
    s.derivation === 'sequence'
      ? `the next batch after ${s.previous_batch}`
      : `the month on the report tab (nothing earlier on record to count from)`

  return {
    key: `production_batch_started:${s.transaction_date}:${s.new_batch}`,
    kind: 'production_batch_started',
    kindLabel: 'New production batch opened',
    source: 'Production report',
    title: `${s.transaction_date}: production moved to a new batch, "${s.new_batch}"`,
    location: s.transaction_date,
    data: {
      transaction_date: s.transaction_date,
      new_batch: s.new_batch,
      previous_batch: s.previous_batch,
      derivation: s.derivation,
      source_sheet: s.source_sheet,
    },
    reason:
      `The report marked the last output of ${s.previous_batch} and the first output of a ` +
      `new batch on this day, so both were filed separately. The new batch's name is not ` +
      `written anywhere in the report — the sync named it "${s.new_batch}" because that is ` +
      `${derivedHow}. Confirm the name is right.`,
    severity: 'attention',
  }
}

/** Plain phrase per production field (no column names in the operator's face). */
const PRODUCTION_FIELD_LABEL: Record<string, string> = {
  ttl_kg: 'total kg',
  sacks_bags: 'sacks/bags',
  customer: 'customer',
  grade: 'grade',
  remarks: 'notes',
  shift_hrs: 'shift hours',
  dt_hrs: 'downtime hours',
  dt_mins: 'downtime minutes',
  dt_reason: 'downtime reason',
  rs1a_kg: 'RS1A waste',
  rs1b_kg: 'RS1B waste',
  bf_kg: 'BF waste',
  rs23_kg: 'RS2/3 waste',
  rs5_kg: 'RS5 waste',
  trml1_kg: 'TRML1 waste',
  trml2_kg: 'TRML2 waste',
  grit_kg: 'grit waste',
  start_kwh: 'start KWH',
  end_kwh: 'end KWH',
  meter_multiplier: 'meter multiplier',
  start_km: 'start KM',
  end_km: 'end KM',
  fuel_liters: 'fuel (L)',
}

/** Plain phrase per production section. */
const PRODUCTION_SECTION_LABEL: Record<string, string> = {
  runs: 'production output',
  downtime: 'downtime',
  waste: 'waste',
  electricity: 'electricity reading',
  trucks: 'truck reading',
}

/** "total kg 13,685 → 13,680; notes none → 'per MC'". */
function productionDeltas(e: ProductionHumanEdit): string {
  return e.changed_fields
    .map((f) => {
      const show = (v: unknown) => {
        if (v == null || v === '') return 'none'
        if (typeof v === 'number') return v.toLocaleString('en-US')
        if (typeof v === 'object') return JSON.stringify(v)
        return String(v)
      }
      return `${PRODUCTION_FIELD_LABEL[f.field] ?? f.field} ${show(f.yours)} ${ARROW} ${show(f.sheet)}`
    })
    .join('; ')
}

/**
 * A production row the sync refused to overwrite because a human edited it in the app
 * (the human-edit latch). The report's value is NOT applied and NOT parked — MC's/Ivy's
 * workbook is cumulative, so this re-fires every run until the operator fixes the sheet
 * or hands the row back. `attention`, never auto-resolved: production's instance of the
 * project-wide "disagreements are arbitrated by a human" rule.
 */
function fromProductionHumanEdit(e: ProductionHumanEdit): RunFinding {
  const sectionLabel = PRODUCTION_SECTION_LABEL[e.section] ?? e.section
  const where = [e.transaction_date, e.production_batch, e.shift, e.meter, e.plate_no]
    .filter(Boolean)
    .join(` ${DOT} `)
  const fields = e.changed_fields.map((f) => PRODUCTION_FIELD_LABEL[f.field] ?? f.field)
  const fieldPhrase =
    fields.length <= 1
      ? (fields[0] ?? 'this row')
      : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`
  const raced =
    e.outcome === 'refused_by_db'
      ? ' (you saved it while the sync was running - your save won)'
      : ''

  return {
    key: `production_human_edited:${e.table}:${e.record_id}`,
    kind: 'production_human_edited',
    kindLabel: 'Row you edited — the report disagrees',
    source: 'Production report',
    title: `${e.transaction_date ?? 'This'} ${sectionLabel}: your edit was kept — the report has a different ${fieldPhrase}`,
    location: where || e.table,
    data: {
      table: e.table,
      record_id: e.record_id,
      section: e.section,
      transaction_date: e.transaction_date,
      production_batch: e.production_batch,
      shift: e.shift,
      meter: e.meter,
      plate_no: e.plate_no,
      changed_fields: e.changed_fields,
      outcome: e.outcome,
    },
    reason:
      `You edited this row in the app, so the sync did NOT overwrite it${raced}. The report ` +
      `says ${productionDeltas(e)}. Nothing changed — either correct the report, or hand ` +
      `this row back to the sync if the report is right.`,
    severity: 'attention',
  }
}

// ============================================================================
// Delivery price findings (2026-08-07).
//
// THE FAILURE THESE EXIST TO END: for a week the sync's entire vocabulary for a
// price problem was one progress beat reading "Price file unavailable — proceeding
// without prices." The file was available; only the worksheet TAB NAME was
// unrecognized ("Aug. 2026" vs the generated "August 2026"). Because the price file
// is loaded ONCE before the row loop, that single miss un-priced every August
// delivery, and because a progress beat does not outlive the run, nothing survived
// to say so. Nine truckloads sat at cost_basis = 0 and dragged AUGUST-26-BLK1's
// average cost to ₱11.01 against a real ₱39.99.
//
// So: a whole-file/whole-month failure is `high` — it is not a row problem, it is
// every row in a month at once, and it is the loudest thing a deliveries run can
// say. NO ₱ ever reaches `data`; `formatData` would strip it anyway, but these
// builders never put one there in the first place.
// ============================================================================

/** Plain phrase per price-note kind. */
const PRICE_KIND_LABEL: Record<string, string> = {
  price_tab_unresolved: 'Price file has no tab for this month',
  price_tab_ambiguous: 'Price file has two tabs for the same month',
  price_file_unreadable: 'Price file could not be read',
  price_fuzzy_match: 'Priced, but the two sheets spell it differently',
  price_fuzzy_ambiguous: 'Could not price — more than one possible match',
  price_date_drift: 'Could not price — the only match is months away',
  price_out_of_band: 'Priced, but the rate is unlike this supplier',
}

/** A whole-file/whole-month failure is `high`; everything else needs a look. */
function priceSeverity(kind: string): FindingSeverity {
  switch (kind) {
    case 'price_tab_unresolved':
    case 'price_tab_ambiguous':
    case 'price_file_unreadable':
      return 'high'
    default:
      return 'attention'
  }
}

// NOTE: there is deliberately no `priceDifferences()` formatter here. The worker's
// `detail` string ALREADY names both spellings side by side (it is written as
// operator-facing prose in enrich.ts), and `data.differences` carries the structured
// pair. Reformatting it here would give the same fact two wordings that could drift.

function fromPriceNote(n: PriceNote): RunFinding {
  const kind = n.kind || 'price_fuzzy_ambiguous'
  const label = PRICE_KIND_LABEL[kind] ?? titleCase(kind)
  const isFileLevel =
    kind === 'price_tab_unresolved' || kind === 'price_tab_ambiguous' || kind === 'price_file_unreadable'

  // Location: the month for a file-level failure, else the delivery's date + plate.
  const rowLoc = [str(n.transaction_date), str(n.truck_plate)].filter(Boolean) as string[]
  const location = isFileLevel ? (str(n.looked_for) ?? 'price file') : rowLoc.length ? rowLoc.join(` ${DOT} `) : '—'

  // Title: a file-level failure names the MONTH (every row in it is affected); a row
  // note names the truck, because that is what the operator will go and check.
  let title: string
  if (kind === 'price_tab_unresolved') {
    title = `No price tab for ${str(n.looked_for) ?? 'that month'} — every delivery in it is unpriced`
  } else if (kind === 'price_tab_ambiguous') {
    title = `Two price tabs both mean ${str(n.looked_for) ?? 'that month'} — refused to guess`
  } else if (kind === 'price_file_unreadable') {
    title = 'The price file could not be opened — nothing was priced'
  } else {
    const who = [str(n.supplier), str(n.truck_plate)].filter(Boolean).join(' ') || 'a delivery'
    // Never say "priced" for a kind that refused — `price_fuzzy_ambiguous` and
    // `price_date_drift` both leave the row at ₱0, and a title claiming otherwise
    // would be the same lie as "Price file unavailable".
    if (kind === 'price_fuzzy_ambiguous') {
      title = `${who}: could not be priced — the match was not unique`
    } else if (kind === 'price_date_drift') {
      const away = num(n.date_tolerance_days)
      title = `${who}: could not be priced — the only matching row is ${away == null ? 'months' : `${away} days`} away`
    } else if (kind === 'price_out_of_band') {
      title = `${who}: priced at an unusual rate for this supplier`
    } else {
      title = `${who}: priced from a row that is spelled differently`
    }
  }

  const data: Record<string, unknown> = {}
  if (str(n.transaction_date)) data.transaction_date = n.transaction_date
  if (str(n.supplier)) data.supplier = n.supplier
  if (str(n.batch_code)) data.batch_code = n.batch_code
  if (str(n.truck_plate)) data.truck_plate = n.truck_plate
  if (n.weight_kg != null) data.weight_kg = num(n.weight_kg)
  if (n.sacks != null) data.sacks = num(n.sacks)
  if (str(n.source_row)) data.source_row = n.source_row
  if (str(n.via)) data.matched_via = n.via
  if (str(n.matched_sheet)) data.matched_sheet = n.matched_sheet
  if (n.matched_row != null) data.matched_row = num(n.matched_row)
  if (n.date_tolerance_days != null) data.date_tolerance_days = num(n.date_tolerance_days)
  if (str(n.looked_for)) data.looked_for = n.looked_for
  // The two halves of the tab-miss message: what it wanted AND what is actually there.
  if (n.tabs_found.length) data.tabs_found = n.tabs_found
  if (n.candidates.length) data.candidates = n.candidates
  if (str(n.collided_on)) data.collided_on = n.collided_on
  if (n.differences.length) data.differences = n.differences
  if (n.collisions.length) data.collisions = n.collisions

  // A stable run-local key. File-level notes key on the month (one per month); row
  // notes key on the delivery identity + kind, so a row with two distinct problems
  // yields two rows and a repeat of the same problem does not.
  const key = isFileLevel
    ? `price:${kind}:${n.looked_for ?? ''}`
    : `price:${kind}:${n.transaction_date ?? ''}:${n.truck_plate ?? ''}:${n.batch_code ?? ''}:${n.weight_kg ?? ''}`

  return {
    key,
    kind,
    kindLabel: label,
    source: 'Delivery prices (Czarina)',
    title,
    location,
    data,
    // `detail` from the worker is already written as operator-facing prose (it names
    // the tab it wanted and the tabs it found, or both spellings), so it IS the reason.
    reason: n.detail || label,
    severity: priceSeverity(kind),
  }
}

/**
 * A delivery still unpriced more than a day after it happened. Renzo: "prices are not
 * supposed to lag, and they liquidate daily."
 *
 * This is the finding that would have caught the August outage on day two instead of
 * day seven — it does not care WHY a row is unpriced, only that it still is. Escalates
 * to `high` at four days pending, the same "at this point it is not late, it is broken"
 * threshold `fromStaleStream` uses (the overdue floor is 2, so 4 means three days late).
 */
function fromUnpricedOverdue(o: UnpricedOverdue): RunFinding {
  const who = [str(o.supplier), str(o.truck_plate)].filter(Boolean).join(' ') || 'A delivery'
  const days = o.days_pending === 1 ? '1 day' : `${o.days_pending} days`

  return {
    key: `unpriced_overdue:${o.id}`,
    kind: 'unpriced_overdue',
    kindLabel: 'Delivery still has no price',
    source: 'Delivery prices (Czarina)',
    title: `${who}: ${fmtKg(o.weight_kg)} delivered ${days} ago and still unpriced`,
    location: [str(o.transaction_date), str(o.batch_code)].filter(Boolean).join(` ${DOT} `) || '—',
    data: {
      delivery_id: o.id,
      transaction_date: o.transaction_date,
      supplier: o.supplier,
      batch_code: o.batch_code,
      truck_plate: o.truck_plate,
      weight_kg: num(o.weight_kg),
      sacks: num(o.sacks),
      days_pending: o.days_pending,
    },
    reason:
      `This delivery has been in the database for ${days} with no price. Prices are not ` +
      `supposed to lag — either it is missing from Czarina's file, or the sync could not ` +
      `match it. Until a price lands, the batch's average cost is calculated from its ` +
      `priced deliveries only, so this row is not dragging that figure down.`,
    severity: o.days_pending >= 4 ? 'high' : 'attention',
  }
}

// ============================================================================
// The public API.
// ============================================================================

/**
 * Flatten EVERYTHING a run flagged into one honest list, in a stable order:
 * held rows (per report) → source diffs → single-source-overdue → unresolved batches →
 * block diffs. Pure, exhaustive, never throws. `result` may be a partial/M0 manifest —
 * every channel is guarded, so a run with nothing to show returns `[]`.
 */
export function flattenRunFindings(result: SyncRunResult): RunFinding[] {
  if (!result) return []
  const out: RunFinding[] = []

  // 1. Held rows across every report's apply phase.
  for (const { reportType, held } of collectHeldRows(result)) {
    out.push(fromHeld(reportType, held))
  }

  // 2. rc_out source disagreements.
  for (const diff of collectSourceDiffs(result)) out.push(fromSourceDiff(diff))

  // 3. rc_out single-witness-overdue facts.
  for (const o of collectSingleSourceOverdue(result)) out.push(fromOverdue(o))

  // 3.5. rc_out second-pass attribution pairings (same feeding, different batch/block).
  for (const a of collectAttributionDiffs(result)) out.push(fromAttributionDiff(a))

  // 4. rc_out unresolved batches.
  for (const u of collectUnresolvedBatches(result)) out.push(fromUnresolvedBatch(u))

  // 5. Blocking cross-check diffs (per-block + the single grand_total).
  for (const d of collectBlockDiffs(result)) out.push(fromBlockDiff(d))

  // 6. Batches auto-created this run (2026-07-11 policy) — info-level, visibility only.
  for (const { reportType, note } of collectAutoCreatedBatches(result)) {
    out.push(fromAutoCreatedBatch(reportType, note))
  }

  // 7. Batches closed from a Google Sheet RC OUT close remark (R4b close-scan) — info for
  //    an actual close, attention for a close asserted against an unknown batch.
  for (const bc of collectBatchCloses(result)) out.push(fromBatchClose(bc))

  // 8. Production-plan days the sync withheld because a human owns them (Stage 3c).
  for (const c of collectScheduleConflicts(result)) out.push(fromScheduleConflict(c))

  // 9. Production-batch changeovers (a STARTING marker opened a derived batch name).
  for (const s of collectProductionBatchStarts(result)) out.push(fromProductionBatchStart(s))

  // 10. Production rows the sync refused to overwrite (the human-edit latch).
  for (const e of collectProductionHumanEdits(result)) out.push(fromProductionHumanEdit(e))

  // 11. Delivery-price problems (2026-08-07): a tab that could not be resolved, a fuzzy
  //     match that was accepted, a match refused as non-unique, a rate unlike the
  //     supplier's. The file-level ones are `high` — they un-price a whole month at once.
  for (const n of collectPriceNotes(result)) out.push(fromPriceNote(n))

  // 12. Deliveries still unpriced more than a day on. Independent of WHY, so it catches
  //     a price outage the price step itself did not notice.
  for (const o of collectUnpricedOverdue(result)) out.push(fromUnpricedOverdue(o))

  // 13. Streams that have gone quiet (Stage 3e) — the one finding about what did NOT
  //     arrive. Last, because it describes the state the whole run leaves behind.
  for (const s of collectStaleStreams(result)) out.push(fromStaleStream(s))

  return out
}

/** The honest headline count + a per-kind breakdown. */
export function summarizeFindings(findings: RunFinding[]): {
  total: number
  byKind: Record<string, number>
} {
  const byKind: Record<string, number> = {}
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
  return { total: findings.length, byKind }
}

// ============================================================================
// Diagnosis-ready serializers — turn a run's findings (or the review page's
// cases) into ONE dense, self-contained plain-text/markdown block optimized for
// an LLM to ingest and diagnose. Pure, deterministic, never throw, no I/O.
//
// Non-ASCII structural delimiters are written as `\uXXXX` escapes (never raw
// bytes) so the source stays byte-clean; the RUNTIME string carries the real
// glyphs. NO ₱/cost is ever emitted — RunFinding.data already excludes it, and
// `formatData` strips any cost-ish key from a raw case row as a belt-and-braces.
// ============================================================================

/** Middle dot `·`. */
const DOT = '\u00B7'
/** Em dash `—`. */
const DASH = '\u2014'
/** Multiplication sign `×`. */
const TIMES = '\u00D7'

/**
 * Compact word per kind for the by-kind breakdown line (e.g. "4 block · 3 overdue").
 * Mirrors HeldRows.tsx's SHORT_KIND (duplicated on purpose — this module must stay
 * client-safe AND node-safe; the copy is trivial and drift-tolerant). Falls back to a
 * plain kind label.
 */
const SHORT_KIND: Record<string, string> = {
  block_diff: 'block',
  single_source_overdue: 'overdue',
  source_diff: 'sources disagree',
  attribution_diff: 'attribution mismatch',
  unresolved_batch: 'unknown batch',
  unmapped_batch_code: 'unknown batch',
  unmapped_bag_type_code: 'unknown bag type',
  gate_failure: 'totals off',
  cross_batch_reassignment: 'batch moved',
  location_occupied: 'slot occupied',
  malformed: 'bad row',
  already_exists: 'already saved',
  low_confidence: 'low confidence',
  unresolved_shift: 'unmatched shift',
  unresolved_batch_id: 'unknown batch',
  batch_auto_created: 'batch created',
  schedule_conflict: 'schedule day held',
  production_batch_started: 'new production batch',
  production_human_edited: 'your edit kept',
  stale_stream: 'report overdue',
  price_tab_unresolved: 'no price tab',
  price_tab_ambiguous: 'duplicate price tab',
  price_file_unreadable: 'price file unreadable',
  price_fuzzy_match: 'price spelling differs',
  price_fuzzy_ambiguous: 'price match not unique',
  price_date_drift: 'price match too old',
  price_out_of_band: 'unusual rate',
  unpriced_overdue: 'no price yet',
}

/** Plain phrase for synthetic (non-held) case/finding kinds, on top of HELD_KIND_LABEL. */
const EXTRA_KIND_LABEL: Record<string, string> = {
  source_diff: 'Sources disagree',
  single_source_overdue: 'Only one source reported',
  attribution_diff: 'Sources disagree on attribution',
  unresolved_batch: "Batch code can't be matched",
  block_diff: 'Block balance mismatch',
  run_triage: 'Run summary',
  batch_auto_created: 'New batch created automatically',
  schedule_conflict: 'Schedule day you edited — the plan email disagrees',
  production_batch_started: 'New production batch opened',
  production_human_edited: 'Row you edited — the report disagrees',
  stale_stream: 'Report stream has gone quiet',
  // Delivery price kinds (2026-08-07). Kept in sync with PRICE_KIND_LABEL above — that
  // table drives the live findings, this one covers a durable case row read back later.
  price_tab_unresolved: 'Price file has no tab for this month',
  price_tab_ambiguous: 'Price file has two tabs for the same month',
  price_file_unreadable: 'Price file could not be read',
  price_fuzzy_match: 'Priced, but the two sheets spell it differently',
  price_fuzzy_ambiguous: 'Could not price — more than one possible match',
  price_date_drift: 'Could not price — the only match is months away',
  price_out_of_band: 'Priced, but the rate is unlike this supplier',
  unpriced_overdue: 'Delivery still has no price',
}

/** Tolerant plain label for ANY finding/case kind (held kinds + synthetic kinds). */
function findingKindLabel(kind: string): string {
  return EXTRA_KIND_LABEL[kind] ?? HELD_KIND_LABEL[kind] ?? titleCase(kind)
}

/** Keys we never emit — cost/price columns, gated everywhere in Blackwood. */
const COST_KEY_RE = /cost|price|php|peso/i

/**
 * Flatten a `data` / raw-row object into compact `key=value; key=value` text. Skips
 * empty values and any cost-ish key; nested values are compact-JSON'd so both sides of a
 * diff / the candidate list survive intact.
 */
function formatData(data: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === '') continue
    if (COST_KEY_RE.test(k)) continue
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
    parts.push(`${k}=${val}`)
  }
  return parts.join('; ')
}

/** "4 block · 3 overdue · 1 unknown batch" — loudest kind first, then kind name. */
function breakdownText(
  counts: Record<string, number>,
  labelFor: (kind: string) => string,
): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${SHORT_KIND[kind] ?? labelFor(kind)}`)
    .join(` ${DOT} `)
}

/** The run-identity header line — `runId` is LOAD-BEARING (lets the assistant query more). */
function runHeaderLine(meta: { runId: string | null; runDate?: string | null; status?: string | null }): string {
  const runDate = str(meta.runDate) ?? 'date n/a'
  const status = str(meta.status) ?? 'unknown status'
  return `Run: ${meta.runId ?? 'unknown (no run id)'} ${DOT} ${runDate} ${DOT} ${status}`
}

/**
 * Serialize a run's honest findings into a diagnosis-ready block for Claude Code.
 * Dense over pretty: a self-describing line, the LOAD-BEARING run id, a total + by-kind
 * breakdown, then every finding grouped by kind (first-appearance order) carrying the
 * source, location, the ACTUAL data values, and the plain reason. Deterministic, no throw.
 */
export function serializeFindingsForClaude(
  findings: RunFinding[],
  meta: { runId: string | null; runDate?: string | null; status?: string | null },
): string {
  const lines: string[] = []
  lines.push(`Blackwood sync flags ${DASH} for diagnosis in Claude Code`)
  lines.push(runHeaderLine(meta))

  const { total, byKind } = summarizeFindings(findings)
  if (total === 0) {
    lines.push(`Total: 0 findings ${DASH} nothing was flagged (clean run).`)
    return lines.join('\n')
  }

  const labelFor = (kind: string) =>
    findings.find((f) => f.kind === kind)?.kindLabel ?? findingKindLabel(kind)
  lines.push(
    `Total: ${total} finding${total === 1 ? '' : 's'} ${DASH} ${breakdownText(byKind, labelFor)}`,
  )

  // Group by kind, kinds in first-appearance order (deterministic given flatten order).
  const order: string[] = []
  const groups = new Map<string, RunFinding[]>()
  for (const f of findings) {
    let list = groups.get(f.kind)
    if (!list) {
      list = []
      groups.set(f.kind, list)
      order.push(f.kind)
    }
    list.push(f)
  }

  for (const kind of order) {
    const group = groups.get(kind)!
    lines.push('')
    lines.push(`## ${group[0].kindLabel} [${kind}] ${TIMES}${group.length}`)
    for (const f of group) {
      lines.push(`- [${f.severity}] ${f.source} | ${f.location} | ${f.title}`)
      const data = formatData(f.data)
      if (data) lines.push(`  data: ${data}`)
      if (f.reason) lines.push(`  why: ${f.reason}`)
    }
  }

  return lines.join('\n')
}

/**
 * The minimal, presentation-free shape `serializeCasesForClaude` needs. The Sync Review
 * page maps each visible `sync_held_cases` row into this (extracting the investigator
 * verdict word + one-line summary via `asVerdict`), so the serializer never imports the
 * component/verdict types and stays pure.
 */
export interface SerializableCase {
  kind: string
  report_type: string
  natural_key: string
  status?: string | null
  reason?: string | null
  detail?: string | null
  /** The raw held row jsonb (cost-ish keys are stripped on serialize). */
  row?: unknown
  occurrence_count?: number
  /** Investigator verdict word (apply | skip | needs-human), if investigated. */
  verdict?: string | null
  /** The investigator's one-line read. */
  verdictSummary?: string | null
}

/**
 * Serialize the Sync Review page's open cases into a diagnosis-ready block for Claude Code.
 * Richer than the findings dump: each case also carries the investigator's `verdict` +
 * one-line read. Same header/breakdown discipline, grouped by kind. Pure, no throw.
 */
export function serializeCasesForClaude(
  cases: SerializableCase[],
  meta: { runId: string | null; runDate?: string | null; status?: string | null },
): string {
  const lines: string[] = []
  lines.push(`Blackwood sync review cases ${DASH} for diagnosis in Claude Code`)
  lines.push(runHeaderLine(meta))

  const total = cases.length
  if (total === 0) {
    lines.push(`Total: 0 cases ${DASH} nothing open to review.`)
    return lines.join('\n')
  }

  const byKind: Record<string, number> = {}
  for (const c of cases) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1
  lines.push(
    `Total: ${total} case${total === 1 ? '' : 's'} ${DASH} ${breakdownText(byKind, findingKindLabel)}`,
  )

  const order: string[] = []
  const groups = new Map<string, SerializableCase[]>()
  for (const c of cases) {
    let list = groups.get(c.kind)
    if (!list) {
      list = []
      groups.set(c.kind, list)
      order.push(c.kind)
    }
    list.push(c)
  }

  for (const kind of order) {
    const group = groups.get(kind)!
    lines.push('')
    lines.push(`## ${findingKindLabel(kind)} [${kind}] ${TIMES}${group.length}`)
    for (const c of group) {
      const occ = c.occurrence_count && c.occurrence_count > 1 ? ` ${TIMES}${c.occurrence_count}` : ''
      const verdict = str(c.verdict) ? `verdict=${c.verdict}` : 'not yet investigated'
      lines.push(`- [${str(c.status) ?? 'open'}] ${c.report_type} | ${c.natural_key}${occ} | ${verdict}`)
      if (str(c.verdictSummary)) lines.push(`  read: ${c.verdictSummary}`)
      const reason = str(c.reason) ?? str(c.detail)
      if (reason) lines.push(`  why: ${reason}`)
      const data =
        c.row && typeof c.row === 'object' ? formatData(c.row as Record<string, unknown>) : ''
      if (data) lines.push(`  data: ${data}`)
    }
  }

  return lines.join('\n')
}

/**
 * Serialize ONE case into a self-contained diagnosis-ready markdown brief for a
 * Claude Code session — the per-case "Copy for Claude" button (`CaseDetail.tsx`).
 * This is the replacement workflow for the in-app investigator now that Sync
 * Review is deterministic-only (`SYNC_AI_REVIEW_ENABLED=false`, see
 * `lib/sync/config.ts`): copy this block, paste it into a Claude Code chat, and
 * ask for a diagnosis + recommendation instead of clicking "Investigate".
 *
 * Leads with an explicit instruction line (so the pasted block is self-explaining
 * with no extra typing needed), then the kind/label, natural key, status, why it
 * was flagged, any prior investigator verdict (if the AI layer was on when it was
 * written), and every row field (cost-ish keys stripped, same as every other
 * serializer here). Pure, deterministic, network-free, never throws.
 */
export function serializeCaseForClaude(c: SerializableCase): string {
  const lines: string[] = []
  lines.push('Diagnose this Blackwood sync flag and recommend a resolution:')
  lines.push('')
  lines.push(`Kind: ${findingKindLabel(c.kind)} [${c.kind}]`)
  lines.push(`Report: ${c.report_type}`)
  lines.push(`Natural key: ${c.natural_key}`)
  if (str(c.status)) lines.push(`Status: ${c.status}`)
  if (c.occurrence_count && c.occurrence_count > 1) {
    lines.push(`Seen in: ${c.occurrence_count} runs`)
  }

  const reason = str(c.reason) ?? str(c.detail)
  if (reason) lines.push(`Why flagged: ${reason}`)

  if (str(c.verdict)) {
    const read = str(c.verdictSummary)
    lines.push(`Prior investigator verdict: ${c.verdict}${read ? ` ${DASH} ${read}` : ''}`)
  }

  const data = c.row && typeof c.row === 'object' ? formatData(c.row as Record<string, unknown>) : ''
  if (data) {
    lines.push('')
    lines.push(`Row data: ${data}`)
  }

  return lines.join('\n')
}
