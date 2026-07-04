'use server'

import { anthropic, JARVIS_MODEL } from '@/lib/anthropic/client'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getUserRole } from '@/lib/auth'
import { PRIVILEGED_ROLES } from '@/types/auth'

import {
  type HeldRow,
  type HeldRowRecommendation,
  type SyncReportType,
} from './types'

// ============================================================
// Config — durable worker kick (Wave 4B)
// ============================================================

/**
 * The durable sync worker's base URL (`workers/sync`, a small cloud host, Fly.io
 * scale-to-zero). The kick POST wakes it. Documented in `.env.example`; when unset
 * the enqueue still succeeds — the row stays queued and DBOS recovery starts it on
 * the next worker wake.
 */
const SYNC_WORKER_URL = process.env.SYNC_WORKER_URL ?? ''
/** Shared secret for `POST /kick` (Bearer). Set on BOTH the app and the worker. */
const SYNC_KICK_SECRET = process.env.SYNC_KICK_SECRET ?? ''
/** How long to wait for the kick before giving up (the row is durable regardless). */
const KICK_TIMEOUT_MS = 5_000

// ============================================================
// Auth guard (mirrors the SEC-3 pattern in rc-in/actions.ts)
// ============================================================

/**
 * Every action in this file is privileged: only Owner/Admin/Dev may run a sync
 * or adjudicate held rows. Derives the EFFECTIVE role via getUserRole() so the
 * dev-impersonation cookie is respected (an Owner "viewing as Production" is
 * denied). Fails closed — throws if unauthenticated or under-privileged.
 *
 * Returns the authenticated user id so the caller can stamp `requested_by`.
 */
async function requirePrivileged(): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    throw new Error('Not authenticated')
  }
  const role = await getUserRole(user.id)
  if (!PRIVILEGED_ROLES.includes(role)) {
    throw new Error('Not authorized — Run Sync is restricted to Owner / Admin / Dev.')
  }
  return user.id
}

// ============================================================
// enqueueSyncRun — the durable-worker entry point (Wave 4B)
// ============================================================

export interface EnqueueSyncRunResult {
  /** The new `sync_runs.id` — the browser subscribes to this run over Realtime. */
  runId: string
  /**
   * Whether the worker acknowledged the kick (HTTP 2xx). `false` means the worker
   * was asleep / unreachable — the run is still QUEUED and DBOS will start it on
   * the next worker wake, so the click is never lost.
   */
  kicked: boolean
  /** Human-readable note when `kicked` is false (shown as an info line, not an error). */
  message?: string
}

/**
 * The ONLY write path the click owns now: INSERT a `sync_runs` row (status
 * `queued`, `requested_by` = the caller) with the service role, then POST the
 * worker's `/kick` endpoint so it wakes and runs the workflow durably.
 *
 * Crash-proof by design:
 *   - The row is written FIRST and is durable. Everything else (extract, classify,
 *     apply, progress) happens in the worker and is checkpointed by DBOS.
 *   - If the kick fails or times out (~5s), we do NOT fail the action. We return
 *     `{ kicked: false }` with a human message; the queued row is recovered by
 *     DBOS when the worker next wakes. The click is never lost.
 *
 * The service role is required because `sync_runs` is INSERT-locked for
 * authenticated users (Phase-4 RLS: service_role writes, authenticated SELECT).
 *
 * @param dryRun classify-only (no writes) — forwarded to the worker in the kick body.
 */
export async function enqueueSyncRun(dryRun = false): Promise<EnqueueSyncRunResult> {
  const userId = await requirePrivileged()

  // 1. Durable row FIRST — service role (authenticated cannot INSERT sync_runs).
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('sync_runs')
    .insert({ requested_by: userId, status: 'queued' })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(
      `Could not enqueue the sync run (writing the sync_runs row failed).\n\n${
        error?.message ?? 'no row returned'
      }`
    )
  }
  const runId = (data as { id: string }).id

  // 2. Best-effort kick — the row is already durable, so a failed kick is non-fatal.
  if (!SYNC_WORKER_URL || !SYNC_KICK_SECRET) {
    return {
      runId,
      kicked: false,
      message:
        'Worker not configured (SYNC_WORKER_URL / SYNC_KICK_SECRET) — the run is queued and will start when the worker is available.',
    }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), KICK_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${SYNC_WORKER_URL.replace(/\/$/, '')}/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYNC_KICK_SECRET}`,
        },
        body: JSON.stringify({ runId, dryRun }),
        signal: controller.signal,
        cache: 'no-store',
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        runId,
        kicked: false,
        message: `Worker did not accept the kick (HTTP ${res.status}) — the run is queued and will start when the worker wakes.${
          body ? `\n\n${body.slice(0, 500)}` : ''
        }`,
      }
    }

    return { runId, kicked: true }
  } catch {
    // Timeout / network error / worker asleep — the queued row survives (DBOS recovers it).
    return {
      runId,
      kicked: false,
      message:
        'Worker asleep — the run is queued and will start when the worker wakes.',
    }
  }
}

// ============================================================
// Adjudication + narration (Anthropic — single completion, no tool loop)
//
// NOTE (Wave 4B): the old child_process transport (runSyncClassify /
// runSyncApply) and the SYNC_MOCK plumbing are RETIRED — classify/apply now run
// in the durable worker, and progress arrives over Supabase Realtime. These two
// actions are UNCHANGED — they are app-side Anthropic calls the modal still owns.
// For dev testing WITHOUT the worker, insert fake sync_runs + sync_run_events
// rows with the service client — see `scripts/dev-fake-run.md`.
// ============================================================

const ADJUDICATOR_SYSTEM = `You are the Blackwood daily-sync ADJUDICATOR.

