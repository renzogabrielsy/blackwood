/**
 * extract.ts — TS port of `.claude/skills/sync-ictc/scripts/extract_flecon_bags.py`
 * (read as spec, alongside specs/flecon.md §2 and specs/SHARED.md §4).
 *
 * This is the FLECON bag-movement extractor: it reads Ivy's single CUMULATIVE
 * workbook (ONE tab per YEAR, e.g. "JANUARY 2026" = all of 2026) and produces the
 * movement list + column map + opening balances + balance snapshot + unmapped/
 * missing column flags that classify.ts consumes.
 *
 * Column mapping is by HEADER SIGNATURE (position-independent), driven by the
 * bag-type registry passed in (offline mode) — never by fixed column letters
 * (flecon.md §2 "Column mapping algorithm").
 *
 * Coercion parity (flecon.md §2 / SHARED.md §4):
 *   coerce_int(v) in Python = int(round(coerce_float(v)))  →  normIntRound(v)
 *     (banker's round then truncate). We call it via coerceIntBanker below, which
 *     reuses lib/norm's coerceFloat (bool-rejecting) + roundHalfToEven — NEVER a raw
 *     Math.round (norm.ts HARD RULE).
 */
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../lib/xlsx.js";
import { coerceFloat, roundHalfToEven } from "../../lib/norm.js";

// ---------------------------------------------------------------------------
// Header geometry (extract_flecon_bags.py lines 89-101)
// ---------------------------------------------------------------------------
const COL_C = 3; // 'C' — first bag-type column
const DEFAULT_LAST_BAG_COL = 16; // 'P' — historical right edge
const HEADER_SIGNATURE_ROWS = [3, 5, 6] as const; // combined in this order

const COL_DATE = 1; // A
const COL_PARTICULAR = 2; // B
const OPENING_BALANCE_ROW = 7; // "Forwarded Balance"
const FIRST_DATA_ROW = 8;

const MONTH_NAMES = new Set([
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
]);

// ---------------------------------------------------------------------------
// Registry row shape (flecon_bag_types) — the source of truth for column mapping.
// ---------------------------------------------------------------------------
export interface BagTypeRegistryRow {
  code: unknown;
  source_label?: unknown;
  source_column?: unknown;
  sort_order?: unknown;
  label?: unknown;
}

export interface FleconMovement {
  transaction_date: string;
  particular: string | null;
  bag_type_code: string;
  qty_delta: number;
  source_row: number;
}

export interface ColumnMapEntry {
  column_letter: string;
  signature: string;
  matched_code: string | null;
  sort_order: unknown;
}

export interface UnmappedColumn {
  column_letter: string;
  signature: string;
  sample_values: Array<{ row: number; value: number; kind?: string }>;
  first_data_row: number | null;
}

export interface MissingColumn {
  code: string;
  source_label: unknown;
  source_column: unknown;
}

export interface FleconExtract {
  filename: string;
  sheet: string;
  since: string | null;
  rows: FleconMovement[];
  opening_balances: Record<string, number>;
  balance_snapshot: Record<string, number> | null;
  column_map: ColumnMapEntry[];
  unmapped_columns: UnmappedColumn[];
  missing_columns: MissingColumn[];
  summary: {
    total_rows: number;
    distinct_dates: number;
    date_min: string | null;
    date_max: string | null;
    total_in: number;
    total_out: number;
    dropped_before_since: number;
    skipped_markers: number;
    matched_columns: number;
    unmapped_columns: number;
    missing_columns: number;
    extraction_warnings: string[];
    overall_confidence: number;
  };
}

// ---------------------------------------------------------------------------
// Coercion helpers (extract_flecon_bags.py lines 157-206) — port EXACTLY.
// ---------------------------------------------------------------------------

/**
 * Port of `coerce_int` (line 196): `int(round(coerce_float(v)))`. Python's
 * round() is banker's rounding → roundHalfToEven; int() then truncates toward 0.
 * This equals lib/norm.normIntRound, but we inline the coerceFloat call here so the
 * flecon-specific coerce_float semantics (comma-strip, bool-reject, "VALUE"→null) are
 * exactly the ones used. norm.coerceFloat already strips commas/₱/$ and rejects bool.
 */
