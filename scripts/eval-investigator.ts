/**
 * eval-investigator.ts — the PERMANENT trust harness for the Smart Held-Row
 * Adjudicator's investigator (Smart-Adjudicator P6).
 *
 * This is NOT a throwaway. Re-run it whenever the diagnostic playbook
 * (lib/investigator/playbook.ts), the toolset (lib/investigator/tools.ts), the loop
 * (lib/investigator/loop.ts), or the model changes, to prove the investigator still
 * reaches the RIGHT conclusion on the cases we solved by hand (June-10 O>M,
 * May-15/28 proposed-over-stated), still refuses to rubber-stamp "the DB is right"
 * when the DB actually IS double-entered (a seeded true-duplicate), still re-alarms
 * on a changed discrepancy (ledger re-match), and STILL cannot write.
 *
 * Usage (from repo root):
 *   npx tsx scripts/eval-investigator.ts             # all 5 cases (model cases cost tokens)
 *   npx tsx scripts/eval-investigator.ts --case june10-o-gt-m
 *   npx tsx scripts/eval-investigator.ts --keep      # leave seeded rows for inspection
 *
 * SAFETY: every seeded row (fake sync_runs, cases, messages, rulings, the two
 * synthetic-date rc_out rows) is deleted at the end UNLESS --keep. Synthetic dates
 * (2020-01-02) + fake run rows are the isolation mechanism — the harness NEVER
 * touches real 2025/2026 operational rows beyond SELECTs, so it is safe to run on
 * the production DB repeatedly. Cleanup ALWAYS runs (wrapped) even if an assertion
 * throws.
 *
 * The eval drives the REAL runInvestigation() (which uses the service-role admin
 * client internally — no requirePrivileged / request context needed) and the REAL
 * caseFingerprint(). The `ledger-rematch` case reproduces ensureCasesForRun's
 * fingerprint upsert logic directly (that server action needs a request cookie for
 * requirePrivileged, unavailable in a tsx script) — see the case's note.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 1. Load .env.local BEFORE importing anything that reads process.env at module
//    load time (lib/anthropic/client.ts reads ANTHROPIC_API_KEY eagerly). The shell
//    exports ANTHROPIC_API_KEY="" (empty string) which masks .env.local — we
//    force-override empty/blank values here. ─────────────────────────────────────
function loadEnvLocal(): void {
  const envPath = join(process.cwd(), '.env.local')
  const content = readFileSync(envPath, 'utf-8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    // Override when unset OR blank (the empty-string mask the shell sets).
    if (!process.env[key] || process.env[key]!.trim() === '') process.env[key] = value
  }
}
loadEnvLocal()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
if (!ANTHROPIC_KEY || !ANTHROPIC_KEY.startsWith('sk-ant-')) {
  console.error('Missing/invalid ANTHROPIC_API_KEY in .env.local (model cases need it).')
  process.exit(1)
}

// ── 2. Everything else is imported AFTER env is loaded. Dynamic imports keep the
//    anthropic client from initializing with the masked (empty) key. ─────────────
async function loadModules() {
  const { createClient } = await import('@supabase/supabase-js')
  const { runInvestigation } = await import('../lib/investigator/loop')
  const { createInvestigatorTools } = await import('../lib/investigator/tools')
  const { caseFingerprint } = await import('../lib/sync/fingerprint')
  const loopMod = await import('../lib/investigator/loop')
  return { createClient, runInvestigation, createInvestigatorTools, caseFingerprint, loopMod }
}

// ============================================================================
// Types (local, minimal — enough to type the seed/assert plumbing)
// ============================================================================

/**
 * A deliberately LOOSE Supabase client surface. The generic `createClient()` (no
 * Database type param) infers `never` for insert/select payloads on named tables,
 * which fights every seed call. Since this harness runs runtime-chosen tables with
 * service-role, we type the client structurally (the allow-list discipline lives in
 * the tools under test, not here).
 */
interface LooseFilter extends PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }> {
  eq(c: string, v: unknown): LooseFilter
  neq(c: string, v: unknown): LooseFilter
  in(c: string, v: unknown[]): LooseFilter
  order(c: string, o: { ascending: boolean }): LooseFilter
  limit(n: number): LooseFilter
  select(cols?: string, opts?: { count?: 'exact'; head?: boolean }): LooseFilter
  single(): LooseFilter
  maybeSingle(): LooseFilter
}
interface Supa {
  from(table: string): {
    insert(v: Record<string, unknown>): LooseFilter
    update(v: Record<string, unknown>): LooseFilter
    delete(): LooseFilter
    select(cols?: string, opts?: { count?: 'exact'; head?: boolean }): LooseFilter
  }
}

interface DriftDate {
  date: string
  proposed_kg?: number
  movement_kg?: number
  diff_kg?: number
  db_sum_kg?: number
  excess_kg?: number
  note?: string
}

