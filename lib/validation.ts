/**
 * Shared validation utilities for Blackwood.
 *
 * Block location format: {WHSE}-{COL}{ROW}
 *   WHSE = A | B | C | D | F
 *   COL  = 1-20
 *   ROW  = A-D (warehouse-dependent)
 *
 * Warehouse row limits mirror the physical warehouse grid:
 *   A: rows A-C  (3 rows, 60 slots)
 *   B: rows A-B  (2 rows, 40 slots)
 *   C: rows A-B  (2 rows, 40 slots)
 *   D: rows A-D  (4 rows, 80 slots)
 *   F: rows A-D  (4 rows, FEED warehouse)
 */

export type BlockLocValidation =
  | { valid: true }
  | { valid: false; error: string };

/** Valid rows per warehouse letter */
const WAREHOUSE_ROWS: Record<string, string[]> = {
  A: ['A', 'B', 'C'],
  B: ['A', 'B'],
  C: ['A', 'B'],
  D: ['A', 'B', 'C', 'D'],
  F: ['A', 'B', 'C', 'D'],
};

/** Regex: warehouse letter, dash, 1-2 digit column, row letter */
const BLOCK_LOC_REGEX = /^[A-DF]-(\d{1,2})([A-D])$/;

/**
 * Validates a block location string against the physical warehouse grid.
 *
 * @param loc - The block location string (e.g. "A-1A", "D-20D", "F-3B")
 * @returns `{ valid: true }` or `{ valid: false, error: string }`
 */
export function validateBlockLoc(loc: string): BlockLocValidation {
  const trimmed = loc.trim().toUpperCase();

  const match = trimmed.match(BLOCK_LOC_REGEX);
  if (!match) {
    return {
      valid: false,
      error: `"${loc}" does not match block location format (expected {WHSE}-{COL}{ROW}, e.g. A-1A, D-20D)`,
    };
  }

  const whse = trimmed[0];
  const col = parseInt(match[1], 10);
  const row = match[2];

  // Validate warehouse letter is one we recognize
  const allowedRows = WAREHOUSE_ROWS[whse];
  if (!allowedRows) {
    return {
      valid: false,
      error: `"${loc}" has invalid warehouse "${whse}" (expected A, B, C, D, or F)`,
    };
  }

  // Validate column range 1-20
  if (col < 1 || col > 20) {
    return {
      valid: false,
      error: `"${loc}" has column ${col} out of range (expected 1-20)`,
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
