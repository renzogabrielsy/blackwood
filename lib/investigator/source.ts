/**
 * source.ts — the `read_run_source` tool: read THIS run's fetched source workbooks
 * from the private `sync-inbox` Storage bucket, so the investigator can compare the
 * ACTUAL source numbers (like the reconcile does), not just what landed in the DB.
 *
 * Storage layout (written by the Mail Clerk, workers/sync/src/workflows/mailClerk.ts):
 *   sync-inbox/<runId>/<key>/<filename>.xlsx
 * where key ∈ SOURCE_KEYS below — one latest xlsx per key per run.
 *
 * The reader is a GENERIC grid dump — no per-report column semantics. It returns the
 * raw sheet as an array-of-arrays so the model reads the grid itself (cells stringified,
 * dates → ISO, trailing empty columns trimmed, bounded rows/cols). The bucket is
 * PRIVATE + service-role only, so all access goes through createAdminClient()'s storage.
 *
 * The SERIALIZATION is factored PURE (buildGridPayload) so the cap/trim logic is unit
 * testable without network or a real workbook.
 *
 * DATE HANDLING (timezone-proof — see L-035). We parse with `cellDates: false` (keep the
 * raw Excel serials) and convert a numeric cell the workbook marks as a date to ISO
 * yyyy-MM-dd with PURE integer arithmetic (`excelSerialToISO`). We deliberately do NOT let
 * SheetJS build JS Dates: with `cellDates:true` those Dates are constructed at LOCAL
 * midnight, and `toISOString()` on a UTC+8 machine (Renzo's, and any PH-hosted runtime)
 * crosses back over midnight UTC — shifting EVERY date one day early. Integer math has no
 * Date object, no timezone, no DST, so it renders the same date everywhere.
 *
 * A "date cell" is detected TWO ways, because the real RAW CHARCOAL MOVEMENT workbook is
 * inconsistent: its DATE-column cells carry NO date number-format (`.z` is undefined) —
 * only a date-looking cached text like `.w="29-May-26"`. So a cell is a date when its `.z`
 * is a date format OR its `.w` looks like a date; either way we convert the RAW SERIAL
 * (not the truncated `.w`, which may lack the year). Gating on `.z` alone would dump the
 * bare serial `46171`, which is WORSE than a one-day-shifted date — the model can't read it.
 *
 * SAFETY NET (the dual hint): a plain number with NO date signal but whose integer lands in
 * the plausible modern date-serial band (2020-01-01..2030-12-31 ≈ 43831..47848) is rendered
 * as `46171 (date? 2026-05-29)` — it could be a date column that lost BOTH its format and a
 * date-looking `.w`, OR a genuine number (a 46,171 kg weight) that happens to land there.
 * Emitting both lets the investigator disambiguate from column context. Deterministic + cheap.
 */
import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'

/** The 7 per-run source keys (Mail Clerk storage sub-keys). */
export const SOURCE_KEYS = [
  'deliveries',
  'deliveries_czarina',
  'rc_out',
  'rc_out_movement',
  'production_mc',
  'production_waste',
  'flecon',
] as const
export type SourceKey = (typeof SOURCE_KEYS)[number]

export const SYNC_INBOX_BUCKET = 'sync-inbox'

/** Hard caps — keep the serialized payload small and the model focused. */
const MAX_ROWS_HARD = 300
const DEFAULT_MAX_ROWS = 100
const MAX_COLS = 30
const MAX_PAYLOAD_BYTES = 40_000

/**
 * PURE: convert a civil day-count (days since 1970-01-01, UTC-agnostic) to [y, m, d].
 * Howard Hinnant's `civil_from_days` — exact integer algorithm, no Date, no timezone,
 * no rounding (only `Math.floor`, which is exact integer division). Valid for any day.
 */
function civilFromDays(z: number): [number, number, number] {
  z += 719468
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097)
  const doe = z - era * 146097 // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365) // [0, 399]
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)) // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153) // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1 // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9 // [1, 12]
  return [m <= 2 ? y + 1 : y, m, d]
}

/**
 * The plausible Excel serial range we treat as a real date. 40000 ≈ 2009-07, 60000 ≈
 * 2064 — comfortably wraps all plant data (2009→). A "date-formatted" cell whose serial
 * falls outside this range is almost certainly not a genuine date, so we fall back to the
 * cell's own formatted text rather than emit a nonsense year.
 */
const EXCEL_SERIAL_MIN = 40000
const EXCEL_SERIAL_MAX = 60000

