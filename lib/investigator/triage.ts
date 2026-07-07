/**
 * triage.ts — the RUN TRIAGE synthesis pass (v1.1 Run Triage layer, T1).
 *
 * After a run's per-case investigations settle (autoInvestigateRun), this pass makes
 * ONE Anthropic call (no read-only tools — just a forced `submit_triage`) that reads
 * every one of the run's held cases (kind / key / detail / status / verdict) and
 * GROUPS them by shared root cause, writing a plain-language run summary a plant
 * manager reads first.
 *
 * The result is persisted as a SYNTHETIC case row deliberately reusing the ENTIRE
 * existing case machinery (messages thread, Realtime, chat loop, review page) instead
 * of new tables:
 *   - kind          = 'run_triage'
 *   - fingerprint   = triageFingerprint(runId)   (dedup / idempotent upsert)
 *   - row           = { clusters, case_ids }
 *   - verdict       = { verdict:'needs-human', confidence:'high', summary, … }
 *   - status        = 'investigated'
 *
 * Zero-flag runs get NO triage case (clean runs stay silent).
 *
 * The PURE piece — parseTriage — validates + deterministically REPAIRS the model
 * output (drop unknown ids, dedupe, add missing ids as a singleton needs-attention
 * cluster) and is exported network-free for the verify script.
 */
import { anthropic, INVESTIGATOR_MODEL } from '@/lib/anthropic/client'
import { createAdminClient } from '@/lib/supabase/admin'
import { canonicalHash } from '@/lib/sync/fingerprint'
import type { Json } from '@/types/supabase'

import { BANNED_JARGON } from './playbook'

// ============================================================================
// Public contract
// ============================================================================

/** The synthetic kind that marks a triage case (unconstrained TEXT in the DB). */
export const TRIAGE_KIND = 'run_triage'

/** The report_type stamped on a triage case (it spans the whole run, not one report). */
export const TRIAGE_REPORT_TYPE = 'run'

/** One cluster of sibling cases sharing a root cause. */
export interface TriageCluster {
  title: string
  root_cause: string
  case_ids: string[]
  suggested_action: 'dismiss' | 'needs-attention'
  reasoning: string
}

/** The validated + repaired synthesis output. */
export interface TriageResult {
  summary: string
  clusters: TriageCluster[]
}

export interface RunTriageOutcome {
  status: 'done' | 'skipped' | 'error'
  caseId?: string
  error?: string
}

// ============================================================================
// Fingerprint
// ============================================================================

/**
 * The stable per-run triage fingerprint — sha256 of {kind:'run_triage', runId}
 * through the SHARED canonical hasher (lib/sync/fingerprint.ts::canonicalHash), so a
 * re-run of triage for the same run upserts the SAME row (never a duplicate).
 */
export function triageFingerprint(runId: string): string {
  return canonicalHash({ kind: TRIAGE_KIND, runId })
}

// ============================================================================
// The forced submit_triage tool
// ============================================================================

/** The single forced tool — the model can ONLY answer by calling this. */
export const SUBMIT_TRIAGE_TOOL = {
  name: 'submit_triage',
  description:
    'Report your triage of this whole sync run. Group the flags by SHARED ROOT CAUSE — flags ' +
    'caused by the same underlying thing go in ONE cluster. Every flag (case id) must appear in ' +
    'EXACTLY ONE cluster. Write the summary in plain plant language a manager reads first.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description:
          '2 to 4 plain sentences a plant manager reads first: how many flags, how many real ' +
          'root causes, and what (if anything) needs a person. No jargon.',
      },
      clusters: {
        type: 'array',
        description: 'One entry per root cause. Every case id appears in exactly one cluster.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A short plain name for this group.' },
            root_cause: {
              type: 'string',
              description: 'The one underlying reason these flags all fired, in plain words.',
            },
            case_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'The ids of every case in this group.',
            },
            suggested_action: {
              type: 'string',
              enum: ['dismiss', 'needs-attention'],
              description:
                '"dismiss" — the database is already correct, these can be set aside together. ' +
                '"needs-attention" — a person needs to look (e.g. a real duplicate, an unknown batch).',
            },
            reasoning: {
              type: 'string',
              description: 'Why this group has this root cause and this suggested action.',
            },
          },
          required: ['title', 'root_cause', 'case_ids', 'suggested_action', 'reasoning'],
        },
      },
    },
    required: ['summary', 'clusters'],
  },
}

// ============================================================================
// PURE validation + repair (exported, network-free)
// ============================================================================

