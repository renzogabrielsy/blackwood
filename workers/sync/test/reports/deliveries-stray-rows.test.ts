/**
 * deliveries-stray-rows.test.ts — L-054 (2026-09-25).
 * "A NOT NULL CONSTRAINT IS NOT A VALIDATION RULE — THE EXTRACTOR MUST KNOW WHERE THE TABLE ENDS."
 *
 * Every cell below is REAL, copied out of MC's stored workbooks in the `sync-inbox` bucket:
 *   - `260924 RC DELIVERIES 2026.xlsx` (run ea4ed942), tab SEPTEMBER 2026: row 68 is the last
 *     real truckload (Ornales · B14 · D-12C · CCP 1309 · 370 sacks · 10,900 kg), rows 69-74
 *     carry only a formula residue (FC = 100), row 76 is `Average`, rows 82-84 are MC's
 *     scratch arithmetic (449325 / 500000 / -50675 in the Weight column, nothing else) and
 *     row 111 is `ALA 9958` / `22840` typed one column off.
 *   - the same workbook's JUNE 2026 tab, rows 29-32: two GENUINE wet-sack splits (a mother
 *     truckload + the next row carrying only weight / sacks / MC / a "net kilos of" remark).
 *   - run 10575906's AUGUST 2026 tab: two real 2026-08-12 truckloads booked BELOW the
 *     tab's Average row (the reason the Average row does not end the table).
 *
 * Before the fix the extractor turned rows 82-84 into three "deliveries" under
 * SEPT-26-BLK14 / CCP 1309 (inherited from row 68) and apply tried to INSERT them; the only
 * thing that stopped it was `lab_results: null` hitting a NOT NULL column.
 */
import { describe, it, expect } from "vitest";

import type { CellValue, LoadedSheet } from "../../src/lib/xlsx.js";
import type { DeliveriesWorkbook } from "../../src/reports/deliveries/sheet.js";
import { extractDeliveries, type DeliveryRow } from "../../src/reports/deliveries/extract.js";
import { DELIVERY_WEIGHT_CAP_KG } from "../../src/reports/deliveries/extractionNotes.js";
import { applyDeliveries, type DeliveriesCompact } from "../../src/reports/deliveries/apply.js";
import { extractionNotesInWindow } from "../../src/reports/deliveries/index.js";
import { labResultsForInsert, shouldWriteLabPatch, isEmptyLabPanel } from "../../src/lib/labResults.js";
import { normalizeApply } from "../../src/workflows/normalizeReport.js";
import { flattenRunFindings } from "../../src/reports/excel/findingsBridge.js";

// ---------------------------------------------------------------------------
// A fake MC workbook: the REAL header block (rows 1-4) + whatever data rows a test gives.
// ---------------------------------------------------------------------------
type Grid = Record<number, Record<number, CellValue>>;

const HEADER: Grid = {
  1: { 1: "SEPTEMBER 2026 DELIVERIES" },
  2: { 1: "DATE", 2: "DATE OF", 3: "Sample", 4: "Block", 5: "block", 6: "TRUCK", 7: "Delivery", 8: "Delivery", 9: "Moisture" },
  3: { 1: "ANALYZED", 2: "DELIVERY", 3: "Supplier name", 5: "locator", 6: "PLATE", 7: "(kilo)", 8: "(sack)" },
  4: { 3: "Standard Specification", 6: "NUMBER" },
};

