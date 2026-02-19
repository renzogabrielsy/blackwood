'use client'

import { useState, useEffect, useRef } from 'react'
import {
  ComposedChart, LineChart, Line, Bar, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import type {
  ChartConfig,
  ChartInstanceSettings,
  ChartSeriesStyle,
  ChartType,
  LineStyle,
  YSeriesConfig,
  SizeTier,
} from './types'
import {
  useWidgetSize,
  getAvailableFields,
  getFilterIndices,
} from './utils'
import {
  CHARCOAL_UNIVERSAL_CONFIG,
  PIVOT_MONTHS,
  FISCAL_TO_CALENDAR,
  CAL_MONTHS,
  SLICE_PALETTE,
  CHART_PALETTE,
  DATA_YEARS,
  CURRENT_YEAR,
} from '@/lib/widgets/mock-data'

/* ===================================================
   Quarter Boundary SVG helper
   =================================================== */

interface QuarterBoundaryProps {
  xOf: (i: number) => number
  yTop: number
  yBottom: number
  showLabels: boolean
  wTier: SizeTier
  fs: number
  boundaryPositions?: number[]
  quarterLabels?: string[]
}

function QuarterBoundaries({ xOf, yTop, yBottom, showLabels, wTier, fs, boundaryPositions, quarterLabels }: QuarterBoundaryProps) {
  const bPositions = boundaryPositions ?? [2.5, 5.5, 8.5]
  const boundaries = bPositions.map(p => xOf(p))

  let midpoints: { x: number; label: string }[]
  if (boundaryPositions && boundaryPositions.length > 0) {
    const qLabels = quarterLabels ?? ['Q2', 'Q3', 'Q4', 'Q1']
    midpoints = []
    for (let i = 0; i <= boundaryPositions.length; i++) {
      const left = i === 0 ? -0.5 : boundaryPositions[i - 1]
      const right = i === boundaryPositions.length ? 11.5 : boundaryPositions[i]
      const mid = (left + right) / 2
      if (i < qLabels.length) {
        midpoints.push({ x: xOf(mid), label: qLabels[i] })
      }
    }
  } else {
    midpoints = [
      { x: xOf(1.0), label: 'Q1' },
      { x: xOf(4.0), label: 'Q2' },
      { x: xOf(7.0), label: 'Q3' },
      { x: xOf(10.0), label: 'Q4' },
    ]
  }

  const showAll = showLabels && (wTier === 'lg' || wTier === 'xl')
  const showSome = showLabels && wTier === 'md'
  const visibleLabels = showAll
    ? midpoints
    : showSome ? midpoints.filter((_, i) => i % 2 === 1)
    : []

  return (
    <>
      {boundaries.map((x, i) => (
        <line key={i} x1={x} y1={yTop} x2={x} y2={yBottom}
          style={{ stroke: 'var(--border)' }} strokeWidth="0.5" strokeDasharray="2,2" />
      ))}
      {visibleLabels.map(({ x, label }) => (
        <text key={label} x={x} y={yTop - 6} fontSize={fs * 0.8}
          style={{ fill: 'var(--muted-foreground)' }} textAnchor="middle">{label}</text>
      ))}
    </>
  )
}

/* ===================================================
   Style Preview for settings popover
   =================================================== */

function StylePreview({ style, color }: { style: ChartSeriesStyle; color: string }) {
  if (style === 'bar') {
    return (
      <svg width="24" height="8" viewBox="0 0 24 8" className="shrink-0">
        <rect x="2" y="1" width="8" height="6" fill={color} opacity="0.75" rx="0.5" />
        <rect x="12" y="3" width="8" height="4" fill={color} opacity="0.75" rx="0.5" />
      </svg>
    )
  }
  const dashArray = style === 'dashed' ? '3,2' : undefined
  return (
    <svg width="24" height="8" viewBox="0 0 24 8" className="shrink-0">
      <polyline points="2,6 8,2 16,5 22,1" fill="none" stroke={color} strokeWidth="1.5"
        strokeLinejoin="round" strokeDasharray={dashArray} />
    </svg>
  )
}

// Suppress unused import warning
void StylePreview

/* ===================================================
   Recharts Widget Renderer
   =================================================== */

interface RechartsWidgetProps {
  config: ChartConfig
  settings: ChartInstanceSettings
  width: number
  height: number
  wTier: SizeTier
  hTier: SizeTier
  fs: number
}

function RechartsWidget({ config, settings, width, height, wTier, hTier, fs }: RechartsWidgetProps) {
  const allFields = getAvailableFields(config)
  const isCompareMode = (settings.comparisonSlices?.length ?? 0) > 0

  let rows: Record<string, unknown>[]
  let xDataKey: string

  if (isCompareMode) {
    rows = CAL_MONTHS.map(calMonth => ({ calMonth } as Record<string, unknown>))
    xDataKey = 'calMonth'

    for (const slice of settings.comparisonSlices!) {
      const indices = getFilterIndices(slice.filter)
      for (const fiscalIdx of indices) {
        const entry = FISCAL_TO_CALENDAR[fiscalIdx]
        const rowIdx = entry.calIdx
        for (const s of config.series) {
          const pt = s.points.find(p => p.x === fiscalIdx)
          if (pt !== undefined) {
            (rows[rowIdx] as Record<string, unknown>)[`${s.key}__${slice.id}`] = pt.value
          }
        }
      }
    }
  } else {
    const indices = getFilterIndices(settings.xFilter ?? { type: 'all' })
    xDataKey = settings.xAxisKey
    rows = indices.map(i => {
      const row: Record<string, unknown> = { month: PIVOT_MONTHS[i] }
      for (const s of config.series) {
        const pt = s.points.find(p => p.x === i)
        if (pt !== undefined) row[s.key] = pt.value
      }
      return row
    })
  }

  const ySeries = settings.ySeries
  const isTimeX = isCompareMode || settings.xAxisKey === 'month'

  const leftSeries = ySeries.filter(ys => ys.axis === 'left')
  const rightSeries = ySeries.filter(ys => ys.axis === 'right')
  const hasRightAxis = rightSeries.length > 0

  function getAxisFormatter(seriesList: YSeriesConfig[]) {
    if (seriesList.length === 0) return (v: number) => String(v)
    const firstKey = seriesList[0].key
    const series = config.series.find(s => s.key === firstKey)
    const group = config.seriesGroups.find(g => g.key === series?.group)
    if (!group || !group.unit) return (v: number) => String(v)
    return (v: number) => group.unitPos === 'prefix' ? `${group.unit}${v}` : `${v}${group.unit}`
  }

  const isSparkline = wTier === 'xs' || (wTier === 'sm' && hTier === 'xs')
  if (isSparkline) {
    const sparkYS = ySeries[0]
    if (!sparkYS) return <div className="h-full w-full" />
    const field = allFields.find(f => f.key === sparkYS.key)
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <YAxis yAxisId="left" hide />
          <Line yAxisId="left" dataKey={isCompareMode ? `${sparkYS.key}__${settings.comparisonSlices![0].id}` : sparkYS.key} stroke={field?.color ?? '#60a5fa'}
            strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    )
  }

  const xAxisInterval = isTimeX
    ? (wTier === 'xl' || wTier === 'lg' ? 1 : wTier === 'md' ? 2 : 3)
    : 'preserveStartEnd' as const

  const hideAxes = wTier === 'sm'

  const quarterRefMonths = ['Jun', 'Sep', 'Dec']
  const quarterLabels = ['Q2', 'Q3', 'Q4']
  const showQLabels = !isCompareMode && isTimeX && (wTier === 'md' || wTier === 'lg' || wTier === 'xl')
  const showQuarterLines = !isCompareMode && isTimeX && config.xAxis.showQuarterBoundaries

  function renderYSeries(ys: YSeriesConfig) {
    const field = allFields.find(f => f.key === ys.key)
    const effectiveColor = ys.color ?? field?.color ?? '#60a5fa'
    const strokeDash =
      ys.lineStyle === 'dashed' ? '6 3' :
      ys.lineStyle === 'dotted' ? '2 3' :
      undefined

    switch (ys.chartType) {
      case 'bar':
        return <Bar key={ys.key} dataKey={ys.key} yAxisId={ys.axis}
          fill={effectiveColor} fillOpacity={0.8} radius={[2,2,0,0]}
          isAnimationActive={false} />
      case 'area':
        return <Area key={ys.key} dataKey={ys.key} yAxisId={ys.axis}
          stroke={effectiveColor} fill={effectiveColor} fillOpacity={0.1}
          strokeWidth={1.5} strokeDasharray={strokeDash}
          dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
      case 'scatter':
        return <Line key={ys.key} dataKey={ys.key} yAxisId={ys.axis}
          stroke={effectiveColor} strokeWidth={0}
          dot={{ r: 3, fill: effectiveColor }}
          activeDot={{ r: 5 }} isAnimationActive={false} />
      case 'line':
      default:
        return <Line key={ys.key} dataKey={ys.key} yAxisId={ys.axis}
          stroke={effectiveColor} strokeWidth={1.5} strokeDasharray={strokeDash}
          dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
    }
  }

  function renderYSeriesWithKey(ys: YSeriesConfig, dataKey: string, colorOverride: string) {
    const strokeDash =
      ys.lineStyle === 'dashed' ? '6 3' :
      ys.lineStyle === 'dotted' ? '2 3' :
      undefined
    switch (ys.chartType) {
      case 'bar':
        return <Bar key={dataKey} dataKey={dataKey} yAxisId={ys.axis}
          fill={colorOverride} fillOpacity={0.8} radius={[2,2,0,0]}
          isAnimationActive={false} />
      case 'area':
        return <Area key={dataKey} dataKey={dataKey} yAxisId={ys.axis}
          stroke={colorOverride} fill={colorOverride} fillOpacity={0.1}
          strokeWidth={1.5} strokeDasharray={strokeDash}
          dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
      default:
        return <Line key={dataKey} dataKey={dataKey} yAxisId={ys.axis}
          stroke={colorOverride} strokeWidth={1.5} strokeDasharray={strokeDash}
          dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
    }
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(60, height)}>
      <ComposedChart data={rows} margin={{ top: 20, right: hasRightAxis ? 0 : 8, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.25} vertical={false} />

        <XAxis
          dataKey={xDataKey}
          type={isTimeX ? 'category' : 'number'}
          tick={{ fontSize: fs, fill: 'var(--muted-foreground)' } as React.SVGProps<SVGTextElement>}
          tickLine={false}
          axisLine={false}
          interval={xAxisInterval}
          domain={isTimeX ? undefined : ['auto', 'auto']}
          label={!isTimeX ? {
            value: allFields.find(f => f.key === settings.xAxisKey)?.label ?? settings.xAxisKey,
            position: 'insideBottom',
            offset: -4,
            fontSize: fs * 0.85,
            fill: 'var(--muted-foreground)',
          } : undefined}
        />

        <YAxis
          yAxisId="left"
          tick={{ fontSize: fs * 0.85, fill: 'var(--muted-foreground)' } as React.SVGProps<SVGTextElement>}
          tickLine={false} axisLine={false}
          tickFormatter={getAxisFormatter(leftSeries)}
          width={leftSeries.length > 0 ? 36 : 0}
          hide={hideAxes || leftSeries.length === 0}
        />

        {hasRightAxis && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: fs * 0.85, fill: 'var(--muted-foreground)' } as React.SVGProps<SVGTextElement>}
            tickLine={false} axisLine={false}
            tickFormatter={getAxisFormatter(rightSeries)}
            width={36}
            hide={hideAxes}
          />
        )}

        <Tooltip
          contentStyle={{
            backgroundColor: 'color-mix(in oklch, var(--popover) 96%, transparent)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid color-mix(in oklch, var(--border) 70%, transparent)',
            borderRadius: '6px',
            fontSize: '11px',
            boxShadow: '0 8px 32px -4px rgb(0 0 0 / 0.3)',
          }}
          formatter={(value?: number | string, name?: string) => {
            const hasSuffix = typeof name === 'string' && name.includes('__')
            const seriesKey = hasSuffix ? name!.split('__')[0] : name ?? ''
            const sliceSuffix = hasSuffix ? name!.split('__').pop() : null
            const slice = settings.comparisonSlices?.find(s => s.id === sliceSuffix)

            const ysDef = settings.ySeries.find(ys => ys.key === seriesKey)
            const seriesDef = config.series.find(s => s.key === seriesKey)
            const group = config.seriesGroups.find(g => g.key === seriesDef?.group)
            const field = allFields.find(f => f.key === seriesKey)
            const baseName = ysDef?.label ?? field?.label ?? seriesKey
            const displayName = slice ? `${baseName} [${slice.label || 'Period'}]` : baseName

            if (!group || typeof value !== 'number') return [String(value ?? ''), displayName]
            const formatted = group.unitPos === 'prefix'
              ? `${group.unit}${value.toFixed(2)}`
              : `${value.toFixed(2)}${group.unit}`
            return [formatted, displayName]
          }}
        />

        {showQuarterLines && quarterRefMonths.map((month, i) => (
          <ReferenceLine key={month} x={month} yAxisId="left"
            stroke="var(--border)" strokeDasharray="2 2" strokeOpacity={0.5}
            label={showQLabels ? {
              value: quarterLabels[i],
              fontSize: fs * 0.8,
              fill: 'var(--muted-foreground)',
              position: 'insideTop',
            } : undefined}
          />
        ))}

        {isCompareMode
          ? settings.comparisonSlices!.flatMap((slice, sliceIdx) => {
              const sliceColor = slice.color ?? SLICE_PALETTE[sliceIdx % SLICE_PALETTE.length]
              return settings.ySeries.map(ys => {
                const dataKey = `${ys.key}__${slice.id}`
                return renderYSeriesWithKey(ys, dataKey, sliceColor)
              })
            })
          : ySeries.map(ys => renderYSeries(ys))
        }
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/* ===================================================
   ChartWidget — main export (was PriceChartsContent)
   =================================================== */