function coerceIntBanker(value: CellValue): number | null {
  const f = coerceFloatFlecon(value);
  if (f === null) return null;
  return Math.trunc(roundHalfToEven(f, 0));
}

/**
 * Port of `coerce_float` (line 176). norm.coerceFloat is nearly identical (rejects
 * bool, strips commas, trims). The one flecon-specific extra: a string containing
 * "VALUE" (an Excel "#VALUE!" leak) → null. openpyxl data_only yields None for error
 * cells, so exceljs already gives us null there; the "VALUE" guard is belt-and-braces
 * parity with the Python.
 */
function coerceFloatFlecon(value: CellValue): number | null {
  if (typeof value === "string" && value.includes("VALUE")) return null;
  return coerceFloat(value);
}

/**
 * Port of `coerce_str` (line 201): str(v).strip(), empty → null. None → null.
 * openpyxl str() on a number yields e.g. "3" / "3.0"; exceljs gives us the number
 * directly, so String(v) mirrors Python's str(). Booleans: Python str(True)="True";
 * the sheet never carries a bool in A/B/header cells, but mirror faithfully.
 */
function coerceStr(value: CellValue): string | null {
  if (value === null || value === undefined) return null;
  const s = pyStr(value).trim();
  return s ? s : null;
}

/** Mirror Python str() for the cell value shapes we see (str/number/bool/Date). */
function pyStr(v: CellValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v instanceof Date) return coerceDate(v) ?? "";
  // number: Python str(3.0) == "3.0", str(3) == "3". exceljs numeric cells come back
  // as JS numbers; header/particular cells that are integers should stringify without
  // ".0" the way Python str(int) does — but a float stays "3.0". JS String(3)==="3",
  // String(3.0)==="3" (JS has no int/float distinction), so integer-valued floats lose
  // the ".0". This only matters for signature/particular text; header cells are text in
  // practice and particular text is never a bare number, so this is not exercised.
  return String(v);
}

/**
 * Port of `coerce_date` (line 157) → ISO YYYY-MM-DD or null. openpyxl yields a native
 * date for date cells; exceljs yields a JS Date. String path tries the same 5 formats.
 */
function coerceDate(value: CellValue): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && value.includes("VALUE")) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const y = value.getUTCFullYear();
    const m = value.getUTCMonth() + 1;
    const d = value.getUTCDate();
    return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
  }
  if (typeof value === "string") {
    const s = value.trim();
    return (
      tryDate(s, "Y-m-d") ??
      tryDate(s, "m/d/Y") ??
      tryDate(s, "d/m/Y") ??
      tryDate(s, "Y/m/d") ??
      tryDate(s, "m-d-Y") ??
      null
    );
  }
  return null;
}

