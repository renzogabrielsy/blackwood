/* ===================================================
   Charcoal KPI Adapter — Live Supabase → KPIData[]
   Tenant: Charcoal Plant Operations
   =================================================== */

import type { WidgetAdapter } from './types'
import type { KPIData, KPIStripSettings } from '@/components/widgets/kpi-strip/types'

/** Returns the first/last day of a given calendar month as ISO date strings */
function monthBounds(year: number, month: number): { start: string; end: string } {
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 0) // last day of month
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-PH', { maximumFractionDigits: 0 })
}

/** Compute ISO date bounds for the requested period relative to now */
function getPeriodBounds(
  period: KPIStripSettings['period'] = 'month',
): { start: string; end: string } {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)

  switch (period) {
    case 'today':
      return { start: today, end: today }

    case 'week': {
      const d = new Date(now)
      d.setDate(d.getDate() - 7)
      return { start: d.toISOString().slice(0, 10), end: today }
    }

    case 'month': {
      return monthBounds(now.getFullYear(), now.getMonth())
    }

    case 'quarter': {
      const year = now.getFullYear()
      const month = now.getMonth()
      const quarterStartMonth = Math.floor(month / 3) * 3
      const startDate = new Date(year, quarterStartMonth, 1)
      return { start: startDate.toISOString().slice(0, 10), end: today }
    }

    case 'year': {
      // Fiscal year: March → February
      const year = now.getFullYear()
      const month = now.getMonth()
      // If we're in Mar–Dec, fiscal year started in March of this year
      // If we're in Jan–Feb, fiscal year started in March of last year
      const fiscalStart =
        month >= 2
          ? new Date(year, 2, 1)
          : new Date(year - 1, 2, 1)
      return { start: fiscalStart.toISOString().slice(0, 10), end: today }
    }

    default:
      return monthBounds(now.getFullYear(), now.getMonth())
  }
}

/* ===================================================
   Core query + transform logic (shared by fetch + fetchWithPeriod)
   =================================================== */

