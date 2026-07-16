/* ===================================================
   Tenant Configuration — Charcoal Plant Operations
   ===================================================

   TENANT OVERRIDE POINT
   ---------------------
   This file is the single place where field definitions, chart series
   metadata, and default axis/color settings are declared for a tenant.
   To onboard a new tenant, duplicate this file (e.g. `acme-config.ts`),
   redefine the exports, and point adapters at the new config. No widget
   or platform code needs to change.

   Adapters import from here instead of defining domain knowledge inline.
   =================================================== */

import type { FieldDef } from '@/components/widgets/special-chart/types'

/* ===================================================
   Special Chart — Field Definitions
   =================================================== */

/**
 * Tenant-level field configuration for the SpecialChartWidget adapter.
 * `fields` defines every numeric and categorical column the adapter emits.
 * `defaultScatterX/Y/colorBy` seed the widget's initial axis selections.
 */
export interface TenantFieldConfig {
  fields: FieldDef[]
  /** Field key for the default X axis in scatter mode */
  defaultScatterX: string
  /** Field key for the default Y axis in scatter mode */
  defaultScatterY: string
  /** Field key for the default color grouping in scatter mode */
  defaultColorBy: string
}

// TENANT OVERRIDE POINT — swap this export to change field definitions for a different tenant
export const CHARCOAL_FIELD_CONFIG: TenantFieldConfig = {
  fields: [
    // Numeric — primary analytics fields first
    { key: 'phpKg',    label: 'PHP/KG',    type: 'numeric',  unit: '\u20B1' },
    { key: 'weightKg', label: 'Weight',    type: 'numeric',  unit: 'kg' },
    { key: 'phpTotal', label: 'PHP Total', type: 'numeric',  unit: '\u20B1' },
    { key: 'sacks',    label: 'Sacks',     type: 'numeric'                  },
    { key: 'mc',       label: 'MC',        type: 'numeric',  unit: '%' },
    { key: 'ash',      label: 'ASH',       type: 'numeric',  unit: '%' },
    { key: 'bdAstm',   label: 'BD ASTM',   type: 'numeric'                  },
    { key: 'bdJis',    label: 'BD JIS',    type: 'numeric'                  },
    { key: 'grit',     label: 'Grit',      type: 'numeric',  unit: '%' },
    { key: 'vm',       label: 'VM',        type: 'numeric',  unit: '%' },
    { key: 'fc',       label: 'FC',        type: 'numeric',  unit: '%' },
    // Categorical — year first so default colorBy is year
    { key: 'year',      label: 'Year',      type: 'categorical' },
    { key: 'quarter',   label: 'Quarter',   type: 'categorical' },
    { key: 'month',     label: 'Month',     type: 'categorical' },
    { key: 'supplier',  label: 'Supplier',  type: 'categorical' },
    { key: 'batchCode', label: 'Batch',     type: 'categorical' },
    { key: 'warehouse', label: 'Warehouse', type: 'categorical' },
    { key: 'blockLoc',  label: 'Block Loc', type: 'categorical' },
  ],
  defaultScatterX: 'phpKg',
  defaultScatterY: 'weightKg',
  defaultColorBy: 'year',
}

/** Convenience alias — the flat fields array used by adapters and mock data */
export const CHARCOAL_FIELDS = CHARCOAL_FIELD_CONFIG.fields

/* ===================================================
   Chart Widget — Series & Group Definitions
   =================================================== */

/**
 * Metadata for a single chart series. Decoupled from data points so
 * the adapter can attach computed points at runtime while the series
 * identity (key, label, color, style, group) comes from config.
 */
export interface TenantChartSeriesDef {
  key: string
  label: string
  color: string
  style: 'line' | 'bar' | 'area' | 'dashed'
  group: string
}

/**
 * A named group of series that share a Y-axis unit.
 */
export interface TenantChartGroupDef {
  key: string
  label: string
  unit: string
  unitPos: 'prefix' | 'suffix'
}

/**
 * A preset is a named collection of series keys that can be activated together.
 */
