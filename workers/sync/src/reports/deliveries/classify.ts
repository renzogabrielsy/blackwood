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
 * ─────────────────────────────────────────────────────────────────────────────
 * L-040b (2026-08-08) — THE IDENTITY IS NOW TWO-TIER
 * ─────────────────────────────────────────────────────────────────────────────
 * The natural key used to be `(transaction_date, batch_code, block_loc, weight_kg)`:
 * no truck plate, and three facts a human corrects. Correct any one of them and this
 * classifier stopped recognising the row and reported it NEW — which is how the sync
 * inserted duplicate copies of the 2026-02-04 block swap and of every `FEEDING # 1` /
 * `JULY-26-FEED1` spelling mismatch. Identity now comes from ONE shared module,
 * `lib/deliveryIdentity.ts` (see its header for the measurements and the two safety
 * properties); `reports/gsheet/classify.ts` uses the same module, so the two writers
 * of `deliveries` cannot disagree about what "the same row" is.
 *
 * Two consequences live in THIS file:
 *   - `batch_code` / `block_loc` / `weight_kg` are now COMPARED (they left the key, so
 *     without this a corrected batch code would match and then read as a silent NOOP).
 *   - A match whose diff touches any of those three is NOT a `changed` row (which
 *     auto-applies). It goes to the new `identity_diff` bucket, which the guard folds
 *     into `flagged` → held → Sync Review, for a human to arbitrate.
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
import { batchCodeAliasEqual, resolveKnownBatchCodeAlias } from "../../lib/batchCodeAlias.js";
import { normPlate } from "../../lib/deliveryIdentity.js";
import {
  buildDeliveryIdentityIndex,
  isMutableIdentityField,
  matchDelivery,
  type DeliveryIdentityTier,
} from "../../lib/deliveryIdentity.js";
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
  /** Which tier the row matched on (1 = plate+sacks, 2 = legacy key). L-040b. */
  matched_tier: DeliveryIdentityTier;
}
/**
 * A match whose diff touches `batch_code` / `block_loc` / `weight_kg` — the three facts
 * a human corrects. NEVER auto-applied: the guard folds these into `flagged` so they
 * become held rows a human arbitrates in Sync Review (L-040b).
 */
interface IdentityDiffItem extends ChangedItem {
  /** The subset of `diff` that is a formerly-key field. Always non-empty. */
  identity_fields: string[];
  /** DB rows sharing the matched key. >1 = a duplicate already in the DB. */
  peer_count: number;
}
interface NoopItem {
  index: unknown;
  natural_key: string;
  matched_tier: DeliveryIdentityTier;
  db_id: unknown;
}
interface MalformedItem {
  row: DeliveryRow;
  reason: string;
}
/**
 * A row that is not BROKEN, only NOT FILLED IN YET (L-042, 2026-08-13).
 *
 * MC books overnight weights in early with the truck plate, the weight and the moisture,
 * and assigns the pile later in the day. Such a row has an EMPTY Block cell, so it carries
 * no `operator_batch_label` and therefore no `batch_code` — and the old malformed guard
 * called that "malformed", i.e. reported an ordinary, self-clearing stage of the operator's
 * day as bad data. Two rows were reported malformed on 2026-08-12 and had filled themselves
 * in by morning.
 *
 * This is a SEPARATE, quieter class. It is never held, never blocks the watermark, and it
 * is NOT a widening of `malformed`: an ORPHAN wet-recovery sub-row (a continuation row with
 * no mother delivery to inherit from) has the same missing batch code and stays MALFORMED
 * and loud — see `isAwaitingBatchAssignment`.
 */
interface AwaitingAssignmentItem {
  index: unknown;
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
    identity_diff_count: number;
    noop_count: number;
    malformed_count: number;
    /** L-042 — rows waiting on the operator to assign a pile. Never held. */
    awaiting_assignment_count: number;
    db_rows_in_window: number;
  };
  new: NewItem[];
  changed: ChangedItem[];
  /** L-040b — matches disagreeing on a formerly-key field. Human-arbitrated. */
  identity_diff: IdentityDiffItem[];
  noop: NoopItem[];
  malformed: MalformedItem[];
  /** L-042 — "not filled in yet", split out of `malformed`. Self-clearing. */
  awaiting_assignment: AwaitingAssignmentItem[];
}

