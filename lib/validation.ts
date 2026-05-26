/**
 * Shared validation utilities for Blackwood.
 *
 * Block location format: {WHSE}-{COL}{ROW}
 *   WHSE = A | B | C | D | F | PCA | PCB
 *   COL  = warehouse-dependent (see WAREHOUSE_COLS)
 *   ROW  = warehouse-dependent (see WAREHOUSE_ROWS)
 *
 * Warehouse row/column limits mirror the physical warehouse grid:
 *   A:   cols 1-20,  rows A-C  (3 rows, 60 slots)
 *   B:   cols 1-20,  rows A-B  (2 rows, 40 slots)
 *   C:   cols 1-20,  rows A-B  (2 rows, 40 slots)
 *   D:   cols 1-20,  rows A-D  (4 rows, 80 slots)
 *   F:   cols 1-20,  rows A-D  (FEED warehouse)
 *   PCA: cols 15-17, rows A-C  (3 rows, 9 slots — prepared charcoal sundrying)
 *   PCB: cols 15-17, rows A-C  (3 rows, 9 slots — prepared charcoal sundrying)
 *
 * PCA and PCB are physical subdivisions of the A-15/16/17 area used for
 * prepared charcoal ("PC") sundrying.
 */

export type BlockLocValidation =
  | { valid: true }
  | { valid: false; error: string };

/** Valid rows per warehouse */
const WAREHOUSE_ROWS: Record<string, string[]> = {
  A: ['A', 'B', 'C'],
  B: ['A', 'B'],
  C: ['A', 'B'],
  D: ['A', 'B', 'C', 'D'],
  F: ['A', 'B', 'C', 'D'],
  PCA: ['A', 'B', 'C'],
  PCB: ['A', 'B', 'C'],
};

/** Valid column range [min, max] per warehouse */
const WAREHOUSE_COLS: Record<string, [number, number]> = {
  A: [1, 20],
  B: [1, 20],
  C: [1, 20],
  D: [1, 20],
  F: [1, 20],
  PCA: [15, 17],
  PCB: [15, 17],
};

/** Regex: warehouse prefix (PCA/PCB or single letter A-D/F), dash, 1-2 digit column, row letter */
const BLOCK_LOC_REGEX = /^(PCA|PCB|[A-DF])-(\d{1,2})([A-D])$/;

/**
 * Validates a block location string against the physical warehouse grid.
 *
 * @param loc - The block location string (e.g. "A-1A", "D-20D", "F-3B", "PCA-15A")
 * @returns `{ valid: true }` or `{ valid: false, error: string }`
 */
export function validateBlockLoc(loc: string): BlockLocValidation {
  const trimmed = loc.trim().toUpperCase();

  const match = trimmed.match(BLOCK_LOC_REGEX);
  if (!match) {
    return {
      valid: false,
      error: `"${loc}" does not match block location format (expected {WHSE}-{COL}{ROW}, e.g. A-1A, D-20D, PCA-15A)`,
    };
  }

  const whse = match[1];
  const col = parseInt(match[2], 10);
  const row = match[3];

  // Validate warehouse is one we recognize
  const allowedRows = WAREHOUSE_ROWS[whse];
  const allowedCols = WAREHOUSE_COLS[whse];
  if (!allowedRows || !allowedCols) {
    return {
      valid: false,
      error: `"${loc}" has invalid warehouse "${whse}" (expected A, B, C, D, F, PCA, or PCB)`,
    };
  }

  // Validate column range for this warehouse
  const [minCol, maxCol] = allowedCols;
  if (col < minCol || col > maxCol) {
    return {
      valid: false,
      error: `"${loc}" has column ${col} out of range for warehouse ${whse} (expected ${minCol}-${maxCol})`,
    };
  }

  // Validate row is allowed for this warehouse
  if (!allowedRows.includes(row)) {
    const maxRow = allowedRows[allowedRows.length - 1];
    return {
      valid: false,
      error: `"${loc}" has row ${row} which is invalid for warehouse ${whse} (expected A-${maxRow})`,
    };
  }

  return { valid: true };
}

/**
 * Trims and uppercases a block location string for canonical form.
 * Use before inserting into the DB or passing to validateBlockLoc.
 */
export function normalizeBlockLoc(loc: string): string {
  return loc.trim().toUpperCase();
}
