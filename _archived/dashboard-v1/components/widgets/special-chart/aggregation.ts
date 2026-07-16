/* ===================================================
   SpecialChartWidget — Aggregation Utilities
   Pure module-level functions — no React, no imports from data sources.
   =================================================== */

import { format, parseISO, parse } from 'date-fns'
import type { FieldDef, SpecialChartData, ScatterGranularity } from './types'

/* ===================================================
   Color Palettes
   =================================================== */

export const YEAR_COLORS: Record<string, string> = {
  '2020': '#94a3b8', // slate
  '2021': '#6b7280', // gray
  '2022': '#f87171', // red
  '2023': '#a78bfa', // purple
  '2024': '#fbbf24', // amber
  '2025': '#60a5fa', // blue
  '2026': '#10b981', // emerald
  '2027': '#22d3ee', // cyan
  '2028': '#fb923c', // orange
}

export const GENERIC_PALETTE: string[] = [
  '#60a5fa', // blue
  '#f87171', // red
  '#34d399', // green
  '#fbbf24', // amber
  '#a78bfa', // purple
  '#22d3ee', // cyan
  '#fb923c', // orange
  '#c084fc', // violet
  '#f472b6', // pink
  '#10b981', // emerald
  '#94a3b8', // slate
]

/* ===================================================
   Field helpers
   =================================================== */

export function numericFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter(f => f.type === 'numeric')
}

export function categoricalFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter(f => f.type === 'categorical')
}

export function fieldLabel(fields: FieldDef[], key: string): string {
  return fields.find(f => f.key === key)?.label ?? key
}

export function fieldUnit(fields: FieldDef[], key: string): string {
  return fields.find(f => f.key === key)?.unit ?? ''
}

/* ===================================================
   Nice axis scale helper
   =================================================== */

const NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000]

export function niceScale(min: number, max: number, targetTicks = 6) {
  if (min === max) {
    const fallbackStep = Math.abs(min) * 0.1 || 1
    return {
      axisMin: min - fallbackStep,
      axisMax: max + fallbackStep,
      ticks: [min - fallbackStep, min, max + fallbackStep],
    }
  }
  const pad = (max - min) * 0.08
  const lo = min - pad
  const hi = max + pad
  const rawStep = (hi - lo) / targetTicks
  const step = NICE_STEPS.find(s => s >= rawStep) ?? rawStep
  const axisMin = Math.floor(lo / step) * step
  const axisMax = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let t = axisMin; t <= axisMax + step * 0.01; t += step) {
    ticks.push(Math.round(t * 1000) / 1000)
  }
  return { axisMin, axisMax, ticks }
}

/* ===================================================
   Granularity key derivation
   =================================================== */

/**
 * Derive a grouping key from a row based on granularity.
 * Reads the row's `date` (YYYY-MM-DD), `month` (YYYY-MM), `quarter` (YYYY-QN), `year` fields.
 */
export function granularityKey(
  row: Record<string, string | number | null>,
  granularity: ScatterGranularity,
): string {
  switch (granularity) {
    case 'day':
      return String(row.date ?? row.month ?? row.year ?? '')
    case 'month':
      return String(row.month ?? row.year ?? '')
    case 'quarter':
      return String(row.quarter ?? row.year ?? '')
    case 'year':
      return String(row.year ?? '')
  }
}

/* ===================================================
   Scatter aggregation
   =================================================== */

export interface ScatterAggPoint {
  x: number
  y: number
  label: string
  colorValue: string
  quarter: string
}

/**
 * Aggregates raw rows into scatter display points.
 * Groups by granularity key, computes weighted average of xField/yField using `weightKg`.
 * Falls back to simple average if `weightKg` is absent or zero.
 */
