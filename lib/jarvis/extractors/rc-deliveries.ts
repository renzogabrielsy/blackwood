/**
 * RcDeliveriesExtractor — Phase A implementation.
 *
 * Handles: "RC DELIVERIES" emails from pretchel.jao@yahoo.com / Ivy / any sender.
 * Target table: deliveries (+ batches upsert on approval).
 *
 * Column order matches CLAUDE.md RC IN Column Config:
 *   Date / Supplier / Batch Code / Block-Loc / Truck Plate / Sacks /
 *   Weight / MC / Grit / VM / Ash / FC / BD ASTM / BD JIS / PHP/KG / PHP Total / Remarks
 *
 * See AI_INGESTION_AGENT.md §4 for the full extraction design.
 */

import * as XLSX from 'xlsx'
import type { EmailMeta, ExtractedRow, ReportExtractor } from './types'

// Canonical block_loc pattern — kept in sync with lib/validation.ts
const BLOCK_LOC_RE = /^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$/i

// Lab plausibility ranges (flag but don't reject)
const LAB_RANGES = {
  mc:       { min: 0,  max: 20,  label: 'MC' },
  ash:      { min: 0,  max: 10,  label: 'Ash' },
  bd_astm:  { min: 0,  max: 10,  label: 'BD ASTM' },
  bd_jis:   { min: 0,  max: 10,  label: 'BD JIS' },
  grit:     { min: 0,  max: 50,  label: 'Grit' },
  vm:       { min: 0,  max: 30,  label: 'VM' },
  fc:       { min: 50, max: 100, label: 'FC' },
}

// Header synonyms — maps canonical snake_case field name to possible header strings.
// Keys are tried with case-insensitive matching after stripping whitespace.
const HEADER_MAP: Record<string, string[]> = {
  transaction_date: ['DATE', 'TRANSACTION DATE', 'DELIVERY DATE', 'TXN DATE'],
  supplier:         ['SUPPLIER', 'SUPPLIER NAME', 'SOURCE'],
  batch_code:       ['BATCH CODE', 'BATCH', 'BATCH#', 'BATCH NO', 'BATCHCODE'],
  block_loc:        ['BLOCK LOC', 'BLOCK-LOC', 'BLOCK/LOC', 'BLOCK', 'LOCATION', 'LOC'],
  truck_plate:      ['TRUCK PLATE', 'TRUCK', 'PLATE', 'PLATE NO', 'PLATE NUMBER', 'VEHICLE'],
  sacks:            ['SACKS', 'BAGS', 'NO OF SACKS', 'NO. OF SACKS'],
  weight_kg:        ['WEIGHT', 'WEIGHT KG', 'WEIGHT (KG)', 'KGS', 'KG', 'TOTAL KG', 'NET KG'],
  mc:               ['MC', 'MOISTURE', 'MOISTURE CONTENT', 'M.C.'],
  grit:             ['GRIT', 'GRIT %', 'GRIT%'],
  vm:               ['VM', 'VOLATILE', 'VOLATILE MATTER', 'V.M.', 'VM%'],
  ash:              ['ASH', 'ASH %', 'ASH%', 'ASH CONTENT'],
  fc:               ['FC', 'FIXED CARBON', 'F.C.', 'FC%'],
  bd_astm:          ['BD ASTM', 'BD-ASTM', 'BDASTM', 'BD(ASTM)', 'ASTM BD'],
  bd_jis:           ['BD JIS', 'BD-JIS', 'BDJIS', 'BD(JIS)', 'JIS BD'],
  cost_basis:       ['PHP/KG', 'PHP KG', 'PRICE', 'COST', 'UNIT PRICE', 'PHP PER KG', '₱/KG'],
  // php_total is computed, not persisted — we read it only for cross-validation
  php_total:        ['PHP TOTAL', 'TOTAL PHP', 'AMOUNT', 'TOTAL AMOUNT'],
  remarks:          ['REMARKS', 'REMARK', 'NOTES', 'NOTE', 'COMMENT'],
}

function normalizeHeader(s: unknown): string {
  return String(s ?? '').trim().toUpperCase()
}

/** Map column letter/index to field name by matching against HEADER_MAP. */
function buildColumnMapping(
  headerRow: unknown[]
): Record<string, number> {
  const mapping: Record<string, number> = {}

  for (let col = 0; col < headerRow.length; col++) {
    const h = normalizeHeader(headerRow[col])
    if (!h) continue

    for (const [field, synonyms] of Object.entries(HEADER_MAP)) {
      if (mapping[field] !== undefined) continue // already found
      if (synonyms.some(s => s.toUpperCase() === h)) {
        mapping[field] = col
      }
    }
  }

  return mapping
}

/** Safely read a cell value, returning undefined instead of throwing. */
function safeCell(row: unknown[], colIndex: number | undefined): unknown {
  if (colIndex === undefined) return undefined
  try {
    return row[colIndex]
  } catch {
    return undefined
  }
}

