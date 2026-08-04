/**
 * classify.ts — the FIVE production classifiers, each a faithful port of its Python
 * counterpart, kept in one file. Each preserves its own natural key, comparison
 * semantics, record projection, and summary key set so the composed envelope
 * matches the oracle byte-for-byte after canonicalization.
 *
 *   classifyRuns        <- classify_production_runs.py     key (shift_id, customer^, grade^)
 *   classifyDowntime    <- classify_production_downtime.py key (shift_id,)
 *   classifyWaste       <- classify_production_waste.py    key (shift_id,)
 *   classifyElectricity <- classify_electricity.py         key (reading_date, meter)
 *   classifyTrucks      <- classify_trucks.py              key (reading_date, plate_no)
 *
 * Shift-dependent classifiers (runs/downtime/waste) resolve each row's
 * (transaction_date, production_batch^, shift^) triplet to a shift_id via the shift
 * map built from the DB-window `shifts` array. electricity/trucks use plain
 * rounded-equality (round to 2dp, then ===), NOT a tolerance band — matching the
 * Python's actual comparison, not its docstring.
 */
import { roundHalfToEven } from "../../lib/norm.js";
import type { RunRow, DowntimeRow, ElectricityRow, TruckRow } from "./extractMc.js";
import type { WasteRow } from "./extractIvy.js";

// MUST stay byte-identical to SHIFT_DEFAULT_NOTE in extractMc.ts.
const SHIFT_DEFAULT_NOTE = "shift defaulted to Morning (operator left blank)";
const NUM_TOLERANCE = 0.01;
const VALID_GRADES = new Set(["3X50", "6X50", "8X50", "2X6", "4X8"]);
const WASTE_STREAMS = ["rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg", "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg"] as const;

// ── Normalizers (mirror the Python norm_* per-file semantics) ───────────────
function normStr(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t ? t.toLowerCase() : null;
}

function normKeyPart(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t ? t.toUpperCase() : null;
}

/** norm_num(v, places=2) — production/electricity/trucks default. */
function normNum(v: unknown, places = 2): number | null {
  if (v === null || v === undefined) return null;
  const f = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(f)) return null;
  return roundHalfToEven(f, places);
}

/** tolerance-BAND equality (runs/downtime/waste). */
function numsEqual(a: unknown, b: unknown): boolean {
  const na = normNum(a);
  const nb = normNum(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) <= NUM_TOLERANCE;
}

function normMeter(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.toUpperCase() : null;
}

function normPlate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, " ");
  return s ? s.toUpperCase() : null;
}

function stripShiftDefaultNote(s: unknown): unknown {
  if (s === null || typeof s !== "string") return s;
  if (!s.includes(SHIFT_DEFAULT_NOTE)) return s;
  let out = s.replace(` | ${SHIFT_DEFAULT_NOTE}`, "");
  out = out.replace(`${SHIFT_DEFAULT_NOTE} | `, "");
  out = out.replace(SHIFT_DEFAULT_NOTE, "");
  return out;
}

// ── DB-window row shapes (denormalized child rows carry shift_id + own fields) ──
export interface ShiftDbRow {
  id?: string | null;
  transaction_date?: string | null;
  production_batch?: string | null;
  shift?: string | null;
}
export interface RunDbRow {
  id?: string | null;
  shift_id?: string | null;
  customer?: string | null;
  grade?: string | null;
  ttl_kg?: number | null;
  sacks_bags?: number | null;
  remarks?: string | null;
}
export interface DowntimeDbRow {
  id?: string | null;
  shift_id?: string | null;
  shift_hrs?: number | null;
  dt_hrs?: number | null;
  dt_mins?: number | null;
  dt_reason?: string | null;
  // No `remarks` — `production_downtime` has no such column. See downtimeFieldDiff.
}
export interface WasteDbRow {
  id?: string | null;
  shift_id?: string | null;
  rs1a_kg?: number | null;
  rs1b_kg?: number | null;
  bf_kg?: number | null;
  rs23_kg?: number | null;
  rs5_kg?: number | null;
  trml1_kg?: number | null;
  trml2_kg?: number | null;
  grit_kg?: number | null;
  remarks?: string | null;
}
export interface ElectricityDbRow {
  id?: string | null;
  reading_date?: string | null;
  meter?: string | null;
  start_kwh?: number | null;
  end_kwh?: number | null;
  meter_multiplier?: number | null;
  remarks?: string | null;
}
export interface TruckDbRow {
  id?: string | null;
  reading_date?: string | null;
  plate_no?: string | null;
  start_km?: number | null;
  end_km?: number | null;
  fuel_liters?: number | null;
  remarks?: string | null;
}

