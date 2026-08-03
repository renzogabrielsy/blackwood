/**
 * production-batch-markers.test.ts — MC's `ENDING`/`STARTING` batch-transition
 * markers (L-007) and the running-state derivation of `production_batch`.
 *
 * THE DEFECT: `production_batch` used to be the sheet's CALENDAR MONTH. Two things
 * broke as a result —
 *   (a) batches routinely span a month boundary (JULY ran 2026-06-30 → 2026-07-31),
 *       so ordinary days were mislabelled at every boundary; and
 *   (b) on a CHANGEOVER day both batches got the same name, so the two same-grade
 *       run rows collapsed to one `(shift_id, customer, grade)` key and apply's
 *       L-026 combine SUMMED them into a single wrong row.
 * Column H, where MC writes the markers, is DUAL-PURPOSE (it also carries real
 * shift labels on an overtime day), so the fix discriminates BY VALUE.
 *
 * What is locked here:
 *   1. a real shift label still parses as a shift (the overtime day is untouched);
 *   2. `ENDING`/`STARTING` → shift M, NOT defaulted, NO warning, NO default-note;
 *   3. ENDING → the running batch · STARTING → the NEXT name in the sequence ·
 *      unmarked → the running batch · downtime → the running batch;
 *   4. a batch that STARTS EARLY, in the prior calendar month;
 *   5. a batch that ENDS EARLY, inside its own calendar month (+ the fold carries
 *      the new batch into the following days);
 *   6. the documented COLD-START fallback (no prior batch on record);
 *   7. `resolveRunningBatch` over a changeover day that carries TWO batches;
 *   8. the real 2026-08-01 case end-to-end: two `CEBU 3X50` rows → TWO shifts,
 *      TWO run inserts, NO merge — proved WITHOUT any special case in apply.
 */
import { describe, it, expect } from "vitest";

import { extractMc } from "../../src/reports/production/extractMc.js";
import {
  buildBatchPlans,
  nextBatchName,
  resolveRunningBatch,
  type SheetMarkerScan,
} from "../../src/reports/production/productionBatch.js";
import { classifyRuns, type ShiftDbRow } from "../../src/reports/production/classify.js";
import {
  applyProduction,
  type ProductionCompact,
  type ProductionSections,
} from "../../src/reports/production/apply.js";
import type { DbClient, Row, InsertIfAbsentResult } from "../../src/lib/db.js";
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../src/lib/xlsx.js";

