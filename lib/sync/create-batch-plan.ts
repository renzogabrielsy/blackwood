/**
 * create-batch-plan.ts — the PURE core for the human-confirmed "create this batch"
 * resolution of an `unmapped_batch_code` / `unresolved_batch` case.
 *
 * WHY THIS EXISTS: the sync NEVER auto-creates a batch (CLAUDE.md hard rule) — a
 * genuinely-new batch like `JULY-26-FEED1` therefore recurs every run as an unmapped /
 * unresolved flag because nothing ever creates it. This is the ONE human-confirmed
 * exception: the reviewer looks at the flag and clicks "create this batch", which
 * (a) inserts the batch and (b) writes the row(s) that were skipped because it was
 * missing — through the SAME deterministic `apply-writers.ts` path the sync uses.
 *
 * This module is PURE + CLIENT-SAFE (imports only `./types`): it derives the batch's
 * fields from the case row, decides which writer lane the skipped row belongs to, and
 * composes the provenance / ruling strings. The DB reads (does the batch already exist?
 * which live rows does this unblock?) + the writes live in the server action
 * (`app/(app)/sync/resolve.ts`). Mirrors the R3a pick-source split (`diff-plan.ts`).
 */
import type { SyncReportType } from '../../app/(app)/sync/types'

/** The tool name under which a create-batch proposal is persisted on an assistant row. */
export const CREATE_BATCH_TOOL = 'propose_create_batch'

/** The batch columns a create derives. `avg_cost` is null (unpriced — pricing is email-side). */
export interface DerivedBatchFields {
  batch_code: string
  location_ref: string
  status: string
  current_weight: number
  avg_cost: number | null
}

/** Which deterministic writer lane the skipped row belongs to (null = can't tell → create only). */
export type WriterLane = 'deliveries' | 'rc_out' | null

/** The batch-code + block read off a case row (null when the row can't name a batch). */
export interface BatchCaseInput {
  batch_code: string
  block_loc: string | null
  transaction_date: string | null
}

/**
 * The full create-batch plan the human confirms. `unblock` is the ONE row this create
 * will re-attempt (the row skipped because the batch was missing); `writerLane` says
 * which writer applies it. `ambiguous` = we could not build a writable row → create the
 * batch only and let the row land on the next sync.
 */
export interface CreateBatchPlan {
  batch_code: string
  fields: DerivedBatchFields
  /** True when block_loc was null/blank → location_ref falls back to the FEED marker. */
  isFeed: boolean
  /** The writer lane for the skipped row (deliveries for RC IN, rc_out for RC OUT). */
  writerLane: WriterLane
  /** The row payload the writer will re-attempt (null when none / ambiguous). NEVER a ₱/cost. */
  unblock: Record<string, unknown> | null
  /** True when no clean writable row could be derived → create the batch only. */
  ambiguous: boolean
  /** Plain note shown when ambiguous (e.g. "the row will write on the next sync"). */
  note?: string
}

/** The FEED-batch location_ref placeholder when a batch has no block (block_loc null). */
export const FEED_LOCATION_REF = 'FEED'

// ============================================================================
// Pure derivations.
// ============================================================================

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/**
 * Derive the new batch's columns. `location_ref` is the row's block when present, else the
 * FEED marker (a FEED batch legitimately has no block); `status` defaults STORED;
 * `current_weight` 0 (the trigger recomputes it from deliveries − rc_out); `avg_cost` null
 * (unpriced — never carries ₱). PURE.
 */
export function deriveBatchFields(batchCode: string, blockLoc: string | null): DerivedBatchFields {
  const block = str(blockLoc)
  return {
    batch_code: batchCode,
    location_ref: block ?? FEED_LOCATION_REF,
    status: 'STORED',
    current_weight: 0,
    avg_cost: null,
  }
}

/**
 * Read the batch_code + block_loc + date off a case row, for both case kinds:
 *   - `unresolved_batch` — row is the UnresolvedBatch shape ({batch_code, block_loc, …}).
 *   - `unmapped_batch_code` — row is the held row's structured `row` ({batch_code, block_loc,
 *     transaction_date, …}); a minimal `{mode, index}` row (no batch_code) → null.
 * PURE + loose (JSONB in). Returns null when the row can't name a batch.
 */
export function readBatchCaseInput(row: unknown): BatchCaseInput | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const batch_code = str(r.batch_code)
  if (!batch_code) return null
  return {
    batch_code,
    block_loc: str(r.block_loc),
    transaction_date: str(r.transaction_date),
  }
}

/**
 * Decide which writer lane the skipped row belongs to:
 *   - kind `unresolved_batch`      → rc_out (a feeding leg).
 *   - report_type deliveries       → deliveries (RC IN).
 *   - report_type rc_out           → rc_out.
 *   - report_type gsheet           → the row's `mode`: rc_in → deliveries, rc_out → rc_out.
 *   - anything else                → null (create the batch only).
 * PURE.
 */
export function pickWriterLane(
  kind: string,
  reportType: SyncReportType | string,
  row: unknown,
): WriterLane {
  if (kind === 'unresolved_batch') return 'rc_out'
  if (reportType === 'deliveries') return 'deliveries'
  if (reportType === 'rc_out') return 'rc_out'
  if (reportType === 'gsheet') {
    const mode = row && typeof row === 'object' ? str((row as Record<string, unknown>).mode) : null
    if (mode === 'rc_in') return 'deliveries'
    if (mode === 'rc_out') return 'rc_out'
  }
  return null
}