/**
 * Validate + deterministically REPAIR the model's submit_triage output against the
 * authoritative set of case ids for this run.
 *
 * Repairs (so the partition invariant ALWAYS holds — every id in exactly one cluster):
 *   - drop any case_id the model invented (not in `validIds`);
 *   - dedupe a case_id that appears in 2+ clusters (keep its FIRST appearance);
 *   - drop a cluster that becomes empty after the above;
 *   - collect every valid id never placed in any cluster and append them as ONE
 *     singleton 'needs-attention' cluster ("Unsorted flags") so nothing is lost.
 *
 * A malformed top-level shape (no summary / no clusters array) → still returns a
 * usable result: an empty-cluster set that the missing-id repair then fills with a
 * single needs-attention cluster holding every id, plus a neutral summary.
 */
export function parseTriage(input: unknown, validIds: string[]): TriageResult {
  const validSet = new Set(validIds)
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

  const rawSummary = typeof o.summary === 'string' ? o.summary.trim() : ''

  const rawClusters = Array.isArray(o.clusters) ? o.clusters : []
  const seen = new Set<string>()
  const clusters: TriageCluster[] = []

  for (const rc of rawClusters) {
    if (!rc || typeof rc !== 'object') continue
    const c = rc as Record<string, unknown>

    const rawIds = Array.isArray(c.case_ids) ? c.case_ids : []
    const ids: string[] = []
    for (const idRaw of rawIds) {
      const id = typeof idRaw === 'string' ? idRaw : String(idRaw)
      if (!validSet.has(id)) continue // drop invented ids
      if (seen.has(id)) continue // dedupe across clusters — first cluster wins
      seen.add(id)
      ids.push(id)
    }
    if (ids.length === 0) continue // drop a cluster left empty after repair

    const action: TriageCluster['suggested_action'] =
      c.suggested_action === 'dismiss' ? 'dismiss' : 'needs-attention'

    clusters.push({
      title: typeof c.title === 'string' && c.title.trim() ? c.title.trim() : 'Flags',
      root_cause:
        typeof c.root_cause === 'string' && c.root_cause.trim()
          ? c.root_cause.trim()
          : 'Not specified.',
      case_ids: ids,
      suggested_action: action,
      reasoning:
        typeof c.reasoning === 'string' && c.reasoning.trim() ? c.reasoning.trim() : 'Not specified.',
    })
  }

  // Any valid id the model never placed → one singleton catch-all cluster.
  const missing = validIds.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    clusters.push({
      title: 'Unsorted flags',
      root_cause: 'These flags were not grouped by the automatic triage — a person should review them.',
      case_ids: missing,
      suggested_action: 'needs-attention',
      reasoning: 'Added automatically so every flag is accounted for.',
    })
  }

  const summary =
    rawSummary ||
    `This run raised ${validIds.length} ${validIds.length === 1 ? 'flag' : 'flags'} across ${clusters.length} ${clusters.length === 1 ? 'group' : 'groups'}. Review the groups below.`

  return { summary, clusters }
}

// ============================================================================
// Sibling-case loading + synthesis input rendering (PURE render helper)
// ============================================================================

/** A NON-triage sibling case of the run, loaded for synthesis. */
export interface SiblingCase {
  id: string
  report_type: string
  kind: string
  natural_key: string
  reason: string | null
  detail: string | null
  status: string
  known_ruling_summary: string | null
  verdict: unknown
}

/** Pull the plain verdict summary + confidence off a persisted verdict jsonb. */
function verdictLine(verdict: unknown): string | null {
  if (!verdict || typeof verdict !== 'object') return null
  const v = verdict as Record<string, unknown>
  const label = typeof v.verdict === 'string' ? v.verdict : null
  const conf = typeof v.confidence === 'string' ? v.confidence : null
  const summary = typeof v.summary === 'string' ? v.summary : null
  if (!label && !summary) return null
  const parts: string[] = []
  if (label) parts.push(`verdict ${label}${conf ? ` (${conf} confidence)` : ''}`)
  if (summary) parts.push(summary)
  return parts.join(' — ')
}

/**
 * Render ONE sibling case into the synthesis prompt (PURE). Each case is presented
 * with its id (the model must group by these), kind, key, why it was set aside, its
 * investigation verdict if any, and any prior-ruling note. NO ₱/cost.
 */