You are given rows a deterministic Python pipeline HELD back from an automatic
apply because they need judgment (unmapped batch codes, reassignments, meter
rollovers, drift beyond tolerance, malformed rows). For each held row, recommend
exactly one verdict:

- "apply"        — safe to write as-is; the hold was over-cautious.
- "skip"         — do not write; it is noise, a duplicate, or a source error to fix upstream.
- "needs-human"  — genuinely ambiguous; Renzo must decide (default when unsure).

Codified rules that constrain you:
- NEVER recommend "apply" for a row that would auto-create a batch that does not exist.
- NEVER recommend "apply" for a flagged reassignment or a settled-date (sub-watermark) insert.
- A meter reading lower than the prior reading is usually a rollover — "needs-human".
- Drift beyond a HARD gate (e.g. rc_out >500 kg) is "needs-human", never "apply".
- When in doubt, "needs-human". You are advisory only; nothing you say is auto-applied.

Respond with ONLY a JSON array, no prose, no code fence:
[{"natural_key": "<key>", "verdict": "apply"|"skip"|"needs-human", "reason": "<one short sentence>"}]
Include exactly one object per held row, echoing its natural_key.`

/**
 * Ask the model for per-row RECOMMENDATIONS on held rows. Advisory only — the
 * caller shows these next to each row; applying a held row stays a manual /
 * sync-employee job in v1 (the apply contract has no single-row path yet).
 *
 * Single completion, no tool loop. Falls back to "needs-human" for every row if
 * the model returns unparseable output.
 */
export async function adjudicateHeldRows(
  reportType: SyncReportType,
  heldRows: HeldRow[]
): Promise<HeldRowRecommendation[]> {
  await requirePrivileged()

  const fallback = (): HeldRowRecommendation[] =>
    heldRows.map((r) => ({
      natural_key: r.natural_key,
      verdict: 'needs-human' as const,
      reason: 'Could not auto-adjudicate — review manually.',
    }))

  if (heldRows.length === 0) return []

  const userContent = [
    `Report type: ${reportType}`,
    'Held rows:',
    ...heldRows.map(
      (r, i) => `${i + 1}. natural_key=${r.natural_key} | reason=${r.reason} | detail=${r.detail}`
    ),
  ].join('\n')

  try {
    const response = await anthropic.messages.create({
      model: JARVIS_MODEL,
      max_tokens: 1024,
      system: [
        { type: 'text', text: ADJUDICATOR_SYSTEM, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userContent }],
    })

    let text = ''
    for (const block of response.content) {
      if (block.type === 'text') text += block.text
    }

    const parsed = safeParseArray(text)
    if (!parsed) return fallback()

    // Re-key by natural_key so the order/shape is authoritative from the held set.
    const byKey = new Map<string, HeldRowRecommendation>()
    for (const item of parsed) {
      if (item && typeof item.natural_key === 'string' && isVerdict(item.verdict)) {
        byKey.set(item.natural_key, {
          natural_key: item.natural_key,
          verdict: item.verdict,
          reason: typeof item.reason === 'string' ? item.reason : '',
        })
      }
    }

    return heldRows.map(
      (r) =>
        byKey.get(r.natural_key) ?? {
          natural_key: r.natural_key,
          verdict: 'needs-human' as const,
          reason: 'No recommendation returned — review manually.',
        }
    )
  } catch {
    return fallback()
  }
}

const NARRATOR_SYSTEM = `You are the Blackwood daily-sync narrator. Given a compact
JSON summary of a sync run, write EXACTLY three short, plain-language sentences for
a non-technical operator (Renzo). No jargon, no numbers-soup — say what happened,
what (if anything) needs his attention, and whether it's safe to move on. No lists,
no markdown, no preamble. Just the three sentences.`

/** Minimal per-report shape the narrator needs. */
export interface NarrateInput {
  report_type: string
  ok: boolean
  gate_failures: number
  inserts: number
  updates: number
  flagged: number
  held: number
}

/**
 * Optional 3-sentence plain-language run summary. Skips the API call entirely
 * (zero tokens) when every report is clean — returns a local string instead.
 */
export async function narrateSyncRun(results: NarrateInput[]): Promise<string> {
  await requirePrivileged()

  const allClean = results.every(
    (r) =>
      r.ok &&
      r.gate_failures === 0 &&
      r.inserts === 0 &&
      r.updates === 0 &&
      r.flagged === 0 &&
      r.held === 0
  )
  if (allClean) return 'Nothing new today. Every report was already up to date. Nothing needs your attention.'

  try {
    const response = await anthropic.messages.create({
      model: JARVIS_MODEL,
      max_tokens: 512,
      system: [{ type: 'text', text: NARRATOR_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(results) }],
    })
    let text = ''
    for (const block of response.content) {
      if (block.type === 'text') text += block.text
    }
    return text.trim() || 'Sync run complete. Review the cards above for anything that needs your attention.'
  } catch {
    // Narration is non-critical — never fail the run over it.
    return 'Sync run complete. Review the cards above for anything that needs your attention.'
  }
}

// ============================================================
// small parse helpers
// ============================================================

function isVerdict(v: unknown): v is HeldRowRecommendation['verdict'] {
  return v === 'apply' || v === 'skip' || v === 'needs-human'
}

interface RawRec {
  natural_key?: unknown
  verdict?: unknown
  reason?: unknown
}

/** Parse a JSON array from model text, tolerating a stray code fence. */
function safeParseArray(text: string): RawRec[] | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as RawRec[]) : null
  } catch {
    // Last resort: pull the first [...] block out of the text.
    const match = trimmed.match(/\[[\s\S]*\]/)
    if (!match) return null
    try {
      const parsed = JSON.parse(match[0])
      return Array.isArray(parsed) ? (parsed as RawRec[]) : null
    } catch {
      return null
    }
  }
}