async function queryAndBuild(
  client: Parameters<WidgetAdapter<KPIData[]>['fetch']>[0],
  period: KPIStripSettings['period'] = 'month',
): Promise<KPIData[]> {
  const now = new Date()
  const currYear = now.getFullYear()
  const currMonth = now.getMonth() // 0-indexed

  // Previous month (handles year wrap)
  const prevMonth = currMonth === 0 ? 11 : currMonth - 1
  const prevYear = currMonth === 0 ? currYear - 1 : currYear

  const periodBounds = getPeriodBounds(period)
  const prevBounds = monthBounds(prevYear, prevMonth)

  // Twelve months ago — for sparkline
  const twelveMonthsAgo = new Date(currYear, currMonth - 11, 1).toISOString().slice(0, 10)

  const [batchesResult, gridResult, rcInPeriodResult, rcOutPeriodResult, rcInPrevResult, sparklineResult] =
    await Promise.allSettled([
      // 1. Active batch count
      client
        .from('batches')
        .select('status')
        .in('status', ['STORED', 'IN-USE']),

      // 2. Blocking grid for slot occupancy + weighted PHP/KG
      client
        .from('view_blocking_grid')
        .select('block_loc, balance, avg_php_kg'),

      // 3. RC IN for selected period (weight)
      client
        .from('deliveries')
        .select('weight_kg')
        .gte('transaction_date', periodBounds.start)
        .lte('transaction_date', periodBounds.end),

      // 4. RC OUT for selected period (weight)
      client
        .from('rc_out')
        .select('weight_kg')
        .gte('transaction_date', periodBounds.start)
        .lte('transaction_date', periodBounds.end),

      // 5. RC IN previous month (for PHP/KG MoM trend)
      client
        .from('deliveries')
        .select('weight_kg, cost_basis')
        .gte('transaction_date', prevBounds.start)
        .lte('transaction_date', prevBounds.end),

      // 6. Last 12 months deliveries for sparkline (PHP/KG per month)
      client
        .from('deliveries')
        .select('transaction_date, weight_kg, cost_basis')
        .gte('transaction_date', twelveMonthsAgo)
        .order('transaction_date', { ascending: true }),
    ])

  /* ---------- 1. Batch count ---------- */
  const batches = batchesResult.status === 'fulfilled' ? (batchesResult.value.data ?? []) : []
  const batchCount = batches.length

  /* ---------- 2. Slot occupancy + weighted avg PHP/KG + total balance ---------- */
  const gridRows = gridResult.status === 'fulfilled' ? (gridResult.value.data ?? []) : []
  const totalSlots = 220
  const occupiedSlots = gridRows.length

  let totalBalance = 0
  let weightedPhpSum = 0
  for (const row of gridRows) {
    const bal = Number(row.balance ?? 0)
    const php = Number(row.avg_php_kg ?? 0)
    totalBalance += bal
    weightedPhpSum += php * bal
  }
  const currentPhpKg = totalBalance > 0 ? weightedPhpSum / totalBalance : 0
  const totalWeightT = totalBalance / 1000
  const occupancyPct = Math.round((occupiedSlots / totalSlots) * 100)

  /* ---------- 3 & 4. Period flow ---------- */
  const rcInRows = rcInPeriodResult.status === 'fulfilled' ? (rcInPeriodResult.value.data ?? []) : []
  const rcOutRows = rcOutPeriodResult.status === 'fulfilled' ? (rcOutPeriodResult.value.data ?? []) : []
  const rcInKg = rcInRows.reduce((sum, r) => sum + Number(r.weight_kg ?? 0), 0)
  const rcOutKg = rcOutRows.reduce((sum, r) => sum + Number(r.weight_kg ?? 0), 0)
  const rcInT = rcInKg / 1000
  const rcOutT = rcOutKg / 1000
  const netFlowT = rcInT - rcOutT

  /* ---------- 5. Previous month PHP/KG (MoM trend) ---------- */
  const prevRows = rcInPrevResult.status === 'fulfilled' ? (rcInPrevResult.value.data ?? []) : []
  let prevTotalKg = 0
  let prevWeightedPhpSum = 0
  for (const r of prevRows) {
    const w = Number(r.weight_kg ?? 0)
    const c = Number(r.cost_basis ?? 0)
    prevTotalKg += w
    prevWeightedPhpSum += c * w
  }
  const prevPhpKg = prevTotalKg > 0 ? prevWeightedPhpSum / prevTotalKg : 0
  const phpDelta = currentPhpKg - prevPhpKg

  /* ---------- 6. PHP/KG sparkline — last 12 months ---------- */
  const sparklineRows = sparklineResult.status === 'fulfilled' ? (sparklineResult.value.data ?? []) : []

  // Group by YYYY-MM, compute weighted avg PHP/KG per month
  const monthMap = new Map<string, { totalKg: number; weightedSum: number }>()
  for (const r of sparklineRows) {
    const ym = (r.transaction_date as string).slice(0, 7)
    const w = Number(r.weight_kg ?? 0)
    const c = Number(r.cost_basis ?? 0)
    const entry = monthMap.get(ym) ?? { totalKg: 0, weightedSum: 0 }
    entry.totalKg += w
    entry.weightedSum += c * w
    monthMap.set(ym, entry)
  }
  const sparkline = Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => (v.totalKg > 0 ? v.weightedSum / v.totalKg : 0))
    .filter(v => v > 0)

  /* ---------- Labels ---------- */
  const monthLabel = now.toLocaleString('en-US', { month: 'short' })
  const prevMonthLabel = new Date(prevYear, prevMonth, 1).toLocaleString('en-US', { month: 'short' })
  // Dynamic period label for flow chip
  const periodLabel =
    period === 'today' ? 'Today'
    : period === 'week' ? '7-Day'
    : period === 'quarter' ? 'Quarter'
    : period === 'year' ? 'FY'
    : monthLabel // default: current month short name

  /* ---------- Build KPI chips ---------- */
  const kpiData: KPIData[] = [
    {
      label: 'Total Inventory',
      value: `${formatNumber(Math.round(totalWeightT))} T`,
      sub: `${batchCount} active batch${batchCount !== 1 ? 'es' : ''}`,
      pinned: true,
    },
    {
      label: 'Warehouse',
      value: `${occupiedSlots}/${totalSlots} (${occupancyPct}%)`,
      variant: 'progress',
      thresholds: [
        { value: 85, status: 'danger' },
        { value: 70, status: 'warning' },
        { value: 0, status: 'good' },
      ],
      drilldown: { href: '/inventory' },
    },
    {
      label: 'Current PHP/KG',
      value: currentPhpKg > 0 ? currentPhpKg.toFixed(2) : '--',
      prefix: '₱',
      pinned: true,
      sparkline: sparkline.length >= 2 ? sparkline : undefined,
      comparison:
        prevPhpKg > 0 && currentPhpKg > 0
          ? {
              value: `${phpDelta >= 0 ? '+' : ''}₱${phpDelta.toFixed(2)}`,
              label: `vs ${prevMonthLabel}`,
              trend: phpDelta > 0 ? 'up' : phpDelta < 0 ? 'down' : 'neutral',
            }
          : undefined,
    },
    {
      label: `${periodLabel} Flow`,
      variant: 'flow',
      value: `${netFlowT >= 0 ? '+' : ''}${formatNumber(Math.round(netFlowT))} T`,
      flowData: {
        inValue: `${formatNumber(Math.round(rcInT))} T`,
        outValue: `${formatNumber(Math.round(rcOutT))} T`,
        netValue: `${netFlowT >= 0 ? '+' : ''}${formatNumber(Math.round(netFlowT))} T`,
      },
      drilldown: { href: '/inventory' },
    },
  ]

  return kpiData
}

/* ===================================================
   Exported adapter
   The `fetch` method is the WidgetAdapter<TPort> contract — do not change.
   `fetchWithPeriod` is an extra method for period-aware server action calls.
   =================================================== */

export const charcoalKpiAdapter: WidgetAdapter<KPIData[]> & {
  fetchWithPeriod: (
    client: Parameters<WidgetAdapter<KPIData[]>['fetch']>[0],
    period?: KPIStripSettings['period'],
  ) => Promise<KPIData[]>
} = {
  id: 'charcoal-kpi',

  /** Standard WidgetAdapter contract — always fetches for the current calendar month */
  async fetch(client) {
    return queryAndBuild(client, 'month')
  },

  /** Period-aware fetch used by the period selector server action */
  async fetchWithPeriod(client, period = 'month') {
    return queryAndBuild(client, period)
  },
}
