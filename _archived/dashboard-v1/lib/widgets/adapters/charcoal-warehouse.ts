/* ===================================================
   Charcoal Warehouse Adapter — Live Supabase → WarehouseData[]
   Tenant: Charcoal Plant Operations
   =================================================== */

import type { WidgetAdapter } from './types'
import type { WarehouseData } from '@/components/widgets/warehouse-occupancy/types'

/** Hardcoded total slot counts per warehouse — physical layout never changes */
const WAREHOUSE_TOTALS: Record<string, number> = {
  A: 60,
  B: 40,
  C: 40,
  D: 80,
}

/** All valid warehouse letters in display order */
const WAREHOUSE_ORDER = ['A', 'B', 'C', 'D'] as const

export const charcoalWarehouseAdapter: WidgetAdapter<WarehouseData[]> = {
  id: 'charcoal-warehouse',

  async fetch(client) {
    const { data: rows, error } = await client
      .from('view_blocking_grid')
      .select('block_loc, balance, avg_php_kg, avg_mc, avg_ash')

    if (error || !rows || rows.length === 0) {
      // Return zero-state for all 4 warehouses
      return WAREHOUSE_ORDER.map(label => ({
        label,
        occupied: 0,
        total: WAREHOUSE_TOTALS[label],
        phpKg: 0,
        mc: 0,
        ash: 0,
      }))
    }

    // Aggregate per warehouse letter (first char of block_loc, e.g. 'A' from 'A-1A')
    interface WhseAccumulator {
      occupied: number
      totalBalance: number
      weightedPhp: number
      weightedMc: number
      weightedAsh: number
    }

    const accumulators = new Map<string, WhseAccumulator>()
    for (const label of WAREHOUSE_ORDER) {
      accumulators.set(label, { occupied: 0, totalBalance: 0, weightedPhp: 0, weightedMc: 0, weightedAsh: 0 })
    }

    for (const row of rows) {
      // block_loc format: 'A-1A', 'B-5B', etc. — first character is warehouse letter
      const whse = (row.block_loc as string | null)?.[0]?.toUpperCase()
      if (!whse || !accumulators.has(whse)) continue

      const acc = accumulators.get(whse)!
      const bal = Number(row.balance ?? 0)
      const php = Number(row.avg_php_kg ?? 0)
      const mc = Number(row.avg_mc ?? 0)
      const ash = Number(row.avg_ash ?? 0)

      acc.occupied += 1
      acc.totalBalance += bal
      acc.weightedPhp += php * bal
      acc.weightedMc += mc * bal
      acc.weightedAsh += ash * bal
    }

    return WAREHOUSE_ORDER.map(label => {
      const acc = accumulators.get(label)!
      const bal = acc.totalBalance
      return {
        label,
        occupied: acc.occupied,
        total: WAREHOUSE_TOTALS[label],
        phpKg: bal > 0 ? acc.weightedPhp / bal : 0,
        mc: bal > 0 ? acc.weightedMc / bal : 0,
        ash: bal > 0 ? acc.weightedAsh / bal : 0,
      }
    })
  },
}
