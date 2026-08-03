/**
 * production-human-edit.test.ts — the HUMAN-EDIT LATCH (2026-08-03).
 *
 * The defect: `apply.ts` step 5 turned every VALUE_CHANGED into a bare
 * `db.update(table, {id}, patch)`. The app edits those same tables, so a number an
 * operator corrected by hand would be reverted by the next run — silently — because
 * MC's workbook still says the old value.
 *
 * What is locked here (the four bars from the brief):
 *   1. a row a human edited is NEVER written (not "carefully written" — the op never
 *      reaches the writer, and if it races, the DB guard refuses it);
 *   2. the disagreement is SURFACED, naming the row and BOTH values;
 *   3. a released row follows the report again;
 *   4. brand-new rows still INSERT — the latch constrains updates only.
 *
 * The single-statement guard itself lives in `fn_apply_production_upstream` and is
 * proven against the live DB in a rolled-back DO block (see the migration). These tests
 * cover the worker's half: what it sends, what it refuses to send, and what it reports.
 */
import { describe, it, expect } from "vitest";

import {
  applyProduction,
  type ProductionCompact,
  type ProductionSections,
} from "../../src/reports/production/apply.js";
import type { DbClient, Row, InsertIfAbsentResult } from "../../src/lib/db.js";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function emptySections(): ProductionSections {
  return { runs: [], downtime: [], waste: [], electricity: [], trucks: [] };
}

function compactWith(
  sections: ProductionSections,
  humanEditedIds?: string[],
): ProductionCompact {
  return {
    report_type: "production",
    since: "2026-01-01",
    window: ["2026-06-30", "2026-07-07"],
    source: { mc_uid: null, ivy_uid: null, mc_thread_id: null },
    sections,
    ...(humanEditedIds ? { human_edited_ids: humanEditedIds } : {}),
  };
}

function okInsert(row: Row): InsertIfAbsentResult {
  const inserted = { ...row, id: `NEW-${Math.random().toString(36).slice(2, 8)}` };
  return { inserted: [inserted], skipped: [], insertedCount: 1, skippedCount: 0 };
}

interface Recorder {
  db: DbClient;
  /** Ops actually handed to the conditional writer. */
  ops: Row[];
  /** Anything that went through the raw, UNGUARDED update path (must stay empty). */
  rawUpdates: Array<{ table: string; patch: Row }>;
  inserts: Array<{ table: string; row: Row }>;
  audits: Array<{ table: string; op: string }>;
}

/** DbClient stub that records both write paths so we can prove which one was used. */
function recorder(
  outcomeFor: (op: Row) => string = () => "applied",
): Recorder {
  const ops: Row[] = [];
  const rawUpdates: Array<{ table: string; patch: Row }> = [];
  const inserts: Array<{ table: string; row: Row }> = [];
  const audits: Array<{ table: string; op: string }> = [];

  const stub: Partial<DbClient> = {
    insertIfAbsent: async (table: string, rows: Row[]) => {
      inserts.push({ table, row: rows[0] });
      return okInsert(rows[0]);
    },
    update: async (table: string, _filters: Record<string, string>, patch: Row) => {
      rawUpdates.push({ table, patch });
      return [];
    },
    applyProductionUpstream: async (batch: Row[]) => {
      ops.push(...batch);
      return batch.map((o) => ({
        table: String(o.table),
        id: String(o.id),
        outcome: outcomeFor(o),
      }));
    },
    selectOne: async () => null,
    writeIngestionAudit: async (a) => {
      audits.push({ table: a.tableName, op: a.operation });
      return { id: "AUDIT-1" };
    },
    upsertIngestionWatermark: async () => true,
  };
  return { db: stub as DbClient, ops, rawUpdates, inserts, audits };
}

/**
 * A runs VALUE_CHANGED whose diff carries BOTH the classifier's real `{db,email}` shape
 * AND the `{new}` key apply reads, so the write path is actually exercised. (In the live
 * pipeline the classifiers emit only `{db,email}`, which is why the update is dormant —
 * see the note in apply.ts. Locking the guard must not depend on that staying true.)
 */
