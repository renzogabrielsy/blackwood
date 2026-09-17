/**
 * apply.ts — port of sync_production.py::phase_apply. FK-safe write order:
 *   1. Collect distinct shift triplets from every NEW+needs_shift_upsert child
 *      (runs+downtime+waste) and UPSERT the parent production_shifts FIRST.
 *   2. L-026 combine duplicate (shift_id, customer^, grade^) NEW run rows, then
 *      insert production_runs.
 *   3. Insert production_downtime (NO remarks col) + production_waste (8 streams +
 *      remarks) via insert_if_absent(natural_key=(shift_id,)).
 *   4. Insert electricity_readings + truck_readings (natural-key, no shift) —
 *      NEVER writing the generated columns diff_kwh/consumption_kwh/ttl_km.
 *   5. Apply VALUE_CHANGED (all 5 sections) through the CONDITIONAL writer
 *      `fn_apply_production_upstream`, stripping generated cols defensively. A row a
 *      human edited in the app is NEVER written — it becomes a run finding instead.
 *   6. Hold ALL MALFORMED.
 * Every table gets a MANUAL audit row via writeIngestionAudit (none of the 6
 * production-family tables has an audit trigger). Reconcile is INFORMATIONAL and
 * never gates. Watermark + label only if `not errors`; a SINGLE mark_processed call
 * labels BOTH the MC and Ivy UIDs together.
 *
 * PD-5 note: the dt_mins>=60 split is applied UPSTREAM at extract shaping
 * (extractMc.ts), so the downtime record reaching apply already carries a
 * constraint-valid dt_hrs/dt_mins — apply writes it verbatim.
 *
 * Batch-changeover note (2026-08-03): a `STARTING` marker gives the day's rows a
 * DIFFERENT `production_batch` from the `ENDING` rows, so the two shift triplets
 * upserted in step 1 are distinct, the two shift_ids differ, and the L-026 combine
 * in step 2 CANNOT merge the two same-grade rows. No special case is needed here —
 * the fix lands entirely upstream in extractMc/productionBatch.
 *
 * Ground truth: .claude/skills/sync-ictc/scripts/sync_production.py.
 */
import type { DbClient, Row } from "../../lib/db.js";
import type { ProgressEmitter } from "../../lib/progress.js";
import { type HeldRow, label } from "../held.js";
import type { WasteGapNote } from "./wasteGap.js";
import { operatorError, errText } from "../../lib/operatorError.js";

const WASTE_STREAMS = ["rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg", "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg"] as const;
const GENERATED_COLS = ["diff_kwh", "consumption_kwh", "ttl_km"] as const;

export interface ProductionSections {
  runs: Record<string, unknown>[];
  downtime: Record<string, unknown>[];
  waste: Record<string, unknown>[];
  electricity: Record<string, unknown>[];
  trucks: Record<string, unknown>[];
}

/**
 * One production-batch CHANGEOVER this run detected — MC marked `STARTING` in the
 * runs block, so a brand-new `production_batch` name came into being. The batch
 * name appears NOWHERE in the workbook (searched every cell): the sync DERIVES it
 * as the next name in the monthly sequence, with no source to verify against.
 * That is why it is announced for human confirmation rather than assumed silently.
 *
 * Run-visibility only — it is NOT a held row (the rows DID write) and NEVER a
 * `HeldKind` (that enum is frontend-locked). Mirror of the frontend
 * `ProductionBatchStart` (app/(app)/sync/types.ts). NEVER a ₱/cost field.
 */
export interface ProductionBatchStart {
  transaction_date: string;
  /** The new batch the `STARTING` row opened. */
  new_batch: string;
  /** The batch it follows (the one that was running). */
  previous_batch: string;
  /** How the new name was derived: next-in-sequence, or a calendar fallback. */
  derivation: string;
  /** Sheet title the marker was read from. */
  source_sheet: string;
}

/**
 * One production row the sync REFUSED to overwrite because a human edited it in the app
 * (the human-edit latch — migration `20260803080000_production_human_edit_guard.sql`).
 *
 * The disagreement is real and stays real: MC's / Ivy's workbook is CUMULATIVE, so it
 * still says the same thing tomorrow and this note re-fires every run until the operator
 * resolves it — either by fixing the sheet or by handing the row back with
 * `fn_release_production_rows`. Nothing is parked in the DB; the source IS the record.
 *
 * Run-visibility only — NOT a held row (there is nothing to retry) and NEVER a `HeldKind`
 * (that enum is frontend-locked). Mirror of the frontend `ProductionHumanEdit`
 * (app/(app)/sync/types.ts). Production carries no ₱/cost fields at all.
 */