export interface TenantChartPresetDef {
  key: string
  label: string
  seriesKeys: string[]
}

/**
 * Full chart tenant config — series metadata, groups, presets, and palettes.
 * The adapter uses this to assemble a `ChartConfig` after computing data points.
 */
export interface TenantChartConfig {
  seriesGroups: TenantChartGroupDef[]
  series: TenantChartSeriesDef[]
  presets: TenantChartPresetDef[]
  defaultPreset: string
  yAxisUnit: string
  yAxisUnitPos: 'prefix' | 'suffix'
}

/* ---- Palettes ---- */
// Defined here (not in mock-data.ts) to avoid a circular dependency:
// mock-data → charcoal-special → tenant-config → mock-data.
// mock-data.ts re-exports these for any code that imports from there.
export const SLICE_PALETTE = ['#60a5fa', '#f87171', '#34d399', '#fbbf24']
export const CHART_PALETTE = [
  '#60a5fa', // blue
  '#a78bfa', // purple
  '#34d399', // green
  '#f87171', // red
  '#fbbf24', // amber
  '#22d3ee', // cyan
  '#fb923c', // orange
  '#c084fc', // violet
  '#f472b6', // pink
  '#10b981', // emerald
  '#94a3b8', // slate
  '#e2e8f0', // light
]

// TENANT OVERRIDE POINT — swap this export to change chart series for a different tenant
export const CHARCOAL_CHART_CONFIG: TenantChartConfig = {
  seriesGroups: [
    { key: 'price',   label: 'Price',   unit: '\u20B1', unitPos: 'prefix' },
    { key: 'volume',  label: 'Volume',  unit: 'T',      unitPos: 'suffix' },
    { key: 'quality', label: 'Quality', unit: '',        unitPos: 'suffix' },
    { key: 'ratio',   label: 'Ratio',   unit: '%',       unitPos: 'suffix' },
    { key: 'change',  label: 'Change',  unit: '%',       unitPos: 'suffix' },
  ],
  series: [
    { key: 'php_kg_in',    label: 'PHP/KG In',    color: CHART_PALETTE[0], style: 'area',   group: 'price'   },
    { key: 'php_kg_out',   label: 'PHP/KG Out',   color: CHART_PALETTE[1], style: 'dashed', group: 'price'   },
    { key: 'rcin_volume',  label: 'RC IN (T)',     color: CHART_PALETTE[2], style: 'bar',    group: 'volume'  },
    { key: 'rcout_volume', label: 'RC OUT (T)',    color: CHART_PALETTE[3], style: 'bar',    group: 'volume'  },
    { key: 'net_stock',    label: 'Net Stock (T)', color: CHART_PALETTE[9], style: 'line',   group: 'volume'  },
    { key: 'mc',           label: 'MC',            color: CHART_PALETTE[5], style: 'line',   group: 'quality' },
    { key: 'ash',          label: 'ASH',           color: CHART_PALETTE[6], style: 'line',   group: 'quality' },
    { key: 'bd_astm',      label: 'BD ASTM',       color: CHART_PALETTE[7], style: 'line',   group: 'quality' },
    { key: 'mom_pct',      label: 'MoM %',         color: CHART_PALETTE[8], style: 'line',   group: 'change'  },
  ],
  presets: [
    { key: 'trajectory', label: 'Trajectory',   seriesKeys: ['php_kg_in'] },
    { key: 'spread',     label: 'Price Spread', seriesKeys: ['php_kg_in', 'php_kg_out'] },
    { key: 'volume',     label: 'Volume',       seriesKeys: ['rcin_volume', 'rcout_volume'] },
    { key: 'combo',      label: 'Vol + Price',  seriesKeys: ['rcin_volume', 'rcout_volume', 'php_kg_in'] },
    { key: 'quality',    label: 'Quality',      seriesKeys: ['mc', 'ash', 'bd_astm'] },
  ],
  defaultPreset: 'trajectory',
  yAxisUnit: '\u20B1',
  yAxisUnitPos: 'prefix',
}