// The classifier result dict shape (one per section) that the oracle composes.
export interface SectionResult {
  table: string;
  classifications: Record<string, unknown>[];
  summary: Record<string, number>;
}

// ── shift map ────────────────────────────────────────────────────────────────
type Triplet = string; // `${date} ${batch^} ${shift^}`
function tripletKey(date: unknown, batch: unknown, shift: unknown): Triplet {
  return `${date ?? "null"} ${normKeyPart(batch) ?? "null"} ${normKeyPart(shift) ?? "null"}`;
}

function buildShiftMap(shifts: ShiftDbRow[]): Map<Triplet, string> {
  const m = new Map<Triplet, string>();
  for (const s of shifts) {
    if (s.id !== null && s.id !== undefined) {
      m.set(tripletKey(s.transaction_date, s.production_batch, s.shift), s.id);
    }
  }
  return m;
}

// ── classify_production_runs ────────────────────────────────────────────────
function runsFieldDiff(email: RunRow, db: RunDbRow): Record<string, { db: number | null | string; email: number | null | string }> {
  const diff: Record<string, { db: number | null | string; email: number | null | string }> = {};
  if (!numsEqual(email.ttl_kg, db.ttl_kg)) {
    diff.ttl_kg = { db: normNum(db.ttl_kg), email: normNum(email.ttl_kg) };
  }
  if (!numsEqual(email.sacks_bags, db.sacks_bags)) {
    diff.sacks_bags = { db: normNum(db.sacks_bags), email: normNum(email.sacks_bags) };
  }
  const emailRemarks = stripShiftDefaultNote(email.remarks);
  if (normStr(emailRemarks) !== normStr(db.remarks)) {
    diff.remarks = { db: db.remarks ?? null, email: email.remarks ?? null } as { db: string | null; email: string | null };
  }
  return diff;
}