function mkWb(data: Grid, name = "SEPTEMBER 2026"): DeliveriesWorkbook {
  const grid: Grid = { ...HEADER, ...data };
  const rowCount = Math.max(...Object.keys(grid).map(Number));
  const sheet: LoadedSheet = {
    name,
    rowCount,
    columnCount: 16,
    cell: (r, c) => grid[r]?.[c] ?? null,
  };
  return {
    sheetNames: [name],
    sheet: (n) => (n === name ? sheet : null),
    sheetAt: (i) => (i === 0 ? sheet : null),
    activeSheetName: () => name,
  };
}

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Row 65 of the real 2026-09-24 tab — the first row that day, with its own date. */
const R65 = { 1: D("2026-09-24"), 2: D("2026-09-24"), 3: "Llanto", 4: "B10", 5: "D-15B", 6: "ALA 9958", 7: 25260, 8: 603, 9: 11.34, 10: 2.6, 11: 0.581, 12: 0.601, 13: 12.88, 14: 2.74, 15: 84.38 };
/** Row 68 — the last real truckload, the row the scratch sums used to inherit from. */
const R68 = { 3: "Ornales", 4: "B14", 5: "D-12C", 6: "CCP 1309", 7: 10900, 8: 370, 9: 10.8, 10: 3.61, 11: 0.575, 12: 0.595, 13: 13.94, 14: 3.73, 15: 82.33 };
const AVERAGE = { 1: "Average", 7: 898834, 8: 23961, 9: 10.2201587301587, 15: 85.0792857142857 };

/** The real 2026-09-24 tail: 65, 68, the FC=100 residue, Average at 76, scratch at 82-84, 111. */
function incidentTab(): Grid {
  return {
    5: R65,
    6: R68,
    7: { 15: 100 },
    8: { 15: 100 },
    10: AVERAGE,
    16: { 7: 449325 },
    17: { 7: 500000 },
    18: { 7: -50675 },
    45: { 7: "ALA 9958", 8: 22840 },
  };
}

