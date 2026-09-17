/**
 * production-waste-frontier.test.ts — L-052 (2026-09-17).
 *
 * THE BUG. `runReport` computed ONE `since` from `db.productionRunsFrontier()` — MC's
 * frontier — and handed it to BOTH extractors. `extractIvy`'s per-row filter is
 * `txnIso <= since -> continue`: EXCLUSIVE and SILENT. Ivy's WASTE PRODUCTION REPORT is
 * CUMULATIVE and always lands later than MC's daily report, so every day MC reported
 * before Ivy had filed it was skipped with no finding, no hold and no log line — and a
 * frontier only moves forward, so no later run could retry it. FIVE real waste days were
 * lost (2026-07-24, 07-30, 07-31, JULY's 08-01 carryover, 08-04), every one of them on a
 * shift that already carried MC's runs.
 *
 * THE FIX, in three parts, one `describe` each:
 *   1. waste gets its OWN frontier, and the window floor is `min(waste, runs) − 3 days`;
 *   2. the skip is no longer a discard — excluded rows come back in `belowSince`;
 *   3. `auditWasteGap` checks every excluded row against the database and NAMES anything
 *      wrong, so a gap can never again be silent.
 *
 * The parity harness is UNAFFECTED and that is asserted here too: `classifyCase` composes
 * from `ivy.waste`, which is byte-for-byte the array it always was.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DbClient,
  type Row,
  type ReadRowsOptions,
  type InsertIfAbsentResult,
} from "../../src/lib/db.js";
import {
  runReport,
  resolveWasteSince,
  type ProductionManifest,
  type RunReportDeps,
} from "../../src/reports/production/index.js";
import { extractIvy } from "../../src/reports/production/extractIvy.js";
import {
  applyProduction,
  type ProductionCompact,
} from "../../src/reports/production/apply.js";
import {
  auditWasteGap,
  SYNC_ERA_START,
  type WasteGapNote,
} from "../../src/reports/production/wasteGap.js";
import type { ShiftDbRow, WasteDbRow } from "../../src/reports/production/classify.js";
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../src/lib/xlsx.js";

const FX = join(__dirname, "../../fixtures/production/workbooks");
const MC_FIXTURE = join(FX, "production_real_mc.xlsx");
const IVY_FIXTURE = join(FX, "production_real_ivy.xlsx");

// ---------------------------------------------------------------------------
// A minimal Ivy workbook builder (same cell map as production.test.ts's).
// ---------------------------------------------------------------------------
interface FakeWasteRow {
  date: string;
  rs1a: number;
  rs1b: number;
  bf: number;
  rs23: number;
  rs5: number;
  trml1: number;
  trml2: number;
  grit: number;
  ttl: number;
  remarks?: string | null;
  shift?: string | null;
}

function fakeIvyWorkbook(sheets: Array<{ name: string; rows: FakeWasteRow[] }>): LoadedWorkbook {
  const built = new Map<string, LoadedSheet>();
  for (const s of sheets) {
    const cells = new Map<string, CellValue>();
    s.rows.forEach((rr, i) => {
      const row = 5 + i;
      const put = (col: number, v: CellValue) => cells.set(`${row},${col}`, v);
      const [y, m, d] = rr.date.split("-").map(Number);
      put(1, new Date(Date.UTC(y, m - 1, d)));
      put(3, rr.rs1a); put(5, rr.rs1b); put(7, rr.bf); put(9, rr.rs23);
      put(11, rr.rs5); put(13, rr.trml1); put(15, rr.trml2); put(17, rr.grit);
      put(18, rr.ttl); put(19, rr.remarks ?? null); put(22, rr.shift ?? null);
    });
    built.set(s.name, {
      name: s.name,
      rowCount: 5 + s.rows.length - 1,
      columnCount: 22,
      cell: (row: number, col: number) => cells.get(`${row},${col}`) ?? null,
    });
  }
  const names = sheets.map((s) => s.name);
  return {
    sheetNames: names,
    sheet: (n: string) => built.get(n) ?? null,
    sheetAt: (i: number) => built.get(names[i]) ?? null,
  };
}

/** The real 2026-07-24 row Ivy filed and the sync dropped (5,746.5 kg). */
const JUL_24: FakeWasteRow = {
  date: "2026-07-24",
  rs1a: 2800, rs1b: 2200, bf: 300, rs23: 200, rs5: 150,
  trml1: 70, trml2: 0.5, grit: 26, ttl: 5746.5, remarks: "PCG/ZAMBAONGA",
};
/** A day the database already has, byte-identical — the ordinary case. */
const JUL_23: FakeWasteRow = {
  date: "2026-07-23",
  rs1a: 2700, rs1b: 2500, bf: 200, rs23: 100, rs5: 20,
  trml1: 25, trml2: 0.5, grit: 0, ttl: 5545.5, remarks: "PCG/ZAMBAONGA",
};

