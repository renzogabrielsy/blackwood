'use server'

/**
 * cases.ts — the case-persistence fan-out for the Smart Held-Row Adjudicator (P1).
 *
 * A terminal sync run's held rows live only inside sync_runs.result JSONB. This
 * action projects them into durable `sync_held_cases` rows — one per DISTINCT
 * discrepancy (deduped by fingerprint) — so a held row can be investigated,
 * discussed, and remembered across runs.
 *
 * IDEMPOTENT: both the sync modal AND the review page call ensureCasesForRun for
 * the same run, possibly repeatedly. Re-calling for the same run must NOT double
 * anything (occurrence_count only bumps when a DIFFERENT run re-raises the case).
 *
 * All reads/writes use the service-role admin client — these tables are
 * service-role-write only (RLS denies authenticated writes), exactly like
 * sync_runs. The auth guard (requirePrivileged) gates WHO may trigger the fan-out.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePrivileged } from '@/lib/sync/privileged'
import {
  caseFingerprint,
  sourceDiffFingerprint,
  sourceDiffNaturalKey,
} from '@/lib/sync/fingerprint'
import { collectHeldRows, collectSourceDiffs } from '@/lib/sync/cases-fold'
import {
  runInvestigation,
  type InvestigationOutcome,
  type RunInvestigationOpts,
} from '@/lib/investigator/loop'
import { runTriage, type RunTriageOutcome } from '@/lib/investigator/triage'
import type { Database, Json } from '@/types/supabase'

import type { SourceDiff, SyncRunResult, SyncRunStatus } from './types'

type CaseInsert = Database['public']['Tables']['sync_held_cases']['Insert']
type CaseUpdate = Database['public']['Tables']['sync_held_cases']['Update']

/** The terminal run statuses whose held rows we persist. */
const TERMINAL_FANOUT_STATUSES: SyncRunStatus[] = ['succeeded', 'failed', 'partial']

export interface EnsureCasesResult {
  /** Cases created for the first time by this call. */
  created: number
  /** Existing cases whose last_run_id / last_seen_at we refreshed. */
  refreshed: number
  /** Newly-created cases that matched a prior ruling (pre-annotated). */
  knownMatched: number
  /** Every case id this call touched (created or refreshed). */
  caseIds: string[]
}

/**
 * Persist every held row of a terminal run into durable cases (idempotent).
 */
export async function ensureCasesForRun(runId: string): Promise<EnsureCasesResult> {
  await requirePrivileged()
  const admin = createAdminClient()

  const empty: EnsureCasesResult = { created: 0, refreshed: 0, knownMatched: 0, caseIds: [] }

  // 1. Load the run. No-op unless it is terminal AND carries per-report results.
  const { data: run, error: runErr } = await admin
    .from('sync_runs')
    .select('id, status, result')
    .eq('id', runId)
    .single()
  if (runErr || !run) return empty
  if (!TERMINAL_FANOUT_STATUSES.includes(run.status as SyncRunStatus)) return empty

  const result = (run.result ?? null) as SyncRunResult | null
  // A run with NO per-report `reports` AND no reconciliation channel has nothing to fan
  // out. (Pre-R2 runs / M0/M1 manifests still short-circuit here.)
  if (!result || (!result.reports && !result.reconciliation)) return empty

  // 2. Flatten the two case sources: held rows (per report) + R2 source_diffs.
  const collected = result.reports ? collectHeldRows(result) : []
  const diffs = collectSourceDiffs(result)
  if (!collected.length && !diffs.length) return empty

  let created = 0
  let refreshed = 0
  let knownMatched = 0
  const caseIds: string[] = []
  const now = new Date().toISOString()

  /**
   * Upsert ONE case by fingerprint (the idempotent spine shared by held rows and
   * source_diffs): refresh an existing case (bumping occurrence only on a NEW run) or
   * insert a fresh one, pre-annotated from the rulings ledger. Mutates the tallies above.
   */
  async function upsertCase(fields: {
    fingerprint: string
    report_type: string
    kind: string
    natural_key: string
    reason: string | null
    detail: string | null
    row: Json
  }): Promise<void> {
    const { fingerprint } = fields

    // 3a. Does a case for this fingerprint already exist?
    const { data: existing, error: exErr } = await admin
      .from('sync_held_cases')
      .select('id, last_run_id, occurrence_count')
      .eq('fingerprint', fingerprint)
      .maybeSingle()
    if (exErr) {
      throw new Error(`case lookup failed for ${fingerprint}: ${exErr.message}`)
    }

    if (existing) {
      // EXISTS → refresh. Bump occurrence ONLY when a DIFFERENT run re-raised it
      // (avoids double-count when the modal + review page both call for one run).
      const isNewRun = existing.last_run_id !== runId
      const update: CaseUpdate = {
        last_run_id: runId,
        last_seen_at: now,
        updated_at: now,
      }
      if (isNewRun) {
        update.occurrence_count = (existing.occurrence_count ?? 1) + 1
      }
      const { error: upErr } = await admin
        .from('sync_held_cases')
        .update(update)
        .eq('id', existing.id)
      if (upErr) throw new Error(`case refresh failed for ${existing.id}: ${upErr.message}`)
      refreshed++
      caseIds.push(existing.id)
      return
    }

    // 3b. NOT EXISTS → check the rulings ledger for a matching known issue.
    const { data: ruling, error: rulErr } = await admin
      .from('sync_case_rulings')
      .select('id')
      .eq('fingerprint', fingerprint)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (rulErr) {
      throw new Error(`ruling lookup failed for ${fingerprint}: ${rulErr.message}`)
    }

    const insert: CaseInsert = {
      fingerprint,
      report_type: fields.report_type,
      kind: fields.kind,
      natural_key: fields.natural_key,
      reason: fields.reason,
      detail: fields.detail,
      row: fields.row,
      first_run_id: runId,
      last_run_id: runId,
      occurrence_count: 1,
      last_seen_at: now,
      status: 'open', // pre-annotated (known_ruling_id) but NOT silenced
      known_ruling_id: ruling?.id ?? null,
    }
    const { data: inserted, error: insErr } = await admin
      .from('sync_held_cases')
      .insert(insert)
      .select('id')
      .single()
    if (insErr || !inserted) {
      throw new Error(`case insert failed for ${fingerprint}: ${insErr?.message ?? 'no row returned'}`)
    }
    created++
    if (ruling?.id) knownMatched++
    caseIds.push(inserted.id)
  }

  // 3. Fold held rows.
  for (const { reportType, held } of collected) {
    await upsertCase({
      fingerprint: caseFingerprint(reportType, held),
      report_type: reportType,
      kind: held.kind ?? 'other',
      natural_key: held.natural_key,
      reason: held.reason ?? null,
      detail: held.detail ?? null,
      row: (held.row ?? null) as Json,
    })
  }

  // 4. Fold R2 SHADOW source_diffs (kind='source_diff', report_type='rc_out'). These
  // ride the SAME rails as held cases — run-triage clusters them and the generic case
  // detail renders them (the per-field PICK control is R3). Idempotent by fingerprint.
  for (const diff of diffs) {
    await upsertCase({
      fingerprint: sourceDiffFingerprint(diff),
      report_type: diff.table, // 'rc_out'
      kind: 'source_diff',
      natural_key: sourceDiffNaturalKey(diff),
      reason: sourceDiffReason(diff),
      detail: sourceDiffDetail(diff),
      row: diff as unknown as Json,
    })
  }

  return { created, refreshed, knownMatched, caseIds }
}

