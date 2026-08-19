import 'server-only'

import { createClient } from '@/lib/supabase/server'
import { getUserRole } from '@/lib/auth'
import { PRIVILEGED_ROLES } from '@/types/auth'
import { flattenRunFindings } from '@/lib/sync/findings'
import { countDecisionsNeedingYou } from '@/lib/sync/decision-cards'
import type { SyncRunResult } from './types'
import { fetchCurrentAcks } from './acks'

/**
 * needs-you.ts — the ONE number the dashboard shows about Sync Review.
 *
 * "How many things from the last sync are still waiting on me." Not a new page, not a new
 * query language: it is literally the panel's own count, produced by the same two pure
 * functions the panel uses (`flattenRunFindings` → `countDecisionsNeedingYou`) over the
 * same acknowledgement map. If it ever disagreed with the panel, one of them would be
 * lying, so there is deliberately no second definition here.
 *
 * NOT a server action — it is READ-ONLY and reached only from a Server Component, so it
 * carries no `'use server'` directive and cannot be invoked from a browser. `server-only`
 * makes that a build error rather than a convention.
 *
 * ROLE. Privileged (Owner / Admin / Dev) only, derived through `getUserRole()` so the
 * dev-impersonation cookie is respected. A refusal returns `ok: false` rather than
 * throwing — the digest must render whether or not this resolves.
 *
 * FAILS QUIET, NEVER FAILS LOUD-AND-WRONG. Every failure path returns `count: 0`, which
 * renders NOTHING. That is the honest direction for a badge: a missing nudge costs a click
 * into the panel, whereas a fabricated "3 need you" would send someone looking for work
 * that is not there. The error text still rides along so a caller can surface it.
 */

export interface SyncNeedsYou {
  ok: boolean
  /** Decisions still waiting. Zero → the caller renders nothing at all. */
  count: number
  /** The findings inside those decisions — the honest flag total behind the number. */
  flags: number
  /** The run the count is about, for the `/sync/cases?run=…` deep link. */
  runId: string | null
  /** Why the count could not be produced. Present only when `ok` is false. */
  error?: string
}

const NONE: SyncNeedsYou = { ok: true, count: 0, flags: 0, runId: null }

export async function getSyncNeedsYou(): Promise<SyncNeedsYou> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NONE

  const role = await getUserRole(user.id)
  if (!PRIVILEGED_ROLES.includes(role)) return NONE

  // The most recent run that actually finished with something to say. A run still in
  // flight has no `result`, and counting an empty one would flash a 0 mid-sync.
  const { data, error } = await supabase
    .from('sync_runs')
    .select('id, result')
    .not('result', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    return { ok: false, count: 0, flags: 0, runId: null, error: error.message }
  }
  if (!data) return NONE

  const findings = flattenRunFindings(data.result as unknown as SyncRunResult)
  if (findings.length === 0) return { ok: true, count: 0, flags: 0, runId: data.id }

  const acks = await fetchCurrentAcks()
  if (!acks.ok) {
    return { ok: false, count: 0, flags: 0, runId: data.id, error: acks.error }
  }

  const { decisions, flags } = countDecisionsNeedingYou(findings, acks.acks)
  return { ok: true, count: decisions, flags, runId: data.id }
}
