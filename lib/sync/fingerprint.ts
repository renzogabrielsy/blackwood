/**
 * fingerprint.ts — a PURE, deterministic content hash for a held-row discrepancy.
 *
 * The fan-out action (app/(app)/sync/cases.ts) upserts one durable case per
 * DISTINCT discrepancy, deduped by this fingerprint. The hash decides "is this the
 * SAME issue we've seen before, or a new one?" — so what goes INTO it is a design
 * decision, split by held-kind:
 *
 *   - gate_failure  → the NUMBERS matter. A gate that fails by 13,743 kg on June 10
 *     and later fails by a DIFFERENT amount is a DIFFERENT discrepancy that must
 *     re-alarm. So the (rounded) drift figures are folded in. The dates array is
 *     sorted so field-order / arrival-order never changes the hash.
 *   - every other kind → ROW IDENTITY matters, not the payload. An unmapped batch
 *     code "JULY-26-BLK9" is the same case whether its weight is 5,820 or 5,821 kg
 *     — the same row keeps re-appearing until a human maps it. So only
 *     (reportType, kind, natural_key) participate; the row payload is excluded.
 *
 * No I/O. Uses node's crypto. Import-safe from a server action.
 */
import { createHash } from 'node:crypto'

import type { HeldRow, SourceDiff, SyncReportType } from '../../app/(app)/sync/types'

/**
 * The gate-failure drift shape threaded onto `row.drift_dates` by the worker.
 * Mirrors GateDriftDate in app/(app)/sync/adjudication.ts (kept local to avoid a
 * server-only import chain). Pure kg totals — NO ₱/cost.
 */
interface DriftDate {
  date: string
  proposed_kg?: number | null
  movement_kg?: number | null
  diff_kg?: number | null
  db_sum_kg?: number | null
  excess_kg?: number | null
  note?: string
}

/**
 * Recursively sort object keys so serialization is deterministic regardless of the
 * order keys were inserted. Arrays keep their order (the caller sorts where order is
 * not semantic). Primitives pass through.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Stable JSON: canonicalized (keys sorted recursively) then serialized. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * The shared canonical content hash: canonicalize (sort keys recursively) → stable
 * JSON → sha256 hex. `caseFingerprint` (held rows) and `triageFingerprint`
 * (lib/investigator/triage.ts, per-run) both build ON this so the hashing discipline
 * lives in ONE place. Exported so no caller re-implements canonicalization + sha256.
 */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

/**
 * Reduce one drift date to only its PRESENT numeric fields, each rounded to an
 * integer, keeping `note` if set. Rounding means sub-kg jitter doesn't spawn a new
 * case, but a real change (a different diff) does.
 */
function canonicalDriftDate(d: DriftDate): Record<string, unknown> {
  const out: Record<string, unknown> = { date: d.date }
  const numericFields: Array<keyof DriftDate> = [
    'proposed_kg',
    'movement_kg',
    'diff_kg',
    'db_sum_kg',
    'excess_kg',
  ]
  for (const f of numericFields) {
    const v = d[f]
    if (v != null && typeof v === 'number' && Number.isFinite(v)) {
      out[f] = Math.round(v)
    }
  }
  if (d.note != null) out.note = d.note
  return out
}

/**
 * The stable content hash for a held row.
 *
 *   gate_failure  → sha256 of {reportType, kind, gate, dates:[…sorted, rounded]}
 *   other/absent  → sha256 of {reportType, kind, natural_key}
 */
export function caseFingerprint(reportType: SyncReportType, held: HeldRow): string {
  let canonical: Record<string, unknown>

  if (held.kind === 'gate_failure') {
    const rawDrift = (held.row?.drift_dates as DriftDate[] | undefined) ?? []
    const dates = rawDrift
      .map(canonicalDriftDate)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    canonical = {
      reportType,
      kind: 'gate_failure',
      // The gate identity — prefer the human label, fall back to the reason.
      gate: held.natural_key || held.reason,
      dates,
    }
  } else {
    canonical = {
      reportType,
      kind: held.kind ?? 'other',
      natural_key: held.natural_key,
    }
  }

  return canonicalHash(canonical)
}

// ============================================================================
// R2 — source_diff fingerprint + human label
// ============================================================================

/**
 * A stable, human-readable label for a `source_diff` case. Example:
 *   "MAR-26-BLK5 @ D-11B · 2026-06-10 · weight"
 * Used as the case's `natural_key` (the operator-facing identity + the recurrence key).
 */
export function sourceDiffNaturalKey(diff: SourceDiff): string {
  const k = diff.naturalKey
  const batch = k.batch ?? '(no batch)'
  const block = k.block_loc ?? '(no block)'
  const dest = k.destination && k.destination !== 'MAIN' ? ` → ${k.destination}` : ''
  const field = diff.field === 'weight_kg' ? 'weight' : diff.field
  return `${batch} @ ${block}${dest} · ${k.transaction_date} · ${field}`
}

/**
 * The stable content hash for a `source_diff` discrepancy. Folds in the natural key +
 * field + the SORTED set of competing (source, value) pairs — so the SAME disagreement
 * (same key, same competing numbers) is recognized as one recurring case, but a CHANGED
 * disagreement (a different competing value next run) re-alarms as a new case. Weight
 * values are rounded to the integer kg so sub-kg jitter does not spawn a new case
 * (mirrors the gate-failure drift discipline in `caseFingerprint`).
 */
export function sourceDiffFingerprint(diff: SourceDiff): string {
  const competing = diff.sources
    .map((s) => ({
      source: s.source,
      value:
        typeof s.value === 'number' && Number.isFinite(s.value) ? Math.round(s.value) : s.value,
    }))
    // Sort by source so arrival order never changes the hash.
    .sort((a, b) => a.source.localeCompare(b.source))

  const k = diff.naturalKey
  const canonical = {
    kind: 'source_diff',
    table: diff.table,
    natural_key: {
      transaction_date: k.transaction_date,
      batch: k.batch,
      block_loc: k.block_loc,
      destination: k.destination,
    },
    field: diff.field,
    competing,
  }
  return canonicalHash(canonical)
}
