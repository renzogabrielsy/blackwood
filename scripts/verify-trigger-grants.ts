/**
 * verify-trigger-grants.ts — assert that no role can fire a trigger whose
 * SECURITY INVOKER call graph reaches a function that role cannot EXECUTE.
 *
 * Run: npx tsx scripts/verify-trigger-grants.ts
 *
 * ============================================================================
 * THE BUG THIS EXISTS TO CATCH (2026-08-04 → 2026-08-14, nine days)
 * ============================================================================
 * `tr_blackwood_delivery` on `public.deliveries` runs `fn_update_blackwood_state()`,
 * which is SECURITY INVOKER — so its body executes as whoever wrote the row. Every
 * branch of it calls `fn_recompute_batch_state(text)`, which was granted to
 * `service_role` ONLY. So an authenticated user's INSERT / UPDATE / DELETE fired a
 * trigger that instantly hit a function they had no rights on:
 *
 *     ERROR:  permission denied for function fn_recompute_batch_state
 *     SQLSTATE: 42501
 *
 * ...and the entire write rolled back. In-app delivery editing was 100% broken.
 *
 * ============================================================================
 * WHY IT WENT UNNOTICED FOR NINE DAYS — THE REASON THIS FILE IS NOT OPTIONAL
 * ============================================================================
 * The sync worker writes with the SERVICE-ROLE key, which holds EXECUTE. So the
 * privileged path stayed perfectly green the whole time: every run succeeded, no
 * finding fired, no gate tripped, nothing alarmed. A PRIVILEGED WRITER WAS MASKING A
 * COMPLETELY BROKEN UNPRIVILEGED PATH. The only symptom anywhere in the system was a
 * human hitting an error toast in the UI.
 *
 * That is the whole lesson, and it generalises past this one grant: a check that
 * runs as an admin CANNOT see a hole that only bites one role. This script exists
 * because correctness here is not a property of any code path — it is a property of
 * the grant table, invisible to every test that does not assume the victim's role.
 *
 * ============================================================================
 * WHAT IT CHECKS
 * ============================================================================
 * Delegates to `public.fn_audit_trigger_function_grants(p_role)` (migration
 * 20260814025716) — the SQL lives in the DB so the walk runs next to the catalogs it
 * reads. For every non-internal trigger on a table the role can write, it walks the
 * SECURITY INVOKER call graph out from the trigger function and reports any reachable
 * function the role cannot EXECUTE. SECURITY DEFINER callees terminate a branch on
 * purpose: they re-root privileges to their owner.
 *
 * ZERO ROWS IS THE PASSING STATE.
 *
 * Roles checked: `authenticated` (the app) and `anon`. `service_role` is deliberately
 * NOT checked — it is the role whose omnipotence caused the blind spot, so asserting
 * things about it would re-create the bug in test form.
 *
 * ============================================================================
 * PROVEN TO CATCH THE REAL BUG
 * ============================================================================
 * On 2026-08-14 the pre-fix state was reconstructed live inside a rolled-back
 * subtransaction (REVOKE the grant, run the audit, attempt the write, roll back):
 *
 *   post-fix          → 0 rows                                        PASS
 *   grant revoked     → 1 row: tr_blackwood_delivery / public.deliveries
 *                       / fn_update_blackwood_state()
 *                       → fn_recompute_batch_state(text)              FAIL
 *   same state, write → "permission denied for function fn_recompute_batch_state"
 *
 * The guard fails exactly when, and only when, the real write fails.
 *
 * ============================================================================
 * IF THIS SCRIPT FAILS
 * ============================================================================
 * The named role cannot complete a write it is otherwise fully entitled to make.
 * Usually the fix is a GRANT EXECUTE to that role, in a migration, with a comment
 * saying why the role is a legitimate caller (see 20260814025344).
 *
 * Do NOT reach for SECURITY DEFINER on the trigger function to make this go quiet:
 * that re-roots the privilege context of everything the trigger does — including its
 * table writes — and bypasses RLS on that path.
 *
 * The edge detection is a documented heuristic (Postgres records no function →
 * function call dependency, so callee names are word-boundary matched against
 * `prosrc`). It can OVER-report, never under-report a plain call. If it ever fires on
 * something genuinely benign, demote it with a written reason — do not widen the
 * predicate until it goes quiet.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** One hole: a role can fire this trigger, but cannot execute what it reaches. */
type Finding = {
  trigger_name: string
  on_table: string
  trigger_function: string
  unexecutable_callee: string
  callee_is_secdef: boolean
  hops: number
}

/** The roles a real human/browser can hold. `service_role` is excluded on purpose. */
const ROLES = ['authenticated', 'anon'] as const

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
  const via = f.hops === 0 ? 'directly' : `${f.hops} hop${f.hops === 1 ? '' : 's'} deep`
  return (
    `    ${f.on_table}  —  trigger ${f.trigger_name}\n` +
    `      ${f.trigger_function}  (SECURITY INVOKER)\n` +
    `        └─ calls ${f.unexecutable_callee} ${via} — NO EXECUTE for this role\n` +
    `      Any write to ${f.on_table} by this role fails:\n` +
    `        permission denied for function ${f.unexecutable_callee.replace(/\(.*$/, '')}`
  )
}

async function main(): Promise<void> {
  const env = readEnv()
  if (!env) {
    console.log('trigger-grant audit — SKIPPED')
    console.log('  ! NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.')
    console.log('  ! This check has NO offline half: a grant is a live database fact,')
    console.log('  ! and there is nothing to mirror. Run it WITH credentials after any')
    console.log('  ! migration that adds a trigger, a trigger function, or a GRANT/REVOKE.')
    return
  }

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(env.url, env.key, { auth: { persistSession: false } })

  let failures = 0
  for (const role of ROLES) {
    const { data, error } = await sb.rpc('fn_audit_trigger_function_grants', { p_role: role })
    if (error) {
      throw new Error(
        `fn_audit_trigger_function_grants('${role}') failed: ${error.message}. ` +
          `Is migration 20260814025716_audit_trigger_function_grants_guard.sql applied?`,
      )
    }
    const findings = (data ?? []) as Finding[]
    if (findings.length === 0) {
      console.log(`  ok   ${role.padEnd(14)} no trigger reaches an un-executable function`)
      continue
    }
    failures += findings.length
    console.log(`  FAIL ${role.padEnd(14)} ${findings.length} broken write path(s):`)
    for (const f of findings) console.log(describe(f))
  }

  if (failures > 0) {
    throw new Error(
      `${failures} trigger/grant hole(s). A role that can write the table cannot ` +
        `complete the write. Fix with a GRANT EXECUTE in a migration — not by making ` +
        `the trigger function SECURITY DEFINER (that bypasses RLS on the write path).`,
    )
  }
  console.log(`\nAll ${ROLES.length} role trigger-grant audits passed.`)
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
