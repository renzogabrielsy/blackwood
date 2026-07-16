/**
 * diff-plan.ts — the PURE row-level write-plan for resolving a `source_diff` case by
 * PICKING one source's value (R3a of the Sync Reconciliation Model).
 *
 * A `source_diff` reconciles at the SUM of rc_out weight over the fine key
 * (transaction_date, batch, block_loc, destination) — see reconcile/rcOut.ts. The DB,
 * however, holds one rc_out row per feeding LEG. So "make source S true for this key"
 * is not one write — it is a set of per-leg writes that turns the DB's current legs into
 * the chosen source's legs. This module computes that plan from the DB's current legs +
 * the chosen source's legs. It is PURE (no DB, no client) so scripts/verify-resolve-diff.ts
 * can exercise every branch; the server action (resolve.ts) does the DB read + apply.
 *
 * Algorithm — EDIT-PREFERRED, NEVER a silent delete, SAFETY over cleverness:
 *   1. Greedily match DB legs to source legs by EQUAL weight (within tol) → `noop` steps.
 *   2. Of the leftovers:
 *      - exactly 1 unmatched DB leg + 1 unmatched source leg (the L-037 shape) →
 *        a single `edit` of that DB leg's weight to the source's value
 *        (reproduces the manual fix: 31,745 → 20,932).
 *      - source has extra legs, DB has none left → `insert` each (resolve batch, never create).
 *      - DB has extra legs, source has none left → `remove` each (SOFT: weight → 0 +
 *        audited note; we never hard-delete — CLAUDE.md "never delete anything").
 *      - anything else (both remainders non-empty and not the clean 1-1 case) → AMBIGUOUS:
 *        no steps, `ambiguous: true` + a suggestion. The UI routes the human to the P5
 *        edit-then-apply path to fix rows by hand. Prefer safety over guessing a mapping.
 *   3. `resultingSumKg` (the sum after applying) always equals the chosen source's total.
 *
 * NEVER touches ₱/cost (rc_out has no cost column). Weights are integer kg; a 1 kg tolerance
 * absorbs rounding, matching the reconcile engine.
 */
import type { RcOutSource, SourceLegRow } from './types'

/** The subset of a live rc_out DB row a write plan reasons over. NO cost column exists. */
export interface DbRcOutRow {
  id: string
  transaction_date: string
  batch_id: string | null
  block_loc: string | null
  destination: string | null
  weight_kg: number
  production_batch: string | null
  remarks: string | null
}

/** One step in the plan. `op` decides which fields are meaningful. */
export interface DiffPlanStep {
  op: 'noop' | 'edit' | 'insert' | 'remove'
  /** DB rc_out row id — present for noop / edit / remove. */
  db_id?: string
  /** The weight currently in the DB row — present for noop / edit / remove. */
  from_weight_kg?: number
  /** The weight to write — present for edit / insert. */
  to_weight_kg?: number
  /** The source leg backing an edit / insert (carries batch_code, block, dest for the write). */
  leg?: SourceLegRow
  /** One plain-language line describing this step (no ₱). */
  describe: string
}

/** The full plan the human confirms before any write. */
export interface DiffWritePlan {
  /** The picked source this plan makes authoritative. */
  source: RcOutSource
  /** True when the DB↔source leg mapping is not clean — NOTHING is auto-written. */
  ambiguous: boolean
  /** Present when ambiguous — how the human should proceed (P5 edit-then-apply). */
  suggestion?: string
  /** The ordered per-leg steps (empty when ambiguous). */
  steps: DiffPlanStep[]
  /** rc_out sum at the key BEFORE applying (current DB). */
  currentSumKg: number
  /** The chosen source's total at the key. */
  chosenSumKg: number
  /** rc_out sum at the key AFTER applying the steps (equals chosenSumKg on a clean plan). */
  resultingSumKg: number
  /** Whether this plan changes anything at all (false = DB already equals the source). */
  hasChanges: boolean
}

const DEFAULT_TOL_KG = 1

function within(a: number, b: number, tol: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol
}

