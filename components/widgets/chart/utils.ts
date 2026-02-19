import { createContext, useContext } from 'react'
import type { SizeTier, WidgetSize, AvailableField, ChartConfig, TimeFilter } from './types'
import { FISCAL_TO_CALENDAR, DATA_YEARS } from '@/lib/widgets/mock-data'

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

export function getFilterIndices(f: TimeFilter): number[] {
  if (!f || f.type === 'all') return [0,1,2,3,4,5,6,7,8,9,10,11]
  if (f.type === 'year') {
    return FISCAL_TO_CALENDAR.filter(m => m.year === f.year).map(m => m.fiscalIdx)
  }
  if (f.type === 'quarter') {
    const map: Record<string, number[]> = { Q1:[0,1,2], Q2:[3,4,5], Q3:[6,7,8], Q4:[9,10,11] }
    return map[f.quarter!] ?? []
  }
  if (f.type === 'range') {
    const result: number[] = []
    for (let i = f.range!.start; i <= f.range!.end; i++) result.push(i)
    return result
  }
  return [0,1,2,3,4,5,6,7,8,9,10,11]
}
