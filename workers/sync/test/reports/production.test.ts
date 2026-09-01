/**
 * production.test.ts — unit tests for the production port (Wave 3, port #5).
 *
 * The parity harness (`npm run parity -- --type production`) is the primary gate
 * (2/2, production_downtime_ge60 PASS-with-note via PD-5). These tests lock the
 * behaviors that define this port:
 *   - PD-5 / L-014 dt_mins>=60 split at 59 / 60 / 125 minutes.
 *   - L-025 blank / unrecognized column-H shift → Morning + strippable note.
 *     (The L-007 `STARTING`/`ENDING` markers are NO LONGER on that path — they are
 *     Morning by explicit rule, with no note and no warning. Their behavior, and the
 *     running-state `production_batch` derivation, live in
 *     test/reports/production-batch-markers.test.ts.)
 *   - L-026 combine of duplicate (shift_id, customer, grade) NEW run rows on apply.
 *   - L-028 second same-date waste row (carryover) resolves to a DISTINCT shift.
 *   - L-027 grade allowlist drop (KOREA POWDER) + generated-col exclusion on write.
 *
 * Ground truth: extract_daily_production.py, extract_waste_production.py,
 * classify_production_*.py, sync_production.py.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadProductionWorkbook } from "../../src/reports/production/sheet.js";
import { extractMc, type DowntimeRow, type McExtract, type RunRow } from "../../src/reports/production/extractMc.js";
import { extractIvy } from "../../src/reports/production/extractIvy.js";
import { reconcile } from "../../src/reports/production/reconcile.js";
import { classifyRuns, classifyWaste, type ShiftDbRow } from "../../src/reports/production/classify.js";
import {
  applyProduction,
  type ProductionCompact,
  type ProductionSections,
} from "../../src/reports/production/apply.js";
import type { DbClient, Row, InsertIfAbsentResult } from "../../src/lib/db.js";
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../src/lib/xlsx.js";

const FX = join(__dirname, "../../fixtures/production/workbooks");

async function loadMc(name: string) {
  return loadProductionWorkbook(await readFile(join(FX, name)));
}

// ---------------------------------------------------------------------------
// PD-5 / L-014 — dt_mins >= 60 split (hrs += mins//60; mins %= 60).
// The split happens at extract shaping (extractMc), so it is visible on the row.
// ---------------------------------------------------------------------------
describe("PD-5 / L-014 — dt_mins>=60 split", () => {
  // Pure re-implementation of the split so we can pin the boundary without a
  // bespoke workbook per minute-total. This mirrors extractMc's applied rule.
  const split = (totalMins: number): { dt_hrs: number; dt_mins: number } => {
    let dtHrs = 0;
    let dtMins = totalMins;
    if (dtMins >= 60) {
      dtHrs += Math.floor(dtMins / 60);
      dtMins = dtMins % 60;
    }
    return { dt_hrs: dtHrs, dt_mins: dtMins };
  };

  it("59 minutes stays unsplit (dt_hrs=0, dt_mins=59)", () => {
    expect(split(59)).toEqual({ dt_hrs: 0, dt_mins: 59 });
  });

  it("exactly 60 minutes splits to dt_hrs=1, dt_mins=0", () => {
    expect(split(60)).toEqual({ dt_hrs: 1, dt_mins: 0 });
  });

  it("125 minutes splits to dt_hrs=2, dt_mins=5", () => {
    expect(split(125)).toEqual({ dt_hrs: 2, dt_mins: 5 });
  });

  it("the real edge workbook (07-04-26, 125 min) emits the split, DB-CHECK-valid", async () => {
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    expect(mc.downtime).toHaveLength(1);
    const dt = mc.downtime[0] as DowntimeRow;
    expect(dt.dt_hrs).toBe(2);
    expect(dt.dt_mins).toBe(5);
    // The whole point of the deviation: dt_mins is now < 60, so the DB CHECK holds.
    expect(dt.dt_mins).toBeLessThan(60);
  });
});

// ---------------------------------------------------------------------------
// L-025 — a BLANK or UNRECOGNIZED column-H shift defaults to Morning + note.
// (`STARTING`/`ENDING` used to land here too; since 2026-08-03 they are Morning by
// explicit rule with NO note and NO warning — see production-batch-markers.test.ts.)
// ---------------------------------------------------------------------------
describe("L-025 — shift default to Morning", () => {
  it("edge workbook: every run defaults to M with the strippable note", async () => {
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    expect(mc.runs.length).toBeGreaterThan(0);
    for (const r of mc.runs) {
      expect(r.shift).toBe("M");
      expect(r._shift_defaulted).toBe(true);
      expect(r.remarks).toBe("shift defaulted to Morning (operator left blank)");
    }
  });

  it("KURARAY 6X50 blank-shift run carries the 'blank/absent' warning (blank-cell path)", async () => {
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    const kuraray = mc.runs.find((r) => r.customer === "KURARAY" && r.grade === "6X50");
    expect(kuraray).toBeDefined();
    expect(kuraray!.warnings).toContain("shift cell blank/absent — defaulted to Morning");
  });

  it("a defaulted-shift run classified against a note-less DB row is DUPLICATE_NOOP, not VALUE_CHANGED", () => {
    // The note is stripped off the email side before diffing (L-025), so an
    // already-written Morning row (DB remarks=null) must not perpetually re-diff.
    const shifts: ShiftDbRow[] = [
      { id: "SID-1", transaction_date: "2026-07-04", production_batch: "JULY", shift: "M" },
    ];
    const mc = { runs: [row3x50("2026-07-04")] };
    const res = classifyRuns(mc.runs, [{ id: "R1", shift_id: "SID-1", customer: "CEBU", grade: "3X50", ttl_kg: 16380, sacks_bags: 630, remarks: null }], shifts);
    const c = res.classifications[0];
    expect(c.class).toBe("DUPLICATE_NOOP");
    expect(c.diff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L-027 — grade allowlist drop (KOREA POWDER) at extract.
// ---------------------------------------------------------------------------
describe("L-027 — grade allowlist", () => {
  it("edge workbook drops the KOREA POWDER row; 4X8 would be kept", async () => {
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    const grades = mc.runs.map((r) => r.grade);
    expect(grades).not.toContain("POWDER");
    // Only allowlisted grades survive.
    for (const g of grades) expect(["3X50", "6X50", "8X50", "2X6", "4X8"]).toContain(g);
  });
});

// ---------------------------------------------------------------------------
// L-026 — combine duplicate (shift_id, customer, grade) NEW run rows on apply.
// ---------------------------------------------------------------------------
describe("L-026 — combine duplicate run rows on apply", () => {
  it("two NEW CEBU 3X50 rows on the same resolved shift combine into ONE insert with summed ttl_kg/sacks", async () => {
    const inserted: Row[] = [];
    const db = mockDb({
      onInsertIfAbsent: (table, rows) => {
        if (table === "production_runs") inserted.push(rows[0]);
        return okInsert(rows[0]);
      },
    });

    const sections = emptySections();
    sections.runs = [
      newRunClass("SID-1", "CEBU", "3X50", 16380, 630),
      newRunClass("SID-1", "CEBU", "3X50", 6890, 265),
    ];
    const res = await applyProduction(compactWith(sections), { db });

    const runInserts = inserted;
    expect(runInserts).toHaveLength(1);
    expect(runInserts[0].ttl_kg).toBe(16380 + 6890);
    expect(runInserts[0].sacks_bags).toBe(630 + 265);
    expect(res.inserts).toBe(1);
    expect(res.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// L-028 — a second same-date waste row (carryover) resolves to a DISTINCT shift.
// ---------------------------------------------------------------------------
describe("L-028 — month-transition second waste row", () => {
  it("two 2026-06-30 waste rows (JUNE vs JULY batch) key to different shifts, no collision", async () => {
    const mc = await loadMc; // unused; keep lints quiet on import shape
    void mc;
    const shifts: ShiftDbRow[] = [
      { id: "SID-JUN", transaction_date: "2026-06-30", production_batch: "JUNE", shift: "M" },
      { id: "SID-JUL", transaction_date: "2026-06-30", production_batch: "JULY", shift: "M" },
    ];
    const junRow = wasteRow("2026-06-30", "JUNE");
    const julRow = wasteRow("2026-06-30", "JULY");
    const res = classifyWaste([junRow, julRow], [], shifts);
    const [a, b] = res.classifications;
    // Both resolve to a real (distinct) shift — NEW, needs_shift_upsert=false.
    expect((a.natural_key as { shift_id: string }).shift_id).toBe("SID-JUN");
    expect((b.natural_key as { shift_id: string }).shift_id).toBe("SID-JUL");
    expect(a.class).toBe("NEW");
    expect(b.class).toBe("NEW");
    expect(a.needs_shift_upsert).toBe(false);
    expect(b.needs_shift_upsert).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L-046 — THE TAB IS THE BATCH. Ivy files each batch's waste in that batch's own
// tab, so a changeover day carries the SAME DATE twice with DIFFERENT figures:
// the outgoing tab's last row and the new tab's first row. Deriving
// production_batch from the DATE's calendar month collapsed both onto one
// (date, batch, shift) triplet — one shift_id — and production_waste's
// UNIQUE(shift_id) then admitted only whichever arrived first.
//
// Shape reproduced verbatim from the stored workbook of run 6649d16f
// (sync-inbox/6649d16f-.../production_waste/260829 WASTE PRODUCTION REPORT 2026.xlsx):
//   AUGUST 2026    row 27  2026-08-29  550/550/50/196/97/50/0.5/16   ttl 1509.5
//   SEPTEMBER 2026 row  5  2026-08-29  550/550/100/179/74/55/0.5/20  ttl 1528.5
// ---------------------------------------------------------------------------
describe("L-046 — the TAB is the batch, not the date's calendar month", () => {
  /** The real 2026-08-29 pair, one row per tab. */
  const AUG_29_AUGUST_TAB = {
    date: "2026-08-29",
    rs1a: 550, rs1b: 550, bf: 50, rs23: 196, rs5: 97,
    trml1: 50, trml2: 0.5, grit: 16, ttl: 1509.5, remarks: "ZAMBAONGA",
  };
  const AUG_29_SEPTEMBER_TAB = {
    date: "2026-08-29",
    rs1a: 550, rs1b: 550, bf: 100, rs23: 179, rs5: 74,
    trml1: 55, trml2: 0.5, grit: 20, ttl: 1528.5, remarks: "ZAMBAONGA",
  };

  const changeoverWorkbook = () =>
    fakeIvyWorkbook([
      { name: "AUGUST 2026", rows: [AUG_29_AUGUST_TAB] },
      { name: "SEPTEMBER 2026", rows: [AUG_29_SEPTEMBER_TAB] },
    ]);

  it("both same-date rows extract under their OWN tab's batch, with their OWN figures", () => {
    const { waste } = extractIvy(changeoverWorkbook(), "2026-08-28");
    expect(waste).toHaveLength(2);

    const aug = waste.find((w) => w.production_batch === "AUGUST")!;
    const sep = waste.find((w) => w.production_batch === "SEPTEMBER")!;
    expect(aug).toBeDefined();
    expect(sep).toBeDefined();

    // The TRUE date is preserved on both — only the batch follows the tab.
    expect(aug.transaction_date).toBe("2026-08-29");
    expect(sep.transaction_date).toBe("2026-08-29");
    expect(aug._source_sheet).toBe("AUGUST 2026");
    expect(sep._source_sheet).toBe("SEPTEMBER 2026");

    // No crossover: each row carries its own tab's figures.
    expect([aug.bf_kg, aug.rs23_kg, aug.rs5_kg, aug.trml1_kg, aug.grit_kg]).toEqual([50, 196, 97, 50, 16]);
    expect([sep.bf_kg, sep.rs23_kg, sep.rs5_kg, sep.trml1_kg, sep.grit_kg]).toEqual([100, 179, 74, 55, 20]);
    expect(aug._summed_kg).toBe(1509.5);
    expect(sep._summed_kg).toBe(1528.5);
  });

  it("only the carryover row is noted, and the note names the batch it was filed under", () => {
    const { waste } = extractIvy(changeoverWorkbook(), "2026-08-28");
    const aug = waste.find((w) => w.production_batch === "AUGUST")!;
    const sep = waste.find((w) => w.production_batch === "SEPTEMBER")!;

    expect(aug.warnings).toEqual([]); // 08-29 on the AUGUST tab is not a carryover
    expect(sep.warnings).toHaveLength(1);
    expect(sep.warnings[0]).toContain("Carryover date 2026-08-29");
    expect(sep.warnings[0]).toContain("SEPTEMBER 2026");
    // The row was FILED, not rejected — the note must not read as a defect.
    expect(sep.warnings[0]).toContain("filed under the SEPTEMBER batch");
  });

  it("the two rows key to DIFFERENT shifts — the second is NEW, never an overwrite of the first", () => {
    const { waste } = extractIvy(changeoverWorkbook(), "2026-08-28");
    // The live DB shape at run 6649d16f: the AUGUST shift + its waste row exist,
    // the SEPTEMBER shift does not exist at all.
    const shifts: ShiftDbRow[] = [
      { id: "SID-AUG", transaction_date: "2026-08-29", production_batch: "AUGUST", shift: "M" },
    ];
    const dbWaste = [
      {
        id: "W-AUG", shift_id: "SID-AUG",
        rs1a_kg: 550, rs1b_kg: 550, bf_kg: 50, rs23_kg: 196, rs5_kg: 97,
        trml1_kg: 50, trml2_kg: 0.5, grit_kg: 16, remarks: "ZAMBAONGA",
      },
    ];
    const res = classifyWaste(waste, dbWaste, shifts);
    const byBatch = new Map(
      res.classifications.map((c) => [(c.record as { production_batch: string }).production_batch, c]),
    );

    const aug = byBatch.get("AUGUST")!;
    const sep = byBatch.get("SEPTEMBER")!;
    expect(aug.class).toBe("DUPLICATE_NOOP"); // already stored, unchanged
    expect(sep.class).toBe("NEW");
    expect(sep.needs_shift_upsert).toBe(true);
    // THE REGRESSION: under the date-derived batch the SEPTEMBER-tab row resolved
    // to SID-AUG and proposed OVERWRITING August's waste with September's figures.
    expect(sep.existing_id).toBeNull();
    expect(res.classifications.some((c) => c.class === "VALUE_CHANGED")).toBe(false);
  });

  it("apply upserts TWO shifts and inserts BOTH waste rows — no already_exists collision", async () => {
    const { waste } = extractIvy(changeoverWorkbook(), "2026-08-28");
    const res0 = classifyWaste(waste, [], []); // nothing in the DB yet

    const shiftInserts: Row[] = [];
    const wasteInserts: Row[] = [];
    let sid = 0;
    const db = mockDb({
      onInsertIfAbsent: (table, rows) => {
        if (table === "production_shifts") shiftInserts.push(rows[0]);
        if (table === "production_waste") wasteInserts.push(rows[0]);
        return {
          inserted: [{ ...rows[0], id: `NEW-${++sid}` }],
          skipped: [], insertedCount: 1, skippedCount: 0,
        };
      },
    });

    const sections = emptySections();
    sections.waste = res0.classifications;
    const out = await applyProduction(compactWith(sections), { db });

    expect(shiftInserts.map((s) => s.production_batch).sort()).toEqual(["AUGUST", "SEPTEMBER"]);
    expect(shiftInserts.every((s) => s.transaction_date === "2026-08-29")).toBe(true);
    expect(wasteInserts).toHaveLength(2);
    expect(wasteInserts.map((w) => w.bf_kg).sort((a, b) => Number(a) - Number(b))).toEqual([50, 100]);
    expect(out.held).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it("reconcile totals a two-batch day BY DATE — both rows count, neither is a mismatch", () => {
    const { waste } = extractIvy(changeoverWorkbook(), "2026-08-28");
    // The per-DATE informational drift check must sum BOTH batches' waste for the
    // day (it groups on transaction_date, which the fix does not touch), and the
    // per-ROW internal check compares each row against its OWN reported total.
    const mc = { runs: [], downtime: [], electricity: [], trucks: [], dayTotals: {} };
    const rep = reconcile(mc as unknown as McExtract, { waste }, { "2026-08-29": 100000 });
    const day = rep.rc_out_drift.find((r) => r.date === "2026-08-29")!;
    expect(day.total_waste_kg).toBe(1509.5 + 1528.5);
    expect(rep.waste_mismatches).toEqual([]);
  });

  it("an ordinary in-month row is unaffected — no note, batch = the tab it lives on", () => {
    const wb = fakeIvyWorkbook([
      { name: "AUGUST 2026", rows: [{ ...AUG_29_AUGUST_TAB, date: "2026-08-28" }] },
    ]);
    const { waste } = extractIvy(wb, "2026-08-27");
    expect(waste).toHaveLength(1);
    expect(waste[0].production_batch).toBe("AUGUST");
    expect(waste[0].warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generated-cols-never-written — a VALUE_CHANGED patch strips diff/consumption/ttl_km.
// ---------------------------------------------------------------------------
describe("generated columns are never written", () => {
  it("an electricity VALUE_CHANGED patch never includes consumption_kwh/diff_kwh", async () => {
    const patches: Array<{ table: string; patch: Row }> = [];
    const db = mockDb({
      onApplyUpstream: (ops) => {
        for (const o of ops) patches.push({ table: String(o.table), patch: o.patch as Row });
        return ops.map((o) => ({ table: String(o.table), id: String(o.id), outcome: "applied" }));
      },
    });

    const sections = emptySections();
    sections.electricity = [
      {
        idx: 0,
        class: "VALUE_CHANGED",
        natural_key: { reading_date: "2026-07-01", meter: "MAIN" },
        existing_id: "E1",
        // diff carries {new} for the base col AND spurious generated cols to prove they're stripped.
        diff: {
          end_kwh: { new: 588.0 },
          consumption_kwh: { new: 999 },
          diff_kwh: { new: 8 },
        },
        record: {},
        reasons: ["1 field(s) differ from existing row"],
        confidence: 0.95,
      },
    ];
    const res = await applyProduction(compactWith(sections), { db });
    expect(res.updates).toBe(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].patch).toHaveProperty("end_kwh");
    expect(patches[0].patch).not.toHaveProperty("consumption_kwh");
    expect(patches[0].patch).not.toHaveProperty("diff_kwh");
  });
});

// ---------------------------------------------------------------------------
// 3Q layout shift — downtime/electricity/trucks are located by ANCHOR (label),
// not fixed rows. The "Daily Production Report 2026 3Q.xlsx" cumulative workbook
// shifted every section below the runs block DOWN by one row; the pre-anchor
// extractor read the header/blank and emitted ZERO for those three sections.
// These tests prove the 3Q layout now recovers AND the old-layout edge fixture
// (downtime at the legacy fixed rows) is unchanged.
// ---------------------------------------------------------------------------
describe("3Q layout shift — anchor-based section location", () => {
  it("recovers downtime + electricity + trucks from the 3Q workbook (previously all ZERO)", async () => {
    const mc = extractMc(await loadMc("production_mc_3q.xlsx"), 2026, "2026-06-25");

    // All three previously-broken sections are now non-empty across the July sheets.
    expect(mc.downtime.length).toBeGreaterThan(0);
    expect(mc.electricity.length).toBeGreaterThan(0);
    expect(mc.trucks.length).toBeGreaterThan(0);
  });

  it("electricity MAIN present-reading chain is recovered (07-08: prev 645.2 → present 652.2, mult 120)", async () => {
    const mc = extractMc(await loadMc("production_mc_3q.xlsx"), 2026, "2026-06-25");
    const e0708 = mc.electricity.find((e) => e.reading_date === "2026-07-08" && e.meter === "MAIN");
    expect(e0708).toBeDefined();
    expect(e0708!.start_kwh).toBe(645.2);
    expect(e0708!.end_kwh).toBe(652.2); // present reading
    expect(e0708!.meter_multiplier).toBe(120);
    // Diff (present − previous) = 7, matching the sheet's KWH DIFFERENCE cell.
    expect(e0708!.end_kwh! - e0708!.start_kwh!).toBeCloseTo(7, 6);
  });

  it("trucks are recovered from the shifted rows (07-08: AAV 6111 315.9 km/155 L, KCA 378 241.2 km/140 L)", async () => {
    const mc = extractMc(await loadMc("production_mc_3q.xlsx"), 2026, "2026-06-25");
    const day = mc.trucks.filter((t) => t.reading_date === "2026-07-08");

    const aav = day.find((t) => t.plate_no === "AAV 6111");
    expect(aav).toBeDefined();
    expect(aav!.start_km).toBe(15704.6);
    expect(aav!.end_km).toBe(16020.5);
    expect(aav!.end_km! - aav!.start_km!).toBeCloseTo(315.9, 4); // total distance
    expect(aav!.fuel_liters).toBe(155);

    const kca = day.find((t) => t.plate_no === "KCA 378");
    expect(kca).toBeDefined();
    expect(kca!.start_km).toBe(36099.4);
    expect(kca!.end_km).toBe(36340.6);
    expect(kca!.end_km! - kca!.start_km!).toBeCloseTo(241.2, 4);
    expect(kca!.fuel_liters).toBe(140);
  });

  it("a non-empty downtime row is recovered for 07-08 (dt_mins=28, DB-CHECK-valid < 60)", async () => {
    const mc = extractMc(await loadMc("production_mc_3q.xlsx"), 2026, "2026-06-25");
    const dt = mc.downtime.find((d) => d._source_sheet === "07-08-26") as DowntimeRow | undefined;
    expect(dt).toBeDefined();
    expect(dt!.dt_mins).toBe(28);
    expect(dt!.dt_hrs).toBe(0);
    expect(dt!.dt_mins).toBeLessThan(60);
    expect(dt!.dt_reason).toContain("REPAIR");
  });

  it("day totals are recovered from the shifted TOTAL row (07-08 = 26738)", async () => {
    const mc = extractMc(await loadMc("production_mc_3q.xlsx"), 2026, "2026-06-25");
    expect(mc.dayTotals["2026-07-08"]).toBe(26738);
  });

  it("OLD-layout edge fixture is UNCHANGED — legacy fixed rows still resolve (guard against regression)", async () => {
    // The edge fixture is the genuine old template: downtime at the legacy fixed
    // rows (no DURATION header → anchor falls back). Electricity/trucks are absent
    // in that stripped sheet and must stay empty. dayTotal still reads the C13 TOTAL.
    const mc = extractMc(await loadMc("production_mc_edge.xlsx"), 2026, "2026-01-01");
    expect(mc.downtime).toHaveLength(1);
    const dt = mc.downtime[0] as DowntimeRow;
    expect(dt.dt_hrs).toBe(2); // 125 min → PD-5 split
    expect(dt.dt_mins).toBe(5);
    expect(dt.dt_reason).toBe("REPAIR | belt change; motor");
    expect(dt.remarks).toBe("Time ranges: 8:00-9:00; 10:00-10:30");
    expect(mc.electricity).toEqual([]);
    expect(mc.trucks).toEqual([]);
    expect(mc.dayTotals["2026-07-04"]).toBe(37048);
  });
});

// ---------------------------------------------------------------------------
// missing-workbook robustness — extractIvy on an absent role is empty, never throws.
// ---------------------------------------------------------------------------
describe("empty-side extract", () => {
  it("extractIvy over a real workbook with an exclusive since past all rows yields []", async () => {
    const wb = await loadProductionWorkbook(await readFile(join(FX, "production_real_ivy.xlsx")));
    const ivy = extractIvy(wb, "2027-12-31");
    expect(ivy.waste).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NO-PRODUCTION day — a VALID-grade run row whose TOTAL-kg cell is genuinely
// BLANK means nothing was produced that shift. It must classify as a benign
// SKIPPED_NO_OUTPUT — never MALFORMED, never held, never gating the run — so a
// no-production day (e.g. 2026-07-17) can't choke the production sync. A present-
// but-unparseable or NEGATIVE ttl_kg is a real data error and STAYS malformed.
// ---------------------------------------------------------------------------
describe("no-production day — blank ttl_kg is a benign skip, not malformed", () => {
  const shifts: ShiftDbRow[] = [
    { id: "SID-1", transaction_date: "2026-07-17", production_batch: "JULY", shift: "M" },
  ];

  it("valid grade + genuinely blank kg → SKIPPED_NO_OUTPUT (not malformed, not new)", () => {
    const res = classifyRuns([runRow({ ttl_kg: null, _ttl_blank: true })], [], shifts);
    const c = res.classifications[0];
    expect(c.class).toBe("SKIPPED_NO_OUTPUT");
    expect(res.summary.malformed).toBe(0);
    expect(res.summary.new).toBe(0);
    expect(res.summary.skipped_no_output).toBe(1);
  });

  it("valid grade + present-but-unparseable kg (null, NOT flagged blank) → still MALFORMED", () => {
    const res = classifyRuns([runRow({ ttl_kg: null })], [], shifts); // no _ttl_blank
    const c = res.classifications[0];
    expect(c.class).toBe("MALFORMED");
    expect(c.reasons as string[]).toContain("ttl_kg not a non-negative number");
    expect(res.summary.malformed).toBe(1);
    expect(res.summary.skipped_no_output).toBeUndefined();
  });

  it("valid grade + NEGATIVE kg → still MALFORMED", () => {
    const res = classifyRuns([runRow({ ttl_kg: -5 })], [], shifts);
    expect(res.classifications[0].class).toBe("MALFORMED");
    expect(res.summary.malformed).toBe(1);
  });

  it("runs summary with no blank-kg rows OMITS skipped_no_output (parity: byte-identical)", () => {
    const res = classifyRuns([runRow({ ttl_kg: 16380 })], [], shifts);
    expect(res.classifications[0].class).not.toBe("SKIPPED_NO_OUTPUT");
    expect("skipped_no_output" in res.summary).toBe(false);
  });

  it("apply HOLDS nothing and writes nothing for a SKIPPED_NO_OUTPUT row (run stays clean)", async () => {
    const inserted: Row[] = [];
    const db = mockDb({
      onInsertIfAbsent: (_t, rows) => {
        inserted.push(rows[0]);
        return okInsert(rows[0]);
      },
    });
    const sections = emptySections();
    sections.runs = [skippedRunClass()];
    const res = await applyProduction(compactWith(sections), { db });
    expect(inserted).toHaveLength(0);
    expect(res.held).toEqual([]);
    expect(res.inserts).toBe(0);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("extractor: a blank TOTAL-kg cell sets _ttl_blank; a junk (#VALUE!) cell does NOT", () => {
    const wb = fakeMcWorkbook("07-17-26", [
      { grade: "3X50", shift: "MORNING SHIFT", ttl: null }, // no-production → blank
      { grade: "3X50", shift: "MORNING SHIFT", ttl: "#VALUE!" }, // junk → malformed-bound
    ]);
    const mc = extractMc(wb, 2026, "2026-01-01");
    expect(mc.runs).toHaveLength(2);
    const [blank, junk] = mc.runs;
    expect(blank.ttl_kg).toBeNull();
    expect(blank._ttl_blank).toBe(true);
    expect(junk.ttl_kg).toBeNull();
    expect(junk._ttl_blank).toBeUndefined();
  });
});

// ── fixtures/helpers ─────────────────────────────────────────────────────────
function runRow(overrides: Partial<RunRow>): RunRow {
  return {
    transaction_date: "2026-07-17",
    production_batch: "JULY",
    shift: "M",
    customer: "CEBU",
    grade: "3X50",
    ttl_kg: null,
    sacks_bags: null,
    remarks: null,
    _shift_defaulted: false,
    _source_sheet: "07-17-26",
    _source_row: 8,
    warnings: [],
    confidence: 1.0,
    ...overrides,
  };
}

function skippedRunClass() {
  return {
    idx: 0,
    class: "SKIPPED_NO_OUTPUT",
    natural_key: { shift_id: null, customer: "CEBU", grade: "3X50" },
    resolved_shift_id: null,
    needs_shift_upsert: false,
    existing_id: null,
    diff: null,
    record: runRow({ _ttl_blank: true }),
    reasons: ["no production output this shift (TOTAL kg blank) — skipped, not written"],
    confidence: 1.0,
  };
}

/** Minimal in-memory MC workbook exposing only the runs-block cells the extractor
 *  reads (grade=D, sacks=E, ttl=G, shift=H, rows 8+). All other sections resolve
 *  to empty (no anchors, null fallback cells). */
function fakeMcWorkbook(
  sheetName: string,
  runs: Array<{ grade: CellValue; shift: CellValue; ttl: CellValue; sacks?: CellValue }>,
): LoadedWorkbook {
  const cells = new Map<string, CellValue>();
  runs.forEach((rr, i) => {
    const row = 8 + i; // RUNS_FIRST_DATA_ROW
    cells.set(`${row},4`, rr.grade);
    cells.set(`${row},5`, rr.sacks ?? null);
    cells.set(`${row},7`, rr.ttl);
    cells.set(`${row},8`, rr.shift);
  });
  const sheet: LoadedSheet = {
    name: sheetName,
    rowCount: 100,
    columnCount: 20,
    cell: (row: number, col: number) => cells.get(`${row},${col}`) ?? null,
  };
  return {
    sheetNames: [sheetName],
    sheet: (n: string) => (n === sheetName ? sheet : null),
    sheetAt: (i: number) => (i === 0 ? sheet : null),
  };
}

function row3x50(date: string) {
  return {
    transaction_date: date,
    production_batch: "JULY",
    shift: "M",
    customer: "CEBU",
    grade: "3X50",
    ttl_kg: 16380,
    sacks_bags: 630,
    remarks: "shift defaulted to Morning (operator left blank)",
    _shift_defaulted: true,
    _source_sheet: date,
    _source_row: 8,
    warnings: ["unrecognized shift 'DAY SHIFT' — defaulted to Morning"],
    confidence: 0.9,
  };
}

function wasteRow(date: string, batch: string) {
  return {
    transaction_date: date,
    production_batch: batch,
    shift: "M",
    rs1a_kg: 1000, rs1b_kg: 1000, bf_kg: 100, rs23_kg: 300,
    rs5_kg: 100, trml1_kg: 50, trml2_kg: 0.5, grit_kg: 30,
    ttl_waste_kg_reported: 2580.5,
    remarks: "PCG",
    _source_sheet: `${batch} 2026`,
    _source_row: 5,
    _summed_kg: 2580.5,
    warnings: [],
  };
}

function emptySections(): ProductionSections {
  return { runs: [], downtime: [], waste: [], electricity: [], trucks: [] };
}

function newRunClass(sid: string, customer: string, grade: string, ttlKg: number, sacks: number) {
  return {
    idx: 0,
    class: "NEW",
    natural_key: { shift_id: sid, customer, grade },
    resolved_shift_id: sid,
    needs_shift_upsert: false,
    existing_id: null,
    diff: null,
    record: {
      transaction_date: "2026-07-04",
      production_batch: "JULY",
      shift: "M",
      customer,
      grade,
      ttl_kg: ttlKg,
      sacks_bags: sacks,
      remarks: null,
    },
    reasons: ["shift exists; no run for this customer+grade"],
    confidence: 0.97,
  };
}

/** One row of a fake Ivy WASTE tab, in the workbook's own column order. */
interface FakeWasteRow {
  date: string;
  rs1a: number; rs1b: number; bf: number; rs23: number;
  rs5: number; trml1: number; trml2: number; grit: number;
  ttl: number | null;
  remarks?: string | null;
  shift?: CellValue;
}

/**
 * Minimal in-memory Ivy WASTE workbook: one sheet per month, data from row 5, with
 * the extractor's POSITIONAL column map (A date · C/E/G/I/K/M/O/Q the 8 KLS streams ·
 * R reported total · S remarks · V shift). The interleaved SACKS columns are left
 * null — the extractor drops them, and leaving them empty proves it.
 */
function fakeIvyWorkbook(sheets: Array<{ name: string; rows: FakeWasteRow[] }>): LoadedWorkbook {
  const built = new Map<string, LoadedSheet>();
  for (const s of sheets) {
    const cells = new Map<string, CellValue>();
    s.rows.forEach((rr, i) => {
      const row = 5 + i; // DATA_START_ROW
      const put = (col: number, v: CellValue) => cells.set(`${row},${col}`, v);
      // The loader hands the extractor a Date for a date-typed cell; coerceDate
      // reads its UTC parts, so build it in UTC exactly as exceljs does.
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

function compactWith(sections: ProductionSections): ProductionCompact {
  return {
    report_type: "production",
    since: "2026-01-01",
    window: ["2026-06-30", "2026-07-07"],
    source: { mc_uid: null, ivy_uid: null, mc_thread_id: null },
    sections,
  };
}

function okInsert(row: Row): InsertIfAbsentResult {
  const inserted = { ...row, id: `NEW-${Math.random().toString(36).slice(2, 8)}` };
  return { inserted: [inserted], skipped: [], insertedCount: 1, skippedCount: 0 };
}

/**
 * A minimal DbClient stub — only the methods applyProduction calls.
 *
 * `applyProductionUpstream` is the CONDITIONAL update path (the human-edit latch); it
 * MUST be stubbed, or every VALUE_CHANGED test silently lands in the catch and reports
 * zero updates. (That is the BUG-016 lesson: a stub built from `Partial<DbClient>` does
 * not fail to compile when the client grows a method.) `onApplyUpstream` lets a test
 * choose the per-op outcome the real RPC would return.
 */
export function mockDb(hooks: {
  onInsertIfAbsent?: (table: string, rows: Row[], nkey: string[]) => InsertIfAbsentResult;
  onUpdate?: (table: string, filters: Record<string, string>, patch: Row) => void;
  onApplyUpstream?: (ops: Row[]) => Array<{ table: string; id: string; outcome: string }>;
}): DbClient {
  const stub: Partial<DbClient> = {
    insertIfAbsent: async (table: string, rows: Row[], naturalKey: string[]) =>
      hooks.onInsertIfAbsent ? hooks.onInsertIfAbsent(table, rows, naturalKey) : okInsert(rows[0]),
    update: async (table: string, filters: Record<string, string>, patch: Row) => {
      hooks.onUpdate?.(table, filters, patch);
      return [];
    },
    applyProductionUpstream: async (ops: Row[]) =>
      hooks.onApplyUpstream
        ? hooks.onApplyUpstream(ops)
        : ops.map((o) => ({ table: String(o.table), id: String(o.id), outcome: "applied" })),
    selectOne: async () => null,
    writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
    upsertIngestionWatermark: async () => true,
  };
  return stub as DbClient;
}