function fmtKg(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} kg`
}

function legLabel(leg: SourceLegRow): string {
  const parts = [leg.batch_code ?? '(no batch)']
  if (leg.block_loc) parts.push(`@ ${leg.block_loc}`)
  if (leg.destination && leg.destination !== 'MAIN') parts.push(`→ ${leg.destination}`)
  return parts.join(' ')
}

/**
 * Compute the per-leg write plan to make `source` authoritative for the natural key.
 * PURE — dbRows are the live rc_out legs at the key; sourceRows are the chosen source's
 * legs (SourceOpinion.rows). Never writes; never trusts a client.
 */
export function computeDiffWritePlan(args: {
  source: RcOutSource
  dbRows: DbRcOutRow[]
  sourceRows: SourceLegRow[]
  tolKg?: number
}): DiffWritePlan {
  const tol = args.tolKg ?? DEFAULT_TOL_KG
  const dbRows = args.dbRows
  const sourceRows = args.sourceRows

  const currentSumKg = round2(dbRows.reduce((a, r) => a + (r.weight_kg ?? 0), 0))
  const chosenSumKg = round2(sourceRows.reduce((a, r) => a + (r.weight_kg ?? 0), 0))

  const base = {
    source: args.source,
    currentSumKg,
    chosenSumKg,
  }

  // ── 1. Greedy equal-weight match (noop pairs). ────────────────────────────
  const dbPool = dbRows.map((r) => ({ row: r, used: false }))
  const srcPool = sourceRows.map((r) => ({ row: r, used: false }))
  const noops: DiffPlanStep[] = []

  for (const s of srcPool) {
    const hit = dbPool.find((d) => !d.used && within(d.row.weight_kg, s.row.weight_kg, tol))
    if (hit) {
      hit.used = true
      s.used = true
      noops.push({
        op: 'noop',
        db_id: hit.row.id,
        from_weight_kg: hit.row.weight_kg,
        to_weight_kg: hit.row.weight_kg,
        describe: `Keep ${legLabel(s.row)} — ${fmtKg(hit.row.weight_kg)} (already matches).`,
      })
    }
  }

  const dbRemain = dbPool.filter((d) => !d.used).map((d) => d.row)
  const srcRemain = srcPool.filter((s) => !s.used).map((s) => s.row)

  // ── 2. Classify the leftovers. ────────────────────────────────────────────

  // Clean L-037 shape: one differing leg on each side → a single EDIT.
  if (dbRemain.length === 1 && srcRemain.length === 1) {
    const db = dbRemain[0]
    const src = srcRemain[0]
    const step: DiffPlanStep = {
      op: 'edit',
      db_id: db.id,
      from_weight_kg: db.weight_kg,
      to_weight_kg: src.weight_kg,
      leg: src,
      describe: `Correct ${legLabel(src)} — ${fmtKg(db.weight_kg)} → ${fmtKg(src.weight_kg)}.`,
    }
    return finalize(base, [...noops, step])
  }

  // Source has extra legs the DB is missing → INSERT each (batch resolved, never created).
  if (dbRemain.length === 0 && srcRemain.length > 0) {
    const inserts = srcRemain.map<DiffPlanStep>((src) => ({
      op: 'insert',
      to_weight_kg: src.weight_kg,
      leg: src,
      describe: `Add ${legLabel(src)} — ${fmtKg(src.weight_kg)} (missing from the database).`,
    }))
    return finalize(base, [...noops, ...inserts])
  }

  // DB has extra legs the source doesn't have → SOFT-REMOVE each (weight → 0; never delete).
  if (srcRemain.length === 0 && dbRemain.length > 0) {
    const removes = dbRemain.map<DiffPlanStep>((db) => ({
      op: 'remove',
      db_id: db.id,
      from_weight_kg: db.weight_kg,
      to_weight_kg: 0,
      describe: `Zero out an over-stated leg — ${fmtKg(db.weight_kg)} → 0 kg (kept as a 0 kg audited row, never deleted).`,
    }))
    return finalize(base, [...noops, ...removes])
  }

  // Nothing left on either side → the DB already equals the source, leg for leg.
  if (dbRemain.length === 0 && srcRemain.length === 0) {
    return finalize(base, noops)
  }

  // ── AMBIGUOUS: unequal counts / multiple mismatched legs → no auto-write. ──
  return {
    ...base,
    ambiguous: true,
    suggestion:
      `The database has ${dbRemain.length} leg(s) and the source has ${srcRemain.length} leg(s) that ` +
      `don't line up one-to-one, so it isn't safe to guess which leg becomes which. ` +
      `Fix the rows by hand with edit-then-apply (the source total for this day is ${fmtKg(chosenSumKg)}).`,
    steps: [],
    resultingSumKg: currentSumKg,
    hasChanges: false,
  }
}

/** Attach the resulting sum + hasChanges to a non-ambiguous plan. */
function finalize(
  base: { source: RcOutSource; currentSumKg: number; chosenSumKg: number },
  steps: DiffPlanStep[],
): DiffWritePlan {
  const resultingSumKg = round2(
    steps.reduce((a, s) => {
      if (s.op === 'noop') return a + (s.from_weight_kg ?? 0)
      if (s.op === 'edit' || s.op === 'insert') return a + (s.to_weight_kg ?? 0)
      // remove → contributes 0
      return a
    }, 0),
  )
  const hasChanges = steps.some((s) => s.op !== 'noop')
  return { ...base, ambiguous: false, steps, resultingSumKg, hasChanges }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ============================================================================
// PICK-SOURCE PROPOSAL — the persisted-proposal shape + pure detection + the
// provenance / ruling-summary composers. All PURE (no DB, no client) so
// scripts/verify-resolve-diff.ts can exercise them and so R3b's UI can import the
// detector without dragging any server-only module into the client bundle (this
// file imports only ./types). The server action (resolve.ts) does the DB read +
// apply; it persists a proposal as an ASSISTANT message carrying ONE tool_use block
// named PICK_SOURCE_TOOL, exactly mirroring how P5 propose_resolution is stored, so
// findOpen*-style detection + sanitizeAnthropicHistory replay both work unchanged.
// ============================================================================

/** The tool name under which a pick_source proposal is persisted on an assistant row. */
export const PICK_SOURCE_TOOL = 'propose_pick_source'

/**
 * The persisted input carried on the propose_pick_source tool_use block. The FULL
 * DiffWritePlan is embedded so executeDiffResolution re-reads it from the DB (never a
 * client payload) — server-authored, so re-reading it is the trusted path.
 */
export interface PickSourceProposalInput {
  source: RcOutSource
  /** The reconciled field (currently always 'weight_kg'). */
  field: string
  /** The human label for the natural key (the case's natural_key). */
  naturalKeyLabel: string
  /** The full, server-computed write plan the human confirms. */
  plan: DiffWritePlan
}

/**
 * Compose the provenance string stamped on every diff-resolution write + audit +
 * ruling. PURE + factored so the verify script pins the exact composition.
 */
export function diffResolutionProvenance(args: {
  email: string
  source: RcOutSource
  field: string
  naturalKeyLabel: string
}): string {
  const field = args.field === 'weight_kg' ? 'weight' : args.field
  return `source_diff resolved via Sync Review by ${args.email}: picked ${args.source} — ${field} for ${args.naturalKeyLabel}`
}

/**
 * The verdict_summary recorded on the pick_source ruling — names the picked source +
 * the authoritative value it makes true for the key. PURE.
 */
export function pickSourceRulingSummary(args: {
  source: RcOutSource
  field: string
  naturalKeyLabel: string
  plan: DiffWritePlan
}): string {
  const field = args.field === 'weight_kg' ? 'weight' : args.field
  const value =
    args.field === 'weight_kg' ? fmtKg(args.plan.chosenSumKg) : String(args.plan.chosenSumKg)
  return `Picked ${args.source} as authoritative for ${args.naturalKeyLabel}: ${field} is now ${value}.`
}

/** A message row as scanned from sync_case_messages (loose — from the DB). */
export interface PickSourceScanRow {
  role: string
  content: string
  tool_calls: unknown
  position: number
}

/** The latest OPEN (un-actioned) pick_source proposal found while scanning a transcript. */
export interface OpenPickSourceProposal {
  input: PickSourceProposalInput
  /** The position of the assistant message that carried the propose_pick_source call. */
  position: number
  /** The tool_use id of the propose_pick_source call (for tracing). */
  tool_use_id: string
}

/** Validate/parse a propose_pick_source tool input into a PickSourceProposalInput, or null. */
export function parsePickSourceInput(input: unknown): PickSourceProposalInput | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>

  const source = o.source
  if (source !== 'proposed' && source !== 'gsheet' && source !== 'movement') return null

  const field = o.field
  if (typeof field !== 'string' || field.trim().length === 0) return null

  const naturalKeyLabel = o.naturalKeyLabel
  if (typeof naturalKeyLabel !== 'string' || naturalKeyLabel.trim().length === 0) return null

  const plan = o.plan
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null
  // Light structural guard — the plan must carry the fields the executor + UI read.
  const p = plan as Record<string, unknown>
  if (typeof p.ambiguous !== 'boolean' || !Array.isArray(p.steps)) return null

  return {
    source,
    field: field.trim(),
    naturalKeyLabel: naturalKeyLabel.trim(),
    plan: plan as unknown as DiffWritePlan,
  }
}

/** Extract the propose_pick_source tool_use block from an assistant row's tool_calls. */
function findPickSourceCall(toolCalls: unknown): { id: string; input: unknown } | null {
  if (!Array.isArray(toolCalls)) return null
  for (const tc of toolCalls) {
    if (tc && typeof tc === 'object') {
      const o = tc as Record<string, unknown>
      if (o.name === PICK_SOURCE_TOOL) {
        return { id: String(o.id ?? ''), input: o.input }
      }
    }
  }
  return null
}

/** True when a system row records a declined proposal at its position. */
function isDeclineRow(row: PickSourceScanRow): boolean {
  return row.role === 'system' && /proposal declined/i.test(row.content)
}

/**
 * Decide whether a case has an OPEN, actionable pick_source proposal. Mirrors
 * findOpenProposal (lib/investigator/resolution.ts): the LATEST propose_pick_source
 * with no later "Proposal declined" system row, and not on a resolved case. PURE — the
 * UI uses this to decide whether to render the pick-source confirm card; resolve.ts
 * uses it to guard double-execution. Returns the open proposal (with its message
 * position) or null.
 */
export function findOpenPickSourcePlan(
  rows: PickSourceScanRow[],
  caseStatus: string,
): OpenPickSourceProposal | null {
  if (caseStatus === 'resolved') return null

  let latest: OpenPickSourceProposal | null = null
  for (const row of rows) {
    if (row.role !== 'assistant') continue
    const call = findPickSourceCall(row.tool_calls)
    if (!call) continue
    const input = parsePickSourceInput(call.input)
    if (!input) continue
    latest = { input, position: row.position, tool_use_id: call.id }
  }
  if (!latest) return null

  for (const row of rows) {
    if (row.position > latest.position && isDeclineRow(row)) return null
  }

  return latest
}
