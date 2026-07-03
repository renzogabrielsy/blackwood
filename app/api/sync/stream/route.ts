/**
 * SSE progress stream for one sync-pipeline phase.
 *
 * GET /api/sync/stream?report=<type>&phase=classify|apply&input=<path>&onlyClean=1&noLabel=1
 *
 * Spawns `python3 <script> --phase <phase> --json [--input <path> --only-clean --no-label]`
 * and streams three SSE event kinds back to the browser:
 *   - event: progress  → one decoded `##SYNC_PROGRESS {…}` line (SyncProgressEvent)
 *   - event: log       → any other stderr line (raw technical text, for the collapsible log)
 *   - event: result    → terminal { exitCode, json, stderrTail } (SyncStreamResult), then close
 *
 * SELF-AUTH: /api is EXEMPT from the auth middleware, so this route re-runs the
 * same server-side privileged gate as sync/actions.ts (createClient → getUser →
 * getUserRole → PRIVILEGED_ROLES). Fails closed with 401/403 JSON.
 *
 * SYNC_MOCK=1: never spawns Python — streams a canned progress sequence + the
 * canned contract result from mock.ts, so the whole feature is testable without
 * the scripts existing.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

import { createClient } from '@/lib/supabase/server'
import { getUserRole } from '@/lib/auth'
import { PRIVILEGED_ROLES } from '@/types/auth'
import {
  SYNC_PROGRESS_SENTINEL,
  SYNC_REPORTS,
  metaFor,
  type ApplyResult,
  type ClassifyResult,
  type SyncProgressEvent,
  type SyncProgressStage,
  type SyncReportType,
} from '@/app/(app)/sync/types'
import { MOCK_APPLY, MOCK_CLASSIFY } from '@/app/(app)/sync/mock'

// This route spawns a child process and streams — force the Node.js runtime,
// never the Edge runtime, and never static optimization.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REPO_ROOT = process.cwd()
const SCRIPTS_DIR = '.claude/skills/sync-ictc/scripts'
const MOCK = process.env.SYNC_MOCK === '1'

/** Keep-alive comment ping cadence (ms). */
const PING_MS = 15_000
/** Cap the stderr tail we retain for a crash detail (chars). */
const STDERR_TAIL_MAX = 8_000

const VALID_REPORTS = new Set<string>(SYNC_REPORTS.map((r) => r.type))
const VALID_PHASES = new Set(['classify', 'apply'])

// ============================================================
// SSE framing helpers
// ============================================================

const enc = new TextEncoder()

/** Encode one SSE event. `data` is JSON-stringified onto a single `data:` line. */
function sse(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Encode an SSE comment (used for keep-alive pings — ignored by EventSource). */
function ssePing(): Uint8Array {
  return enc.encode(`: ping\n\n`)
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ============================================================
// Auth (mirrors requirePrivileged() in sync/actions.ts)
// ============================================================

/** Returns null when authorized, or a Response (401/403) when not. */
async function guard(): Promise<Response | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return jsonError(401, 'Not authenticated')

  const role = await getUserRole(user.id)
  if (!PRIVILEGED_ROLES.includes(role)) {
    return jsonError(403, 'Not authorized — Run Sync is restricted to Owner / Admin / Dev.')
  }
  return null
}

// ============================================================
// Route
// ============================================================

export async function GET(request: Request): Promise<Response> {
  const denied = await guard()
  if (denied) return denied

  const url = new URL(request.url)
  const report = url.searchParams.get('report')
  const phase = url.searchParams.get('phase')
  const input = url.searchParams.get('input')
  const onlyClean = url.searchParams.get('onlyClean') === '1'
  const noLabel = url.searchParams.get('noLabel') === '1'

  // --- validate params ---
  if (!report || !VALID_REPORTS.has(report)) {
    return jsonError(400, `Unknown or missing report type: ${report ?? '(none)'}`)
  }
  if (!phase || !VALID_PHASES.has(phase)) {
    return jsonError(400, `Invalid phase: ${phase ?? '(none)'} (expected classify|apply)`)
  }
  const reportType = report as SyncReportType
  const phaseKind = phase as 'classify' | 'apply'

  // apply requires an --input path, and it must live under /tmp/ (never an arbitrary path).
  if (phaseKind === 'apply') {
    if (!input) return jsonError(400, 'apply phase requires an input classified path')
    if (!input.startsWith('/tmp/')) {
      return jsonError(400, 'Refusing input path outside /tmp/')
    }
    const meta = metaFor(reportType)
    if (meta.readOnly) {
      return jsonError(400, `${meta.label} is read-only — apply is not permitted for this report.`)
    }
  }

  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }

  if (MOCK) {
    return new Response(mockStream(reportType, phaseKind), { headers })
  }

  return new Response(spawnStream(reportType, phaseKind, { input, onlyClean, noLabel }, request), {
    headers,
  })
}