export function renderSiblingForSynthesis(c: SiblingCase): string {
  const lines: string[] = []
  lines.push(`• case id: ${c.id}`)
  lines.push(`  report: ${c.report_type} · kind: ${c.kind} · status: ${c.status}`)
  lines.push(`  key: ${c.natural_key}`)
  if (c.reason) lines.push(`  why set aside: ${c.reason}`)
  if (c.detail) lines.push(`  detail: ${c.detail}`)
  const vl = verdictLine(c.verdict)
  if (vl) lines.push(`  investigation said: ${vl}`)
  if (c.known_ruling_summary) lines.push(`  prior ruling on this exact flag: "${c.known_ruling_summary}"`)
  return lines.join('\n')
}

/** Build the full synthesis system prompt (PURE) — the plain-language triage rules. */
export function buildTriageSystem(): string {
  const banned = BANNED_JARGON.join(', ')
  return `You are the Blackwood daily-sync TRIAGE. You work for Renzo, who runs a charcoal
plant and is NOT an engineer. Write everything the way you would talking to him on the
plant floor.

You are handed EVERY flag the daily sync set aside on ONE run, each already looked at
individually. Your job is to step back and see the WHOLE run: group the flags by their
SHARED ROOT CAUSE (flags caused by the same underlying thing belong together), and write
a short summary a manager reads first.

Rules:
- Group by shared root cause. If five flags are all "the movement sheet is missing
  feedings", that is ONE group, not five.
- Every flag (case id) must appear in EXACTLY ONE group. Never leave one out, never put
  one in two groups.
- suggested_action per group: "dismiss" when the database is already correct and the
  group can be set aside together; "needs-attention" when a person genuinely must act
  (a real duplicate in the database, an unknown batch code, a genuine mismatch).
- The summary is 2 to 4 plain sentences: how many flags, how many real root causes, and
  what needs a person (if anything). It is the FIRST thing the manager reads.
- Plain plant language ONLY. Do NOT use any of these words: ${banned}. Say "the two
  numbers don't match", "the movement sheet is missing entries", "already saved", "an
  unknown batch code" — never engineer jargon.
- Name specifics where you can (dates, kg, batch codes), pulled from what each flag says.

Answer ONLY by calling submit_triage.`
}

// ============================================================================
// The run (network + DB)
// ============================================================================

type AdminClient = ReturnType<typeof createAdminClient>

/** Load the run's NON-triage cases (any status) with their pre-annotating ruling summary. */
async function loadSiblingCases(admin: AdminClient, runId: string): Promise<SiblingCase[]> {
  const { data, error } = await admin
    .from('sync_held_cases')
    .select(
      'id, report_type, kind, natural_key, reason, detail, status, verdict, known_ruling_id, sync_case_rulings!sync_held_cases_known_ruling_id_fkey(verdict_summary)',
    )
    .eq('last_run_id', runId)
    .neq('kind', TRIAGE_KIND)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`load sibling cases failed: ${error.message}`)

  return (data ?? []).map((r) => {
    const rel = r.sync_case_rulings as
      | { verdict_summary?: string }
      | { verdict_summary?: string }[]
      | null
    const summary = Array.isArray(rel) ? rel[0]?.verdict_summary ?? null : rel?.verdict_summary ?? null
    return {
      id: r.id,
      report_type: r.report_type,
      kind: r.kind,
      natural_key: r.natural_key,
      reason: r.reason,
      detail: r.detail,
      status: r.status,
      known_ruling_summary: summary,
      verdict: r.verdict,
    }
  })
}

/** A short, human run label for the triage case's natural_key. */
function runLabel(runId: string, startedAt: string | null, createdAt: string | null): string {
  const iso = startedAt ?? createdAt
  const datePart = iso ? String(iso).slice(0, 10) : 'unknown date'
  return `Run triage — ${datePart} (${runId.slice(0, 8)})`
}

/** Render the clusters + summary into the opening assistant chat message (plain text). */
export function renderTriageMessage(result: TriageResult, siblings: SiblingCase[]): string {
  const byId = new Map(siblings.map((s) => [s.id, s]))
  const lines: string[] = []
  lines.push(result.summary)
  lines.push('')
  result.clusters.forEach((c, i) => {
    const actionLabel = c.suggested_action === 'dismiss' ? 'can be set aside' : 'needs a person'
    lines.push(`${i + 1}. ${c.title} — ${actionLabel}`)
    lines.push(`   Root cause: ${c.root_cause}`)
    const keys = c.case_ids
      .map((id) => byId.get(id)?.natural_key)
      .filter((k): k is string => Boolean(k))
    if (keys.length > 0) {
      lines.push(`   Flags: ${keys.join('; ')}`)
    } else {
      lines.push(`   Flags: ${c.case_ids.length}`)
    }
    if (c.reasoning) lines.push(`   Why: ${c.reasoning}`)
  })
  return lines.join('\n')
}

