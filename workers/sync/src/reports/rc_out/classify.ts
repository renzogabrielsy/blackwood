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

/**
 * An informational (non-holding) note surfaced to the run's output. Emitted when a
 * sub-watermark row is NOOP'd via the 5-hard-field match but the production-run label
 * (production_batch) differs — a benign month-boundary label variance (rc_out L-034).
 * Carries no ₱/cost — pure identity + kg. See classifyRcOut sub-watermark branch.
 */
export interface SoftWarning {
  kind: string;
  index: unknown;
  natural_key: [string, string, string];
  db_id: unknown;
  message: string;
}

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
  /** Informational, non-holding notes (e.g. month-boundary label variance, L-034). */
  soft_warnings: SoftWarning[];
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
// L-037 balance-integrity guard — balances become VALIDATION, not scraped data.
// ---------------------------------------------------------------------------

/** kg tolerance for the balance checks. Real reports have STRT−END == DAY TOTAL to
 *  the exact integer (verified across the full May+July corpus, dSE=0 everywhere),
 *  so 1 kg absorbs trivial rounding without masking a real gap (June-10 was 10,813 kg). */
const BALANCE_TOL_KG = 1.0;

/** Plain 3dp round for the human-readable hold reason (never a comparison path). */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * L-037 — hold a row when its scraped DAY TOTAL (the feeding weight) cannot be trusted:
 *   (a) within-block: STRT − END must equal DAY TOTAL. A mismatch means the DAY TOTAL
 *       cell is NOT this block's own feeding (the June-10 signature: the operator wrote a
 *       cross-block cumulative — day-opening minus THIS leg's end — into a continuation
 *       leg's DAY TOTAL). The extractor scrapes DAY TOTAL faithfully; this guard is what
 *       stops a bad cumulative from being stored (or from overwriting a corrected DB row).
 *   (b) continuity: a section's opening STRT must continue the immediately-prior section's
 *       END when both describe the SAME physical slot on the SAME day (a re-feed of the
 *       same (whse_label, block_no) — the two-leg case). A break is the "discrepancy
 *       between previous and latest entry" the operator wants surfaced.
 *
 * Returns a hold reason, or null when the balances validate. The pallet-Net sum is
 * deliberately NOT a trigger — real reports list pallets only partially (pathway/SUNDRY
 * zones carry none), so a net-sum gate would false-hold constantly (verified on the
 * corpus). Only fires when the needed balances are BOTH present — a blank STRT/END cell
 * (e.g. a FEED section with no END) cannot be validated and is never held.
 */
function balanceIntegrity(row: ProposedRow, prev: ProposedRow | null): string | null {
  const strt = normNum(row.strt_bal_kg, 3);
  const end = normNum(row.end_bal_kg, 3);
  const day = normNum(pyOr(row.weight_kg, row.day_total_kg), 3);

  // (a) within-block STRT − END vs DAY TOTAL.
  if (strt !== null && end !== null && day !== null) {
    const se = r3(strt - end);
    if (Math.abs(se - day) > BALANCE_TOL_KG) {
      return (
        `block balance integrity: STRT ${strt} - END ${end} = ${se} kg but DAY TOTAL = ${day} kg ` +
        `(delta ${r3(se - day)}). The scraped DAY TOTAL disagrees with the block's own STRT/END — ` +
        `suspected cross-block cumulative (L-037). Held for manual review.`
      );
    }
  }

  // (b) same-slot, same-day continuity against the immediately-prior section.
  if (prev !== null && strt !== null) {
    const sameSlot =
      row.transaction_date === prev.transaction_date &&
      normStr(row.whse_label) === normStr(prev.whse_label) &&
      row.block_no === prev.block_no;
    if (sameSlot) {
      const pEnd = normNum(prev.end_bal_kg, 3);
      if (pEnd !== null && Math.abs(strt - pEnd) > BALANCE_TOL_KG) {
        return (
          `slot continuity: STRT ${strt} != the previous same-slot END ${pEnd} for ` +
          `${row.whse_label} #${row.block_no} on ${row.transaction_date} (delta ${r3(strt - pEnd)}). ` +
          `Discrepancy between consecutive feedings of this slot (L-037). Held for manual review.`
        );
      }
    }
  }
  return null;
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
  const classifiedSoftWarnings: SoftWarning[] = [];

  for (let idx = 0; idx < extractedRows.length; idx++) {
    const exRow = extractedRows[idx];
    const prevRow = idx > 0 ? extractedRows[idx - 1] : null;
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

    // L-037 balance-integrity guard: HOLD (never write) a row whose scraped DAY TOTAL
    // disagrees with the block's own STRT/END or breaks same-slot continuity. This runs
    // BEFORE the natural-key routing so a corrupt cumulative can neither be inserted as
    // NEW nor overwrite a corrected DB row as VALUE_CHANGED.
    const balanceReason = balanceIntegrity(exRow, prevRow);
    if (balanceReason !== null) {
      classifiedFlagged.push({ index: exRow._source_row, row: exRow, reason: balanceReason });
      continue;
    }

    const destination = exRow.destination || "MAIN";
    const key = makeNaturalKey(exRow.transaction_date, batchId, destination);
    const matches = dbIndex.get(keyStr(key)) ?? [];

    if (!matches.length) {
      // SUB-WATERMARK WRITE GUARD (L-019): a settled-date NEW (transaction_date <=
      // watermark) with NO natural-key match is FLAGGED, never inserted. String comparison
      // on zero-padded ISO dates (rc_out.md porting trap).
      //
      // L-034 note: the month-boundary false-flag (a settled row present in the DB but
      // labeled differently) is NOT resolved here — reaching this branch means the DB row
      // is genuinely ABSENT from the compare-set. That was the recurring bug: an
      // asymmetric compare window (since = watermark−3d) that never reached the workbook's
      // oldest sheet rows. The fix lives in the ORCHESTRATOR (index.ts / sync_rc_out.py),
      // which now widens the compare-set floor to min(extract_min, watermark−3d) so the
      // saved copy IS in `matches` → the label variance is handled in the matches branch
      // below. A row that still reaches HERE is a real miss and is correctly held.
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
      // L-034: a diff list whose ONLY entry is production_batch is a month-boundary run
      // label variance on an already-saved row (calendar-month vs run-header-month label).
      // Both labels are defensible; the record is already correct. Demote to NOOP + a SOFT
      // WARNING — never a VALUE_CHANGED (which would needlessly flip the DB label each run).
      const onlyLabelDiff = diffs.length === 1 && diffs[0].field === "production_batch";
      if (!diffs.length) {
        classifiedNoop.push({
          index: exRow._source_row,
          natural_key: key,
          db_id: dbRow.id,
        });
      } else if (onlyLabelDiff) {
        classifiedNoop.push({
          index: exRow._source_row,
          natural_key: key,
          db_id: dbRow.id,
        });
        classifiedSoftWarnings.push({
          kind: "sub_watermark_suspected_dup",
          index: exRow._source_row,
          natural_key: key,
          db_id: dbRow.id,
          message:
            `label differs, but record is already saved — no action needed ` +
            `(${exRow.transaction_date}, ${destination}, ` +
            `${normNum(pyOr(exRow.weight_kg, exRow.day_total_kg), 3)}kg: ` +
            `production_batch '${exRow.production_batch}' vs DB '${dbRow.production_batch ?? ""}'; ` +
            `month-boundary run label variance).`,
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
    soft_warnings: classifiedSoftWarnings,
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
