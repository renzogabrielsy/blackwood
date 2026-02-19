/* ===================================================
   Chart Widget — TypeScript Types
   =================================================== */

export interface LedgerMonth {
  label: string
  weightT: number
  phpKg: number
  momDelta: number | null
  momPct: number | null
  mc: number
  ash: number
  bdAstm: number
  bdJis: number
  grit: number
  vm: number
  fc: number
}

export interface LedgerQuarter {
  quarter: string
  weightT: number
  phpKg: number
  deltaQoQ: number
  mc: number
  ash: number
  bdAstm: number
  months: LedgerMonth[]
}

export interface LedgerYear {
  year: string
  quarters: LedgerQuarter[]
}

export interface UsageMonth {
  label: string
  usageT: number
  phpKg: number
  netT: number
  momDelta: number | null
  momPct: number | null
}

export interface UsageQuarter {
  quarter: string
  usageT: number
  phpKg: number
  netT: number
  deltaQoQ: number | null
  months: UsageMonth[]
}

export interface UsageYear {
  year: string
  quarters: UsageQuarter[]
}

export type ChartSeriesStyle = 'area' | 'line' | 'dashed' | 'bar'

export interface ChartDataPoint {
  x: number   // 0-based index into xAxis.labels
  value: number
}

export interface ChartSeriesGroup {
  key: string
  label: string
  unit: string
  unitPos: 'prefix' | 'suffix'
}

export interface ChartSeries {
  key: string
  label: string
  color: string
  style: ChartSeriesStyle
  points: ChartDataPoint[]
  group: string
}

export interface ChartPreset {
  key: string
  label: string
  seriesKeys: string[]
}

export interface ChartConfig {
  xAxis: {
    labels: string[]              // all x-position labels e.g. 12 months
    showQuarterBoundaries: boolean
    quarterBoundaryPositions?: number[]  // positions of boundary lines (e.g. [0.5, 3.5, 6.5, 9.5])
  }
  yAxis: {
    unit: string                  // "₱", "%", "T", etc.
    unitPos: 'prefix' | 'suffix'
    min?: number                  // optional override — auto-computed if omitted
    max?: number
  }
  series: ChartSeries[]           // ALL available series
  seriesGroups: ChartSeriesGroup[]
  presets: ChartPreset[]          // named quick-select groups
  defaultPreset: string
}

export type ChartType = 'line' | 'bar' | 'area' | 'scatter'

export type LineStyle = 'solid' | 'dashed' | 'dotted'

export interface YSeriesConfig {
  key: string             // any field key (including 'month')
  chartType: ChartType
  lineStyle: LineStyle    // only applies to line/area types
  axis: 'left' | 'right'
  color?: string          // hex override; undefined = use field default
  label?: string          // custom display name; undefined = use field label
}

export type FilterType = 'all' | 'year' | 'quarter' | 'range'

export interface TimeFilter {
  type: FilterType
  year?: string               // '2025' | '2026'
  quarter?: 'Q1' | 'Q2' | 'Q3' | 'Q4'
  range?: { start: number; end: number }  // fiscal indices 0–11 inclusive
}

export interface ComparisonSlice {
  id: string
  label: string               // user-editable: "2026", "2025", "Q3", etc.
  filter: TimeFilter
  color: string               // stable palette color, assigned at creation
}

export interface ChartInstanceSettings {
  title: string
  xAxisKey: string          // any field key; default 'month'
  xFilter?: TimeFilter                  // used when NO comparison slices
  comparisonSlices?: ComparisonSlice[]  // empty/absent = single-period mode
  ySeries: YSeriesConfig[]  // ordered list; empty = nothing shown
  fontScale: number
}

export interface AvailableField {
  key: string
  label: string
  color: string
  defaultChartType: ChartType
}

export type SizeTier = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export interface WidgetSize {
  widthPx: number
  heightPx: number
  wTier: SizeTier
  hTier: SizeTier
}
