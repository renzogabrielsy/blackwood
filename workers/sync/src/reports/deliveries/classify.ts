/**
 * classify.ts — TS port of `classify_deliveries.py` PLUS the orchestrator-level guard
 * layer from `workers/sync/scripts/parity_guards.py` (which mirrors
 * sync_deliveries.py:152-246). Behavioral law: specs/deliveries.md §3.
 *
 * The deliveries CLASSIFY oracle is:
 *     apply_deliveries_guard( classify_deliveries(extract, db_rows), db_rows, batch_codes )
 * (build_oracle.py::oracle_deliveries). So this file exposes:
 *   - classifyDeliveries(...)  → the raw classifier result (summary/new/changed/noop/malformed)
 *   - applyDeliveriesGuard(...) → re-routes `new` into inserts / flagged / dup_noops,
 *     leaving summary/changed/noop/malformed UNTOUCHED (the guard does `dict(classified)`
 *     then only overrides new/flagged/dup_noops — summary keeps the RAW pre-guard counts).
 *
 * PARITY-CRITICAL:
 *   - norm_int here TRUNCATES (normIntTrunc), matching classify_deliveries.norm_int
 *     (SHARED.md porting trap #3 — do NOT use the gsheet round variant).
 *   - cost_basis is SKIPPED from field_differences when the extracted side is null.
 *   - true_weight_kg / deduction_note are NEVER diffed (additive/write-only, L-021).
 *   - The guard's L-033b hint remap MUTATES the row's batch_code in place BEFORE the
 *     L-004 collision check (so a remap can change whether L-004 fires).
 *   - Guard indices/keys/notes are byte-exact to parity_guards.py.
 */
import { normStr, normNum, normIntTrunc, normBlockLoc } from "../../lib/norm.js";
import type { DeliveryRow, ExtractResult } from "./extract.js";

// ---------------------------------------------------------------------------
// DB row + result types
// ---------------------------------------------------------------------------
export type DeliveriesDbRow = Record<string, unknown>;

export interface FieldDiff {
  field: string;
  emailValue: unknown;
  dbValue: unknown;
}

interface NewItem {
  index: unknown;
  row: DeliveryRow;
  notes?: string[];
}
interface ChangedItem {
  index: unknown;
  row: DeliveryRow;
  db_row: DeliveriesDbRow;
  diff: FieldDiff[];
}
interface NoopItem {
  index: unknown;
  natural_key: NaturalKey;
  db_id: unknown;
}
interface MalformedItem {
  row: DeliveryRow;
  reason: string;
}
interface FlaggedItem {
  kind: string;
  index: unknown;
  row: DeliveryRow;
  reason: string;
  decision: string;
  db_id?: unknown;
}
interface DupNoopItem {
  index: unknown;
  natural_key: string;
  note: string;
}

export interface ClassifyResult {
  summary: {
    extracted_total: number;
    new_count: number;
    changed_count: number;
    noop_count: number;
    malformed_count: number;
    db_rows_in_window: number;
  };
  new: NewItem[];
  changed: ChangedItem[];
  noop: NoopItem[];
  malformed: MalformedItem[];
}

/** The guard layer's output — the CLASSIFY oracle unit. */
export interface GuardedResult extends ClassifyResult {
  flagged: FlaggedItem[];
  dup_noops: DupNoopItem[];
}

// ---------------------------------------------------------------------------
// Raw classifier (classify_deliveries.py)
// ---------------------------------------------------------------------------
type NaturalKey = [unknown, unknown, string | null, number | null];

function makeNaturalKey(row: Record<string, unknown>): NaturalKey {
  return [
    row.transaction_date ?? null,
    row.batch_code ?? null,
    normBlockLoc(row.block_loc),
    normNum(row.weight_kg, 3),
  ];
}

/** Serialize a natural key tuple to a stable index-string (Python dict-key parity). */
function keyStr(k: NaturalKey): string {
  return JSON.stringify(k);
}

