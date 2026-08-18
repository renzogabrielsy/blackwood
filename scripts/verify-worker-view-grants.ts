/**
 * verify-worker-view-grants.ts — assert that every SQL view the sync worker reads is
 * actually readable by `service_role`, the role the worker holds.
 *
 * Run: npx tsx scripts/verify-worker-view-grants.ts
 *
 * ============================================================================
 * THE BUG THIS EXISTS TO CATCH (built 2026-08-04 / 2026-08-07, found 2026-08-18)
 * ============================================================================
 * The worker reads five views. Two of them — `view_digest_stream_status` and
 * `view_digest_unpriced_deliveries` — returned HTTP 403 / SQLSTATE 42501,
 * "permission denied", to the service-role key. They are exactly the two that carry
 * an alarm:
 *
 *   * the stream-freshness watch (2026-08-04). `sync_runs.result.reconciliation
 *     .stale_streams` was ABSENT on every run in the table. The watch had never once
 *     fired — including on days the view plainly reported a stream late.
 *   * the unpriced-delivery chase (2026-08-07, L-039 rule 5) — the warning built
 *     precisely to catch a price outage that the price step itself missed.
 *
 * Both reads sat behind a bare `catch`, so a permission error was rendered as
 * "nothing to report" from the day each alarm was built. Nothing anywhere went red.
 * An alarm that cannot read its input does not fail loudly; it goes quiet, and quiet
 * is indistinguishable from "all clear".
 *
 * ============================================================================
 * WHY IT SURVIVED A CORRECT-LOOKING GRANT — READ THIS BEFORE "FIXING" A 42501
 * ============================================================================
 * `view_digest_unpriced_deliveries` HAD its service_role grant the whole time
 * (20260807040107 granted it `TO authenticated, service_role`, correctly
 * anticipating the worker). It still 403'd.
 *
 * These are `security_invoker` views: the CALLER's privileges are applied to every
 * relation underneath, all the way down. So the denial CASCADES, and the error names
 * the DEPENDENCY, not the view you asked for:
 *
 *   SELECT ... FROM view_digest_unpriced_deliveries
 *     -> ERROR 42501: permission denied for view view_digest_operational_days
 *
 * A grant on the outermost view alone buys nothing. The unit of correctness is the
 * whole dependency CLOSURE. Fixed by migration 20260818071855.
 *
 * ============================================================================
 * WHY THIS CHECK DOES A REAL READ INSTEAD OF INSPECTING THE GRANT TABLE
 * ============================================================================
 * L-043's lesson, learned the same month from the mirror-image bug (a SECURITY
 * INVOKER trigger reaching a function `authenticated` could not execute): PROVE A
 * PERMISSION FIX BY ASSUMING THE VICTIM'S ROLE, NEVER BY INSPECTING THE GRANT.
 *
 * `scripts/verify-trigger-grants.ts` walks the catalogs because its victim is
 * `authenticated` and no script has a user JWT lying around. Here the victim is
 * `service_role` and its key is in `.env.local` — so the real read is available, and
 * it is strictly stronger evidence than any catalog walk:
 *
 *   - it exercises the ENTIRE security_invoker chain in one statement, at whatever
 *     depth, with no dependency-graph query to get wrong;
 *   - it is the exact PostgREST path the worker uses, not a model of it;
 *   - Postgres's own error already names the offending relation, so the failure
 *     message is actionable without any extra machinery.
 *
 * ZERO FINDINGS IS THE PASSING STATE.
 *
 * ============================================================================
 * HOW THE VIEW LIST IS DERIVED — AND THE ONE WAY IT CAN ROT
 * ============================================================================
 * The list is EXTRACTED FROM THE WORKER SOURCE, never hard-coded here: a hard-coded
 * list is a second definition of "what the worker reads" and would drift the first
 * time someone adds a read. The net is every single- or double-quoted string literal
 * matching /view_[A-Za-z0-9_]+/ under `workers/sync/src`.
 *
 * BACKTICKS ARE DELIBERATELY EXCLUDED. In this codebase backticks around a view name
 * are JSDoc code spans, not template literals — including seven mentions of
 * `view_digest_unpriced_recent`, which the worker does NOT read and which is
 * deliberately NOT granted to service_role (it is a CONSUMER of
 * view_digest_unpriced_deliveries, not a dependency of it). Including backticks
 * would false-fail on day one.
 *
 * The residual blind spot: a view read through a COMPUTED name cannot be seen
 * statically. That is why every hit is printed with its file:line provenance — so a
 * reader can notice an absence, not just trust a tick. If you ever add such a read,
 * add the view here explicitly with a comment saying why it is invisible.
 *
 * AN EMPTY LIST IS A FAILURE, NOT A PASS. An extractor that quietly matches nothing
 * would otherwise report success while checking nothing at all — the same trap as a
 * missing report being indistinguishable from a clean one.
 *
 * ============================================================================
 * IF THIS SCRIPT FAILS
 * ============================================================================
 * The worker cannot read a view it depends on, and whatever that view feeds is
 * silently reporting nothing. Fix with a GRANT, in a migration, covering the FULL
 * dependency closure of the named view — walk it with pg_depend/pg_rewrite, do not
 * eyeball it. See 20260818071855 for the shape.
 *
 * Do NOT reach for `security_definer` on the view to make this go quiet: that makes
 * the view run as its owner for EVERY caller, a permanent privilege change to paper
 * over a missing grant. Same trade CLAUDE.md rejects for `fn_recompute_batch_state`.
 *
 * Run this after any migration that adds a view, drops-and-recreates a view
 * (`DROP VIEW` + `CREATE VIEW` LOSES its grants; `CREATE OR REPLACE VIEW` keeps
 * them), or changes a GRANT/REVOKE — and after any worker change that adds a read.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

/** One view the worker reads, with every place it is named. */
type WorkerView = {
  view: string
  sites: string[]
}

