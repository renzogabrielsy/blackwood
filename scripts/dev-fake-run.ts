/**
 * dev-fake-run.ts — insert a FAKE durable sync run so the modal can be exercised
 * WITHOUT the worker (workers/sync) running.
 *
 * The old SYNC_MOCK path spawned canned Python over SSE. In the durable-worker era
 * (Wave 4B) there is no app-side transport to mock — the modal watches Supabase
 * Realtime. So "mock a run" now means: write a `sync_runs` row + a realistic
 * sequence of `sync_run_events`, then a terminal `sync_runs` UPDATE carrying a
 * `result.reports` payload. The logged-in browser (subscribed via useSyncRun) will
 * animate the cards live exactly as a real run would.
 *
 * Usage (from repo root):
 *   npx tsx scripts/dev-fake-run.ts            # full run (inserts + a gate fail + held rows)
 *   npx tsx scripts/dev-fake-run.ts --clean    # a clean "nothing new" run
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local (service role bypasses the
 * INSERT lock on sync_runs / sync_run_events).
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const sb = createClient(url, key)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clean = process.argv.includes('--clean')

interface Ev {
  report_type: string
  stage: string
  pct: number
  label: string
  detail?: string
  level?: 'info' | 'warn'
}

async function emit(runId: string, e: Ev) {
  const { error } = await sb.from('sync_run_events').insert({
    run_id: runId,
    report_type: e.report_type,
    stage: e.stage,
    pct: e.pct,
    label: e.label,
    detail: e.detail ?? null,
    level: e.level ?? 'info',
  })
  if (error) throw new Error(`emit failed: ${error.message}`)
}

async function main() {
  // 1. The run row (queued → running).
  const { data, error } = await sb
    .from('sync_runs')
    .insert({ status: 'running', started_at: new Date().toISOString() })
    .select('id')
    .single()
  if (error || !data) throw new Error(`create run failed: ${error?.message}`)
  const runId = (data as { id: string }).id
  console.log(`[dev-fake-run] runId=${runId} — open the Daily Sync modal now to watch it live.`)

  // 2. Top-level (_run) + per-report progress beats.
  await emit(runId, { report_type: '_run', stage: 'fetch', pct: 5, label: 'Checking Gmail for new reports…' })
  await sleep(600)
  await emit(runId, { report_type: '_run', stage: 'fetch', pct: 40, label: 'Downloaded 4 report file(s)' })

  for (const t of ['deliveries', 'rc_out', 'production', 'flecon']) {
    await sleep(400)
    await emit(runId, { report_type: t, stage: 'extract', pct: 30, label: 'Reading the rows…', detail: '43 rows' })
  }
  for (const t of ['deliveries', 'production', 'flecon']) {
    await sleep(400)
    await emit(runId, { report_type: t, stage: 'classify', pct: 62, label: 'Comparing against the database…', detail: '40 already recorded' })
  }
  await sleep(400)
  await emit(runId, { report_type: 'rc_out', stage: 'reconcile', pct: 60, label: 'Cross-checking against the movement total…', detail: 'drift 6,300 kg', level: 'warn' })
  for (const t of ['deliveries', 'flecon']) {
    await sleep(400)
    await emit(runId, { report_type: t, stage: 'apply', pct: 88, label: 'Writing the new rows…' })
  }
  await sleep(400)
  await emit(runId, { report_type: '_run', stage: 'finalize', pct: 100, label: 'Done' })

  // 3. Terminal result — per-report ClassifyResult / ApplyResult (the M3 contract).
  const result = clean ? cleanResult() : richResult()
  await sleep(500)
  const { error: upErr } = await sb
    .from('sync_runs')
    .update({
      status: clean ? 'succeeded' : 'partial',
      result,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId)
  if (upErr) throw new Error(`finish run failed: ${upErr.message}`)
  console.log(`[dev-fake-run] finished runId=${runId} (${clean ? 'clean' : 'rich'}).`)
}

function cleanResult() {
  return {
    reports: {
      gsheet: repClean('gsheet', 812),
      deliveries: repClean('deliveries', 40),
      rc_out: repClean('rc_out', 18),
      production: repClean('production', 22),
      flecon: repClean('flecon', 30),
      rc_movement: repClean('rc_movement', 0),
    },
  }
}

function richResult() {
  return {
    reports: {
      gsheet: repClean('gsheet', 812),
      deliveries: {
        classify: classify('deliveries', { noop: 40, insert: 3, update: 1, flagged: 0 }, true, []),
        apply: apply('deliveries', 3, 1, [], []),
      },
      rc_out: {
        status: 'gate-failed',
        classify: classify('rc_out', { noop: 18, insert: 6, update: 0, flagged: 0 }, false, [
          { gate: 'PROPOSED-vs-RC-MOVEMENT drift', detail: '2026-07-03: drift 6,300 kg exceeds the 500 kg HARD limit. Writes halted.' },
        ]),
        apply: null,
      },
      production: {
        classify: classify('production', { noop: 22, insert: 9, update: 0, flagged: 2 }, true, []),
        apply: apply('production', 9, 0, [], [
          { reason: 'unmapped_batch', natural_key: '2026-07-03|WASTE|AYAG', detail: 'References batch AUG-26-BLK9 which does not exist.' },
          { reason: 'meter_rollover', natural_key: '2026-07-03|ELEC|GEN2', detail: 'Reading 002,140 < prior 998,000 — likely a rollover.' },
        ]),
      },
      flecon: {
        classify: classify('flecon', { noop: 30, insert: 5, update: 0, flagged: 0 }, true, []),
        apply: apply('flecon', 5, 0, ['2026-07-03'], []),
      },
      rc_movement: repClean('rc_movement', 0),
    },
  }
}

function classify(rt: string, counts: { noop: number; insert: number; update: number; flagged: number }, ok: boolean, gate_failures: { gate: string; detail: string }[]) {
  return {
    report_type: rt, ok, gate_failures, counts,
    rows_preview: [], classified_path: `/tmp/${rt}.json`, source: {}, watermark: '2026-07-03',
  }
}
function apply(rt: string, inserts: number, updates: number, replaced_dates: string[], held: { reason: string; natural_key: string; detail: string }[]) {
  return {
    report_type: rt, ok: true,
    applied: { inserts, updates, replaced_dates },
    held, labeled: true, watermark_updated: true, errors: [],
  }
}
function repClean(rt: string, noop: number) {
  return {
    classify: classify(rt, { noop, insert: 0, update: 0, flagged: 0 }, true, []),
    apply: apply(rt, 0, 0, [], []),
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