// ===========================================================================
// 1. THE FRONTIER
// ===========================================================================
describe("db.productionWasteFrontier — waste's OWN watermark", () => {
  function fakeSb(result: { data: unknown; error: unknown }) {
    const calls = { from: "", select: "", order: [] as Array<[string, boolean]>, limit: 0 };
    const builder: Record<string, unknown> = {
      select(sel: string) {
        calls.select = sel;
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        calls.order.push([col, opts.ascending]);
        return builder;
      },
      limit(n: number) {
        calls.limit = n;
        return result;
      },
    };
    const sb = {
      from(table: string) {
        calls.from = table;
        return builder;
      },
    };
    return { sb, calls };
  }
  function dbWith(sb: unknown): DbClient {
    const db = Object.create(DbClient.prototype) as DbClient;
    (db as unknown as { sb: unknown }).sb = sb;
    return db;
  }

  it("issues production_shifts?select=transaction_date,production_waste!inner(id) desc limit 1", async () => {
    const { sb, calls } = fakeSb({
      data: [{ transaction_date: "2026-09-16", production_waste: [{ id: "w1" }] }],
      error: null,
    });
    expect(await dbWith(sb).productionWasteFrontier()).toBe("2026-09-16");
    expect(calls.from).toBe("production_shifts");
    // The embed is on production_WASTE — reading production_runs here would reproduce the
    // very coupling this method exists to remove.
    expect(calls.select).toBe("transaction_date,production_waste!inner(id)");
    expect(calls.order).toEqual([["transaction_date", false]]);
    expect(calls.limit).toBe(1);
  });

  it("slices a timestamp to YYYY-MM-DD and returns null on an empty result", async () => {
    const ts = fakeSb({
      data: [{ transaction_date: "2026-09-16T00:00:00+08:00", production_waste: [{ id: "w" }] }],
      error: null,
    });
    expect(await dbWith(ts.sb).productionWasteFrontier()).toBe("2026-09-16");
    const empty = fakeSb({ data: [], error: null });
    expect(await dbWith(empty.sb).productionWasteFrontier()).toBeNull();
  });

  it("throws on a PostgREST error (same style as the runs frontier)", async () => {
    const { sb } = fakeSb({ data: null, error: { code: "42P01", message: "boom" } });
    await expect(dbWith(sb).productionWasteFrontier()).rejects.toThrow(
      /production_waste_frontier failed/,
    );
  });
});

describe("resolveWasteSince — min(waste, runs) − 3 days", () => {
  it("THE BUG: when MC races ahead, the floor is pinned to WASTE, not to MC", () => {
    // MC at 2026-08-04, Ivy's last written waste at 2026-07-23. The old code used MC's
    // frontier, so 07-24 … 08-04 were all `<= since` and silently dropped.
    expect(resolveWasteSince("2026-08-04", "2026-07-23")).toBe("2026-07-20");
  });

  it("in the steady state (waste ahead of MC) the runs frontier pulls the window back", () => {
    // Ivy's cumulative file normally runs AHEAD; `min` lowers the floor to where MC is,
    // which is where the operator is still correcting things. It can only WIDEN.
    expect(resolveWasteSince("2026-09-15", "2026-09-16")).toBe("2026-09-12");
  });

  it("a NULL waste frontier means production_waste is empty — the whole workbook is in", () => {
    // MC's frontier must never stand in for waste's here either: that is the bug in one
    // line. With no waste rows at all there is nothing to be behind.
    expect(resolveWasteSince("2026-09-15", null)).toBe("2025-01-01");
    expect(resolveWasteSince(null, null)).toBe("2025-01-01");
  });

  it("a NULL runs frontier leaves waste's own frontier in charge", () => {
    expect(resolveWasteSince(null, "2026-07-23")).toBe("2026-07-20");
  });

  it("never returns earlier than the cold-start floor", () => {
    expect(resolveWasteSince("2025-01-01", "2025-01-02")).toBe("2025-01-01");
  });

  it("crosses a month boundary correctly (the pad is calendar days, not day-of-month)", () => {
    expect(resolveWasteSince("2026-08-02", "2026-08-02")).toBe("2026-07-30");
  });
});

