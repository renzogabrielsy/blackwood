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

/** Stringify one cell: Date → ISO yyyy-MM-dd; null/undefined → ''; else String(). */
function cellToString(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) {
    // Guard against Invalid Date.
    const t = v.getTime()
    if (Number.isNaN(t)) return ''
    return v.toISOString().slice(0, 10)
  }
  return String(v)
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
      wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
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
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true }) as unknown[][]

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
