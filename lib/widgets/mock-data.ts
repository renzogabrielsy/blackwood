import type {
  LedgerQuarter,
  LedgerYear,
  UsageQuarter,
  UsageYear,
  ChartConfig,
  FiscalCalEntry,
} from '@/components/widgets/chart/types'
import type { KPIData } from '@/components/widgets/kpi-strip/types'
import type { WarehouseData } from '@/components/widgets/warehouse-occupancy/types'
import type { ScatterPoint } from '@/components/widgets/quality-scatter/types'

/* ===================================================
   Fiscal / Calendar Mapping
   =================================================== */

export const PIVOT_MONTHS = ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb']

export const FISCAL_TO_CALENDAR = [
  { fiscalIdx: 0,  calMonth: 'Mar', calIdx: 2,  year: '2025' },
  { fiscalIdx: 1,  calMonth: 'Apr', calIdx: 3,  year: '2025' },
  { fiscalIdx: 2,  calMonth: 'May', calIdx: 4,  year: '2025' },
  { fiscalIdx: 3,  calMonth: 'Jun', calIdx: 5,  year: '2025' },
  { fiscalIdx: 4,  calMonth: 'Jul', calIdx: 6,  year: '2025' },
  { fiscalIdx: 5,  calMonth: 'Aug', calIdx: 7,  year: '2025' },
  { fiscalIdx: 6,  calMonth: 'Sep', calIdx: 8,  year: '2025' },
  { fiscalIdx: 7,  calMonth: 'Oct', calIdx: 9,  year: '2025' },
  { fiscalIdx: 8,  calMonth: 'Nov', calIdx: 10, year: '2025' },
  { fiscalIdx: 9,  calMonth: 'Dec', calIdx: 11, year: '2025' },
  { fiscalIdx: 10, calMonth: 'Jan', calIdx: 0,  year: '2026' },
  { fiscalIdx: 11, calMonth: 'Feb', calIdx: 1,  year: '2026' },
]

export const CAL_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
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
export const CURRENT_YEAR = new Date().getFullYear().toString()
export const DATA_YEARS = [...new Set(FISCAL_TO_CALENDAR.map(m => m.year))].sort()

/* ===================================================
   Static Ledger Data (RC IN)
   =================================================== */

