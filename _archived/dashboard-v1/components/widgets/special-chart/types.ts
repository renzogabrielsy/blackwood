/* ===================================================
   SpecialChartWidget — TypeScript Types (Port / Data-Agnostic Interface)
   =================================================== */

/**
 * Describes a field available in the dataset.
 * Adapters emit this alongside rows so widgets can label axes generically.
 */
export interface FieldDef {
  key: string
  label: string
  type: 'numeric' | 'categorical'
  /** Optional unit string — '₱', '%', 'kg', etc. */
  unit?: string
}

/**
 * The primary port for SpecialChartWidget.
 * Adapters return this; the widget has zero knowledge of what produced it.
 */
export interface SpecialChartData {
  rows: Record<string, string | number | null>[]
  fields: FieldDef[]
}

export type SpecialChartType = 'scatter' | 'pie' | 'donut'
export type ScatterGranularity = 'day' | 'month' | 'quarter' | 'year'

/**
 * Persisted settings for the Special Chart widget.
 * Stored in D6Prefs.specialChartSettings.
 * All fields optional — defaults resolved at render time.
 */
export interface SpecialChartSettings {
  /** Chart rendering mode; default 'scatter' */
  chartType?: SpecialChartType
  /** Numeric field key for X axis (scatter) */
  xField?: string
  /** Numeric field key for Y axis (scatter) */
  yField?: string
  /** Categorical field key for dot coloring (scatter) */
  colorBy?: string
  /** Aggregation granularity (scatter); default 'month' */
  granularity?: ScatterGranularity
  /** Show mean reference lines (scatter); default true */
  showRefLines?: boolean
  /** Numeric field key to aggregate (pie/donut) */
  valueField?: string
  /** Aggregation function (pie/donut); default 'sum' */
  aggregation?: 'sum' | 'avg' | 'count'
  /** Categorical field key to group by (pie/donut) */
  groupBy?: string
  /** "YYYY-QN" strings — empty/absent = show all */
  quarterFilter?: string[]
}