export interface ProductionHumanEdit {
  /** runs | downtime | waste | electricity | trucks. */
  section: string;
  /** The DB table the refusal applies to. */
  table: string;
  /** The row the sync would have written. Feeds the release action. */
  record_id: string;
  transaction_date: string | null;
  production_batch: string | null;
  shift: string | null;
  meter: string | null;
  plate_no: string | null;
  /** Every field the report disagrees on: `yours` = what's in the app, `sheet` = the report. */
  changed_fields: Array<{ field: string; yours: unknown; sheet: unknown }>;
  /**
   * `known_before_write` — the row was already latched when the run planned its writes.
   * `refused_by_db`      — it was latched between the plan and the write; the RPC's own
   *                        guard caught it (the TOCTOU case this design exists for).
   */
  outcome: string;
}

/**
 * ONE production day where MC's typed DURATION total disagrees with her own list of stop
 * times, or where no time range could be read at all (L-051). Panel-visibility only: the
 * row is WRITTEN either way, from the time ranges, so nothing is held. Shape mirrors
 * `app/(app)/sync/types.ts::DowntimeNote` exactly.
 */
export interface DowntimeNote {
  kind: string;
  transaction_date: string;
  production_batch: string | null;
  duration_mins: number | null;
  ranges_mins: number | null;
  minutes_source: string;
  dt_ranges: string | null;
  dt_incident_ranges: string | null;
  shift_hrs: number | null;
  shift_hrs_source: string | null;
  warnings: string[];
}

/** Cap on the per-row parse complaints carried into a note (a cell cannot be endless). */
const DOWNTIME_NOTE_WARNING_CAP = 8;

/**
 * Build one note per downtime DAY that needs one, from the extractor's own underscore
 * fields on the classify record.
 *
 * Keyed by DATE, not by classification: a changeover day emits TWO downtime rows (the
 * L-007 output split) carrying the same source cell, and the sheet's two halves
 * disagreeing is ONE fact about ONE day. Raised for EVERY extracted downtime row,
 * whatever its class — a NOOP row read from a disagreeing sheet is exactly as worth
 * saying as a newly inserted one, and staying silent on the second run would make the
 * warning look like it had been resolved.
 */
export function buildDowntimeNotes(sections: ProductionSections): DowntimeNote[] {
  const byDate = new Map<string, DowntimeNote>();
  for (const c of sections.downtime ?? []) {
    const rec = (c.record ?? {}) as Row;
    const date = typeof rec.transaction_date === "string" ? rec.transaction_date : null;
    if (!date || byDate.has(date)) continue;

    const source = typeof rec._minutes_source === "string" ? rec._minutes_source : "ranges";
    const disagrees = rec._duration_disagrees === true;
    const unreadable = source === "duration";
    // L-051b: a day that excluded a stoppage as an incident ALWAYS says so, whether or not
    // anything else about it is odd. A stoppage that stops counting must never be silent.
    const incident = typeof rec.dt_incident_ranges === "string" && rec.dt_incident_ranges !== "";
    if (!disagrees && !unreadable && !incident) continue;

    const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
    byDate.set(date, {
      // An incident is the QUIETEST of the three, so it only names the day when nothing
      // louder is also true — the reader gets one note per day, not a pile.
      kind: unreadable
        ? "downtime_ranges_unreadable"
        : disagrees
          ? "downtime_duration_mismatch"
          : "downtime_incident_no_stop",
      transaction_date: date,
      production_batch: typeof rec.production_batch === "string" ? rec.production_batch : null,
      duration_mins: numOrNull(rec._duration_mins),
      ranges_mins: numOrNull(rec._ranges_mins),
      minutes_source: source,
      dt_ranges: typeof rec.dt_ranges === "string" ? rec.dt_ranges : null,
      dt_incident_ranges: incident ? String(rec.dt_incident_ranges) : null,
      shift_hrs: numOrNull(rec.shift_hrs),
      shift_hrs_source:
        typeof rec.shift_hrs_source === "string" ? rec.shift_hrs_source : null,
      warnings: Array.isArray(rec.warnings)
        ? (rec.warnings as unknown[]).filter((w): w is string => typeof w === "string")
            .slice(0, DOWNTIME_NOTE_WARNING_CAP)
        : [],
    });
  }
  return [...byDate.values()];
}