export function classifyRuns(rows: RunRow[], dbRows: RunDbRow[], shifts: ShiftDbRow[]): SectionResult {
  const shiftMap = buildShiftMap(shifts);
  const dbIndex = new Map<string, RunDbRow>();
  for (const d of dbRows) {
    const key = `${d.shift_id ?? "null"} ${normKeyPart(d.customer) ?? "null"} ${normKeyPart(d.grade) ?? "null"}`;
    dbIndex.set(key, d);
  }

  const classifications: Record<string, unknown>[] = [];
  const counts = { new: 0, value_changed: 0, duplicate_noop: 0, malformed: 0, needs_shift_upsert: 0, skipped_no_output: 0 };

  rows.forEach((ex, idx) => {
    const rawShift = ex.shift;
    if (rawShift === null || rawShift === undefined || String(rawShift).trim() === "") {
      classifications.push({
        idx, class: "MALFORMED",
        natural_key: { shift_id: null, customer: ex.customer, grade: ex.grade },
        resolved_shift_id: null, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons: ["missing shift; cannot key to production_shifts"], confidence: 1.0,
      });
      counts.malformed++;
      return;
    }

    const reasons: string[] = [];
    const grade = normKeyPart(ex.grade);
    if (grade === null || !VALID_GRADES.has(grade)) {
      reasons.push(`grade '${ex.grade}' not in ${JSON.stringify([...VALID_GRADES].sort())}`);
    }
    // Benign no-production: a VALID-grade row whose TOTAL-kg cell was genuinely
    // BLANK means nothing was produced this shift. It is NOT malformed, NOT
    // written, and does NOT hold or gate the run — surfaced only as an
    // informational SKIPPED_NO_OUTPUT. A present-but-unparseable or negative
    // ttl_kg (below) is a real data error and still MALFORMED. This is an
    // intentional TS-only divergence from the (unported) Python, which held such
    // a row as MALFORMED; no existing parity fixture carries a blank-kg row, so
    // parity stays green.
    if (reasons.length === 0 && ex._ttl_blank === true) {
      classifications.push({
        idx, class: "SKIPPED_NO_OUTPUT",
        natural_key: { shift_id: null, customer: ex.customer, grade: ex.grade },
        resolved_shift_id: null, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex,
        reasons: ["no production output this shift (TOTAL kg blank) — skipped, not written"],
        confidence: 1.0,
      });
      counts.skipped_no_output++;
      return;
    }
    const ttl = normNum(ex.ttl_kg);
    if (ttl === null || ttl < 0) reasons.push("ttl_kg not a non-negative number");
    if (reasons.length > 0) {
      classifications.push({
        idx, class: "MALFORMED",
        natural_key: { shift_id: null, customer: ex.customer, grade: ex.grade },
        resolved_shift_id: null, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons, confidence: 1.0,
      });
      counts.malformed++;
      return;
    }

    const shift = normKeyPart(rawShift);
    const resolved = shiftMap.get(tripletKey(ex.transaction_date, ex.production_batch, shift)) ?? null;
    const needsUpsert = resolved === null;
    const customer = normKeyPart(ex.customer) ?? "CEBU";
    const naturalKey = { shift_id: resolved, customer, grade };

    if (needsUpsert) {
      counts.needs_shift_upsert++;
      classifications.push({
        idx, class: "NEW", natural_key: naturalKey,
        resolved_shift_id: null, needs_shift_upsert: true, existing_id: null, diff: null,
        record: ex, reasons: ["parent shift absent; upsert shift then insert run"], confidence: 0.95,
      });
      counts.new++;
      return;
    }

    const dbRow = dbIndex.get(`${resolved} ${customer} ${grade}`);
    if (dbRow === undefined) {
      classifications.push({
        idx, class: "NEW", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons: ["shift exists; no run for this customer+grade"], confidence: 0.97,
      });
      counts.new++;
      return;
    }

    const diff = runsFieldDiff(ex, dbRow);
    if (Object.keys(diff).length > 0) {
      classifications.push({
        idx, class: "VALUE_CHANGED", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false,
        existing_id: dbRow.id ?? null, diff,
        record: ex, reasons: [`${Object.keys(diff).length} field(s) differ: ${Object.keys(diff).sort().join(", ")}`],
        confidence: 0.9,
      });
      counts.value_changed++;
    } else {
      classifications.push({
        idx, class: "DUPLICATE_NOOP", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false,
        existing_id: dbRow.id ?? null, diff: null,
        record: ex, reasons: ["natural key present; all comparable fields equal"], confidence: 0.99,
      });
      counts.duplicate_noop++;
    }
  });

  const summary: Record<string, number> = {
    new: counts.new, value_changed: counts.value_changed, duplicate_noop: counts.duplicate_noop,
    malformed: counts.malformed, needs_shift_upsert: counts.needs_shift_upsert,
  };
  // Additive-only: omit when 0 so runs summaries with no blank-kg rows stay
  // byte-identical to the Python oracle (parity).
  if (counts.skipped_no_output > 0) summary.skipped_no_output = counts.skipped_no_output;

  return {
    table: "production_runs",
    classifications,
    summary,
  };
}

