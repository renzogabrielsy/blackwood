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
  BlockDiff,
  HeldRow,
  RcOutSource,
  SingleSourceOverdue,
  SourceDiff,
  SyncReportType,
  SyncRunResult,
  UnresolvedBatch,
} from '../../app/(app)/sync/types'
import {
  collectBlockDiffs,
  collectHeldRows,
  collectSingleSourceOverdue,
  collectSourceDiffs,
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

  // 4. rc_out unresolved batches.
  for (const u of collectUnresolvedBatches(result)) out.push(fromUnresolvedBatch(u))

  // 5. Blocking cross-check diffs (per-block + the single grand_total).
  for (const d of collectBlockDiffs(result)) out.push(fromBlockDiff(d))

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