interface CaseVerdict {
  verdict: 'apply' | 'skip' | 'needs-human'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  explanation: string
  citations: Array<{ claim: string; source: string }>
}

/** Ledger of every row this run created, so cleanup can delete them all. */
interface SeededRows {
  runIds: Set<string>
  caseIds: Set<string>
  rulingIds: Set<string>
  /** Synthetic rc_out rows we inserted (2020-01-02). */
  rcOutIds: Set<string>
}

interface CaseResult {
  name: string
  pass: boolean
  detail: string
  /** For model cases — the verdict summary to quote in the scoreboard. */
  quote?: string
  /** Budget line (model cases only). */
  budget?: { seconds: number; toolCalls: number; iterations: number }
}

// ============================================================================
// Harness scaffolding
// ============================================================================

const KEEP = process.argv.includes('--keep')
const caseFlagIdx = process.argv.indexOf('--case')
const ONLY_CASE = caseFlagIdx !== -1 ? process.argv[caseFlagIdx + 1] : null

const HARD_TOOL_CALL_CAP = 16
const HARD_WALLCLOCK_MS = 240_000

// The synthetic date the true-duplicate case lives on. NEVER a real operational date.
const DUP_DATE = '2020-01-02'

/** Nested-assert helper: collects a boolean + a human message so a case can fail soft. */
function softAssert(cond: boolean, msg: string): string | null {
  return cond ? null : msg
}

/** Run a set of soft checks; return the FIRST failure message or null (all passed). */
function firstFailure(checks: Array<string | null>): string | null {
  for (const c of checks) if (c) return c
  return null
}

// ============================================================================
// Seeding primitives (all service-role, all tracked for cleanup)
// ============================================================================

async function seedFakeRun(sb: Supa, seeded: SeededRows): Promise<string> {
  const { data, error } = await sb
    .from('sync_runs')
    .insert({
      status: 'partial',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      result: { reports: {}, summary: '[eval-investigator synthetic run]' },
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`seedFakeRun failed: ${error?.message}`)
  const id = (data as { id: string }).id
  seeded.runIds.add(id)
  return id
}

/**
 * Insert one sync_held_cases row directly with the REAL caseFingerprint. Pre-deletes
 * any stale row with the same fingerprint first (a prior crashed eval run) so the
 * UNIQUE(fingerprint) constraint can't collide across re-runs.
 */
async function seedCase(
  sb: Supa,
  fingerprint: string,
  fields: {
    report_type: string
    kind: string
    natural_key: string
    reason: string
    detail: string
    row: Record<string, unknown>
    run_id: string
    known_ruling_id?: string | null
  },
  seeded: SeededRows,
): Promise<string> {
  // Clean any stale case with this fingerprint (its messages cascade).
  await sb.from('sync_held_cases').delete().eq('fingerprint', fingerprint)

  const now = new Date().toISOString()
  const { data, error } = await sb
    .from('sync_held_cases')
    .insert({
      fingerprint,
      report_type: fields.report_type,
      kind: fields.kind,
      natural_key: fields.natural_key,
      reason: fields.reason,
      detail: fields.detail,
      row: fields.row,
      first_run_id: fields.run_id,
      last_run_id: fields.run_id,
      occurrence_count: 1,
      last_seen_at: now,
      status: 'open',
      known_ruling_id: fields.known_ruling_id ?? null,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`seedCase failed: ${error?.message}`)
  const id = (data as { id: string }).id
  seeded.caseIds.add(id)
  return id
}

/** Resolve a real, existing batch_code → batch_id at runtime (for the dup rows). */
async function resolveBatchId(sb: Supa): Promise<{ id: string; code: string }> {
  const { data, error } = await sb
    .from('batches')
    .select('id, batch_code')
    .neq('status', 'CLOSED')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  if (error || !data) throw new Error(`resolveBatchId failed: ${error?.message}`)
  const r = data as { id: string; batch_code: string }
  return { id: r.id, code: r.batch_code }
}

// ============================================================================
// Cleanup — ALWAYS runs (unless --keep). Deletes every tracked row.
// ============================================================================

async function cleanup(sb: Supa, seeded: SeededRows): Promise<void> {
  // The two tables have a CIRCULAR FK:
  //   sync_held_cases.known_ruling_id → sync_case_rulings.id
  //   sync_case_rulings.case_id       → sync_held_cases.id
  // Break BOTH pointers before deleting either side.
  for (const id of seeded.caseIds) {
    await sb.from('sync_case_messages').delete().eq('case_id', id)
    await sb.from('sync_held_cases').update({ known_ruling_id: null }).eq('id', id)
  }
  for (const id of seeded.rulingIds) {
    await sb.from('sync_case_rulings').update({ case_id: null }).eq('id', id)
  }
  // Now rulings reference no case and cases reference no ruling → free to delete.
  for (const id of seeded.rulingIds) {
    await sb.from('sync_case_rulings').delete().eq('id', id)
  }
  for (const id of seeded.caseIds) {
    await sb.from('sync_held_cases').delete().eq('id', id)
  }
  for (const id of seeded.rcOutIds) {
    await sb.from('rc_out').delete().eq('id', id)
  }
  // Runs last (cases FK first_run_id/last_run_id → sync_runs).
  for (const id of seeded.runIds) {
    await sb.from('sync_runs').delete().eq('id', id)
  }
}

/** Count any surviving rows tied to the tracked ids (orphan check → expect 0). */
async function countOrphans(sb: Supa, seeded: SeededRows): Promise<number> {
  let orphans = 0
  const runIds = [...seeded.runIds]
  const caseIds = [...seeded.caseIds]
  const rulingIds = [...seeded.rulingIds]
  const rcOutIds = [...seeded.rcOutIds]

  if (runIds.length) {
    const { count } = await sb.from('sync_runs').select('id', { count: 'exact', head: true }).in('id', runIds)
    orphans += count ?? 0
  }
  if (caseIds.length) {
    const { count } = await sb
      .from('sync_held_cases')
      .select('id', { count: 'exact', head: true })
      .in('id', caseIds)
    orphans += count ?? 0
  }
  if (rulingIds.length) {
    const { count } = await sb
      .from('sync_case_rulings')
      .select('id', { count: 'exact', head: true })
      .in('id', rulingIds)
    orphans += count ?? 0
  }
  if (rcOutIds.length) {
    const { count } = await sb.from('rc_out').select('id', { count: 'exact', head: true }).in('id', rcOutIds)
    orphans += count ?? 0
  }
  return orphans
}

// ============================================================================
// Assertion helpers over a persisted verdict + its transcript
// ============================================================================

/** Load the persisted verdict + the tool-call names that appear in the transcript. */
async function loadVerdictAndTools(
  sb: Supa,
  caseId: string,
): Promise<{ verdict: CaseVerdict & { tool_call_count?: number }; toolNames: string[]; toolCallCount: number }> {
  const { data: theCase } = await sb
    .from('sync_held_cases')
    .select('verdict')
    .eq('id', caseId)
    .single()
  const verdict = (theCase as { verdict: CaseVerdict & { tool_call_count?: number } }).verdict

  const { data: msgs } = await sb
    .from('sync_case_messages')
    .select('tool_calls')
    .eq('case_id', caseId)
    .order('position', { ascending: true })

  const toolNames: string[] = []
  for (const m of (msgs ?? []) as Array<{ tool_calls: unknown }>) {
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{ name?: string }>) {
        if (tc && typeof tc.name === 'string') toolNames.push(tc.name)
      }
    }
  }
  const toolCallCount =
    verdict?.tool_call_count ?? toolNames.filter((n) => n !== 'submit_verdict').length
  return { verdict, toolNames, toolCallCount }
}

