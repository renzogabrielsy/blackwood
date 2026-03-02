'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { useWidgetSize } from '@/components/widgets/chart/utils'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import type { SpecialChartData, SpecialChartSettings, SpecialChartType, ScatterGranularity } from './types'
import {
  numericFields,
  categoricalFields,
  fieldLabel,
  buildColorMap,
  aggregateScatterData,
  YEAR_COLORS,
  GENERIC_PALETTE,
} from './aggregation'
import { ScatterRenderer } from './scatter-renderer'
import { PieRenderer } from './pie-renderer'

/* ===================================================
   SpecialChartWidget — scatter / pie / donut dispatcher
   Zero domain knowledge — all field info from FieldDef[].
   =================================================== */

export interface SpecialChartWidgetProps {
  data?: SpecialChartData
  settings?: SpecialChartSettings
  onSettingsChange?: (partial: Partial<SpecialChartSettings>) => void
}

/* ---- Chart type options ---- */
const CHART_TYPE_OPTIONS: { value: SpecialChartType; label: string }[] = [
  { value: 'scatter', label: 'Scatter' },
  { value: 'pie',     label: 'Pie' },
  { value: 'donut',   label: 'Donut' },
]

/* ---- Granularity options ---- */
const GRANULARITY_OPTIONS: { value: ScatterGranularity; label: string }[] = [
  { value: 'day',     label: 'Day' },
  { value: 'month',   label: 'Month' },
  { value: 'quarter', label: 'Qtr' },
  { value: 'year',    label: 'Year' },
]

/* ---- Aggregation options ---- */
const AGGREGATION_OPTIONS: { value: 'sum' | 'avg' | 'count'; label: string }[] = [
  { value: 'sum',   label: 'Sum' },
  { value: 'avg',   label: 'Avg' },
  { value: 'count', label: 'Count' },
]

/* ---- Indeterminate checkbox ---- */
interface IndeterminateCheckboxProps {
  checked: boolean
  indeterminate: boolean
  onChange: () => void
  className?: string
}

function IndeterminateCheckbox({ checked, indeterminate, onChange, className }: IndeterminateCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className={className}
    />
  )
}

/* ===================================================
   Main component
   =================================================== */