interface ChartWidgetProps {
  instanceId: string
  settings: ChartInstanceSettings
  onSettingsChange: (partial: Partial<ChartInstanceSettings>) => void
  config?: ChartConfig
}

export function ChartWidget({
  instanceId,
  settings,
  onSettingsChange,
  config = CHARCOAL_UNIVERSAL_CONFIG,
}: ChartWidgetProps) {
  const { wTier, hTier, widthPx, heightPx } = useWidgetSize()
  const [nameInput, setNameInput] = useState(settings.title)
  const [openColorPicker, setOpenColorPicker] = useState<string | null>(null)
  const dragYRef = useRef<number | null>(null)
  const dragSliceRef = useRef<number | null>(null)

  useEffect(() => {
    setNameInput(settings.title)
  }, [settings.title])

  const allFields = getAvailableFields(config)

  const HEADER_H = 36
  const chartHeight = Math.max(60, heightPx - HEADER_H)
  const chartWidth = Math.max(200, widthPx)

  const compactLegend = wTier === 'xs' || wTier === 'sm'
  const isCompareMode = (settings.comparisonSlices?.length ?? 0) > 0

  const chartKey = `${instanceId}-${settings.xAxisKey}-${JSON.stringify(settings.xFilter)}-${
    (settings.comparisonSlices ?? []).map(s => `${s.id}:${JSON.stringify(s.filter)}`).join(',')
  }-${settings.ySeries.map(ys => `${ys.key}:${ys.chartType}:${ys.lineStyle}:${ys.axis}`).join(',')}`

  function handleAddYSeries(fieldKey: string) {
    if (settings.ySeries.some(ys => ys.key === fieldKey)) return
    const field = allFields.find(f => f.key === fieldKey)
    onSettingsChange({
      ySeries: [...settings.ySeries, {
        key: fieldKey,
        chartType: field?.defaultChartType ?? 'line',
        lineStyle: 'solid',
        axis: 'left',
        color: undefined,
        label: undefined,
      }],
    })
  }

  function handleRemoveYSeries(fieldKey: string) {
    onSettingsChange({ ySeries: settings.ySeries.filter(ys => ys.key !== fieldKey) })
  }

  function handleYSeriesTypeChange(fieldKey: string, chartType: ChartType) {
    onSettingsChange({
      ySeries: settings.ySeries.map(ys => ys.key === fieldKey ? { ...ys, chartType } : ys),
    })
  }

  function handleYSeriesAxisToggle(fieldKey: string) {
    onSettingsChange({
      ySeries: settings.ySeries.map(ys =>
        ys.key === fieldKey ? { ...ys, axis: ys.axis === 'left' ? 'right' : 'left' } : ys
      ),
    })
  }

  function handleLineStyleChange(fieldKey: string, lineStyle: LineStyle) {
    onSettingsChange({
      ySeries: settings.ySeries.map(ys =>
        ys.key === fieldKey ? { ...ys, lineStyle } : ys
      ),
    })
  }

  function handleColorChange(fieldKey: string, color: string) {
    onSettingsChange({
      ySeries: settings.ySeries.map(ys =>
        ys.key === fieldKey ? { ...ys, color } : ys
      ),
    })
  }

  function handleLabelChange(fieldKey: string, label: string) {
    onSettingsChange({
      ySeries: settings.ySeries.map(ys =>
        ys.key === fieldKey ? { ...ys, label: label.trim() || undefined } : ys
      ),
    })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header row: legend left, settings right */}
      <div className="flex items-center justify-between mb-1 flex-shrink-0">
        {/* Legend dots */}
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          {isCompareMode
            ? (settings.comparisonSlices ?? []).map((slice, sliceIdx) => {
                const sliceColor = slice.color ?? SLICE_PALETTE[sliceIdx % SLICE_PALETTE.length]
                return (
                  <div key={slice.id} className="flex items-center gap-1 shrink-0">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: sliceColor }} />
                    {!compactLegend && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">
                        {slice.label || `Period ${sliceIdx + 1}`}
                      </span>
                    )}
                  </div>
                )
              })
            : settings.ySeries.map(ys => {
                const field = allFields.find(f => f.key === ys.key)
                if (!field) return null
                const effectiveColor = ys.color ?? field.color
                const effectiveLabel = ys.label ?? field.label
                return (
                  <div key={ys.key} className="flex items-center gap-1 shrink-0">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: effectiveColor }} />
                    {!compactLegend && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">{effectiveLabel}</span>
                    )}
                  </div>
                )
              })
          }
        </div>

        {/* Settings popover */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="px-1.5 py-0.5 text-[10px] font-medium rounded-sm text-muted-foreground hover:text-foreground transition-colors"
                title="Chart Settings"
              >
                ...
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-72 p-3 max-h-[480px] overflow-y-auto bg-popover/95 backdrop-blur-lg">
              {/* Chart Name */}
              <div className="mb-3">
                <div className="text-[10px] font-semibold text-muted-foreground mb-1.5">Chart Name</div>
                <input
                  className="w-full text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  onBlur={() => onSettingsChange({ title: nameInput })}
                  onKeyDown={e => { if (e.key === 'Enter') onSettingsChange({ title: nameInput }) }}
                />
              </div>

              {/* Font Size */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">Font Size</span>
                <button type="button" disabled={settings.fontScale <= -3}
                  onClick={() => onSettingsChange({ fontScale: Math.max(-3, settings.fontScale - 1) })}
                  className="w-5 h-5 flex items-center justify-center rounded text-xs border border-border bg-muted/30 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">-</button>
                <span className="text-xs font-mono w-5 text-center tabular-nums">
                  {settings.fontScale >= 0 ? `+${settings.fontScale}` : settings.fontScale}
                </span>
                <button type="button" disabled={settings.fontScale >= 3}
                  onClick={() => onSettingsChange({ fontScale: Math.min(3, settings.fontScale + 1) })}
                  className="w-5 h-5 flex items-center justify-center rounded text-xs border border-border bg-muted/30 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">+</button>
              </div>

              <div className="border-t border-border mb-3" />

              {/* X Axis */}
              <div className="mb-3">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">X Axis</div>
                <select
                  value={settings.xAxisKey}
                  onChange={e => onSettingsChange({ xAxisKey: e.target.value })}
                  className="w-full text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none cursor-pointer"
                >
                  {allFields.map(f => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>

                {settings.xAxisKey === 'month' && !(settings.comparisonSlices?.length) && (
                  <div className="mt-1.5">
                    {settings.xFilter?.type === 'range' ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1">
                          <select
                            value={settings.xFilter.range?.start ?? 0}
                            onChange={e => onSettingsChange({ xFilter: { type: 'range', range: { start: Number(e.target.value), end: settings.xFilter?.range?.end ?? 11 } } })}
                            className="flex-1 text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none cursor-pointer"
                          >
                            {PIVOT_MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
                          </select>
                          <span className="text-[10px] text-muted-foreground">to</span>
                          <select
                            value={settings.xFilter?.range?.end ?? 11}
                            onChange={e => onSettingsChange({ xFilter: { type: 'range', range: { start: settings.xFilter?.range?.start ?? 0, end: Number(e.target.value) } } })}
                            className="flex-1 text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none cursor-pointer"
                          >
                            {PIVOT_MONTHS.map((m, i) => <option key={i} value={i}>{m}</option>)}
                          </select>
                          <button
                            type="button"
                            onClick={() => onSettingsChange({ xFilter: { type: 'all' } })}
                            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                          >&times;</button>
                        </div>
                      </div>
                    ) : (
                      <select
                        value={settings.xFilter?.type === 'year' ? settings.xFilter.year : settings.xFilter?.type === 'quarter' ? settings.xFilter.quarter : settings.xFilter?.type ?? 'all'}
                        onChange={e => {
                          const v = e.target.value
                          if (v === 'all') onSettingsChange({ xFilter: { type: 'all' } })
                          else if (DATA_YEARS.includes(v)) onSettingsChange({ xFilter: { type: 'year', year: v } })
                          else if (v === 'Q1') onSettingsChange({ xFilter: { type: 'quarter', quarter: 'Q1' } })
                          else if (v === 'Q2') onSettingsChange({ xFilter: { type: 'quarter', quarter: 'Q2' } })
                          else if (v === 'Q3') onSettingsChange({ xFilter: { type: 'quarter', quarter: 'Q3' } })
                          else if (v === 'Q4') onSettingsChange({ xFilter: { type: 'quarter', quarter: 'Q4' } })
                          else if (v === 'range') onSettingsChange({ xFilter: { type: 'range', range: { start: 0, end: 11 } } })
                        }}
                        className="w-full text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none cursor-pointer"
                      >
                        <option value="all">All (fiscal year)</option>
                        {DATA_YEARS.map(yr => (
                          <option key={yr} value={yr}>{yr === CURRENT_YEAR ? `${yr} (Current)` : yr}</option>
                        ))}
                        <option value="Q1">Q1 (Mar--May)</option>
                        <option value="Q2">Q2 (Jun--Aug)</option>
                        <option value="Q3">Q3 (Sep--Nov)</option>
                        <option value="Q4">Q4 (Dec--Feb)</option>
                        <option value="range">Custom range...</option>
                      </select>
                    )}
                  </div>
                )}
                {settings.xAxisKey === 'month' && (settings.comparisonSlices?.length ?? 0) > 0 && (
                  <p className="text-[10px] text-muted-foreground/60 mt-1">Each period has its own filter below</p>
                )}
              </div>

              {/* Y Axis series */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Y Axis</div>
                  <select
                    value=""
                    onChange={e => { if (e.target.value) handleAddYSeries(e.target.value) }}
                    className="text-[10px] bg-muted/30 border border-border rounded px-1.5 py-0.5 text-foreground focus:outline-none cursor-pointer"
                  >
                    <option value="">+ Add</option>
                    {allFields
                      .filter(f => !settings.ySeries.some(ys => ys.key === f.key))
                      .map(f => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))
                    }
                  </select>
                </div>

                {settings.ySeries.length === 0 && (
                  <div className="text-[10px] text-muted-foreground py-2">No series added yet</div>
                )}

                <div className="space-y-2">
                  {settings.ySeries.map((ys, index) => {
                    const field = allFields.find(f => f.key === ys.key)
                    if (!field) return null
                    const effectiveColor = ys.color ?? field.color
                    const showColorPicker = openColorPicker === ys.key
                    const showLineStyle = ys.chartType === 'line' || ys.chartType === 'area'

                    return (
                      <div
                        key={ys.key}
                        draggable
                        onDragStart={() => { dragYRef.current = index }}
                        onDragOver={e => e.preventDefault()}
                        onDrop={() => {
                          const from = dragYRef.current
                          if (from === null || from === index) return
                          const reordered = [...settings.ySeries]
                          const [moved] = reordered.splice(from, 1)
                          reordered.splice(index, 0, moved)
                          onSettingsChange({ ySeries: reordered })
                          dragYRef.current = null
                        }}
                        onDragEnd={() => { dragYRef.current = null }}
                        className="rounded border border-border bg-muted/20 p-1.5 space-y-1.5 cursor-default"
                      >
                        <div className="flex items-center gap-1.5">
                          <div
                            className="text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing shrink-0 select-none text-[11px] leading-none"
                            title="Drag to reorder"
                          >
                            &#x283F;
                          </div>
                          <button
                            type="button"
                            onClick={e => {
                              e.preventDefault()
                              e.stopPropagation()
                              setOpenColorPicker(showColorPicker ? null : ys.key)
                            }}
                            className="w-4 h-4 rounded-full border border-border/50 shrink-0 hover:ring-2 hover:ring-ring transition-all"
                            style={{ backgroundColor: effectiveColor }}
                            title="Change color"
                          />
                          <input
                            type="text"
                            value={ys.label ?? ''}
                            onChange={e => handleLabelChange(ys.key, e.target.value)}
                            placeholder={field.label}
                            className="flex-1 min-w-0 text-xs bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground/50"
                          />
                          <button
                            type="button"
                            onClick={e => { e.preventDefault(); e.stopPropagation(); handleRemoveYSeries(ys.key) }}
                            className="text-[11px] text-muted-foreground hover:text-destructive transition-colors shrink-0 w-4 h-4 flex items-center justify-center"
                            title="Remove series"
                          >
                            &times;
                          </button>
                        </div>

                        {showColorPicker && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {CHART_PALETTE.map(c => (
                              <button
                                key={c}
                                type="button"
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleColorChange(ys.key, c)
                                  setOpenColorPicker(null)
                                }}
                                className={`w-4 h-4 rounded-full border transition-all hover:scale-110 ${
                                  effectiveColor === c ? 'border-foreground ring-1 ring-foreground' : 'border-border/50'
                                }`}
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                        )}

                        <div className="flex items-center gap-1">
                          <select
                            value={ys.chartType}
                            onChange={e => handleYSeriesTypeChange(ys.key, e.target.value as ChartType)}
                            onClick={e => e.stopPropagation()}
                            className="text-[9px] bg-muted/30 border border-border rounded px-1 py-0.5 text-foreground focus:outline-none cursor-pointer flex-1"
                          >
                            <option value="line">Line</option>
                            <option value="bar">Bar</option>
                            <option value="area">Area</option>
                            <option value="scatter">Scatter</option>
                          </select>

                          {showLineStyle && (
                            <select
                              value={ys.lineStyle ?? 'solid'}
                              onChange={e => handleLineStyleChange(ys.key, e.target.value as LineStyle)}
                              onClick={e => e.stopPropagation()}
                              className="text-[9px] bg-muted/30 border border-border rounded px-1 py-0.5 text-foreground focus:outline-none cursor-pointer flex-1"
                            >
                              <option value="solid">Solid</option>
                              <option value="dashed">Dashed</option>
                              <option value="dotted">Dotted</option>
                            </select>
                          )}

                          <button
                            type="button"
                            onClick={e => { e.preventDefault(); e.stopPropagation(); handleYSeriesAxisToggle(ys.key) }}
                            className={`text-[9px] font-mono w-5 h-5 flex items-center justify-center rounded border shrink-0 transition-colors ${
                              ys.axis === 'right'
                                ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                                : 'border-border bg-muted/30 text-muted-foreground hover:text-foreground'
                            }`}
                            title="Toggle Y-axis: L = left, R = right"
                          >
                            {ys.axis === 'right' ? 'R' : 'L'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Compare section */}
              <div className="border-t border-border mt-3 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Compare</div>
                  <button
                    type="button"
                    onClick={() => {
                      const existingCount = (settings.comparisonSlices ?? []).length
                      const newSlice = {
                        id: Date.now().toString(),
                        label: '',
                        filter: { type: 'all' as const },
                        color: SLICE_PALETTE[existingCount % SLICE_PALETTE.length],
                      }
                      onSettingsChange({ comparisonSlices: [...(settings.comparisonSlices ?? []), newSlice] })
                    }}
                    className="text-[10px] text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-0.5 transition-colors"
                  >
                    + Period
                  </button>
                </div>

                {(settings.comparisonSlices ?? []).length === 0 && (
                  <p className="text-[10px] text-muted-foreground/60 py-1">Add periods to overlay them on the same chart</p>
                )}

                <div className="space-y-1.5">
                  {(settings.comparisonSlices ?? []).map((slice, sliceIdx) => {
                    const sliceColor = slice.color ?? SLICE_PALETTE[sliceIdx % SLICE_PALETTE.length]
                    const filterValue = slice.filter.type === 'year' ? slice.filter.year
                      : slice.filter.type === 'quarter' ? slice.filter.quarter
                      : slice.filter.type

                    return (
                      <div
                        key={slice.id}
                        draggable
                        onDragStart={() => { dragSliceRef.current = sliceIdx }}
                        onDragOver={e => e.preventDefault()}
                        onDrop={() => {
                          const from = dragSliceRef.current
                          if (from === null || from === sliceIdx) return
                          const reordered = [...(settings.comparisonSlices ?? [])]
                          const [moved] = reordered.splice(from, 1)
                          reordered.splice(sliceIdx, 0, moved)
                          onSettingsChange({ comparisonSlices: reordered })
                          dragSliceRef.current = null
                        }}
                        onDragEnd={() => { dragSliceRef.current = null }}
                        className="flex items-center gap-1.5 rounded border border-border bg-muted/20 px-1.5 py-1 cursor-default"
                      >
                        <div
                          className="text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing shrink-0 select-none text-[11px] leading-none"
                          title="Drag to reorder"
                        >
                          &#x283F;
                        </div>
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: sliceColor }} />

                        <input
                          type="text"
                          value={slice.label}
                          onChange={e => {
                            const updated = (settings.comparisonSlices ?? []).map(s =>
                              s.id === slice.id ? { ...s, label: e.target.value } : s
                            )
                            onSettingsChange({ comparisonSlices: updated })
                          }}
                          placeholder="Label..."
                          className="flex-1 min-w-0 text-xs bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground/50"
                        />

                        <select
                          value={filterValue ?? 'all'}
                          onChange={e => {
                            const v = e.target.value
                            let filter
                            if (v === 'all') filter = { type: 'all' as const }
                            else if (DATA_YEARS.includes(v)) filter = { type: 'year' as const, year: v }
                            else if (v === 'Q1') filter = { type: 'quarter' as const, quarter: 'Q1' as const }
                            else if (v === 'Q2') filter = { type: 'quarter' as const, quarter: 'Q2' as const }
                            else if (v === 'Q3') filter = { type: 'quarter' as const, quarter: 'Q3' as const }
                            else if (v === 'Q4') filter = { type: 'quarter' as const, quarter: 'Q4' as const }
                            else filter = { type: 'all' as const }
                            const updated = (settings.comparisonSlices ?? []).map(s =>
                              s.id === slice.id ? { ...s, filter } : s
                            )
                            onSettingsChange({ comparisonSlices: updated })
                          }}
                          className="text-[9px] bg-muted/30 border border-border rounded px-1 py-0.5 text-foreground focus:outline-none cursor-pointer"
                        >
                          <option value="all">All</option>
                          {DATA_YEARS.map(yr => (
                            <option key={yr} value={yr}>{yr === CURRENT_YEAR ? `${yr} (Current)` : yr}</option>
                          ))}
                          <option value="Q1">Q1</option>
                          <option value="Q2">Q2</option>
                          <option value="Q3">Q3</option>
                          <option value="Q4">Q4</option>
                        </select>

                        <button
                          type="button"
                          onClick={() => {
                            const updated = (settings.comparisonSlices ?? []).filter(s => s.id !== slice.id)
                            onSettingsChange({ comparisonSlices: updated })
                          }}
                          className="text-[11px] text-muted-foreground hover:text-destructive transition-colors shrink-0 w-4 h-4 flex items-center justify-center"
                        >
                          &times;
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Chart area */}
      <div className="flex-1 min-h-0 relative">
        {settings.ySeries.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <p className="text-[11px] text-muted-foreground">No series added</p>
            <p className="text-[10px] text-muted-foreground/60">Open <span className="font-mono">&#8943;</span> &rarr; Y Axis &rarr; + Add</p>
          </div>
        ) : (
          <div key={chartKey} className="absolute inset-0 animate-fade-in">
            <RechartsWidget
              config={config}
              settings={settings}
              width={chartWidth}
              height={chartHeight}
              wTier={wTier}
              hTier={hTier}
              fs={11 + settings.fontScale}
            />
          </div>
        )}
      </div>
    </div>
  )
}
