/* ===================================================
   KPI Strip Widget — Chip Variant Renderers
   Pure presentational components: no hooks, no state,
   no imports from Supabase or any data source.
   =================================================== */

import type { KPIData, KPIComparison, KPIThreshold } from './types'

/* ===================================================
   Threshold color helper
   =================================================== */

/**
 * Walk the adapter-sorted threshold list (highest first) and return the
 * first Tailwind text color class whose threshold the numeric value meets.
 */
export function getThresholdColor(
  thresholds: KPIThreshold[] | undefined,
  rawValue: string | undefined,
): string | undefined {
  if (!thresholds || !rawValue) return undefined
  // Strip all non-numeric chars except period and minus sign
  const numericValue = parseFloat(rawValue.replace(/[^0-9.-]/g, ''))
  if (isNaN(numericValue)) return undefined
  for (const t of thresholds) {
    if (numericValue >= t.value) {
      if (t.status === 'good') return 'text-emerald-500'
      if (t.status === 'warning') return 'text-amber-500'
      return 'text-red-500'
    }
  }
  return undefined
}

/* ===================================================
   Sparkline — pure SVG, 40×14px
   =================================================== */

interface SparklineProps {
  values: number[]
  thresholdColor?: string
}

export function Sparkline({ values, thresholdColor }: SparklineProps) {
  if (!values || values.length < 2) return null

  const WIDTH = 40
  const HEIGHT = 14
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min === 0 ? 1 : max - min

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * WIDTH
      const y = HEIGHT - ((v - min) / range) * HEIGHT
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const strokeClass = thresholdColor
    ? thresholdColor.replace('text-', 'stroke-')
    : 'stroke-muted-foreground/50'

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${strokeClass}`}
    >
      <polyline points={points} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* ===================================================
   ComparisonLine — trend arrow + formatted delta
   =================================================== */

interface ComparisonLineProps {
  comparison: KPIComparison
}

export function ComparisonLine({ comparison }: ComparisonLineProps) {
  const colorClass =
    comparison.trend === 'up'
      ? 'text-emerald-500'
      : comparison.trend === 'down'
        ? 'text-red-500'
        : 'text-muted-foreground'

  const arrow =
    comparison.trend === 'up' ? '↑' : comparison.trend === 'down' ? '↓' : '—'

  return (
    <span className={`text-[10px] font-mono ${colorClass}`}>
      {arrow} {comparison.value}{' '}
      <span className="text-muted-foreground">{comparison.label}</span>
    </span>
  )
}

/* ===================================================
   FlowChip — three-part in/out/net layout
   =================================================== */

interface FlowChipProps {
  chip: KPIData
}

export function FlowChip({ chip }: FlowChipProps) {
  const { flowData } = chip
  if (!flowData) return null

  const netIsPositive = flowData.netValue.startsWith('+')
  const netIsNegative = flowData.netValue.startsWith('-')
  const netColor = netIsPositive
    ? 'text-emerald-500'
    : netIsNegative
      ? 'text-red-500'
      : 'text-foreground'

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {chip.label}
      </span>
      <div className="flex items-center gap-1.5 text-[11px] font-mono">
        <span className="text-foreground">{flowData.inValue}</span>
        <span className="text-muted-foreground/50">in</span>
        <span className="text-muted-foreground/30">·</span>
        <span className="text-foreground">{flowData.outValue}</span>
        <span className="text-muted-foreground/50">out</span>
        <span className="text-muted-foreground/30">·</span>
        <span className={`font-semibold ${netColor}`}>{flowData.netValue}</span>
      </div>
    </div>
  )
}

/* ===================================================
   ProgressChip — label + thin bar + value
   =================================================== */

interface ProgressChipProps {
  chip: KPIData
  thresholdColor?: string
}

export function ProgressChip({ chip, thresholdColor }: ProgressChipProps) {
  // Parse numeric percentage from value string, e.g. "154/220 (70%)" → 70
  const match = chip.value?.match(/\((\d+(?:\.\d+)?)%\)/) ?? chip.value?.match(/(\d+(?:\.\d+)?)%/)
  const pct = match ? Math.min(100, Math.max(0, parseFloat(match[1]))) : 0

  const barFillClass = thresholdColor
    ? thresholdColor.replace('text-', 'bg-')
    : 'bg-primary'

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {chip.label}
      </span>
      <div className="w-full h-[3px] bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barFillClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-sm font-mono font-semibold ${thresholdColor ?? 'text-foreground'}`}>
        {chip.value}
      </span>
    </div>
  )
}

/* ===================================================
   RatioChip — label + mono value with threshold coloring
   =================================================== */

interface RatioChipProps {
  chip: KPIData
  thresholdColor?: string
}

export function RatioChip({ chip, thresholdColor }: RatioChipProps) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {chip.label}
      </span>
      <span className={`text-sm font-mono font-semibold flex items-center gap-1 ${thresholdColor ?? 'text-foreground'}`}>
        {chip.prefix && <span className="text-muted-foreground">{chip.prefix}</span>}
        {chip.value}
        {chip.suffix && <span className="text-muted-foreground">{chip.suffix}</span>}
      </span>
    </div>
  )
}

/* ===================================================
   DefaultChip — label + prefix/value/suffix + optional sub/sparkline/comparison
   Extended from the original KPIChip; threshold-colored value text.
   =================================================== */

interface DefaultChipProps {
  chip: KPIData
  showSub?: boolean
  showSparkline?: boolean
  thresholdColor?: string
}

export function DefaultChip({
  chip,
  showSub = true,
  showSparkline = true,
  thresholdColor,
}: DefaultChipProps) {
  const subClass =
    chip.subTrend === 'up'
      ? 'text-[10px] text-emerald-500'
      : chip.subTrend === 'down'
        ? 'text-[10px] text-red-500'
        : 'text-[10px] text-muted-foreground'

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {chip.label}
      </span>
      <div className="flex items-center gap-2">
        <span className={`text-sm font-mono font-semibold flex items-center gap-1 ${thresholdColor ?? 'text-foreground'}`}>
          {chip.prefix && <span className="text-muted-foreground">{chip.prefix}</span>}
          {chip.value}
          {chip.suffix && <span className="text-muted-foreground">{chip.suffix}</span>}
        </span>
        {showSparkline && chip.sparkline && chip.sparkline.length >= 2 && (
          <Sparkline values={chip.sparkline} thresholdColor={thresholdColor} />
        )}
      </div>
      {showSub && chip.comparison && (
        <ComparisonLine comparison={chip.comparison} />
      )}
      {showSub && chip.sub && !chip.comparison && (
        <span className={subClass}>{chip.sub}</span>
      )}
    </div>
  )
}
