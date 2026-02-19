/* ===================================================
   Charcoal Scatter Adapter — Live Supabase → ScatterPoint[]
   Tenant: Charcoal Plant Operations
   =================================================== */

import { format } from 'date-fns'
import type { WidgetAdapter } from './types'
import type { ScatterPoint } from '@/components/widgets/quality-scatter/types'

interface DeliveryRow {
  transaction_date: string | null
  weight_kg: number | string | null
  cost_basis: number | string | null
  lab_results: unknown
}

interface MonthAccumulator {
  totalWeight: number
  weightedPhp: number
  weightedMc: number
  weightedAsh: number
  date: Date
}

export const charcoalScatterAdapter: WidgetAdapter<ScatterPoint[]> = {
  id: 'charcoal-scatter',

  async fetch(client) {
    const { data, error } = await client
      .from('deliveries')
      .select('transaction_date, weight_kg, cost_basis, lab_results')
      .not('lab_results', 'is', null)
      .order('transaction_date', { ascending: true })

    if (error || !data || data.length === 0) return []

    // Group by YYYY-MM and compute weighted averages
    const monthMap = new Map<string, MonthAccumulator>()

    for (const row of data as DeliveryRow[]) {
      if (!row.transaction_date) continue

      // Parse with local time to avoid UTC offset issues
      const d = new Date(row.transaction_date + 'T00:00:00')
      if (isNaN(d.getTime())) continue

      const key = format(d, 'yyyy-MM')

      const weightKg = Number(row.weight_kg ?? 0)
      const cost = Number(row.cost_basis ?? 0)
      const lab = row.lab_results as Record<string, unknown> | null
      const mc = lab?.mc !== undefined && lab.mc !== null ? Number(lab.mc) : null
      const ash = lab?.ash !== undefined && lab.ash !== null ? Number(lab.ash) : null

      if (weightKg <= 0 || mc === null || ash === null) continue

      if (!monthMap.has(key)) {
        monthMap.set(key, { totalWeight: 0, weightedPhp: 0, weightedMc: 0, weightedAsh: 0, date: d })
      }

      const acc = monthMap.get(key)!
      acc.totalWeight += weightKg
      acc.weightedPhp += cost * weightKg
      acc.weightedMc += mc * weightKg
      acc.weightedAsh += ash * weightKg
    }

    // Convert to ScatterPoint[], sorted by date
    return Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, acc]) => {
        const w = acc.totalWeight
        const d = acc.date
        return {
          phpKg: w > 0 ? acc.weightedPhp / w : 0,
          mc: w > 0 ? acc.weightedMc / w : 0,
          ash: w > 0 ? acc.weightedAsh / w : 0,
          label: format(d, 'MMM yyyy'),   // e.g. "Feb 2026"
          year: format(d, 'yyyy'),         // e.g. "2026"
        }
      })
  },
}