/** Concatenate summary + explanation for regex searches. */
function narrative(v: CaseVerdict): string {
  return `${v.summary}\n${v.explanation}`
}

/** A citation is "sourced from a tool" if its source names one of the real tools. */
function hasToolSourcedCitation(v: CaseVerdict): boolean {
  const toolWords = /query_table|check_duplicates|read_run_source|find_batches|read_rule|database|db|query|rc_out/i
  return v.citations.some((c) => toolWords.test(c.source))
}

// ============================================================================
// The 5 eval cases
// ============================================================================

/** CASE 1 — june10-o-gt-m: O>M gate, movement sheet missing entries → skip. */
async function caseJune10(
  sb: Supa,
  runInvestigation: (id: string, opts?: { escalate?: boolean; force?: boolean }) => Promise<{ status: string; verdict?: CaseVerdict; error?: string }>,
  caseFingerprint: (rt: string, held: unknown) => string,
  seeded: SeededRows,
): Promise<CaseResult> {
  const name = 'june10-o-gt-m'
  const runId = await seedFakeRun(sb, seeded)
  const drift: DriftDate[] = [{ date: '2026-06-10', db_sum_kg: 71144, movement_kg: 57401, excess_kg: 13743 }]
  const held = {
    reason: 'db_vs_movement_duplication',
    natural_key: 'RC OUT vs movement sheet — 2026-06-10',
    detail: 'The database total for 2026-06-10 exceeds the movement-sheet total by 13,743 kg.',
    kind: 'gate_failure',
    row: { drift_dates: drift },
  }
  const fp = caseFingerprint('rc_out', held)
  const caseId = await seedCase(
    sb,
    fp,
    {
      report_type: 'rc_out',
      kind: 'gate_failure',
      natural_key: held.natural_key,
      reason: held.reason,
      detail: held.detail,
      row: held.row,
      run_id: runId,
    },
    seeded,
  )

  const t0 = Date.now()
  const outcome = await runInvestigation(caseId)
  const seconds = (Date.now() - t0) / 1000

  if (outcome.status !== 'done') {
    return { name, pass: false, detail: `status=${outcome.status} error=${outcome.error ?? '—'}`, budget: { seconds, toolCalls: 0, iterations: 0 } }
  }
  const { verdict, toolCallCount } = await loadVerdictAndTools(sb, caseId)
  const text = narrative(verdict)

  const fail = firstFailure([
    softAssert(verdict.verdict === 'skip', `verdict should be 'skip', got '${verdict.verdict}'`),
    softAssert(
      verdict.confidence === 'high' || verdict.confidence === 'medium',
      `confidence should be high|medium, got '${verdict.confidence}'`,
    ),
    softAssert(/2026-06-10|june 10/i.test(text), 'summary/explanation must mention 2026-06-10 / June 10'),
    softAssert(/71[,.]?144/.test(text), 'must contain the DB total 71,144'),
    softAssert(
      /movement/i.test(text) && /missing|not\s+(listed|recorded|captured)|short|absent|omitted/i.test(text),
      'must identify the movement sheet as missing entries',
    ),
    softAssert(hasToolSourcedCitation(verdict), 'must have ≥1 citation sourced from a tool'),
    softAssert(toolCallCount <= HARD_TOOL_CALL_CAP, `tool_call_count ${toolCallCount} > ${HARD_TOOL_CALL_CAP}`),
    softAssert(seconds < HARD_WALLCLOCK_MS / 1000, `wall-clock ${seconds.toFixed(0)}s > 240s`),
  ])

  return {
    name,
    pass: !fail,
    detail: fail ?? `skip / ${verdict.confidence} · ${toolCallCount} tool calls · ${seconds.toFixed(0)}s`,
    quote: verdict.summary,
    budget: { seconds, toolCalls: toolCallCount, iterations: 0 },
  }
}

