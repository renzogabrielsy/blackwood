/**
 * enrich.ts — TS port of `.claude/skills/sync-ictc/scripts/enrich_prices.py`
 * (read the Python as spec). Apply-phase price enrichment from Czarina's
 * "RAW CHARCOAL PURCHASES -Daily" workbook. NOT part of the classify oracle
 * (build_oracle.py never runs enrich; cost_basis is skipped in field_differences
 * whenever the extracted side is null), so this module is orchestrator scaffolding
 * for the DBOS worker — no parity fixture exercises it.
 *
 * Matching (VERBATIM): key = (norm_supplier, norm_truck, norm_weight[whole-kg]).
 *   - 0 candidates → no match (cost_basis stays null → L-008 placeholder at apply).
 *   - 1 candidate  → use it.
 *   - >1 candidates → pick the closest in date drift (tiebreak only).
 * The ledger's L-010 plate-typo recovery is a MANUAL agent action, NOT implemented
 * here — enrich only ever does exact (supplier, truck, weight) matching (specs
 * trap): an ambiguous match stays a human judgment call, never auto-picked beyond
 * the date-drift tiebreak the Python already does.
 *
 * Czarina sheet selection ("<Month> <YYYY>") is done by the caller (index.ts).
 */
import { loadWorkbook, type CellValue } from "../../lib/xlsx.js";
import { coerceDate } from "../../lib/norm.js";
import type { DeliveryRow } from "./extract.js";

// Czarina column layout (1-based), verified 2026-05-27.
const CZ_COL = {
  date: 1,
  supplier: 2,
  truck_plate: 3,
  net_weight: 8,
  php_per_kg: 9,
} as const;

interface CzarinaRow {
  _source_row: number;
  date: string | null;
  supplier_norm: string | null;
  truck_norm: string | null;
  net_weight: number;
  php_per_kg: number;
}

export interface CzarinaMatch {
  czarina_rows_loaded: number;
  matched_count: number;
  unmatched_count: number;
}

/** norm_supplier: strip, lowercase, drop a leading single-letter-dot prefix. */
function normSupplier(s: CellValue): string | null {
  if (s === null || s === undefined) return null;
  let t = String(s).trim().toLowerCase();
  t = t.replace(/^[a-z]\.\s+/, "");
  return t ? t : null;
}

/** norm_truck: strip whitespace/hyphen/underscore, uppercase. */
function normTruck(s: CellValue): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/[\s\-_]/g, "").toUpperCase();
  return t ? t : null;
}

/** norm_weight: round to whole kg for matching. */
function normWeight(v: CellValue): number | null {
  if (v === null || v === undefined) return null;
  const f = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(f)) return null;
  // Python round(f, 0) is banker's; whole-kg precision — matching only.
  return Math.round(f);
}

function dateDiffDays(a: string | null, b: string | null): number {
  if (!a || !b) return Infinity;
  const da = Date.parse(`${a}T00:00:00Z`);
  const dbb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(dbb)) return Infinity;
  return Math.abs((da - dbb) / 86400000);
}

async function loadCzarinaRows(buf: Buffer, sheetName: string): Promise<CzarinaRow[]> {
  const wb = await loadWorkbook(buf);
  const ws = wb.sheet(sheetName);
  if (!ws) throw new Error(`Czarina sheet '${sheetName}' not found`);
  const rows: CzarinaRow[] = [];
  let lastSeenDate: string | null = null;
  for (let r = 5; r < ws.rowCount + 1; r++) {
    const supplier = ws.cell(r, CZ_COL.supplier);
    if (supplier === null || supplier === undefined || String(supplier).trim() === "") continue;
    const sl = String(supplier).trim().toLowerCase();
    if (sl === "average" || sl === "total" || sl === "sum") continue;

    let dateStr = coerceDate(ws.cell(r, CZ_COL.date));
    if (dateStr === null) dateStr = lastSeenDate;
    else lastSeenDate = dateStr;

    const netWeight = normWeight(ws.cell(r, CZ_COL.net_weight));
    if (netWeight === null || netWeight <= 0) continue;

    const phpRaw = ws.cell(r, CZ_COL.php_per_kg);
    if (phpRaw === null || phpRaw === undefined) continue;
    const php = typeof phpRaw === "number" ? phpRaw : Number(String(phpRaw));
    if (!Number.isFinite(php)) continue;

    rows.push({
      _source_row: r,
      date: dateStr,
      supplier_norm: normSupplier(supplier),
      truck_norm: normTruck(ws.cell(r, CZ_COL.truck_plate)),
      net_weight: netWeight,
      php_per_kg: php,
    });
  }
  return rows;
}

function buildPriceIndex(rows: CzarinaRow[]): Map<string, CzarinaRow[]> {
  const idx = new Map<string, CzarinaRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.supplier_norm, r.truck_norm, r.net_weight]);
    const arr = idx.get(key);
    if (arr) arr.push(r);
    else idx.set(key, [r]);
  }
  return idx;
}

function matchPrice(row: DeliveryRow, index: Map<string, CzarinaRow[]>): number | null {
  const key = JSON.stringify([
    normSupplier(row.supplier as CellValue),
    normTruck(row.truck_plate as CellValue),
    normWeight(row.weight_kg as CellValue),
  ]);
  const candidates = index.get(key) ?? [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].php_per_kg;
  const exDate = String(row.transaction_date);
  const sorted = [...candidates].sort(
    (a, b) => dateDiffDays(exDate, a.date) - dateDiffDays(exDate, b.date),
  );
  return sorted[0].php_per_kg;
}

/**
 * Enrich `rows` in place: set `cost_basis` on each row a Czarina price matches.
 * Returns match counts. Mirrors enrich_prices.py's mutation of the extract rows.
 */
export async function enrichPrices(
  czarinaBuf: Buffer,
  sheetName: string,
  rows: DeliveryRow[],
): Promise<CzarinaMatch> {
  const czarinaRows = await loadCzarinaRows(czarinaBuf, sheetName);
  const index = buildPriceIndex(czarinaRows);
  let matched = 0;
  let unmatched = 0;
  for (const row of rows) {
    const php = matchPrice(row, index);
    if (php !== null) {
      row.cost_basis = php;
      matched++;
    } else {
      unmatched++;
    }
  }
  return {
    czarina_rows_loaded: czarinaRows.length,
    matched_count: matched,
    unmatched_count: unmatched,
  };
}