/**
 * Synthesize + persist a run's triage case. Idempotent by the fingerprint UNIQUE
 * upsert — re-running replaces verdict/row and appends a fresh system note.
 *
 * Returns 'skipped' (no triage case) for a run with zero non-triage cases (a clean run).
 */
export async function runTriage(runId: string): Promise<RunTriageOutcome> {
  const admin = createAdminClient()

  try {
    // 1. Load the run (for the date label) + every non-triage case.
    const { data: run } = await admin
      .from('sync_runs')
      .select('id, started_at, created_at')
      .eq('id', runId)
      .maybeSingle()

    const siblings = await loadSiblingCases(admin, runId)
    if (siblings.length === 0) {
      return { status: 'skipped' }
    }

    const validIds = siblings.map((s) => s.id)

    // 2. ONE Anthropic call, forced onto submit_triage (no read-only tools).
    const system = buildTriageSystem()
    const userPrompt =
      `This run raised ${siblings.length} ${siblings.length === 1 ? 'flag' : 'flags'}. ` +
      `Group them by shared root cause and call submit_triage. Every case id below must appear ` +
      `in exactly one group.\n\n${siblings.map(renderSiblingForSynthesis).join('\n\n')}`

    const response = await anthropic.messages.create({
      model: INVESTIGATOR_MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
      tools: [SUBMIT_TRIAGE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_triage' },
    })

    const toolUse = response.content.find(
      (b): b is import('@anthropic-ai/sdk').Anthropic.ToolUseBlock =>
        b.type === 'tool_use' && b.name === 'submit_triage',
    )
    const result = parseTriage(toolUse?.input ?? {}, validIds)

    // 3. Build the persisted row payloads.
    const nowIso = new Date().toISOString()
    const fingerprint = triageFingerprint(runId)
    const label = runLabel(runId, run?.started_at ?? null, run?.created_at ?? null)

    const verdictJson = {
      verdict: 'needs-human',
      confidence: 'high',
      summary: result.summary,
      explanation: 'run triage',
      citations: [],
      model: INVESTIGATOR_MODEL,
      investigated_at: nowIso,
      tool_call_count: 0,
    }

    // 4. UPSERT the triage case by fingerprint (idempotent, single-flight via UNIQUE).
    const { data: upserted, error: upErr } = await admin
      .from('sync_held_cases')
      .upsert(
        {
          fingerprint,
          report_type: TRIAGE_REPORT_TYPE,
          kind: TRIAGE_KIND,
          natural_key: label,
          reason: `Triage of ${siblings.length} ${siblings.length === 1 ? 'flag' : 'flags'} on this run.`,
          detail: null,
          row: { clusters: result.clusters, case_ids: validIds } as unknown as Json,
          first_run_id: runId,
          last_run_id: runId,
          occurrence_count: 1,
          last_seen_at: nowIso,
          status: 'investigated',
          verdict: verdictJson as unknown as Json,
          known_ruling_id: null,
          updated_at: nowIso,
        },
        { onConflict: 'fingerprint' },
      )
      .select('id')
      .single()
    if (upErr || !upserted) {
      throw new Error(`triage upsert failed: ${upErr?.message ?? 'no row returned'}`)
    }
    const caseId = upserted.id as string

    // 5. Seed / append the chat thread: a system note + an assistant message carrying
    //    the summary + clusters as plain text (so the run chat opens with the triage).
    const { data: maxRow } = await admin
      .from('sync_case_messages')
      .select('position')
      .eq('case_id', caseId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle()
    let pos = (maxRow?.position ?? -1) + 1

    const noteText = `Triage of ${siblings.length} ${siblings.length === 1 ? 'flag' : 'flags'} → ${result.clusters.length} ${result.clusters.length === 1 ? 'group' : 'groups'}.`
    await admin.from('sync_case_messages').insert([
      {
        case_id: caseId,
        role: 'system',
        content: noteText,
        tool_calls: null,
        tool_results: null,
        position: pos++,
      },
      {
        case_id: caseId,
        role: 'assistant',
        content: renderTriageMessage(result, siblings),
        tool_calls: null,
        tool_results: null,
        position: pos++,
      },
    ])

    return { status: 'done', caseId }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { status: 'error', error: message }
  }
}