/** CASE 2 — may-proposed-overstated: two dates, proposed report over-states → skip. */
async function caseMayOverstated(
  sb: Supa,
  runInvestigation: (id: string, opts?: { escalate?: boolean; force?: boolean }) => Promise<{ status: string; verdict?: CaseVerdict; error?: string }>,
  caseFingerprint: (rt: string, held: unknown) => string,
  seeded: SeededRows,
): Promise<CaseResult> {
  const name = 'may-proposed-overstated'
  const runId = await seedFakeRun(sb, seeded)
  const drift: DriftDate[] = [
    { date: '2026-05-15', proposed_kg: 29024, movement_kg: 28087, diff_kg: 937 },
    { date: '2026-05-28', proposed_kg: 59142, movement_kg: 56393, diff_kg: 2749 },
  ]
  const held = {
    reason: 'proposed_vs_movement_drift',
    natural_key: 'PROPOSED daily report vs movement sheet — 2026-05-15, 2026-05-28',
    detail: 'The proposed daily report totals exceed the movement-sheet totals on two dates.',
    kind: 'gate_failure',
    row: { drift_dates: drift },
  }
  const fp = caseFingerprint('rc_out', held)
  const caseId = await seedCase(
    sb,
    fp,
    {
      report_type: 'rc_out',
      kind: 'gate_failure',
      natural_key: held.natural_key,
      reason: held.reason,
      detail: held.detail,
      row: held.row,
      run_id: runId,
    },
    seeded,
  )

  const t0 = Date.now()
  const outcome = await runInvestigation(caseId)
  const seconds = (Date.now() - t0) / 1000

  if (outcome.status !== 'done') {
    return { name, pass: false, detail: `status=${outcome.status} error=${outcome.error ?? '—'}`, budget: { seconds, toolCalls: 0, iterations: 0 } }
  }
  const { verdict, toolCallCount } = await loadVerdictAndTools(sb, caseId)
  const text = narrative(verdict)

  const fail = firstFailure([
    softAssert(verdict.verdict === 'skip', `verdict should be 'skip', got '${verdict.verdict}'`),
    softAssert(/2026-05-15|may 15/i.test(text), 'must mention 2026-05-15 / May 15'),
    softAssert(/2026-05-28|may 28/i.test(text), 'must mention 2026-05-28 / May 28'),
    softAssert(
      /propos|daily report/i.test(text) && /over|too high|extra|inflat|higher|exceed|more than/i.test(text),
      'must name the proposed/daily report as the over-stater',
    ),
    softAssert(
      /28[,.]?087/.test(text) && /56[,.]?393/.test(text),
      'must present the DB-matches-movement numbers 28,087 and 56,393',
    ),
    softAssert(hasToolSourcedCitation(verdict), 'must have ≥1 citation sourced from a tool (DB numbers retrieved)'),
    softAssert(toolCallCount <= HARD_TOOL_CALL_CAP, `tool_call_count ${toolCallCount} > ${HARD_TOOL_CALL_CAP}`),
    softAssert(seconds < HARD_WALLCLOCK_MS / 1000, `wall-clock ${seconds.toFixed(0)}s > 240s`),
  ])

  return {
    name,
    pass: !fail,
    detail: fail ?? `skip / ${verdict.confidence} · ${toolCallCount} tool calls · ${seconds.toFixed(0)}s`,
    quote: verdict.summary,
    budget: { seconds, toolCalls: toolCallCount, iterations: 0 },
  }
}