export const LEDGER: LedgerQuarter[] = [
  {
    quarter: 'Q1 2026 YTD', weightT: 2637.6, phpKg: 47.99, deltaQoQ: 5.2, mc: 10.87, ash: 3.56, bdAstm: 0.571,
    months: [
      { label: 'Feb 2026', weightT: 1132.2, phpKg: 48.46, momDelta: 0.82, momPct: 1.7, mc: 10.38, ash: 3.53, bdAstm: 0.569, bdJis: 0.571, grit: 0.12, vm: 8.4, fc: 78.2 },
      { label: 'Jan 2026', weightT: 1505.4, phpKg: 47.64, momDelta: 1.28, momPct: 2.8, mc: 11.48, ash: 3.60, bdAstm: 0.574, bdJis: 0.576, grit: 0.14, vm: 8.6, fc: 77.8 },
    ]
  },
  {
    quarter: 'Q4 2025', weightT: 4219.4, phpKg: 45.27, deltaQoQ: 3.5, mc: 12.05, ash: 3.63, bdAstm: 0.573,
    months: [
      { label: 'Dec 2025', weightT: 1202.1, phpKg: 46.36, momDelta: 1.43, momPct: 3.2, mc: 11.82, ash: 3.42, bdAstm: 0.573, bdJis: 0.575, grit: 0.11, vm: 8.3, fc: 78.5 },
      { label: 'Nov 2025', weightT: 1290.0, phpKg: 44.93, momDelta: 0.17, momPct: 0.4, mc: 12.11, ash: 3.45, bdAstm: 0.573, bdJis: 0.574, grit: 0.13, vm: 8.5, fc: 78.0 },
      { label: 'Oct 2025', weightT: 1727.3, phpKg: 44.76, momDelta: null, momPct: null, mc: 12.23, ash: 3.82, bdAstm: 0.573, bdJis: 0.574, grit: 0.15, vm: 8.7, fc: 77.5 },
    ]
  },
  {
    quarter: 'Q3 2025', weightT: 3027.9, phpKg: 43.55, deltaQoQ: 30.8, mc: 11.02, ash: 4.64, bdAstm: 0.592,
    months: [
      { label: 'Sep 2025', weightT: 1081.4, phpKg: 44.92, momDelta: 0.58, momPct: 1.3, mc: 11.36, ash: 4.01, bdAstm: 0.572, bdJis: 0.574, grit: 0.16, vm: 8.8, fc: 77.2 },
      { label: 'Aug 2025', weightT: 1272.0, phpKg: 44.34, momDelta: 4.47, momPct: 11.2, mc: 10.98, ash: 4.15, bdAstm: 0.570, bdJis: 0.572, grit: 0.18, vm: 9.0, fc: 76.8 },
      { label: 'Jul 2025', weightT: 674.5, phpKg: 39.87, momDelta: null, momPct: null, mc: 10.73, ash: 3.77, bdAstm: 0.563, bdJis: 0.565, grit: 0.14, vm: 8.5, fc: 78.1 },
    ]
  },
  {
    quarter: 'Q2 2025', weightT: 2221.6, phpKg: 33.32, deltaQoQ: 26.4, mc: 11.44, ash: 4.16, bdAstm: 0.574,
    months: [
      { label: 'Jun 2025', weightT: 756.4, phpKg: 35.89, momDelta: 3.09, momPct: 9.4, mc: 11.79, ash: 5.88, bdAstm: 0.643, bdJis: 0.645, grit: 0.20, vm: 9.2, fc: 75.9 },
      { label: 'May 2025', weightT: 722.3, phpKg: 32.80, momDelta: 1.59, momPct: 5.1, mc: 11.46, ash: 3.56, bdAstm: 0.574, bdJis: 0.576, grit: 0.13, vm: 8.4, fc: 78.3 },
      { label: 'Apr 2025', weightT: 745.1, phpKg: 31.21, momDelta: null, momPct: null, mc: 11.08, ash: 3.92, bdAstm: 0.574, bdJis: 0.576, grit: 0.15, vm: 8.6, fc: 77.7 },
    ]
  },
  {
    quarter: 'Q1 2025', weightT: 2291.4, phpKg: 26.36, deltaQoQ: 12.4, mc: 11.54, ash: 3.97, bdAstm: 0.573,
    months: [
      { label: 'Mar 2025', weightT: 857.3, phpKg: 28.29, momDelta: null, momPct: null, mc: 12.00, ash: 4.01, bdAstm: 0.573, bdJis: 0.575, grit: 0.17, vm: 8.9, fc: 76.5 },
    ]
  },
]