// ============================================================
// Real transport — spawn python3 and forward stderr line-by-line
// ============================================================

interface ApplyArgs {
  input: string | null
  onlyClean: boolean
  noLabel: boolean
}

/**
 * Try to decode a raw stderr line as a `##SYNC_PROGRESS` event. Returns the event
 * on success, or null if the line is not a progress sentinel / is malformed /
 * fails the digestibility guard (looks like a traceback).
 */
function parseProgressLine(line: string): SyncProgressEvent | null {
  if (!line.startsWith(SYNC_PROGRESS_SENTINEL)) return null
  const payload = line.slice(SYNC_PROGRESS_SENTINEL.length).trim()
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const stage = r.stage
  const validStage: SyncProgressStage[] = [
    'fetch',
    'extract',
    'classify',
    'apply',
    'reconcile',
    'finalize',
  ]
  if (typeof stage !== 'string' || !validStage.includes(stage as SyncProgressStage)) return null

  const pctNum = typeof r.pct === 'number' ? r.pct : Number(r.pct)
  const pct = Number.isFinite(pctNum) ? Math.max(0, Math.min(100, Math.round(pctNum))) : 0

  const label = typeof r.label === 'string' ? r.label : ''
  // Digestibility guard: a "label" that looks like raw log / a traceback is NOT a
  // status line — reject it here so it falls through to the technical log instead.
  if (
    !label ||
    label.startsWith('Traceback') ||
    label.includes('File "') ||
    label.length > 140
  ) {
    return null
  }

  const detail = typeof r.detail === 'string' && r.detail.trim() ? r.detail : undefined
  const level = r.level === 'warn' ? 'warn' : 'info'

  return { stage: stage as SyncProgressStage, pct, label, detail, level }
}

function spawnStream(
  reportType: SyncReportType,
  phaseKind: 'classify' | 'apply',
  applyArgs: ApplyArgs,
  request: Request
): ReadableStream<Uint8Array> {
  const meta = metaFor(reportType)
  const scriptPath = path.join(SCRIPTS_DIR, meta.script)

  const args = [scriptPath, '--phase', phaseKind, '--json']
  if (phaseKind === 'apply') {
    if (applyArgs.input) args.push('--input', applyArgs.input)
    if (applyArgs.onlyClean) args.push('--only-clean')
    if (applyArgs.noLabel) args.push('--no-label')
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(ping)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
      const push = (chunk: Uint8Array) => {
        if (closed) return
        try {
          controller.enqueue(chunk)
        } catch {
          /* controller torn down — ignore */
        }
      }

      const child = spawn('python3', args, { cwd: REPO_ROOT })

      // Keep-alive ping so proxies don't idle-close the connection.
      const ping = setInterval(() => push(ssePing()), PING_MS)

      // Kill the child if the browser disconnects.
      const onAbort = () => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        close()
      }
      request.signal.addEventListener('abort', onAbort)

      // --- stdout: accumulate the single machine-JSON result object ---
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })

      // --- stderr: line-buffer; split progress events from raw log lines ---
      let stderrBuf = ''
      let stderrTail = ''
      child.stderr.setEncoding('utf8')

      const handleLine = (line: string) => {
        if (!line) return
        stderrTail = (stderrTail + line + '\n').slice(-STDERR_TAIL_MAX)
        const progress = parseProgressLine(line)
        if (progress) {
          push(sse('progress', progress))
        } else {
          push(sse('log', line))
        }
      }

      child.stderr.on('data', (d: string) => {
        stderrBuf += d
        let idx: number
        while ((idx = stderrBuf.indexOf('\n')) !== -1) {
          const line = stderrBuf.slice(0, idx).replace(/\r$/, '')
          stderrBuf = stderrBuf.slice(idx + 1)
          handleLine(line)
        }
      })

      const finish = (exitCode: number) => {
        if (closed) return
        // Flush any trailing partial stderr line.
        if (stderrBuf.trim()) handleLine(stderrBuf.trim())
        stderrBuf = ''

        let json: ClassifyResult | ApplyResult | null = null
        const trimmed = stdout.trim()
        if (trimmed) {
          try {
            json = JSON.parse(trimmed) as ClassifyResult | ApplyResult
          } catch {
            json = null
          }
        }
        push(sse('result', { exitCode, json, stderrTail }))
        request.signal.removeEventListener('abort', onAbort)
        close()
      }

      child.on('error', (err) => {
        // spawn itself failed (e.g. python3 missing). Surface as a log line + a
        // non-zero result so the client renders the error state.
        handleLine(`spawn error: ${err instanceof Error ? err.message : String(err)}`)
        finish(-1)
      })

      child.on('close', (code) => {
        finish(code ?? -1)
      })
    },
  })
}

