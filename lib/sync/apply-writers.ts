/**
 * apply-writers.ts — the WRITER REGISTRY for human-directed resolution (P5).
 *
 * When a reviewer confirms an "apply" / "edit-then-apply" resolution in the case
 * chat, executeResolution (app/(app)/sync/resolve.ts) routes the case's row through
 * the deterministic write path the sync employee uses — one writer per report type.
 *
 * ONLY per-row holds with a registered writer here can be applied. Everything else
 * (report-level gate failures, report types without a writer) is refused with a
 * plain error the model relays.
 *
 * Hard rules preserved (CLAUDE.md "Database Rules"):
 *   - NEVER auto-create a batch. A row whose batch can't be resolved to a UNIQUE
 *     existing batch fails with a plain error listing the candidates.
 *   - NEVER delete anything.
 *   - Price gating (L-008): deliveries.cost_basis is forced to 0 (a placeholder);
 *     pricing stays email-side. rc_out has no cost column at all.
 *
 * The PURE validation functions (validateRcOutRow / validateDeliveriesRow) are
 * exported and take NO client, so scripts/verify-resolution.ts can exercise them
 * without a DB. The writers themselves do the batch resolution + insert + audit.
 */
import type { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/supabase'

type AdminClient = ReturnType<typeof createAdminClient>

/** What a writer returns on success — the table it wrote + the new row id + snapshot. */
export interface WriteOutcome {
  table: string
  record_id: string
  snapshot: Record<string, unknown>
}

/** A writer takes the (possibly edited) row + an admin client + a provenance string. */
export type ApplyWriter = (
  row: Record<string, unknown>,
  admin: AdminClient,
  provenance: string,
) => Promise<WriteOutcome>

/** Report types that have a registered per-row writer (v1: rc_out + deliveries). */
export const APPLY_WRITER_REPORT_TYPES = ['rc_out', 'deliveries'] as const

// ============================================================================
// PURE validation (no client) — exported for the verify script.
// ============================================================================

export interface ValidationResult {
  ok: boolean
  /** A plain-language error naming exactly what's missing (surfaced to the model). */
  error?: string
  /** The cleaned/normalized field values a writer will use (present when ok). */
  clean?: Record<string, unknown>
}

/** Coerce to a finite positive number, or null. */
function posNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** A non-empty trimmed string, or null. */
function nonEmptyStr(v: unknown): string | null {
  if (typeof v !== 'string') {
    if (typeof v === 'number') return String(v)
    return null
  }
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** A YYYY-MM-DD date string (basic shape check), or null. */
function isoDate(v: unknown): string | null {
  const s = nonEmptyStr(v)
  if (!s) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/**
 * Validate an rc_out row the same way the sync applies it. Requires a date, a
 * positive weight, a destination, and a batch reference (production_batch or
 * batch_code — resolved to batch_id at write time). NEVER touches cost.
 */
export function validateRcOutRow(row: unknown): ValidationResult {
  if (!row || typeof row !== 'object') {
    return { ok: false, error: 'The row is empty — there is nothing to save.' }
  }
  const r = row as Record<string, unknown>

  const transaction_date = isoDate(r.transaction_date)
  if (!transaction_date) {
    return { ok: false, error: 'Missing or badly-formatted feeding date (needs a YYYY-MM-DD date).' }
  }

  const weight_kg = posNumber(r.weight_kg)
  if (weight_kg == null) {
    return { ok: false, error: 'Missing or non-positive weight — a feeding must have a weight in kg.' }
  }

  const destination = nonEmptyStr(r.destination)
  if (!destination) {
    return { ok: false, error: 'Missing destination — where the raw charcoal was fed to.' }
  }

  // The batch reference: either an explicit batch_code, or the production_batch label.
  const batch_code = nonEmptyStr(r.batch_code) ?? nonEmptyStr(r.production_batch)
  if (!batch_code) {
    return {
      ok: false,
      error: 'Missing batch — no batch code or production batch on the row, so it cannot be linked to a stored batch.',
    }
  }

  return {
    ok: true,
    clean: {
      transaction_date,
      weight_kg,
      destination,
      batch_code,
      production_batch: nonEmptyStr(r.production_batch),
      block_loc: nonEmptyStr(r.block_loc),
      remarks: nonEmptyStr(r.remarks),
    },
  }
}

/**
 * Validate a deliveries row. Requires a date, supplier, positive weight, and a
 * batch_code (resolved against an EXISTING batch — never auto-created). cost_basis
 * is forced to 0 downstream (L-008); lab_results only if present.
 */
export function validateDeliveriesRow(row: unknown): ValidationResult {
  if (!row || typeof row !== 'object') {
    return { ok: false, error: 'The row is empty — there is nothing to save.' }
  }
  const r = row as Record<string, unknown>

  const transaction_date = isoDate(r.transaction_date)
  if (!transaction_date) {
    return { ok: false, error: 'Missing or badly-formatted delivery date (needs a YYYY-MM-DD date).' }
  }

  const supplier = nonEmptyStr(r.supplier)
  if (!supplier) {
    return { ok: false, error: 'Missing supplier — a delivery must name who it came from.' }
  }

  const weight_kg = posNumber(r.weight_kg)
  if (weight_kg == null) {
    return { ok: false, error: 'Missing or non-positive weight — a delivery must have a weight in kg.' }
  }

  const batch_code = nonEmptyStr(r.batch_code)
  if (!batch_code) {
    return {
      ok: false,
      error: 'Missing batch code — a delivery must reference a stored batch (batches are never created here).',
    }
  }

  return {
    ok: true,
    clean: {
      transaction_date,
      supplier,
      weight_kg,
      batch_code,
      block_loc: nonEmptyStr(r.block_loc),
      truck_plate: nonEmptyStr(r.truck_plate),
      sacks: r.sacks != null && Number.isFinite(Number(r.sacks)) ? Number(r.sacks) : null,
      remarks: nonEmptyStr(r.remarks),
      // Lab results only if the row actually carries them (nested JSONB).
      lab_results:
        r.lab_results && typeof r.lab_results === 'object' ? (r.lab_results as Record<string, unknown>) : null,
    },
  }
}

// ============================================================================
// Batch resolution (never auto-creates) — shared by both writers.
// ============================================================================

interface BatchResolution {
  ok: boolean
  batch_id?: string
  batch_code?: string
  /** On failure, a plain error listing the near candidates (never creates a batch). */
  error?: string
}

/**
 * Resolve a batch_code to a UNIQUE existing batch id. Exact match first; if none,
 * an `ilike` fuzzy match. If zero or 2+ candidates, FAIL with a plain error naming
 * the candidates — NEVER create a batch (CLAUDE.md hard rule).
 */
async function resolveUniqueBatch(admin: AdminClient, batchCode: string): Promise<BatchResolution> {
  // 1. Exact match.
  const { data: exact, error: exactErr } = await admin
    .from('batches')
    .select('id, batch_code')
    .eq('batch_code', batchCode)
    .limit(2)
  if (exactErr) return { ok: false, error: `Could not look up the batch: ${exactErr.message}` }
  if (exact && exact.length === 1) {
    return { ok: true, batch_id: exact[0].id as string, batch_code: exact[0].batch_code as string }
  }
  if (exact && exact.length > 1) {
    return {
      ok: false,
      error: `The batch code "${batchCode}" matches more than one stored batch — resolve which one by hand before saving.`,
    }
  }

  // 2. Fuzzy match (the month-prefix inconsistency: JAN vs MARCH vs SEPT…).
  const { data: fuzzy, error: fuzzyErr } = await admin
    .from('batches')
    .select('id, batch_code')
    .ilike('batch_code', `%${batchCode}%`)
    .limit(10)
  if (fuzzyErr) return { ok: false, error: `Could not look up the batch: ${fuzzyErr.message}` }

  if (!fuzzy || fuzzy.length === 0) {
    return {
      ok: false,
      error: `No stored batch matches "${batchCode}". A batch is never created automatically — add it by hand first, then save this row.`,
    }
  }
  if (fuzzy.length === 1) {
    return { ok: true, batch_id: fuzzy[0].id as string, batch_code: fuzzy[0].batch_code as string }
  }
  const candidates = fuzzy.map((b) => b.batch_code as string).join(', ')
  return {
    ok: false,
    error: `The batch code "${batchCode}" is ambiguous — it could be any of: ${candidates}. Pick the exact one and re-apply with that code.`,
  }
}

// ============================================================================
// Writers.
// ============================================================================

/**
 * rc_out writer — validate, resolve the batch (unique existing only), insert, then
 * write an ingestion audit row via write_ingestion_audit (rc_out has no audit
 * trigger). NO cost column exists on rc_out.
 */
const writeRcOut: ApplyWriter = async (row, admin, provenance) => {
  const v = validateRcOutRow(row)
  if (!v.ok || !v.clean) throw new Error(v.error ?? 'Invalid rc_out row.')
  const clean = v.clean

  const resolved = await resolveUniqueBatch(admin, String(clean.batch_code))
  if (!resolved.ok || !resolved.batch_id) throw new Error(resolved.error ?? 'Batch not resolved.')

  const insertPayload = {
    transaction_date: clean.transaction_date as string,
    batch_id: resolved.batch_id,
    destination: clean.destination as string,
    weight_kg: clean.weight_kg as number,
    block_loc: (clean.block_loc as string | null) ?? null,
    production_batch: (clean.production_batch as string | null) ?? resolved.batch_code ?? null,
    remarks: (clean.remarks as string | null) ?? null,
  }

  const { data: inserted, error: insErr } = await admin
    .from('rc_out')
    .insert(insertPayload)
    .select('id')
    .single()
  if (insErr) throw new Error(`Saving the feeding failed: ${insErr.message}`)

  const recordId = inserted.id as string

  // rc_out has no audit trigger → use the service-role ingestion audit writer.
  const { error: auditErr } = await admin.rpc('write_ingestion_audit', {
    p_table_name: 'rc_out',
    p_record_id: recordId,
    p_operation: 'INSERT',
    p_diff: null,
    p_snapshot: insertPayload as unknown as Json,
    p_comment: provenance,
  })
  if (auditErr) throw new Error(`Saved the feeding but the audit log failed: ${auditErr.message}`)

  return { table: 'rc_out', record_id: recordId, snapshot: insertPayload }
}

/**
 * deliveries writer — validate, resolve the batch (unique existing only, never
 * created), attach the provenance via set_audit_comment (deliveries HAS its own
 * audit trigger — mirrors the review-queue path), then insert. cost_basis forced 0
 * (L-008 placeholder — pricing stays email-side).
 */
const writeDeliveries: ApplyWriter = async (row, admin, provenance) => {
  const v = validateDeliveriesRow(row)
  if (!v.ok || !v.clean) throw new Error(v.error ?? 'Invalid delivery row.')
  const clean = v.clean

  // Never auto-create a batch — resolve to a unique existing one.
  const resolved = await resolveUniqueBatch(admin, String(clean.batch_code))
  if (!resolved.ok) throw new Error(resolved.error ?? 'Batch not resolved.')

  const insertPayload = {
    transaction_date: clean.transaction_date as string,
    supplier: clean.supplier as string,
    batch_code: resolved.batch_code ?? (clean.batch_code as string),
    block_loc: (clean.block_loc as string | null) ?? null,
    truck_plate: (clean.truck_plate as string | null) ?? null,
    sacks: (clean.sacks as number | null) ?? null,
    weight_kg: clean.weight_kg as number,
    cost_basis: 0, // L-008 placeholder — pricing is enriched email-side, never here.
    lab_results: (clean.lab_results ?? {}) as Json,
    remarks: (clean.remarks as string | null) ?? null,
  }

  // deliveries has its own audit trigger — attach the provenance comment first
  // (the review-queue pattern), then insert so the trigger picks it up.
  const { error: cmtErr } = await admin.rpc('set_audit_comment', { comment: provenance })
  if (cmtErr) throw new Error(`Could not attach the audit note: ${cmtErr.message}`)

  const { data: inserted, error: insErr } = await admin
    .from('deliveries')
    .insert(insertPayload)
    .select('id')
    .single()
  if (insErr) throw new Error(`Saving the delivery failed: ${insErr.message}`)

  return { table: 'deliveries', record_id: inserted.id as string, snapshot: insertPayload }
}

/** The registry: report_type → its per-row writer. */
export const APPLY_WRITERS: Partial<Record<string, ApplyWriter>> = {
  rc_out: writeRcOut,
  deliveries: writeDeliveries,
}

/** True when a report type has a registered per-row writer. */
export function hasApplyWriter(reportType: string): boolean {
  return Boolean(APPLY_WRITERS[reportType])
}
