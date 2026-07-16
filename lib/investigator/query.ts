/**
 * query.ts — the PURE query-plan builders for `query_table` and `check_duplicates`.
 *
 * These validate the model-supplied args against the static allow-lists and produce a
 * structured PLAN (table, columns, filters, order, limit) — WITHOUT touching the DB.
 * tools.ts applies a plan to the real PostgREST builder; the verify script asserts the
 * plan directly, so the query logic is proven without live network.
 */
import {
  ALLOWED_OPS,
  isAllowedColumn,
  resolveColumns,
  TABLE_ALLOWLIST,
  type FilterOp,
} from './allowlist'

export interface FilterClause {
  column: string
  op: FilterOp
  value: unknown
}

export interface QueryPlan {
  table: string
  columns: readonly string[]
  filters: FilterClause[]
  orderBy: { column: string; ascending: boolean } | null
  limit: number
}

export const QUERY_DEFAULT_LIMIT = 50
export const QUERY_MAX_LIMIT = 200

/** Clamp a requested limit to [1, QUERY_MAX_LIMIT], defaulting when absent/invalid. */
export function clampLimit(raw: unknown, def = QUERY_DEFAULT_LIMIT, max = QUERY_MAX_LIMIT): number {
  const n = typeof raw === 'number' ? raw : raw == null ? NaN : Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(Math.max(1, Math.floor(n)), max)
}

export interface QueryTableArgs {
  table?: string
  columns?: string[]
  filters?: Array<{ column?: string; op?: string; value?: unknown }>
  order_by?: { column?: string; ascending?: boolean } | string
  limit?: number
}

/**
 * Build + validate a `query_table` plan. Returns { ok:true, plan } or { ok:false, error }
 * (a plain string the tool returns as JSON to the model). Every column/op/order is
 * validated against the allow-lists; nothing raw reaches PostgREST.
 */
export function buildQueryPlan(
  args: QueryTableArgs,
): { ok: true; plan: QueryPlan } | { ok: false; error: string } {
  const table = args.table ?? ''
  if (!TABLE_ALLOWLIST[table]) {
    return { ok: false, error: `Unknown table "${table}". Allowed: ${Object.keys(TABLE_ALLOWLIST).join(', ')}.` }
  }

  const colRes = resolveColumns(table, args.columns)
  if (!colRes.ok) return { ok: false, error: colRes.error }

  // Filters
  const filters: FilterClause[] = []
  for (const f of args.filters ?? []) {
    const column = f.column ?? ''
    const op = f.op ?? ''
    if (!isAllowedColumn(table, column)) {
      return {
        ok: false,
        error: `Filter column "${column}" is not allowed on "${table}" (or is a price column).`,
      }
    }
    if (!(ALLOWED_OPS as readonly string[]).includes(op)) {
      return { ok: false, error: `Filter op "${op}" is not allowed. Use one of: ${ALLOWED_OPS.join(', ')}.` }
    }
    if (op === 'in' && !Array.isArray(f.value)) {
      return { ok: false, error: `Filter op "in" on "${column}" requires an array value.` }
    }
    filters.push({ column, op: op as FilterOp, value: f.value })
  }

  // order_by — accept either { column, ascending } or a bare column string.
  let orderBy: QueryPlan['orderBy'] = null
  if (args.order_by) {
    const oc = typeof args.order_by === 'string' ? args.order_by : (args.order_by.column ?? '')
    const asc = typeof args.order_by === 'string' ? true : args.order_by.ascending !== false
    if (oc) {
      if (!isAllowedColumn(table, oc)) {
        return { ok: false, error: `order_by column "${oc}" is not allowed on "${table}".` }
      }
      orderBy = { column: oc, ascending: asc }
    }
  }

  return {
    ok: true,
    plan: {
      table,
      columns: colRes.columns,
      filters,
      orderBy,
      limit: clampLimit(args.limit),
    },
  }
}

export interface DuplicatePlan {
  table: string
  groupBy: string[]
  dateColumn: string
  dateFrom: string
  dateTo: string
  fetchLimit: number
}

export interface CheckDuplicatesArgs {
  table?: string
  group_by?: string[]
  date_column?: string
  date?: string
  date_from?: string
  date_to?: string
}

/** Loose ISO-date sanity check (YYYY-MM-DD). */
function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim())
}

/** How many rows check_duplicates fetches for its in-memory grouping (bounded). */
export const DUP_FETCH_LIMIT = 500

/**
 * Build + validate a `check_duplicates` plan. group_by columns and the date column are
 * validated against the allow-list; a date or date_from/date_to window is required so the
 * bounded fetch stays small. Returns { ok, plan } or { ok:false, error }.
 */
export function buildDuplicatePlan(
  args: CheckDuplicatesArgs,
): { ok: true; plan: DuplicatePlan } | { ok: false; error: string } {
  const table = args.table ?? ''
  if (!TABLE_ALLOWLIST[table]) {
    return { ok: false, error: `Unknown table "${table}". Allowed: ${Object.keys(TABLE_ALLOWLIST).join(', ')}.` }
  }
  const groupBy = args.group_by ?? []
  if (groupBy.length === 0) {
    return { ok: false, error: 'group_by must name at least one column to group on.' }
  }
  for (const c of groupBy) {
    if (!isAllowedColumn(table, c)) {
      return { ok: false, error: `group_by column "${c}" is not allowed on "${table}" (or is a price column).` }
    }
  }
  const dateColumn = args.date_column ?? ''
  if (!isAllowedColumn(table, dateColumn)) {
    return { ok: false, error: `date_column "${dateColumn}" is not allowed on "${table}".` }
  }

  let dateFrom: string
  let dateTo: string
  if (isIsoDate(args.date)) {
    dateFrom = args.date.trim()
    dateTo = args.date.trim()
  } else if (isIsoDate(args.date_from) && isIsoDate(args.date_to)) {
    dateFrom = args.date_from.trim()
    dateTo = args.date_to.trim()
  } else if (isIsoDate(args.date_from)) {
    dateFrom = args.date_from.trim()
    dateTo = args.date_from.trim()
  } else {
    return {
      ok: false,
      error: 'Provide either `date` (YYYY-MM-DD) or both `date_from` and `date_to` (YYYY-MM-DD) to bound the check.',
    }
  }

  return {
    ok: true,
    plan: { table, groupBy, dateColumn, dateFrom, dateTo, fetchLimit: DUP_FETCH_LIMIT },
  }
}

/**
 * PURE: group already-fetched rows by the plan's group_by columns and return only the
 * groups with count > 1 (the duplicates), each with a bounded sample of the offending
 * rows. Rows are assumed already price-scrubbed by the caller.
 */
export function groupDuplicates(
  rows: Array<Record<string, unknown>>,
  groupBy: string[],
  sampleSize = 5,
): Array<{ key: Record<string, unknown>; count: number; sample: Array<Record<string, unknown>> }> {
  const groups = new Map<string, { key: Record<string, unknown>; count: number; sample: Array<Record<string, unknown>> }>()
  for (const row of rows) {
    const keyObj: Record<string, unknown> = {}
    for (const c of groupBy) keyObj[c] = row[c] ?? null
    const keyStr = JSON.stringify(groupBy.map((c) => row[c] ?? null))
    const g = groups.get(keyStr)
    if (g) {
      g.count += 1
      if (g.sample.length < sampleSize) g.sample.push(row)
    } else {
      groups.set(keyStr, { key: keyObj, count: 1, sample: [row] })
    }
  }
  return [...groups.values()].filter((g) => g.count > 1)
}
