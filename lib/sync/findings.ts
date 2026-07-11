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
  collectAttributionDiffs,
  collectAutoCreatedBatches,
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
