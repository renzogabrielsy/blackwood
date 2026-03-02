'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { GridLayout, verticalCompactor } from 'react-grid-layout'
import type { Layout as RGLLayout, LayoutItem as RGLLayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

import { WIDGET_REGISTRY } from '@/components/widgets'
import { ChartWidget } from '@/components/widgets/chart/ChartWidget'
import { KPIStripWidget } from '@/components/widgets/kpi-strip/KPIStripWidget'
import { KPIStripSettingsPopover } from '@/components/widgets/kpi-strip/settings-popover'
import { SpecialChartWidget } from '@/components/widgets/special-chart/SpecialChartWidget'
import { WarehouseOccupancyWidget } from '@/components/widgets/warehouse-occupancy/WarehouseOccupancyWidget'
import type { ChartInstanceSettings } from '@/components/widgets/chart/types'
import type { ChartConfig, WidgetSize } from '@/components/widgets/chart/types'
import { WidgetSizeContext } from '@/components/widgets/chart/utils'
import type { KPIData, KPIStripSettings } from '@/components/widgets/kpi-strip/types'
import type { WarehouseData } from '@/components/widgets/warehouse-occupancy/types'
import type { SpecialChartData, SpecialChartSettings } from '@/components/widgets/special-chart/types'
import { WidgetShell } from './WidgetShell'
import { WidgetPicker } from './WidgetPicker'
import { WidgetError } from './WidgetError'
import { fetchKpiData, saveDashboardPrefs } from '@/app/(app)/actions'
import { Pin, PinOff } from 'lucide-react'
import type { D6Prefs, LayoutItem } from '@/lib/dashboard/types'
import {
  loadProfileStore,
  getActiveProfile,
  updateActiveProfile,
  getActiveProfileName,
} from '@/lib/dashboard/profile-store'

/* ===================================================
   Types
   =================================================== */

export type { D6Prefs, LayoutItem }

export interface DashboardGridProps {
  kpiData?: KPIData[]
  kpiError?: string
  chartConfig?: ChartConfig
  chartError?: string
  warehouseData?: WarehouseData[]
  warehouseError?: string
  specialChartData?: SpecialChartData
  specialChartError?: string
  /** Server-fetched preferences used to seed the initial grid state, bypassing localStorage cold-start */
  serverPrefs?: D6Prefs
}

/* ===================================================
   Default prefs (module-level constant — shared with profile store)
   =================================================== */

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: 'kpi-strip',           x: 0, y: 0,  w: 12, h: 2 },
  { i: 'price-trajectory',    x: 0, y: 2,  w: 4,  h: 7 },
  { i: 'special-chart',       x: 4, y: 2,  w: 4,  h: 7 },
  { i: 'warehouse-occupancy', x: 8, y: 2,  w: 4,  h: 7 },
]

export const DEFAULT_PREFS: D6Prefs = {
  layout: DEFAULT_LAYOUT,
  visibleModules: ['kpi-strip', 'price-trajectory', 'special-chart', 'warehouse-occupancy'],
  collapsed: [],
  widgetSettings: {
    'price-trajectory': {
      title: 'Price Charts',
      xAxisKey: 'month',
      ySeries: [],
      fontScale: 0,
    },
  },
  kpiSettings: {},
  stickyKpi: false,
  prePinLayout: undefined,
  specialChartSettings: { chartType: 'scatter', granularity: 'month', quarterFilter: [], showRefLines: true },
}

/* ===================================================
   Vertical compaction helper (pure, module-level)
   Removes vertical gaps by packing items upward.
   =================================================== */

function compactVertically(items: LayoutItem[]): LayoutItem[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const result: LayoutItem[] = []
  for (const item of sorted) {
    let y = 0
    for (const placed of result) {
      // Check horizontal overlap
      if (placed.x < item.x + item.w && placed.x + placed.w > item.x) {
        y = Math.max(y, placed.y + placed.h)
      }
    }
    result.push({ ...item, y })
  }
  return result
}

