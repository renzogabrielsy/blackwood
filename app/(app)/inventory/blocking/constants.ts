export interface WarehouseConfig {
  /** Number of columns rendered in this section */
  cols: number;
  /** First column number (1 for standard warehouses, 15 for PCA/PCB) */
  colStart: number;
  /** Row letters for this warehouse */
  rows: string[];
}

/**
 * Warehouse layout for the Blocking grid.
 *
 * Standard warehouses (A/B/C/D): 220 slots total, the operator's mental baseline.
 * PCA/PCB: 18 additional slots in the A-15/16/17 area for prepared charcoal
 * sundrying. These are opt-in via filter chips and are NOT counted against the
 * 220-slot baseline by default.
 */
export const WAREHOUSES: Record<string, WarehouseConfig> = {
  A:   { cols: 20, colStart: 1,  rows: ['A', 'B', 'C'] },
  B:   { cols: 20, colStart: 1,  rows: ['A', 'B'] },
  C:   { cols: 20, colStart: 1,  rows: ['A', 'B'] },
  D:   { cols: 20, colStart: 1,  rows: ['A', 'B', 'C', 'D'] },
  PCA: { cols: 3,  colStart: 15, rows: ['A', 'B', 'C'] },
  PCB: { cols: 3,  colStart: 15, rows: ['A', 'B', 'C'] },
};

/** The standard 4 warehouses — what the "ALL" filter resets to. PCA/PCB stay opt-in. */
export const STANDARD_WAREHOUSES = ['A', 'B', 'C', 'D'] as const;