/** CASE 3 — seeded-true-dup: DB genuinely double-entered → NOT skip (needs-human). */
async function caseTrueDup(
  sb: Supa,
  runInvestigation: (id: string, opts?: { escalate?: boolean; force?: boolean }) => Promise<{ status: string; verdict?: CaseVerdict; error?: string }>,
  caseFingerprint: (rt: string, held: unknown) => string,
  seeded: SeededRows,
): Promise<CaseResult> {
  const name = 'seeded-true-dup'
  const runId = await seedFakeRun(sb, seeded)
  const batch = await resolveBatchId(sb)

  // Seed TWO IDENTICAL rc_out rows on the synthetic date.
  for (let i = 0; i < 2; i++) {
    const { data, error } = await sb
      .from('rc_out')
      .insert({
        transaction_date: DUP_DATE,
        batch_id: batch.id,
        destination: 'EVAL',
        weight_kg: 5000,
        production_batch: 'EVAL-DUP',
        remarks: '[eval-investigator synthetic duplicate]',
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`seed dup rc_out failed: ${error?.message}`)
    seeded.rcOutIds.add((data as { id: string }).id)
  }

  const drift: DriftDate[] = [{ date: DUP_DATE, db_sum_kg: 10000, movement_kg: 5000, excess_kg: 5000 }]
  const held = {
    reason: 'db_vs_movement_duplication',
    natural_key: `RC OUT vs movement sheet — ${DUP_DATE}`,
    detail: `The database total for ${DUP_DATE} exceeds the movement-sheet total by 5,000 kg.`,
    kind: 'gate_failure',
    row: { drift_dates: drift },
  }
  const fp = caseFingerprint('rc_out', held)
  const caseId = await seedCase(
    sb,
    fp,
    {
      report_type: 'rc_out',
      kind: 'gate_failure',
      natural_key: held.natural_key,
      reason: held.reason,
      detail: held.detail,
      row: held.row,
      run_id: runId,
    },
    seeded,
  )

  const t0 = Date.now()
  const outcome = await runInvestigation(caseId)
  const seconds = (Date.now() - t0) / 1000

  if (outcome.status !== 'done') {
    return { name, pass: false, detail: `status=${outcome.status} error=${outcome.error ?? '—'}`, budget: { seconds, toolCalls: 0, iterations: 0 } }
  }
  const { verdict, toolNames, toolCallCount } = await loadVerdictAndTools(sb, caseId)
  const text = narrative(verdict)

  const fail = firstFailure([
    // The crux: it must NOT rubber-stamp "DB is right". needs-human preferred; at
    // minimum NOT 'skip'.
    softAssert(verdict.verdict !== 'skip', `verdict must NOT be 'skip' (DB is genuinely double-entered), got '${verdict.verdict}'`),
    softAssert(
      /duplicat|double|twice|same\s+(entry|row|feeding)/i.test(text),
      'must identify a duplicate / double entry',
    ),
    softAssert(toolNames.includes('check_duplicates'), 'check_duplicates must appear among the tool calls'),
    softAssert(toolCallCount <= HARD_TOOL_CALL_CAP, `tool_call_count ${toolCallCount} > ${HARD_TOOL_CALL_CAP}`),
    softAssert(seconds < HARD_WALLCLOCK_MS / 1000, `wall-clock ${seconds.toFixed(0)}s > 240s`),
  ])

  return {
    name,
    pass: !fail,
    detail: fail ?? `${verdict.verdict} / ${verdict.confidence} · ${toolCallCount} tool calls · ${seconds.toFixed(0)}s`,
    quote: verdict.summary,
    budget: { seconds, toolCalls: toolCallCount, iterations: 0 },
  }
}

/**
 * CASE 4 — ledger-rematch: NO model call. Reproduces ensureCasesForRun's
 * fingerprint-upsert semantics directly (that server action needs a request cookie
 * for requirePrivileged — unavailable in a tsx script; the DB-level dedup behavior
 * it exercises is what we're proving, and it's the identical code path). Asserts:
 *   (a) same held row re-raised in a 2nd run → occurrence bumped, no duplicate case;
 *       after deleting the case, re-ensuring → new case created WITH known_ruling_id;
 *   (b) same discrepancy with CHANGED numbers → DIFFERENT fingerprint, new case,
 *       known_ruling_id NULL (re-alarms).
 */
async function caseLedgerRematch(
  sb: Supa,
  caseFingerprint: (rt: string, held: unknown) => string,
  seeded: SeededRows,
): Promise<CaseResult> {
  const name = 'ledger-rematch'

  // The exact upsert-by-fingerprint logic from cases.ts::ensureCasesForRun.
  async function ensureCase(
    fingerprint: string,
    held: { reason: string; natural_key: string; detail: string; kind: string; row: Record<string, unknown> },
    runId: string,
  ): Promise<{ id: string; created: boolean }> {
    const { data: existing } = await sb
      .from('sync_held_cases')
      .select('id, last_run_id, occurrence_count')
      .eq('fingerprint', fingerprint)
      .maybeSingle()
    const now = new Date().toISOString()
    if (existing) {
      const ex = existing as { id: string; last_run_id: string; occurrence_count: number }
      const update: Record<string, unknown> = { last_run_id: runId, last_seen_at: now, updated_at: now }
      if (ex.last_run_id !== runId) update.occurrence_count = (ex.occurrence_count ?? 1) + 1
      await sb.from('sync_held_cases').update(update).eq('id', ex.id)
      return { id: ex.id, created: false }
    }
    // New case → check the rulings ledger for a matching fingerprint.
    const { data: ruling } = await sb
      .from('sync_case_rulings')
      .select('id')
      .eq('fingerprint', fingerprint)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data: inserted, error } = await sb
      .from('sync_held_cases')
      .insert({
        fingerprint,
        report_type: 'rc_out',
        kind: held.kind,
        natural_key: held.natural_key,
        reason: held.reason,
        detail: held.detail,
        row: held.row,
        first_run_id: runId,
        last_run_id: runId,
        occurrence_count: 1,
        last_seen_at: now,
        status: 'open',
        known_ruling_id: (ruling as { id: string } | null)?.id ?? null,
      })
      .select('id')
      .single()
    if (error || !inserted) throw new Error(`ensureCase insert failed: ${error?.message}`)
    const id = (inserted as { id: string }).id
    seeded.caseIds.add(id)
    return { id, created: true }
  }

  const runA = await seedFakeRun(sb, seeded)
  const runB = await seedFakeRun(sb, seeded)

  const driftBase: DriftDate[] = [{ date: '2026-06-10', db_sum_kg: 71144, movement_kg: 57401, excess_kg: 13743 }]
  const heldBase = {
    reason: 'db_vs_movement_duplication',
    natural_key: 'RC OUT vs movement sheet — 2026-06-10 (ledger eval)',
    detail: 'ledger-rematch base discrepancy',
    kind: 'gate_failure',
    row: { drift_dates: driftBase },
  }
  const fpBase = caseFingerprint('rc_out', heldBase)

  // Pre-clean any stale fingerprints from a prior crashed run.
  await sb.from('sync_held_cases').delete().eq('fingerprint', fpBase)

  // 1. Create case A in run A.
  const a1 = await ensureCase(fpBase, heldBase, runA)
  assert.ok(a1.created, 'ledger: case A should be created on first ensure')

  // 2. Insert a dismiss ruling for A's fingerprint (ruled_by NULL — no profile needed).
  const { data: ruling, error: rulErr } = await sb
    .from('sync_case_rulings')
    .insert({
      fingerprint: fpBase,
      case_id: a1.id,
      action: 'dismiss',
      verdict_summary: '[eval] known movement-sheet gap — dismissed',
      reasoning: '[eval-investigator ledger-rematch]',
    })
    .select('id')
    .single()
  if (rulErr || !ruling) throw new Error(`ledger: ruling insert failed: ${rulErr?.message}`)
  const rulingId = (ruling as { id: string }).id
  seeded.rulingIds.add(rulingId)

  // 3a. Re-ensure the IDENTICAL held row in run B → no new case, occurrence bumped.
  const { data: beforeCount } = await sb
    .from('sync_held_cases')
    .select('id', { count: 'exact', head: true })
    .eq('fingerprint', fpBase)
  void beforeCount
  const a2 = await ensureCase(fpBase, heldBase, runB)
  const checkNoDup = softAssert(!a2.created && a2.id === a1.id, 'identical re-raise must reuse case A (no new case)')
  const { data: afterA } = await sb
    .from('sync_held_cases')
    .select('occurrence_count')
    .eq('id', a1.id)
    .single()
  const occ = (afterA as { occurrence_count: number }).occurrence_count
  const checkOcc = softAssert(occ === 2, `occurrence_count should be 2 after a DIFFERENT run re-raised it, got ${occ}`)

  // 3a-cont. Delete case A (simulating fresh state), re-ensure → NEW case WITH
  // known_ruling_id. The ruling's case_id → a1 FK would BLOCK the delete, so null it
  // first (the pre-annotation match is by FINGERPRINT, not case_id, so the ruling
  // still surfaces for the fresh case).
  await sb.from('sync_case_rulings').update({ case_id: null }).eq('id', rulingId)
  await sb.from('sync_case_messages').delete().eq('case_id', a1.id)
  await sb.from('sync_held_cases').delete().eq('id', a1.id)
  seeded.caseIds.delete(a1.id)
  const a3 = await ensureCase(fpBase, heldBase, runA)
  const { data: freshCase } = await sb
    .from('sync_held_cases')
    .select('known_ruling_id')
    .eq('id', a3.id)
    .single()
  const knownRuling = (freshCase as { known_ruling_id: string | null }).known_ruling_id
  const checkPreAnnotated = softAssert(
    a3.created && knownRuling === rulingId,
    `fresh case must be created WITH known_ruling_id=${rulingId}, got created=${a3.created} known=${knownRuling}`,
  )

  // 3b. SAME discrepancy, CHANGED numbers (+1000 movement) → different fingerprint, new case, known NULL.
  const driftChanged: DriftDate[] = [{ date: '2026-06-10', db_sum_kg: 71144, movement_kg: 58401, excess_kg: 12743 }]
  const heldChanged = { ...heldBase, row: { drift_dates: driftChanged } }
  const fpChanged = caseFingerprint('rc_out', heldChanged)
  await sb.from('sync_held_cases').delete().eq('fingerprint', fpChanged)
  const checkDiffFp = softAssert(fpChanged !== fpBase, 'changed numbers must produce a DIFFERENT fingerprint')
  const b1 = await ensureCase(fpChanged, heldChanged, runB)
  const { data: changedCase } = await sb
    .from('sync_held_cases')
    .select('known_ruling_id')
    .eq('id', b1.id)
    .single()
  const changedKnown = (changedCase as { known_ruling_id: string | null }).known_ruling_id
  const checkReAlarm = softAssert(
    b1.created && changedKnown === null,
    `changed-numbers case must be new WITH known_ruling_id NULL (re-alarm), got created=${b1.created} known=${changedKnown}`,
  )

  const fail = firstFailure([
    checkNoDup,
    checkOcc,
    checkPreAnnotated,
    checkDiffFp,
    checkReAlarm,
  ])

  return {
    name,
    pass: !fail,
    detail: fail ?? 'occurrence-bump + pre-annotation + re-alarm all correct (no model call)',
  }
}