export function aggregateScatterData(
  data: SpecialChartData,
  xField: string,
  yField: string,
  colorBy: string,
  granularity: ScatterGranularity,
  quarterFilter: string[],
): ScatterAggPoint[] {
  if (data.rows.length === 0 || !xField || !yField) return []

  // Apply quarter filter
  const rows =
    quarterFilter.length > 0
      ? data.rows.filter(r => {
          const q = String(r.quarter ?? '')
          return quarterFilter.includes(q)
        })
      : data.rows

  interface GroupAcc {
    totalWeight: number
    weightedX: number
    weightedY: number
    colorValue: string
    quarter: string
    firstRow: Record<string, string | number | null>
    count: number
  }

  const groups = new Map<string, GroupAcc>()

  for (const row of rows) {
    const xVal = Number(row[xField])
    const yVal = Number(row[yField])
    if (isNaN(xVal) || isNaN(yVal)) continue

    const key = granularityKey(row, granularity)
    const weight = Number(row.weightKg ?? row.weight_kg ?? 1)
    const w = weight > 0 ? weight : 1

    if (!groups.has(key)) {
      groups.set(key, {
        totalWeight: 0,
        weightedX: 0,
        weightedY: 0,
        colorValue: String(row[colorBy] ?? ''),
        quarter: String(row.quarter ?? ''),
        firstRow: row,
        count: 0,
      })
    }

    const acc = groups.get(key)!
    acc.totalWeight += w
    acc.weightedX += xVal * w
    acc.weightedY += yVal * w
    acc.count += 1
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, acc]) => {
      const w = acc.totalWeight
      const label = derivePeriodLabel(acc.firstRow, granularity)
      return {
        x: w > 0 ? acc.weightedX / w : 0,
        y: w > 0 ? acc.weightedY / w : 0,
        label,
        colorValue: acc.colorValue,
        quarter: acc.quarter,
      }
    })
}

function derivePeriodLabel(
  row: Record<string, string | number | null>,
  granularity: ScatterGranularity,
): string {
  try {
    switch (granularity) {
      case 'day': {
        const date = String(row.date ?? '')
        return date ? format(parseISO(date), 'd MMM yyyy') : date
      }
      case 'month': {
        const month = String(row.month ?? '')
        return month ? format(parse(month, 'yyyy-MM', new Date()), 'MMM yyyy') : month
      }
      case 'quarter': {
        const q = String(row.quarter ?? '')
        if (!q) return q
        const [yr, qLabel] = q.split('-')
        return `${qLabel} ${yr}`
      }
      case 'year':
        return String(row.year ?? '')
    }
  } catch {
    return ''
  }
}

/* ===================================================
   Pie/Donut aggregation
   =================================================== */

export interface PieAggSlice {
  group: string
  value: number
  percentage: number
}

/**
 * Aggregates raw rows into pie/donut slices.
 * Groups by categorical `groupBy` field, computes sum/avg/count of `valueField`.
 */
export function aggregatePieData(
  data: SpecialChartData,
  valueField: string,
  groupBy: string,
  aggregation: 'sum' | 'avg' | 'count',
  quarterFilter: string[],
): PieAggSlice[] {
  if (data.rows.length === 0 || !valueField || !groupBy) return []

  const rows =
    quarterFilter.length > 0
      ? data.rows.filter(r => {
          const q = String(r.quarter ?? '')
          return quarterFilter.includes(q)
        })
      : data.rows

  const groups = new Map<string, { sum: number; count: number }>()

  for (const row of rows) {
    const groupVal = String(row[groupBy] ?? '(blank)')
    const numVal = Number(row[valueField])
    if (isNaN(numVal)) continue

    if (!groups.has(groupVal)) {
      groups.set(groupVal, { sum: 0, count: 0 })
    }
    const acc = groups.get(groupVal)!
    acc.sum += numVal
    acc.count += 1
  }

  const slices: PieAggSlice[] = Array.from(groups.entries()).map(([group, acc]) => {
    let value: number
    switch (aggregation) {
      case 'sum':
        value = acc.sum
        break
      case 'avg':
        value = acc.count > 0 ? acc.sum / acc.count : 0
        break
      case 'count':
        value = acc.count
        break
    }
    return { group, value, percentage: 0 }
  })

  const total = slices.reduce((s, sl) => s + Math.abs(sl.value), 0)
  for (const sl of slices) {
    sl.percentage = total > 0 ? (Math.abs(sl.value) / total) * 100 : 0
  }

  return slices.sort((a, b) => b.value - a.value)
}

/* ===================================================
   Color mapping
   =================================================== */

/**
 * Returns a stable value-to-color mapping.
 * Uses YEAR_COLORS when colorBy is 'year', falls back to GENERIC_PALETTE otherwise.
 */
export function buildColorMap(
  values: string[],
  colorBy: string,
): Map<string, string> {
  const map = new Map<string, string>()
  if (colorBy === 'year') {
    for (const v of values) {
      map.set(v, YEAR_COLORS[v] ?? '#71717a')
    }
  } else {
    values.forEach((v, i) => {
      map.set(v, GENERIC_PALETTE[i % GENERIC_PALETTE.length])
    })
  }
  return map
}
