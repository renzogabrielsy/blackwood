'use server'

import { createClient } from '@/lib/supabase/server'
import { charcoalKpiAdapter } from '@/lib/widgets/adapters/charcoal-kpi'
import type { KPIData, KPIStripSettings } from '@/components/widgets/kpi-strip/types'
import type { D6Prefs } from '@/lib/dashboard/types'

/**
 * Fetches KPI chip data for the given time period.
 * Called from DashboardGrid when the user changes the period selector.
 */
export async function fetchKpiData(
  period: KPIStripSettings['period'] = 'month',
): Promise<KPIData[]> {
  const supabase = await createClient()
  return charcoalKpiAdapter.fetchWithPeriod(supabase, period)
}

/**
 * Loads the authenticated user's dashboard preferences from Supabase.
 * Returns null when no saved prefs exist or on any error.
 * Called from page.tsx (server-side) to seed the initial grid state.
 */
export async function loadDashboardPrefs(): Promise<D6Prefs | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('user_dashboard_prefs')
    .select('prefs')
    .maybeSingle()
  if (error || !data) return null
  return data.prefs as D6Prefs
}

/**
 * Persists the authenticated user's dashboard preferences to Supabase.
 * Upserts on user_id conflict — one row per user.
 * No revalidatePath() — this is a background sync, no page reload intended.
 */
export async function saveDashboardPrefs(prefs: D6Prefs): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  await supabase
    .from('user_dashboard_prefs')
    .upsert({ user_id: user.id, prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
}