/** Parse a date value from xlsx — can be a JS Date, number (serial), or string. */
function parseDate(raw: unknown): string | null {
  if (raw == null) return null
  try {
    if (raw instanceof Date) {
      return raw.toISOString().split('T')[0]
    }
    if (typeof raw === 'number') {
      // Excel date serial — xlsx with cellDates:true should already have converted,
      // but handle the rare passthrough case.
      const date = XLSX.SSF.parse_date_code(raw)
      if (date) {
        const y = date.y
        const m = String(date.m).padStart(2, '0')
        const d = String(date.d).padStart(2, '0')
        return `${y}-${m}-${d}`
      }
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (!trimmed) return null
      // Accept YYYY-MM-DD directly
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
      // Try Date constructor
      const d = new Date(trimmed)
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]
    }
  } catch {
    // fall through
  }
  return null
}

/** Parse a numeric value from a cell; returns null if not parseable. */
function parseNumber(raw: unknown): number | null {
  if (raw == null) return null
  try {
    if (typeof raw === 'number') return isNaN(raw) ? null : raw
    if (typeof raw === 'string') {
      const cleaned = raw.trim().replace(/,/g, '')
      if (!cleaned) return null
      const n = parseFloat(cleaned)
      return isNaN(n) ? null : n
    }
  } catch {
    // fall through
  }
  return null
}

/** Parse an integer. Returns null if not parseable. */
function parseInt2(raw: unknown): number | null {
  const n = parseNumber(raw)
  if (n === null) return null
  return Math.round(n)
}

/** Parse a string cell. Returns null if empty/blank. */
function parseString(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  return s || null
}

/** Validate and parse a lab_results object from individual column values. */
function buildLabResults(
  row: unknown[],
  mapping: Record<string, number>
): {
  mc: number | null
  ash: number | null
  bd_astm: number | null
  bd_jis: number | null
  grit: number | null
  vm: number | null
  fc: number | null
} {
  return {
    mc:      parseNumber(safeCell(row, mapping.mc)),
    ash:     parseNumber(safeCell(row, mapping.ash)),
    bd_astm: parseNumber(safeCell(row, mapping.bd_astm)),
    bd_jis:  parseNumber(safeCell(row, mapping.bd_jis)),
    grit:    parseNumber(safeCell(row, mapping.grit)),
    vm:      parseNumber(safeCell(row, mapping.vm)),
    fc:      parseNumber(safeCell(row, mapping.fc)),
  }
}

/** Check whether a row is entirely blank (skip these). */
function isBlankRow(row: unknown[]): boolean {
  return row.every(cell => cell == null || String(cell).trim() === '')
}

export class RcDeliveriesExtractor implements ReportExtractor {
  readonly reportType = 'rc_deliveries'

  /**
   * Returns true for emails whose subject matches /^RC DELIVERIES/i.
   * Sender constraint is loose — Pretchel and Ivy both send from different addresses.
   */
  matches(meta: EmailMeta): boolean {
    return /^RC DELIVERIES/i.test(meta.subject.trim())
  }

  targetTable(): string {
    return 'deliveries'
  }

  /**
   * Natural key for duplicate detection against the deliveries table:
   *   (transaction_date, batch_code, block_loc, weight_kg)
   */
  static readonly NATURAL_KEY_FIELDS = ['transaction_date', 'batch_code', 'block_loc', 'weight_kg'] as const

  /**
   * Fields compared for VALUE_CHANGED detection (everything except natural key + audit fields).
   */
  static readonly COMPARE_FIELDS = ['supplier', 'truck_plate', 'sacks', 'cost_basis', 'remarks', 'lab_results'] as const

  async extract(attachmentBytes: Buffer, _meta: EmailMeta): Promise<ExtractedRow[]> {
    const rows: ExtractedRow[] = []

    let wb: XLSX.WorkBook
    try {
      wb = XLSX.read(attachmentBytes, { type: 'buffer', cellDates: true })
    } catch (err) {
      return [{
        payload: {},
        confidence: 0,
        warnings: [`Failed to open XLSX: ${err instanceof Error ? err.message : String(err)}`],
      }]
    }

    // Use first sheet — RC DELIVERIES always has one relevant sheet
    const sheetName = wb.SheetNames[0]
    if (!sheetName) {
      return [{
        payload: {},
        confidence: 0,
        warnings: ['XLSX has no sheets'],
      }]
    }

    const ws = wb.Sheets[sheetName]
    // Convert to array-of-arrays with header row preserved
    const rawData: unknown[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,         // return arrays, not objects
      defval: null,
      blankrows: false,
    }) as unknown[][]

    if (rawData.length === 0) {
      return [{
        payload: {},
        confidence: 0,
        warnings: ['Sheet is empty'],
      }]
    }

    // --- Find the header row ---
    // Scan rows until we find one that contains 'DATE' or 'BATCH' or 'WEIGHT'
    let headerRowIdx = -1
    for (let i = 0; i < Math.min(rawData.length, 20); i++) {
      const normalized = rawData[i].map(normalizeHeader)
      if (
        normalized.some(h => h === 'DATE' || h === 'TRANSACTION DATE' || h === 'DELIVERY DATE') ||
        normalized.some(h => h === 'BATCH CODE' || h === 'BATCH') ||
        normalized.some(h => h === 'WEIGHT' || h === 'WEIGHT KG' || h === 'WEIGHT (KG)')
      ) {
        headerRowIdx = i
        break
      }
    }