/** Plain one-line reason for a source_diff case (no ₱ — weights only). */
function sourceDiffReason(diff: SourceDiff): string {
  const srcs = diff.sources.map((s) => s.source).sort().join(' vs ')
  const field = diff.field === 'weight_kg' ? 'weight' : diff.field
  return `sources disagree on ${field} (${srcs})`
}

/** Plain detail listing each source's competing value + the advisory recommendation. */
function sourceDiffDetail(diff: SourceDiff): string {
  const unit = diff.field === 'weight_kg' ? ' kg' : ''
  const parts = diff.sources.map((s) => {
    const v = typeof s.value === 'number' ? s.value.toLocaleString('en-US') : String(s.value)
    return `${s.source} ${v}${unit}`
  })
  const rec = diff.recommended ? ` — recommended: ${diff.recommended.source} (advisory only)` : ''
  return parts.join(' vs ') + rec
}

/** One open case joined with its known ruling's plain-language summary (if any). */
export interface OpenCaseRow {
  id: string
  fingerprint: string
  report_type: string
  kind: string
  natural_key: string
  reason: string | null
  detail: string | null
  row: unknown
  status: string
  occurrence_count: number
  first_run_id: string
  last_run_id: string
  last_seen_at: string
  created_at: string
  updated_at: string
  known_ruling_id: string | null
  /** verdict_summary of the pre-annotating ruling (null when none). */
  known_ruling_summary: string | null
  /** The persisted investigation verdict (P3), or null if not yet investigated. */
  verdict: unknown
}

/**
 * All not-yet-resolved cases, newest first. Pre-annotating ruling summaries are
 * joined via the known_ruling_id FK (a relational select).
 */
export async function listOpenCases(): Promise<OpenCaseRow[]> {
  await requirePrivileged()
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('sync_held_cases')
    .select(
      'id, fingerprint, report_type, kind, natural_key, reason, detail, row, status, occurrence_count, first_run_id, last_run_id, last_seen_at, created_at, updated_at, known_ruling_id, verdict, sync_case_rulings!sync_held_cases_known_ruling_id_fkey(verdict_summary)',
    )
    .neq('status', 'resolved')
    .order('last_seen_at', { ascending: false })
  if (error) throw new Error(`listOpenCases failed: ${error.message}`)

  return (data ?? []).map((r) => {
    const rel = r.sync_case_rulings as { verdict_summary?: string } | { verdict_summary?: string }[] | null
    const summary = Array.isArray(rel) ? rel[0]?.verdict_summary ?? null : rel?.verdict_summary ?? null
    return {
      id: r.id,
      fingerprint: r.fingerprint,
      report_type: r.report_type,
      kind: r.kind,
      natural_key: r.natural_key,
      reason: r.reason,
      detail: r.detail,
      row: r.row,
      status: r.status,
      occurrence_count: r.occurrence_count,
      first_run_id: r.first_run_id,
      last_run_id: r.last_run_id,
      last_seen_at: r.last_seen_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
      known_ruling_id: r.known_ruling_id,
      known_ruling_summary: summary,
      verdict: r.verdict,
    }
  })
}

