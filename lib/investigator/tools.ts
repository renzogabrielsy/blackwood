/**
 * tools.ts — the Smart Held-Row Adjudicator's READ-ONLY investigative toolset (P2).
 *
 * `createInvestigatorTools({ runId, canViewPrices })` returns:
 *   - `definitions`: Anthropic.Tool[]  — the 5 tools, described FOR the model
 *   - `execute(name, args)`            — the dispatcher; every executor returns a JSON string
 *
 * Every tool is SELECT / READ-ONLY: no INSERT/UPDATE/DELETE, no apply, no skip. The
 * agent investigates and advises; the write stays human-directed (P5). Mirrors Jarvis'
 * `TOOL_DEFINITIONS` + `executeToolCall` shape (lib/jarvis/tool-handlers.ts) but is
 * scoped, allow-listed, and price-free by construction.
 *
 * PRICE SAFETY (defense in depth, three layers):
 *   1. TABLE_ALLOWLIST has NO ₱/cost columns — the model literally cannot name one.
 *   2. buildQueryPlan/buildDuplicatePlan reject any price-pattern column.
 *   3. scrubPriceKeys() strips any price-pattern key from EVERY returned row.
 * `canViewPrices` is carried in ctx for parity with the rest of the app, but this
 * surface never returns ₱ REGARDLESS of it (adjudication.ts's stance) — so the flag
 * only ever tightens, never loosens.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '@/lib/supabase/admin'
import { ALLOWED_OPS, ALLOWED_TABLES, scrubPriceKeys } from './allowlist'
import {
  buildDuplicatePlan,
  buildQueryPlan,
  groupDuplicates,
  QUERY_DEFAULT_LIMIT,
  QUERY_MAX_LIMIT,
  type CheckDuplicatesArgs,
  type QueryTableArgs,
} from './query'
import { readRule, RULE_ID_RE } from './rules'
import { readRunSource, SOURCE_KEYS } from './source'

/**
 * A minimal structural client for the two dynamic-table executors (query_table /
 * check_duplicates). Their `table` is chosen at RUNTIME and validated against
 * TABLE_ALLOWLIST, so it can never satisfy the typed relation union — we deliberately
 * run these through an untyped PostgREST surface. The allow-list is the type-safety
 * substitute: only real tables/columns ever reach here. Returned rows are always
 * price-scrubbed before leaving the executor.
 */
interface UntypedFilter extends PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> {
  eq(column: string, value: unknown): UntypedFilter
  neq(column: string, value: unknown): UntypedFilter
  gte(column: string, value: unknown): UntypedFilter
  lte(column: string, value: unknown): UntypedFilter
  ilike(column: string, pattern: string): UntypedFilter
  in(column: string, values: unknown[]): UntypedFilter
  order(column: string, opts: { ascending: boolean }): UntypedFilter
  limit(n: number): UntypedFilter
}
interface UntypedQueryClient {
  from(table: string): { select(columns: string): UntypedFilter }
}

export interface InvestigatorContext {
  /** The run this case belongs to — required by read_run_source; null → that tool errors. */
  runId: string | null
  /** Effective price visibility (impersonation-aware). This surface never returns ₱ regardless. */
  canViewPrices: boolean
}

export interface InvestigatorTools {
  definitions: Anthropic.Tool[]
  execute(name: string, args: Record<string, unknown>): Promise<string>
}

// ============================================================================
// Tool definitions — the `description` fields are prompt engineering. They tell
// the model WHEN to reach for each tool, WHAT it returns, and its LIMITS.
// ============================================================================