// ===========================================================================
// 2. THE SKIP IS NO LONGER A DISCARD
// ===========================================================================
describe("extractIvy — an excluded row is PARKED, never thrown away", () => {
  const wb = () =>
    fakeIvyWorkbook([{ name: "JULY 2026", rows: [JUL_23, JUL_24] }]);

  it("`waste` keeps its exact old contents — strictly ABOVE `since` — so parity cannot move", () => {
    const { waste } = extractIvy(wb(), "2026-07-23");
    expect(waste).toHaveLength(1);
    expect(waste[0].transaction_date).toBe("2026-07-24");
  });

  it("the row at or below `since` now comes back in `belowSince`, fully shaped", () => {
    const { belowSince } = extractIvy(wb(), "2026-07-23");
    expect(belowSince).toHaveLength(1);
    const r = belowSince[0];
    expect(r.transaction_date).toBe("2026-07-23");
    // Shaped exactly like a classified row: batch from the TAB (L-046), streams, sum.
    expect(r.production_batch).toBe("JULY");
    expect(r._summed_kg).toBe(5545.5);
    expect(r._source_sheet).toBe("JULY 2026");
  });

  it("`since = null` classifies everything and parks nothing", () => {
    const { waste, belowSince } = extractIvy(wb(), null);
    expect(waste).toHaveLength(2);
    expect(belowSince).toEqual([]);
  });

  it("every row is accounted for — waste + belowSince is the whole workbook, always", () => {
    for (const since of [null, "2026-07-01", "2026-07-23", "2026-07-24", "2026-12-31"]) {
      const { waste, belowSince } = extractIvy(wb(), since);
      expect(waste.length + belowSince.length).toBe(2);
    }
  });
});

