/* ===================================================
   Charcoal Chart Adapter — Live Supabase → ChartConfig
   Tenant: Charcoal Plant Operations

   Series metadata (keys, labels, colors, styles, groups) and presets
   imported from tenant-config.ts — the single source of truth for
   charcoal chart configuration.
   =================================================== */

import type { WidgetAdapter } from './types'
import type { ChartConfig, ChartDataPoint, FiscalCalEntry } from '@/components/widgets/chart/types'
import { CHARCOAL_CHART_CONFIG, SLICE_PALETTE } from './tenant-config'

/* ---------- Calendar year / month helpers ---------- */

const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Returns calendar year string for a date.
 * Jan 2025 → '2025', Dec 2026 → '2026'
 */
function getCalYear(date: Date): string {
  return String(date.getFullYear())
}

/**
 * Returns calendar month index: Jan=0, Feb=1, ..., Dec=11
 */
function getCalMonth(date: Date): number {
  return date.getMonth()
}

/* ---------- Delivery / RC OUT row types ---------- */

interface DeliveryRow {
  transaction_date: string | null
  weight_kg: number | string | null
  cost_basis: number | string | null
  lab_results: unknown
}

interface RcOutRow {
  transaction_date: string | null
  weight_kg: number | string | null
}

/* ---------- Per-fiscal-month accumulator ---------- */

interface MonthAcc {
  rcInKg: number
  rcOutKg: number
  weightedPhpIn: number
  weightedMc: number
  weightedAsh: number
  weightedBdAstm: number
}

function emptyAcc(): MonthAcc {
  return { rcInKg: 0, rcOutKg: 0, weightedPhpIn: 0, weightedMc: 0, weightedAsh: 0, weightedBdAstm: 0 }
}

/* ---------- Adapter ---------- */