// ---------------------------------------------------------------------------
describe("L-054 — the 2026-09-24 incident, reproduced", () => {
  it("the three scratch sums below the Average row are NOT deliveries — findings, not rows", () => {
    const ex = extractDeliveries(mkWb(incidentTab()), "260924 RC DELIVERIES 2026.xlsx");

    // Only the two real truckloads come out. Nothing inherits CCP 1309 / SEPT-26-BLK14.
    expect(ex.rows.map((r) => r._source_row)).toEqual([5, 6]);
    expect(ex.rows.filter((r) => r.truck_plate === "CCP 1309")).toHaveLength(1);
    expect(ex.rows.every((r) => r.weight_kg > 0 && r.weight_kg <= DELIVERY_WEIGHT_CAP_KG)).toBe(true);

    const notes = ex.extraction_notes ?? [];
    const scratch = notes.filter((n) => [16, 17, 18].includes(n.source_row));
    expect(scratch.map((n) => n.weight_kg)).toEqual([449325, 500000, -50675]);
    for (const n of scratch) {
      expect(n.kind).toBe("stray_row");
      expect(n.reason_code).toBe("recovery_not_adjacent");
      expect(n.below_summary_row).toBe(true);
      expect(n.summary_row).toBe(10);
      // NOTHING is inherited onto a stray: its own cells only.
      expect(n.supplier).toBeNull();
      expect(n.truck_plate).toBeNull();
      expect(n.batch_label).toBeNull();
      expect(Object.keys(n.cells)).toEqual(["Weight (kg)"]);
      // …and the forward-filled date is CONTEXT, flagged as not the row's own.
      expect(n.context_date).toBe("2026-09-24");
      expect(n.date_is_own).toBe(false);
      expect(n.detail).toMatch(/NOT treated as a delivery/);
      expect(n.detail).toMatch(/below the tab's Average row/);
    }
  });

  it("row 111 (`ALA 9958` in the Weight column) is named, not silently dropped", () => {
    const ex = extractDeliveries(mkWb(incidentTab()), "x.xlsx");
    const n = (ex.extraction_notes ?? []).find((x) => x.source_row === 45);
    expect(n?.kind).toBe("stray_row");
    expect(n?.reason_code).toBe("weight_not_a_number");
    expect(n?.weight_kg).toBeNull(); // never read as 0 kg
    expect(n?.cells).toEqual({ "Weight (kg)": "ALA 9958", Sacks: "22840" });
  });

  it("the formula residue rows (only FC = 100) stay silent — no note for a row with no weight", () => {
    const ex = extractDeliveries(mkWb(incidentTab()), "x.xlsx");
    expect((ex.extraction_notes ?? []).map((n) => n.source_row)).toEqual([16, 17, 18, 45]);
  });
});

// ---------------------------------------------------------------------------
describe("L-054 — positive signals, inside the table", () => {
  it("a scratch weight ABOVE the Average row, one blank row under a delivery → stray (not adjacent)", () => {
    const ex = extractDeliveries(mkWb({ 5: R65, 6: R68, 8: { 7: 12345 }, 10: AVERAGE }), "x.xlsx");
    expect(ex.rows.map((r) => r._source_row)).toEqual([5, 6]);
    const [n] = ex.extraction_notes ?? [];
    expect(n.kind).toBe("stray_row");
    expect(n.reason_code).toBe("recovery_not_adjacent");
    expect(n.below_summary_row).toBe(false);
  });

  it("a weight-only row DIRECTLY under a delivery but with no sacks and no remark → stray (no evidence)", () => {
    const ex = extractDeliveries(mkWb({ 5: R65, 6: R68, 7: { 7: 449325 }, 10: AVERAGE }), "x.xlsx");
    expect(ex.rows.map((r) => r._source_row)).toEqual([5, 6]);
    expect((ex.extraction_notes ?? [])[0].reason_code).toBe("recovery_no_evidence");
  });

  it("a row with its own supplier + label + block but NO truck plate → stray (no positive signal)", () => {
    const noPlate = { ...R68, 6: null };
    const ex = extractDeliveries(mkWb({ 5: R65, 6: noPlate }), "x.xlsx");
    expect(ex.rows.map((r) => r._source_row)).toEqual([5]);
    const [n] = ex.extraction_notes ?? [];
    expect(n.reason_code).toBe("no_own_supplier_or_plate");
    expect(n.supplier).toBe("Ornales");
    expect(n.detail).toMatch(/no truck plate/);
  });

  it("a row with a plate and a label but NO supplier → stray (the DB would refuse supplier NULL anyway)", () => {
    const noSupplier = { ...R68, 3: null };
    const ex = extractDeliveries(mkWb({ 5: R65, 6: noSupplier }), "x.xlsx");
    expect(ex.rows.map((r) => r._source_row)).toEqual([5]);
    expect((ex.extraction_notes ?? [])[0].detail).toMatch(/no supplier/);
  });
});

// ---------------------------------------------------------------------------
describe("L-054 — what must STILL pass", () => {
  // JUNE 2026 rows 29-32, verbatim.
  const R29 = { 1: D("2026-06-16"), 2: D("2026-06-16"), 3: "ORNALES", 4: "B06", 5: "D-20D", 6: "CBJ 6560", 7: 17683, 8: 370, 9: 12.14, 10: 3.61, 11: 0.552, 12: 0.572, 13: 12.77, 14: 10.86, 15: 76.37, 16: "CBJ net kilos of    19,855    -  5.86%  (ASH)  =  18,692 - 1,009 (18 sacks net wet)   = 17, 683" };
  const R30 = { 7: 960, 8: 18, 9: 16.07, 16: "CBJ net kilos of    1,009    -     4.87%  (MC)  =  960" };
  const R31 = { 3: "ORNALES", 4: "B06", 5: "D-20D", 6: "CAJ 1133", 7: 25706, 8: 502, 9: 11.74, 10: 3.44, 11: 0.556, 12: 0.576, 13: 12.58, 14: 8.75, 15: 78.67, 16: "CAJ net kilos of    28,475    -  3.75%  (ASH)  =  27,408 - 1,702 (31 sacks net wet)   = 25, 706" };
  const R32 = { 7: 1633, 8: 31, 9: 16.87, 16: "CAJ net kilos of    1,702    -     4.07%  (MC)  =  1,633" };

  it("a GENUINE wet-sack split (the very next row, own sacks + remark) still inherits its truck", () => {
    const ex = extractDeliveries(mkWb({ 5: R29, 6: R30, 7: R31, 8: R32 }, "JUNE 2026"), "x.xlsx");
    expect(ex.extraction_notes).toEqual([]);
    expect(ex.rows.map((r) => [r._source_row, r.truck_plate, r.weight_kg, r._recovery ?? false])).toEqual([
      [5, "CBJ 6560", 17683, false],
      [6, "CBJ 6560", 960, true],
      [7, "CAJ 1133", 25706, false],
      [8, "CAJ 1133", 1633, true],
    ]);
    const rec = ex.rows[1];
    expect(rec.batch_code).toBe("JUNE-26-BLK6");
    expect(rec.sacks).toBe(18);
  });

  it("a legit multi-row same-truck split (two OWN rows, same plate, different sacks) passes untouched", () => {
    // The 2025-04-03 / KCA 378 shape: the yard books over-moisture sacks separately.
    const a = { 1: D("2025-04-03"), 2: D("2025-04-03"), 3: "Tag-at", 4: "B09", 5: "C-9A", 6: "KCA 378", 7: 18827, 8: 471, 9: 11.2 };
    const b = { 3: "Tag-at", 4: "B09", 5: "C-9A", 6: "KCA 378", 7: 1440, 8: 36, 9: 16.1 };
    const ex = extractDeliveries(mkWb({ 5: a, 6: b }, "APRIL 2025"), "x.xlsx");
    expect(ex.extraction_notes).toEqual([]);
    expect(ex.rows.map((r) => [r.truck_plate, r.sacks, r.weight_kg])).toEqual([
      ["KCA 378", 471, 18827],
      ["KCA 378", 36, 1440],
    ]);
  });

  it("real truckloads typed BELOW an Average row are still read (AUGUST 2026, run 10575906)", () => {
    const ex = extractDeliveries(
      mkWb(
        {
          5: { 1: D("2026-08-11"), 2: D("2026-08-11"), 3: "Ornales", 4: "B05", 5: "A-9C", 6: "MAV 9202", 7: 20940, 8: 550 },
          7: AVERAGE,
          9: { 1: D("2026-08-12"), 2: D("2026-08-12"), 3: "Paquibot", 6: "AAV 6111", 7: 18595, 9: 11.6, 12: 0.02, 15: 100 },
          10: { 3: "Tag-at", 6: "KCA 378", 7: 18650, 9: 11.27, 12: 0.02, 15: 100 },
        },
        "AUGUST 2026",
      ),
      "x.xlsx",
    );
    expect(ex.extraction_notes).toEqual([]);
    expect(ex.rows.map((r) => [r.truck_plate, r.weight_kg, r.transaction_date])).toEqual([
      ["MAV 9202", 20940, "2026-08-11"],
      ["AAV 6111", 18595, "2026-08-12"],
      ["KCA 378", 18650, "2026-08-12"],
    ]);
  });

  it("a legit row with BLANK lab readings is still a delivery (its lab_results is null at extract)", () => {
    const blankLabs = { 1: D("2026-09-24"), 2: D("2026-09-24"), 3: "Ornales", 4: "B14", 5: "D-12C", 6: "CCP 1309", 7: 10900, 8: 370 };
    const ex = extractDeliveries(mkWb({ 5: blankLabs }), "x.xlsx");
    expect(ex.extraction_notes).toEqual([]);
    expect(ex.rows).toHaveLength(1);
    expect(ex.rows[0].lab_results).toBeNull(); // parity: the classify envelope still says null
  });
});

// ---------------------------------------------------------------------------
describe("L-054 — weight bounds (last line of defence)", () => {
  const withWeight = (w: number) => ({ ...R65, 7: w });

  it("a delivery-shaped row weighing 500,000 kg is refused: weight_out_of_range / above cap", () => {
    const ex = extractDeliveries(mkWb({ 5: withWeight(500000) }), "x.xlsx");
    expect(ex.rows).toEqual([]);
    const [n] = ex.extraction_notes ?? [];
    expect(n.kind).toBe("weight_out_of_range");
    expect(n.reason_code).toBe("weight_above_cap");
    expect(n.cap_kg).toBe(DELIVERY_WEIGHT_CAP_KG);
    expect(n.truck_plate).toBe("ALA 9958");
    expect(n.date_is_own).toBe(true);
  });

  it("a delivery-shaped row weighing −50,675 kg is refused: weight_not_positive", () => {
    const ex = extractDeliveries(mkWb({ 5: withWeight(-50675) }), "x.xlsx");
    expect(ex.rows).toEqual([]);
    expect((ex.extraction_notes ?? [])[0].reason_code).toBe("weight_not_positive");
  });

  it("the cap is inclusive at 60,000 kg and the heaviest real truck (36,069 kg) is nowhere near it", () => {
    expect(DELIVERY_WEIGHT_CAP_KG).toBe(60_000);
    const ok = extractDeliveries(mkWb({ 5: withWeight(60000), 6: { ...R68, 7: 36069 } }), "x.xlsx");
    expect(ok.rows.map((r) => r.weight_kg)).toEqual([60000, 36069]);
    const over = extractDeliveries(mkWb({ 5: withWeight(60001) }), "x.xlsx");
    expect(over.rows).toEqual([]);
    expect((over.extraction_notes ?? [])[0].reason_code).toBe("weight_above_cap");
  });

  it("an impossible weight on a wet-sack split is refused too (the split is still a delivery)", () => {
    // Adjacent + own sacks + own remark → a genuine split by shape; a 0 kg weight is not.
    const ex = extractDeliveries(mkWb({ 5: R65, 6: { 7: 0, 8: 18, 16: "net kilos of 0" } }), "x.xlsx");
    expect(ex.rows.map((r) => r._source_row)).toEqual([5]);
    expect((ex.extraction_notes ?? [])[0].kind).toBe("weight_out_of_range");
  });
});

// ---------------------------------------------------------------------------
describe("L-054 — lab_results is never written as an explicit null", () => {
  it("labResultsForInsert: null / undefined / junk → {} (no reading), a real panel passes through", () => {
    expect(labResultsForInsert(null)).toEqual({});
    expect(labResultsForInsert(undefined)).toEqual({});
    expect(labResultsForInsert("x")).toEqual({});
    const panel = { mc: 10.8, ash: 3.73 };
    expect(labResultsForInsert(panel)).toBe(panel);
  });

  it("an empty panel never goes into an UPDATE patch (absence is not deletion)", () => {
    expect(shouldWriteLabPatch(null)).toBe(false);
    expect(shouldWriteLabPatch({})).toBe(false);
    expect(shouldWriteLabPatch({ mc: null, ash: null })).toBe(false);
    expect(shouldWriteLabPatch({ mc: 11.2 })).toBe(true);
    expect(isEmptyLabPanel({ mc: 0 })).toBe(false); // a 0 is a stated reading
  });

  function recordingDb() {
    const inserts: Array<Record<string, unknown>> = [];
    const ops: Array<Record<string, unknown>> = [];
    const db = {
      selectOne: async () => ({ batch_code: "SEPT-26-BLK14" }),
      insert: async () => [],
      insertIfAbsent: async (_t: string, rows: Array<Record<string, unknown>>) => {
        inserts.push(...rows);
        return { insertedCount: 1, inserted: [{ id: "new-id" }] };
      },
      applyDeliveryUpstream: async (o: Array<Record<string, unknown>>) => {
        ops.push(...o);
        return o.map((x) => ({ id: String(x.id), outcome: "applied" }));
      },
      stampIngestionAudit: async () => true,
      writeIngestionAudit: async () => "audit-id",
      upsertIngestionWatermark: async () => true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { db, inserts, ops };
  }

  const blankLabRow: DeliveryRow = {
    transaction_date: "2026-09-24",
    supplier: "Ornales",
    batch_code: "SEPT-26-BLK14",
    operator_batch_label: "B14",
    block_loc: "D-12C",
    truck_plate: "CCP 1309",
    sacks: 370,
    weight_kg: 10900,
    cost_basis: null,
    remarks: null,
    lab_results: null,
    true_weight_kg: null,
    deduction_note: null,
    warnings: [],
    confidence: 1,
    _source_row: 68,
  };

  function compact(over: Partial<DeliveriesCompact["actionable"]>): DeliveriesCompact {
    return {
      report_type: "deliveries",
      since: "2026-09-21",
      watermark: "2026-09-24",
      source: {},
      actionable: { new: [], changed: [], flagged: [], dup_noops: [], malformed: [], ...over },
    };
  }

  it("apply INSERTS a genuine no-reading-yet delivery with lab_results {} — not null, not the all-zero default", async () => {
    const { db, inserts } = recordingDb();
    const res = await applyDeliveries(compact({ new: [{ index: 68, row: blankLabRow }] }), { db, noLabel: true });
    expect(res.errors).toEqual([]);
    expect(res.inserts).toBe(1);
    expect(inserts[0].lab_results).toEqual({});
    expect(res.extraction_notes).toEqual([]);
  });

  it("apply's UPDATE drops a lab_results diff whose incoming side is empty, and keeps a real one", async () => {
    const { db, ops } = recordingDb();
    await applyDeliveries(
      compact({
        changed: [
          {
            index: 68,
            row: blankLabRow,
            db_row: { id: "a", lab_results: { mc: 10.8 } },
            diff: [
              { field: "lab_results", emailValue: null, dbValue: { mc: 10.8 } },
              { field: "remarks", emailValue: "PILED", dbValue: null },
            ],
          },
          {
            index: 69,
            row: blankLabRow,
            db_row: { id: "b", lab_results: {} },
            diff: [{ field: "lab_results", emailValue: null, dbValue: { mc: 1 } }],
          },
          {
            index: 70,
            row: blankLabRow,
            db_row: { id: "c", lab_results: { mc: 1 } },
            diff: [{ field: "lab_results", emailValue: { mc: 11.2 }, dbValue: { mc: 1 } }],
          },
        ],
      }),
      { db, noLabel: true },
    );
    expect(ops).toEqual([
      { id: "a", patch: { remarks: "PILED" } },
      { id: "c", patch: { lab_results: { mc: 11.2 } } },
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("L-054 — the notes reach the stored run result and the findings list", () => {
  it("extractionNotesInWindow keeps in-window and undated notes, drops the ones above the window", () => {
    const ex = extractDeliveries(mkWb(incidentTab()), "x.xlsx");
    const notes = ex.extraction_notes ?? [];
    expect(extractionNotesInWindow(notes, "2026-09-21")).toHaveLength(4);
    expect(extractionNotesInWindow(notes, "2026-09-25")).toHaveLength(0);
    expect(extractionNotesInWindow([{ ...notes[0], context_date: null }], "2099-01-01")).toHaveLength(1);
  });

  it("normalizeApply carries extraction_notes (default []) and strips a cost-ish cell key", () => {
    const ex = extractDeliveries(mkWb(incidentTab()), "x.xlsx");
    const n = (ex.extraction_notes ?? [])[0];
    const out = normalizeApply("deliveries", {
      extraction_notes: [{ ...n, cells: { ...n.cells, "PHP/KG": "39.5" } }],
    });
    expect(out?.extraction_notes).toHaveLength(1);
    expect(out?.extraction_notes[0].cells).toEqual({ "Weight (kg)": "449325" });
    expect(normalizeApply("deliveries", {})?.extraction_notes).toEqual([]);
  });

  it("flattenRunFindings turns them into findings: below-table stray = info, in-table / bad weight = attention", () => {
    const below = extractDeliveries(mkWb(incidentTab()), "x.xlsx").extraction_notes ?? [];
    const inside = extractDeliveries(mkWb({ 5: R65, 6: R68, 8: { 7: 12345 } }), "x.xlsx").extraction_notes ?? [];
    const heavy = extractDeliveries(mkWb({ 5: { ...R65, 7: 500000 } }), "x.xlsx").extraction_notes ?? [];
    const apply = normalizeApply("deliveries", { extraction_notes: [...below, ...inside, ...heavy] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const findings = flattenRunFindings({ reports: { deliveries: { classify: null, apply } } } as any);
    const bySev = (k: string) => findings.filter((f) => f.kind === k).map((f) => f.severity);
    expect(bySev("stray_row")).toEqual(["info", "info", "info", "info", "attention"]);
    expect(bySev("weight_out_of_range")).toEqual(["attention"]);
    for (const f of findings) {
      expect(f.section).toBe("deliveries");
      expect(JSON.stringify(f)).not.toMatch(/₱|cost_basis/);
    }
    const scratch = findings.find((f) => f.data.source_row === 17);
    expect(scratch?.title).toMatch(/500,000 kg/);
    expect(scratch?.location).toMatch(/below the Average row/);
  });
});
