'use server'

/**
 * Review Queue — Server Actions
 *
 * These are the LOCKED CONTRACT actions that the frontend /review-queue UI depends on.
 * Do NOT change signatures without coordinating with the frontend agent.
 *
 * Architecture:
 *   uploadForReview  → extract → classify (per-row DB lookup) → persist pending_review
 *   listPending      → SELECT pending_review WHERE status='pending'
 *   getReviewDetail  → SELECT single pending_review + expand rows_json
 *   approveReview    → INSERT/UPDATE deliveries + upsert batches + update pending_review
 *   rejectReview     → UPDATE pending_review status='rejected'
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { RcDeliveriesExtractor } from '@/lib/jarvis/extractors/rc-deliveries'
import { extractorForType } from '@/lib/jarvis/classifier'
import { classifyRow } from '@/lib/jarvis/diff-engine'
import { normalizeBlockLoc } from '@/lib/validation'

// ---------------------------------------------------------------------------
// Locked contract types
// ---------------------------------------------------------------------------

export type ReviewRowClass = 'NEW' | 'VALUE_CHANGED'
// DUPLICATE_NOOP rows are silently filtered out before persistence

export interface ClassifiedRow {
  index: number                              // position in the original extracted set
  class: ReviewRowClass
  payload: Record<string, unknown>           // the row as extracted from xlsx
  existingRow?: Record<string, unknown> | null // present iff class === 'VALUE_CHANGED'
  diff?: Array<{ field: string; emailValue: unknown; dbValue: unknown }> // iff VALUE_CHANGED
  warnings?: string[]
  confidence?: number
}

export interface PendingReviewSummary {
  id: string
  report_type: string
  source_filename: string | null
  received_at: string | null
  extracted_at: string
  status: 'pending' | 'approved' | 'rejected' | 'manual_needed'
  overall_confidence: number | null
  rowCounts: { new: number; changed: number; total: number }
}

export interface PendingReviewDetail extends PendingReviewSummary {
  rows: ClassifiedRow[]
  diagnostic: string[]
}

// ---------------------------------------------------------------------------
// RC DELIVERIES natural key + compare fields (mirrors RcDeliveriesExtractor)
// ---------------------------------------------------------------------------
const RC_DELIVERIES_NATURAL_KEY = ['transaction_date', 'batch_code', 'block_loc', 'weight_kg']
const RC_DELIVERIES_COMPARE     = ['supplier', 'truck_plate', 'sacks', 'cost_basis', 'remarks', 'lab_results']

// ---------------------------------------------------------------------------
// uploadForReview
// ---------------------------------------------------------------------------

export async function uploadForReview(formData: FormData): Promise<{
  pendingReviewId: string
  classifiedCount: number
  newCount: number
  changedCount: number
  noopCount: number
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const file = formData.get('file') as File | null
  const reportType = formData.get('reportType') as string | null

  if (!file) throw new Error('No file provided')
  if (!reportType) throw new Error('No reportType provided')

  // Read file bytes
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Resolve extractor — Phase A: hardcode rc_deliveries; Phase B: use classifyEmail registry
  let extractor = extractorForType(reportType)
  if (!extractor && reportType === 'rc_deliveries') {
    extractor = new RcDeliveriesExtractor()
  }
  if (!extractor) {
    throw new Error(`No extractor registered for report_type: ${reportType}`)
  }

  const fakeMeta = {
    messageId: `manual-upload-${Date.now()}`,
    subject: '',
    sender: '',
    receivedAt: new Date().toISOString(),
    bodyText: '',
  }

  // Extract rows
  const extractedRows = await extractor.extract(buffer, fakeMeta)

  // Classify each row
  const classifiedRows: ClassifiedRow[] = []
  let newCount = 0
  let changedCount = 0
  let noopCount = 0
  const allWarnings: string[] = []

  for (let i = 0; i < extractedRows.length; i++) {
    const extracted = extractedRows[i]
    const { payload, confidence, warnings } = extracted

    // Accumulate warnings for diagnostic
    if (warnings.length > 0) allWarnings.push(...warnings)

    // Determine natural key + compare fields per extractor
    let naturalKeyFields = RC_DELIVERIES_NATURAL_KEY
    let compareFields    = RC_DELIVERIES_COMPARE
    if (extractor.reportType === 'rc_deliveries') {
      naturalKeyFields = RC_DELIVERIES_NATURAL_KEY
      compareFields    = RC_DELIVERIES_COMPARE
    }

    const result = await classifyRow(
      extractor.targetTable(),
      naturalKeyFields,
      compareFields,
      payload as Record<string, unknown>
    )

    if (result.class === 'DUPLICATE_NOOP') {
      noopCount++
      // Do NOT persist — silently skip
      continue
    }

    if (result.class === 'NEW') {
      newCount++
      classifiedRows.push({
        index: i,
        class: 'NEW',
        payload: payload as Record<string, unknown>,
        warnings: warnings.length > 0 ? warnings : undefined,
        confidence,
      })
    } else {
      // VALUE_CHANGED
      changedCount++
      classifiedRows.push({
        index: i,
        class: 'VALUE_CHANGED',
        payload: payload as Record<string, unknown>,
        existingRow: result.existingRow ?? null,
        diff: result.diff,
        warnings: warnings.length > 0 ? warnings : undefined,
        confidence,
      })
    }
  }

  const overallConfidence =
    classifiedRows.length > 0
      ? Math.min(...classifiedRows.map(r => r.confidence ?? 1.0))
      : null

  // Build pending_review entry
  const admin = createAdminClient()
  const now = new Date().toISOString()

  const { data: inserted, error: insertError } = await admin
    .from('pending_review')
    .insert({
      source_email_id:   `manual-upload-${Date.now()}`,
      source_filename:   file.name,
      report_type:       reportType,
      received_at:       now,
      extracted_at:      now,
      rows_json:         classifiedRows as unknown as import('@/types/supabase').Json,
      overall_confidence: overallConfidence,
      diagnostic_json:   {
        totalRows:    extractedRows.length,
        newCount,
        changedCount,
        noopCount,
        warnings:     allWarnings,
      } as unknown as import('@/types/supabase').Json,
      status: 'pending',
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    throw new Error(`Failed to persist pending_review: ${insertError?.message}`)
  }

  revalidatePath('/review-queue')

  return {
    pendingReviewId: inserted.id,
    classifiedCount: classifiedRows.length,
    newCount,
    changedCount,
    noopCount,
  }
}

// ---------------------------------------------------------------------------
// listPending
// ---------------------------------------------------------------------------

export async function listPending(): Promise<PendingReviewSummary[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('pending_review')
    .select('id, report_type, source_filename, received_at, extracted_at, status, overall_confidence, rows_json')
    .eq('status', 'pending')
    .order('received_at', { ascending: false })

  if (error) throw new Error(`listPending failed: ${error.message}`)

  return (data ?? []).map(row => {
    const rows = (row.rows_json as unknown as ClassifiedRow[]) ?? []
    return {
      id:                 row.id,
      report_type:        row.report_type,
      source_filename:    row.source_filename,
      received_at:        row.received_at,
      extracted_at:       row.extracted_at,
      status:             row.status as PendingReviewSummary['status'],
      overall_confidence: row.overall_confidence,
      rowCounts: {
        new:     rows.filter(r => r.class === 'NEW').length,
        changed: rows.filter(r => r.class === 'VALUE_CHANGED').length,
        total:   rows.length,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// getReviewDetail
// ---------------------------------------------------------------------------

export async function getReviewDetail(id: string): Promise<PendingReviewDetail> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('pending_review')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !data) throw new Error(`getReviewDetail failed: ${error?.message ?? 'not found'}`)

  const rows = (data.rows_json as unknown as ClassifiedRow[]) ?? []
  const diagnostic = (() => {
    const d = data.diagnostic_json as Record<string, unknown> | null
    if (!d) return []
    const w = d['warnings']
    return Array.isArray(w) ? w as string[] : []
  })()

  return {
    id:                 data.id,
    report_type:        data.report_type,
    source_filename:    data.source_filename,
    received_at:        data.received_at,
    extracted_at:       data.extracted_at,
    status:             data.status as PendingReviewDetail['status'],
    overall_confidence: data.overall_confidence,
    rowCounts: {
      new:     rows.filter(r => r.class === 'NEW').length,
      changed: rows.filter(r => r.class === 'VALUE_CHANGED').length,
      total:   rows.length,
    },
    rows,
    diagnostic,
  }
}

// ---------------------------------------------------------------------------
// approveReview
// ---------------------------------------------------------------------------

export async function approveReview(input: {
  id: string
  decisions: Record<number, 'email_wins' | 'db_wins' | 'both'>
}): Promise<{
  inserted: number
  updated: number
  skipped: number
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const admin = createAdminClient()

  // Load the pending_review row
  const { data: reviewRow, error: loadError } = await admin
    .from('pending_review')
    .select('*')
    .eq('id', input.id)
    .single()

  if (loadError || !reviewRow) {
    throw new Error(`approveReview: record not found — ${loadError?.message}`)
  }

  const rows = (reviewRow.rows_json as unknown as ClassifiedRow[]) ?? []

  let inserted = 0
  let updated  = 0
  let skipped  = 0

  for (const classifiedRow of rows) {
    const decision = input.decisions[classifiedRow.index] ?? 'email_wins'

    if (classifiedRow.class === 'NEW') {
      // Always insert NEW rows
      await insertDelivery(admin, classifiedRow.payload, user.id)
      inserted++
    } else if (classifiedRow.class === 'VALUE_CHANGED') {
      if (decision === 'db_wins') {
        skipped++
      } else if (decision === 'email_wins') {
        await updateDelivery(admin, classifiedRow, user.id)
        updated++
      } else if (decision === 'both') {
        // Split-shipment: insert email values as a new row alongside the existing one.
        // The natural-key uniqueness is intentionally violated here — this is legitimate.
        await insertDelivery(admin, classifiedRow.payload, user.id)
        inserted++
      }
    }
  }

  // Update pending_review status
  const { error: updateError } = await admin
    .from('pending_review')
    .update({
      status:          'approved',
      reviewed_at:     new Date().toISOString(),
      reviewed_by:     user.id,
      final_rows_json: rows as unknown as import('@/types/supabase').Json,
    })
    .eq('id', input.id)

  if (updateError) {
    console.error('approveReview: failed to update pending_review status', updateError)
    // Non-fatal — data was already written to deliveries
  }

  revalidatePath('/review-queue')
  revalidatePath('/inventory/rc-in')
  revalidatePath('/inventory')

  return { inserted, updated, skipped }
}

// ---------------------------------------------------------------------------
// rejectReview
// ---------------------------------------------------------------------------

export async function rejectReview(input: {
  id: string
  reason?: string
}): Promise<{ ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const admin = createAdminClient()

  // Load existing diagnostic_json to preserve existing notes
  const { data: existing } = await admin
    .from('pending_review')
    .select('diagnostic_json')
    .eq('id', input.id)
    .single()

  const existingDiag = (existing?.diagnostic_json as Record<string, unknown>) ?? {}

  const { error } = await admin
    .from('pending_review')
    .update({
      status:      'rejected',
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id,
      diagnostic_json: {
        ...existingDiag,
        rejection_reason: input.reason ?? null,
      } as unknown as import('@/types/supabase').Json,
    })
    .eq('id', input.id)

  if (error) throw new Error(`rejectReview failed: ${error.message}`)

  revalidatePath('/review-queue')

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Private helpers — delivery writes + batch upsert
// ---------------------------------------------------------------------------

/** Normalize a delivery payload for insertion into deliveries. */
function toDeliveryInsert(payload: Record<string, unknown>) {
  const blockLoc = payload.block_loc
    ? normalizeBlockLoc(String(payload.block_loc))
    : null

  return {
    transaction_date: payload.transaction_date as string,
    supplier:         String(payload.supplier ?? ''),
    batch_code:       payload.batch_code ? String(payload.batch_code) : null,
    block_loc:        blockLoc,
    truck_plate:      payload.truck_plate ? String(payload.truck_plate) : null,
    sacks:            payload.sacks != null ? Number(payload.sacks) : null,
    weight_kg:        Number(payload.weight_kg ?? 0),
    cost_basis:       Number(payload.cost_basis ?? 0),
    remarks:          payload.remarks ? String(payload.remarks) : null,
    lab_results:      (payload.lab_results ?? {}) as import('@/types/supabase').Json,
  }
}

