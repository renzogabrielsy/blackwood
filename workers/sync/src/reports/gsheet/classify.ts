/**
 * classify.ts — TS port of `.claude/skills/sync-ictc/scripts/classify_gsheet.py`
 * (read as spec, alongside specs/gsheet.md §3).
 *
 * Forward-only alignment of Sheet RC IN / RC OUT against the live DB snapshot.
 * PROPOSE/dry-run only: emits buckets, never writes. LOCKED POLICY (Renzo
 * 2026-05-30): 2025-scope floor, Sheet-wins on MATERIAL diffs, conflict guardrail
 * FLAGGED (never auto-insert, never delete), UNMAPPED never auto-creates a batch.
 *
 * PARITY DISCIPLINE: bug-for-bug against the Python oracle. The materiality gate
 * ports the CODE behavior, not the stale docstring (PORTING_DECISIONS #1 /
 * SHARED.md trap #1: `_lab_diff_is_immaterial({mc:11.5},{mc:11})` → MATERIAL).
 * `norm_int` here ROUNDS (int(round(float))) — the gsheet variant (normIntRound),
 * NOT the deliveries truncating variant (PORTING_DECISIONS #6). All rounding via
 * lib/norm (banker's); Math.round is banned.
 */
import { normStr, normBlockLoc, normNum, normIntRound } from "../../lib/norm.js";
import type { RowDict } from "./deductions.js";

// classify_gsheet.py:70-74
const WEIGHT_TOL_KG = 1.0;
const AGG_TOL_KG = 50.0;

export interface DiffEntry {
  field: string;
  sheetValue: unknown;
  dbValue: unknown;
}

export type DeliveryDbRow = Record<string, unknown>;
export type RcOutDbRow = Record<string, unknown>;
export type BatchLookup = Record<string, string>;

