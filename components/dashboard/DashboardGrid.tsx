'use client'

import { useState, useEffect, useCallback } from 'react'
import { GridLayout, verticalCompactor } from 'react-grid-layout'
import type { Layout as RGLLayout, LayoutItem as RGLLayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

import { WIDGET_REGISTRY } from '@/components/widgets'
import { ChartWidget } from '@/components/widgets/chart/ChartWidget'
import { KPIStripWidget } from '@/components/widgets/kpi-strip/KPIStripWidget'
import { QualityScatterWidget } from '@/components/widgets/quality-scatter/QualityScatterWidget'
import { WarehouseOccupancyWidget } from '@/components/widgets/warehouse-occupancy/WarehouseOccupancyWidget'
import type { ChartInstanceSettings } from '@/components/widgets/chart/types'
import { WidgetShell } from './WidgetShell'
import { WidgetPicker } from './WidgetPicker'

/* ===================================================
   Types
   =================================================== */

type LayoutItem = { i: string; x: number; y: number; w: number; h: number }

interface D6Prefs {
  layout: LayoutItem[]
  visibleModules: string[]
  collapsed: string[]
  widgetSettings: Record<string, ChartInstanceSettings>
}

/* ===================================================
   localStorage Persistence
   =================================================== */

const LS_KEY = 'bw_d6_prefs'

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: 'kpi-strip',       x: 0, y: 0,  w: 12, h: 2 },
  { i: 'price-trajectory', x: 0, y: 2,  w: 4,  h: 7 },
  { i: 'quality-scatter',  x: 4, y: 2,  w: 4,  h: 7 },
  { i: 'warehouse-occupancy', x: 8, y: 2, w: 4,  h: 7 },
]

const DEFAULT_PREFS: D6Prefs = {
  layout: DEFAULT_LAYOUT,
  visibleModules: ['kpi-strip', 'price-trajectory', 'quality-scatter', 'warehouse-occupancy'],
  collapsed: [],
  widgetSettings: {
    'price-trajectory': {
      title: 'Price Charts',
      xAxisKey: 'month',
      ySeries: [],
      fontScale: 0,
    },
  },
}

function loadPrefs(): D6Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Record<string, unknown>

    // Migrate/validate widgetSettings
    let widgetSettings = (parsed.widgetSettings as Record<string, ChartInstanceSettings>) ?? {}
    if (!widgetSettings['price-trajectory']) {
      widgetSettings = {
        ...widgetSettings,
        'price-trajectory': {
          title: 'Price Charts',
          xAxisKey: 'month',
          ySeries: [],
          fontScale: (parsed.chartFontScale as number) ?? 0,
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

    return {
      layout: (parsed.layout as LayoutItem[]) ?? DEFAULT_PREFS.layout,
      visibleModules: (parsed.visibleModules as string[]) ?? DEFAULT_PREFS.visibleModules,
      collapsed: (parsed.collapsed as string[]) ?? DEFAULT_PREFS.collapsed,
      widgetSettings,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function savePrefs(prefs: D6Prefs) {
  localStorage.setItem(LS_KEY, JSON.stringify(prefs))
}

/* ===================================================
   Widget ID helpers
   =================================================== */

const isChartId = (id: string) => id === 'price-trajectory' || id.startsWith('uchart-')

/** Map a module ID to the correct widget JSX */
function renderWidgetContent(
  id: string,
  prefs: D6Prefs,
  onSettingsChange: (id: string, partial: Partial<ChartInstanceSettings>) => void,
): React.ReactNode {
  if (isChartId(id)) {
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
        onSettingsChange={(partial) => onSettingsChange(id, partial)}
      />
    )
  }
  if (id === 'kpi-strip') return <KPIStripWidget />
  if (id === 'quality-scatter') return <QualityScatterWidget />
  if (id === 'warehouse-occupancy') return <WarehouseOccupancyWidget />
  return <div className="text-xs text-muted-foreground">Unknown widget: {id}</div>
}

/** Get display title for a module */
function getWidgetTitle(id: string, prefs: D6Prefs): string {
  if (isChartId(id)) {
    return prefs.widgetSettings[id]?.title ?? 'Chart'
  }
  const def = WIDGET_REGISTRY.find(w => w.type === id)
  return def?.displayName ?? id
}

/* ===================================================
   DashboardGrid — main export
   =================================================== */

export function DashboardGrid() {
  const [prefs, setPrefs] = useState<D6Prefs>(DEFAULT_PREFS)
  const [editMode, setEditMode] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [preCollapseHeights, setPreCollapseHeights] = useState<Record<string, number>>({})

  useEffect(() => {
    setPrefs(loadPrefs())
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

  const handleLayoutChange = useCallback((newLayout: RGLLayout) => {
    const mapped: LayoutItem[] = newLayout.map(l => ({
      i: l.i, x: l.x, y: l.y, w: l.w, h: l.h,
    }))
    updatePrefs({ layout: mapped })
  }, [updatePrefs])

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

  /* --- Build grid layout --- */
  const gridLayout: RGLLayoutItem[] = prefs.layout
    .filter(l => prefs.visibleModules.includes(l.i))
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

  return (
    <div className="flex flex-col flex-1 min-h-screen bg-muted/10">
      {/* Sticky Header */}
      <div className="sticky top-0 z-30 bg-card border-b border-border px-4 py-2">
        <div className="flex items-center justify-between max-w-[1600px] mx-auto">
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
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {prefs.visibleModules.length} widgets
            </span>
            <button
              type="button"
              onClick={() => setEditMode(!editMode)}
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
            const isCollapsed = prefs.collapsed.includes(id)
            const displayTitle = getWidgetTitle(id, prefs)
            return (
              <div key={id}>
                <WidgetShell
                  id={id}
                  title={displayTitle}
                  editMode={editMode}
                  onRemove={() => removeModule(id)}
                  onCollapse={() => toggleCollapse(id)}
                  collapsed={isCollapsed}
                >
                  {renderWidgetContent(id, prefs, handleSettingsChange)}
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