function buildDefinitions(): Anthropic.Tool[] {
  return [
    {
      name: 'query_table',
      description:
        `Run a scoped, READ-ONLY SELECT against one allow-listed table or reporting view to pull the ` +
        `actual rows behind a held case. This is your primary evidence tool: use it to see what the ` +
        `database already has for a date/batch/location before concluding anything.\n\n` +
        `Tables you can query: ${ALLOWED_TABLES.join(', ')}.\n` +
        `You choose columns from that table's allow-list (omit \`columns\` to get all allowed columns). ` +
        `PRICE / COST columns are NEVER available anywhere — do not ask for cost_basis, avg_cost, php, etc.\n` +
        `Filters are an array of {column, op, value}; op ∈ ${ALLOWED_OPS.join(' | ')} ("in" needs an array value). ` +
        `order_by is {column, ascending} or a bare column name. limit defaults to ${QUERY_DEFAULT_LIMIT}, hard max ${QUERY_MAX_LIMIT}.\n` +
        `Returns {table, count, rows}. rows are plain objects. If you name an unknown table/column or a ` +
        `price column, you get an {error} back — read it and correct your call.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          table: { type: 'string', enum: ALLOWED_TABLES, description: 'The table or view to query.' },
          columns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional. Columns to return (must be in the table\'s allow-list). Omit for all allowed columns.',
          },
          filters: {
            type: 'array',
            description: 'Optional WHERE clauses, ANDed together.',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                op: { type: 'string', enum: [...ALLOWED_OPS] },
                value: { description: 'Scalar for eq/neq/gte/lte/like; array for in.' },
              },
              required: ['column', 'op', 'value'],
            },
          },
          order_by: {
            description: 'Optional. {column, ascending} or a bare column name (ascending).',
          },
          limit: { type: 'number', description: `Max rows (default ${QUERY_DEFAULT_LIMIT}, hard max ${QUERY_MAX_LIMIT}).` },
        },
        required: ['table'],
      },
    },
    {
      name: 'check_duplicates',
      description:
        `Detect duplicate rows in one allow-listed table for a given date (or small date window), grouped ` +
        `by a natural key you choose. This is the tool that answers "is the database double-entered?" — ` +
        `e.g. for an O>M feeding overage, group rc_out by [transaction_date, batch_id, destination, weight_kg] ` +
        `on the suspect date: if a group appears 2+ times the DB really has duplicates; if none do, the ` +
        `database is clean and the discrepancy lives in the source sheet.\n\n` +
        `You MUST bound it with either \`date\` (YYYY-MM-DD) or \`date_from\`/\`date_to\`, naming the \`date_column\`. ` +
        `It fetches the matching rows (bounded) and groups them in memory. Returns {table, group_by, ` +
        `duplicate_groups} where each group has {key, count, sample rows}. Empty duplicate_groups = no duplicates found.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          table: { type: 'string', enum: ALLOWED_TABLES, description: 'The table to check.' },
          group_by: {
            type: 'array',
            items: { type: 'string' },
            description: 'Columns forming the natural key to group on (allow-listed columns).',
          },
          date_column: { type: 'string', description: 'The date column to filter on (e.g. transaction_date, reading_date).' },
          date: { type: 'string', description: 'A single day (YYYY-MM-DD). Use this OR the from/to pair.' },
          date_from: { type: 'string', description: 'Start of a date window (YYYY-MM-DD).' },
          date_to: { type: 'string', description: 'End of a date window (YYYY-MM-DD).' },
        },
        required: ['table', 'group_by', 'date_column'],
      },
    },
    {
      name: 'read_run_source',
      description:
        `Read the ACTUAL source workbook this sync run fetched, straight from storage, so you can compare ` +
        `the numbers in the operator's sheet against what landed in the database (this is how you tell ` +
        `"the sheet is missing entries" from "the database is wrong"). It is a GENERIC grid dump — you read ` +
        `the raw rows yourself; there are no pre-parsed columns.\n\n` +
        `source_key picks WHICH file: ${SOURCE_KEYS.join(', ')} ` +
        `(e.g. "rc_out" = the PROPOSED DAILY REPORT, "rc_out_movement" = the RAW CHARCOAL MOVEMENT sheet, ` +
        `"deliveries" = RC IN, "deliveries_czarina" = the price file, "production_mc"/"production_waste" = the two ` +
        `production emails, "flecon" = the bag workbook). sheet is a name or 0-based index (default 0). Page with ` +
        `start_row (1-based, default 1) and max_rows (default 100, hard max 300).\n\n` +
        `Returns {file, sheets, sheet, total_rows, rows} where rows is an array of arrays (the raw grid, cells as ` +
        `strings, dates as yyyy-MM-dd). Large sheets are truncated (flagged in the payload) — page through them. ` +
        `Requires a run to be attached to the case; without one you get {error:"no run attached to this case"}.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          source_key: { type: 'string', enum: [...SOURCE_KEYS], description: 'Which stored source file to read.' },
          sheet: { description: 'Sheet name or 0-based index (default 0).' },
          start_row: { type: 'number', description: '1-based first row to return (default 1).' },
          max_rows: { type: 'number', description: 'Rows to return (default 100, hard max 300).' },
        },
        required: ['source_key'],
      },
    },
    {
      name: 'find_batches',
      description:
        `Fuzzy-search the batches table by batch code (case-insensitive substring match) to resolve an unknown ` +
        `or mistyped batch code to real candidates. Use this when a held row names a batch code that may not ` +
        `exist or may be spelled differently.\n\n` +
        `IMPORTANT — month prefixes in batch codes are INCONSISTENT across the data: some months use a 3-letter ` +
        `prefix (JAN, FEB, AUG, SEPT, OCT, NOV, DEC) and others the full word (MARCH, APRIL, JUNE, JULY). If a ` +
        `search comes back empty, try the other spelling of the month (e.g. both "MAR" and "MARCH", "SEP" and ` +
        `"SEPT"). Give at least 3 characters.\n\n` +
        `Returns up to 20 matches with {id, batch_code, status, location_ref, current_weight}. It NEVER returns ` +
        `cost. Never treat "not found" as license to invent a batch — surface the closest candidates instead.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          code_query: { type: 'string', description: 'The batch-code fragment to search for (min 3 chars).' },
        },
        required: ['code_query'],
      },
    },
    {
      name: 'read_rule',
      description:
        `Look up one of the sync's institutional learnings (the "L-rules", L-001 … L-033) so your reasoning ` +
        `matches how this plant's data actually behaves. Each rule captures a real past incident and the ` +
        `standing handling for it — e.g. L-019 (settled-date re-inserts / DB sum > movement = duplication), ` +
        `L-022 (cross-month movement totals), L-007 (STARTING/ENDING = batch boundaries).\n\n` +
        `rule_id is "L-0XX". full=false (default) returns the one-line digest summary; full=true returns the ` +
        `entire ledger entry (the full story + handling). If the id is unknown you get an {error} plus a list ` +
        `of nearby valid ids. Reach for this whenever a held case smells like a known pattern.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          rule_id: { type: 'string', description: 'The rule id, form L-0XX (e.g. L-007).' },
          full: { type: 'boolean', description: 'false → digest line (default); true → full ledger entry.' },
        },
        required: ['rule_id'],
      },
    },
  ]
}

// ============================================================================
// Executors
// ============================================================================

/** query_table — validate a plan, run the SELECT, price-scrub every row. */
async function execQueryTable(
  admin: UntypedQueryClient,
  args: QueryTableArgs,
): Promise<string> {
  const res = buildQueryPlan(args)
  if (!res.ok) return JSON.stringify({ error: res.error })
  const { plan } = res

  let q = admin.from(plan.table).select(plan.columns.join(', ')).limit(plan.limit)
  for (const f of plan.filters) {
    switch (f.op) {
      case 'eq':
        q = q.eq(f.column, f.value)
        break
      case 'neq':
        q = q.neq(f.column, f.value)
        break
      case 'gte':
        q = q.gte(f.column, f.value)
        break
      case 'lte':
        q = q.lte(f.column, f.value)
        break
      case 'like':
        q = q.ilike(f.column, `%${String(f.value)}%`)
        break
      case 'in':
        q = q.in(f.column, f.value as unknown[])
        break
    }
  }
  if (plan.orderBy) {
    q = q.order(plan.orderBy.column, { ascending: plan.orderBy.ascending })
  }

  const { data, error } = await q
  if (error) return JSON.stringify({ error: error.message, table: plan.table })
  const rows = (data ?? []).map((r) => scrubPriceKeys(r as Record<string, unknown>))
  return JSON.stringify({ table: plan.table, count: rows.length, rows })
}

/** check_duplicates — bounded date-filtered fetch, in-memory group, return count>1 groups. */
async function execCheckDuplicates(
  admin: UntypedQueryClient,
  args: CheckDuplicatesArgs,
): Promise<string> {
  const res = buildDuplicatePlan(args)
  if (!res.ok) return JSON.stringify({ error: res.error })
  const { plan } = res

  const { data, error } = await admin
    .from(plan.table)
    .select('*')
    .gte(plan.dateColumn, plan.dateFrom)
    .lte(plan.dateColumn, plan.dateTo)
    .limit(plan.fetchLimit)
  if (error) return JSON.stringify({ error: error.message, table: plan.table })

  const rows = (data ?? []).map((r) => scrubPriceKeys(r as Record<string, unknown>))
  const dupGroups = groupDuplicates(rows, plan.groupBy)
  return JSON.stringify({
    table: plan.table,
    group_by: plan.groupBy,
    date_range: { from: plan.dateFrom, to: plan.dateTo },
    scanned: rows.length,
    duplicate_groups: dupGroups,
  })
}

/** find_batches — case-insensitive batch_code search, never returns avg_cost. */
async function execFindBatches(
  admin: ReturnType<typeof createAdminClient>,
  args: { code_query?: string },
): Promise<string> {
  const q = (args.code_query ?? '').trim()
  if (q.length < 3) {
    return JSON.stringify({ error: 'code_query must be at least 3 characters.' })
  }
  const { data, error } = await admin
    .from('batches')
    .select('id, batch_code, status, location_ref, current_weight')
    .ilike('batch_code', `%${q}%`)
    .limit(20)
  if (error) return JSON.stringify({ error: error.message })
  const rows = (data ?? []).map((r) => scrubPriceKeys(r as Record<string, unknown>))
  return JSON.stringify({ query: q, count: rows.length, rows })
}

// ============================================================================
// Factory
// ============================================================================

export function createInvestigatorTools(ctx: InvestigatorContext): InvestigatorTools {
  const definitions = buildDefinitions()

  async function execute(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case 'query_table': {
          // Untyped surface: the table is runtime-validated against the allow-list.
          const admin = createAdminClient() as unknown as UntypedQueryClient
          return await execQueryTable(admin, args as QueryTableArgs)
        }
        case 'check_duplicates': {
          const admin = createAdminClient() as unknown as UntypedQueryClient
          return await execCheckDuplicates(admin, args as CheckDuplicatesArgs)
        }
        case 'read_run_source': {
          // Validate the run attachment BEFORE building the admin client, so a
          // missing run reports "no run attached" rather than a client/env error.
          if (!ctx.runId) return JSON.stringify({ error: 'no run attached to this case' })
          const admin = createAdminClient()
          return await readRunSource(
            admin,
            ctx.runId,
            args as { source_key: string; sheet?: string | number; start_row?: number; max_rows?: number },
          )
        }
        case 'find_batches': {
          // Cheap arg guard before building the client (keeps the min-length
          // rejection env-independent).
          const codeQuery = String((args as { code_query?: unknown }).code_query ?? '').trim()
          if (codeQuery.length < 3) {
            return JSON.stringify({ error: 'code_query must be at least 3 characters.' })
          }
          const admin = createAdminClient()
          return await execFindBatches(admin, { code_query: codeQuery })
        }
        case 'read_rule': {
          const ruleId = String((args as { rule_id?: unknown }).rule_id ?? '')
          if (!RULE_ID_RE.test(ruleId)) {
            return JSON.stringify({ error: `Invalid rule id "${ruleId}". Expected the form L-0XX (e.g. L-007).` })
          }
          const full = Boolean((args as { full?: unknown }).full)
          return await readRule(ruleId, full)
        }
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` })
      }
    } catch (e) {
      // Never throw — the agent loop feeds errors back to the model as a tool result.
      return JSON.stringify({ error: `Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return { definitions, execute }
}