// ============================================================
// Mock transport — canned progress + canned result (SYNC_MOCK=1)
// ============================================================

/** Realistic per-report progress script for the mock path. */
function mockProgressScript(reportType: SyncReportType): SyncProgressEvent[] {
  // rc_out is the canned HARD-gate failure; give it a warn near the end.
  if (reportType === 'rc_out') {
    return [
      { stage: 'fetch', pct: 10, label: 'Opening today’s report email…', level: 'info' },
      { stage: 'extract', pct: 35, label: 'Reading the feeding rows…', detail: '24 rows', level: 'info' },
      {
        stage: 'reconcile',
        pct: 60,
        label: 'Cross-checking against the movement total…',
        detail: 'drift 6,300 kg',
        level: 'warn',
      },
      { stage: 'finalize', pct: 100, label: 'Halting — the totals don’t match.', level: 'warn' },
    ]
  }
  if (reportType === 'rc_movement') {
    return [
      { stage: 'fetch', pct: 20, label: 'Opening the movement email…', level: 'info' },
      { stage: 'extract', pct: 55, label: 'Reading the feeding totals…', level: 'info' },
      { stage: 'reconcile', pct: 90, label: 'Comparing against what we recorded…', detail: '550 kg drift', level: 'info' },
      { stage: 'finalize', pct: 100, label: 'Cross-check complete.', level: 'info' },
    ]
  }
  return [
    { stage: 'fetch', pct: 12, label: 'Fetching the latest report…', level: 'info' },
    { stage: 'extract', pct: 34, label: 'Reading the rows…', detail: '43 rows', level: 'info' },
    {
      stage: 'classify',
      pct: 62,
      label: 'Comparing against the database…',
      detail: '40 already recorded',
      level: 'info',
    },
    { stage: 'apply', pct: 88, label: 'Writing the new rows…', level: 'info' },
    { stage: 'finalize', pct: 100, label: 'Done.', level: 'info' },
  ]
}

function mockStream(
  reportType: SyncReportType,
  phaseKind: 'classify' | 'apply'
): ReadableStream<Uint8Array> {
  const events = mockProgressScript(reportType)
  const resultJson: ClassifyResult | ApplyResult =
    phaseKind === 'apply' ? MOCK_APPLY[reportType] : MOCK_CLASSIFY[reportType]
  // Mirror the real exit-code semantics: classify gate failure → non-zero so the
  // client renders gate-failed even though the JSON also carries ok:false.
  const exitCode = 'ok' in resultJson && resultJson.ok === false ? 1 : 0

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk)
        } catch {
          /* torn down */
        }
      }
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

      // A couple of raw log lines so the technical-log collapsible has content.
      push(sse('log', `[mock] python3 sync_${reportType}.py --phase ${phaseKind} --json`))
      for (const ev of events) {
        await wait(280)
        push(sse('progress', ev))
        push(sse('log', `[mock] ${ev.stage} ${ev.pct}% — ${ev.label}`))
      }
      await wait(200)
      push(sse('result', { exitCode, json: resultJson, stderrTail: '[mock] no stderr' }))
      try {
        controller.close()
      } catch {
        /* already closed */
      }
    },
  })
}
