/**
 * classify.ts — TS port of `.claude/skills/sync-ictc/scripts/classify_flecon_bags.py`
 * (read as spec, alongside specs/flecon.md §3).
 *
 * DAY-SET / REPLACE-BY-DATE model. A bag-movement register legitimately repeats
 * identical rows within a day, so there is NO per-row natural key. The unit of
 * comparison is the WHOLE DAY as a MULTISET of (particular, bag_type_code, qty_delta).
 *
 *   date absent in DB          → NEW            (full day payload for INSERT)
 *   present, multisets equal   → DUPLICATE_NOOP (counted only, never dumped)
 *   present, multisets differ  → DATE_CHANGED   (full day payload for REPLACE)
 *
 * db_present is a KEY-MEMBERSHIP check, NOT array-non-empty (flecon.md §3 / porting
 * trap #5): a date whose DB rows are all < since is genuinely absent from db_by_date.
 */
import type {
  FleconExtract,
  FleconMovement,
  ColumnMapEntry,
  UnmappedColumn,
  MissingColumn,
} from "./extract.js";
import { roundHalfToEven } from "../../lib/norm.js";

// ---------------------------------------------------------------------------
// DB-window row shapes (offline snapshot the classify step consumes).
// ---------------------------------------------------------------------------
export interface DbMovementRow {
  id?: unknown;
  transaction_date?: unknown;
  particular?: unknown;
  bag_type_id?: unknown;
  bag_type_code?: unknown;
  qty_delta?: unknown;
  [k: string]: unknown;
}
export interface BagTypeRow {
  id: unknown;
  code: unknown;
}
export interface ViewBalanceRow {
  code?: unknown;
  balance?: unknown;
  [k: string]: unknown;
}

export interface PerDateEntry {
  transaction_date: string;
  class: "NEW" | "DATE_CHANGED";
  sheet_movement_count: number;
  db_movement_count: number;
  delta: { added: DeltaRow[]; removed: DeltaRow[] };
  movements: FleconMovement[];
}
interface DeltaRow {
  particular: string;
  bag_type_code: string;
  qty_delta: number;
  count: number;
}

export interface BalanceCrosscheckRow {
  code: string;
  db_view_balance: number | null;
  sheet_snapshot_balance: number | null;
  drift: number | null;
}

export interface FleconClassified {
  table: "flecon_bag_movements";
  since: string;
  model: "REPLACE_BY_DATE";
  per_date: PerDateEntry[];
  code_to_id: Record<string, unknown>;
  balance_crosscheck: {
    available: boolean;
    rows: BalanceCrosscheckRow[];
    note: string | null;
  };
  column_flags: {
    flagged: boolean;
    unmapped_columns: UnmappedColumn[];
    missing_columns: MissingColumn[];
    column_map: ColumnMapEntry[];
    note: string;
  };
  summary: {
    new_days: number;
    date_changed_days: number;
    duplicate_noop_days: number;
    total_days_in_window: number;
    sheet_movements_in_window: number;
    db_movements_in_window: number;
    unmapped_columns: number;
    missing_columns: number;
    column_map_size: number;
  };
}

// ---------------------------------------------------------------------------
// Normalization / day-set signature (classify_flecon_bags.py lines 67-90)
// ---------------------------------------------------------------------------

/** norm_particular (line 67): None→"", else uppercase + collapse ALL whitespace. */
export function normParticular(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s).toUpperCase().split(/\s+/).filter((x) => x.length > 0).join(" ");
}

/** movement_sig (line 76): (particular^, code^, int(round(float(qty)))) as a tuple key. */
export function movementSig(m: { particular?: unknown; bag_type_code?: unknown; qty_delta?: unknown }): string {
  let qty: number;
  const raw = m.qty_delta;
  const f = toFloat(raw);
  if (f === null) qty = 0;
  else qty = Math.trunc(roundHalfToEven(f, 0)); // int(round(float(x)))
  const code = String(m.bag_type_code ?? "").trim().toUpperCase();
  // Encode the 3-tuple as a stable, collision-free string key for the multiset.
  return JSON.stringify([normParticular(m.particular), code, qty]);
}

/** float(x) for Python parity in movement_sig: number or numeric string, else null. */
function toFloat(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return null;
    if (/^[+-]?(infinity|inf|nan)$/i.test(t)) return null;
    const f = Number(t);
    return Number.isFinite(f) ? f : null;
  }
  return null;
}

