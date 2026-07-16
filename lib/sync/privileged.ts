/**
 * privileged.ts — the shared Owner/Admin/Dev auth guard for every sync server
 * action. Extracted from app/(app)/sync/actions.ts so cases.ts and actions.ts
 * enforce the SAME boundary (one source of truth, no drift).
 *
 * Server-only: it imports the per-request server Supabase client. Both callers
 * (actions.ts, cases.ts) are 'use server', so that is fine.
 */
import { createClient } from '@/lib/supabase/server'
import { getUserRole } from '@/lib/auth'
import { PRIVILEGED_ROLES } from '@/types/auth'

/**
 * Only Owner/Admin/Dev may run a sync, adjudicate held rows, or touch cases.
 * Derives the EFFECTIVE role via getUserRole() so the dev-impersonation cookie is
 * respected (an Owner "viewing as Production" is denied). Fails closed — throws if
 * unauthenticated or under-privileged.
 *
 * Returns the authenticated user id so the caller can stamp `requested_by` etc.
 */
export async function requirePrivileged(): Promise<string> {
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