function runsChanged(id: string, dbKg: number, sheetKg: number) {
  return {
    idx: 0,
    class: "VALUE_CHANGED",
    natural_key: { shift_id: "SID-1", customer: "CEBU", grade: "3X50" },
    existing_id: id,
    diff: { ttl_kg: { db: dbKg, email: sheetKg, new: sheetKg } },
    record: {
      transaction_date: "2026-06-30",
      production_batch: "JUNE-26",
      shift: "M",
      customer: "CEBU",
      grade: "3X50",
      ttl_kg: sheetKg,
    },
    reasons: ["1 field(s) differ: ttl_kg"],
    confidence: 0.95,
  };
}

/** A trucks VALUE_CHANGED — the LIST diff shape (electricity/trucks classifiers). */
function trucksChanged(id: string, dbKm: number, sheetKm: number) {
  return {
    idx: 0,
    class: "VALUE_CHANGED",
    natural_key: { reading_date: "2026-06-30", plate_no: "AAV 6111" },
    existing_id: id,
    diff: [{ field: "end_km", emailValue: sheetKm, dbValue: dbKm, new: sheetKm }],
    record: { reading_date: "2026-06-30", plate_no: "AAV 6111", end_km: sheetKm },
    reasons: ["1 field(s) differ from existing row"],
    confidence: 0.95,
  };
}

// ---------------------------------------------------------------------------
// 1. An UNTOUCHED row is still updated — the guard must not freeze the pipeline.
// ---------------------------------------------------------------------------

describe("human-edit latch — an untouched row still updates", () => {
  it("sends the op to the conditional writer and counts the update", async () => {
    const rec = recorder();
    const sections = emptySections();
    sections.runs = [runsChanged("R-UNTOUCHED", 13680, 13685)];

    const res = await applyProduction(compactWith(sections), { db: rec.db });

    expect(rec.ops).toHaveLength(1);
    expect(rec.ops[0]).toMatchObject({ table: "production_runs", id: "R-UNTOUCHED" });
    expect((rec.ops[0].patch as Row).ttl_kg).toBe(13685);
    expect(res.updates).toBe(1);
    expect(res.production_human_edits).toEqual([]);
    expect(res.errors).toEqual([]);
    expect(rec.audits).toContainEqual({ table: "production_runs", op: "UPDATE" });
  });

  it("NEVER uses the raw unguarded db.update path for a fact table", async () => {
    const rec = recorder();
    const sections = emptySections();
    sections.runs = [runsChanged("R-1", 1, 2)];
    sections.trucks = [trucksChanged("T-1", 100, 200)];

    await applyProduction(compactWith(sections), { db: rec.db });

    // If this ever regresses, the human-edit guard is bypassed entirely.
    expect(rec.rawUpdates).toEqual([]);
    expect(rec.ops.map((o) => o.table).sort()).toEqual(["production_runs", "truck_readings"]);
  });
});

// ---------------------------------------------------------------------------
// 2. A HUMAN-EDITED row is never written, and the disagreement is surfaced.
// ---------------------------------------------------------------------------

