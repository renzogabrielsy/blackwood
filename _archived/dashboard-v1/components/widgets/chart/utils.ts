import { createContext, useContext } from 'react'
import type { SizeTier, WidgetSize, AvailableField, ChartConfig, TimeFilter, FiscalCalEntry } from './types'

/* ===================================================
   Widget Size Tier System
   =================================================== */

export function getRootFontSize(): number {
  if (typeof window === 'undefined') return 16
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
}

export function getWidthTier(px: number): SizeTier {
  const rem = px / getRootFontSize()
  if (rem < 10) return 'xs'      // ~160px at 16px base
  if (rem < 17.5) return 'sm'    // ~280px
  if (rem < 27.5) return 'md'    // ~440px
  if (rem < 40) return 'lg'      // ~640px
  return 'xl'
}

export function getHeightTier(px: number): SizeTier {
  const rem = px / getRootFontSize()
  if (rem < 5) return 'xs'       // ~80px
  if (rem < 10) return 'sm'      // ~160px
  if (rem < 16.25) return 'md'   // ~260px
  if (rem < 25) return 'lg'      // ~400px
  return 'xl'
}

export const WidgetSizeContext = createContext<WidgetSize>({
  widthPx: 400,
  heightPx: 300,
  wTier: 'md',
  hTier: 'md',
})

export const useWidgetSize = () => useContext(WidgetSizeContext)

export function formatPeriodLabel(label: string, wTier: SizeTier): string {
  if (wTier === 'xs') {
    const parts = label.split(' ')
    return parts[0][0] + (parts[1]?.slice(2) ?? '')
  }
  if (wTier === 'sm' || wTier === 'md') {
    const parts = label.split(' ')
    return parts[0] + " '" + (parts[1]?.slice(2) ?? '')
  }
  return label
}

/* ===================================================
   Chart Field Helpers
   =================================================== */

export const MONTH_FIELD: AvailableField = {
  key: 'month',
  label: 'Month (time)',
  color: 'var(--muted-foreground)',
  defaultChartType: 'line',
}

export function getAvailableFields(config: ChartConfig): AvailableField[] {
  return [
    MONTH_FIELD,
    ...config.series.map(s => ({
      key: s.key,
      label: s.label,
      color: s.color,
      defaultChartType: (s.style === 'bar' ? 'bar' : s.style === 'area' ? 'area' : 'line') as AvailableField['defaultChartType'],
    })),
  ]
}

function calMonthInQuarter(month: number, q: string): boolean {
  // Plain calendar quarters: Q1 = Jan–Mar (0–2), Q2 = Apr–Jun (3–5), Q3 = Jul–Sep (6–8), Q4 = Oct–Dec (9–11)
  const quarterMap: Record<string, number[]> = {
    Q1: [0, 1, 2],   // Jan–Mar
    Q2: [3, 4, 5],   // Apr–Jun
    Q3: [6, 7, 8],   // Jul–Sep
    Q4: [9, 10, 11], // Oct–Dec
  }
  return (quarterMap[q] ?? []).includes(month)
}

export function getFilterIndices(f: TimeFilter, fiscalCalendar: FiscalCalEntry[]): number[] {
  if (!f || f.type === 'all') return fiscalCalendar.map(e => e.x)

  if (f.type === 'year') {
    // Plain calendar year string match: '2025', '2026', etc.
    return fiscalCalendar.filter(e => e.fiscalYear === f.year).map(e => e.x)
  }

  if (f.type === 'quarter') {
    const q = f.quarter!
    return fiscalCalendar.filter(e => calMonthInQuarter(e.fiscalMonth, q)).map(e => e.x)
  }

  if (f.type === 'range') {
    return fiscalCalendar
      .filter(e => e.fiscalMonth >= f.range!.start && e.fiscalMonth <= f.range!.end)
      .map(e => e.x)
  }

  return fiscalCalendar.map(e => e.x)
}
