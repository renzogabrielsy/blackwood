/**
 * classify.ts — TS port of classify_rc_out.py (read the Python as spec).
 *
 * Behavioral law: workers/sync/specs/rc_out.md §3 (natural key, batch resolution,
 * equality rules, FLAGGED kinds). This is the PARITY-CRITICAL file — its output IS
 * the classify oracle (fixtures/rc_out/oracle/*.json). Must match byte-for-byte
 * after the harness canonicalizer.
 *
 * Natural key: (transaction_date, batch_id, destination), destination default "MAIN".
 * All numeric comparison via lib/norm normNum (banker's rounding); NEVER Math.round.
 */
import type { ProposedRow } from "./extract.js";
import { normNum, normStr } from "../../lib/norm.js";

// ---------------------------------------------------------------------------
// Types mirroring the classify_rc_out.py output buckets.
// ---------------------------------------------------------------------------

/** A DB rc_out row from the snapshot (dbWindow.rc_out). */
export type RcOutDbRow = Record<string, unknown>;

/** batch_code → batch_id (uuid) map (dbWindow.batch_lookup). */
export type BatchLookup = Record<string, string>;

export interface FieldDiff {
  field: string;
  emailValue: unknown;
  dbValue: unknown;
}

interface NewItem { index: unknown; row: ProposedRow; }
interface ChangedItem { index: unknown; row: ProposedRow; db_row: RcOutDbRow; diff: FieldDiff[]; }
interface NoopItem { index: unknown; natural_key: [string, string, string]; db_id: unknown; }
interface FlaggedItem { index: unknown; row: ProposedRow; reason: string; }
interface UnmappedItem { index: unknown; row: ProposedRow; reason: string; }
interface MalformedItem { row: ProposedRow; reason: string; }

export interface ClassifyResult {
  summary: {
    extracted_total: number;
    new_count: number;
    changed_count: number;
    noop_count: number;
    flagged_count: number;
    unmapped_count: number;
    malformed_count: number;
    db_rows_in_window: number;
    watermark: string | null;
    extract_date_span: { min: string | null; max: string | null };
    db_date_span: { min: string | null; max: string | null };
  };
  new: NewItem[];
  changed: ChangedItem[];
  noop: NoopItem[];
  flagged: FlaggedItem[];
  unmapped: UnmappedItem[];
  malformed: MalformedItem[];
}

// ---------------------------------------------------------------------------
// Helpers — classify_rc_out.py:83-148.
// ---------------------------------------------------------------------------

function makeNaturalKey(
  transactionDate: string,
  batchId: string,
  destination = "MAIN",
): [string, string, string] {
  return [transactionDate, batchId, destination];
}

/** classify_rc_out.py:87-98 resolve_batch_id — primary first, then fallbacks in order. */
function resolveBatchId(
  row: ProposedRow,
  batchLookup: BatchLookup,
): [string | null, string | null] {
  const primary = row.batch_code_primary;
  if (primary && primary in batchLookup) return [batchLookup[primary], primary];
  for (const fb of row.batch_code_fallbacks ?? []) {
    if (fb in batchLookup) return [batchLookup[fb], fb];
  }
  return [null, null];
}

/**
 * classify_rc_out.py:101-148 field_differences.
 * weight_kg (norm_num 3dp), remarks (norm_str null≡empty), production_batch,
 * and block_loc ONLY when the extracted side is non-null/non-empty.
 */
function fieldDifferences(extracted: ProposedRow, dbRow: RcOutDbRow): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  // weight_kg — extracted.weight_kg falling back to day_total_kg (Python `or`).
  const eWSrc = pyOr(extracted.weight_kg, extracted.day_total_kg);
  const eW = normNum(eWSrc, 3);
  const dW = normNum(dbRow.weight_kg, 3);
  if (!numEq(eW, dW)) {
    diffs.push({ field: "weight_kg", emailValue: eW, dbValue: dW });
  }

  // remarks — null≡empty via norm_str.
  const eR = normStr(extracted.remarks);
  const dR = normStr(dbRow.remarks);
  if (eR !== dR) {
    diffs.push({ field: "remarks", emailValue: extracted.remarks, dbValue: dbRow.remarks });
  }

  // production_batch.
  const ePb = normStr(extracted.production_batch);
  const dPb = normStr(dbRow.production_batch);
  if (ePb !== dPb) {
    diffs.push({
      field: "production_batch",
      emailValue: extracted.production_batch,
      dbValue: dbRow.production_batch,
    });
  }

  // block_loc — only when extracted side is non-null and non-empty.
  const eBl = extracted.block_loc;
  if (eBl !== null && eBl !== undefined && eBl !== "") {
    const dBl = dbRow.block_loc;
    if (normStr(eBl) !== normStr(dBl)) {
      diffs.push({ field: "block_loc", emailValue: eBl, dbValue: dBl });
    }
  }

  return diffs;
}