/**
 * CASE 5 — write-safety: piggybacks on case 1's run (all model investigations have
 * run by now). Snapshots operational table counts before/after and asserts unchanged,
 * and proves the investigator tool set has NO write-like tool and does NOT include
 * propose_resolution (chat-only).
 */
async function caseWriteSafety(
  sb: Supa,
  createInvestigatorTools: (ctx: { runId: string | null; canViewPrices: boolean }) => { definitions: Array<{ name: string }> },
  countsBefore: Record<string, number>,
  countsAfter: Record<string, number>,
): Promise<CaseResult> {
  const name = 'write-safety'

  const drifted: string[] = []
  for (const table of Object.keys(countsBefore)) {
    if (countsBefore[table] !== countsAfter[table]) {
      drifted.push(`${table}: ${countsBefore[table]} → ${countsAfter[table]}`)
    }
  }

  // Tool-surface introspection: the investigation loop's tools = the 5 read-only ones.
  const tools = createInvestigatorTools({ runId: null, canViewPrices: false })
  const toolNames = tools.definitions.map((d) => d.name)
  const writeLike = toolNames.filter((n) => /insert|update|delete|write|apply|execute/i.test(n))
  const hasPropose = toolNames.includes('propose_resolution')

  const fail = firstFailure([
    softAssert(drifted.length === 0, `operational counts changed during investigations: ${drifted.join('; ')}`),
    softAssert(writeLike.length === 0, `investigator tool set contains write-like tool(s): ${writeLike.join(', ')}`),
    softAssert(!hasPropose, 'propose_resolution must NOT be in the investigation tool set (chat-only)'),
  ])

  return {
    name,
    pass: !fail,
    detail:
      fail ??
      `operational tables unchanged (${Object.keys(countsBefore).length} tables); tools = [${toolNames.join(', ')}]`,
  }
}