describe("human-edit latch — a row the human edited is never overwritten", () => {
  it("does not even send the op, and reports both values", async () => {
    const rec = recorder();
    const sections = emptySections();
    sections.runs = [runsChanged("R-MINE", 13685, 13680)];

    const res = await applyProduction(compactWith(sections, ["R-MINE"]), { db: rec.db });

    // Bar 1: not written. Not "carefully written" — never handed to the writer at all.
    expect(rec.ops).toEqual([]);
    expect(rec.rawUpdates).toEqual([]);
    expect(res.updates).toBe(0);

    // Bar 2: surfaced, naming the row and BOTH values.
    expect(res.production_human_edits).toHaveLength(1);
    const note = res.production_human_edits[0];
    expect(note).toMatchObject({
      section: "runs",
      table: "production_runs",
      record_id: "R-MINE",
      transaction_date: "2026-06-30",
      production_batch: "JUNE-26",
      shift: "M",
      outcome: "known_before_write",
    });
    expect(note.changed_fields).toEqual([
      { field: "ttl_kg", yours: 13685, sheet: 13680 },
    ]);

    // A refusal is an arbitration, not a failure: the run stays ok so the watermark
    // still advances and the email is still labelled.
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("surfaces the disagreement even when there is no patch to write (today's dormant path)", async () => {
    // The live classifiers emit `{db,email}` with NO `new` key, so the patch is empty
    // and nothing would be written either way. The operator must STILL be told the
    // report disagrees with their edit — silence is the actual complaint.
    const rec = recorder();
    const sections = emptySections();
    sections.runs = [
      {
        ...runsChanged("R-MINE", 13685, 13680),
        diff: { ttl_kg: { db: 13685, email: 13680 } },
      },
    ];

    const res = await applyProduction(compactWith(sections, ["R-MINE"]), { db: rec.db });

    expect(rec.ops).toEqual([]);
    expect(res.production_human_edits).toHaveLength(1);
    expect(res.production_human_edits[0].changed_fields).toEqual([
      { field: "ttl_kg", yours: 13685, sheet: 13680 },
    ]);
  });

  it("handles the LIST diff shape (electricity/trucks) too", async () => {
    const rec = recorder();
    const sections = emptySections();
    sections.trucks = [trucksChanged("T-MINE", 16020.5, 16020.9)];

    const res = await applyProduction(compactWith(sections, ["T-MINE"]), { db: rec.db });

    expect(rec.ops).toEqual([]);
    expect(res.production_human_edits).toHaveLength(1);
    expect(res.production_human_edits[0]).toMatchObject({
      section: "trucks",
      table: "truck_readings",
      transaction_date: "2026-06-30",
      plate_no: "AAV 6111",
    });
    expect(res.production_human_edits[0].changed_fields).toEqual([
      { field: "end_km", yours: 16020.5, sheet: 16020.9 },
    ]);
  });

  it("the DB guard still catches a row claimed AFTER the run's snapshot (the race)", async () => {
    // The worker's `human_edited_ids` list is advisory. If the operator saves between
    // the window read and the write, ONLY the guard inside the RPC's own UPDATE saves
    // them — the op is sent, and comes back refused.
    const rec = recorder((op) => (op.id === "R-RACED" ? "human_edited" : "applied"));
    const sections = emptySections();
    sections.runs = [runsChanged("R-RACED", 13685, 13680)];

    const res = await applyProduction(compactWith(sections), { db: rec.db });

    expect(rec.ops).toHaveLength(1); // it WAS sent — the snapshot said it was free
    expect(res.updates).toBe(0); // ...and the DB refused it
    expect(res.production_human_edits).toHaveLength(1);
    expect(res.production_human_edits[0].outcome).toBe("refused_by_db");
    expect(res.errors).toEqual([]);
    // No audit row for a write that never happened.
    expect(rec.audits).toEqual([]);
  });

  it("a mixed batch applies the free rows and refuses only the claimed one", async () => {
    const rec = recorder();
    const sections = emptySections();
    sections.runs = [runsChanged("R-FREE", 1, 2), runsChanged("R-MINE", 3, 4)];
    sections.trucks = [trucksChanged("T-FREE", 10, 20)];

    const res = await applyProduction(compactWith(sections, ["R-MINE"]), { db: rec.db });

    expect(rec.ops.map((o) => o.id).sort()).toEqual(["R-FREE", "T-FREE"]);
    expect(res.updates).toBe(2);
    expect(res.production_human_edits.map((h) => h.record_id)).toEqual(["R-MINE"]);
  });
});

// ---------------------------------------------------------------------------
// 3. A non-arbitration refusal is a real problem, not a silent skip.
// ---------------------------------------------------------------------------

describe("human-edit latch — non-arbitration outcomes are loud", () => {
  it("`missing` / `unsupported_field` become errors, which block the watermark + label", async () => {
    const rec = recorder((op) => (op.id === "R-GONE" ? "missing" : "unsupported_field"));
    const sections = emptySections();
    sections.runs = [runsChanged("R-GONE", 1, 2), runsChanged("R-ODD", 3, 4)];

    const res = await applyProduction(compactWith(sections), { db: rec.db, noLabel: true });

    expect(res.updates).toBe(0);
    expect(res.production_human_edits).toEqual([]);
    expect(res.errors).toHaveLength(2);
    expect(res.errors.join(" | ")).toContain("not applied (missing)");
    expect(res.errors.join(" | ")).toContain("not applied (unsupported_field)");
    expect(res.ok).toBe(false);
    expect(res.watermark_updated).toBe(false);
  });

  it("an RPC failure is recorded, never swallowed", async () => {
    const stub: Partial<DbClient> = {
      insertIfAbsent: async (_t: string, rows: Row[]) => okInsert(rows[0]),
      applyProductionUpstream: async () => {
        throw new Error("fn_apply_production_upstream RPC failed 42501: permission denied");
      },
      selectOne: async () => null,
      writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
      upsertIngestionWatermark: async () => true,
    };
    const sections = emptySections();
    sections.runs = [runsChanged("R-1", 1, 2)];

    const res = await applyProduction(compactWith(sections), { db: stub as DbClient });

    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain("production conditional update failed");
    expect(res.errors[0]).toContain("permission denied");
  });
});

// ---------------------------------------------------------------------------
// 4. Inserts are untouched — the latch constrains UPDATES only.
// ---------------------------------------------------------------------------

describe("human-edit latch — brand-new rows still insert", () => {
  it("a NEW run/downtime/electricity row inserts normally, with no ops and no notes", async () => {
    const rec = recorder();
    const sections = emptySections();
    sections.runs = [
      {
        idx: 0,
        class: "NEW",
        natural_key: { shift_id: "SID-1", customer: "CEBU", grade: "3X50" },
        resolved_shift_id: "SID-1",
        needs_shift_upsert: false,
        existing_id: null,
        diff: null,
        record: { customer: "CEBU", grade: "3X50", ttl_kg: 16380, sacks_bags: 630, remarks: null },
        reasons: [],
        confidence: 0.97,
      },
    ];
    sections.electricity = [
      {
        idx: 0,
        class: "NEW",
        natural_key: { reading_date: "2026-07-01", meter: "MAIN" },
        existing_id: null,
        diff: null,
        record: {
          reading_date: "2026-07-01", meter: "MAIN",
          start_kwh: 645.2, end_kwh: 652.2, meter_multiplier: 120, remarks: null,
        },
        reasons: [],
        confidence: 0.97,
      },
    ];

    const res = await applyProduction(compactWith(sections), { db: rec.db });

    expect(res.inserts).toBe(2);
    expect(rec.inserts.map((i) => i.table).sort()).toEqual([
      "electricity_readings",
      "production_runs",
    ]);
    // An insert never carries the stamp — a sync-created row is sync-owned.
    for (const i of rec.inserts) expect(i.row).not.toHaveProperty("human_edited_at");
    expect(rec.ops).toEqual([]);
    expect(res.production_human_edits).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it("a claimed row does not block an insert that happens to share the run", async () => {
    const rec = recorder();
    const sections = emptySections();
    sections.runs = [
      {
        idx: 0,
        class: "NEW",
        natural_key: { shift_id: "SID-1", customer: "CEBU", grade: "6X50" },
        resolved_shift_id: "SID-1",
        needs_shift_upsert: false,
        existing_id: null,
        diff: null,
        record: { customer: "CEBU", grade: "6X50", ttl_kg: 900, sacks_bags: 30, remarks: null },
        reasons: [],
        confidence: 0.97,
      },
      runsChanged("R-MINE", 3, 4),
    ];

    const res = await applyProduction(compactWith(sections, ["R-MINE"]), { db: rec.db });

    expect(res.inserts).toBe(1);
    expect(res.updates).toBe(0);
    expect(res.production_human_edits).toHaveLength(1);
  });
});
