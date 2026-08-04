/**
 * production-value-changed-patch.test.ts — the DORMANT WRITER (2026-08-04).
 *
 * The defect: `apply.ts` built its patch by looking for a `new` key —
 *   Array shape:  `if ("new" in entry) patch[entry.field] = entry.new`
 *   Object shape: `if ("new" in v)     patch[f]          = v.new`
 * — but NEITHER classifier has ever emitted a `new` key. `runs`/`downtime`/`waste`
 * emit `{ field: { db, email } }`; `electricity`/`trucks` emit
 * `[{ field, emailValue, dbValue }]`. So every patch came out `{}`, every op was
 * `continue`d, and the production sync had **never applied a single correction**
 * from MC's or Ivy's workbook. It failed silently and reported success.
 *
 * `production-human-edit.test.ts` did not catch it because its fixtures inject a
 * synthetic `new` key alongside the real one specifically so the write path would
 * be reachable while dormant. These tests use the REAL classifier output — nothing
 * hand-shaped — so they fail against the old patch builder.
 *
 * The second half locks the landmine found while fixing it: a classifier must never
 * emit a field the RPC's allowlist does not carry. `fn_apply_production_upstream`
 * refuses the WHOLE op on one unknown key (`unsupported_field`), so a phantom field
 * takes that row's genuine corrections down with it.
 */
import { describe, it, expect } from "vitest";

import {
  applyProduction,
  type ProductionCompact,
  type ProductionSections,
} from "../../src/reports/production/apply.js";
import {
  classifyDowntime,
  classifyRuns,
  classifyTrucks,
  type DowntimeDbRow,
  type RunDbRow,
  type ShiftDbRow,
  type TruckDbRow,
} from "../../src/reports/production/classify.js";
import type { DowntimeRow, RunRow, TruckRow } from "../../src/reports/production/extractMc.js";
import type { DbClient, Row } from "../../src/lib/db.js";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function emptySections(): ProductionSections {
  return { runs: [], downtime: [], waste: [], electricity: [], trucks: [] };
}

function compactWith(sections: ProductionSections): ProductionCompact {
  return {
    report_type: "production",
    since: "2026-01-01",
    window: ["2026-06-30", "2026-07-07"],
    source: { mc_uid: null, ivy_uid: null, mc_thread_id: null },
    sections,
  };
}

/** Records only what reaches the conditional writer — that is the whole question here. */
function opRecorder(): { db: DbClient; ops: Row[] } {
  const ops: Row[] = [];
  const stub: Partial<DbClient> = {
    insertIfAbsent: async (_t: string, rows: Row[]) => ({
      inserted: rows.map((r) => ({ ...r, id: "NEW-1" })),
      skipped: [],
      insertedCount: rows.length,
      skippedCount: 0,
    }),
    update: async () => [],
    applyProductionUpstream: async (batch: Row[]) => {
      ops.push(...batch);
      return batch.map((o) => ({ table: String(o.table), id: String(o.id), outcome: "applied" }));
    },
    selectOne: async () => null,
    writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
    upsertIngestionWatermark: async () => true,
  };
  return { db: stub as DbClient, ops };
}

const SHIFTS: ShiftDbRow[] = [
  { id: "SID-1", transaction_date: "2026-06-30", production_batch: "JUNE-26", shift: "MORNING" },
];

/** A downtime row exactly as extractMc emits it — including the phantom `remarks`. */
function downtimeEmailRow(over: Partial<DowntimeRow> = {}): DowntimeRow {
  return {
    transaction_date: "2026-06-30",
    production_batch: "JUNE-26",
    shift: "MORNING",
    shift_hrs: 12,
    dt_hrs: 1,
    dt_mins: 30,
    dt_reason: "MECHANICAL | belt slip",
    remarks: "Time ranges: 08:00-09:30",
    _source_sheet: "06-30-26",
    warnings: [],
    ...over,
  };
}

function runEmailRow(over: Partial<RunRow> = {}): RunRow {
  return {
    transaction_date: "2026-06-30",
    production_batch: "JUNE-26",
    shift: "MORNING",
    customer: "CEBU",
    grade: "3X50",
    ttl_kg: 13685,
    sacks_bags: 200,
    remarks: null,
    _shift_defaulted: false,
    _source_sheet: "06-30-26",
    _source_row: 12,
    warnings: [],
    confidence: 1.0,
    ...over,
  };
}