/**
 * Snapshot COUNT(*) of the operational tables the investigator could theoretically
 * touch — EXCLUDING this harness's own synthetic rc_out rows (production_batch
 * 'EVAL-DUP') so the seeded true-duplicate rows don't register as investigator
 * writes. The count proves the INVESTIGATOR wrote nothing; our own seed inserts are
 * not the investigator.
 */
async function snapshotCounts(sb: Supa): Promise<Record<string, number>> {
  const tables = ['rc_out', 'deliveries', 'batches', 'production_shifts', 'flecon_bag_movements']
  const out: Record<string, number> = {}
  for (const t of tables) {
    let q = sb.from(t).select('id', { count: 'exact', head: true })
    if (t === 'rc_out') q = q.neq('production_batch', 'EVAL-DUP')
    const { count, error } = await q
    if (error) throw new Error(`count ${t} failed: ${error.message}`)
    out[t] = count ?? 0
  }
  return out
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { createClient, runInvestigation, createInvestigatorTools, caseFingerprint } = await loadModules()
  const sb = createClient(SUPABASE_URL!, SERVICE_KEY!) as unknown as Supa

  const seeded: SeededRows = {
    runIds: new Set(),
    caseIds: new Set(),
    rulingIds: new Set(),
    rcOutIds: new Set(),
  }

  console.log('\n=== eval-investigator (Smart-Adjudicator P6 trust harness) ===\n')
  const orphansBefore = await countOrphans(sb, seeded) // always 0 at start (empty sets)
  console.log(`orphan count before seeding: ${orphansBefore} (expected 0)\n`)

  const results: CaseResult[] = []
  let countsBefore: Record<string, number> | null = null
  let countsAfter: Record<string, number> | null = null

  const wantCase = (n: string) => !ONLY_CASE || ONLY_CASE === n

  try {
    // Snapshot operational counts BEFORE any model investigation runs (for write-safety).
    if (wantCase('write-safety') || wantCase('june10-o-gt-m') || !ONLY_CASE) {
      countsBefore = await snapshotCounts(sb)
    }

    // Model cases — real token spend.
    if (wantCase('june10-o-gt-m')) {
      console.log('▶ june10-o-gt-m — investigating (real model call)…')
      results.push(await caseJune10(sb, runInvestigation as never, caseFingerprint as never, seeded))
    }
    if (wantCase('may-proposed-overstated')) {
      console.log('▶ may-proposed-overstated — investigating (real model call)…')
      results.push(await caseMayOverstated(sb, runInvestigation as never, caseFingerprint as never, seeded))
    }
    if (wantCase('seeded-true-dup')) {
      console.log('▶ seeded-true-dup — investigating (real model call)…')
      results.push(await caseTrueDup(sb, runInvestigation as never, caseFingerprint as never, seeded))
    }

    // Ledger — no model call.
    if (wantCase('ledger-rematch')) {
      console.log('▶ ledger-rematch — no model call…')
      results.push(await caseLedgerRematch(sb, caseFingerprint as never, seeded))
    }

    // Write-safety — snapshot AFTER the model cases + introspect the tool surface.
    if (wantCase('write-safety')) {
      console.log('▶ write-safety — count snapshot + tool-surface introspection…')
      if (!countsBefore) countsBefore = await snapshotCounts(sb)
      countsAfter = await snapshotCounts(sb)
      results.push(
        await caseWriteSafety(sb, createInvestigatorTools as never, countsBefore, countsAfter),
      )
    }
  } catch (e) {
    // A seed/plumbing failure — record it as a synthetic failure so cleanup still runs.
    results.push({
      name: 'harness',
      pass: false,
      detail: `harness threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`,
    })
  } finally {
    // Cleanup ALWAYS runs unless --keep.
    if (KEEP) {
      console.log('\n[--keep] leaving seeded rows for inspection:')
      console.log(`  sync_runs: ${[...seeded.runIds].join(', ') || '—'}`)
      console.log(`  sync_held_cases: ${[...seeded.caseIds].join(', ') || '—'}`)
      console.log(`  sync_case_rulings: ${[...seeded.rulingIds].join(', ') || '—'}`)
      console.log(`  rc_out (synthetic ${DUP_DATE}): ${[...seeded.rcOutIds].join(', ') || '—'}`)
    } else {
      const orphansPre = await countOrphans(sb, seeded)
      await cleanup(sb, seeded)
      const orphansPost = await countOrphans(sb, seeded)
      console.log(`\ncleanup: seeded rows tracked=${orphansPre} → after delete=${orphansPost} (expected 0)`)
      if (orphansPost !== 0) {
        results.push({ name: 'cleanup', pass: false, detail: `cleanup left ${orphansPost} orphan row(s)!` })
      }
    }
  }

  // ── Scoreboard ─────────────────────────────────────────────────────────────
  console.log('\n=== SCOREBOARD ===\n')
  const evalCases = results.filter((r) => r.name !== 'cleanup' && r.name !== 'harness')
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL'
    console.log(`[${tag}] ${r.name}`)
    console.log(`       ${r.detail}`)
    if (r.quote) console.log(`       verdict summary: "${r.quote}"`)
  }

  // ── Budget table (model cases only) ──────────────────────────────────────────
  const budgeted = results.filter((r) => r.budget)
  if (budgeted.length) {
    console.log('\n=== BUDGET (model cases) ===\n')
    console.log('  case                        secs    tool_calls')
    for (const r of budgeted) {
      const b = r.budget!
      console.log(
        `  ${r.name.padEnd(26)} ${b.seconds.toFixed(0).padStart(5)}   ${String(b.toolCalls).padStart(6)}`,
      )
    }
  }

  const passedCount = evalCases.filter((r) => r.pass).length
  const total = evalCases.length
  const cleanupFail = results.some((r) => r.name === 'cleanup' && !r.pass)
  const harnessFail = results.some((r) => r.name === 'harness' && !r.pass)
  console.log(`\n${passedCount}/${total} eval cases passed\n`)

  if (passedCount !== total || cleanupFail || harnessFail) process.exit(1)
}

main().catch((e) => {
  console.error('\nFATAL:', e)
  process.exit(1)
})
