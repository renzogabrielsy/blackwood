/* ===================================================
   Dashboard Preferences Migration & Normalization
   ===================================================

   Pure function that takes raw stored prefs (from localStorage, Supabase,
   or server seed) and returns a clean, validated D6Prefs object. Handles:
   - Missing default settings for price-trajectory chart instance
   - Old widget settings formats (visualType, chartType, activeSeries, etc.)
   - Remap 'quality-scatter' → 'special-chart' in visibleModules and layout
   - Carry over legacy scatterSettings → specialChartSettings
   - Missing/undefined fields filled with defaults

   Extracted from DashboardGrid.tsx to keep migration logic separate from
   render logic. This is a pure function — no React, no side effects.
   =================================================== */

import type { D6Prefs, LayoutItem } from './types'
import type { SpecialChartSettings } from '@/components/widgets/special-chart/types'

/** Default prefs used as fallback values during migration */
interface MigrationDefaults {
  layout: LayoutItem[]
  visibleModules: string[]
  collapsed: string[]
}

/**
 * Migrates and normalizes raw dashboard prefs into a clean D6Prefs object.
 *
 * @param raw - The raw prefs object (from localStorage, Supabase, or server seed)
 * @param defaults - Default layout/visibleModules/collapsed to fill missing fields
 * @returns A fully validated D6Prefs object
 */
export function migrateLegacyPrefs(raw: D6Prefs, defaults: MigrationDefaults): D6Prefs {
  // --- Widget settings migration ---
  let widgetSettings = raw.widgetSettings ?? {}
  if (!widgetSettings['price-trajectory']) {
    widgetSettings = {
      ...widgetSettings,
      'price-trajectory': {
        title: 'Price Charts',
        xAxisKey: 'month',
        ySeries: [],
        fontScale: 0,
      },
    }
  }
  for (const [key, val] of Object.entries(widgetSettings)) {
    const s = val as unknown as Record<string, unknown>
    const hasOldFormat = 'visualType' in s || 'chartType' in s || 'activeSeries' in s || 'seriesConfig' in s || 'preset' in s
    if (hasOldFormat) {
      widgetSettings[key] = { title: (s.title as string) ?? 'Chart', xAxisKey: 'month', ySeries: [], fontScale: (s.fontScale as number) ?? 0 }
      continue
    }
    if (!s.xAxisKey) s.xAxisKey = 'month'
    if (!s.ySeries) s.ySeries = []
    if (Array.isArray(s.ySeries)) {
      s.ySeries = (s.ySeries as Record<string, unknown>[]).map((ys: Record<string, unknown>) => ({
        ...ys,
        lineStyle: ys.lineStyle ?? 'solid',
      }))
    }
    if (!s.comparisonSlices) s.comparisonSlices = []
  }

  // --- Remap 'quality-scatter' → 'special-chart' ---
  const rawVisible: string[] = raw.visibleModules ?? defaults.visibleModules
  const migratedVisible = rawVisible.map(m => m === 'quality-scatter' ? 'special-chart' : m)

  // When remapping quality-scatter → special-chart, enforce minimum dimensions.
  // The old widget may have been collapsed (h=2) or resized very small.
  const specialChartDefaultH = defaults.layout.find(d => d.i === 'special-chart')?.h ?? 7
  const remapId = (l: LayoutItem): LayoutItem => {
    if (l.i !== 'quality-scatter') return l
    return { ...l, i: 'special-chart', w: Math.max(l.w, 4), h: Math.max(l.h, specialChartDefaultH) }
  }

  const rawLayout: LayoutItem[] = raw.layout ?? defaults.layout
  const migratedLayout = rawLayout.map(remapId)

  // --- Carry over scatterSettings → specialChartSettings ---
  const rawPrefs = raw as unknown as Record<string, unknown>
  let specialChartSettings: SpecialChartSettings | undefined = raw.specialChartSettings
  if (!specialChartSettings && rawPrefs.scatterSettings) {
    const old = rawPrefs.scatterSettings as Record<string, unknown>
    specialChartSettings = {
      chartType: 'scatter',
      granularity: (old.granularity as SpecialChartSettings['granularity']) ?? 'month',
      quarterFilter: (old.quarterFilter as string[]) ?? [],
      showRefLines: (old.showRefLines as boolean) ?? true,
    }
  }

  // Build default height lookup from defaults.layout
  const defaultMinH: Record<string, number> = {}
  for (const def of defaults.layout) {
    defaultMinH[def.i] = def.h
  }
  const ensureMinH = (l: LayoutItem): LayoutItem => {
    const minH = defaultMinH[l.i] ?? 0
    return l.h < minH ? { ...l, h: minH } : l
  }

  return {
    layout: migratedLayout.map(ensureMinH),
    visibleModules: migratedVisible,
    collapsed: raw.collapsed ?? defaults.collapsed,
    widgetSettings,
    kpiSettings: raw.kpiSettings ?? {},
    stickyKpi: raw.stickyKpi ?? false,
    prePinLayout: raw.prePinLayout?.map(remapId).map(ensureMinH),
    specialChartSettings: specialChartSettings ?? {},
  }
}