// ── classify_production_downtime ────────────────────────────────────────────
function downtimeFieldDiff(email: DowntimeRow, db: DowntimeDbRow): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const f of ["shift_hrs", "dt_hrs", "dt_mins"] as const) {
    if (!numsEqual(email[f], db[f])) diff[f] = { db: normNum(db[f]), email: normNum(email[f]) };
  }
  // `remarks` is DELIBERATELY not compared: `production_downtime` has no such
  // column. The extractor still builds one ("Time ranges: …") and the insert
  // path drops it, so the DB side is permanently undefined — comparing them
  // made every downtime row with time ranges a permanent phantom VALUE_CHANGED,
  // and once the apply path started emitting patches it would have put a
  // non-allowlisted key in them, refusing the whole op (`unsupported_field`)
  // and taking the row's REAL dt_hrs/dt_mins/dt_reason corrections down with it.
  if (normStr(email.dt_reason) !== normStr(db.dt_reason)) {
    diff.dt_reason = { db: db.dt_reason ?? null, email: email.dt_reason ?? null };
  }
  return diff;
}

export function classifyDowntime(rows: DowntimeRow[], dbRows: DowntimeDbRow[], shifts: ShiftDbRow[]): SectionResult {
  const shiftMap = buildShiftMap(shifts);
  const dbIndex = new Map<string | null | undefined, DowntimeDbRow>();
  for (const d of dbRows) dbIndex.set(d.shift_id, d);

  const classifications: Record<string, unknown>[] = [];
  const counts = { new: 0, value_changed: 0, duplicate_noop: 0, malformed: 0, needs_shift_upsert: 0 };

  rows.forEach((ex, idx) => {
    const rawShift = ex.shift;
    if (rawShift === null || rawShift === undefined || String(rawShift).trim() === "") {
      classifications.push({
        idx, class: "MALFORMED", natural_key: { shift_id: null },
        resolved_shift_id: null, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons: ["missing shift; cannot key to production_shifts"], confidence: 1.0,
      });
      counts.malformed++;
      return;
    }
    const sh = normNum(ex.shift_hrs);
    if (sh === null || sh <= 0) {
      classifications.push({
        idx, class: "MALFORMED", natural_key: { shift_id: null },
        resolved_shift_id: null, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons: ["shift_hrs <= 0"], confidence: 1.0,
      });
      counts.malformed++;
      return;
    }

    const shift = normKeyPart(rawShift);
    const resolved = shiftMap.get(tripletKey(ex.transaction_date, ex.production_batch, shift)) ?? null;
    const needsUpsert = resolved === null;
    const naturalKey = { shift_id: resolved };

    if (needsUpsert) {
      counts.needs_shift_upsert++;
      classifications.push({
        idx, class: "NEW", natural_key: naturalKey,
        resolved_shift_id: null, needs_shift_upsert: true, existing_id: null, diff: null,
        record: ex, reasons: ["parent shift absent; upsert shift then insert downtime"], confidence: 0.95,
      });
      counts.new++;
      return;
    }

    const dbRow = dbIndex.get(resolved);
    if (dbRow === undefined) {
      classifications.push({
        idx, class: "NEW", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons: ["shift exists; no downtime row yet"], confidence: 0.97,
      });
      counts.new++;
      return;
    }

    const diff = downtimeFieldDiff(ex, dbRow);
    if (Object.keys(diff).length > 0) {
      classifications.push({
        idx, class: "VALUE_CHANGED", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false, existing_id: dbRow.id ?? null, diff,
        record: ex, reasons: [`${Object.keys(diff).length} field(s) differ: ${Object.keys(diff).sort().join(", ")}`],
        confidence: 0.9,
      });
      counts.value_changed++;
    } else {
      classifications.push({
        idx, class: "DUPLICATE_NOOP", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false, existing_id: dbRow.id ?? null, diff: null,
        record: ex, reasons: ["natural key present; all comparable fields equal"], confidence: 0.99,
      });
      counts.duplicate_noop++;
    }
  });

  return {
    table: "production_downtime",
    classifications,
    summary: {
      new: counts.new, value_changed: counts.value_changed, duplicate_noop: counts.duplicate_noop,
      malformed: counts.malformed, needs_shift_upsert: counts.needs_shift_upsert,
    },
  };
}

