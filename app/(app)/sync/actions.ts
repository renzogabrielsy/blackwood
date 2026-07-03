'use server'

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { anthropic, JARVIS_MODEL } from '@/lib/anthropic/client'
import { createClient } from '@/lib/supabase/server'
import { getUserRole } from '@/lib/auth'
import { PRIVILEGED_ROLES } from '@/types/auth'

import {
  metaFor,
  type ApplyResult,
  type ClassifyResult,
  type HeldRow,
  type HeldRowRecommendation,
  type SyncReportType,
} from './types'
import { MOCK_APPLY, MOCK_CLASSIFY } from './mock'

const execFileAsync = promisify(execFile)

// ============================================================
// Config
// ============================================================

/** Repo root — actions run from the Next.js server whose cwd is the repo root. */
const REPO_ROOT = process.cwd()
const SCRIPTS_DIR = '.claude/skills/sync-ictc/scripts'

/** Generous timeout — the Python phase fetches Gmail + runs classify/apply. */
const EXEC_TIMEOUT_MS = 5 * 60 * 1000
/** 32 MB — classify JSON can be large on a big backfill. */
const EXEC_MAX_BUFFER = 32 * 1024 * 1024

const MOCK = process.env.SYNC_MOCK === '1'

// ============================================================
// Auth guard (mirrors the SEC-3 pattern in rc-in/actions.ts)
// ============================================================

/**
 * Every action in this file is privileged: only Owner/Admin/Dev may run a sync
 * or adjudicate held rows. Derives the EFFECTIVE role via getUserRole() so the
 * dev-impersonation cookie is respected (an Owner "viewing as Production" is
 * denied). Fails closed — throws if unauthenticated or under-privileged.
 */
async function requirePrivileged(): Promise<void> {
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
}

// ============================================================
// child_process transport (mockable)
// ============================================================

/**
 * Single choke-point for spawning a sync orchestrator. Behind SYNC_MOCK it never
 * spawns anything — it returns the canned contract JSON. This is the ONE place
 * the child_process layer is isolated, so the whole panel is testable before the
 * real scripts exist.
 *
 * @throws an Error whose message includes stdout + stderr for the inline error
 *   block + Copy button (HARD RULE — never swallow the detail).
 */
async function runPhase<T>(
  reportType: SyncReportType,
  phase: 'classify' | 'apply',
  extraArgs: string[],
  mockValue: T
): Promise<T> {
  if (MOCK) {
    // Small delay so the UI spinners are observable in the mock path.
    await new Promise((r) => setTimeout(r, 350))
    return mockValue
  }

  const meta = metaFor(reportType)
  const scriptPath = path.join(SCRIPTS_DIR, meta.script)
  const args = [scriptPath, '--phase', phase, '--json', ...extraArgs]

  let stdout: string
  let stderr: string
  try {
    const res = await execFileAsync('python3', args, {
      cwd: REPO_ROOT,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    })
    stdout = res.stdout
    stderr = res.stderr
  } catch (err) {
    // execFile rejects on non-zero exit; the error carries stdout/stderr.
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    const detail = [
      `python3 ${args.join(' ')}`,
      `cwd: ${REPO_ROOT}`,
      e.code ? `exit: ${e.code}` : null,
      e.stdout ? `stdout:\n${e.stdout}` : null,
      e.stderr ? `stderr:\n${e.stderr}` : null,
      e.message ? `message: ${e.message}` : null,
    ]
      .filter(Boolean)
      .join('\n\n')
    throw new Error(`Sync ${phase} failed for ${reportType}.\n\n${detail}`)
  }

  try {
    return JSON.parse(stdout.trim()) as T
  } catch {
    const detail = [
      `python3 ${args.join(' ')}`,
      'Could not parse the script stdout as JSON.',
      stderr ? `stderr:\n${stderr}` : null,
      `stdout:\n${stdout}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    throw new Error(`Sync ${phase} returned malformed output for ${reportType}.\n\n${detail}`)
  }
}

// ============================================================
// Public actions
// ============================================================

/**
 * PROPOSE phase — classify a single report type. Spawns
 * `sync_<type>.py --phase classify --json` and returns the parsed contract.
 * Never writes to the DB.
 */
export async function runSyncClassify(reportType: SyncReportType): Promise<ClassifyResult> {
  await requirePrivileged()
  return runPhase<ClassifyResult>(reportType, 'classify', [], MOCK_CLASSIFY[reportType])
}

/**
 * APPLY phase — deterministically apply the clean rows from a prior classify.
 * Spawns `sync_<type>.py --phase apply --input <path> --only-clean --json`.
 * Flagged/held rows are surfaced in the result's `held[]`, not written.
 *
 * The read-only auditor (rc_movement) must never be applied — guarded here.
 */
export async function runSyncApply(
  reportType: SyncReportType,
  classifiedPath: string
): Promise<ApplyResult> {
  await requirePrivileged()
  const meta = metaFor(reportType)
  if (meta.readOnly) {
    throw new Error(`${meta.label} is read-only — apply is not permitted for this report.`)
  }
  return runPhase<ApplyResult>(
    reportType,
    'apply',
    ['--input', classifiedPath, '--only-clean'],
    MOCK_APPLY[reportType]
  )
}

// ============================================================
// Adjudication + narration (Anthropic — single completion, no tool loop)
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