export const USAGE_LEDGER: UsageQuarter[] = [
  {
    quarter: 'Q1 2026 YTD', usageT: 1417.7, phpKg: 45.50, netT: 1219.9, deltaQoQ: null,
    months: [
      { label: 'Feb 2026', usageT: 545.6, phpKg: 45.80, netT: 586.6, momDelta: 0.60, momPct: 1.3 },
      { label: 'Jan 2026', usageT: 872.1, phpKg: 45.20, netT: 633.3, momDelta: 0.70, momPct: 1.6 },
    ]
  },
  {
    quarter: 'Q4 2025', usageT: 1967.5, phpKg: 44.23, netT: 2251.9, deltaQoQ: 6.8,
    months: [
      { label: 'Dec 2025', usageT: 869.4, phpKg: 44.50, netT: 332.7, momDelta: 0.20, momPct: 0.5 },
      { label: 'Nov 2025', usageT: 420.3, phpKg: 44.30, netT: 869.7, momDelta: 0.40, momPct: 0.9 },
      { label: 'Oct 2025', usageT: 677.8, phpKg: 43.90, netT: 1049.5, momDelta: null, momPct: null },
    ]
  },
  {
    quarter: 'Q3 2025', usageT: 2488.6, phpKg: 41.43, netT: 539.3, deltaQoQ: 29.6,
    months: [
      { label: 'Sep 2025', usageT: 821.2, phpKg: 43.70, netT: 260.2, momDelta: 1.60, momPct: 3.8 },
      { label: 'Aug 2025', usageT: 803.7, phpKg: 42.10, netT: 468.3, momDelta: 3.60, momPct: 9.4 },
      { label: 'Jul 2025', usageT: 896.1, phpKg: 38.50, netT: -221.6, momDelta: null, momPct: null },
    ]
  },
  {
    quarter: 'Q2 2025', usageT: 2318.6, phpKg: 31.97, netT: -97.0, deltaQoQ: 11.0,
    months: [
      { label: 'Jun 2025', usageT: 769.3, phpKg: 34.20, netT: -12.9, momDelta: 2.70, momPct: 8.6 },
      { label: 'May 2025', usageT: 896.2, phpKg: 31.50, netT: -173.9, momDelta: 1.10, momPct: 3.6 },
      { label: 'Apr 2025', usageT: 723.1, phpKg: 30.40, netT: 22.0, momDelta: null, momPct: null },
    ]
  },
  {
    quarter: 'Q1 2025', usageT: 1706.0, phpKg: 28.80, netT: 585.4, deltaQoQ: null,
    months: [
      { label: 'Mar 2025', usageT: 706.5, phpKg: 28.80, netT: 150.8, momDelta: null, momPct: null },
    ]
  },
]

/* ===================================================
   Year Grouping Helpers
   =================================================== */

export function groupByYear(quarters: LedgerQuarter[]): LedgerYear[] {
  const yearMap = new Map<string, LedgerQuarter[]>()
  for (const q of quarters) {
    const match = q.quarter.match(/(\d{4})/)
    const year = match ? match[1] : 'Unknown'
    if (!yearMap.has(year)) yearMap.set(year, [])
    yearMap.get(year)!.push(q)
  }
  return Array.from(yearMap.entries())
    .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
    .map(([year, quarters]) => ({ year, quarters }))
}

export function groupUsageByYear(quarters: UsageQuarter[]): UsageYear[] {
  const yearMap = new Map<string, UsageQuarter[]>()
  for (const q of quarters) {
    const match = q.quarter.match(/(\d{4})/)
    const year = match ? match[1] : 'Unknown'
    if (!yearMap.has(year)) yearMap.set(year, [])
    yearMap.get(year)!.push(q)
  }
  return Array.from(yearMap.entries())
    .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
    .map(([year, quarters]) => ({ year, quarters }))
}

export const LEDGER_BY_YEAR: LedgerYear[] = groupByYear(LEDGER)
export const USAGE_BY_YEAR: UsageYear[] = groupUsageByYear(USAGE_LEDGER)

/* ===================================================
   Warehouse Data
   =================================================== */

export const WAREHOUSE_LIST = [
  { label: 'A', occupied: 46, total: 60, phpKg: 46.80, mc: 10.8, ash: 3.6 },
  { label: 'B', occupied: 34, total: 40, phpKg: 48.20, mc: 11.2, ash: 3.5 },
  { label: 'C', occupied: 33, total: 40, phpKg: 47.50, mc: 10.9, ash: 3.7 },
  { label: 'D', occupied: 41, total: 80, phpKg: 45.90, mc: 11.5, ash: 3.8 },
]

/** Typed static fallback for WarehouseOccupancyWidget adapter */
export const CHARCOAL_WAREHOUSE_DATA: WarehouseData[] = WAREHOUSE_LIST