// ── classify_production_waste ───────────────────────────────────────────────
function wasteFieldDiff(email: WasteRow, db: WasteDbRow): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const f of WASTE_STREAMS) {
    if (!numsEqual(email[f], db[f])) diff[f] = { db: normNum(db[f]), email: normNum(email[f]) };
  }
  if (normStr(email.remarks) !== normStr(db.remarks)) {
    diff.remarks = { db: db.remarks ?? null, email: email.remarks ?? null };
  }
  return diff;
}

export function classifyWaste(rows: WasteRow[], dbRows: WasteDbRow[], shifts: ShiftDbRow[]): SectionResult {
  const shiftMap = buildShiftMap(shifts);
  const dbIndex = new Map<string | null | undefined, WasteDbRow>();
  for (const d of dbRows) dbIndex.set(d.shift_id, d);

  const classifications: Record<string, unknown>[] = [];
  const counts = { new: 0, value_changed: 0, duplicate_noop: 0, malformed: 0, needs_shift_upsert: 0 };

  rows.forEach((ex, idx) => {
    const rawShift = ex.shift;
    if (rawShift === null || rawShift === undefined || String(rawShift).trim() === "") {
      classifications.push({
        idx, class: "MALFORMED", natural_key: { shift_id: null },
        resolved_shift_id: null, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons: ["missing shift; cannot key to production_shifts"], confidence: 1.0,
      });
      counts.malformed++;
      return;
    }
    const reasons: string[] = [];
    for (const f of WASTE_STREAMS) {
      const n = normNum(ex[f]);
      if (n !== null && n < 0) reasons.push(`${f} negative`);
    }
    if (reasons.length > 0) {
      classifications.push({
        idx, class: "MALFORMED", natural_key: { shift_id: null },
        resolved_shift_id: null, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons, confidence: 1.0,
      });
      counts.malformed++;
      return;
    }

    const shift = normKeyPart(rawShift);
    const resolved = shiftMap.get(tripletKey(ex.transaction_date, ex.production_batch, shift)) ?? null;
    const needsUpsert = resolved === null;
    const naturalKey = { shift_id: resolved };

    if (needsUpsert) {
      counts.needs_shift_upsert++;
      classifications.push({
        idx, class: "NEW", natural_key: naturalKey,
        resolved_shift_id: null, needs_shift_upsert: true, existing_id: null, diff: null,
        record: ex, reasons: ["parent shift absent; upsert shift then insert waste"], confidence: 0.95,
      });
      counts.new++;
      return;
    }

    const dbRow = dbIndex.get(resolved);
    if (dbRow === undefined) {
      classifications.push({
        idx, class: "NEW", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false, existing_id: null, diff: null,
        record: ex, reasons: ["shift exists; no waste row yet"], confidence: 0.97,
      });
      counts.new++;
      return;
    }

    const diff = wasteFieldDiff(ex, dbRow);
    if (Object.keys(diff).length > 0) {
      classifications.push({
        idx, class: "VALUE_CHANGED", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false, existing_id: dbRow.id ?? null, diff,
        record: ex, reasons: [`${Object.keys(diff).length} field(s) differ: ${Object.keys(diff).sort().join(", ")}`],
        confidence: 0.9,
      });
      counts.value_changed++;
    } else {
      classifications.push({
        idx, class: "DUPLICATE_NOOP", natural_key: naturalKey,
        resolved_shift_id: resolved, needs_shift_upsert: false, existing_id: dbRow.id ?? null, diff: null,
        record: ex, reasons: ["natural key present; all comparable fields equal"], confidence: 0.99,
      });
      counts.duplicate_noop++;
    }
  });

  return {
    table: "production_waste",
    classifications,
    summary: {
      new: counts.new, value_changed: counts.value_changed, duplicate_noop: counts.duplicate_noop,
      malformed: counts.malformed, needs_shift_upsert: counts.needs_shift_upsert,
    },
  };
}

// ── classify_electricity + classify_trucks (plain rounded-equality) ─────────
const ELEC_EMITTED = ["reading_date", "meter", "start_kwh", "end_kwh", "meter_multiplier", "remarks"] as const;
const TRUCK_EMITTED = ["reading_date", "plate_no", "start_km", "end_km", "fuel_liters", "remarks"] as const;