/* ===================================================
   localStorage Persistence (via profile store)
   =================================================== */

function loadPrefs(seed?: D6Prefs): D6Prefs {
  if (typeof window === 'undefined') return seed ?? DEFAULT_PREFS
  try {
    const raw = seed ?? getActiveProfile(DEFAULT_PREFS)
    // Migrate/validate widgetSettings
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

    // Migrate: remap 'quality-scatter' → 'special-chart' in visibleModules and layout
    const rawVisible: string[] = raw.visibleModules ?? DEFAULT_PREFS.visibleModules
    const migratedVisible = rawVisible.map(m => m === 'quality-scatter' ? 'special-chart' : m)

    const rawLayout: LayoutItem[] = raw.layout ?? DEFAULT_PREFS.layout
    const migratedLayout = rawLayout.map(l =>
      l.i === 'quality-scatter' ? { ...l, i: 'special-chart' } : l,
    )

    // Migrate: carry over scatterSettings → specialChartSettings (preserving granularity / quarterFilter / showRefLines)
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

    return {
      layout: migratedLayout,
      visibleModules: migratedVisible,
      collapsed: raw.collapsed ?? DEFAULT_PREFS.collapsed,
      widgetSettings,
      kpiSettings: raw.kpiSettings ?? {},
      stickyKpi: raw.stickyKpi ?? false,
      prePinLayout: raw.prePinLayout,
      specialChartSettings: specialChartSettings ?? {},
    }
  } catch {
    return DEFAULT_PREFS
  }
}


/* ===================================================
   Widget ID helpers
   =================================================== */

const isChartId = (id: string) => id === 'price-trajectory' || id.startsWith('uchart-')

/** Get display title for a module */
function getWidgetTitle(id: string, prefs: D6Prefs): string {
  if (isChartId(id)) {
    return prefs.widgetSettings[id]?.title ?? 'Chart'
  }
  const def = WIDGET_REGISTRY.find(w => w.type === id)
  return def?.displayName ?? id
}

/* ===================================================
   Static size context for the sticky KPI bar
   =================================================== */

const STICKY_BAR_SIZE: WidgetSize = {
  widthPx: 1200,
  heightPx: 48,
  wTier: 'xl',
  hTier: 'sm',
}

/* ===================================================
   DashboardGrid — main export
   =================================================== */