/** The guard layer's output — the CLASSIFY oracle unit. */
export interface GuardedResult extends ClassifyResult {
  flagged: FlaggedItem[];
  dup_noops: DupNoopItem[];
}

// ---------------------------------------------------------------------------
// Raw classifier (classify_deliveries.py)
// ---------------------------------------------------------------------------
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

  // L-040b — the three formerly-key fields. Compared FIRST so the diff list reads
  // identity-first. On a tier-2 (legacy-key) match these are equal by construction, so
  // they cost nothing; on a tier-1 match a difference here IS the human correction the
  // old key could not see.
  // L-042 — a MONTH-PREFIX ALIAS IS NOT A DISAGREEMENT. `AUGUST-26-FEED1` and
  // `AUG-26-FEED1` are one batch spelled two ways (`lib/batchCodeAlias.ts`), and the
  // project has always known the table. Comparing raw strings here is what turned MC's
  // `FEEDING # 1` shorthand into a `cross_batch_reassignment` held case asking a human to
  // arbitrate between two spellings of the same thing. Different MONTHS still differ:
  // `JULY-26-BLK9` vs `JUNE-26-BLK9` (the L-033 month-boundary phantom, and both
  // deliveries parity fixtures) is untouched.
  if (!batchCodeAliasEqual(extracted.batch_code, dbRow.batch_code)) {
    diffs.push({ field: "batch_code", emailValue: extracted.batch_code ?? null, dbValue: dbRow.batch_code ?? null });
  }
  if (normBlockLoc(extracted.block_loc) !== normBlockLoc(dbRow.block_loc)) {
    diffs.push({ field: "block_loc", emailValue: extracted.block_loc ?? null, dbValue: dbRow.block_loc ?? null });
  }
  if (normNum(extracted.weight_kg, 3) !== normNum(dbRow.weight_kg, 3)) {
    diffs.push({ field: "weight_kg", emailValue: extracted.weight_kg ?? null, dbValue: dbRow.weight_kg ?? null });
  }

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
 * Is this row merely AWAITING THE OPERATOR'S PILE ASSIGNMENT rather than malformed?
 * (L-042, 2026-08-13.) The whole point of this predicate is where it says NO.
 *
 * All four clauses must hold:
 *   1. It has a `transaction_date` (forward-filled counts — a row with no date and no
 *      prior date is dropped by the extractor and never reaches here).
 *   2. It has a real `weight_kg`. A 0 weight is a data problem, not a pending assignment.
 *   3. Its `batch_code` is missing BECAUSE THE BLOCK CELL WAS EMPTY — `operator_batch_label`
 *      is null. A label that EXISTS but did not translate comes back as the raw label
 *      (truthy `batch_code`), so it never reaches the malformed guard at all; and a label
 *      that is present must never be silenced by this class.
 *   4. It carries a TRUCK PLATE. This is the clause that keeps MALFORMED loud: an ORPHAN
 *      wet-recovery sub-row is defined by having NO plate, no batch code and no block
 *      (`deductions.ts::isRecoveryRowDict`), so it fails here and stays malformed. When we
 *      cannot tell the two apart — no plate AND no label — the LOUD answer wins.
 */
export function isAwaitingBatchAssignment(row: DeliveryRow): boolean {
  if (!row.transaction_date) return false;
  if (!row.weight_kg) return false;
  if (row.batch_code) return false;
  if (row.operator_batch_label !== null && row.operator_batch_label !== undefined) return false;
  if (normPlate(row.truck_plate) === "") return false;
  return true;
}

/**
 * Raw classifier. Mirrors classify_deliveries.py main() loop. `extract.rows` is the
 * tail-filtered extract; `dbRows` is dbWindow.deliveries.
 */
