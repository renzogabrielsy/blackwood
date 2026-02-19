/* ===================================================
   Charcoal Chart Adapter — Live Supabase → ChartConfig
   Tenant: Charcoal Plant Operations
   =================================================== */

import type { WidgetAdapter } from './types'
import type { ChartConfig, ChartDataPoint, FiscalCalEntry } from '@/components/widgets/chart/types'
import {
  CHART_PALETTE,
  SLICE_PALETTE,
} from '@/lib/widgets/mock-data'

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
    async function fetchAll<T>(buildQuery: () => ReturnType<typeof client.from>): Promise<T[]> {
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

    const phpKgInPoints = makePoints(acc =>
      acc.rcInKg > 0 ? acc.weightedPhpIn / acc.rcInKg : null,
    )

    const rcInVolumePoints = makePoints(acc =>
      acc.rcInKg > 0 ? acc.rcInKg / 1000 : null, // convert kg → tonnes
    )

    const rcOutVolumePoints = makePoints(acc =>
      acc.rcOutKg > 0 ? acc.rcOutKg / 1000 : null,
    )

    const netStockPoints = makePoints(acc => {
      const netKg = acc.rcInKg - acc.rcOutKg
      return acc.rcInKg > 0 || acc.rcOutKg > 0 ? netKg / 1000 : null
    })

    const mcPoints = makePoints(acc =>
      acc.rcInKg > 0 ? acc.weightedMc / acc.rcInKg : null,
    )

    const ashPoints = makePoints(acc =>
      acc.rcInKg > 0 ? acc.weightedAsh / acc.rcInKg : null,
    )

    const bdAstmPoints = makePoints(acc =>
      acc.rcInKg > 0 ? acc.weightedBdAstm / acc.rcInKg : null,
    )

    const momPctPoints: ChartDataPoint[] = []
    for (let i = 1; i < fiscalCalendar.length; i++) {
      const curr = fiscalCalendar[i]
      const prev = fiscalCalendar[i - 1]
      const currAcc = yearAccs.get(curr.fiscalYear)![curr.fiscalMonth]
      const prevAcc = yearAccs.get(prev.fiscalYear)![prev.fiscalMonth]
      if (currAcc.rcInKg > 0 && prevAcc.rcInKg > 0 && prevAcc.weightedPhpIn > 0) {
        const currPhp = currAcc.weightedPhpIn / currAcc.rcInKg
        const prevPhp = prevAcc.weightedPhpIn / prevAcc.rcInKg
        momPctPoints.push({ x: curr.x, value: parseFloat(((currPhp - prevPhp) / prevPhp * 100).toFixed(2)) })
      }
    }

    /* ---------- Assemble ChartConfig ---------- */
    const config: ChartConfig = {
      xAxis: {
        labels: fiscalCalendar.map(e => e.label),
        showQuarterBoundaries: false, // quarter boundaries less meaningful across multi-year span
        quarterBoundaryPositions: [],
      },
      yAxis: { unit: '\u20B1', unitPos: 'prefix' },
      seriesGroups: [
        { key: 'price',   label: 'Price',   unit: '\u20B1', unitPos: 'prefix' },
        { key: 'volume',  label: 'Volume',  unit: 'T',      unitPos: 'suffix' },
        { key: 'quality', label: 'Quality', unit: '',       unitPos: 'suffix' },
        { key: 'ratio',   label: 'Ratio',   unit: '%',      unitPos: 'suffix' },
        { key: 'change',  label: 'Change',  unit: '%',      unitPos: 'suffix' },
      ],
      series: [
        {
          key: 'php_kg_in',
          label: 'PHP/KG In',
          color: CHART_PALETTE[0],  // blue
          style: 'area',
          group: 'price',
          points: phpKgInPoints,
        },
        {
          key: 'php_kg_out',
          label: 'PHP/KG Out',
          color: CHART_PALETTE[1],  // purple
          style: 'dashed',
          group: 'price',
          points: [],  // rc_out has no price stored — zeroed per plan
        },
        {
          key: 'rcin_volume',
          label: 'RC IN (T)',
          color: CHART_PALETTE[2],  // green
          style: 'bar',
          group: 'volume',
          points: rcInVolumePoints,
        },
        {
          key: 'rcout_volume',
          label: 'RC OUT (T)',
          color: CHART_PALETTE[3],  // red
          style: 'bar',
          group: 'volume',
          points: rcOutVolumePoints,
        },
        {
          key: 'net_stock',
          label: 'Net Stock (T)',
          color: CHART_PALETTE[9],  // emerald
          style: 'line',
          group: 'volume',
          points: netStockPoints,
        },
        {
          key: 'mc',
          label: 'MC',
          color: CHART_PALETTE[5],  // cyan
          style: 'line',
          group: 'quality',
          points: mcPoints,
        },
        {
          key: 'ash',
          label: 'ASH',
          color: CHART_PALETTE[6],  // orange
          style: 'line',
          group: 'quality',
          points: ashPoints,
        },
        {
          key: 'bd_astm',
          label: 'BD ASTM',
          color: CHART_PALETTE[7],  // violet
          style: 'line',
          group: 'quality',
          points: bdAstmPoints,
        },
        {
          key: 'mom_pct',
          label: 'MoM %',
          color: CHART_PALETTE[8],  // pink/amber
          style: 'line',
          group: 'change',
          points: momPctPoints,
        },
      ],
      presets: [
        { key: 'trajectory', label: 'Trajectory',   seriesKeys: ['php_kg_in'] },
        { key: 'spread',     label: 'Price Spread', seriesKeys: ['php_kg_in', 'php_kg_out'] },
        { key: 'volume',     label: 'Volume',       seriesKeys: ['rcin_volume', 'rcout_volume'] },
        { key: 'combo',      label: 'Vol + Price',  seriesKeys: ['rcin_volume', 'rcout_volume', 'php_kg_in'] },
        { key: 'quality',    label: 'Quality',      seriesKeys: ['mc', 'ash', 'bd_astm'] },
      ],
      defaultPreset: 'trajectory',
      fiscalCalendar,
      dataYears: sortedYears, // plain calendar year strings: ['2020', ..., '2026']
    }

    // If no data was loaded from Supabase, return empty config so fallback is triggered upstream
    if (phpKgInPoints.length === 0 && rcInVolumePoints.length === 0) {
      throw new Error('No chart data available — falling back to static adapter')
    }

    return config
  },
}

// Re-export SLICE_PALETTE so DashboardGrid can use it if needed without importing mock-data
export { SLICE_PALETTE }