/** Typed static fallback for QualityScatterWidget adapter */
export const CHARCOAL_SCATTER_DATA: ScatterPoint[] = LEDGER.flatMap(q =>
  q.months.map(m => ({
    phpKg: m.phpKg,
    mc: m.mc,
    ash: m.ash,
    label: m.label,
    year: m.label.split(' ')[1] ?? '2025',
  }))
)

/* ===================================================
   Pivot Matrix Data
   =================================================== */

export interface PivotRow {
  metric: string
  values: (number | null)[]
  format: 'weight' | 'price' | 'pct' | 'decimal'
}

export const PIVOT_DATA: PivotRow[] = [
  { metric: 'RC IN (T)', values: [857.3, 745.1, 722.3, 756.4, 674.5, 1272.0, 1081.4, 1727.3, 1290.0, 1202.1, 1505.4, 1132.2], format: 'weight' },
  { metric: 'RC OUT (T)', values: [706.5, 723.1, 896.2, 769.3, 896.1, 803.7, 821.2, 677.8, 420.3, 869.4, 872.1, 545.6], format: 'weight' },
  { metric: 'Net Stock (T)', values: [150.8, 22.0, -173.9, -12.9, -221.6, 468.3, 260.2, 1049.5, 869.7, 332.7, 633.3, 586.6], format: 'weight' },
  { metric: 'PHP/KG (In)', values: [28.29, 31.21, 32.80, 35.89, 39.87, 44.34, 44.92, 44.76, 44.93, 46.36, 47.64, 48.46], format: 'price' },
  { metric: 'PHP/KG (Out)', values: [28.80, 30.40, 31.50, 34.20, 38.50, 42.10, 43.70, 43.90, 44.30, 44.50, 45.20, 45.80], format: 'price' },
  { metric: 'MoM %', values: [null, null, 5.1, 9.4, 11.1, 11.2, 1.3, -0.4, 0.4, 3.2, 2.8, 1.7], format: 'pct' },
  { metric: 'MC', values: [12.00, 11.08, 11.46, 11.79, 10.73, 10.98, 11.36, 12.23, 12.11, 11.82, 11.48, 10.38], format: 'decimal' },
  { metric: 'ASH', values: [4.01, 3.92, 3.56, 5.88, 3.77, 4.15, 4.01, 3.82, 3.45, 3.42, 3.60, 3.53], format: 'decimal' },
  { metric: 'BD ASTM', values: [0.573, 0.574, 0.574, 0.643, 0.563, 0.570, 0.572, 0.573, 0.573, 0.573, 0.574, 0.569], format: 'decimal' },
]

/* ===================================================
   Charcoal Universal Chart Config
   =================================================== */

/**
 * Static calendar for the mock data (Mar 2025 – Feb 2026).
 * x values 0–11 correspond to the 12 chronological months.
 * fiscalYear = plain calendar year string ('2025' or '2026').
 * fiscalMonth = calIdx = calendar month (Jan=0, Dec=11).
 */
const STATIC_FISCAL_CALENDAR: FiscalCalEntry[] = [
  { x:  0, calIdx:  2, fiscalYear: '2025', fiscalMonth:  2, label: 'Mar 2025' },
  { x:  1, calIdx:  3, fiscalYear: '2025', fiscalMonth:  3, label: 'Apr 2025' },
  { x:  2, calIdx:  4, fiscalYear: '2025', fiscalMonth:  4, label: 'May 2025' },
  { x:  3, calIdx:  5, fiscalYear: '2025', fiscalMonth:  5, label: 'Jun 2025' },
  { x:  4, calIdx:  6, fiscalYear: '2025', fiscalMonth:  6, label: 'Jul 2025' },
  { x:  5, calIdx:  7, fiscalYear: '2025', fiscalMonth:  7, label: 'Aug 2025' },
  { x:  6, calIdx:  8, fiscalYear: '2025', fiscalMonth:  8, label: 'Sep 2025' },
  { x:  7, calIdx:  9, fiscalYear: '2025', fiscalMonth:  9, label: 'Oct 2025' },
  { x:  8, calIdx: 10, fiscalYear: '2025', fiscalMonth: 10, label: 'Nov 2025' },
  { x:  9, calIdx: 11, fiscalYear: '2025', fiscalMonth: 11, label: 'Dec 2025' },
  { x: 10, calIdx:  0, fiscalYear: '2026', fiscalMonth:  0, label: 'Jan 2026' },
  { x: 11, calIdx:  1, fiscalYear: '2026', fiscalMonth:  1, label: 'Feb 2026' },
]