export interface ProductionCompact {
  report_type: string;
  since: string;
  window: [string, string];
  /**
   * Ids of rows in this run's DB window that a human owns (`human_edited_at IS NOT NULL`).
   * Read from the SAME queries that build the classify window, so it costs no extra round
   * trip. ADVISORY: it lets the apply skip a doomed write and name the disagreement even
   * when there is no write to attempt. The authoritative guard is inside
   * `fn_apply_production_upstream`'s own UPDATE.
   */
  human_edited_ids?: string[];
  source: {
    mc_subject?: string | null;
    mc_uid?: number | string | null;
    mc_thread_id?: string | null;
    ivy_subject?: string | null;
    ivy_uid?: number | string | null;
    ivy_thread_id?: string | null;
  };
  sections: ProductionSections;
  /** Changeovers detected this run (usually empty — once a month at most). */
  batch_starts?: ProductionBatchStart[];
  /** Waste rows the `since` floor excluded that the database does not agree with
   *  (L-052). Computed in `index.ts`; echoed here so the run result carries it. */
  waste_notes?: WasteGapNote[];
}

export interface ApplyResult {
  report_type: string;
  ok: boolean;
  inserts: number;
  updates: number;
  held: HeldRow[];
  labeled: boolean;
  watermark_updated: boolean;
  errors: string[];
  /** Echoed from the compact so the run result carries it to the panel's findings. */
  production_batch_starts: ProductionBatchStart[];
  /** Rows the sync refused to overwrite because a human owns them. */
  production_human_edits: ProductionHumanEdit[];
  /** Downtime days whose typed total and listed stop times disagree (L-051). */
  downtime_notes: DowntimeNote[];
  /** Waste rows Ivy's cumulative workbook states that the database is missing or
   *  disagrees with, found BELOW the sync window (L-052). ALWAYS present (default []). */
  waste_notes: WasteGapNote[];
}

/**
 * Re-read the row that WON a `UNIQUE(shift_id)` collision, so the hold can show both
 * sides. Called only when `insertIfAbsent` actually skipped, so it costs nothing on an
 * ordinary run. A read failure degrades to `null` — a collision must still be reported
 * even if we cannot describe the other half of it.
 */