export function SpecialChartWidget({
  data,
  settings,
  onSettingsChange,
}: SpecialChartWidgetProps) {
  const { wTier, hTier } = useWidgetSize()
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set())

  /* ---- Empty / no data guard ---- */
  if (!data || data.rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        No data
      </div>
    )
  }

  /* ---- Derived settings with defaults ---- */
  const chartType = settings?.chartType ?? 'scatter'
  const granularity = settings?.granularity ?? 'month'
  const quarterFilter = settings?.quarterFilter ?? []
  const showRefLines = settings?.showRefLines ?? true
  const aggregation = settings?.aggregation ?? 'sum'

  const nFields = numericFields(data.fields)
  const cFields = categoricalFields(data.fields)

  const xField = settings?.xField ?? nFields[0]?.key ?? ''
  const yField = settings?.yField ?? nFields[1]?.key ?? nFields[0]?.key ?? ''
  const colorBy = settings?.colorBy ??
    (cFields.find(f => f.key === 'year')?.key ?? cFields[0]?.key ?? '')
  const valueField = settings?.valueField ?? nFields[0]?.key ?? ''
  const groupBy = settings?.groupBy ?? cFields[0]?.key ?? ''

  /* ---- Year→Quarter map for filter tree (scatter only) ---- */
  const yearQuarterMap = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const row of data.rows) {
      const year = String(row.year ?? '')
      const quarter = String(row.quarter ?? '')
      if (!year || !quarter) continue
      if (!map.has(year)) map.set(year, new Set())
      map.get(year)!.add(quarter)
    }
    return map
  }, [data.rows])

  const allYears = useMemo(
    () => Array.from(yearQuarterMap.keys()).sort((a, b) => Number(b) - Number(a)),
    [yearQuarterMap],
  )

  /* ---- Legend values for scatter ---- */
  const displayPoints = useMemo(
    () => chartType === 'scatter'
      ? aggregateScatterData(data, xField, yField, colorBy, granularity, quarterFilter)
      : [],
    [data, xField, yField, colorBy, granularity, quarterFilter, chartType],
  )

  const legendValues = useMemo(
    () => Array.from(new Set(displayPoints.map(p => p.colorValue))).sort(),
    [displayPoints],
  )

  const colorMap = useMemo(
    () => buildColorMap(legendValues, colorBy),
    [legendValues, colorBy],
  )

  /* ---- Visibility flags ---- */
  const showLegend = (hTier !== 'sm' && hTier !== 'xs') && chartType === 'scatter'
  const showLegendText = wTier !== 'xs' && wTier !== 'sm'

  /* ---- Settings handlers ---- */
  function update(partial: Partial<SpecialChartSettings>) {
    onSettingsChange?.(partial)
  }

  function toggleExpandYear(year: string) {
    setExpandedYears(prev => {
      const next = new Set(prev)
      next.has(year) ? next.delete(year) : next.add(year)
      return next
    })
  }

  function handleQuarterToggle(quarterKey: string) {
    const next = quarterFilter.includes(quarterKey)
      ? quarterFilter.filter(q => q !== quarterKey)
      : [...quarterFilter, quarterKey]
    update({ quarterFilter: next })
  }

  function handleYearCheckboxToggle(year: string) {
    const yearQuarters = Array.from(yearQuarterMap.get(year) ?? [])
    const allSelected = yearQuarters.every(q => quarterFilter.includes(q))
    const someSelected = yearQuarters.some(q => quarterFilter.includes(q))
    if (allSelected || someSelected) {
      update({ quarterFilter: quarterFilter.filter(q => !yearQuarters.includes(q)) })
    } else {
      update({ quarterFilter: Array.from(new Set([...quarterFilter, ...yearQuarters])) })
    }
  }

  function getYearCheckboxState(year: string): { checked: boolean; indeterminate: boolean } {
    if (quarterFilter.length === 0) return { checked: false, indeterminate: false }
    const yearQuarters = Array.from(yearQuarterMap.get(year) ?? [])
    const selected = yearQuarters.filter(q => quarterFilter.includes(q)).length
    if (selected === 0) return { checked: false, indeterminate: false }
    if (selected === yearQuarters.length) return { checked: true, indeterminate: false }
    return { checked: false, indeterminate: true }
  }

  function getColorForYear(year: string): string {
    return YEAR_COLORS[year] ?? '#71717a'
  }

  return (
    <div className="flex flex-col gap-1.5 h-full">
      {/* ---- Internal header row ---- */}
      <div className="flex items-center justify-between gap-2 shrink-0 px-0.5">
        {/* Legend (scatter only) */}
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {showLegend &&
            legendValues.map(val => (
              <div key={val} className="flex items-center gap-1 min-w-0">
                <span
                  className="shrink-0 inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: colorMap.get(val) ?? '#71717a' }}
                />
                {showLegendText && (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {val}
                  </span>
                )}
              </div>
            ))}
        </div>

        {/* Settings ⋯ popover */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Chart settings"
              className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors text-xs leading-none shrink-0"
            >
              &#8943;
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60 p-3 space-y-4 bg-popover/95 backdrop-blur-lg">

            {/* Section: Chart Type */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Chart Type
              </p>
              <div className="grid grid-cols-3 rounded-md border border-border bg-muted/30 p-0.5 gap-0.5">
                {CHART_TYPE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => update({ chartType: opt.value })}
                    className={`px-1.5 py-1 text-[10px] font-medium rounded-sm transition-colors text-center ${
                      chartType === opt.value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ---- Scatter-specific controls ---- */}
            {chartType === 'scatter' && (
              <>
                {/* X Axis field */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    X Axis
                  </p>
                  <select
                    value={xField}
                    onChange={e => update({ xField: e.target.value })}
                    className="w-full text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {nFields.map(f => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>

                {/* Y Axis field */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Y Axis
                  </p>
                  <select
                    value={yField}
                    onChange={e => update({ yField: e.target.value })}
                    className="w-full text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {nFields.map(f => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>

                {/* Color By */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Color By
                  </p>
                  <select
                    value={colorBy}
                    onChange={e => update({ colorBy: e.target.value })}
                    className="w-full text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {cFields.map(f => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>

                {/* Granularity */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Granularity
                  </p>
                  <div className="grid grid-cols-4 rounded-md border border-border bg-muted/30 p-0.5 gap-0.5">
                    {GRANULARITY_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => update({ granularity: opt.value })}
                        className={`px-1.5 py-1 text-[10px] font-medium rounded-sm transition-colors text-center ${
                          granularity === opt.value
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Show reference lines */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Display
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showRefLines}
                      onChange={() => update({ showRefLines: !showRefLines })}
                      className="rounded border-border accent-primary cursor-pointer"
                    />
                    <span className="text-xs text-foreground">Show average lines</span>
                  </label>
                </div>
              </>
            )}

            {/* ---- Pie / Donut controls ---- */}
            {(chartType === 'pie' || chartType === 'donut') && (
              <>
                {/* Value field */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Value
                  </p>
                  <select
                    value={valueField}
                    onChange={e => update({ valueField: e.target.value })}
                    className="w-full text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {nFields.map(f => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>

                {/* Aggregation measure */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Measure
                  </p>
                  <div className="grid grid-cols-3 rounded-md border border-border bg-muted/30 p-0.5 gap-0.5">
                    {AGGREGATION_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => update({ aggregation: opt.value })}
                        className={`px-1 py-1 text-[10px] font-medium rounded-sm transition-colors text-center ${
                          aggregation === opt.value
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Group By field */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Group By
                  </p>
                  <select
                    value={groupBy}
                    onChange={e => update({ groupBy: e.target.value })}
                    className="w-full text-xs bg-muted/30 border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {cFields.map(f => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {/* ---- Shared: Quarters filter ---- */}
            {allYears.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Quarters
                  </p>
                  {quarterFilter.length > 0 && (
                    <button
                      type="button"
                      onClick={() => update({ quarterFilter: [] })}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground">No selection = show all</p>
                <div className="space-y-0.5 max-h-40 overflow-y-auto">
                  {allYears.map(year => {
                    const isExpanded = expandedYears.has(year)
                    const { checked, indeterminate } = getYearCheckboxState(year)
                    const yearQuarters = Array.from(yearQuarterMap.get(year) ?? []).sort()

                    return (
                      <div key={year}>
                        <div className="flex items-center gap-1.5 py-0.5">
                          <button
                            type="button"
                            onClick={() => toggleExpandYear(year)}
                            aria-label={isExpanded ? `Collapse ${year}` : `Expand ${year}`}
                            className="w-3 h-3 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0 text-[8px] leading-none"
                          >
                            {isExpanded ? '▼' : '▶'}
                          </button>
                          <IndeterminateCheckbox
                            checked={checked}
                            indeterminate={indeterminate}
                            onChange={() => handleYearCheckboxToggle(year)}
                            className="rounded border-border accent-primary cursor-pointer"
                          />
                          <span
                            className="inline-block w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: getColorForYear(year) }}
                          />
                          <button
                            type="button"
                            onClick={() => toggleExpandYear(year)}
                            className="text-xs text-foreground font-mono hover:text-foreground/80 transition-colors"
                          >
                            {year}
                          </button>
                        </div>
                        {isExpanded && (
                          <div className="ml-5 space-y-0.5 pb-0.5">
                            {yearQuarters.map(quarterKey => {
                              const qLabel = quarterKey.split('-')[1]
                              const isChecked = quarterFilter.includes(quarterKey)
                              return (
                                <label
                                  key={quarterKey}
                                  className="flex items-center gap-2 cursor-pointer py-0.5"
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => handleQuarterToggle(quarterKey)}
                                    className="rounded border-border accent-primary cursor-pointer"
                                  />
                                  <span className="text-xs text-muted-foreground font-mono">
                                    {qLabel}
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {/* ---- Renderer area ---- */}
      <div className="flex-1 min-h-0">
        {chartType === 'scatter' && (
          <ScatterRenderer
            data={data}
            xField={xField}
            yField={yField}
            colorBy={colorBy}
            granularity={granularity}
            quarterFilter={quarterFilter}
            showRefLines={showRefLines}
          />
        )}
        {(chartType === 'pie' || chartType === 'donut') && (
          <PieRenderer
            data={data}
            valueField={valueField}
            groupBy={groupBy}
            aggregation={aggregation}
            quarterFilter={quarterFilter}
            donut={chartType === 'donut'}
          />
        )}
      </div>
    </div>
  )
}

// Re-export types for convenience
export type { SpecialChartData, SpecialChartSettings }

// Suppress unused import warning from GENERIC_PALETTE (used in pie-renderer, re-exported here for consistency)
void GENERIC_PALETTE