/** Counter of movement signatures for a day. */
type Multiset = Map<string, number>;
function dayMultiset(movements: Array<Record<string, unknown>>): Multiset {
  const c: Multiset = new Map();
  for (const m of movements) {
    const k = movementSig(m);
    c.set(k, (c.get(k) ?? 0) + 1);
  }
  return c;
}

function multisetsEqual(a: Multiset, b: Multiset): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** multiset_delta (line 93): symmetric difference for HUMAN REVIEW only. */
function multisetDelta(extracted: Multiset, db: Multiset): { added: DeltaRow[]; removed: DeltaRow[] } {
  const sub = (x: Multiset, y: Multiset): Multiset => {
    // Counter subtraction: keeps only positive counts.
    const out: Multiset = new Map();
    for (const [k, n] of x) {
      const d = n - (y.get(k) ?? 0);
      if (d > 0) out.set(k, d);
    }
    return out;
  };
  const unpack = (c: Multiset): DeltaRow[] => {
    const rows: DeltaRow[] = [];
    // Python sorts c.items() by the tuple key (particular, code, qty). Our keys are
    // JSON of that tuple; sort by the DECODED tuple to match Python's tuple ordering.
    const entries = [...c.entries()].map(([k, n]) => {
      const [particular, code, qty] = JSON.parse(k) as [string, string, number];
      return { particular, code, qty, n };
    });
    entries.sort((a, b) => tupleCmp([a.particular, a.code, a.qty], [b.particular, b.code, b.qty]));
    for (const e of entries) {
      rows.push({ particular: e.particular, bag_type_code: e.code, qty_delta: e.qty, count: e.n });
    }
    return rows;
  };
  return { added: unpack(sub(extracted, db)), removed: unpack(sub(db, extracted)) };
}

/** Python tuple comparison: element-wise, strings lexicographic, numbers numeric. */
function tupleCmp(a: [string, string, number], b: [string, string, number]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] - b[2];
}