/** Lab comparison at 2-decimal precision (deep_lab_equal). */
function deepLabEqual(a: unknown, b: unknown): boolean {
  const ao = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  const bo = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    const va = normNum(ao[k], 2);
    const vb = normNum(bo[k], 2);
    if (va !== vb) return false;
  }
  return true;
}

function fieldDifferences(extracted: Record<string, unknown>, dbRow: Record<string, unknown>): FieldDiff[] {
  const diffs: FieldDiff[] = [];

  if (normStr(extracted.supplier) !== normStr(dbRow.supplier)) {
    diffs.push({ field: "supplier", emailValue: extracted.supplier ?? null, dbValue: dbRow.supplier ?? null });
  }

  if (normStr(extracted.truck_plate) !== normStr(dbRow.truck_plate)) {
    diffs.push({ field: "truck_plate", emailValue: extracted.truck_plate ?? null, dbValue: dbRow.truck_plate ?? null });
  }

  if (normIntTrunc(extracted.sacks) !== normIntTrunc(dbRow.sacks)) {
    diffs.push({ field: "sacks", emailValue: extracted.sacks ?? null, dbValue: dbRow.sacks ?? null });
  }

  // cost_basis: skip if extracted is null (operator file has no price column).
  if (extracted.cost_basis !== null && extracted.cost_basis !== undefined) {
    if (normNum(extracted.cost_basis, 3) !== normNum(dbRow.cost_basis, 3)) {
      diffs.push({ field: "cost_basis", emailValue: extracted.cost_basis, dbValue: dbRow.cost_basis ?? null });
    }
  }

  if (normStr(extracted.remarks) !== normStr(dbRow.remarks)) {
    diffs.push({ field: "remarks", emailValue: extracted.remarks ?? null, dbValue: dbRow.remarks ?? null });
  }

  if (!deepLabEqual(extracted.lab_results, dbRow.lab_results)) {
    diffs.push({ field: "lab_results", emailValue: extracted.lab_results ?? null, dbValue: dbRow.lab_results ?? null });
  }

  return diffs;
}

/**
 * Raw classifier. Mirrors classify_deliveries.py main() loop. `extract.rows` is the
 * tail-filtered extract; `dbRows` is dbWindow.deliveries.
 */
export function classifyDeliveries(extract: ExtractResult, dbRows: DeliveriesDbRow[]): ClassifyResult {
  const extractedRows = extract.rows;

  // Index DB rows by natural key.
  const dbIndex = new Map<string, DeliveriesDbRow[]>();
  for (const dbRow of dbRows) {
    const key = keyStr(makeNaturalKey(dbRow));
    const arr = dbIndex.get(key);
    if (arr) arr.push(dbRow);
    else dbIndex.set(key, [dbRow]);
  }

  const classifiedNew: NewItem[] = [];
  const classifiedChanged: ChangedItem[] = [];
  const classifiedNoop: NoopItem[] = [];
  const classifiedMalformed: MalformedItem[] = [];

  for (const exRow of extractedRows) {
    // MALFORMED: falsy transaction_date / batch_code / weight_kg. (Python truthiness:
    // 0 / "" / null all falsy. weight_kg is always a positive float here, but a
    // batch_code "" or null is falsy.)
    if (!exRow.transaction_date || !exRow.batch_code || !exRow.weight_kg) {
      classifiedMalformed.push({
        row: exRow,
        reason: "Missing required field (transaction_date / batch_code / weight_kg)",
      });
      continue;
    }

    const key = makeNaturalKey(exRow as unknown as Record<string, unknown>);
    const matches = dbIndex.get(keyStr(key)) ?? [];

    if (matches.length === 0) {
      classifiedNew.push({ index: exRow._source_row, row: exRow });
    } else {
      const dbRow = matches[0];
      const diffs = fieldDifferences(exRow as unknown as Record<string, unknown>, dbRow);
      if (diffs.length === 0) {
        classifiedNoop.push({
          index: exRow._source_row,
          natural_key: key,
          db_id: dbRow.id,
        });
      } else {
        classifiedChanged.push({
          index: exRow._source_row,
          row: exRow,
          db_row: dbRow,
          diff: diffs,
        });
      }
    }
  }

  return {
    summary: {
      extracted_total: extractedRows.length,
      new_count: classifiedNew.length,
      changed_count: classifiedChanged.length,
      noop_count: classifiedNoop.length,
      malformed_count: classifiedMalformed.length,
      db_rows_in_window: dbRows.length,
    },
    new: classifiedNew,
    changed: classifiedChanged,
    noop: classifiedNoop,
    malformed: classifiedMalformed,
  };
}

