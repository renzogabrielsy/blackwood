/* ===================================================
   KPI Strip Widget — TypeScript Types (Port / Data-Agnostic Interface)
   =================================================== */

export interface KPIThreshold {
  value: number
  status: 'good' | 'warning' | 'danger'
}

export interface KPIComparison {
  /** Pre-formatted delta string, e.g. "+₱1.74" */
  value: string
  /** Context label, e.g. "vs Jan" */
  label: string
  trend: 'up' | 'down' | 'neutral'
}

export interface KPIFlowData {
  /** Pre-formatted in-flow value, e.g. "1,132 T" */
  inValue: string
  /** Pre-formatted out-flow value, e.g. "546 T" */
  outValue: string
  /** Pre-formatted net value with sign, e.g. "+587 T" */
  netValue: string
}

/**
 * A single KPI chip. Pre-formatted by the adapter — the widget never
 * performs any data transformation.
 *
 * Chips with `value` set are **data chips** — rendered in all size tiers.
 * Chips with only `label` + `href` (no `value`) are **nav chips** — rendered
 * only in the lg/xl nav section on the right side.
 */
export interface KPIData {
  /** Display label, rendered uppercase + tracking-wider */
  label: string
  /** Primary display value, pre-formatted (e.g., "9,100 T", "+587 T", "48.46") */
  value?: string
  /** Unit prefix rendered before the value (e.g., "₱", "$") */
  prefix?: string
  /** Unit suffix rendered after the value (e.g., "T", "kg", "%") */
  suffix?: string
  /** Secondary sub-line, pre-formatted (e.g., "162 active batches") */
  sub?: string
  /** Colors the sub line: emerald-500 for up, red-500 for down, muted-foreground for neutral */
  subTrend?: 'up' | 'down' | 'neutral'
  /** If provided, the chip (or nav link) navigates to this path */
  href?: string
  /** Tailwind bg-* color class for the dot in the nav section (e.g., "bg-emerald-500") */
  accent?: string

  /**
   * Chip display variant — drives the rendering strategy.
   * - 'default': label + prefix/value/suffix + optional sub line (legacy behavior)
   * - 'flow': three-part in/out/net layout; requires `flowData`
   * - 'progress': thin progress bar between label and value; value parsed as %
   * - 'ratio': standard mono value display with threshold coloring
   */
  variant?: 'default' | 'flow' | 'progress' | 'ratio'

  /**
   * Ordered from highest threshold to lowest. The adapter pre-sorts these.
   * The widget walks the array and picks the first matching status color.
   */
  thresholds?: KPIThreshold[]

  /**
   * Sparkline data points (normalized by the widget). The adapter decides
   * the period/count — typically last 12 months.
   */
  sparkline?: number[]

  /** MoM or period-over-period comparison shown beneath the primary value */
  comparison?: KPIComparison

  /** Required when variant === 'flow'. Provides the three-part flow breakdown. */
  flowData?: KPIFlowData

  /** When true, chip is always shown at xs/sm tiers (pinned to compact view) */
  pinned?: boolean

  /** Wraps the entire chip in a Next.js Link */
  drilldown?: { href: string }
}

/**
 * Per-chip display overrides. Keyed by the chip's ORIGINAL label
 * (before any labelOverride is applied).
 */
export interface KPIChipOverride {
  /** Replaces chip.label in the display (original label is still used as the key) */
  labelOverride?: string
  /** Override the adapter's pinned flag for this chip */
  pinned?: boolean
  /** false = hide the comparison/sub line for this chip */
  showComparison?: boolean
  /** false = hide the sparkline for this chip */
  showSparkline?: boolean
}

export interface KPIStripSettings {
  /** Max chips before collapsing (default: show all) */
  maxVisible?: number
  /** Override auto-layout (default: auto by size tier) */
  layout?: 'horizontal' | 'grid'
  /** Labels of chips that are toggled off (hidden) */
  hidden?: string[]
  /** Labels in display order — unlisted chips append at the end */
  order?: string[]
  /**
   * Controls sub-line and sparkline visibility:
   * - 'auto': show when height tier is md+
   * - 'compact': always hide
   * - 'expanded': always show
   */
  chipMode?: 'auto' | 'compact' | 'expanded'
  /** The time window for live data fetches */
  period?: 'today' | 'week' | 'month' | 'quarter' | 'year'
  /**
   * Per-chip display overrides, keyed by the chip's ORIGINAL label.
   * Applied after adapter fills the port — widget only.
   */
  chipOverrides?: Record<string, KPIChipOverride>
}
