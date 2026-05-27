/**
 * Diff Engine — classifies an extracted row against the live deliveries table.
 *
 * Three outcomes:
 *   NEW             — natural key not found in target table
 *   DUPLICATE_NOOP  — natural key exists, all compare fields match
 *   VALUE_CHANGED   — natural key exists, ≥1 compare field differs
 *
 * This module performs live Supabase queries (service-role client) and must
 * only be called from server actions or server-side code.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type RowClass = 'NEW' | 'DUPLICATE_NOOP' | 'VALUE_CHANGED'

export interface DiffEntry {
  field: string
  emailValue: unknown
  dbValue: unknown
}

export interface ClassificationResult {
  class: RowClass
  existingRow?: Record<string, unknown> | null
  diff?: DiffEntry[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a value for comparison: trim strings, convert dates to ISO, etc. */
function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim()
  if (v instanceof Date) return v.toISOString().split('T')[0]
  return v
}

/**
 * Deep-equality check for two field values.
 * Handles JSONB (lab_results), numbers, strings, nulls.
 */
function valuesAreEqual(a: unknown, b: unknown): boolean {
  const na = normalizeValue(a)
  const nb = normalizeValue(b)

  if (na === null && nb === null) return true
  if (na === null || nb === null) return false

  // Coerce numbers from string (XLSX sometimes returns "12.5" vs DB number 12.5)
  const numA = typeof na === 'string' ? parseFloat(na as string) : na
  const numB = typeof nb === 'string' ? parseFloat(nb as string) : nb
  if (typeof numA === 'number' && !isNaN(numA) && typeof numB === 'number' && !isNaN(numB)) {
    // Compare with tolerance for floating-point
    return Math.abs(numA - numB) < 0.0001
  }

  // Object / JSONB deep comparison
  if (typeof na === 'object' && typeof nb === 'object') {
    return JSON.stringify(na) === JSON.stringify(nb)
  }

  return na === nb
}

/**
 * Resolve both camelCase and snake_case variants of a key from a row object.
 * XLSX-extracted rows use camelCase sometimes; DB rows use snake_case.
 */
function resolveField(row: Record<string, unknown>, field: string): unknown {
  if (field in row) return row[field]

  // camelCase → snake_case conversion
  const snake = field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
  if (snake in row) return row[snake]

  // snake_case → camelCase conversion
  const camel = field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
  if (camel in row) return row[camel]

  return undefined
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Classify a single extracted row against a live Supabase table.
 *
 * @param targetTable      e.g. 'deliveries'
 * @param naturalKeyFields e.g. ['transaction_date','batch_code','block_loc','weight_kg']
 * @param compareFields    e.g. ['supplier','truck_plate','sacks','cost_basis','remarks','lab_results']
 * @param row              The extracted row (payload from ExtractedRow)
 */
export async function classifyRow(
  targetTable: string,
  naturalKeyFields: string[],
  compareFields: string[],
  row: Record<string, unknown>
): Promise<ClassificationResult> {
  const admin = createAdminClient()

  // Build the natural-key WHERE filter.
  // Cast targetTable to 'any' — classifyRow is intentionally generic across tables,
  // so the typed literal union constraint on .from() must be bypassed here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (admin as any).from(targetTable).select('*')

  for (const field of naturalKeyFields) {
    const value = resolveField(row, field)
    if (value === null || value === undefined) {
      // If a natural key field is null, we can't do a reliable lookup.
      // Treat as NEW — missing key fields are flagged as warnings during extraction.
      return { class: 'NEW' }
    }
    // Supabase JS chained .eq() calls are AND-joined
    query = query.eq(field, value as string | number | boolean)
  }

  const { data, error } = await query

  if (error) {
    console.error(`[diff-engine] DB lookup error on ${targetTable}:`, error)
    // Treat as NEW rather than throwing — caller will surface via warnings
    return { class: 'NEW' }
  }

  if (!data || data.length === 0) {
    return { class: 'NEW' }
  }

  if (data.length > 1) {
    // Data integrity issue — multiple rows match the natural key.
    // Log and treat as VALUE_CHANGED against the first row.
    console.warn(
      `[diff-engine] ${data.length} rows match natural key in ${targetTable}. ` +
      `Fields: ${naturalKeyFields.map(f => `${f}=${resolveField(row, f)}`).join(', ')}. ` +
      `Using first row.`
    )
  }

  const dbRow = data[0] as Record<string, unknown>
  const diff: DiffEntry[] = []

  for (const field of compareFields) {
    const emailValue = resolveField(row, field)
    const dbValue = resolveField(dbRow, field)

    if (!valuesAreEqual(emailValue, dbValue)) {
      diff.push({ field, emailValue, dbValue })
    }
  }

  if (diff.length === 0) {
    return { class: 'DUPLICATE_NOOP', existingRow: dbRow }
  }

  return { class: 'VALUE_CHANGED', existingRow: dbRow, diff }
}