/**
 * Build the create-batch plan from a case row (PURE). Derives the batch fields, picks the
 * writer lane, and passes the case row THROUGH as the unblock payload (the server writer
 * validates it — if it's missing required fields the write simply fails and the batch-only
 * outcome stands). When no batch_code or no writer lane → ambiguous (create the batch only).
 */
export function buildCreateBatchPlan(args: {
  kind: string
  reportType: SyncReportType | string
  row: unknown
}): CreateBatchPlan | null {
  const input = readBatchCaseInput(args.row)
  if (!input) return null

  const fields = deriveBatchFields(input.batch_code, input.block_loc)
  const isFeed = fields.location_ref === FEED_LOCATION_REF
  const lane = pickWriterLane(args.kind, args.reportType, args.row)

  if (!lane) {
    return {
      batch_code: input.batch_code,
      fields,
      isFeed,
      writerLane: null,
      unblock: null,
      ambiguous: true,
      note: 'This flag has no clear delivery/feeding row to re-attempt — the batch will be created and the row will write on the next sync.',
    }
  }

  return {
    batch_code: input.batch_code,
    fields,
    isFeed,
    writerLane: lane,
    unblock: (args.row && typeof args.row === 'object' ? (args.row as Record<string, unknown>) : {}),
    ambiguous: false,
  }
}

// ============================================================================
// Provenance + ruling summary (PURE).
// ============================================================================

/** The provenance stamped on the batch insert + row write + ruling + trail. */
export function createBatchProvenance(email: string, batchCode: string): string {
  return `batch "${batchCode}" created + row written via Sync Review by ${email}`
}

/** The verdict_summary recorded on the `create_batch` ruling. */
export function createBatchRulingSummary(args: {
  batchCode: string
  created: boolean
  rowsWritten: number
}): string {
  const batchPart = args.created
    ? `Created batch "${args.batchCode}"`
    : `Batch "${args.batchCode}" already existed`
  const rowPart =
    args.rowsWritten > 0
      ? ` and wrote ${args.rowsWritten} skipped row(s).`
      : ' (no row written — it will land on the next sync).'
  return batchPart + rowPart
}

// ============================================================================
// Persisted-proposal parse + open-detection (mirrors diff-plan.ts pick-source).
// ============================================================================

/** The input carried on the propose_create_batch tool_use block (the server-computed plan). */
export interface CreateBatchProposalInput {
  batch_code: string
  /** The human label for the case (the case's natural_key). */
  naturalKeyLabel: string
  plan: CreateBatchPlan
}

/** A message row scanned from sync_case_messages (loose — from the DB). */
export interface CreateBatchScanRow {
  role: string
  content: string
  tool_calls: unknown
  position: number
}

/** The latest OPEN (un-actioned) create-batch proposal found while scanning a transcript. */
export interface OpenCreateBatchProposal {
  input: CreateBatchProposalInput
  position: number
  tool_use_id: string
}

/** Validate/parse a propose_create_batch tool input, or null. */
export function parseCreateBatchInput(input: unknown): CreateBatchProposalInput | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>

  const batch_code = str(o.batch_code)
  if (!batch_code) return null

  const naturalKeyLabel = str(o.naturalKeyLabel)
  if (!naturalKeyLabel) return null

  const plan = o.plan
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null
  const p = plan as Record<string, unknown>
  if (typeof p.batch_code !== 'string' || typeof p.ambiguous !== 'boolean' || !p.fields) return null

  return { batch_code, naturalKeyLabel, plan: plan as unknown as CreateBatchPlan }
}

/** Extract the propose_create_batch tool_use block from an assistant row's tool_calls. */
function findCreateBatchCall(toolCalls: unknown): { id: string; input: unknown } | null {
  if (!Array.isArray(toolCalls)) return null
  for (const tc of toolCalls) {
    if (tc && typeof tc === 'object') {
      const o = tc as Record<string, unknown>
      if (o.name === CREATE_BATCH_TOOL) return { id: String(o.id ?? ''), input: o.input }
    }
  }
  return null
}

function isDeclineRow(row: CreateBatchScanRow): boolean {
  return row.role === 'system' && /proposal declined/i.test(row.content)
}

/**
 * The latest propose_create_batch with no later "Proposal declined" system row, on a
 * non-resolved case (mirrors findOpenPickSourcePlan). PURE — the server action guards
 * double-execution with it; a UI can restore a pending proposal after reload. Returns the
 * open proposal (with its message position) or null.
 */
export function findOpenCreateBatchPlan(
  rows: CreateBatchScanRow[],
  caseStatus: string,
): OpenCreateBatchProposal | null {
  if (caseStatus === 'resolved') return null

  let latest: OpenCreateBatchProposal | null = null
  for (const row of rows) {
    if (row.role !== 'assistant') continue
    const call = findCreateBatchCall(row.tool_calls)
    if (!call) continue
    const input = parseCreateBatchInput(call.input)
    if (!input) continue
    latest = { input, position: row.position, tool_use_id: call.id }
  }
  if (!latest) return null

  for (const row of rows) {
    if (row.position > latest.position && isDeclineRow(row)) return null
  }
  return latest
}