// ---------------------------------------------------------------------------
// 1 + 2 — the discriminated read of column H.
// ---------------------------------------------------------------------------
describe("column H is read BY VALUE, not repurposed as a batch column", () => {
  it("a real shift label still parses as a shift — the overtime day is untouched", () => {
    // 07-23-26's actual column H. `DAY SHIFT`/`OVERTIME` are NOT in
    // SHIFT_LABEL_TO_CODE, so they take the pre-existing "unrecognized → default
    // to Morning + warning" branch. That behavior is parity-frozen and must not move.
    const wb = fakeMc([
      {
        sheet: "07-23-26",
        runs: [
          { grade: "CEBU 3X50", shift: "DAY SHIFT", ttl: 11700, sacks: 450 },
          { grade: "2X6", shift: "DAY SHIFT", ttl: 9120, sacks: 16 },
          { grade: "CEBU 3X50", shift: "OVERTIME", ttl: 3120, sacks: 120 },
          { grade: "2X6", shift: "OVERTIME", ttl: 4560, sacks: 8 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });

    expect(mc.runs).toHaveLength(4);
    for (const r of mc.runs) {
      expect(r.shift).toBe("M");
      expect(r._shift_defaulted).toBe(true);
      expect(r.remarks).toBe("shift defaulted to Morning (operator left blank)");
      expect(r.production_batch).toBe("JULY");
    }
    expect(mc.runs[0].warnings).toContain("unrecognized shift 'DAY SHIFT' — defaulted to Morning");
    expect(mc.runs[2].warnings).toContain("unrecognized shift 'OVERTIME' — defaulted to Morning");
    // No STARTING anywhere → nothing to announce.
    expect(mc.batch.transitions).toEqual([]);
  });

  it("an explicit MORNING/NIGHT label is still honoured verbatim", () => {
    const wb = fakeMc([
      {
        sheet: "07-23-26",
        runs: [
          { grade: "CEBU 3X50", shift: "MORNING SHIFT", ttl: 100, sacks: 1 },
          { grade: "2X6", shift: "NIGHT SHIFT", ttl: 200, sacks: 2 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });
    expect(mc.runs.map((r) => r.shift)).toEqual(["M", "E"]);
    for (const r of mc.runs) {
      expect(r._shift_defaulted).toBe(false);
      expect(r.warnings).toEqual([]);
    }
  });

  it("ENDING / STARTING → shift M with NO warning and NO default-note", () => {
    const wb = fakeMc([
      {
        sheet: "08-01-26",
        runs: [
          { grade: "CEBU 3X50", shift: "ENDING", ttl: 1326, sacks: 51 },
          { grade: "2X6", shift: "ENDING", ttl: 1140, sacks: 2 },
          { grade: "CEBU 3X50", shift: "STARTING", ttl: 11830, sacks: 455 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });

    expect(mc.runs).toHaveLength(3);
    for (const r of mc.runs) {
      expect(r.shift).toBe("M"); // explicit domain rule: markers are Morning-only
      expect(r._shift_defaulted).toBe(false);
      expect(r.remarks).toBeNull();
      expect(r.warnings).toEqual([]);
      expect(r.confidence).toBe(1);
    }
    // The spurious warning the old code produced must be gone entirely.
    const allWarnings = mc.runs.flatMap((r) => r.warnings).join(" | ");
    expect(allWarnings).not.toMatch(/unrecognized shift/);
  });

  it("case + whitespace tolerant ('  starting  ' is still a marker)", () => {
    const wb = fakeMc([
      {
        sheet: "08-01-26",
        runs: [
          { grade: "CEBU 3X50", shift: "  ending ", ttl: 1326, sacks: 51 },
          { grade: "2X6", shift: "Starting", ttl: 11830, sacks: 455 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });
    expect(mc.runs.map((r) => r.production_batch)).toEqual(["JULY", "AUGUST"]);
    for (const r of mc.runs) expect(r.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 — the batch rule itself.
// ---------------------------------------------------------------------------
describe("production_batch follows the RUNNING STATE, not the calendar", () => {
  it("ENDING → running batch · STARTING → next in sequence · unmarked → running batch", () => {
    const wb = fakeMc([
      {
        sheet: "08-01-26",
        runs: [
          { grade: "CEBU 3X50", shift: "ENDING", ttl: 1326, sacks: 51 },
          { grade: "2X6", shift: "ENDING", ttl: 1140, sacks: 2 },
          { grade: "CEBU 3X50", shift: "STARTING", ttl: 11830, sacks: 455 },
          { grade: "4X8", shift: null, ttl: 500, sacks: 5 }, // unmarked
        ],
        downtimeMins: 30,
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });

    expect(mc.runs.map((r) => [r.grade, r.production_batch])).toEqual([
      ["3X50", "JULY"],
      ["2X6", "JULY"],
      ["3X50", "AUGUST"],
      ["4X8", "JULY"], // unmarked = "the currently running batch"
    ]);
    // Downtime is a whole-DAY fact with no marker → same rule as an unmarked row.
    expect(mc.downtime).toHaveLength(1);
    expect(mc.downtime[0].production_batch).toBe("JULY");
    expect(mc.downtime[0].transaction_date).toBe("2026-08-01");
  });

  it("an ORDINARY day past a month boundary is corrected (July sheet, JULY batch — not the calendar's AUGUST)", () => {
    // The JULY batch ran 2026-06-30 → 2026-07-31; the calendar rule mislabelled
    // every day where the batch name and the month disagree. Here: an AUGUST-dated
    // sheet still on the JULY batch (no STARTING yet).
    const wb = fakeMc([
      { sheet: "08-02-26", runs: [{ grade: "CEBU 3X50", shift: null, ttl: 15600, sacks: 600 }] },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });
    expect(mc.runs[0].production_batch).toBe("JULY");
  });

  it("announces the changeover with the new batch, the date, and the batch it follows", () => {
    const wb = fakeMc([
      {
        sheet: "08-01-26",
        runs: [
          { grade: "CEBU 3X50", shift: "ENDING", ttl: 1326, sacks: 51 },
          { grade: "CEBU 3X50", shift: "STARTING", ttl: 11830, sacks: 455 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });
    expect(mc.batch.transitions).toEqual([
      {
        transaction_date: "2026-08-01",
        new_batch: "AUGUST",
        previous_batch: "JULY",
        derivation: "sequence",
        source_sheet: "08-01-26",
      },
    ]);
  });

  it("a STARTING parked on a DROPPED grade can never advance the batch", () => {
    // KOREA POWDER is not an allowlisted grade (L-027) — it is never emitted as a
    // run, so a marker sitting on it must not be treated as a changeover.
    const wb = fakeMc([
      {
        sheet: "08-01-26",
        runs: [
          { grade: "CEBU 3X50", shift: null, ttl: 15600, sacks: 600 },
          { grade: "KOREA POWDER (BAGGED)", shift: "STARTING", ttl: null, sacks: 0 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });
    expect(mc.batch.transitions).toEqual([]);
    expect(mc.runs.map((r) => r.production_batch)).toEqual(["JULY"]);
  });

  it("nextBatchName wraps DECEMBER → JANUARY and rejects a non-month label", () => {
    expect(nextBatchName("JULY")).toBe("AUGUST");
    expect(nextBatchName("december")).toBe("JANUARY");
    expect(nextBatchName("CAMPAIGN-9")).toBeNull();
    expect(nextBatchName(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4 — a batch STARTING EARLY, in the prior calendar month.
// ---------------------------------------------------------------------------
describe("a batch that starts EARLY (in the prior calendar month)", () => {
  it("SEPTEMBER opens on an AUGUST-dated sheet — sequence wins over the calendar", () => {
    const wb = fakeMc([
      {
        sheet: "08-30-26",
        runs: [
          { grade: "CEBU 3X50", shift: "ENDING", ttl: 2000, sacks: 77 },
          { grade: "CEBU 3X50", shift: "STARTING", ttl: 9000, sacks: 346 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "AUGUST" });
    expect(mc.runs.map((r) => r.production_batch)).toEqual(["AUGUST", "SEPTEMBER"]);
    // The calendar month (AUGUST) would have collided both rows into one key.
    expect(new Set(mc.runs.map((r) => r.production_batch)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5 — a batch that ENDS EARLY, inside its own calendar month.
// ---------------------------------------------------------------------------
describe("a batch that ends EARLY (inside its own calendar month)", () => {
  it("JULY closes mid-July, AUGUST opens the same day, and the NEXT day follows AUGUST", () => {
    const wb = fakeMc([
      {
        sheet: "07-20-26",
        runs: [
          { grade: "CEBU 3X50", shift: "ENDING", ttl: 1200, sacks: 46 },
          { grade: "CEBU 3X50", shift: "STARTING", ttl: 8800, sacks: 338 },
        ],
      },
      { sheet: "07-21-26", runs: [{ grade: "CEBU 3X50", shift: null, ttl: 15600, sacks: 600 }] },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });

    expect(mc.runs.map((r) => [r._source_sheet, r.production_batch])).toEqual([
      ["07-20-26", "JULY"],
      ["07-20-26", "AUGUST"],
      ["07-21-26", "AUGUST"], // the fold carried the new batch forward
    ]);
  });

  it("the fold runs in DATE order even when the workbook's tab order is scrambled", () => {
    // Emission order must stay the workbook's own order (parity), but the running
    // batch must be folded chronologically.
    const wb = fakeMc([
      { sheet: "07-21-26", runs: [{ grade: "CEBU 3X50", shift: null, ttl: 15600, sacks: 600 }] },
      {
        sheet: "07-20-26",
        runs: [
          { grade: "CEBU 3X50", shift: "ENDING", ttl: 1200, sacks: 46 },
          { grade: "2X6", shift: "STARTING", ttl: 8800, sacks: 15 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01", { runningBatch: "JULY" });

    // Emission order = workbook order (07-21 first) …
    expect(mc.runs.map((r) => r._source_sheet)).toEqual(["07-21-26", "07-20-26", "07-20-26"]);
    // … but the batches came from the DATE-ordered fold.
    expect(mc.runs.map((r) => r.production_batch)).toEqual(["AUGUST", "JULY", "AUGUST"]);
  });
});

// ---------------------------------------------------------------------------
// 6 — the documented COLD-START fallback.
// ---------------------------------------------------------------------------
describe("cold start — no prior batch on record", () => {
  it("an ordinary day falls back to the sheet's calendar month and SAYS SO", () => {
    const wb = fakeMc([
      { sheet: "07-21-26", runs: [{ grade: "CEBU 3X50", shift: null, ttl: 15600, sacks: 600 }] },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01"); // no runningBatch → cold start
    expect(mc.runs[0].production_batch).toBe("JULY");
    expect(mc.batch.seed).toBeNull();
    expect(mc.batch.coldStartDates).toEqual(["2026-07-21"]);
  });

  it("a cold-start CHANGEOVER day still yields TWO distinct batches (the collision cannot reappear)", () => {
    const wb = fakeMc([
      {
        sheet: "08-01-26",
        runs: [
          { grade: "CEBU 3X50", shift: "ENDING", ttl: 1326, sacks: 51 },
          { grade: "CEBU 3X50", shift: "STARTING", ttl: 11830, sacks: 455 },
        ],
      },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01");
    expect(mc.runs.map((r) => r.production_batch)).toEqual(["JULY", "AUGUST"]);
    expect(mc.batch.coldStartDates).toEqual(["2026-08-01"]);
    expect(mc.batch.transitions[0].derivation).toBe("calendar_cold_start");
  });

  it("once the fold has a batch, later sheets are NOT cold-start any more", () => {
    const wb = fakeMc([
      { sheet: "07-21-26", runs: [{ grade: "CEBU 3X50", shift: null, ttl: 100, sacks: 1 }] },
      { sheet: "07-22-26", runs: [{ grade: "CEBU 3X50", shift: null, ttl: 200, sacks: 2 }] },
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01");
    expect(mc.batch.coldStartDates).toEqual(["2026-07-21"]);
    expect(mc.runs.map((r) => r.production_batch)).toEqual(["JULY", "JULY"]);
  });

  it("a non-month running label falls back to the calendar and flags the derivation", () => {
    const plans = buildBatchPlans(
      [scan("09-01-26", "2026-09-01", 9, true)],
      "CAMPAIGN-9", // not a month name → nextBatchName() can't advance it
    );
    expect(plans.transitions[0]).toMatchObject({
      new_batch: "SEPTEMBER",
      previous_batch: "CAMPAIGN-9",
      derivation: "calendar_unknown_running",
    });
  });
});

// ---------------------------------------------------------------------------
// 7 — seeding the running batch from the DB.
// ---------------------------------------------------------------------------
describe("resolveRunningBatch — the DB seed", () => {
  const rows = [
    { transaction_date: "2026-06-25", production_batch: "JUNE" },
    { transaction_date: "2026-06-29", production_batch: "JUNE" },
    { transaction_date: "2026-06-30", production_batch: "JUNE" },
    { transaction_date: "2026-06-30", production_batch: "JULY" },
    { transaction_date: "2026-07-01", production_batch: "JULY" },
  ];

  it("returns the batch on the latest date at/below the cutoff", () => {
    expect(resolveRunningBatch(rows, "2026-07-31")).toBe("JULY");
    expect(resolveRunningBatch(rows, "2026-06-29")).toBe("JUNE");
  });

  it("a CHANGEOVER day carrying TWO batches resolves to the one that started most recently", () => {
    // 2026-06-30 holds both JUNE and JULY — the RUNNING one is JULY.
    expect(resolveRunningBatch(rows, "2026-06-30")).toBe("JULY");
  });

  it("no rows at/below the cutoff → null (cold start)", () => {
    expect(resolveRunningBatch(rows, "2026-01-01")).toBeNull();
    expect(resolveRunningBatch([], "2026-07-31")).toBeNull();
  });

  it("ignores rows with a missing/blank batch or an unparseable date, never throws", () => {
    expect(
      resolveRunningBatch(
        [
          { transaction_date: "2026-07-01", production_batch: "   " },
          { transaction_date: null, production_batch: "JULY" },
          { transaction_date: "2026-06-28T00:00:00Z", production_batch: "JUNE" },
        ],
        "2026-07-31",
      ),
    ).toBe("JUNE");
  });
});

// ---------------------------------------------------------------------------
// 8 — the real 2026-08-01 case, end to end. NO special case in apply.
// ---------------------------------------------------------------------------
describe("2026-08-01 — the two CEBU 3X50 rows no longer collide", () => {
  const wb = () =>
    fakeMc([
      {
        sheet: "08-01-26",
        runs: [
          { grade: "CEBU 3X50", shift: "ENDING", ttl: 1326, sacks: 51 },
          { grade: "2X6", shift: "ENDING", ttl: 1140, sacks: 2 },
          { grade: "CEBU 3X50", shift: "STARTING", ttl: 11830, sacks: 455 },
        ],
      },
    ]);

  it("classify keys the two 3X50 rows to DIFFERENT shift triplets", () => {
    const mc = extractMc(wb(), 2026, "2026-01-01", { runningBatch: "JULY" });
    const shifts: ShiftDbRow[] = [
      { id: "SID-JUL", transaction_date: "2026-08-01", production_batch: "JULY", shift: "M" },
      { id: "SID-AUG", transaction_date: "2026-08-01", production_batch: "AUGUST", shift: "M" },
    ];
    const res = classifyRuns(mc.runs, [], shifts);
    const byGradeBatch = res.classifications.map((c) => [
      (c.record as { grade: string }).grade,
      (c.natural_key as { shift_id: string | null }).shift_id,
    ]);
    expect(byGradeBatch).toEqual([
      ["3X50", "SID-JUL"],
      ["2X6", "SID-JUL"],
      ["3X50", "SID-AUG"],
    ]);
    for (const c of res.classifications) expect(c.class).toBe("NEW");
  });

  it("apply upserts TWO shifts and inserts THREE runs — the L-026 combine never merges them", async () => {
    const mc = extractMc(wb(), 2026, "2026-01-01", { runningBatch: "JULY" });
    // No shifts in the DB → every run is NEW with needs_shift_upsert.
    const classified = classifyRuns(mc.runs, [], []);

    const shiftPayloads: Row[] = [];
    const runPayloads: Row[] = [];
    let seq = 0;
    const db = mockDb((table, rows) => {
      if (table === "production_shifts") {
        shiftPayloads.push(rows[0]);
        // A DISTINCT id per distinct triplet — the whole point of the fix.
        return okInsert(rows[0], `SID-${++seq}`);
      }
      if (table === "production_runs") runPayloads.push(rows[0]);
      return okInsert(rows[0], `ROW-${++seq}`);
    });

    const sections = emptySections();
    sections.runs = classified.classifications as unknown as Record<string, unknown>[];
    const res = await applyProduction(compactWith(sections), { db });

    // TWO parent shifts on the SAME date, differing only by production_batch.
    expect(shiftPayloads).toHaveLength(2);
    expect(shiftPayloads.map((s) => `${s.transaction_date}·${s.production_batch}·${s.shift}`)).toEqual([
      "2026-08-01·JULY·M",
      "2026-08-01·AUGUST·M",
    ]);

    // THREE run rows — the two 3X50s stay separate with their own weights.
    expect(runPayloads).toHaveLength(3);
    const threeByFifty = runPayloads.filter((r) => r.grade === "3X50");
    expect(threeByFifty).toHaveLength(2);
    expect(threeByFifty.map((r) => r.ttl_kg).sort((a, b) => Number(a) - Number(b))).toEqual([1326, 11830]);
    // The bug's signature was ONE combined row at 1326 + 11830 = 13156.
    expect(runPayloads.some((r) => r.ttl_kg === 13156)).toBe(false);
    expect(new Set(threeByFifty.map((r) => r.shift_id)).size).toBe(2);

    expect(res.inserts).toBe(3);
    expect(res.held).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it("the changeover is echoed onto the apply result for the panel's findings", async () => {
    const db = mockDb(() => okInsert({}, "SID-1"));
    const res = await applyProduction(
      {
        ...compactWith(emptySections()),
        batch_starts: [
          {
            transaction_date: "2026-08-01",
            new_batch: "AUGUST",
            previous_batch: "JULY",
            derivation: "sequence",
            source_sheet: "08-01-26",
          },
        ],
      },
      { db },
    );
    expect(res.production_batch_starts).toEqual([
      {
        transaction_date: "2026-08-01",
        new_batch: "AUGUST",
        previous_batch: "JULY",
        derivation: "sequence",
        source_sheet: "08-01-26",
      },
    ]);
  });

  it("an ordinary run announces nothing (once-a-month, never noisy)", async () => {
    const db = mockDb(() => okInsert({}, "SID-1"));
    const res = await applyProduction(compactWith(emptySections()), { db });
    expect(res.production_batch_starts).toEqual([]);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function scan(name: string, iso: string, month: number, hasStarting: boolean): SheetMarkerScan {
  return { name, iso, month, hasStarting };
}

interface FakeRun {
  grade: CellValue;
  shift: CellValue;
  ttl: CellValue;
  sacks?: CellValue;
}

interface FakeSheet {
  sheet: string;
  runs: FakeRun[];
  /** Emit a minimal legacy-layout downtime block totalling this many minutes. */
  downtimeMins?: number;
}

/**
 * Multi-sheet in-memory MC workbook exposing the runs block (grade=D, sacks=E,
 * ttl=G, shift=H from row 8) and, optionally, a legacy-fixed-row downtime block
 * (category C24, minutes E27). Every other section resolves to empty (no anchors).
 */
function fakeMc(sheets: FakeSheet[]): LoadedWorkbook {
  const built = new Map<string, LoadedSheet>();
  for (const s of sheets) {
    const cells = new Map<string, CellValue>();
    s.runs.forEach((rr, i) => {
      const row = 8 + i; // RUNS_FIRST_DATA_ROW
      cells.set(`${row},4`, rr.grade);
      cells.set(`${row},5`, rr.sacks ?? null);
      cells.set(`${row},7`, rr.ttl);
      cells.set(`${row},8`, rr.shift);
    });
    if (s.downtimeMins !== undefined) {
      cells.set(`24,3`, "REPAIR"); // DT_CATEGORY_ROW, COL_DT_CATEGORY
      cells.set(`27,5`, String(s.downtimeMins)); // DT_RANGES_ROW, COL_DT_MINUTES
    }
    built.set(s.sheet, {
      name: s.sheet,
      rowCount: 100,
      columnCount: 20,
      cell: (row: number, col: number) => cells.get(`${row},${col}`) ?? null,
    });
  }
  const names = sheets.map((s) => s.sheet);
  return {
    sheetNames: names,
    sheet: (n: string) => built.get(n) ?? null,
    sheetAt: (i: number) => built.get(names[i]) ?? null,
  };
}

function okInsert(row: Row, id?: string): InsertIfAbsentResult {
  const inserted = { ...row, id: id ?? `NEW-${Math.random().toString(36).slice(2, 8)}` };
  return { inserted: [inserted], skipped: [], insertedCount: 1, skippedCount: 0 };
}

function mockDb(
  onInsertIfAbsent: (table: string, rows: Row[], nkey: string[]) => InsertIfAbsentResult,
): DbClient {
  const stub: Partial<DbClient> = {
    insertIfAbsent: async (table: string, rows: Row[], naturalKey: string[]) =>
      onInsertIfAbsent(table, rows, naturalKey),
    update: async () => [],
    selectOne: async () => null,
    writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
    upsertIngestionWatermark: async () => true,
  };
  return stub as DbClient;
}

function emptySections(): ProductionSections {
  return { runs: [], downtime: [], waste: [], electricity: [], trucks: [] };
}

function compactWith(sections: ProductionSections): ProductionCompact {
  return {
    report_type: "production",
    since: "2026-01-01",
    window: ["2026-07-29", "2026-08-04"],
    source: { mc_uid: null, ivy_uid: null, mc_thread_id: null },
    sections,
  };
}