function tryDate(s: string, fmt: "Y-m-d" | "m/d/Y" | "d/m/Y" | "Y/m/d" | "m-d-Y"): string | null {
  let y: number, mo: number, d: number, m: RegExpMatchArray | null;
  switch (fmt) {
    case "Y-m-d":
      m = s.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/);
      if (!m) return null;
      y = +m[1]; mo = +m[2]; d = +m[3];
      break;
    case "m/d/Y":
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/);
      if (!m) return null;
      mo = +m[1]; d = +m[2]; y = +m[3];
      break;
    case "d/m/Y":
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/);
      if (!m) return null;
      d = +m[1]; mo = +m[2]; y = +m[3];
      break;
    case "Y/m/d":
      m = s.match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/);
      if (!m) return null;
      y = +m[1]; mo = +m[2]; d = +m[3];
      break;
    case "m-d-Y":
      m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{1,4})$/);
      if (!m) return null;
      mo = +m[1]; d = +m[2]; y = +m[3];
      break;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${pad4(y)}-${pad2(mo)}-${pad2(d)}`;
}

// ---------------------------------------------------------------------------
// Signature helpers (extract_flecon_bags.py lines 130-151, 261-269)
// ---------------------------------------------------------------------------

/** '590 kls (Kuraray)' → '590klskuraray'. Drops ALL non-alphanumerics (line 143). */
function normalizeSig(text: string | null | undefined): string {
  if (text === null || text === undefined) return "";
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 'C' → 3, base-26 1-indexed (A=1). Tolerant; blank/non-alpha → null (line 130). */
function colLetterToIndex(letter: unknown): number | null {
  if (letter === null || letter === undefined) return null;
  const s = String(letter).trim().toUpperCase();
  if (!s || !/^[A-Z]+$/.test(s)) return null;
  let idx = 0;
  for (const ch of s) idx = idx * 26 + (ch.charCodeAt(0) - 65 + 1);
  return idx;
}

/** 1 → 'A', 27 → 'AA'. Inverse of colLetterToIndex, for report entries. */
function colIndexToLetter(idx: number): string {
  let n = idx;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Combine non-empty header cells across rows 3/5/6 into one space-joined signature. */
function buildColumnSignature(ws: LoadedSheet, col: number): string {
  const parts: string[] = [];
  for (const r of HEADER_SIGNATURE_ROWS) {
    const v = coerceStr(ws.cell(r, col));
    if (v) parts.push(v);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Sheet selection (extract_flecon_bags.py lines 218-236)
// ---------------------------------------------------------------------------
function selectYearSheet(wb: LoadedWorkbook, year: number | null): [string, string | null] {
  const names = wb.sheetNames;
  if (year !== null) {
    const target = String(year);
    const matches = names.filter((n) => n.replace(/ /g, "").includes(target));
    if (matches.length) return [matches[matches.length - 1], null];
    return [
      names[names.length - 1],
      `No sheet name contains year ${year}; falling back to last sheet ` +
        `'${names[names.length - 1]}'. Available: ${JSON.stringify(names)}`,
    ];
  }
  return [names[names.length - 1], null];
}

// ---------------------------------------------------------------------------
// Header block location (extract_flecon_bags.py lines 242-255)
// ---------------------------------------------------------------------------
function locateHeaderBlock(ws: LoadedSheet): boolean {
  const a4 = normalizeSig(coerceStr(ws.cell(4, COL_DATE)));
  const b4 = normalizeSig(coerceStr(ws.cell(4, COL_PARTICULAR)));
  const headerOk = a4 === "date" && b4 === "particular";
  let anySig = false;
  const end = Math.min(DEFAULT_LAST_BAG_COL, ws.columnCount);
  for (let c = COL_C; c <= end; c++) {
    if (buildColumnSignature(ws, c).trim()) {
      anySig = true;
      break;
    }
  }
  return headerOk && anySig;
}

// ---------------------------------------------------------------------------
// Column mapping (extract_flecon_bags.py lines 272-370) — two-pass, verbatim.
// ---------------------------------------------------------------------------
function mapColumns(
  ws: LoadedSheet,
  registry: BagTypeRegistryRow[],
  warnings: string[],
): { colToCode: Map<number, string>; columnMap: ColumnMapEntry[]; matchedCodes: string[] } {
  // reg_by_nsig: normalized source_label → list of entries.
  const regByNsig = new Map<string, BagTypeRegistryRow[]>();
  for (const e of registry) {
    const nsig = normalizeSig(e.source_label as string | null | undefined);
    if (nsig) {
      const arr = regByNsig.get(nsig) ?? [];
      arr.push(e);
      regByNsig.set(nsig, arr);
    }
  }
  const regEntries = registry.filter((e) => normalizeSig(e.source_label as string | null | undefined));

  // last_col = max(DEFAULT_LAST_BAG_COL, *registry source_column indices).
  const regCols: number[] = [];
  for (const e of registry) {
    const idx = colLetterToIndex(e.source_column);
    if (idx !== null) regCols.push(idx);
  }
  const lastCol = regCols.length ? Math.max(DEFAULT_LAST_BAG_COL, ...regCols) : DEFAULT_LAST_BAG_COL;

  const colToCode = new Map<number, string>();
  const claimedCodes = new Set<string>();
  const scanned: Array<[number, string, string]> = []; // (col, sig, nsig)

  for (let col = COL_C; col <= lastCol; col++) {
    const sig = buildColumnSignature(ws, col);
    const nsig = normalizeSig(sig);
    scanned.push([col, sig, nsig]);
  }

  // Pass 1 — exact normalized match.
  for (const [col, sig, nsig] of scanned) {
    if (!nsig) continue;
    const hits = regByNsig.get(nsig) ?? [];
    if (hits.length === 1) {
      const code = String(hits[0].code);
      colToCode.set(col, code);
      claimedCodes.add(code);
    } else if (hits.length > 1) {
      warnings.push(
        `col ${colIndexToLetter(col)}: signature ${pyRepr(sig)} matched ${hits.length} ` +
          `registry entries exactly (${pyList(hits.map((h) => h.code))}) — left UNMAPPED (ambiguous).`,
      );
    }
  }

  // Pass 2 — conservative contains fallback for still-unmatched columns.
  for (const [col, sig, nsig] of scanned) {
    if (colToCode.has(col) || !nsig) continue;
    const cand: BagTypeRegistryRow[] = [];
    for (const e of regEntries) {
      const code = String(e.code);
      if (claimedCodes.has(code)) continue;
      const rn = normalizeSig(e.source_label as string | null | undefined);
      if (rn && (nsig.includes(rn) || rn.includes(nsig))) cand.push(e);
    }
    const candCodes = [...new Set(cand.map((e) => String(e.code)))].sort();
    if (candCodes.length === 1) {
      const code = candCodes[0];
      colToCode.set(col, code);
      claimedCodes.add(code);
    } else if (candCodes.length > 1) {
      warnings.push(
        `col ${colIndexToLetter(col)}: signature ${pyRepr(sig)} contains-matched ` +
          `${pyList(candCodes)} — left UNMAPPED (ambiguous, never guessed).`,
      );
    }
  }

  // Build the column_map report entry for every scanned column.
  const sortByCode = new Map<string, unknown>();
  for (const e of registry) sortByCode.set(String(e.code), e.sort_order);
  const columnMap: ColumnMapEntry[] = [];
  for (const [col, sig] of scanned) {
    const code = colToCode.get(col);
    columnMap.push({
      column_letter: colIndexToLetter(col),
      signature: sig,
      matched_code: code ?? null,
      sort_order: code ? (sortByCode.get(code) ?? null) : null,
    });
  }

  return { colToCode, columnMap, matchedCodes: [...colToCode.values()] };
}

// ---------------------------------------------------------------------------
// Unmapped columns scan (extract_flecon_bags.py lines 373-415)
// ---------------------------------------------------------------------------
function scanUnmappedColumns(
  ws: LoadedSheet,
  columnMap: ColumnMapEntry[],
): UnmappedColumn[] {
  // letter → col index, for columns C..max_column.
  const letterToCol = new Map<string, number>();
  for (let c = COL_C; c <= ws.columnCount; c++) letterToCol.set(colIndexToLetter(c), c);

  const out: UnmappedColumn[] = [];
  for (const entry of columnMap) {
    if (entry.matched_code !== null) continue;
    const col = letterToCol.get(entry.column_letter);
    if (col === undefined) continue;

    const samples: Array<{ row: number; value: number; kind?: string }> = [];
    let firstRow: number | null = null;

    const opening = coerceIntBanker(ws.cell(OPENING_BALANCE_ROW, col));
    if (opening !== null && opening !== 0) {
      firstRow = OPENING_BALANCE_ROW;
      samples.push({ row: OPENING_BALANCE_ROW, value: opening, kind: "opening" });
    }
    for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
      const iv = coerceIntBanker(ws.cell(r, col));
      if (iv !== null && iv !== 0) {
        if (firstRow === null) firstRow = r;
        if (samples.length < 5) samples.push({ row: r, value: iv });
        else break;
      }
    }
    if (samples.length) {
      out.push({
        column_letter: entry.column_letter,
        signature: entry.signature,
        sample_values: samples,
        first_data_row: firstRow,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Opening balances (extract_flecon_bags.py lines 421-428)
// ---------------------------------------------------------------------------
function extractOpeningBalances(ws: LoadedSheet, colToCode: Map<number, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [col, code] of colToCode) {
    const v = coerceIntBanker(ws.cell(OPENING_BALANCE_ROW, col));
    if (v !== null && v !== 0) out[code] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Movement extraction (extract_flecon_bags.py lines 434-521)
// ---------------------------------------------------------------------------
function extractMovements(
  ws: LoadedSheet,
  colToCode: Map<number, string>,
  since: string | null,
  warnings: string[],
): {
  movements: FleconMovement[];
  balanceSnapshot: Record<string, number> | null;
  droppedBeforeSince: number;
  skippedMarkers: number;
} {
  const movements: FleconMovement[] = [];
  let balanceSnapshot: Record<string, number> | null = null;
  let carriedDate: string | null = null;
  let droppedBeforeSince = 0;
  let skippedMarkers = 0;
  const matchedCols = [...colToCode.keys()].sort((a, b) => a - b);

  for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r++) {
    const aRaw = ws.cell(r, COL_DATE);
    const particular = coerceStr(ws.cell(r, COL_PARTICULAR));

    // Populated MATCHED bag-type columns for this row (signed ints).
    const cols: Array<[number, number]> = [];
    for (const c of matchedCols) {
      const iv = coerceIntBanker(ws.cell(r, c));
      if (iv !== null && iv !== 0) cols.push([c, iv]);
    }

    const aStr = coerceStr(aRaw);
    const aDate = coerceDate(aRaw);

    // Month-name section row: A alpha (month), B empty → context marker. Reset date.
    if (aStr !== null && aDate === null && particular === null) {
      if (MONTH_NAMES.has(aStr.toUpperCase())) {
        carriedDate = null;
        continue;
      }
      // other alpha-in-A / no-particular row: fall through (handled below).
    }

    // Balance-snapshot row: NO date, NO particular, but numbers present.
    if (aDate === null && particular === null && cols.length) {
      if (balanceSnapshot === null) {
        balanceSnapshot = {};
        for (const [c, v] of cols) balanceSnapshot[colToCode.get(c) as string] = v;
      } else {
        warnings.push(`row ${r}: second balance-snapshot-like row ignored`);
      }
      continue;
    }

    // Carry the date forward.
    if (aDate !== null) carriedDate = aDate;

    // No matched quantity → bare marker (e.g. RS 1 ZAMBOANGA). Skip.
    if (!cols.length) {
      if (particular !== null) skippedMarkers += 1;
      continue;
    }

    // A movement needs an effective date.
    if (carriedDate === null) {
      warnings.push(
        `row ${r}: bag quantity present but no date in context ` +
          `(particular=${pyRepr(particular)}) — skipped`,
      );
      continue;
    }

    // --since tail-scope: drop rows dated before the watermark.
    if (since !== null && carriedDate < since) {
      droppedBeforeSince += cols.length;
      continue;
    }

    // Emit one movement per populated matched column.
    for (const [c, qty] of cols) {
      movements.push({
        transaction_date: carriedDate,
        particular,
        bag_type_code: colToCode.get(c) as string,
        qty_delta: qty,
        source_row: r,
      });
    }
  }

  return { movements, balanceSnapshot, droppedBeforeSince, skippedMarkers };
}

// ---------------------------------------------------------------------------
// Python repr helpers (for warning strings — only load-bearing if a fixture asserts
// on warning text; kept faithful so overall_confidence's warning COUNT is right).
// ---------------------------------------------------------------------------
function pyRepr(s: string | null): string {
  if (s === null) return "None";
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
function pyList(items: unknown[]): string {
  return "[" + items.map((i) => pyRepr(String(i))).join(", ") + "]";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

// ---------------------------------------------------------------------------
// Public entrypoint — the whole extract, returning the same shape the Python
// prints to stdout. `throw`s on the hard-error paths (locate/registry) that the
// Python exits nonzero on, since the oracle build would have failed there too.
// ---------------------------------------------------------------------------
export function extractFlecon(
  wb: LoadedWorkbook,
  filename: string,
  registry: BagTypeRegistryRow[],
  since: string | null,
  year: number | null = null,
): FleconExtract {
  const warnings: string[] = [];
  const [sheetName, selWarn] = selectYearSheet(wb, year);
  if (selWarn) warnings.push(selWarn);
  const ws = wb.sheet(sheetName);
  if (!ws) throw new Error(`sheet '${sheetName}' not found`);

  if (!locateHeaderBlock(ws)) {
    throw new Error(
      `Could not locate the FLECON header block on sheet '${sheetName}' ` +
        `(expected row 4 A='DATE'/B='PARTICULAR' and bag-type header signatures). ` +
        `Aborting rather than producing 0 movements.`,
    );
  }
  if (!registry || !registry.length) {
    throw new Error("flecon_bag_types registry is empty — cannot map columns.");
  }

  const { colToCode, columnMap, matchedCodes } = mapColumns(ws, registry, warnings);
  const unmappedColumns = scanUnmappedColumns(ws, columnMap);

  const matchedSet = new Set(matchedCodes);
  const missingColumns: MissingColumn[] = registry
    .filter((e) => !matchedSet.has(String(e.code)))
    .map((e) => ({
      code: String(e.code),
      source_label: e.source_label ?? null,
      source_column: e.source_column ?? null,
    }));

  if (unmappedColumns.length) {
    warnings.push(
      `${unmappedColumns.length} unmapped column(s) with data — possible NEW bag type(s), ` +
        `FLAGGED for registration: ${pyList(unmappedColumns.map((u) => u.column_letter))}`,
    );
  }
  if (missingColumns.length) {
    warnings.push(
      `${missingColumns.length} registry code(s) matched NO column this run ` +
        `(removed/renamed?): ${pyList(missingColumns.map((m) => m.code))}`,
    );
  }

  const openingBalances = extractOpeningBalances(ws, colToCode);
  const { movements, balanceSnapshot, droppedBeforeSince, skippedMarkers } = extractMovements(
    ws,
    colToCode,
    since,
    warnings,
  );

  // Confidence: 1.0 − 0.05 per warning, floored at 0.5, round to 3dp (line 623).
  const overallConfidence = roundHalfToEven(Math.max(0.5, 1.0 - 0.05 * warnings.length), 3);

  const dates = [...new Set(movements.map((m) => m.transaction_date))].sort();
  let totalIn = 0;
  let totalOut = 0;
  for (const m of movements) {
    if (m.qty_delta > 0) totalIn += m.qty_delta;
    else if (m.qty_delta < 0) totalOut += -m.qty_delta;
  }

  return {
    filename,
    sheet: sheetName,
    since,
    rows: movements,
    opening_balances: openingBalances,
    balance_snapshot: balanceSnapshot,
    column_map: columnMap,
    unmapped_columns: unmappedColumns,
    missing_columns: missingColumns,
    summary: {
      total_rows: movements.length,
      distinct_dates: dates.length,
      date_min: dates.length ? dates[0] : null,
      date_max: dates.length ? dates[dates.length - 1] : null,
      total_in: totalIn,
      total_out: totalOut,
      dropped_before_since: droppedBeforeSince,
      skipped_markers: skippedMarkers,
      matched_columns: colToCode.size,
      unmapped_columns: unmappedColumns.length,
      missing_columns: missingColumns.length,
      extraction_warnings: warnings,
      overall_confidence: overallConfidence,
    },
  };
}