async function readCollidingRow(
  db: DbClient,
  table: string,
  shiftId: string,
  cols: string[],
): Promise<Record<string, unknown> | null> {
  try {
    const rows = await db.readRows(table, {
      sinceColumn: null,
      columns: ["id", "shift_id", "human_edited_at", ...cols],
      extraFilters: { shift_id: `eq.${shiftId}`, limit: "1" },
    });
    return rows.length ? (rows[0] as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Sum of the eight waste streams on a payload-shaped object. Null for a non-waste row. */
function streamTotal(row: Record<string, unknown> | null | undefined): number | null {
  if (!row) return null;
  let t = 0;
  for (const f of WASTE_STREAMS) t += Number(row[f] ?? 0);
  return Math.round(t * 10000) / 10000;
}

/** Thousands-separated, at most 2dp. */
function fmtNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Human label for a production child record: "2026-06-30 · JUNE-26 · Morning · runs". */
function prodKey(section: string, rec: Record<string, unknown> | undefined): string {
  const r = rec ?? {};
  return label([r.transaction_date, r.production_batch, r.shift, section]) || section;
}

/** The structured production held-row payload (no ₱/cost — production carries none). */
function prodHeldRow(section: string, rec: Record<string, unknown> | undefined): Record<string, unknown> {
  const r = rec ?? {};
  return {
    section,
    transaction_date: r.transaction_date ?? null,
    production_batch: r.production_batch ?? null,
    shift: r.shift ?? null,
    customer: r.customer ?? null,
    grade: r.grade ?? null,
  };
}

/**
 * Normalize either classifier diff shape into ONE list of {field, yours, sheet}:
 *   runs/downtime/waste   `{ field: { db, email } }`
 *   electricity/trucks    `[ { field, emailValue, dbValue } ]`
 * `yours` is the stored (app) value, `sheet` is what the report says. Generated columns
 * are dropped — they are derived, never a real disagreement.
 */
function changedFields(
  diff: Record<string, unknown> | Array<{ field: string; emailValue?: unknown; dbValue?: unknown }>,
): Array<{ field: string; yours: unknown; sheet: unknown }> {
  const out: Array<{ field: string; yours: unknown; sheet: unknown }> = [];
  const generated = new Set<string>(GENERATED_COLS);
  if (Array.isArray(diff)) {
    for (const e of diff) {
      if (!e || typeof e !== "object" || generated.has(e.field)) continue;
      out.push({ field: e.field, yours: e.dbValue ?? null, sheet: e.emailValue ?? null });
    }
  } else {
    for (const [field, v] of Object.entries(diff)) {
      if (generated.has(field)) continue;
      const o = (v ?? {}) as Record<string, unknown>;
      out.push({ field, yours: o.db ?? null, sheet: o.email ?? null });
    }
  }
  out.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return out;
}

/** Build the run-visibility note for one refused row. NEVER carries a ₱/cost field. */
function humanEditNote(
  section: string,
  table: string,
  recordId: string,
  rec: Row,
  changed: Array<{ field: string; yours: unknown; sheet: unknown }>,
  outcome: string,
): ProductionHumanEdit {
  const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
  return {
    section,
    table,
    record_id: recordId,
    // runs/downtime/waste carry transaction_date; electricity/trucks carry reading_date.
    transaction_date: s(rec.transaction_date) ?? s(rec.reading_date),
    production_batch: s(rec.production_batch),
    shift: s(rec.shift),
    meter: s(rec.meter),
    plate_no: s(rec.plate_no),
    changed_fields: changed,
    outcome,
  };
}

export interface ApplyDeps {
  db: DbClient;
  labeler?: (uids: Array<number | string>) => Promise<boolean>;
  progress?: ProgressEmitter;
  noLabel?: boolean;
  runTs?: string;
}

function normUpper(s: unknown): string | null | undefined {
  return s !== null && s !== undefined ? String(s).trim().toUpperCase() : (s as null | undefined);
}

/**
 * Turn the internal shift key `"<date>|<batch>|<shift>"` back into the words on the day
 * sheet, for an operator-facing error headline (2026-08-25, BUG-027 part 2).
 */
function shiftLabel(key: string): string {
  const [date, batch, shift] = key.split("|").map((p) => (p === "null" ? "" : p));
  return label([date, batch, shift]) || "an unnamed shift";
}

/** Plain word per production child section, for an operator-facing headline. */
function sectionWord(section: string): string {
  if (section === "runs") return "production output";
  if (section === "downtime") return "downtime";
  if (section === "waste") return "waste";
  return section;
}

/** Plain word per production table, for an operator-facing headline. */
function tableWord(table: string): string {
  if (table === "electricity_readings") return "electricity";
  if (table === "truck_readings") return "truck";
  if (table === "production_runs") return "production output";
  if (table === "production_downtime") return "downtime";
  if (table === "production_waste") return "waste";
  if (table === "production_shifts") return "shift";
  return table;
}

function prov(table: string, runTs: string, extra = ""): string {
  const base = `provenance=production-sync | Ingested by sync_production.py (lean orchestrator) into ${table} on ${runTs}.`;
  return base + (extra ? ` ${extra}` : "");
}

export async function applyProduction(compact: ProductionCompact, deps: ApplyDeps): Promise<ApplyResult> {
  const { db } = deps;
  const emit = deps.progress;
  const runTs = deps.runTs ?? new Date().toISOString();
  const sections = compact.sections;
  const held: HeldRow[] = [];
  const errors: string[] = [];
  let inserts = 0;
  let updates = 0;

  await emit?.("apply", "Setting up production shifts…", 15);

  // ── 1. distinct shift triplets needing upsert (runs+downtime+waste NEW) ──
  const triplets = new Map<string, { transaction_date: unknown; production_batch: unknown; shift: unknown }>();
  for (const secName of ["runs", "downtime", "waste"] as const) {
    for (const c of sections[secName] ?? []) {
      if (c.class === "NEW" && c.needs_shift_upsert) {
        const rec = (c.record ?? {}) as Row;
        const key = `${rec.transaction_date ?? "null"}|${normUpper(rec.production_batch) ?? "null"}|${normUpper(rec.shift) ?? "null"}`;
        if (!triplets.has(key)) {
          triplets.set(key, {
            transaction_date: rec.transaction_date,
            production_batch: rec.production_batch,
            shift: rec.shift,
          });
        }
      }
    }
  }

  const shiftMap = new Map<string, string>();
  for (const [key, payload] of triplets) {
    try {
      const res = await db.insertIfAbsent("production_shifts", [payload as Row], [
        "transaction_date",
        "production_batch",
        "shift",
      ]);
      let sid: string | null = null;
      if (res.inserted.length > 0) {
        sid = res.inserted[0].id as string;
        await db.writeIngestionAudit({
          tableName: "production_shifts", recordId: sid, operation: "INSERT",
          comment: prov("production_shifts", runTs), snapshot: payload as Row,
        });
      } else {
        const existing = await db.selectOne(
          "production_shifts",
          {
            transaction_date: `eq.${payload.transaction_date}`,
            production_batch: `eq.${payload.production_batch}`,
            shift: `eq.${payload.shift}`,
          },
          "id",
        );
        sid = existing ? (existing.id as string) : null;
      }
      if (sid) shiftMap.set(key, sid);
    } catch (exc) {
      errors.push(
        operatorError(
          `Couldn't record the shift for ${shiftLabel(key)} — the database refused it. That ` +
            `shift and everything under it (output, downtime, waste) was not saved; the ` +
            `email stays unprocessed so the next run tries again.`,
          errText(exc),
        ),
      );
    }
  }

  const resolveShift = (c: Record<string, unknown>): string | null => {
    if (c.resolved_shift_id) return c.resolved_shift_id as string;
    const rec = (c.record ?? {}) as Row;
    const key = `${rec.transaction_date ?? "null"}|${normUpper(rec.production_batch) ?? "null"}|${normUpper(rec.shift) ?? "null"}`;
    return shiftMap.get(key) ?? null;
  };

  await emit?.("apply", "Writing production runs, downtime, and waste…", 40);

  // ── 2. runs (L-026 combine) ──
  const runNews = (sections.runs ?? []).filter((c) => c.class === "NEW");
  const combined = new Map<string, Row>();
  for (const c of runNews) {
    const sid = resolveShift(c);
    if (!sid) {
      const rec = (c.record ?? {}) as Row;
      held.push({
        reason: "unresolved_shift",
        natural_key: prodKey("runs", rec),
        detail: "run NEW without resolvable shift_id",
        kind: "unresolved_shift",
        row: prodHeldRow("runs", rec),
      });
      continue;
    }
    const rec = (c.record ?? {}) as Row;
    const k = `${sid}|${normUpper(rec.customer)}|${normUpper(rec.grade)}`;
    if (combined.has(k)) {
      const cur = combined.get(k)!;
      cur.ttl_kg = ((cur.ttl_kg as number) || 0) + ((rec.ttl_kg as number) || 0);
      cur.sacks_bags = ((cur.sacks_bags as number) || 0) + ((rec.sacks_bags as number) || 0);
      cur.remarks = [cur.remarks, rec.remarks].filter(Boolean).join("; ");
    } else {
      combined.set(k, {
        shift_id: sid, customer: rec.customer, grade: rec.grade,
        ttl_kg: rec.ttl_kg, sacks_bags: rec.sacks_bags, remarks: rec.remarks,
      });
    }
  }
  for (const payload of combined.values()) {
    try {
      const res = await db.insertIfAbsent("production_runs", [payload], ["shift_id", "customer", "grade"]);
      if (res.inserted.length > 0) {
        const nid = res.inserted[0].id as string;
        inserts++;
        await db.writeIngestionAudit({
          tableName: "production_runs", recordId: nid, operation: "INSERT",
          comment: prov("production_runs", runTs), snapshot: payload,
        });
      } else {
        held.push({
          reason: "already_exists",
          natural_key: label([payload.customer, payload.grade, "runs (already recorded)"]),
          detail: "idempotent skip",
          kind: "already_exists",
          row: { section: "runs", customer: payload.customer ?? null, grade: payload.grade ?? null, shift_id: payload.shift_id },
        });
      }
    } catch (exc) {
      errors.push(
        operatorError(
          `Couldn't save one production line (${payload.customer ?? "no customer"} · ` +
            `${payload.grade ?? "no grade"}) — the database refused it. That line was not ` +
            `saved; the email stays unprocessed so the next run tries again.`,
          errText(exc),
        ),
      );
    }
  }

  // ── 3. downtime (no remarks col) + waste ──
  const childSpecs: Array<[keyof ProductionSections, string[], string]> = [
    // L-051 / L-051b: dt_ranges, dt_incident_ranges and shift_hrs_source joined the
    // column list on 2026-09-14.
    [
      "downtime",
      [
        "shift_hrs", "dt_hrs", "dt_mins", "dt_reason",
        "dt_ranges", "dt_incident_ranges", "shift_hrs_source",
      ],
      "production_downtime",
    ],
    ["waste", [...WASTE_STREAMS, "remarks"], "production_waste"],
  ];
  for (const [secName, cols, table] of childSpecs) {
    for (const c of sections[secName] ?? []) {
      if (c.class !== "NEW") continue;
      const sid = resolveShift(c);
      if (!sid) {
        const rec = (c.record ?? {}) as Row;
        held.push({
          reason: "unresolved_shift",
          natural_key: prodKey(secName, rec),
          detail: `${secName} NEW without resolvable shift_id`,
          kind: "unresolved_shift",
          row: prodHeldRow(secName, rec),
        });
        continue;
      }
      const rec = (c.record ?? {}) as Row;
      const payload: Row = { shift_id: sid };
      for (const col of cols) payload[col] = rec[col] ?? null;
      try {
        const res = await db.insertIfAbsent(table, [payload], ["shift_id"]);
        if (res.inserted.length > 0) {
          const nid = res.inserted[0].id as string;
          inserts++;
          await db.writeIngestionAudit({
            tableName: table, recordId: nid, operation: "INSERT",
            comment: prov(table, runTs), snapshot: payload,
          });
        } else {
          // ── L-052 (2026-09-17): a collision must SHOW BOTH ROWS ──────────────
          // This hold used to say only "already present", which is a statement about the
          // database's uniqueness constraint and not about the plant. The 2026-08-01
          // AUGUST shift is why that is not enough: the stored row was JULY's carryover
          // (590.5 kg, "PCG") and the incoming one was AUGUST's own opening day (993.5 kg,
          // "ZAMBAONGA") — two different real rows, and the message gave a human no way to
          // tell which one belonged. The stored row is re-read HERE, on the collision path
          // only (so an ordinary run pays nothing), and BOTH sides ride in the held row.
          // Nothing is overwritten: the latch rule stands, and the repair is
          // `scripts/backfill-waste-frontier-gap.ts`.
          const stored = await readCollidingRow(db, table, sid, cols);
          const incoming: Record<string, unknown> = {};
          for (const col of cols) incoming[col] = rec[col] ?? null;
          const storedTotal = secName === "waste" ? streamTotal(stored) : null;
          const incomingTotal = secName === "waste" ? streamTotal(incoming) : null;
          const bothTotals =
            storedTotal !== null && incomingTotal !== null
              ? ` The stored row totals ${fmtNum(storedTotal)} kg (${String(stored?.remarks ?? "no note")}); ` +
                `the report's row totals ${fmtNum(incomingTotal)} kg (${String(rec.remarks ?? "no note")}).`
              : "";
          held.push({
            reason: "already_exists_or_collision",
            natural_key: prodKey(secName, rec),
            detail:
              `This shift already has a ${sectionWord(secName)} row, so the report's row was ` +
              `NOT written and nothing was overwritten.${bothTotals} Check which one belongs ` +
              `to this shift before repairing it.`,
            kind: "already_exists",
            row: {
              ...prodHeldRow(secName, rec),
              shift_id: sid,
              db_row_id: stored?.id ? String(stored.id) : null,
              db_human_edited: stored?.human_edited_at != null,
              stored,
              incoming,
              stored_total_kg: storedTotal,
              incoming_total_kg: incomingTotal,
            },
          });
        }
      } catch (exc) {
        errors.push(
          operatorError(
            `Couldn't save the ${sectionWord(secName)} for one shift — the database refused ` +
              `it. That entry was not saved; the email stays unprocessed so the next run ` +
              `tries again.`,
            `${secName} insert shift ${sid}: ${errText(exc)}`,
          ),
        );
      }
    }
  }

  await emit?.("apply", "Writing electricity and truck readings…", 62);

  // ── 4. electricity + trucks (natural-key, no shift; generated cols never written) ──
  const nkSpecs: Array<[keyof ProductionSections, string, string[], string[]]> = [
    ["electricity", "electricity_readings", ["reading_date", "meter", "start_kwh", "end_kwh", "meter_multiplier", "remarks"], ["reading_date", "meter"]],
    ["trucks", "truck_readings", ["reading_date", "plate_no", "start_km", "end_km", "fuel_liters", "remarks"], ["reading_date", "plate_no"]],
  ];
  for (const [secName, table, cols, nkey] of nkSpecs) {
    for (const c of sections[secName] ?? []) {
      if (c.class !== "NEW") continue;
      const rec = (c.record ?? {}) as Row;
      const payload: Row = {};
      for (const col of cols) payload[col] = rec[col] ?? null;
      try {
        const res = await db.insertIfAbsent(table, [payload], nkey);
        if (res.inserted.length > 0) {
          const nid = res.inserted[0].id as string;
          inserts++;
          await db.writeIngestionAudit({
            tableName: table, recordId: nid, operation: "INSERT",
            comment: prov(table, runTs), snapshot: payload,
          });
        } else {
          held.push({
            reason: "already_exists",
            natural_key: label([rec.reading_date, rec.meter ?? rec.plate_no, `${secName} (already recorded)`]) || table,
            detail: "idempotent skip",
            kind: "already_exists",
            row: { section: secName, reading_date: rec.reading_date ?? null, meter: rec.meter ?? null, plate_no: rec.plate_no ?? null },
          });
        }
      } catch (exc) {
        errors.push(
          operatorError(
            `Couldn't save one ${tableWord(table)} reading — the database refused it. That ` +
              `reading was not saved; the email stays unprocessed so the next run tries again.`,
            `${table} insert: ${errText(exc)}`,
          ),
        );
      }
    }
  }

  await emit?.("apply", "Applying changed rows…", 78);

  // ── 5. VALUE_CHANGED (all sections) → CONDITIONAL update + manual audit ──
  //
  // Two layers, doing two different jobs:
  //
  //   VISIBILITY — a row already latched (`compact.human_edited_ids`) is never sent to
  //     the writer at all; it becomes a `ProductionHumanEdit` note carrying BOTH values.
  //     This runs BEFORE the empty-patch skip on purpose: the disagreement exists whether
  //     or not there is a patch to write, and staying silent about it is the actual
  //     complaint ("sync has to know when i edited something in the app").
  //
  //   CORRECTNESS — everything else goes through `fn_apply_production_upstream`, whose
  //     UPDATE carries `human_edited_at IS NULL` in its OWN WHERE. A save that lands
  //     between the read above and this call therefore still wins, and comes back as
  //     `human_edited`. There is no read-then-write anywhere on this path.
  //
  // NOTE ON THE PATCH SHAPE (unchanged, deliberately): the classifiers emit
  // `{field:{db,email}}` (runs/downtime/waste) and `[{field,emailValue,dbValue}]`
  // (electricity/trucks); this reads a `new` key that NEITHER carries, faithfully
  // mirroring sync_production.py. So in the live pipeline the patch is empty and no
  // update is attempted — the write path is DORMANT. Repairing that shape is a separate,
  // deliberate decision (it would start writing MC's values over the DB); this change
  // only makes sure the guard is already underneath it when someone does.
  const tableFor: Record<keyof ProductionSections, string> = {
    runs: "production_runs", downtime: "production_downtime", waste: "production_waste",
    electricity: "electricity_readings", trucks: "truck_readings",
  };
  const humanEditedIds = new Set(compact.human_edited_ids ?? []);
  const humanEdits: ProductionHumanEdit[] = [];
  const ops: Row[] = [];
  /** Per-op bookkeeping so an RPC outcome can be turned back into an audit row / note. */
  const opMeta = new Map<string, {
    section: keyof ProductionSections; table: string; diff: unknown;
    rec: Row; changed: Array<{ field: string; yours: unknown; sheet: unknown }>;
  }>();

  for (const secName of Object.keys(tableFor) as Array<keyof ProductionSections>) {
    const tbl = tableFor[secName];
    for (const c of sections[secName] ?? []) {
      if (c.class !== "VALUE_CHANGED" || !c.existing_id) continue;
      const id = String(c.existing_id);
      const diff = (c.diff ?? {}) as Record<string, unknown> | Array<{ field: string; emailValue?: unknown; dbValue?: unknown }>;
      const rec = (c.record ?? {}) as Row;
      const changed = changedFields(diff);

      if (humanEditedIds.has(id)) {
        humanEdits.push(humanEditNote(secName, tbl, id, rec, changed, "known_before_write"));
        continue;
      }

      // Build the patch from the SAME normalization the run findings use. Both
      // classifier diff shapes carry the sheet value under a shape-specific key
      // (`email` / `emailValue`) and NEITHER has ever had a `new` key — the old
      // `"new" in entry` test therefore matched nothing, every patch came out
      // empty, and this writer has never applied a single correction. Reading
      // `changed` also drops the generated columns exactly once, in one place.
      const patch: Row = {};
      for (const { field, sheet } of changed) patch[field] = sheet;
      if (Object.keys(patch).length === 0) continue;

      ops.push({ table: tbl, id, patch });
      opMeta.set(`${tbl}|${id}`, { section: secName, table: tbl, diff, rec, changed });
    }
  }

  if (ops.length > 0) {
    try {
      for (const res of await db.applyProductionUpstream(ops)) {
        const meta = opMeta.get(`${res.table}|${res.id}`);
        if (!meta) continue;
        if (res.outcome === "applied") {
          updates++;
          await db.writeIngestionAudit({
            tableName: meta.table, recordId: res.id, operation: "UPDATE",
            comment: prov(meta.table, runTs, "UPDATE"), diff: meta.diff as Row,
          });
        } else if (res.outcome === "human_edited") {
          humanEdits.push(
            humanEditNote(meta.section, meta.table, res.id, meta.rec, meta.changed, "refused_by_db"),
          );
        } else {
          // missing / empty_patch / unsupported_field / not_applied — nothing was written
          // and it is NOT a human-arbitration case, so it must surface as a real problem
          // (errors[] also blocks the watermark bump + the Gmail label).
          errors.push(
            operatorError(
              `One ${tableWord(meta.table)} row the report changed was not updated — the ` +
                `database would not accept the change. Everything else this run saved is ` +
                `fine; the email stays unprocessed so the next run tries this row again.`,
              `${meta.table} update ${res.id}: not applied (${res.outcome})`,
            ),
          );
        }
      }
    } catch (exc) {
      errors.push(
        operatorError(
          `Couldn't apply the production changes this report asked for — the database ` +
            `refused the whole batch of updates. Nothing was changed; the email stays ` +
            `unprocessed so the next run tries again.`,
          `production conditional update failed: ${errText(exc)}`,
        ),
      );
    }
  }

  for (const h of humanEdits) {
    await emit?.(
      "apply",
      `${h.transaction_date ?? "a row"} ${h.section}: you edited this in the app, so the ` +
        `report's different value was NOT written — please confirm which is right.`,
      80,
      undefined,
      "warn",
    );
  }

  // ── 6. MALFORMED → held everywhere ──
  for (const secName of Object.keys(sections) as Array<keyof ProductionSections>) {
    for (const c of sections[secName] ?? []) {
      if (c.class === "MALFORMED") {
        const reasons = (c.reasons as string[] | undefined) ?? [];
        const rec = (c.record ?? {}) as Row;
        held.push({
          reason: "malformed",
          natural_key: prodKey(secName, rec),
          detail: reasons.join("; ") || "malformed row held",
          kind: "malformed",
          row: prodHeldRow(secName, rec),
        });
      }
    }
  }

  let watermarkUpdated = false;
  let labeled = false;
  if (errors.length === 0) {
    await emit?.("apply", "Updating the audit trail…", 90);
    watermarkUpdated = await db.upsertIngestionWatermark(compact.report_type, {
      lastEmailId: compact.source?.mc_thread_id ?? null,
    });
    if (!deps.noLabel) {
      const uids = [compact.source?.mc_uid, compact.source?.ivy_uid].filter(
        (u): u is number | string => u !== null && u !== undefined && u !== "",
      );
      if (uids.length > 0 && deps.labeler) {
        await emit?.("apply", "Marking the email(s) as processed…", 95);
        labeled = await deps.labeler(uids);
      }
    }
  }

  if (errors.length > 0) {
    await emit?.("finalize", `Finished with ${errors.length} problem(s) — see details.`, 100, undefined, "warn");
  } else if (inserts || updates) {
    await emit?.("finalize", `Done — ${inserts} new, ${updates} updated.`, 100);
  } else {
    await emit?.("finalize", "Done — nothing new to write.", 100);
  }

  return {
    report_type: compact.report_type,
    ok: errors.length === 0,
    inserts,
    updates,
    held,
    labeled,
    watermark_updated: watermarkUpdated,
    errors,
    production_batch_starts: compact.batch_starts ?? [],
    production_human_edits: humanEdits,
    downtime_notes: buildDowntimeNotes(sections),
    waste_notes: compact.waste_notes ?? [],
  };
}
