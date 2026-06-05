/* ===================================================
   WarehouseOccupancyWidget — TypeScript Types (Port / Data-Agnostic Interface)
   =================================================== */

/**
 * Data for a single warehouse occupancy bar.
 * Pre-aggregated by the adapter — the widget never performs aggregation.
 */
export interface WarehouseData {
  /** Single-letter warehouse label: 'A', 'B', 'C', 'D' */
  label: string
  /** Number of occupied slots (active batch count) */
  occupied: number
  /** Total physical slots in this warehouse (A=60, B=40, C=40, D=80) */
  total: number
  /** Weighted average cost per kg (PHP/KG) across all batches in this warehouse */
  phpKg: number
  /** Weighted average moisture content (%) */
  mc: number
  /** Weighted average ash content (%) */
  ash: number
}