// ---------------------------------------------------------------------------
// The classify entrypoint. Mirrors classify_flecon_bags.py main() exactly, but
// takes the extract + DB snapshot as arguments (offline, no lib.db).
// ---------------------------------------------------------------------------
export function classifyFlecon(
  extract: FleconExtract,
  since: string,
  db: {
    movements: DbMovementRow[];
    bagTypes: BagTypeRow[];
    viewBalance: ViewBalanceRow[];
  },
): FleconClassified {
  const exRows = extract.rows ?? [];
  const exColumnMap = extract.column_map ?? [];
  const exUnmapped = extract.unmapped_columns ?? [];
  const exMissing = extract.missing_columns ?? [];

  since = since.trim();

  // code_to_id (line 127): {code^: id}; id_to_code is the inverse.
  const codeToId: Record<string, unknown> = {};
  for (const t of db.bagTypes) {
    codeToId[String(t.code).trim().toUpperCase()] = t.id;
  }
  const idToCode = new Map<unknown, string>();
  for (const [code, id] of Object.entries(codeToId)) idToCode.set(id, code);

  // Load DB movements; normalize each to carry bag_type_code (line 192-195).
  const dbRows: DbMovementRow[] = db.movements.map((r) => ({ ...r }));
  for (const row of dbRows) {
    if (!("bag_type_code" in row) || row.bag_type_code === undefined) {
      if (idToCode.has(row.bag_type_id)) row.bag_type_code = idToCode.get(row.bag_type_id);
    }
  }

  // Group extracted + DB by transaction_date. db_by_date only gets dates >= since —
  // so a date whose DB rows are all below since is genuinely absent (porting trap #5).
  const exByDate = new Map<string, FleconMovement[]>();
  for (const m of exRows) {
    const d = m.transaction_date;
    const arr = exByDate.get(d) ?? [];
    arr.push(m);
    exByDate.set(d, arr);
  }
  const dbByDate = new Map<string, DbMovementRow[]>();
  for (const m of dbRows) {
    const d = String(m.transaction_date ?? "").slice(0, 10);
    if (d >= since) {
      const arr = dbByDate.get(d) ?? [];
      arr.push(m);
      dbByDate.set(d, arr);
    }
  }

  const allDates = [...new Set([...exByDate.keys(), ...dbByDate.keys()])].sort();

  const perDate: PerDateEntry[] = [];
  const counts = { new: 0, date_changed: 0, duplicate_noop: 0 };
  for (const d of allDates) {
    const exDay = exByDate.get(d) ?? [];
    const dbDay = dbByDate.get(d) ?? [];
    const exMs = dayMultiset(exDay as unknown as Array<Record<string, unknown>>);
    const dbPresent = dbByDate.has(d); // KEY membership, not array length.
    const dbMs = dayMultiset(dbDay as unknown as Array<Record<string, unknown>>);

    if (!dbPresent) {
      counts.new += 1;
      perDate.push({
        transaction_date: d,
        class: "NEW",
        sheet_movement_count: exDay.length,
        db_movement_count: 0,
        delta: multisetDelta(exMs, dbMs),
        movements: exDay,
      });
    } else if (multisetsEqual(exMs, dbMs)) {
      counts.duplicate_noop += 1;
      // NOOP days counted only — never dumped.
    } else {
      counts.date_changed += 1;
      perDate.push({
        transaction_date: d,
        class: "DATE_CHANGED",
        sheet_movement_count: exDay.length,
        db_movement_count: dbDay.length,
        delta: multisetDelta(exMs, dbMs),
        movements: exDay,
      });
    }
  }

  // Informational balance cross-check (lines 240-269) — never gates.
  const viewByCode = new Map<string, ViewBalanceRow>();
  for (const v of db.viewBalance) {
    viewByCode.set(String(v.code ?? "").trim().toUpperCase(), v);
  }
  const sheetSnapshot = extract.balance_snapshot;
  let balanceCrosscheck: FleconClassified["balance_crosscheck"];
  if (sheetSnapshot && Object.keys(sheetSnapshot).length > 0) {
    const rowsOut: BalanceCrosscheckRow[] = [];
    const codeSet = new Set<string>(viewByCode.keys());
    for (const c of Object.keys(sheetSnapshot)) codeSet.add(c.trim().toUpperCase());
    const codes = [...codeSet].sort();
    for (const code of codes) {
      let dbBal: number | null = null;
      if (viewByCode.has(code)) {
        const f = toFloat(viewByCode.get(code)!.balance);
        // int(round(float(balance))); on failure Python keeps the raw value. In practice
        // balances are numeric, so a failure yields null here (raw non-numeric → null via
        // toFloat). This matches every oracle row (all integer balances).
        dbBal = f === null ? null : Math.trunc(roundHalfToEven(f, 0));
      }
      const sheetBalRaw = sheetSnapshot[code];
      const sheetBal = typeof sheetBalRaw === "number" ? sheetBalRaw : null;
      let drift: number | null = null;
      if (Number.isInteger(dbBal) && dbBal !== null && Number.isInteger(sheetBal) && sheetBal !== null) {
        drift = dbBal - sheetBal;
      }
      rowsOut.push({
        code,
        db_view_balance: dbBal,
        sheet_snapshot_balance: sheetBal,
        drift,
      });
    }
    balanceCrosscheck = {
      available: true,
      rows: rowsOut,
      note: "INFORMATIONAL only — never gates writes. Drift = DB view balance - sheet snapshot.",
    };
  } else {
    balanceCrosscheck = {
      available: false,
      rows: [],
      note: "No sheet balance-snapshot located; cross-check skipped.",
    };
  }

  // Column-mapping FLAGS pass-through (lines 271-287) — never gate movements.
  const columnFlags = {
    flagged: exUnmapped.length > 0 || exMissing.length > 0,
    unmapped_columns: exUnmapped,
    missing_columns: exMissing,
    column_map: exColumnMap,
    note:
      "FLAGGED, informational — these do NOT block the movements that mapped. " +
      "unmapped_columns = candidate NEW bag type(s) to register in flecon_bag_types; " +
      "missing_columns = registry code(s) with no column this run (removed/renamed?). " +
      "The agent must surface these for the user; never auto-create a bag type.",
  };

  let dbMovementsInWindow = 0;
  for (const arr of dbByDate.values()) dbMovementsInWindow += arr.length;

  return {
    table: "flecon_bag_movements",
    since,
    model: "REPLACE_BY_DATE",
    per_date: perDate,
    code_to_id: codeToId,
    balance_crosscheck: balanceCrosscheck,
    column_flags: columnFlags,
    summary: {
      new_days: counts.new,
      date_changed_days: counts.date_changed,
      duplicate_noop_days: counts.duplicate_noop,
      total_days_in_window: allDates.length,
      sheet_movements_in_window: exRows.length,
      db_movements_in_window: dbMovementsInWindow,
      unmapped_columns: exUnmapped.length,
      missing_columns: exMissing.length,
      column_map_size: exColumnMap.length,
    },
  };
}