/** One hole: the worker's own role cannot read a view the worker reads. */
type Finding = {
  view: string
  sites: string[]
  code: string
  message: string
}

/** The worker source tree — the ONE source of truth for what the worker reads. */
const WORKER_SRC = 'workers/sync/src'

/**
 * Single- or double-quoted `view_*` string literals. Backticks excluded on purpose —
 * see the header. Cannot under-report a literal read; can over-report a call shape
 * quoted inside a comment, which is the safe direction (it just gets checked too).
 */
const VIEW_LITERAL = /['"](view_[A-Za-z0-9_]+)['"]/g

/** Every `.ts` file under a directory, recursively. */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      walkTs(full, out)
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Extract the views the worker reads, with file:line provenance for each. */
function extractWorkerViews(root: string): WorkerView[] {
  const found = new Map<string, string[]>()
  for (const file of walkTs(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const m of line.matchAll(VIEW_LITERAL)) {
        const view = m[1]
        const site = `${file}:${i + 1}`
        const sites = found.get(view)
        if (sites) {
          if (!sites.includes(site)) sites.push(site)
        } else {
          found.set(view, [site])
        }
      }
    })
  }
  return [...found.entries()]
    .map(([view, sites]) => ({ view, sites }))
    .sort((a, b) => (a.view < b.view ? -1 : a.view > b.view ? 1 : 0))
}

/** Read NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from env or .env.local. */
function readEnv(): { url: string; key: string } | null {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!url || !key) {
    try {
      const txt = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
      for (const raw of txt.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const k = line.slice(0, eq).trim()
        const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (k === 'NEXT_PUBLIC_SUPABASE_URL' && !url) url = v
        if (k === 'SUPABASE_SERVICE_ROLE_KEY' && !key) key = v
      }
    } catch {
      /* no .env.local — fall through to the skip */
    }
  }
  return url && key ? { url, key } : null
}

function describe(f: Finding): string {
  const cascade =
    f.code === '42501' && !f.message.includes(f.view)
      ? `\n      NOTE: the denial names a DEPENDENCY, not ${f.view} itself. Granting\n` +
        `      ${f.view} alone will NOT fix this — grant the whole closure.`
      : ''
  return (
    `    ${f.view}  — service_role CANNOT read it\n` +
    `      ${f.code ? `SQLSTATE ${f.code}: ` : ''}${f.message}${cascade}\n` +
    `      read by: ${f.sites.join(', ')}`
  )
}

async function main(): Promise<void> {
  const views = extractWorkerViews(resolve(process.cwd(), WORKER_SRC))

  if (views.length === 0) {
    throw new Error(
      `extracted ZERO views from ${WORKER_SRC}. That is a failure, not a pass: the ` +
        `extractor has rotted (moved source tree, or reads now use a quote style or ` +
        `call shape the regex does not match), and this guard would silently check ` +
        `nothing. Fix the extractor before trusting this script again.`,
    )
  }

  console.log(`worker view-grant audit — ${views.length} view(s) read by ${WORKER_SRC}:`)
  for (const v of views) console.log(`    ${v.view.padEnd(34)} ${v.sites.join(', ')}`)
  console.log()

  const env = readEnv()
  if (!env) {
    console.log('  SKIPPED')
    console.log('  ! NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.')
    console.log('  ! This check has NO offline half: a grant is a live database fact and')
    console.log('  ! the only honest test is to actually read as the victim role. Run it')
    console.log('  ! WITH credentials after any migration touching a view or a GRANT.')
    return
  }

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } })

  const findings: Finding[] = []
  for (const { view, sites } of views) {
    // The real read, as service_role — not a model of it. One row is enough: the
    // privilege check covers every relation in the rewritten query regardless of
    // how many rows come back.
    const { error } = await sb.from(view).select('*').limit(1)
    if (error) {
      findings.push({ view, sites, code: error.code ?? '', message: error.message })
      console.log(`  FAIL ${view}`)
    } else {
      console.log(`  ok   ${view}`)
    }
  }

  if (findings.length > 0) {
    console.log(`\n  ${findings.length} unreadable view(s):`)
    for (const f of findings) console.log(describe(f))
    throw new Error(
      `${findings.length} view(s) the sync worker reads are NOT readable by ` +
        `service_role. Whatever they feed is silently reporting nothing. Fix with a ` +
        `GRANT covering each view's FULL dependency closure (security_invoker cascades ` +
        `the caller's privileges downward) — never by re-rooting a view to ` +
        `security_definer.`,
    )
  }

  console.log(`\nAll ${views.length} worker-read views are readable by service_role.`)
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