export function DashboardGrid(props: DashboardGridProps) {
  const [prefs, setPrefs] = useState<D6Prefs>(DEFAULT_PREFS)
  const [activeProfileName, setActiveProfileName] = useState<string>('Default')
  const [editMode, setEditMode] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [preCollapseHeights, setPreCollapseHeights] = useState<Record<string, number>>({})
  const [liveKpiData, setLiveKpiData] = useState<KPIData[] | undefined>(undefined)
  const [stickyKpiExiting, setStickyKpiExiting] = useState(false)
  const [isStuck, setIsStuck] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const hasLoadedRef = useRef(false)
  const supabaseSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function savePrefs(prefs: D6Prefs) {
    if (!hasLoadedRef.current) return
    updateActiveProfile(prefs, DEFAULT_PREFS)
    if (supabaseSaveTimerRef.current) clearTimeout(supabaseSaveTimerRef.current)
    supabaseSaveTimerRef.current = setTimeout(() => {
      saveDashboardPrefs(prefs).catch(() => {})
    }, 1500)
  }

  useEffect(() => {
    const loaded = loadPrefs(props.serverPrefs)
    hasLoadedRef.current = true
    setPrefs(loaded)
    // Resolve profile name from store
    setActiveProfileName(getActiveProfileName(DEFAULT_PREFS))
    // Auto-fetch live KPI data if the saved period differs from the default
    if (loaded.kpiSettings?.period && loaded.kpiSettings.period !== 'month') {
      fetchKpiData(loaded.kpiSettings.period).then(setLiveKpiData).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    setIsMobile(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => setIsStuck(!e.isIntersecting), { threshold: 0 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const updatePrefs = useCallback((partial: Partial<D6Prefs>) => {
    setPrefs(prev => {
      const next = { ...prev, ...partial }
      savePrefs(next)
      return next
    })
  }, [])

  const handleSettingsChange = useCallback((id: string, partial: Partial<ChartInstanceSettings>) => {
    setPrefs(prev => {
      const next = {
        ...prev,
        widgetSettings: {
          ...prev.widgetSettings,
          [id]: { ...prev.widgetSettings[id], ...partial },
        },
      }
      savePrefs(next)
      return next
    })
  }, [])

  const handleKpiSettingsChange = useCallback((partial: Partial<KPIStripSettings>) => {
    setPrefs(prev => {
      const next: D6Prefs = {
        ...prev,
        kpiSettings: { ...prev.kpiSettings, ...partial },
      }
      savePrefs(next)
      return next
    })
    // When period changes, fetch live data for that period
    if (partial.period !== undefined) {
      fetchKpiData(partial.period).then(setLiveKpiData).catch(() => {})
    }
  }, [])

  const handleSpecialChartSettingsChange = useCallback((partial: Partial<SpecialChartSettings>) => {
    setPrefs(prev => {
      const next: D6Prefs = {
        ...prev,
        specialChartSettings: { ...prev.specialChartSettings, ...partial },
      }
      savePrefs(next)
      return next
    })
  }, [])

  const handleLayoutChange = useCallback((newLayout: RGLLayout) => {
    const mapped: LayoutItem[] = newLayout.map(l => ({
      i: l.i, x: l.x, y: l.y, w: l.w, h: l.h,
    }))
    setPrefs(prev => {
      // Preserve layout entries for modules excluded from the grid (e.g. pinned kpi-strip).
      // RGL fires onLayoutChange without those items, so we must merge them back.
      const hiddenEntries = prev.layout.filter(l => !mapped.some(m => m.i === l.i))
      const next = { ...prev, layout: [...mapped, ...hiddenEntries] }
      savePrefs(next)
      return next
    })
  }, [])

  const removeModule = useCallback((id: string) => {
    setPrefs(prev => {
      const { [id]: _, ...remainingSettings } = prev.widgetSettings
      const next: D6Prefs = {
        ...prev,
        visibleModules: prev.visibleModules.filter(m => m !== id),
        layout: prev.layout.filter(l => l.i !== id),
        collapsed: prev.collapsed.filter(c => c !== id),
        widgetSettings: remainingSettings,
      }
      savePrefs(next)
      return next
    })
  }, [])

  const addSingleton = useCallback((type: string, instanceId: string) => {
    const def = WIDGET_REGISTRY.find(w => w.type === type)
    if (!def) return
    setPrefs(prev => {
      const maxY = prev.layout.reduce((max, l) => Math.max(max, l.y + l.h), 0)
      const next: D6Prefs = {
        ...prev,
        visibleModules: [...prev.visibleModules, instanceId],
        layout: [...prev.layout, {
          i: instanceId,
          x: 0, y: maxY,
          w: def.defaultSize.w,
          h: def.defaultSize.h,
        }],
      }
      savePrefs(next)
      return next
    })
  }, [])

  const addChart = useCallback(() => {
    const id = `uchart-${Date.now()}`
    setPrefs(prev => {
      const maxY = prev.layout.reduce((max, l) => Math.max(max, l.y + l.h), 0)
      const next: D6Prefs = {
        ...prev,
        visibleModules: [...prev.visibleModules, id],
        layout: [...prev.layout, { i: id, x: 0, y: maxY, w: 4, h: 7 }],
        widgetSettings: {
          ...prev.widgetSettings,
          [id]: { title: 'Chart', xAxisKey: 'month', ySeries: [], fontScale: 0 },
        },
      }
      savePrefs(next)
      return next
    })
  }, [])

  const toggleCollapse = useCallback((id: string) => {
    setPrefs(prev => {
      const isCollapsed = prev.collapsed.includes(id)
      if (isCollapsed) {
        const originalH = preCollapseHeights[id]
        const def = WIDGET_REGISTRY.find(w => w.type === id || (isChartId(id) && w.type === 'chart'))
        const restoredH = originalH ?? (def?.defaultSize.h ?? 6)
        const next: D6Prefs = {
          ...prev,
          collapsed: prev.collapsed.filter(c => c !== id),
          layout: prev.layout.map(l => l.i === id ? { ...l, h: restoredH } : l),
        }
        savePrefs(next)
        return next
      } else {
        const currentItem = prev.layout.find(l => l.i === id)
        if (currentItem) {
          setPreCollapseHeights(p => ({ ...p, [id]: currentItem.h }))
        }
        const next: D6Prefs = {
          ...prev,
          collapsed: [...prev.collapsed, id],
          layout: prev.layout.map(l => l.i === id ? { ...l, h: 2 } : l),
        }
        savePrefs(next)
        return next
      }
    })
  }, [preCollapseHeights])

  const resetLayout = useCallback(() => {
    setPrefs(DEFAULT_PREFS)
    savePrefs(DEFAULT_PREFS)
    setPreCollapseHeights({})
  }, [])

  const handlePin = useCallback(() => {
    setPrefs(prev => {
      const prePinLayout = prev.layout   // save full snapshot (includes kpi-strip)
      const nonKpi = prev.layout.filter(l => l.i !== 'kpi-strip')
      const kpiItem = prev.layout.find(l => l.i === 'kpi-strip')
      const compacted = compactVertically(nonKpi)
      const next: D6Prefs = {
        ...prev,
        stickyKpi: true,
        prePinLayout,
        layout: [...(kpiItem ? [kpiItem] : []), ...compacted],
      }
      savePrefs(next)
      return next
    })
  }, [])

  const handleUnpin = useCallback(() => {
    setStickyKpiExiting(true)
    setTimeout(() => {
      setStickyKpiExiting(false)
      setPrefs(prev => {
        const next: D6Prefs = {
          ...prev,
          stickyKpi: false,
          layout: prev.prePinLayout ?? prev.layout,  // restore pre-pin positions
          prePinLayout: undefined,
        }
        savePrefs(next)
        return next
      })
    }, 200)
  }, [])

  const handleEditModeToggle = useCallback(() => {
    const entering = !editMode
    // Exiting edit mode while pinned: re-compact non-KPI items.
    // During edit mode the KPI strip reappears in the grid, RGL pushes the 3
    // widgets down to y=2, and onLayoutChange saves those positions. On exit we
    // need to pack them back up as if the KPI row were absent.
    if (!entering && prefs.stickyKpi) {
      setPrefs(prev => {
        const nonKpi = prev.layout.filter(l => l.i !== 'kpi-strip')
        const kpiItem = prev.layout.find(l => l.i === 'kpi-strip')
        const compacted = compactVertically(nonKpi)
        const next: D6Prefs = {
          ...prev,
          layout: [...(kpiItem ? [kpiItem] : []), ...compacted],
        }
        savePrefs(next)
        return next
      })
    }
    setEditMode(entering)
  }, [editMode, prefs.stickyKpi])

  /* ---- Widget content renderer (inner function to close over live KPI state) ---- */
  function renderWidgetContent(id: string): React.ReactNode {
    if (isChartId(id)) {
      if (props.chartError) return <WidgetError message={props.chartError} />
      if (!props.chartConfig) return <WidgetError message="[Blackwood] Adapter 'charcoal-chart' returned no data." />
      const settings: ChartInstanceSettings = prefs.widgetSettings[id] ?? {
        title: 'Chart',
        xAxisKey: 'month',
        ySeries: [],
        fontScale: 0,
      }
      return (
        <ChartWidget
          instanceId={id}
          settings={settings}
          onSettingsChange={(partial) => handleSettingsChange(id, partial)}
          config={props.chartConfig}
        />
      )
    }
    if (id === 'kpi-strip') {
      if (props.kpiError) return <WidgetError message={props.kpiError} />
      if (!props.kpiData && !liveKpiData) return <WidgetError message="[Blackwood] Adapter 'charcoal-kpi' returned no data." />
      return (
        <KPIStripWidget
          data={liveKpiData ?? props.kpiData}
          settings={prefs.kpiSettings}
          onSettingsChange={handleKpiSettingsChange}
        />
      )
    }
    if (id === 'special-chart') {
      if (props.specialChartError) return <WidgetError message={props.specialChartError} />
      if (!props.specialChartData) return <WidgetError message="[Blackwood] Adapter 'charcoal-special' returned no data." />
      return (
        <SpecialChartWidget
          data={props.specialChartData}
          settings={prefs.specialChartSettings}
          onSettingsChange={handleSpecialChartSettingsChange}
        />
      )
    }
    if (id === 'warehouse-occupancy') {
      if (props.warehouseError) return <WidgetError message={props.warehouseError} />
      if (!props.warehouseData) return <WidgetError message="[Blackwood] Adapter 'charcoal-warehouse' returned no data." />
      return <WarehouseOccupancyWidget data={props.warehouseData} />
    }
    return <div className="text-xs text-muted-foreground">Unknown widget: {id}</div>
  }

  /* --- Sticky KPI bar derived state --- */
  const showStickyBar = Boolean(prefs.stickyKpi) && !editMode && !isMobile
  const showKpiInGrid = !prefs.stickyKpi || editMode || isMobile

  /* --- Build grid layout --- */
  const gridLayout: RGLLayoutItem[] = prefs.layout
    .filter(l => prefs.visibleModules.includes(l.i))
    .filter(l => !(l.i === 'kpi-strip' && !showKpiInGrid))
    .map(l => {
      const def = WIDGET_REGISTRY.find(w => isChartId(l.i) ? w.type === 'chart' : w.type === l.i)
      return {
        i: l.i,
        x: l.x,
        y: l.y,
        w: l.w,
        h: l.h,
        minW: def?.defaultSize.minW ?? 2,
        minH: prefs.collapsed.includes(l.i) ? 2 : (def?.defaultSize.minH ?? 2),
        isResizable: editMode && !prefs.collapsed.includes(l.i),
        static: !editMode,
      }
    })

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // Suppress unused warning — updatePrefs is defined for future use by profile manager
  void updatePrefs

  return (
    <div className="flex flex-col flex-1 overflow-auto bg-muted/10">
      {/* Sentinel for IntersectionObserver */}
      <div ref={sentinelRef} className="h-px -mt-px" />

      {/* Sticky Header */}
      <div className={`sticky top-0 z-30 bg-card border-b px-4 relative transition-[border-color,box-shadow] duration-200 ${
        isStuck ? 'shadow-lg' : ''
      } ${
        showStickyBar ? 'border-primary/30' : 'border-border'
      }`}>

        {/* Row 1 — title, date, edit controls */}
        <div className="py-2 flex items-center justify-between max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-foreground">Blackwood Dashboard</h1>
            <span className="text-xs text-muted-foreground font-mono">{today}</span>
          </div>
          <div className="flex items-center gap-2">
            {editMode && (
              <button
                type="button"
                onClick={resetLayout}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border hover:bg-muted/50 transition-colors"
              >
                Reset Layout
              </button>
            )}
            <span className="text-[10px] text-muted-foreground font-mono">
              {activeProfileName}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {prefs.visibleModules.length} widgets
            </span>
            <button
              type="button"
              onClick={handleEditModeToggle}
              className={`text-xs font-medium px-3 py-1.5 rounded transition-colors ${
                editMode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground hover:bg-muted/80'
              }`}
            >
              {editMode ? 'Done Editing' : 'Edit Layout'}
            </button>
          </div>
        </div>

        {/* Row 2 — KPI strip (pinned mode only) */}
        {showStickyBar && (
          <div className={`border-t border-border/50 py-1.5 max-w-[1600px] mx-auto flex items-center gap-3 ${
            stickyKpiExiting ? 'animate-kpi-exit' : 'animate-kpi-enter'
          }`}>
            <div className="flex-1 min-w-0">
              <WidgetSizeContext.Provider value={STICKY_BAR_SIZE}>
                <KPIStripWidget
                  data={liveKpiData ?? props.kpiData}
                  settings={prefs.kpiSettings}
                  onSettingsChange={handleKpiSettingsChange}
                />
              </WidgetSizeContext.Provider>
            </div>
            <button
              type="button"
              onClick={handleUnpin}
              title="Return to grid"
              aria-label="Unpin KPI strip"
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
            >
              <PinOff className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Grid Content */}
      <div
        ref={containerRef}
        className="flex-1 max-w-[1600px] mx-auto w-full px-2 py-2"
        style={editMode ? {
          backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)',
          backgroundSize: `calc(100% / 12) 40px`,
        } : undefined}
      >
        <GridLayout
          layout={gridLayout}
          width={containerWidth}
          gridConfig={{ cols: 12, rowHeight: 40, margin: [8, 8] as const, containerPadding: null, maxRows: Infinity }}
          dragConfig={{ enabled: editMode, bounded: false, handle: '.drag-handle', threshold: 3 }}
          resizeConfig={{ enabled: editMode, handles: ['se'] as const }}
          compactor={verticalCompactor}
          onLayoutChange={handleLayoutChange}
        >
          {prefs.visibleModules.map(id => {
            if (id === 'kpi-strip' && !showKpiInGrid) return null

            const isCollapsed = prefs.collapsed.includes(id)
            const displayTitle = getWidgetTitle(id, prefs)

            // Wire KPI strip gear icon into WidgetShell headerAction
            const kpiHeaderAction =
              id === 'kpi-strip' && !props.kpiError ? (
                <>
                  {!editMode && !isMobile && (
                    <button
                      type="button"
                      onClick={handlePin}
                      title="Pin to top"
                      aria-label="Pin KPI strip to header"
                      className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                    >
                      <Pin className="w-3 h-3" />
                    </button>
                  )}
                  <KPIStripSettingsPopover
                    chips={liveKpiData ?? props.kpiData ?? []}
                    settings={prefs.kpiSettings ?? {}}
                    onSettingsChange={handleKpiSettingsChange}
                  />
                </>
              ) : undefined

            return (
              <div key={id}>
                <WidgetShell
                  id={id}
                  title={displayTitle}
                  editMode={editMode}
                  onRemove={() => removeModule(id)}
                  onCollapse={() => toggleCollapse(id)}
                  collapsed={isCollapsed}
                  headerAction={kpiHeaderAction}
                >
                  {renderWidgetContent(id)}
                </WidgetShell>
              </div>
            )
          })}
        </GridLayout>

        {/* Add Widget Button (edit mode only) */}
        {editMode && (
          <div className="flex justify-center py-6 animate-fade-up">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-md border border-dashed border-border text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 hover:bg-muted/30 transition-colors"
            >
              <span className="text-lg leading-none">+</span>
              Add Widget
            </button>
          </div>
        )}
      </div>

      {/* Widget Picker */}
      <WidgetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        visibleModules={prefs.visibleModules}
        onAddSingleton={addSingleton}
        onAddChart={addChart}
      />
    </div>
  )
}