// ---------------------------------------------------------------------------
// Guard layer (parity_guards.py::apply_deliveries_guard)
// ---------------------------------------------------------------------------
const CONF_FLOOR = 0.7;

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const CODE_VARIANTS: Record<number, string[]> = {
  1: ["JAN"], 2: ["FEB"], 3: ["MARCH", "MAR"], 4: ["APRIL", "APR"],
  5: ["MAY"], 6: ["JUNE", "JUN"], 7: ["JULY", "JUL"], 8: ["AUG"],
  9: ["SEPT", "SEP"], 10: ["OCT"], 11: ["NOV"], 12: ["DEC"],
};

/** _norm_truck: keep only alphanumerics, uppercase. */
function normTruck(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  let out = "";
  for (const ch of s.toUpperCase()) {
    if (/[0-9A-Z]/.test(ch)) out += ch;
  }
  return out;
}

function tupleKey(parts: Array<unknown>): string {
  return JSON.stringify(parts);
}

/**
 * Python `str(float)` for the dup_noop natural_key string. Python renders an
 * integer-valued float WITH a trailing ".0" (e.g. 20640.0 → "20640.0"), whereas JS
 * `String(20640)` → "20640". Non-integer values share the shortest round-trip repr
 * in this domain, so JS String() matches for those. `weight_kg` here is always a
 * float (coerce_float). Non-number values (defensive) pass through String().
 */
function pyFloatStr(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Number.isInteger(v) ? `${v}.0` : String(v);
  }
  return String(v);
}

/**
 * apply_deliveries_guard — returns a NEW guarded result with L-033a/b + L-004 +
 * low-confidence re-routing applied. `changed`/`noop`/`malformed`/`summary` pass
 * through untouched; `new` is trimmed to genuine inserts; adds `flagged` + `dup_noops`.
 */
