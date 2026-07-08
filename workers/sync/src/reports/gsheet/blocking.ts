/**
 * blocking.ts — extractor for the Google Sheet **Blocking** tab (RB phase of the
 * Sync Reconciliation Model; `SYNC_RECONCILIATION_MODEL.md` → phase RB, Refinement 2).
 *
 * The daily sync has ALWAYS downloaded this workbook, but this tab was never read (the
 * Sheet's Blocking grid is the operator's hand-kept block ledger). RB turns it into a
 * first-class SOURCE so it can be cross-checked, per-block and in total, against the
 * app's COMPUTED `view_blocking_grid` (balance = ΣRC_IN − ΣRC_OUT). It is the one net
 * anchored OUTSIDE the transaction data — it would have caught L-037 from a different
 * angle (a block's operator balance vs the DB-derived balance).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REAL TAB STRUCTURE (investigated 2026-07-08 against the live Sheet — the tab is
 * "Blocking", 971 rows × 33 cols). It is a 2-D VISUAL GRID mirroring the physical
 * warehouse, NOT a flat table:
 *
 *   - Grand total: col A ("INVENTORY TONS") carries the whole-inventory total in TONS
 *     (e.g. 10289.082) a few rows down — the first numeric cell in col 1. ×1000 = kg.
 *   - The grid is a stack of BANDS, one per physical warehouse ROW (WHSE A rows A/B/C,
 *     B rows A/B, C rows A/B, D rows A/B/C/D → 11 bands). Each band is 6 stacked rows:
 *        r+0  LABEL   — col 7 = the row letter (A/B/C/D); cols 8..27 = block_loc strings
 *                        ("A-1A".."A-20A"); a PCA/PCB mini-grid extends at cols 31..33.
 *        r+1  BLOCK   — the batch_code occupying each block (e.g. "FEB-26-BLK3").
 *        r+2  BALANCE — the block's balance in kg (e.g. 73575) — a SUMIFS over the
 *                        Sheet's OWN RC IN/RC OUT tabs (so a per-block diff vs the app =
 *                        the Sheet's RC IN/OUT data diverges from the DB for that block).
 *        r+3  BD / r+4 ASH / r+5 MC — lab values (not reconciled here).
 *     Block_loc, batch and balance for one block all share the same COLUMN index, so the
 *     extractor reads them column-aligned. Empty slots have no cached formula result
 *     (openpyxl/exceljs → null) and are skipped.
 *
 * EXACT-SCRAPE DISCIPLINE (Reconciliation-Model rule 1): capture what the tab literally
 * says per block, no cross-record math. The only derived figure is the stated grand
 * total (read straight from col A) — used only as an extraction-completeness anchor.
 */
import type { LoadedSheet, CellValue } from "../../lib/xlsx.js";

/** One block the Sheet's Blocking grid states. `batch_code`/`balance_kg` null = the
 *  slot had a header but no occupant (should not normally be emitted — see extractor). */
export interface SheetBlock {
  /** Normalized `{WHSE}-{COL}{ROW}` (trim + UPPERCASE). */
  block_loc: string;
  /** The batch_code the Sheet shows occupying this block (verbatim, trimmed). */
  batch_code: string | null;
  /** The Sheet's stated balance for this block, in kg. */
  balance_kg: number | null;
}

export interface BlockingExtractResult {
  tab: string;
  blocks: SheetBlock[];
  /** The Sheet's whole-inventory total in kg (col A tons × 1000), or null if absent. */
  statedGrandTotalKg: number | null;
  warnings: string[];
  source_rows: number;
}

/** block_loc format — MIRRORS `extract.ts::BLOCK_LOC_REGEX` (that const is unexported).
 *  {WHSE ∈ A-D or F, or PCA/PCB}-{col 1..99}{row A-D}. */
const BLOCK_LOC_REGEX = /^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$/;

/** Columns 1..7 are the band's label/state gutter; block columns start at 8. */
const FIRST_BLOCK_COL = 8;
/** Row-offset of the BLOCK (batch) row below a LABEL row. */
const BLOCK_ROW_OFFSET = 1;
/** Row-offset of the BALANCE row below a LABEL row. */
const BALANCE_ROW_OFFSET = 2;
/** How far down col A to look for the "INVENTORY TONS" numeric total. */
const GRAND_TOTAL_SCAN_ROWS = 20;
/** tons → kg. */
const KG_PER_TON = 1000;

function asTrimmedString(v: CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null; // a date can't be a loc/batch
  const s = String(v).trim();
  return s.length ? s : null;
}

function asNumber(v: CellValue): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The Sheet's stated whole-inventory total. Read the FIRST finite number in col A
 * (the "INVENTORY TONS" figure), interpret as TONS, convert to kg. Positional but
 * robust — col A carries only the label text + this one number in the header region.
 */
function readStatedGrandTotalKg(sheet: LoadedSheet): number | null {
  const scan = Math.min(sheet.rowCount, GRAND_TOTAL_SCAN_ROWS);
  for (let r = 1; r <= scan; r++) {
    const n = asNumber(sheet.cell(r, 1));
    if (n !== null) return Math.round(n * KG_PER_TON);
  }
  return null;
}

/**
 * Extract the Blocking tab into per-block source records + the stated grand total.
 *
 * A LABEL row is any row carrying ≥1 block_loc-shaped string at/after col 8. For each
 * such (col, loc) the batch is one row below and the balance two rows below, at the SAME
 * column. A block is emitted only when it is OCCUPIED (a batch code or a numeric balance
 * is present) — vacant slots (both null) are skipped. This handles the standard 20-col
 * bands AND the PCA/PCB extension columns uniformly, because both live in the same LABEL
 * row with the same +1/+2 offsets.
 */
export function extractBlockingTab(sheet: LoadedSheet): BlockingExtractResult {
  const warnings: string[] = [];
  const blocks: SheetBlock[] = [];
  const seen = new Set<string>();
  let sourceRows = 0;

  const maxRow = sheet.rowCount;
  const maxCol = sheet.columnCount;

  for (let r = 1; r <= maxRow; r++) {
    // Collect block_loc cells in this row (a LABEL row has them).
    const locCells: Array<{ col: number; loc: string }> = [];
    for (let c = FIRST_BLOCK_COL; c <= maxCol; c++) {
      const s = asTrimmedString(sheet.cell(r, c));
      if (s && BLOCK_LOC_REGEX.test(s.toUpperCase())) {
        locCells.push({ col: c, loc: s.toUpperCase() });
      }
    }
    if (locCells.length === 0) continue;
    sourceRows += 1;

    for (const { col, loc } of locCells) {
      const batch = asTrimmedString(sheet.cell(r + BLOCK_ROW_OFFSET, col));
      const balance = asNumber(sheet.cell(r + BALANCE_ROW_OFFSET, col));
      if (batch === null && balance === null) continue; // vacant slot

      if (seen.has(loc)) {
        warnings.push(`Duplicate block_loc '${loc}' in the Sheet Blocking tab (kept first)`);
        continue;
      }
      seen.add(loc);
      blocks.push({ block_loc: loc, batch_code: batch, balance_kg: balance });
    }
  }

  return {
    tab: sheet.name,
    blocks,
    statedGrandTotalKg: readStatedGrandTotalKg(sheet),
    warnings,
    source_rows: sourceRows,
  };
}