// ---------------------------------------------------------------------------
// deep_lab_equal (classify_gsheet.py:112-119)
// ---------------------------------------------------------------------------
function deepLabEqual(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  const aa = a ?? {};
  const bb = b ?? {};
  const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
  for (const k of keys) {
    if (normNum(aa[k], 2) !== normNum(bb[k], 2)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// _lab_diff_is_immaterial (classify_gsheet.py:125-155) — CODE behavior (PD #1)
// ---------------------------------------------------------------------------
function labDiffIsImmaterial(
  sheetLab: Record<string, unknown> | null | undefined,
  dbLab: Record<string, unknown> | null | undefined,
): boolean {
  const a = sheetLab ?? {};
  const b = dbLab ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = normNum(a[k], 2);
    const vb = normNum(b[k], 2);
    if (va === vb) continue;
    // null <-> 0 padding
    if ((va === null && vb === 0) || (vb === null && va === 0)) continue;
    // one side missing entirely
    if (va === null || vb === null) {
      const present = vb === null ? va : vb;
      if (normNum(present, 0) === 0) continue;
      return false;
    }
    // both present: immaterial only if equal at integer precision
    if (normNum(va, 0) !== normNum(vb, 0)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// is_material (classify_gsheet.py:158-188)
// ---------------------------------------------------------------------------
function isMaterial(diffs: DiffEntry[]): [boolean, string | null] {
  if (!diffs.length) return [false, null];
  const skipped: string[] = [];
  for (const d of diffs) {
    const f = d.field;
    if (f === "sacks") {
      const sv = normIntRound(d.sheetValue);
      const dv = normIntRound(d.dbValue);
      if ((sv === null && dv === 0) || (dv === null && sv === 0)) {
        skipped.push("sacks(null↔0)");
        continue;
      }
      return [true, null];
    }
    if (f === "lab_results") {
      if (
        labDiffIsImmaterial(
          d.sheetValue as Record<string, unknown> | null,
          d.dbValue as Record<string, unknown> | null,
        )
      ) {
        skipped.push("lab(rounding)");
        continue;
      }
      return [true, null];
    }
    // any other field is inherently material
    return [true, null];
  }
  // every diff was demoted: "immaterial: " + ", ".join(sorted(set(skipped)))
  const uniqSorted = [...new Set(skipped)].sort();
  return [false, "immaterial: " + uniqSorted.join(", ")];
}

// ---------------------------------------------------------------------------
// Batch resolution (classify_gsheet.py:194-215)
// ---------------------------------------------------------------------------
function resolveAgainstSet(row: RowDict, codeSet: Set<string>): [string | null, string | null] {
  const primary = (row.batch_code_primary as string | null | undefined) ?? null;
  if (primary && codeSet.has(primary)) return [primary, primary];
  const fbs = (row.batch_code_fallbacks as string[] | undefined) ?? [];
  for (const fb of fbs) {
    if (codeSet.has(fb)) return [fb, fb];
  }
  return [primary, null];
}

function resolveBatchId(row: RowDict, lookup: BatchLookup): [string | null, string | null] {
  const primary = (row.batch_code_primary as string | null | undefined) ?? null;
  if (primary && primary in lookup) return [lookup[primary], primary];
  const fbs = (row.batch_code_fallbacks as string[] | undefined) ?? [];
  for (const fb of fbs) {
    if (fb in lookup) return [lookup[fb], fb];
  }
  return [null, null];
}

// ---------------------------------------------------------------------------
// Diff functions (classify_gsheet.py:221-269)
// ---------------------------------------------------------------------------
function rcInDiffs(ex: RowDict, db: DeliveryDbRow): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  if (normStr(ex.supplier) !== normStr(db.supplier)) {
    diffs.push({ field: "supplier", sheetValue: ex.supplier, dbValue: db.supplier });
  }
  if (normStr(ex.truck_plate) !== normStr(db.truck_plate)) {
    diffs.push({ field: "truck_plate", sheetValue: ex.truck_plate, dbValue: db.truck_plate });
  }
  if (normIntRound(ex.sacks) !== normIntRound(db.sacks)) {
    diffs.push({ field: "sacks", sheetValue: ex.sacks, dbValue: db.sacks });
  }
  // cost_basis is OUT OF SCOPE — never diffed.
  if (normStr(ex.remarks) !== normStr(db.remarks)) {
    diffs.push({ field: "remarks", sheetValue: ex.remarks, dbValue: db.remarks });
  }
  if (
    !deepLabEqual(
      (ex.lab_results as Record<string, unknown> | null) ?? null,
      (db.lab_results as Record<string, unknown> | null) ?? null,
    )
  ) {
    diffs.push({ field: "lab_results", sheetValue: ex.lab_results, dbValue: db.lab_results });
  }
  return diffs;
}

function rcOutDiffs(ex: RowDict, db: RcOutDbRow): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  const eW = normNum(ex.weight_kg, 3);
  const dW = normNum(db.weight_kg, 3);
  if (eW !== null && dW !== null && Math.abs(eW - dW) > WEIGHT_TOL_KG) {
    diffs.push({ field: "weight_kg", sheetValue: eW, dbValue: dW });
  }
  if (normStr(ex.remarks) !== normStr(db.remarks)) {
    diffs.push({ field: "remarks", sheetValue: ex.remarks, dbValue: db.remarks });
  }
  const ePb = normStr(ex.production_batch);
  const dPb = normStr(db.production_batch);
  if (ePb && dPb && ePb !== dPb) {
    diffs.push({
      field: "production_batch",
      sheetValue: ex.production_batch,
      dbValue: db.production_batch,
    });
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Bucket types
// ---------------------------------------------------------------------------
export interface ClassifyBundle {
  mode: "rc_in" | "rc_out";
  since: string;
  summary: {
    extracted_total: number;
    out_of_scope_count: number;
    in_scope_total: number;
    noop_count: number;
    new_count: number;
    changed_count: number;
    flagged_count: number;
    unmapped_count: number;
    malformed_count: number;
    db_rows_in_window: number;
  };
  new: RowDict[];
  changed: RowDict[];
  flagged: RowDict[];
  noop: RowDict[];
  unmapped: RowDict[];
  malformed: RowDict[];
}

export interface GsheetClassified {
  rc_in: ClassifyBundle;
  rc_out: ClassifyBundle;
}

/** _pack_rc_in / _pack_rc_out (classify_gsheet.py:376-380, 502-506). key is a list. */
function packRow(ex: RowDict, dbRow: Record<string, unknown>, diffs: DiffEntry[], key: unknown[]): RowDict {
  const base: RowDict = {
    index: ex._source_row ?? null,
    natural_key: key,
    db_id: dbRow.id ?? null,
  };
  if (diffs.length) {
    base.row = ex;
    base.db_row = dbRow;
    base.diff = diffs;
  }
  return base;
}

/**
 * _route_changed (classify_gsheet.py:383-404). Applies the materiality gate.
 * `packer` builds the packed row; `extra` (aggregation_note) is merged.
 */
function routeChanged(
  ex: RowDict,
  dbRow: Record<string, unknown>,
  diffs: DiffEntry[],
  key: unknown[],
  noop: RowDict[],
  changed: RowDict[],
  extra?: Record<string, unknown>,
): void {
  if (!diffs.length) {
    const packed = packRow(ex, dbRow, [], key);
    if (extra) Object.assign(packed, extra);
    noop.push(packed);
    return;
  }
  const [material, note] = isMaterial(diffs);
  const packed = packRow(ex, dbRow, diffs, key);
  if (extra) Object.assign(packed, extra);
  if (material) {
    changed.push(packed);
  } else {
    packed.immaterial_note = note;
    noop.push(packed);
  }
}

// ---------------------------------------------------------------------------
// RC IN classification (classify_gsheet.py:275-373)
// ---------------------------------------------------------------------------
function classifyRcIn(extracted: RowDict[], dbRows: DeliveryDbRow[], since: string): ClassifyBundle {
  const codeSet = new Set<string>();
  for (const r of dbRows) {
    const bc = r.batch_code;
    if (bc) codeSet.add(bc as string);
  }

  const exact = new Map<string, DeliveryDbRow[]>();
  const loose = new Map<string, DeliveryDbRow[]>();
  const byDateBlockWt = new Map<string, DeliveryDbRow[]>();
  for (const r of dbRows) {
    const bc = (r.batch_code as string | null | undefined) ?? null;
    const d = (r.transaction_date as string | null | undefined) ?? null;
    const bl = normBlockLoc(r.block_loc);
    const w = normNum(r.weight_kg, 3);
    push(exact, keyStr([d, bc, bl, w]), r);
    push(loose, keyStr([d, bc, bl]), r);
    push(byDateBlockWt, keyStr([d, bl, w]), r);
  }

  const newRows: RowDict[] = [];
  const changed: RowDict[] = [];
  const noop: RowDict[] = [];
  const unmapped: RowDict[] = [];
  const malformed: RowDict[] = [];
  const flagged: RowDict[] = [];
  let outOfScope = 0;

  for (const ex of extracted) {
    const d = (ex.transaction_date as string | null | undefined) ?? null;
    const w = normNum(ex.weight_kg, 3);

    if (d && d < since) {
      outOfScope += 1;
      continue;
    }
    if (!d || w === null || !ex.batch_code_primary) {
      malformed.push({ row: ex, reason: "missing date / batch_code / weight" });
      continue;
    }

    const [resolvedCode, dbMatchedCode] = resolveAgainstSet(ex, codeSet);
    const bl = normBlockLoc(ex.block_loc);

    if (dbMatchedCode === null) {
      unmapped.push({
        index: ex._source_row ?? null,
        row: ex,
        reason:
          `batch_code primary=${pyRepr(ex.batch_code_primary)} ` +
          `+ fallbacks=${pyListRepr(ex.batch_code_fallbacks as unknown[])} not in DB`,
      });
      continue;
    }

    // 1) exact natural-key hit
    const exactMatches = exact.get(keyStr([d, dbMatchedCode, bl, w])) ?? [];
    if (exactMatches.length) {
      const dbRow = exactMatches[0];
      const diffs = rcInDiffs(ex, dbRow);
      routeChanged(ex, dbRow, diffs, [d, dbMatchedCode, bl, w], noop, changed);
      continue;
    }

    // 2) tolerance / aggregation fallback
    const cands = loose.get(keyStr([d, dbMatchedCode, bl])) ?? [];
    let best: DeliveryDbRow | null = null;
    let bestDelta: number | null = null;
    for (const c of cands) {
      const cw = normNum(c.weight_kg, 3);
      if (cw === null) continue;
      const delta = Math.abs(cw - (w as number));
      if (delta <= AGG_TOL_KG && (bestDelta === null || delta < bestDelta)) {
        best = c;
        bestDelta = delta;
      }
    }
    if (best !== null) {
      const diffs = rcInDiffs(ex, best);
      const note =
        `weight matched within tolerance (sheet=${pyNum(w)}, db=${pyNum(normNum(best.weight_kg, 3))}, ` +
        `Δ=${pyNum(normNum(bestDelta, 3))}kg) — likely per-block vs per-truck aggregation`;
      routeChanged(ex, best, diffs, [d, dbMatchedCode, bl, w], noop, changed, {
        aggregation_note: note,
      });
      continue;
    }

    // 3) CONFLICT GUARDRAIL
    const collisions = (byDateBlockWt.get(keyStr([d, bl, w])) ?? []).filter(
      (c) => c.batch_code !== dbMatchedCode,
    );
    if (bl !== null && collisions.length) {
      flagged.push({
        index: ex._source_row ?? null,
        kind: "reassignment_suspected",
        row: ex,
        db_conflicts: collisions,
        reason:
          `Sheet row (${d} ${ex.batch_code_primary} @ ${bl} ${pyNum(w)}kg) would be NEW, ` +
          `but the DB already has the same date/block/weight under ` +
          `${pyListRepr(collisions.map((c) => c.batch_code))} — likely a batch reassignment, ` +
          `not an insert. Held to avoid double-count; never deletes a DB row.`,
      });
      continue;
    }

    // 4) genuinely new
    ex.batch_code_resolved = resolvedCode;
    newRows.push({ index: ex._source_row ?? null, row: ex });
  }

  return bundle("rc_in", extracted, dbRows, newRows, changed, noop, unmapped, malformed, flagged, outOfScope, since);
}

// ---------------------------------------------------------------------------
// RC OUT classification (classify_gsheet.py:410-499)
// ---------------------------------------------------------------------------
function classifyRcOut(
  extracted: RowDict[],
  dbRows: RcOutDbRow[],
  lookup: BatchLookup,
  since: string,
): ClassifyBundle {
  const dbIndex = new Map<string, RcOutDbRow[]>();
  const byDateDestWt = new Map<string, RcOutDbRow[]>();
  for (const r of dbRows) {
    const dest = (r.destination as string | null | undefined) || "MAIN";
    push(dbIndex, keyStr([r.transaction_date ?? null, r.batch_id ?? null, dest]), r);
    push(byDateDestWt, keyStr([r.transaction_date ?? null, dest, normNum(r.weight_kg, 3)]), r);
  }

  const consumed = new Map<string, number>();

  const newRows: RowDict[] = [];
  const changed: RowDict[] = [];
  const noop: RowDict[] = [];
  const unmapped: RowDict[] = [];
  const malformed: RowDict[] = [];
  const flagged: RowDict[] = [];
  let outOfScope = 0;

  for (const ex of extracted) {
    const d = (ex.transaction_date as string | null | undefined) ?? null;
    const w = ex.weight_kg as number | null | undefined;

    if (d && d < since) {
      outOfScope += 1;
      continue;
    }
    if (!d) {
      malformed.push({ row: ex, reason: "missing transaction_date" });
      continue;
    }
    if (w === null || w === undefined || Number(w) === 0) {
      malformed.push({ row: ex, reason: "missing or zero weight" });
      continue;
    }

    const [batchId, codeUsed] = resolveBatchId(ex, lookup);
    if (batchId === null) {
      unmapped.push({
        index: ex._source_row ?? null,
        row: ex,
        reason:
          `batch_code primary=${pyRepr(ex.batch_code_primary)} ` +
          `+ fallbacks=${pyListRepr(ex.batch_code_fallbacks as unknown[])} -> no batch_id`,
      });
      continue;
    }

    ex.batch_id = batchId;
    ex.batch_code_resolved = codeUsed;
    const dest = (ex.destination as string | null | undefined) || "MAIN";
    const key = keyStr([d, batchId, dest]);
    const matches = dbIndex.get(key) ?? [];

    if (!matches.length) {
      const collisions = (byDateDestWt.get(keyStr([d, dest, normNum(w, 3)])) ?? []).filter(
        (c) => c.batch_id !== batchId,
      );
      if (collisions.length) {
        flagged.push({
          index: ex._source_row ?? null,
          kind: "reassignment_suspected",
          row: ex,
          db_conflicts: collisions,
          reason:
            `Sheet feed (${d} ${ex.batch_code_resolved} ${dest} ${pyNum(normNum(w, 3))}kg) would ` +
            `be NEW, but the DB already has the same date/dest/weight under a different ` +
            `batch_id (${pyListRepr(collisions.map((c) => c.id))}) — likely a batch reassignment, ` +
            `not an insert. Held to avoid double-count; never deletes a DB row.`,
        });
        continue;
      }
      newRows.push({ index: ex._source_row ?? null, row: ex });
      continue;
    }

    // Pick the closest-weight DB row among matches, preferring unconsumed.
    const start = consumed.get(key) ?? 0;
    const pool = matches.slice(start).length ? matches.slice(start) : matches;
    let best: RcOutDbRow | null = null;
    let bestDelta: number | null = null;
    const ew = normNum(w, 3);
    for (const c of pool) {
      const cw = normNum(c.weight_kg, 3);
      const delta = Math.abs((cw ?? 0) - (ew ?? 0));
      if (bestDelta === null || delta < bestDelta) {
        best = c;
        bestDelta = delta;
      }
    }
    consumed.set(key, start + 1);

    const diffs = rcOutDiffs(ex, best as RcOutDbRow);
    routeChanged(ex, best as RcOutDbRow, diffs, [d, batchId, dest], noop, changed);
  }

  return bundle("rc_out", extracted, dbRows, newRows, changed, noop, unmapped, malformed, flagged, outOfScope, since);
}

// ---------------------------------------------------------------------------
// Shared bundling (classify_gsheet.py:512-536)
// ---------------------------------------------------------------------------
function bundle(
  mode: "rc_in" | "rc_out",
  extracted: RowDict[],
  dbRows: Record<string, unknown>[],
  newRows: RowDict[],
  changed: RowDict[],
  noop: RowDict[],
  unmapped: RowDict[],
  malformed: RowDict[],
  flagged: RowDict[],
  outOfScope: number,
  since: string,
): ClassifyBundle {
  return {
    mode,
    since,
    summary: {
      extracted_total: extracted.length,
      out_of_scope_count: outOfScope,
      in_scope_total: extracted.length - outOfScope,
      noop_count: noop.length,
      new_count: newRows.length,
      changed_count: changed.length,
      flagged_count: flagged.length,
      unmapped_count: unmapped.length,
      malformed_count: malformed.length,
      db_rows_in_window: dbRows.length,
    },
    new: newRows,
    changed,
    flagged,
    noop,
    unmapped,
    malformed,
  };
}

/**
 * Top-level classify: runs BOTH modes (mirrors the oracle, which classifies rc_in
 * AND rc_out regardless of opts.mode) and returns the composed {rc_in, rc_out}.
 */
export function classifyGsheet(
  extract: { rc_in: { rows: RowDict[] }; rc_out: { rows: RowDict[] } },
  db: { deliveries: DeliveryDbRow[]; rc_out: RcOutDbRow[]; batchLookup: BatchLookup },
  since: string,
): GsheetClassified {
  return {
    rc_in: classifyRcIn(extract.rc_in.rows, db.deliveries, since),
    rc_out: classifyRcOut(extract.rc_out.rows, db.rc_out, db.batchLookup, since),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stable string key from a tuple of parts, matching Python dict-tuple
 *  keying (null/undefined → one "missing" token = Python None; number vs string
 *  tagged so 20000 the number and "20000" the string never collide). */
function keyStr(parts: unknown[]): string {
  return parts
    .map((p) =>
      p === null || p === undefined
        ? " null"
        : typeof p === "number"
          ? "n:" + p
          : "s:" + String(p),
    )
    .join("");
}

function push<T>(m: Map<string, T[]>, k: string, v: T): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/** Python repr() of a string/None as it appears inside an f-string (single quotes
 *  for str, "None" for null). Only used in UNMAPPED/flagged reason strings. */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return `'${v}'`;
  return String(v);
}

/** Python repr() of a list, e.g. ['A', 'B'] or [] — single-quoted string elements. */
function pyListRepr(arr: unknown[] | null | undefined): string {
  if (!arr) return "None";
  const parts = arr.map((x) => {
    if (x === null || x === undefined) return "None";
    if (typeof x === "string") return `'${x}'`;
    return String(x);
  });
  return "[" + parts.join(", ") + "]";
}

/** Python str() of a number/None for interpolation into notes (str(None)="None",
 *  integer-valued float keeps ".0"). Used only in aggregation_note / flagged text. */
function pyNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "None";
  if (Number.isInteger(v)) return `${v}.0`;
  return String(v);
}