function truckEmailRow(over: Partial<TruckRow> = {}): TruckRow {
  return {
    reading_date: "2026-06-30",
    plate_no: "AAV 6111",
    start_km: 100,
    end_km: 480,
    fuel_liters: 40,
    remarks: null,
    _source_sheet: "06-30-26",
    _source_row: 30,
    warnings: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. The real classifier shapes must produce a NON-EMPTY patch.
// ---------------------------------------------------------------------------

describe("VALUE_CHANGED patch — built from what the classifiers actually emit", () => {
  it("OBJECT diff shape ({db,email}) — a runs correction reaches the writer", async () => {
    // Straight out of classifyRuns: no hand-shaping, no `new` key anywhere.
    const emailRows = [runEmailRow()];
    const dbRows: RunDbRow[] = [
      { id: "R-1", shift_id: "SID-1", customer: "CEBU", grade: "3X50", ttl_kg: 13680, sacks_bags: 200, remarks: null },
    ];

    const classified = classifyRuns(emailRows, dbRows, SHIFTS);
    const changed = classified.classifications.filter((c) => c.class === "VALUE_CHANGED");
    expect(changed).toHaveLength(1);
    // Guard the premise: there is no `new` key to read.
    expect(JSON.stringify(changed[0].diff)).not.toContain('"new"');

    const sections = emptySections();
    sections.runs = changed;
    const rec = opRecorder();
    const res = await applyProduction(compactWith(sections), { db: rec.db });

    // THE regression: the old builder produced {} here and `continue`d.
    expect(rec.ops).toHaveLength(1);
    expect(rec.ops[0]).toMatchObject({ table: "production_runs", id: "R-1" });
    expect((rec.ops[0].patch as Row).ttl_kg).toBe(13685);
    expect(res.updates).toBe(1);
  });

  it("ARRAY diff shape ({field,emailValue,dbValue}) — a trucks correction reaches the writer", async () => {
    const emailRows = [truckEmailRow()];
    const dbRows: TruckDbRow[] = [
      { id: "T-1", reading_date: "2026-06-30", plate_no: "AAV 6111", start_km: 100, end_km: 460, fuel_liters: 40, remarks: null },
    ];

    const classified = classifyTrucks(emailRows, dbRows);
    const changed = classified.classifications.filter((c) => c.class === "VALUE_CHANGED");
    expect(changed).toHaveLength(1);
    expect(JSON.stringify(changed[0].diff)).not.toContain('"new"');

    const sections = emptySections();
    sections.trucks = changed;
    const rec = opRecorder();
    await applyProduction(compactWith(sections), { db: rec.db });

    expect(rec.ops).toHaveLength(1);
    expect(rec.ops[0]).toMatchObject({ table: "truck_readings", id: "T-1" });
    expect((rec.ops[0].patch as Row).end_km).toBe(480);
  });

  it("a GENERATED column never enters the patch", async () => {
    // ttl_km is computed by the DB; writing it would be rejected outright.
    const sections = emptySections();
    sections.trucks = [{
      idx: 0,
      class: "VALUE_CHANGED",
      natural_key: { reading_date: "2026-06-30", plate_no: "AAV 6111" },
      existing_id: "T-GEN",
      diff: [
        { field: "end_km", emailValue: 480, dbValue: 460 },
        { field: "ttl_km", emailValue: 380, dbValue: 360 },
      ],
      record: { reading_date: "2026-06-30", plate_no: "AAV 6111", end_km: 480 },
      reasons: ["2 field(s) differ from existing row"],
      confidence: 0.95,
    }];

    const rec = opRecorder();
    await applyProduction(compactWith(sections), { db: rec.db });

    expect(rec.ops).toHaveLength(1);
    const patch = rec.ops[0].patch as Row;
    expect(patch.end_km).toBe(480);
    expect(patch).not.toHaveProperty("ttl_km");
  });

  it("a diff of ONLY generated columns still writes nothing", async () => {
    const sections = emptySections();
    sections.trucks = [{
      idx: 0,
      class: "VALUE_CHANGED",
      natural_key: { reading_date: "2026-06-30", plate_no: "AAV 6111" },
      existing_id: "T-ONLY-GEN",
      diff: [{ field: "ttl_km", emailValue: 380, dbValue: 360 }],
      record: { reading_date: "2026-06-30", plate_no: "AAV 6111" },
      reasons: ["1 field(s) differ from existing row"],
      confidence: 0.95,
    }];

    const rec = opRecorder();
    await applyProduction(compactWith(sections), { db: rec.db });

    expect(rec.ops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The phantom column. `production_downtime` has no `remarks`.
// ---------------------------------------------------------------------------

describe("downtime `remarks` is a phantom — it must never be diffed", () => {
  it("an email-only remarks does NOT make the row VALUE_CHANGED", () => {
    // The extractor always builds `remarks` ("Time ranges: …") and the insert path
    // drops it, so the DB side is permanently absent. Comparing them made every
    // downtime row carrying time ranges a permanent, self-renewing disagreement.
    const dbRows: DowntimeDbRow[] = [
      { id: "D-1", shift_id: "SID-1", shift_hrs: 12, dt_hrs: 1, dt_mins: 30, dt_reason: "MECHANICAL | belt slip" },
    ];

    const res = classifyDowntime([downtimeEmailRow()], dbRows, SHIFTS);

    expect(res.classifications).toHaveLength(1);
    expect(res.classifications[0].class).toBe("DUPLICATE_NOOP");
    expect(res.summary.value_changed ?? 0).toBe(0);
  });

  it("a REAL downtime disagreement is still caught, and carries no remarks key", () => {
    const dbRows: DowntimeDbRow[] = [
      { id: "D-2", shift_id: "SID-1", shift_hrs: 12, dt_hrs: 1, dt_mins: 15, dt_reason: "MECHANICAL | belt slip" },
    ];

    const res = classifyDowntime([downtimeEmailRow()], dbRows, SHIFTS);

    expect(res.classifications[0].class).toBe("VALUE_CHANGED");
    const diff = res.classifications[0].diff as Record<string, unknown>;
    expect(diff).toHaveProperty("dt_mins");
    expect(diff).not.toHaveProperty("remarks");
  });
});

// ---------------------------------------------------------------------------
// 3. Nothing a classifier emits may fall outside the RPC's allowlist.
// ---------------------------------------------------------------------------

/**
 * Mirrors the `allowed(tbl, col)` VALUES list in `fn_apply_production_upstream`
 * (migration 20260803080000). One unknown key refuses the WHOLE op, so a field the
 * RPC does not know is not a dropped field — it is a lost correction on every other
 * field of that row. Keep this in step with the migration.
 */
const RPC_ALLOWLIST: Record<string, string[]> = {
  production_runs: ["customer", "grade", "ttl_kg", "sacks_bags", "remarks"],
  production_downtime: ["shift_hrs", "dt_hrs", "dt_mins", "dt_reason"],
  production_waste: ["rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg", "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg", "remarks"],
  electricity_readings: ["start_kwh", "end_kwh", "meter_multiplier", "remarks"],
  truck_readings: ["start_km", "end_km", "fuel_liters", "remarks"],
};

describe("every patch key is a column the RPC will accept", () => {
  it("a downtime correction sends only allowlisted keys", async () => {
    const dbRows: DowntimeDbRow[] = [
      { id: "D-3", shift_id: "SID-1", shift_hrs: 11, dt_hrs: 0, dt_mins: 5, dt_reason: "ELECTRICAL" },
    ];
    const classified = classifyDowntime([downtimeEmailRow()], dbRows, SHIFTS);

    const sections = emptySections();
    sections.downtime = classified.classifications.filter((c) => c.class === "VALUE_CHANGED");
    const rec = opRecorder();
    await applyProduction(compactWith(sections), { db: rec.db });

    expect(rec.ops).toHaveLength(1);
    const keys = Object.keys(rec.ops[0].patch as Row);
    expect(keys.length).toBeGreaterThan(0);
    // Before the phantom fix this contained `remarks` and the RPC refused the op.
    for (const k of keys) expect(RPC_ALLOWLIST.production_downtime).toContain(k);
  });

  it("runs and trucks corrections send only allowlisted keys", async () => {
    const runsDb: RunDbRow[] = [
      { id: "R-2", shift_id: "SID-1", customer: "CEBU", grade: "3X50", ttl_kg: 1, sacks_bags: 1, remarks: "old" },
    ];
    const runsEmail = [runEmailRow({ ttl_kg: 2, sacks_bags: 2, remarks: "new note" })];

    const trucksDb: TruckDbRow[] = [
      { id: "T-2", reading_date: "2026-06-30", plate_no: "AAV 6111", start_km: 1, end_km: 2, fuel_liters: 3, remarks: "old" },
    ];
    const trucksEmail = [truckEmailRow({ start_km: 10, end_km: 20, fuel_liters: 30, remarks: "new note" })];

    const sections = emptySections();
    sections.runs = classifyRuns(runsEmail, runsDb, SHIFTS).classifications
      .filter((c) => c.class === "VALUE_CHANGED");
    sections.trucks = classifyTrucks(trucksEmail, trucksDb).classifications
      .filter((c) => c.class === "VALUE_CHANGED");

    const rec = opRecorder();
    await applyProduction(compactWith(sections), { db: rec.db });

    expect(rec.ops).toHaveLength(2);
    for (const op of rec.ops) {
      const allowed = RPC_ALLOWLIST[String(op.table)];
      expect(allowed).toBeDefined();
      for (const k of Object.keys(op.patch as Row)) expect(allowed).toContain(k);
    }
  });
});