// ===========================================================================
// 3. THE AUDIT — zero silent drops
// ===========================================================================
describe("auditWasteGap — an excluded row the database does not hold is NAMED", () => {
  const SHIFTS: ShiftDbRow[] = [
    { id: "SID-23", transaction_date: "2026-07-23", production_batch: "JULY", shift: "M" },
    { id: "SID-24", transaction_date: "2026-07-24", production_batch: "JULY", shift: "M" },
  ];
  const storedFor = (shiftId: string, over: Partial<WasteDbRow> = {}): WasteDbRow => ({
    id: `W-${shiftId}`,
    shift_id: shiftId,
    rs1a_kg: 2700, rs1b_kg: 2500, bf_kg: 200, rs23_kg: 100, rs5_kg: 20,
    trml1_kg: 25, trml2_kg: 0.5, grit_kg: 0,
    remarks: "PCG/ZAMBAONGA",
    ...over,
  });
  const belowSince = (rows: FakeWasteRow[]) =>
    extractIvy(fakeIvyWorkbook([{ name: "JULY 2026", rows }]), "2026-12-31").belowSince;

  const run = (input: Partial<Parameters<typeof auditWasteGap>[0]> = {}): WasteGapNote[] =>
    auditWasteGap({
      belowSince: belowSince([JUL_23, JUL_24]),
      shifts: SHIFTS,
      wasteRows: [storedFor("SID-23")],
      shiftIdsWithRuns: new Set(["SID-23", "SID-24"]),
      wasteSince: "2026-12-31",
      ...input,
    });

  it("ARM A — a shift with NO waste row is reported, with both the figures and the source", () => {
    const notes = run();
    expect(notes).toHaveLength(1);
    const n = notes[0];
    expect(n.kind).toBe("waste_row_missing");
    expect(n.transaction_date).toBe("2026-07-24");
    expect(n.production_batch).toBe("JULY");
    expect(n.shift_id).toBe("SID-24");
    expect(n.shift_has_runs).toBe(true);
    expect(n.sheet_total_kg).toBe(5746.5);
    expect(n.sheet_streams.rs1a_kg).toBe(2800);
    expect(n.source_sheet).toBe("JULY 2026");
    // Nothing stored, so the DB half is NULL — never 0, which would claim a zero row.
    expect(n.db_streams).toBeNull();
    expect(n.db_total_kg).toBeNull();
    expect(n.differing_streams).toEqual([]);
  });

  it("a row the database already holds, byte-identical, raises NOTHING", () => {
    const notes = run({
      wasteRows: [storedFor("SID-23"), storedFor("SID-24", {
        rs1a_kg: 2800, rs1b_kg: 2200, bf_kg: 300, rs23_kg: 200, rs5_kg: 150,
        trml1_kg: 70, trml2_kg: 0.5, grit_kg: 26,
      })],
    });
    expect(notes).toEqual([]);
  });

  it("a `remarks`-ONLY difference raises NOTHING — 140 historical rows differ that way", () => {
    // This is the whole reason the audit compares STREAMS and not the classifier's full
    // field diff: an alarm that fires 140 times is an alarm nobody reads.
    const notes = run({
      wasteRows: [
        storedFor("SID-23", { remarks: null }),
        storedFor("SID-24", {
          rs1a_kg: 2800, rs1b_kg: 2200, bf_kg: 300, rs23_kg: 200, rs5_kg: 150,
          trml1_kg: 70, trml2_kg: 0.5, grit_kg: 26, remarks: null,
        }),
      ],
    });
    expect(notes).toEqual([]);
  });

  it("ARM B — a STREAM disagreement reports BOTH rows and names the fields", () => {
    // The 2026-08-01 shape: the stored row is another batch's, so the figures differ.
    const notes = run({
      wasteRows: [
        storedFor("SID-23"),
        storedFor("SID-24", { rs1a_kg: 239, rs1b_kg: 239, bf_kg: 0, rs23_kg: 27, rs5_kg: 35, trml1_kg: 25, trml2_kg: 0.5, grit_kg: 25, remarks: "PCG" }),
      ],
    });
    expect(notes).toHaveLength(1);
    const n = notes[0];
    expect(n.kind).toBe("waste_row_disagrees");
    expect(n.db_waste_id).toBe("W-SID-24");
    expect(n.db_total_kg).toBe(590.5);
    expect(n.sheet_total_kg).toBe(5746.5);
    expect(n.db_remarks).toBe("PCG");
    expect(n.sheet_remarks).toBe("PCG/ZAMBAONGA");
    expect(n.differing_streams.sort()).toEqual(
      ["bf_kg", "grit_kg", "rs1a_kg", "rs1b_kg", "rs23_kg", "rs5_kg", "trml1_kg"].sort(),
    );
    // trml2 agrees on both sides, so it must NOT be listed.
    expect(n.differing_streams).not.toContain("trml2_kg");
  });

  it("a stored row a human owns is still reported — and says so, so the repair is refused knowingly", () => {
    const notes = run({
      wasteRows: [
        storedFor("SID-23"),
        storedFor("SID-24", { rs1a_kg: 1, human_edited_at: "2026-09-01T00:00:00Z" } as Partial<WasteDbRow>),
      ],
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("waste_row_disagrees");
    expect(notes[0].db_human_edited).toBe(true);
  });

  it("the sync-era FLOOR holds back the master-file era, and COUNTS what it held back", () => {
    const old: FakeWasteRow = { ...JUL_24, date: "2026-02-02" };
    const notes = auditWasteGap({
      belowSince: belowSince([old, JUL_24]),
      shifts: [
        ...SHIFTS,
        { id: "SID-FEB", transaction_date: "2026-02-02", production_batch: "JULY", shift: "M" },
      ],
      wasteRows: [],
      shiftIdsWithRuns: new Set(),
      wasteSince: "2026-12-31",
    });
    // Only the sync-era row is judged; the 2026-02-02 row is counted, never dropped.
    expect(notes.map((n) => n.transaction_date)).toEqual(["2026-07-24"]);
    expect(notes[0].pre_sync_era_rows).toBe(1);
    expect(SYNC_ERA_START).toBe("2026-05-25");
  });

  it("a row matching NO shift is never invented into one — it is counted and named", () => {
    const orphan: FakeWasteRow = { ...JUL_24, date: "2026-07-25" };
    const notes = run({ belowSince: belowSince([JUL_24, orphan]) });
    expect(notes).toHaveLength(1);
    expect(notes[0].transaction_date).toBe("2026-07-24");
    expect(notes[0].unmatched_dates).toEqual(["2026-07-25"]);
  });

  it("nothing excluded → no notes at all (the ordinary run's shape is unchanged)", () => {
    expect(auditWasteGap({
      belowSince: [],
      shifts: SHIFTS,
      wasteRows: [],
      shiftIdsWithRuns: new Set(),
      wasteSince: "2026-07-23",
    })).toEqual([]);
  });
});

// ===========================================================================
// 4. runReport — the regression itself, end to end, on the REAL workbooks
// ===========================================================================
describe("runReport — Ivy's rows survive MC racing ahead (the L-052 regression)", () => {
  const manifest: ProductionManifest = {
    reports: {
      production_mc: [{ storagePath: "mc", filename: "DAILY.xlsx", emailUid: 1 }],
      production_waste: [{ storagePath: "ivy", filename: "WASTE.xlsx", emailUid: 2 }],
    },
  };

  function mkDb(runsFrontier: string, wasteFrontier: string, rows: Record<string, Row[]> = {}) {
    const productionWasteFrontier = vi.fn(async () => wasteFrontier as string | null);
    const productionRunsFrontier = vi.fn(async () => runsFrontier as string | null);
    const db: Partial<DbClient> = {
      productionRunsFrontier,
      productionWasteFrontier,
      dataWatermark: vi.fn(async () => null),
      readRows: async (table: string, _opts: ReadRowsOptions = {}) => rows[table] ?? [],
      insertIfAbsent: async (_t: string, r: Row[]): Promise<InsertIfAbsentResult> => ({
        inserted: [{ ...r[0], id: `id-${Math.random().toString(36).slice(2, 8)}` }],
        skipped: [], insertedCount: 1, skippedCount: 0,
      }),
      selectOne: async () => null,
      update: async () => [],
      writeIngestionAudit: async () => ({ id: "audit-1" }),
      upsertIngestionWatermark: async () => true,
    };
    return { db: db as DbClient, productionRunsFrontier, productionWasteFrontier };
  }

  const deps = (db: DbClient): RunReportDeps => ({
    db,
    fetchToLocalPath: async (p: string) => (p === "ivy" ? IVY_FIXTURE : MC_FIXTURE),
    noLabel: true,
  });

  it("THE BUG: with MC at 2026-06-30 and waste at 2026-06-25, Ivy's 06-26+ rows are STILL read", async () => {
    // Old behaviour: one `since` = MC's 2026-06-30, so 06-26 … 06-30 were all `<= since`
    // and silently discarded. New behaviour: min(06-30, 06-25) − 3 = 2026-06-22.
    const { db, productionRunsFrontier, productionWasteFrontier } = mkDb("2026-06-30", "2026-06-25");
    const res = await runReport(deps(db), "run-l052", manifest);

    // BOTH dials were read — the old code only ever read one.
    expect(productionRunsFrontier).toHaveBeenCalledTimes(1);
    expect(productionWasteFrontier).toHaveBeenCalledTimes(1);
    // Ivy's fixture has TEN rows dated after 2026-06-22 (06-23 … 07-02, including both
    // sides of the 06-30 JUNE/JULY changeover). Under the old single-frontier rule — one
    // `since` from MC — the window started at 2026-06-27 and only five survived.
    expect(res.classify.per_section.waste).toBe(10);
    // MC's own window is untouched: still its own frontier, still both day-sheets.
    expect(res.classify.per_section.runs).toBe(8);
    expect(res.classify.watermark).toBe("2026-06-30");
  });

  it("NEGATIVE CONTROL: feed waste MC's frontier and HALF those rows vanish", async () => {
    // Exactly the buggy behaviour, reproduced by moving ONE dial — proof that the waste
    // frontier's VALUE is what gates Ivy's extraction, not something else in the window.
    const { db } = mkDb("2026-06-30", "2026-06-30");
    const res = await runReport(deps(db), "run-buggy", manifest);
    expect(res.classify.per_section.waste).toBe(5);
  });

  it("a below-window row the database does not hold becomes a LOUD note, not a silent drop", async () => {
    // 2026-06-19 (4,591.5 kg on the JUNE tab) sits well below the window. Give the DB the
    // shift, with MC's runs against it, and no waste row: exactly the shape of the five
    // real victims.
    const { db } = mkDb("2026-06-30", "2026-06-25", {
      production_shifts: [
        { id: "SID-0619", transaction_date: "2026-06-19", production_batch: "JUNE", shift: "M" },
      ],
      production_runs: [
        { id: "R1", shift_id: "SID-0619", customer: "CEBU", grade: "3X50", ttl_kg: 1000 },
      ],
    });
    const res = await runReport(deps(db), "run-gap", manifest);

    const notes = res.apply.waste_notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("waste_row_missing");
    expect(notes[0].transaction_date).toBe("2026-06-19");
    expect(notes[0].production_batch).toBe("JUNE");
    expect(notes[0].shift_id).toBe("SID-0619");
    expect(notes[0].shift_has_runs).toBe(true);
    expect(notes[0].sheet_total_kg).toBe(4591.5);
    expect(notes[0].waste_since).toBe("2026-06-22");
    // Every OTHER excluded row matched no shift — counted, never silently dropped.
    expect(notes[0].unmatched_dates.length).toBeGreaterThan(0);
    expect(notes[0].unmatched_dates).not.toContain("2026-06-19");
    // And the pre-sync-era rows (2026-01-02 … 05-23) are held back by the floor, counted.
    expect(notes[0].pre_sync_era_rows).toBeGreaterThan(0);
  });

  it("the apply result ALWAYS carries waste_notes, so a consumer never has to guess", async () => {
    const { db } = mkDb("2026-06-30", "2026-06-25");
    const res = await runReport(deps(db), "run-shape", manifest);
    expect(Array.isArray(res.apply.waste_notes)).toBe(true);
    expect(res.apply.waste_notes).toEqual([]); // no shifts in this DB → nothing to judge
  });

  it("opts.since still overrides BOTH windows (explicit since wins)", async () => {
    const { db } = mkDb("2026-06-30", "2026-06-25");
    const res = await runReport(deps(db), "run-override", manifest, { since: "2026-07-01" });
    expect(res.classify.per_section.runs).toBe(4); // only the 07-02 MC day-sheet survives
    expect(res.classify.per_section.waste).toBe(1); // only the 07-02 waste row survives
  });
});

// ===========================================================================
// 5. THE COLLISION HOLD SHOWS BOTH ROWS
// ===========================================================================
describe("apply — a UNIQUE(shift_id) waste collision names BOTH rows, not just itself", () => {
  /** The real 2026-08-01 shape: AUGUST's own opening day arriving at a shift that already
   *  holds JULY's carryover. */
  const INCOMING = {
    transaction_date: "2026-08-01", production_batch: "AUGUST", shift: "M",
    rs1a_kg: 520, rs1b_kg: 0, bf_kg: 210, rs23_kg: 90, rs5_kg: 94,
    trml1_kg: 50, trml2_kg: 0.5, grit_kg: 29, remarks: "ZAMBAONGA",
  };
  const STORED: Row = {
    id: "W-AUG", shift_id: "SID-AUG", human_edited_at: null,
    rs1a_kg: 239, rs1b_kg: 239, bf_kg: 0, rs23_kg: 27, rs5_kg: 35,
    trml1_kg: 25, trml2_kg: 0.5, grit_kg: 25, remarks: "PCG",
  };

  function collideDb(storedRows: Row[]): DbClient {
    const stub: Partial<DbClient> = {
      // The collision: the insert finds the natural key already present.
      insertIfAbsent: async (_t: string, _r: Row[]): Promise<InsertIfAbsentResult> => ({
        inserted: [], skipped: [{}], insertedCount: 0, skippedCount: 1,
      }),
      readRows: async (_t: string, _o: ReadRowsOptions = {}) => storedRows,
      update: async () => [],
      applyProductionUpstream: async (ops: Row[]) =>
        ops.map((o) => ({ table: String(o.table), id: String(o.id), outcome: "applied" })),
      selectOne: async () => null,
      writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
      upsertIngestionWatermark: async () => true,
    };
    return stub as DbClient;
  }

  const wasteNew = {
    idx: 0, class: "NEW",
    natural_key: { shift_id: "SID-AUG" },
    resolved_shift_id: "SID-AUG",
    needs_shift_upsert: false,
    existing_id: null, diff: null,
    record: INCOMING,
    reasons: ["shift exists; no waste row yet"], confidence: 0.97,
  } as unknown as Record<string, unknown>;

  const compact = (): ProductionCompact => ({
    report_type: "production",
    since: "2026-07-31",
    window: ["2026-07-29", "2026-08-04"],
    source: { mc_uid: null, ivy_uid: null, mc_thread_id: null },
    sections: { runs: [], downtime: [], waste: [wasteNew], electricity: [], trucks: [] },
  });

  it("the held row carries the STORED figures, the INCOMING figures and both totals", async () => {
    const res = await applyProduction(compact(), { db: collideDb([STORED]) });
    expect(res.held).toHaveLength(1);
    const h = res.held[0];
    expect(h.kind).toBe("already_exists");
    const row = h.row as Record<string, unknown>;
    expect(row.stored_total_kg).toBe(590.5); // JULY's carryover, which is what is stored
    expect(row.incoming_total_kg).toBe(993.5); // AUGUST's own opening day
    expect((row.stored as Record<string, unknown>).rs1a_kg).toBe(239);
    expect((row.incoming as Record<string, unknown>).rs1a_kg).toBe(520);
    expect(row.db_row_id).toBe("W-AUG");
    expect(row.db_human_edited).toBe(false);
    // The detail must be readable by a person, and must say nothing was overwritten.
    expect(h.detail).toContain("590.5 kg");
    expect(h.detail).toContain("993.5 kg");
    expect(h.detail).toContain("nothing was overwritten");
  });

  it("NOTHING is overwritten — a collision holds, it never becomes an update", async () => {
    const ops: Row[][] = [];
    const db = collideDb([STORED]);
    (db as unknown as { applyProductionUpstream: unknown }).applyProductionUpstream = async (
      o: Row[],
    ) => {
      ops.push(o);
      return [];
    };
    const res = await applyProduction(compact(), { db });
    expect(ops).toEqual([]);
    expect(res.inserts).toBe(0);
    expect(res.updates).toBe(0);
  });

  it("a stored row that cannot be re-read still HOLDS — a collision is reported regardless", async () => {
    const db = collideDb([]);
    const res = await applyProduction(compact(), { db });
    expect(res.held).toHaveLength(1);
    const row = res.held[0].row as Record<string, unknown>;
    expect(row.stored).toBeNull();
    // With nothing to compare against, the totals sentence is simply absent — never a
    // fabricated zero.
    expect(res.held[0].detail).not.toContain("kg (");
  });

  it("a stored row a human owns is flagged as such, so a repair is refused knowingly", async () => {
    const db = collideDb([{ ...STORED, human_edited_at: "2026-09-01T00:00:00Z" }]);
    const res = await applyProduction(compact(), { db });
    expect((res.held[0].row as Record<string, unknown>).db_human_edited).toBe(true);
  });
});

// ===========================================================================
// 6. The duplicated constant, pinned (the DEFAULT_SHIFT_HRS idiom from L-051b)
// ===========================================================================
describe("SYNC_ERA_START is ONE date, not two", () => {
  it("the L-051 downtime backfill's own literal still equals the exported constant", () => {
    // `backfill-downtime-ranges.ts` is a standalone one-off and carries its own copy. If
    // one of them ever moves, the two backfills would floor at different dates for the
    // same stated reason — which is exactly the drift this assertion exists to catch.
    const src = readFileSync(
      join(__dirname, "../../scripts/backfill-downtime-ranges.ts"),
      "utf8",
    );
    const m = src.match(/const SYNC_ERA_START = "(\d{4}-\d{2}-\d{2})"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(SYNC_ERA_START);
  });
});