/**
 * Upsert a batch entry from a delivery payload.
 * Mirrors the upsertBatchesFromRows() pattern in rc-in/actions.ts.
 */
async function upsertBatch(
  admin: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>
): Promise<void> {
  const batchCode = payload.batch_code ? String(payload.batch_code) : null
  if (!batchCode) return

  const blockLoc = payload.block_loc
    ? normalizeBlockLoc(String(payload.block_loc))
    : ''

  const { error } = await admin
    .from('batches')
    .upsert(
      { batch_code: batchCode, location_ref: blockLoc },
      { onConflict: 'batch_code' }
    )

  if (error) {
    console.error(`approveReview: batch upsert failed for ${batchCode}:`, error)
    // Non-fatal — delivery insert will fail if FK is missing, which surfaces clearly
  }
}

/**
 * Insert a new delivery row.
 * Also upserts the corresponding batch entry.
 * Logs to audit_logs via the DB trigger (fn_update_blackwood_state + audit trigger).
 */
async function insertDelivery(
  admin: ReturnType<typeof createAdminClient>,
  payload: Record<string, unknown>,
  userId: string
): Promise<void> {
  // Upsert batch first (FK requirement)
  await upsertBatch(admin, payload)

  // Set audit comment to identify this as an AI ingestion insert
  // We use the same set_audit_comment RPC pattern the app uses for bulk edits.
  // Note: service-role client does not carry session context, so we call rpc directly.
  await admin.rpc('set_audit_comment', { comment: `AI ingestion — approved by ${userId}` })

  const deliveryPayload = toDeliveryInsert(payload)

  const { error } = await admin
    .from('deliveries')
    .insert(deliveryPayload)

  if (error) {
    throw new Error(`insertDelivery failed: ${error.message}`)
  }
}

/**
 * Update an existing delivery row to email values.
 * Looks up the existing row via natural key to get its id.
 */
async function updateDelivery(
  admin: ReturnType<typeof createAdminClient>,
  classifiedRow: ClassifiedRow,
  userId: string
): Promise<void> {
  const { payload, existingRow } = classifiedRow

  if (!existingRow) {
    throw new Error('updateDelivery called with no existingRow')
  }

  const existingId = existingRow['id'] as string | undefined
  if (!existingId) {
    throw new Error('updateDelivery: existingRow has no id')
  }

  await upsertBatch(admin, payload)

  await admin.rpc('set_audit_comment', { comment: `AI ingestion update — approved by ${userId}` })

  const deliveryPayload = toDeliveryInsert(payload)

  const { error } = await admin
    .from('deliveries')
    .update(deliveryPayload)
    .eq('id', existingId)

  if (error) {
    throw new Error(`updateDelivery failed for id=${existingId}: ${error.message}`)
  }
}