/**
 * PURE, EXPORTED (for the regression checks): Excel 1900-system serial → ISO yyyy-MM-dd.
 *
 * TIMEZONE-PROOF: no JS `Date`, so no local-midnight / toISOString UTC crossover (the bug
 * this replaces). The anchor `serial 25569 == 1970-01-01` already bakes in Excel's phantom
 * 1900-02-29 leap-day offset for every serial in the modern range, so `serial − 25569` is
 * the exact unix-epoch day count, which `civilFromDays` turns into y/m/d.
 *
 * Returns null when `serial` is not a finite number in the plausible date range — the
 * caller then falls back to the cell's `.w` formatted text.
 */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial)) return null
  const n = Math.trunc(serial) // drop any time-of-day fraction; integer days only
  if (n < EXCEL_SERIAL_MIN || n > EXCEL_SERIAL_MAX) return null
  const [y, m, d] = civilFromDays(n - 25569)
  return (
    `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  )
}

/**
 * The plausible MODERN date-serial band, used ONLY for the dual-hint safety net (a number
 * with no date signal at all). 43831 == 2020-01-01, 47848 == 2030-12-31 — tight enough that
 * a genuine number rarely collides, wide enough to catch any plant date going forward. A
 * value in this band could be a date column that lost both its format AND a date-looking
 * `.w`, so we surface the date reading alongside the raw number for the model to judge.
 */
const PLAUSIBLE_DATE_SERIAL_MIN = 43831 // 2020-01-01
const PLAUSIBLE_DATE_SERIAL_MAX = 47848 // 2030-12-31

/**
 * PURE, EXPORTED (for the regression checks): the dual-hint classifier — is this value a
 * whole number sitting in the plausible modern date-serial band? Only integers qualify (a
 * whole-day date serial has no time fraction; a fractional number is far likelier a weight).
 */
export function isPlausibleDateSerial(v: number): boolean {
  return Number.isInteger(v) && v >= PLAUSIBLE_DATE_SERIAL_MIN && v <= PLAUSIBLE_DATE_SERIAL_MAX
}

/** Match a 3-letter English month name as a whole word (case-insensitive). */
const MONTH_WORD_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i

/**
 * PURE, EXPORTED (for the regression checks): does a cell's cached display text (`.w`) look
 * like a DATE? True for an ISO `yyyy-mm-dd` OR any text carrying a month name plus a digit
 * (e.g. "29-May-26", "29-May", "Jan-26", "May 29"). This is the SECOND date signal — the
 * movement workbook's date cells have NO date number-format, only a date-looking `.w`.
 */
export function looksLikeDateText(w: unknown): boolean {
  if (typeof w !== 'string') return false
  const s = w.trim()
  if (s === '') return false
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true // ISO date
  return MONTH_WORD_RE.test(s) && /\d/.test(s) // "29-May-26", "Jan-26", "May 29"
}

/**
 * PURE, EXPORTED (for the regression checks): render ONE parsed cell (as walked from the
 * worksheet with `cellDates:false`) to its grid string.
 *   - date-signalled numeric cell → ISO via `excelSerialToISO`, else the cell's `.w` text;
 *   - plain number in the plausible date band (no signal) → dual hint "N (date? ISO)";
 *   - any other number → its number text (unchanged);
 *   - text / boolean → String() (unchanged);
 *   - null/undefined/empty → ''.
 * `isDateFmt` says whether the caller judged this a date cell (date `.z` OR date-looking `.w`);
 * `w` is the cell's pre-formatted display text (the fallback when the serial can't convert).
 */
export function renderCell(
  v: unknown,
  opts?: { isDateFmt?: boolean; w?: string | null },
): string {
  if (v == null) return ''
  if (typeof v === 'number') {
    // 1. The workbook marks this a date (date `.z` OR a date-looking `.w`): convert the RAW
    //    serial → ISO, timezone-proof. Fall back to `.w` only if the serial is out of range.
    if (opts?.isDateFmt) {
      const iso = excelSerialToISO(v)
      if (iso) return iso
      if (opts.w != null && opts.w !== '') return opts.w
      return String(v)
    }
    // 2. No date signal, but the integer lands in the plausible modern date-serial band:
    //    emit the number AND a date reading so the model can disambiguate from the column.
    if (isPlausibleDateSerial(v)) {
      const iso = excelSerialToISO(v)
      if (iso) return `${v} (date? ${iso})`
    }
    // 3. A genuine non-date number.
    return String(v)
  }
  // Defensive: if a Date slips through (should not with cellDates:false), render it from
  // LOCAL components — never toISOString — so it is not shifted a day on UTC+8.
  if (v instanceof Date) {
    const t = v.getTime()
    if (Number.isNaN(t)) return ''
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  return String(v)
}

/**
 * PURE: is this number-format string a DATE format? Guards `SSF.is_date` (throws on
 * undefined/non-string). A cell with a date `z` (e.g. "dd-mmm-yy", "mmm-yy") is a date;
 * a numeric/general format (e.g. "#,##0", "0.00", "General", undefined) is not.
 */
function isDateFormat(z: unknown): boolean {
  if (typeof z !== 'string' || z === '') return false
  try {
    return XLSX.SSF.is_date(z)
  } catch {
    return false
  }
}

/**
 * PURE: turn a worksheet (parsed with `cellDates:false`) into the raw grid the serializer
 * consumes — an array-of-arrays where each cell is ALREADY its final string. Date cells
 * (date `.z` OR date-looking `.w`) become ISO via `renderCell`; a bare number in the date
 * band gets a dual hint; every other cell passes through unchanged. Mirrors
 * `sheet_to_json(header:1, defval:null, blankrows:true)`'s bounds so paging is identical,
 * but we walk cells directly to reach `.z`/`.w` (which `sheet_to_json` discards).
 */
export function sheetToGrid(ws: XLSX.WorkSheet): string[][] {
  const ref = ws['!ref']
  if (!ref) return []
  const range = XLSX.utils.decode_range(ref)
  const grid: string[][] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = ws[addr] as XLSX.CellObject | undefined
      if (!cell || cell.v == null) {
        row.push('')
        continue
      }
      // A numeric cell is a DATE when it carries a date number-format (.z) OR a date-looking
      // cached text (.w) — the movement workbook's date cells have only the latter.
      const dateSignal = cell.t === 'n' && (isDateFormat(cell.z) || looksLikeDateText(cell.w))
      row.push(renderCell(cell.v, { isDateFmt: dateSignal, w: cell.w ?? null }))
    }
    grid.push(row)
  }
  return grid
}

/** Stringify one already-rendered cell for the payload: null/undefined → ''; else String(). */
function cellToString(v: unknown): string {
  if (v == null) return ''
  return renderCell(v)
}

/** Trim trailing all-empty columns from a grid (after per-row MAX_COLS clamp). */
function trimTrailingEmptyCols(grid: string[][]): string[][] {
  let maxUsed = 0
  for (const row of grid) {
    for (let c = row.length - 1; c >= 0; c--) {
      if (row[c] !== '') {
        if (c + 1 > maxUsed) maxUsed = c + 1
        break
      }
    }
  }
  return grid.map((row) => row.slice(0, maxUsed))
}

export interface GridPayload {
  file: string
  sheets: string[]
  sheet: string
  total_rows: number
  start_row: number
  rows: string[][]
  truncated?: boolean
  note?: string
}

/**
 * PURE: turn a raw array-of-arrays sheet into the bounded, stringified grid payload.
 *
 * - Slices `[start_row-1, start_row-1 + max_rows)` (start_row is 1-based, human-facing).
 * - Stringifies every cell; clamps to MAX_COLS; trims trailing empty columns.
 * - If the JSON payload exceeds ~MAX_PAYLOAD_BYTES, HALVES the row count and re-serializes
 *   once, flagging `truncated` + a `note`. (One halving is enough in practice; if still
 *   over, we ship it — the cap is a guardrail, not a hard promise.)
 */
export function buildGridPayload(
  raw: unknown[][],
  opts: {
    file: string
    sheets: string[]
    sheet: string
    startRow: number
    maxRows: number
  },
): GridPayload {
  const totalRows = raw.length
  const startIdx = Math.max(0, Math.floor(opts.startRow) - 1)
  const cap = Math.min(Math.max(1, Math.floor(opts.maxRows)), MAX_ROWS_HARD)

  const build = (rowCount: number): { payload: GridPayload; bytes: number } => {
    const slice = raw.slice(startIdx, startIdx + rowCount)
    const grid = trimTrailingEmptyCols(
      slice.map((row) => (row ?? []).slice(0, MAX_COLS).map(cellToString)),
    )
    const payload: GridPayload = {
      file: opts.file,
      sheets: opts.sheets,
      sheet: opts.sheet,
      total_rows: totalRows,
      start_row: startIdx + 1,
      rows: grid,
    }
    return { payload, bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8') }
  }

  const { payload, bytes } = build(cap)
  if (bytes > MAX_PAYLOAD_BYTES && cap > 1) {
    const halved = Math.max(1, Math.floor(cap / 2))
    const retry = build(halved)
    retry.payload.truncated = true
    retry.payload.note = `Payload exceeded ~${MAX_PAYLOAD_BYTES} bytes; row count halved from ${cap} to ${halved}. Use start_row to page through the rest.`
    return retry.payload
  }
  return payload
}

/**
 * Resolve which stored file to read for a (runId, key): list the folder, pick the first
 * (Mail Clerk keeps one latest xlsx per key per run). Returns the storage path + filename,
 * or an error string.
 */
async function resolveSourceFile(
  storage: SupabaseClient['storage'],
  runId: string,
  key: SourceKey,
): Promise<{ path: string; file: string } | { error: string }> {
  const prefix = `${runId}/${key}`
  const { data, error } = await storage.from(SYNC_INBOX_BUCKET).list(prefix, { limit: 20 })
  if (error) return { error: `Could not list source files for ${key}: ${error.message}` }
  const files = (data ?? []).filter((f) => f.name && !f.name.startsWith('.'))
  if (files.length === 0) {
    return { error: `No "${key}" source file was stored for this run (nothing fetched for it, or the run predates storage).` }
  }
  const file = files[0].name
  return { path: `${prefix}/${file}`, file }
}

/**
 * The `read_run_source` executor. Requires a runId (returns an error string if null).
 * Downloads the resolved xlsx, opens the requested sheet (name or 0-based index),
 * and returns the bounded grid payload as a JSON STRING. Never throws.
 */
export async function readRunSource(
  admin: SupabaseClient,
  runId: string | null,
  args: { source_key: string; sheet?: string | number; start_row?: number; max_rows?: number },
): Promise<string> {
  if (!runId) {
    return JSON.stringify({ error: 'no run attached to this case' })
  }
  const key = args.source_key as SourceKey
  if (!SOURCE_KEYS.includes(key)) {
    return JSON.stringify({ error: `Unknown source_key "${args.source_key}". Allowed: ${SOURCE_KEYS.join(', ')}.` })
  }
  try {
    const resolved = await resolveSourceFile(admin.storage, runId, key)
    if ('error' in resolved) return JSON.stringify({ error: resolved.error })

    const dl = await admin.storage.from(SYNC_INBOX_BUCKET).download(resolved.path)
    if (dl.error || !dl.data) {
      return JSON.stringify({ error: `Could not download ${resolved.path}: ${dl.error?.message ?? 'no data'}` })
    }
    const buf = Buffer.from(await dl.data.arrayBuffer())

    let wb: XLSX.WorkBook
    try {
      // cellDates:FALSE — keep raw serials; we convert dates with pure integer math
      // (excelSerialToISO) so no local-midnight / toISOString shift can occur (L-035).
      wb = XLSX.read(buf, { type: 'buffer', cellDates: false })
    } catch (e) {
      return JSON.stringify({ error: `Could not open the workbook: ${e instanceof Error ? e.message : String(e)}` })
    }
    const sheets = wb.SheetNames
    if (sheets.length === 0) return JSON.stringify({ error: 'The workbook has no sheets.' })

    // Resolve requested sheet: number → index, string → name, default → 0.
    let sheetName: string | undefined
    const req = args.sheet
    if (req == null || req === '') {
      sheetName = sheets[0]
    } else if (typeof req === 'number' || /^\d+$/.test(String(req))) {
      const idx = Number(req)
      sheetName = sheets[idx]
    } else {
      sheetName = sheets.find((s) => s === req) ?? sheets.find((s) => s.toLowerCase() === String(req).toLowerCase())
    }
    if (!sheetName) {
      return JSON.stringify({ error: `Sheet "${String(req)}" not found. Available sheets: ${sheets.join(', ')}.` })
    }

    const ws = wb.Sheets[sheetName]
    // Walk cells directly (not sheet_to_json) so we reach each cell's number-format (.z)
    // and formatted text (.w) — needed to detect date cells and render them timezone-proof.
    const raw = sheetToGrid(ws) as unknown[][]

    const payload = buildGridPayload(raw, {
      file: resolved.file,
      sheets,
      sheet: sheetName,
      startRow: args.start_row ?? 1,
      maxRows: args.max_rows ?? DEFAULT_MAX_ROWS,
    })
    return JSON.stringify(payload)
  } catch (e) {
    return JSON.stringify({ error: `read_run_source failed: ${e instanceof Error ? e.message : String(e)}` })
  }
}