export const charcoalChartAdapter: WidgetAdapter<ChartConfig> = {
  id: 'charcoal-chart',

  async fetch(client) {
    // Paginated fetch helper to bypass PostgREST max_rows (1000)
    const PAGE = 1000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function fetchAll<T>(buildQuery: () => any): Promise<T[]> {
      let all: T[] = []
      let from = 0
      let hasMore = true
      while (hasMore) {
        const { data } = await (buildQuery() as any).range(from, from + PAGE - 1)
        all = all.concat(data || [])
        hasMore = (data?.length || 0) === PAGE
        from += PAGE
      }
      return all
    }

    const [rcInRows, rcOutRows] = await Promise.all([
      fetchAll<DeliveryRow>(() =>
        client
          .from('deliveries')
          .select('transaction_date, weight_kg, cost_basis, lab_results')
          .order('transaction_date', { ascending: true }),
      ),
      fetchAll<RcOutRow>(() =>
        client
          .from('rc_out')
          .select('transaction_date, weight_kg')
          .order('transaction_date', { ascending: true }),
      ),
    ])

    // Map<calYear, MonthAcc[12]> — one accumulator per calendar month per calendar year
    // Index 0=Jan, 1=Feb, ..., 11=Dec
    const yearAccs = new Map<string, MonthAcc[]>()

    function getOrCreateYearAccs(year: string): MonthAcc[] {
      if (!yearAccs.has(year)) {
        yearAccs.set(year, Array.from({ length: 12 }, emptyAcc))
      }
      return yearAccs.get(year)!
    }

    /* ---------- Aggregate RC IN ---------- */
    for (const row of rcInRows) {
      if (!row.transaction_date) continue
      const d = new Date(row.transaction_date + 'T00:00:00')
      if (isNaN(d.getTime())) continue

      const year = getCalYear(d)
      const month = getCalMonth(d)
      const accs = getOrCreateYearAccs(year)

      const w = Number(row.weight_kg ?? 0)
      const cost = Number(row.cost_basis ?? 0)
      const lab = row.lab_results as Record<string, unknown> | null
      const mc = lab?.mc !== undefined && lab.mc !== null ? Number(lab.mc) : 0
      const ash = lab?.ash !== undefined && lab.ash !== null ? Number(lab.ash) : 0
      const bdAstm = lab?.bd_astm !== undefined && lab.bd_astm !== null ? Number(lab.bd_astm) : 0

      accs[month].rcInKg += w
      accs[month].weightedPhpIn += cost * w
      accs[month].weightedMc += mc * w
      accs[month].weightedAsh += ash * w
      accs[month].weightedBdAstm += bdAstm * w
    }

    /* ---------- Aggregate RC OUT ---------- */
    for (const row of rcOutRows) {
      if (!row.transaction_date) continue
      const d = new Date(row.transaction_date + 'T00:00:00')
      if (isNaN(d.getTime())) continue

      const year = getCalYear(d)
      const month = getCalMonth(d)
      const accs = getOrCreateYearAccs(year)

      accs[month].rcOutKg += Number(row.weight_kg ?? 0)
    }

    // Sort calendar years ascending (e.g. ['2020', '2021', ..., '2026'])
    const sortedYears = Array.from(yearAccs.keys()).sort()

    /* ---------- Build fiscalCalendar ----------
     * One FiscalCalEntry per month that has any RC IN or RC OUT data.
     * x is the chronological index starting at 0.
     * With plain calendar years: fiscalYear = '2025', fiscalMonth = calIdx = 0–11 (Jan=0)
     */
    const fiscalCalendar: FiscalCalEntry[] = []
    let x = 0
    for (const year of sortedYears) {
      const accs = yearAccs.get(year)!
      for (let month = 0; month < 12; month++) {
        const acc = accs[month]
        if (acc.rcInKg > 0 || acc.rcOutKg > 0) {
          const label = `${MONTH_ABBREVS[month]} ${year}`

          fiscalCalendar.push({
            x,
            calIdx: month,       // calendar month index (Jan=0, Dec=11)
            fiscalYear: year,    // plain calendar year string e.g. '2025'
            fiscalMonth: month,  // same as calIdx — calendar month (Jan=0)
            label,
          })
          x++
        }
      }
    }

    /* ---------- Build series points ----------
     * Iterate fiscalCalendar entries in order. Each entry corresponds exactly to one x value.
     */
    function makePoints(fn: (acc: MonthAcc) => number | null): ChartDataPoint[] {
      const points: ChartDataPoint[] = []
      for (const entry of fiscalCalendar) {
        const accs = yearAccs.get(entry.fiscalYear)!
        const acc = accs[entry.fiscalMonth]
        const val = fn(acc)
        if (val !== null) {
          points.push({ x: entry.x, value: val })
        }
      }
      return points
    }

    /* ---- Map series keys to their computed data points ---- */
    const seriesPointsMap: Record<string, ChartDataPoint[]> = {
      php_kg_in: makePoints(acc =>
        acc.rcInKg > 0 ? acc.weightedPhpIn / acc.rcInKg : null,
      ),
      php_kg_out: [], // rc_out has no price stored — zeroed per plan
      rcin_volume: makePoints(acc =>
        acc.rcInKg > 0 ? acc.rcInKg / 1000 : null, // convert kg → tonnes
      ),
      rcout_volume: makePoints(acc =>
        acc.rcOutKg > 0 ? acc.rcOutKg / 1000 : null,
      ),
      net_stock: makePoints(acc => {
        const netKg = acc.rcInKg - acc.rcOutKg
        return acc.rcInKg > 0 || acc.rcOutKg > 0 ? netKg / 1000 : null
      }),
      mc: makePoints(acc =>
        acc.rcInKg > 0 ? acc.weightedMc / acc.rcInKg : null,
      ),
      ash: makePoints(acc =>
        acc.rcInKg > 0 ? acc.weightedAsh / acc.rcInKg : null,
      ),
      bd_astm: makePoints(acc =>
        acc.rcInKg > 0 ? acc.weightedBdAstm / acc.rcInKg : null,
      ),
      mom_pct: (() => {
        const points: ChartDataPoint[] = []
        for (let i = 1; i < fiscalCalendar.length; i++) {
          const curr = fiscalCalendar[i]
          const prev = fiscalCalendar[i - 1]
          const currAcc = yearAccs.get(curr.fiscalYear)![curr.fiscalMonth]
          const prevAcc = yearAccs.get(prev.fiscalYear)![prev.fiscalMonth]
          if (currAcc.rcInKg > 0 && prevAcc.rcInKg > 0 && prevAcc.weightedPhpIn > 0) {
            const currPhp = currAcc.weightedPhpIn / currAcc.rcInKg
            const prevPhp = prevAcc.weightedPhpIn / prevAcc.rcInKg
            points.push({ x: curr.x, value: parseFloat(((currPhp - prevPhp) / prevPhp * 100).toFixed(2)) })
          }
        }
        return points
      })(),
    }

    /* ---------- Assemble ChartConfig from tenant config ---------- */
    const cfg = CHARCOAL_CHART_CONFIG

    const config: ChartConfig = {
      xAxis: {
        labels: fiscalCalendar.map(e => e.label),
        showQuarterBoundaries: false, // quarter boundaries less meaningful across multi-year span
        quarterBoundaryPositions: [],
      },
      yAxis: { unit: cfg.yAxisUnit, unitPos: cfg.yAxisUnitPos },
      seriesGroups: cfg.seriesGroups.map(g => ({
        key: g.key,
        label: g.label,
        unit: g.unit,
        unitPos: g.unitPos,
      })),
      series: cfg.series.map(s => ({
        key: s.key,
        label: s.label,
        color: s.color,
        style: s.style,
        group: s.group,
        points: seriesPointsMap[s.key] ?? [],
      })),
      presets: cfg.presets.map(p => ({
        key: p.key,
        label: p.label,
        seriesKeys: p.seriesKeys,
      })),
      defaultPreset: cfg.defaultPreset,
      fiscalCalendar,
      dataYears: sortedYears, // plain calendar year strings: ['2020', ..., '2026']
    }

    // If no data was loaded from Supabase, return empty config so fallback is triggered upstream
    if ((seriesPointsMap.php_kg_in?.length ?? 0) === 0 && (seriesPointsMap.rcin_volume?.length ?? 0) === 0) {
      throw new Error('No chart data available — falling back to static adapter')
    }

    return config
  },
}

// Re-export SLICE_PALETTE so DashboardGrid can use it if needed without importing mock-data
export { SLICE_PALETTE }
