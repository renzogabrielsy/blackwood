/**
 * create-batch-plan.ts — the PURE core for the human-confirmed "create this batch"
 * resolution of an `unmapped_batch_code` / `unresolved_batch` case.
 *
 * WHY THIS EXISTS: this is the MANUAL / human-in-the-loop side of batch creation —
 * the reviewer looks at a still-open flag in Sync Review and clicks "create this
 * batch", which (a) inserts the batch and (b) writes the row(s) that were skipped
 * because it was missing — through the SAME deterministic `apply-writers.ts` path
 * the sync uses. It is the fallback for whatever the AUTOMATIC path below didn't
 * catch (a pattern-INVALID code — a likely typo — or a case left over from before
 * the policy change).
 *
 * POLICY UPDATE (2026-07-11, Renzo-approved): the "never auto-create a batch" hard
 * rule this file's history refers to is REVERSED for pattern-valid codes. The sync
 * worker now auto-creates a batch (from this EXACT template, mirrored — not
 * imported, separate module graph — in `workers/sync/src/lib/batchAutoCreate.ts`)
 * whenever a source names a `batch_code` that doesn't exist yet AND matches the
 * canonical month-prefix + `-YY-` + kind+number shape (e.g. `JULY-26-BLK6`,
 * `JULY-26-FEED1`). A pattern-INVALID code (`BLKZ`, a likely typo) still holds/
 * unmapped and STILL needs this manual flow. See
 * `workers/sync/specs/PORTING_DECISIONS.md` → "Apply-phase deviations" for the
 * full ruling + file list.
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
  /** True when block_loc was null/blank/not-a-valid-location-code → location_ref is ''. */
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

/**
 * DISPLAY-ONLY label for a FEED batch (no block). NEVER write this string into
 * `batches.location_ref` — `chk_location_ref_format` only allows '' or
 * `^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$`, and 'FEED' matches neither (23514). Use it purely
 * to label the UI/narration when `plan.isFeed` is true; the actual stored value is ''.
 */
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
 * Mirrors the DB CHECK constraint `chk_location_ref_format` on `batches.location_ref`:
 * `location_ref = '' OR location_ref ~ '^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$'`. A `block_loc`
 * that doesn't match this (a FEED batch's null block, or free text like "FOR FEEDING" /
 * "16A NEAR PATHWAY") must fall back to '' — never a sentinel like 'FEED', which violates
 * the constraint and 23514s the insert (BUG B, 2026-07-11).
 */
const LOCATION_REF_PATTERN_RE = /^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$/

/**
 * Derive the new batch's columns. `location_ref` is the row's block when it matches the
 * DB's `chk_location_ref_format` constraint, else '' (empty = feed/no block — covers both
 * a genuinely missing block AND a block string that isn't a valid location code); `status`
 * defaults STORED; `current_weight` 0 (the trigger recomputes it from deliveries − rc_out);
 * `avg_cost` null (unpriced — never carries ₱). PURE.
 */
export function deriveBatchFields(batchCode: string, blockLoc: string | null): DerivedBatchFields {
  const block = str(blockLoc)
  const location_ref = block && LOCATION_REF_PATTERN_RE.test(block) ? block : ''
  return {
    batch_code: batchCode,
    location_ref,
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
  // Feed-ness is derived from the ABSENCE of a valid block (empty location_ref), not from
  // a 'FEED' sentinel value — that sentinel is never actually stored (BUG B, 2026-07-11).
  const isFeed = fields.location_ref === ''
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