function cleanRecord(row: object, fields: readonly string[]): Record<string, unknown> {
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of fields) out[k] = src[k] ?? null;
  return out;
}

/** PLAIN rounded-equality at 2dp (NOT a tolerance band) — matches the Python code. */
function roundedEq(a: unknown, b: unknown): boolean {
  return normNum(a, 2) === normNum(b, 2);
}

export function classifyElectricity(rows: ElectricityRow[], dbRows: ElectricityDbRow[]): SectionResult {
  const dbIndex = new Map<string, ElectricityDbRow[]>();
  for (const d of dbRows) {
    const key = `${d.reading_date ?? "null"} ${normMeter(d.meter) ?? "null"}`;
    (dbIndex.get(key) ?? dbIndex.set(key, []).get(key)!).push(d);
  }

  const classifications: Record<string, unknown>[] = [];
  const counts = { new: 0, value_changed: 0, duplicate_noop: 0, malformed: 0 };

  rows.forEach((ex, idx) => {
    const readingDate = ex.reading_date;
    const meter = normMeter(ex.meter);
    const natKey = { reading_date: readingDate, meter };

    const reasonsBad: string[] = [];
    if (!readingDate) reasonsBad.push("missing reading_date");
    if (!meter) reasonsBad.push("missing or empty meter");
    if (ex.start_kwh === null || ex.start_kwh === undefined) reasonsBad.push("missing start_kwh");
    if (ex.end_kwh === null || ex.end_kwh === undefined) reasonsBad.push("missing end_kwh");
    if (reasonsBad.length > 0) {
      counts.malformed++;
      classifications.push({
        idx, class: "MALFORMED", natural_key: natKey, existing_id: null, diff: null,
        record: cleanRecord(ex, ELEC_EMITTED), reasons: reasonsBad, confidence: 1.0,
      });
      return;
    }

    const matches = dbIndex.get(`${readingDate ?? "null"} ${meter ?? "null"}`) ?? [];
    if (matches.length === 0) {
      counts.new++;
      classifications.push({
        idx, class: "NEW", natural_key: natKey, existing_id: null, diff: null,
        record: cleanRecord(ex, ELEC_EMITTED),
        reasons: ["natural key (reading_date, meter) not present in DB"], confidence: 1.0,
      });
      return;
    }

    const dbRow = matches[0];
    const diffs: Array<{ field: string; emailValue: unknown; dbValue: unknown }> = [];
    for (const f of ["start_kwh", "end_kwh", "meter_multiplier"] as const) {
      if (!roundedEq(ex[f], dbRow[f])) diffs.push({ field: f, emailValue: ex[f] ?? null, dbValue: dbRow[f] ?? null });
    }
    if (normStr(ex.remarks) !== normStr(dbRow.remarks)) {
      diffs.push({ field: "remarks", emailValue: ex.remarks ?? null, dbValue: dbRow.remarks ?? null });
    }
    const ambiguous = matches.length > 1;

    if (diffs.length === 0) {
      counts.duplicate_noop++;
      classifications.push({
        idx, class: "DUPLICATE_NOOP", natural_key: natKey, existing_id: dbRow.id ?? null, diff: null,
        record: cleanRecord(ex, ELEC_EMITTED),
        reasons: ambiguous ? ["multiple DB rows share this natural key; matched first"] : ["all comparable base fields match existing row"],
        confidence: ambiguous ? 0.85 : 1.0,
      });
    } else {
      counts.value_changed++;
      classifications.push({
        idx, class: "VALUE_CHANGED", natural_key: natKey, existing_id: dbRow.id ?? null, diff: diffs,
        record: cleanRecord(ex, ELEC_EMITTED),
        reasons: [`${diffs.length} field(s) differ from existing row`, ...(ambiguous ? ["multiple DB rows share this natural key; matched first"] : [])],
        confidence: ambiguous ? 0.7 : 0.95,
      });
    }
  });

  return {
    table: "electricity_readings",
    classifications,
    summary: {
      new: counts.new, value_changed: counts.value_changed, duplicate_noop: counts.duplicate_noop,
      malformed: counts.malformed, extracted_total: rows.length, db_rows_in_window: dbRows.length,
    },
  };
}

