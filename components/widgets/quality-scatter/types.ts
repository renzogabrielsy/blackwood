/* ===================================================
   QualityScatterWidget — TypeScript Types (Port / Data-Agnostic Interface)
   =================================================== */

/**
 * A single data point in the quality scatter plot.
 * Pre-aggregated per time period by the adapter.
 */
export interface ScatterPoint {
  /** Weighted average PHP/KG for this period */
  phpKg: number
  /** Weighted average moisture content (%) */
  mc: number
  /** Weighted average ash content (%) */
  ash: number
  /** Human-readable period label, e.g. 'Feb 2026' */
  label: string
  /** Four-digit year string, used for color differentiation (e.g. '2026' = emerald, else blue) */
  year: string
}
