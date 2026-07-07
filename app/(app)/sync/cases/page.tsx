import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import { getUserRole } from '@/lib/auth'
import { PRIVILEGED_ROLES } from '@/types/auth'
import { listOpenCases } from '../cases'
import { CasesClient, type WireCase } from '@/components/sync/cases/CasesClient'

export const metadata = {
  title: 'Sync Review — Blackwood',
}

export const dynamic = 'force-dynamic'

export default async function SyncCasesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const role = await getUserRole(user.id)
  if (!PRIVILEGED_ROLES.includes(role)) {
    redirect('/inventory')
  }

  // Fetch open cases. Wrap so the client always renders even if the action throws.
  let initialCases: WireCase[] = []
  let initialError: string | null = null
  try {
    const rows = await listOpenCases()
    initialCases = rows.map((r) => ({
      id: r.id,
      report_type: r.report_type,
      kind: r.kind,
      natural_key: r.natural_key,
      reason: r.reason,
      detail: r.detail,
      row: r.row,
      status: r.status,
      occurrence_count: r.occurrence_count,
      last_seen_at: r.last_seen_at,
      known_ruling_id: r.known_ruling_id,
      known_ruling_summary: r.known_ruling_summary,
      verdict: r.verdict,
    }))
  } catch (err) {
    initialError = err instanceof Error ? err.message : 'Failed to load review cases'
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/10">
      <CasesClient initialCases={initialCases} initialError={initialError} />
    </div>
  )
}