export function classifyDeliveries(extract: ExtractResult, dbRows: DeliveriesDbRow[]): ClassifyResult {
  const extractedRows = extract.rows;

  // L-040b — index DB rows under BOTH tiers (see lib/deliveryIdentity.ts).
  const dbIndex = buildDeliveryIdentityIndex(dbRows);

  const classifiedNew: NewItem[] = [];
  const classifiedChanged: ChangedItem[] = [];
  const classifiedIdentityDiff: IdentityDiffItem[] = [];
  const classifiedNoop: NoopItem[] = [];
  const classifiedMalformed: MalformedItem[] = [];
  const classifiedAwaiting: AwaitingAssignmentItem[] = [];

  for (const exRow of extractedRows) {
    // MALFORMED: falsy transaction_date / batch_code / weight_kg. (Python truthiness:
    // 0 / "" / null all falsy. weight_kg is always a positive float here, but a
    // batch_code "" or null is falsy.)
    if (!exRow.transaction_date || !exRow.batch_code || !exRow.weight_kg) {
      // L-042 — "not filled in yet" is not "malformed". Split out FIRST, but only for the
      // one narrowly-defined shape; everything else, including an orphan wet-recovery
      // sub-row, falls through to MALFORMED exactly as before.
      if (isAwaitingBatchAssignment(exRow)) {
        classifiedAwaiting.push({
          index: exRow._source_row,
          row: exRow,
          reason: "No pile assigned yet (the Block cell is empty)",
        });
        continue;
      }
      classifiedMalformed.push({
        row: exRow,
        reason: "Missing required field (transaction_date / batch_code / weight_kg)",
      });
      continue;
    }

    const match = matchDelivery(dbIndex, exRow as unknown as Record<string, unknown>);

    if (match === null) {
      classifiedNew.push({ index: exRow._source_row, row: exRow });
    } else {
      const dbRow = match.rows[0];
      const diffs = fieldDifferences(exRow as unknown as Record<string, unknown>, dbRow);
      if (diffs.length === 0) {
        classifiedNoop.push({
          index: exRow._source_row,
          natural_key: match.key,
          matched_tier: match.matchedTier,
          db_id: dbRow.id,
        });
      } else {
        const identityFields = diffs.map((d) => d.field).filter(isMutableIdentityField);
        if (identityFields.length) {
          // A formerly-key field disagrees → a human correction one source has not
          // caught up with. NEVER auto-applied (CLAUDE.md → Sync Integrity).
          classifiedIdentityDiff.push({
            index: exRow._source_row,
            row: exRow,
            db_row: dbRow,
            diff: diffs,
            matched_tier: match.matchedTier,
            identity_fields: identityFields,
            peer_count: match.peerCount,
          });
        } else {
          classifiedChanged.push({
            index: exRow._source_row,
            row: exRow,
            db_row: dbRow,
            diff: diffs,
            matched_tier: match.matchedTier,
          });
        }
      }
    }
  }

  return {
    summary: {
      extracted_total: extractedRows.length,
      new_count: classifiedNew.length,
      changed_count: classifiedChanged.length,
      identity_diff_count: classifiedIdentityDiff.length,
      noop_count: classifiedNoop.length,
      malformed_count: classifiedMalformed.length,
      awaiting_assignment_count: classifiedAwaiting.length,
      db_rows_in_window: dbRows.length,
    },
    new: classifiedNew,
    changed: classifiedChanged,
    identity_diff: classifiedIdentityDiff,
    noop: classifiedNoop,
    malformed: classifiedMalformed,
    awaiting_assignment: classifiedAwaiting,
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
 *
 * L-040b: every `identity_diff` row is ALSO appended to `flagged` (kind
 * `L040_identity_diff`, decision `skip`) so `apply.ts` holds it with no change to the
 * apply layer. The `identity_diff` bucket itself is preserved for visibility.
 * Note this makes L-033a a narrower BACKSTOP than it was: a plated row whose sacks match
 * an existing row is now resolved as an identity diff by the classifier and never
 * reaches the guard's `new` loop at all — which is strictly better, because L-033a's
 * `dup_noop` outcome was a SILENT skip and this one asks a human.
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

    // L-042 — PREFER THE SPELLING THE DATABASE ACTUALLY USES. Runs AFTER the L-033b hint
    // (a remark naming the pile is stronger evidence than a spelling convention) and BEFORE
    // the L-004 collision check, exactly like the hint itself.
    //
    // Why this is part of the same change: the extractor derives a FEED code from the
    // delivery month using the FULL month name (`AUGUST-26-FEED3`), while the live
    // convention for August feed batches is `AUG-26-FEED3`. Without this, widening the
    // FEEDING label would stop the sync creating an obviously-junk batch named
    // `FEEDING # 3` (it created `FEEDING # 1` and `FEEDING # 2` for real, and they still
    // sit in `batches` holding phantom weight) and start it creating a
    // plausible-looking-but-duplicate `AUGUST-26-FEED3` instead — trading a loud wrong for
    // a quiet one, which this ledger keeps recording as the worse outcome.
    //
    // It can ONLY ever point at a batch that ALREADY EXISTS, and never overrides a code
    // that already resolves — the same safety property as the L-033b hint.
    const aliased = resolveKnownBatchCodeAlias(r.batch_code, batchCodes);
    if (aliased) {
      if (!item.notes) item.notes = [];
      item.notes.push(
        `L-042: batch re-spelled ${r.batch_code} → ${aliased} (the same batch under the ` +
          `month-prefix convention the database uses)`,
      );
      r.batch_code = aliased;
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

  // L-040b — fold the identity diffs into `flagged` so apply holds them. Appended
  // AFTER the `new`-loop flags so the guard's own ordering is untouched.
  for (const item of classified.identity_diff) {
    flagged.push({
      kind: "L040_identity_diff",
      index: item.index,
      row: item.row,
      db_id: item.db_row.id,
      reason: identityDiffReason(item),
      decision: "skip",
    });
  }

  // out = dict(classified); out["new"]=inserts; out["flagged"]=flagged; out["dup_noops"]=dup_noops.
  // summary / changed / noop / malformed / awaiting_assignment pass through UNTOUCHED (raw
  // pre-guard counts). `awaiting_assignment` deliberately gets NO guard treatment: there is
  // nothing to write and nothing to hold — it is a visibility channel only (L-042).
  return {
    ...classified,
    new: inserts,
    flagged,
    dup_noops: dupNoops,
  };
}

/**
 * The human-readable refusal for an identity diff. Names BOTH sides of every disagreeing
 * field, because the whole point is that a person decides which source is right.
 * Carries NO ₱ value (`cost_basis` is never an identity field, and this string is shown
 * to every privileged role).
 */
function identityDiffReason(item: IdentityDiffItem): string {
  const who =
    item.matched_tier === 1
      ? `same truck + sack count (${item.row.truck_plate ?? "?"}, ${item.row.sacks ?? "?"} sacks) on ${String(item.row.transaction_date).slice(0, 10)}`
      : `same date/batch/block/weight`;
  const parts = item.diff
    .filter((d) => isMutableIdentityField(d.field))
    .map((d) => `${d.field}: report says ${fmtSide(d.emailValue)}, app has ${fmtSide(d.dbValue)}`);
  const peer =
    item.peer_count > 1
      ? ` NOTE: the app already holds ${item.peer_count} rows for this one truckload — a ` +
        `duplicate that predates this run.`
      : "";
  return (
    `L-040: this is the SAME delivery as an existing row (matched on ${who}), but the ` +
    `two sources disagree on ${parts.join("; ")}. One side is a human correction the ` +
    `other has not caught up with — never auto-applied; a person picks the winner.` +
    peer
  );
}

function fmtSide(v: unknown): string {
  return v === null || v === undefined || v === "" ? "(blank)" : String(v);
}