/** Python truthy `a or b` for the weight fallback (0/None/"" are falsy). */
function pyOr(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined || a === 0 || a === "" || a === false) return b;
  return a;
}

/** Equality of two normNum results, treating NaN-free numbers by value; null≠number. */
function numEq(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a === b;
}

// ---------------------------------------------------------------------------
// Main classify — classify_rc_out.py:151-327 (offline: consumes snapshots, no DB).
// ---------------------------------------------------------------------------

export interface ClassifyInputs {
  extractedRows: ProposedRow[];
  batchLookup: BatchLookup;
  dbRows: RcOutDbRow[];
  /** Live DB MAX(transaction_date); null disables the sub-watermark guard. */
  watermark: string | null;
}

export function classifyRcOut(inputs: ClassifyInputs): ClassifyResult {
  const { extractedRows, batchLookup } = inputs;
  const watermark = (inputs.watermark ?? "").trim() || null; // classify_rc_out.py:167.

  // Handle the wrapped {"data":[...]} json_agg shape (classify_rc_out.py:184-185).
  let dbRows = inputs.dbRows;
  if (
    Array.isArray(dbRows) &&
    dbRows.length === 1 &&
    isPlainObject(dbRows[0]) &&
    "data" in (dbRows[0] as Record<string, unknown>)
  ) {
    const inner = (dbRows[0] as Record<string, unknown>).data;
    dbRows = Array.isArray(inner) ? (inner as RcOutDbRow[]) : [];
  }

  // Index DB by natural key (classify_rc_out.py:190-197).
  const dbIndex = new Map<string, RcOutDbRow[]>();
  for (const dbRow of dbRows) {
    const key = makeNaturalKey(
      String(dbRow.transaction_date ?? ""),
      String(dbRow.batch_id ?? ""),
      (dbRow.destination as string) || "MAIN",
    );
    const kStr = keyStr(key);
    const bucket = dbIndex.get(kStr);
    if (bucket) bucket.push(dbRow);
    else dbIndex.set(kStr, [dbRow]);
  }

  const classifiedNew: NewItem[] = [];
  const classifiedChanged: ChangedItem[] = [];
  const classifiedNoop: NoopItem[] = [];
  const classifiedUnmapped: UnmappedItem[] = [];
  const classifiedMalformed: MalformedItem[] = [];
  const classifiedFlagged: FlaggedItem[] = [];

  for (const exRow of extractedRows) {
    // Required-field check (classify_rc_out.py:208-214).
    if (!exRow.transaction_date) {
      classifiedMalformed.push({ row: exRow, reason: "missing transaction_date" });
      continue;
    }
    const w = pyOr(exRow.weight_kg, exRow.day_total_kg);
    // `w is None or float(w) == 0` — a genuine 0 total is malformed/dropped.
    if (w === null || w === undefined || pyFloatEqZero(w)) {
      classifiedMalformed.push({ row: exRow, reason: "missing or zero weight" });
      continue;
    }

    // Resolve batch_id (classify_rc_out.py:217-227).
    const [batchId, batchCodeUsed] = resolveBatchId(exRow, batchLookup);
    if (batchId === null) {
      classifiedUnmapped.push({
        index: exRow._source_row,
        row: exRow,
        reason:
          `No batch_id found for primary='${exRow.batch_code_primary}' ` +
          `or fallbacks=${pyListRepr(exRow.batch_code_fallbacks)}`,
      });
      continue;
    }

    // Enrich extracted row (classify_rc_out.py:230-231) — MUTATES the row, so the
    // enriched batch_id/batch_code_resolved appear in the echoed new/changed/flagged row.
    exRow.batch_id = batchId;
    exRow.batch_code_resolved = batchCodeUsed as string;
    const destination = exRow.destination || "MAIN";
    const key = makeNaturalKey(exRow.transaction_date, batchId, destination);
    const matches = dbIndex.get(keyStr(key)) ?? [];

    if (!matches.length) {
      // SUB-WATERMARK WRITE GUARD (L-019, classify_rc_out.py:242-254): a settled-date
      // NEW (transaction_date <= watermark) is FLAGGED, never inserted. String
      // comparison on zero-padded ISO dates (rc_out.md porting trap).
      if (watermark !== null && exRow.transaction_date <= watermark) {
        classifiedFlagged.push({
          index: exRow._source_row,
          row: exRow,
          reason:
            `sub-watermark NEW: transaction_date ${exRow.transaction_date} ` +
            `<= watermark ${watermark} but no DB natural-key match. A settled date ` +
            `must not be inserted (suspected duplicate / incomplete compare-set). ` +
            `Resolve manually: confirm it is truly missing before any write.`,
        });
      } else {
        classifiedNew.push({ index: exRow._source_row, row: exRow });
      }
    } else {
      const dbRow = matches[0];
      const diffs = fieldDifferences(exRow, dbRow);
      if (!diffs.length) {
        classifiedNoop.push({
          index: exRow._source_row,
          natural_key: key,
          db_id: dbRow.id,
        });
      } else {
        classifiedChanged.push({ index: exRow._source_row, row: exRow, db_row: dbRow, diff: diffs });
      }
    }
  }

  // Date spans (classify_rc_out.py:274-278) — Python min()/max() are lexicographic
  // over ISO strings.
  const extractDates = extractedRows
    .filter((r) => r.transaction_date)
    .map((r) => r.transaction_date);
  const dbDates = dbRows
    .map((r) => r.transaction_date)
    .filter((d): d is string => d !== null && d !== undefined)
    .map((d) => String(d));
  const dbSpan = dbDates.length
    ? { min: minStr(dbDates), max: maxStr(dbDates) }
    : { min: null, max: null };
  const extractSpan = extractDates.length
    ? { min: minStr(extractDates), max: maxStr(extractDates) }
    : { min: null, max: null };

  return {
    summary: {
      extracted_total: extractedRows.length,
      new_count: classifiedNew.length,
      changed_count: classifiedChanged.length,
      noop_count: classifiedNoop.length,
      flagged_count: classifiedFlagged.length,
      unmapped_count: classifiedUnmapped.length,
      malformed_count: classifiedMalformed.length,
      db_rows_in_window: dbRows.length,
      watermark,
      extract_date_span: extractSpan,
      db_date_span: dbSpan,
    },
    new: classifiedNew,
    changed: classifiedChanged,
    noop: classifiedNoop,
    flagged: classifiedFlagged,
    unmapped: classifiedUnmapped,
    malformed: classifiedMalformed,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function keyStr(key: [string, string, string]): string {
  //   separator can't appear in ISO dates / uuids / "MAIN".
  return key.join(" ");
}

/** Python `float(w) == 0` — a numeric string like "0" also equals 0. */
function pyFloatEqZero(w: unknown): boolean {
  if (typeof w === "number") return w === 0;
  if (typeof w === "string") {
    const t = w.trim();
    if (t === "") return false; // float("") raises → not reached (w already truthy)
    const f = Number(t);
    return Number.isFinite(f) && f === 0;
  }
  return false;
}

/** Python repr of a list[str] for the UNMAPPED reason string, e.g. [] or ['MAR-26-BLK1']. */
function pyListRepr(items: string[] | undefined): string {
  if (!items || items.length === 0) return "[]";
  return "[" + items.map((s) => `'${s}'`).join(", ") + "]";
}

function minStr(arr: string[]): string {
  let m = arr[0];
  for (const s of arr) if (s < m) m = s;
  return m;
}
function maxStr(arr: string[]): string {
  let m = arr[0];
  for (const s of arr) if (s > m) m = s;
  return m;
}