export function applyDeliveriesGuard(
  classified: ClassifyResult,
  dbRows: DeliveriesDbRow[],
  batchCodes: Set<string>,
): GuardedResult {
  // db_by_dbw: (date[:10], batch_code, norm_num(weight,3)) → rows
  const dbByDbw = new Map<string, DeliveriesDbRow[]>();
  for (const r of dbRows) {
    const k = tupleKey([
      String(r.transaction_date ?? "").slice(0, 10),
      r.batch_code ?? null,
      normNum(r.weight_kg, 3),
    ]);
    const arr = dbByDbw.get(k);
    if (arr) arr.push(r);
    else dbByDbw.set(k, [r]);
  }

  // db_by_dtw: (date[:10], norm_truck(truck), norm_num(weight,3)) → rows
  const dbByDtw = new Map<string, DeliveriesDbRow[]>();
  for (const r of dbRows) {
    const k = tupleKey([
      String(r.transaction_date ?? "").slice(0, 10),
      normTruck(r.truck_plate),
      normNum(r.weight_kg, 3),
    ]);
    const arr = dbByDtw.get(k);
    if (arr) arr.push(r);
    else dbByDtw.set(k, [r]);
  }

  const piledInHint = (row: DeliveryRow): string | null => {
    const remarks = String(row.remarks ?? "");
    const m = /PILED\s+IN\s+([A-Z]+)\.?\s+BLOCK\s*(\d+)/i.exec(remarks);
    if (!m) return null;
    const word = m[1].toUpperCase();
    const blk = parseInt(m[2], 10);
    // mnum = first (prefix, n) in _MONTHS where word.startsWith(prefix).
    let mnum: number | null = null;
    for (const [p, n] of Object.entries(MONTHS)) {
      if (word.startsWith(p)) {
        mnum = n;
        break;
      }
    }
    if (!mnum) return null;
    const txn = String(row.transaction_date ?? "").slice(0, 10);
    const ty = parseInt(txn.slice(0, 4), 10);
    const tm = parseInt(txn.slice(5, 7), 10);
    if (Number.isNaN(ty) || Number.isNaN(tm)) return null;
    const year = mnum > tm ? ty - 1 : ty;
    const yy = String(year).slice(2);
    for (const v of CODE_VARIANTS[mnum]) {
      const cand = `${v}-${yy}-BLK${blk}`;
      if (batchCodes.has(cand)) return cand;
    }
    return null;
  };

  const inserts: NewItem[] = [];
  const flagged: FlaggedItem[] = [];
  const dupNoops: DupNoopItem[] = [];

  for (const item of classified.new) {
    const r = item.row;
    const kd = tupleKey([
      String(r.transaction_date ?? "").slice(0, 10),
      normTruck(r.truck_plate),
      normNum(r.weight_kg, 3),
    ]);
    const dups = normTruck(r.truck_plate) ? (dbByDtw.get(kd) ?? []) : [];
    const sameLoc = dups.filter(
      (d) => normBlockLoc(d.block_loc) === normBlockLoc(r.block_loc),
    );
    if (sameLoc.length) {
      const dbBc = sameLoc[0].batch_code;
      if (dbBc !== r.batch_code) {
        dupNoops.push({
          index: item.index,
          natural_key: `${r.transaction_date}|${r.truck_plate}|${pyFloatStr(r.weight_kg)}`,
          note:
            `L-033: same truckload already recorded as ${dbBc} — ` +
            `extractor-derived name ${r.batch_code} is a month-boundary phantom.`,
        });
        continue;
      }
    } else if (dups.length) {
      flagged.push({
        kind: "L033_cross_batch_loc_mismatch",
        index: item.index,
        row: r,
        reason:
          `Same date/truck/weight exists as ${dups[0].batch_code} at ` +
          `block_loc=${dups[0].block_loc} (report says ${r.block_loc}) — ` +
          `same truckload under a different name AND location; needs a human.`,
        decision: "skip",
      });
      continue;
    }

    const hint = piledInHint(r);
    if (hint && hint !== r.batch_code) {
      if (!item.notes) item.notes = [];
      item.notes.push(
        `L-033: batch re-mapped ${r.batch_code} → ${hint} per remark 'PILED IN … BLOCK …'`,
      );
      r.batch_code = hint;
    }

    const k = tupleKey([
      String(r.transaction_date ?? "").slice(0, 10),
      r.batch_code ?? null,
      normNum(r.weight_kg, 3),
    ]);
    const collision = (dbByDbw.get(k) ?? []).filter(
      (d) => normBlockLoc(d.block_loc) !== normBlockLoc(r.block_loc),
    );
    if (collision.length) {
      flagged.push({
        kind: "L004_block_loc_correction",
        index: item.index,
        row: r,
        db_id: collision[0].id,
        reason:
          `Same date/batch/weight exists at block_loc=${collision[0].block_loc} ` +
          `(sheet says ${r.block_loc}) — block_loc correction, not a new delivery.`,
        decision: "skip",
      });
    } else if ((r.confidence ?? 1.0) < CONF_FLOOR) {
      flagged.push({
        kind: "low_confidence",
        index: item.index,
        row: r,
        reason: `confidence ${r.confidence} < ${CONF_FLOOR}`,
        decision: "skip",
      });
    } else {
      inserts.push(item);
    }
  }

  // out = dict(classified); out["new"]=inserts; out["flagged"]=flagged; out["dup_noops"]=dup_noops.
  // summary / changed / noop / malformed pass through UNTOUCHED (raw pre-guard counts).
  return {
    ...classified,
    new: inserts,
    flagged,
    dup_noops: dupNoops,
  };
}