export const CHARCOAL_UNIVERSAL_CONFIG: ChartConfig = {
  xAxis: {
    labels: STATIC_FISCAL_CALENDAR.map(e => e.label),
    showQuarterBoundaries: false,
    quarterBoundaryPositions: [],
  },
  yAxis: { unit: '\u20B1', unitPos: 'prefix' },
  seriesGroups: [
    { key: 'price',   label: 'Price',   unit: '\u20B1', unitPos: 'prefix' },
    { key: 'volume',  label: 'Volume',  unit: 'T', unitPos: 'suffix' },
    { key: 'quality', label: 'Quality', unit: '',  unitPos: 'suffix' },
    { key: 'ratio',   label: 'Ratio',   unit: '%', unitPos: 'suffix' },
    { key: 'change',  label: 'Change',  unit: '%', unitPos: 'suffix' },
  ],
  series: [
    // Price group
    {
      key: 'php_kg_in', label: 'PHP/KG In', color: '#60a5fa', style: 'area', group: 'price',
      points: [
        {x:0,value:28.29},{x:1,value:31.21},{x:2,value:32.80},{x:3,value:35.89},
        {x:4,value:39.87},{x:5,value:44.34},{x:6,value:44.92},{x:7,value:44.76},
        {x:8,value:44.93},{x:9,value:46.36},{x:10,value:47.64},{x:11,value:48.46},
      ],
    },
    {
      key: 'php_kg_out', label: 'PHP/KG Out', color: '#a78bfa', style: 'dashed', group: 'price',
      points: [
        {x:0,value:28.80},{x:1,value:30.40},{x:2,value:31.50},{x:3,value:34.20},
        {x:4,value:38.50},{x:5,value:42.10},{x:6,value:43.70},{x:7,value:43.90},
        {x:8,value:44.30},{x:9,value:44.50},{x:10,value:45.20},{x:11,value:45.80},
      ],
    },
    // Volume group
    {
      key: 'rcin_volume', label: 'RC IN (T)', color: '#34d399', style: 'bar', group: 'volume',
      points: [
        {x:0,value:857.3},{x:1,value:745.1},{x:2,value:722.3},{x:3,value:756.4},
        {x:4,value:674.5},{x:5,value:1272.0},{x:6,value:1081.4},{x:7,value:1727.3},
        {x:8,value:1290.0},{x:9,value:1202.1},{x:10,value:1505.4},{x:11,value:1132.2},
      ],
    },
    {
      key: 'rcout_volume', label: 'RC OUT (T)', color: '#f87171', style: 'bar', group: 'volume',
      points: [
        {x:0,value:706.5},{x:1,value:723.1},{x:2,value:896.2},{x:3,value:769.3},
        {x:4,value:896.1},{x:5,value:803.7},{x:6,value:821.2},{x:7,value:677.8},
        {x:8,value:420.3},{x:9,value:869.4},{x:10,value:872.1},{x:11,value:545.6},
      ],
    },
    {
      key: 'net_stock', label: 'Net Stock (T)', color: '#10b981', style: 'line', group: 'volume',
      points: [
        {x:0,value:150.8},{x:1,value:22.0},{x:2,value:-173.9},{x:3,value:-12.9},
        {x:4,value:-221.6},{x:5,value:468.3},{x:6,value:260.2},{x:7,value:1049.5},
        {x:8,value:869.7},{x:9,value:332.7},{x:10,value:633.3},{x:11,value:586.6},
      ],
    },
    // Change group
    {
      key: 'mom_pct', label: 'MoM %', color: '#f472b6', style: 'line', group: 'change',
      points: [
        {x:1,value:10.32},{x:2,value:5.09},{x:3,value:9.42},{x:4,value:11.09},
        {x:5,value:11.21},{x:6,value:1.31},{x:7,value:-0.36},{x:8,value:0.38},{x:9,value:3.18},
        {x:10,value:2.76},{x:11,value:1.72},
      ],
    },
    // Quality group
    {
      key: 'mc', label: 'MC', color: '#22d3ee', style: 'line', group: 'quality',
      points: [
        {x:0,value:12.00},{x:1,value:11.08},{x:2,value:11.46},{x:3,value:11.79},
        {x:4,value:10.73},{x:5,value:10.98},{x:6,value:11.36},{x:7,value:12.23},
        {x:8,value:12.11},{x:9,value:11.82},{x:10,value:11.48},{x:11,value:10.38},
      ],
    },
    {
      key: 'ash', label: 'ASH', color: '#fb923c', style: 'line', group: 'quality',
      points: [
        {x:0,value:4.01},{x:1,value:3.92},{x:2,value:3.56},{x:3,value:5.88},
        {x:4,value:3.77},{x:5,value:4.15},{x:6,value:4.01},{x:7,value:3.82},
        {x:8,value:3.45},{x:9,value:3.42},{x:10,value:3.60},{x:11,value:3.53},
      ],
    },
    {
      key: 'bd_astm', label: 'BD ASTM', color: '#c084fc', style: 'line', group: 'quality',
      points: [
        {x:0,value:0.573},{x:1,value:0.574},{x:2,value:0.574},{x:3,value:0.643},
        {x:4,value:0.563},{x:5,value:0.570},{x:6,value:0.572},{x:7,value:0.573},
        {x:8,value:0.573},{x:9,value:0.573},{x:10,value:0.574},{x:11,value:0.569},
      ],
    },
  ],
  presets: [
    { key: 'trajectory', label: 'Trajectory',   seriesKeys: ['php_kg_in'] },
    { key: 'spread',     label: 'Price Spread', seriesKeys: ['php_kg_in', 'php_kg_out'] },
    { key: 'volume',     label: 'Volume',        seriesKeys: ['rcin_volume', 'rcout_volume'] },
    { key: 'combo',      label: 'Vol + Price',   seriesKeys: ['rcin_volume', 'rcout_volume', 'php_kg_in'] },
    { key: 'quality',    label: 'Quality',       seriesKeys: ['mc', 'ash', 'bd_astm'] },
  ],
  defaultPreset: 'trajectory',
  fiscalCalendar: STATIC_FISCAL_CALENDAR,
  dataYears: ['2025', '2026'],
}

/* ===================================================
   Charcoal KPI Strip Data
   =================================================== */

export const CHARCOAL_KPI_DATA: KPIData[] = [
  {
    label: 'Total Inventory',
    value: '9,100 T',
    sub: '162 active batches',
    pinned: true,
  },
  {
    label: 'Warehouse',
    value: '154/220 (70%)',
    variant: 'progress',
    thresholds: [
      { value: 85, status: 'danger' },
      { value: 70, status: 'warning' },
      { value: 0, status: 'good' },
    ],
    drilldown: { href: '/inventory' },
  },
  {
    label: 'Current PHP/KG',
    value: '48.46',
    prefix: '₱',
    pinned: true,
    sparkline: [44.2, 45.1, 44.8, 46.3, 46.72, 47.1, 47.64, 47.82, 48.46, 48.20, 47.90, 48.46],
    comparison: {
      value: '+₱1.74',
      label: 'vs Jan',
      trend: 'up',
    },
  },
  {
    label: 'Feb Flow',
    value: '+587 T',
    variant: 'flow',
    flowData: {
      inValue: '1,132 T',
      outValue: '546 T',
      netValue: '+587 T',
    },
    drilldown: { href: '/inventory' },
  },
]