export function classifyTrucks(rows: TruckRow[], dbRows: TruckDbRow[]): SectionResult {
  const dbIndex = new Map<string, TruckDbRow[]>();
  for (const d of dbRows) {
    const key = `${d.reading_date ?? "null"} ${normPlate(d.plate_no) ?? "null"}`;
    (dbIndex.get(key) ?? dbIndex.set(key, []).get(key)!).push(d);
  }

  const classifications: Record<string, unknown>[] = [];
  const counts = { new: 0, value_changed: 0, duplicate_noop: 0, malformed: 0 };

  rows.forEach((ex, idx) => {
    const readingDate = ex.reading_date;
    const plate = normPlate(ex.plate_no);
    const natKey = { reading_date: readingDate, plate_no: plate };

    const reasonsBad: string[] = [];
    if (!readingDate) reasonsBad.push("missing reading_date");
    if (!plate) reasonsBad.push("missing or empty plate_no");
    if (ex.start_km === null || ex.start_km === undefined) reasonsBad.push("missing start_km");
    if (ex.end_km === null || ex.end_km === undefined) reasonsBad.push("missing end_km");
    if (reasonsBad.length > 0) {
      counts.malformed++;
      classifications.push({
        idx, class: "MALFORMED", natural_key: natKey, existing_id: null, diff: null,
        record: cleanRecord(ex, TRUCK_EMITTED), reasons: reasonsBad, confidence: 1.0,
      });
      return;
    }

    const matches = dbIndex.get(`${readingDate ?? "null"} ${plate ?? "null"}`) ?? [];
    if (matches.length === 0) {
      counts.new++;
      classifications.push({
        idx, class: "NEW", natural_key: natKey, existing_id: null, diff: null,
        record: cleanRecord(ex, TRUCK_EMITTED),
        reasons: ["natural key (reading_date, plate_no) not present in DB"], confidence: 1.0,
      });
      return;
    }

    const dbRow = matches[0];
    const diffs: Array<{ field: string; emailValue: unknown; dbValue: unknown }> = [];
    for (const f of ["start_km", "end_km", "fuel_liters"] as const) {
      if (!roundedEq(ex[f], dbRow[f])) diffs.push({ field: f, emailValue: ex[f] ?? null, dbValue: dbRow[f] ?? null });
    }
    if (normStr(ex.remarks) !== normStr(dbRow.remarks)) {
      diffs.push({ field: "remarks", emailValue: ex.remarks ?? null, dbValue: dbRow.remarks ?? null });
    }
    const ambiguous = matches.length > 1;

    if (diffs.length === 0) {
      counts.duplicate_noop++;
      classifications.push({
        idx, class: "DUPLICATE_NOOP", natural_key: natKey, existing_id: dbRow.id ?? null, diff: null,
        record: cleanRecord(ex, TRUCK_EMITTED),
        reasons: ambiguous ? ["multiple DB rows share this natural key; matched first"] : ["all comparable base fields match existing row"],
        confidence: ambiguous ? 0.85 : 1.0,
      });
    } else {
      counts.value_changed++;
      classifications.push({
        idx, class: "VALUE_CHANGED", natural_key: natKey, existing_id: dbRow.id ?? null, diff: diffs,
        record: cleanRecord(ex, TRUCK_EMITTED),
        reasons: [`${diffs.length} field(s) differ from existing row`, ...(ambiguous ? ["multiple DB rows share this natural key; matched first"] : [])],
        confidence: ambiguous ? 0.7 : 0.95,
      });
    }
  });

  return {
    table: "truck_readings",
    classifications,
    summary: {
      new: counts.new, value_changed: counts.value_changed, duplicate_noop: counts.duplicate_noop,
      malformed: counts.malformed, extracted_total: rows.length, db_rows_in_window: dbRows.length,
    },
  };
}