    if (headerRowIdx === -1) {
      return [{
        payload: {},
        confidence: 0,
        warnings: ['Could not locate header row (looked for DATE/BATCH/WEIGHT in first 20 rows)'],
      }]
    }

    const mapping = buildColumnMapping(rawData[headerRowIdx])

    // Require at minimum: date, batch_code, weight_kg
    const missingRequired: string[] = []
    if (mapping.transaction_date === undefined) missingRequired.push('DATE')
    if (mapping.batch_code === undefined) missingRequired.push('BATCH CODE')
    if (mapping.weight_kg === undefined) missingRequired.push('WEIGHT')

    if (missingRequired.length > 0) {
      return [{
        payload: {},
        confidence: 0,
        warnings: [`Missing required columns: ${missingRequired.join(', ')}`],
      }]
    }

    // --- Parse data rows ---
    for (let i = headerRowIdx + 1; i < rawData.length; i++) {
      const row = rawData[i]

      // Skip entirely blank rows
      if (isBlankRow(row)) continue

      const warnings: string[] = []
      let confidence = 1.0

      // transaction_date
      let transaction_date: string | null = null
      try {
        transaction_date = parseDate(safeCell(row, mapping.transaction_date))
      } catch (err) {
        warnings.push(`Row ${i + 1}: date parse error — ${err}`)
      }

      if (!transaction_date) {
        // If there is no date at all, skip the row (likely a summary/total row)
        continue
      }

      // supplier
      const supplier = parseString(safeCell(row, mapping.supplier)) ?? ''
      if (!supplier) {
        warnings.push(`Row ${i + 1}: missing supplier`)
        confidence -= 0.15
      }

      // batch_code
      const batch_code = parseString(safeCell(row, mapping.batch_code))
      if (!batch_code) {
        warnings.push(`Row ${i + 1}: missing batch_code`)
        confidence -= 0.15
      }

      // block_loc
      let block_loc: string | null = null
      try {
        const rawLoc = parseString(safeCell(row, mapping.block_loc))
        if (rawLoc) {
          const normalized = rawLoc.trim().toUpperCase()
          if (!BLOCK_LOC_RE.test(normalized)) {
            warnings.push(`Row ${i + 1}: invalid block_loc "${rawLoc}" — expected format A-1A, PCA-15B, etc.`)
            confidence -= 0.15
          } else {
            block_loc = normalized
          }
        }
      } catch (err) {
        warnings.push(`Row ${i + 1}: block_loc parse error — ${err}`)
      }

      // weight_kg
      let weight_kg: number | null = null
      try {
        weight_kg = parseNumber(safeCell(row, mapping.weight_kg))
        if (weight_kg === null) {
          warnings.push(`Row ${i + 1}: missing weight_kg`)
          confidence -= 0.15
        } else if (weight_kg <= 0 || weight_kg >= 100000) {
          warnings.push(`Row ${i + 1}: implausible weight_kg ${weight_kg} (expected 0–100,000)`)
          confidence -= 0.15
        }
      } catch (err) {
        warnings.push(`Row ${i + 1}: weight_kg parse error — ${err}`)
      }

      // cost_basis
      let cost_basis: number = 0
      try {
        const raw = parseNumber(safeCell(row, mapping.cost_basis))
        if (raw !== null) {
          if (raw < 0 || raw > 1000) {
            warnings.push(`Row ${i + 1}: implausible cost_basis ${raw} PHP/kg (expected 0–1000)`)
            confidence -= 0.10
          }
          cost_basis = raw
        }
      } catch {
        // cost_basis is optional — no penalty
      }

      // sacks
      let sacks: number | null = null
      try {
        sacks = parseInt2(safeCell(row, mapping.sacks))
      } catch {
        // optional
      }

      // truck_plate
      const truck_plate = parseString(safeCell(row, mapping.truck_plate)) ?? null

      // remarks
      const remarks = parseString(safeCell(row, mapping.remarks)) ?? null

      // lab_results
      let lab_results: Record<string, number | null> = {
        mc: null, ash: null, bd_astm: null, bd_jis: null, grit: null, vm: null, fc: null,
      }
      try {
        lab_results = buildLabResults(row, mapping)
      } catch (err) {
        warnings.push(`Row ${i + 1}: lab_results parse error — ${err}`)
      }

      // Lab plausibility checks
      for (const [key, range] of Object.entries(LAB_RANGES)) {
        const val = lab_results[key as keyof typeof lab_results]
        if (val !== null && (val < range.min || val > range.max)) {
          warnings.push(`Row ${i + 1}: ${range.label}=${val} outside plausible range [${range.min}, ${range.max}]`)
          confidence -= 0.10
        }
      }

      confidence = Math.max(0, confidence)

      rows.push({
        payload: {
          transaction_date,
          supplier,
          batch_code,
          block_loc,
          truck_plate,
          sacks,
          weight_kg,
          cost_basis,
          remarks,
          lab_results,
        },
        confidence,
        warnings,
      })
    }

    return rows
  }
}