export interface CaseMessageRow {
  id: string
  case_id: string
  role: string
  content: string
  tool_calls: unknown
  tool_results: unknown
  position: number
  created_at: string
}

/** A single case plus its full message transcript (position ascending). */
export async function getCaseWithMessages(caseId: string): Promise<{
  case: Record<string, unknown> | null
  messages: CaseMessageRow[]
}> {
  await requirePrivileged()
  const admin = createAdminClient()

  const { data: theCase, error: caseErr } = await admin
    .from('sync_held_cases')
    .select('*')
    .eq('id', caseId)
    .maybeSingle()
  if (caseErr) throw new Error(`getCase failed: ${caseErr.message}`)

  const { data: messages, error: msgErr } = await admin
    .from('sync_case_messages')
    .select('id, case_id, role, content, tool_calls, tool_results, position, created_at')
    .eq('case_id', caseId)
    .order('position', { ascending: true })
  if (msgErr) throw new Error(`getCaseMessages failed: ${msgErr.message}`)

  return { case: theCase ?? null, messages: (messages ?? []) as CaseMessageRow[] }
}

// ============================================================================
// P3 — the investigator auto-trigger
// ============================================================================

/**
 * Investigate ONE case (privileged-gated wrapper around the loop). The loop itself
 * is single-flight: a concurrent call, an already-investigated case, or a
 * known-ruling match returns `skipped` without burning a token.
 *
 * opts.escalate → run on Opus 4.8 instead of Sonnet (the "re-investigate / escalate"
 * button). opts.force → re-investigate even if already done / known-ruled.
 */
export async function investigateCase(
  caseId: string,
  opts?: RunInvestigationOpts,
): Promise<InvestigationOutcome> {
  await requirePrivileged()
  return runInvestigation(caseId, opts)
}

export interface AutoInvestigateResult {
  /** Cases the run fanned out (created or refreshed). */
  cases: number
  /** Cases whose investigation reached a verdict this call. */
  investigated: number
  /** Cases skipped (already investigating/investigated, or a known ruling). */
  skipped: number
  /** Cases whose investigation errored. */
  errors: number
  /** The run-triage synthesis outcome (v1.1). 'skipped' when the run had zero flags. */
  triage: RunTriageOutcome
}

/**
 * Fan a terminal run out into cases, then auto-investigate every fresh, not-yet-ruled
 * open case with a small concurrency pool. Fired (fire-and-forget) by the sync modal
 * on run completion — by the time Renzo opens the review page, cited verdicts are
 * already waiting.
 *
 * Idempotent by construction: ensureCasesForRun dedupes by fingerprint, and the loop's
 * single-flight guard means a second fan-out re-investigates nothing already handled.
 * Known-ruling cases are NOT investigated (they reuse the prior verdict).
 */
export async function autoInvestigateRun(runId: string): Promise<AutoInvestigateResult> {
  await requirePrivileged()

  // ensureCasesForRun is itself privileged; calling it here is fine (same guard).
  const ensured = await ensureCasesForRun(runId)
  const admin = createAdminClient()

  // Only investigate cases that are OPEN and have NO known ruling. Re-fetch status
  // from the DB (a refreshed case may already be investigated/resolved).
  const targets: string[] = []
  for (const id of ensured.caseIds) {
    const { data } = await admin
      .from('sync_held_cases')
      .select('status, known_ruling_id')
      .eq('id', id)
      .maybeSingle()
    if (data && data.status === 'open' && !data.known_ruling_id) targets.push(id)
  }

  let investigated = 0
  let skipped = 0
  let errors = 0

  // Simple promise pool, concurrency 2.
  const CONCURRENCY = 2
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const id = targets[cursor++]
      const outcome = await runInvestigation(id)
      if (outcome.status === 'done') investigated++
      else if (outcome.status === 'skipped') skipped++
      else errors++
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()))

  // After the investigation pool settles, synthesize the run-level triage (v1.1).
  // Reads every non-triage case of the run (now carrying fresh verdicts) and clusters
  // them by root cause. Skipped for a clean run (zero cases). Never throws — a triage
  // failure is surfaced in the outcome, not raised (the investigations already landed).
  const triage = await runTriage(runId)

  return { cases: ensured.caseIds.length, investigated, skipped, errors, triage }
}

/**
 * Re-triage a run on demand (the "re-triage" button). requirePrivileged; forces a
 * fresh synthesis pass over the run's current cases, replacing the triage case's
 * verdict/row and appending a fresh system note (idempotent by fingerprint upsert).
 * Skipped for a run with zero non-triage cases.
 */
export async function triageRun(runId: string): Promise<RunTriageOutcome> {
  await requirePrivileged()
  return runTriage(runId)
}
