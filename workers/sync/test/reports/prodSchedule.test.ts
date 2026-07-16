/**
 * prodSchedule.test.ts — proves the ported PROD SCHED parse + Joseph merge (the worker
 * copy in src/reports/prodSchedule/parse.ts) reproduces the verified root-script SPEC.
 *
 * Two layers:
 *   1. SYNTHETIC merge test (always runs, no fixture): asserts mergeSchedules' rules —
 *      Joseph's scheduling wins, Renzo's tonnages kept on work days & zeroed on rest,
 *      setup fallback, source tag, and the composed remark strings.
 *   2. LIVE-FIXTURE Joseph parse (skips when the machine-local REV#2 workbook is absent,
 *      e.g. CI): parses the real 2026 3Q tab and asserts the July anchors that back the
 *      current DB (Jul 13 SOLID 8-hr, Jul 18 Optional leave, Jul 31 PAHUBAS, Sundays).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  mergeSchedules,
  parseJosephSchedule,
  parseJosephRev,
  type ProdScheduleRow,
  type JosephDay,
} from "../../src/reports/prodSchedule/parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// workers/sync/test/reports → up 4 → repo root.
const JOSEPH_FIXTURE = resolve(
  __dirname,
  "../../../../.sync-flags/joseph-prod-sched/joseph_REV2_2026_PRODUCTION_SCHEDULE.xlsx",
);

// ---------------------------------------------------------------------------
// 1. Synthetic merge — always runs, self-contained.
// ---------------------------------------------------------------------------
describe("mergeSchedules (ported merge rules)", () => {
  const rev = parseJosephRev("2026 PRODUCTION SCHEDULE REVISION # 2");
  expect(rev.sourceTag).toBe("joseph:REV2");

  const renzoBase = (plan_date: string): ProdScheduleRow => ({
    plan_date,
    year: 2026,
    month: 7,
    dow: "Monday",
    shifts: 1,
    setup: "3X50 / 6X50",
    projected_tons: 26,
    grades: { "3X50": 21, "4X8": 5 },
    remarks: "renzo base note",
    source: "gsheet:PROD SCHED",
  });

  it("keeps Renzo tons on a work day and takes Joseph's setup + shift-hours remark", () => {
    const j: JosephDay = {
      plan_date: "2026-07-13",
      shifts: 1,
      setup: "SOLID 3X50",
      shiftHours: 8,
      reason: null,
      note: null,
      rawB: "SINGLE SHIFT 8HRS",
      rawD: "SOLID PRODUCTION 3X50 CEBU",
    };
    const { rows } = mergeSchedules([renzoBase("2026-07-13")], [j], rev);
    expect(rows[0]).toMatchObject({
      plan_date: "2026-07-13",
      shifts: 1,
      setup: "SOLID 3X50",
      projected_tons: 26, // Renzo's tons KEPT
      grades: { "3X50": 21, "4X8": 5 },
      remarks: "8-hr (per Joseph REV#2)",
      source: "joseph:REV2",
    });
  });

  it("zeros tons + nulls setup/grades on a Joseph rest day and uses the reason remark", () => {
    const j: JosephDay = {
      plan_date: "2026-07-18",
      shifts: 0,
      setup: null,
      shiftHours: null,
      reason: "Optional leave day",
      note: null,
      rawB: "NO WORK - OPTIONAL LEAVE",
      rawD: null,
    };
    const { rows } = mergeSchedules([renzoBase("2026-07-18")], [j], rev);
    expect(rows[0]).toMatchObject({
      shifts: 0,
      setup: null,
      projected_tons: 0,
      grades: null,
      remarks: "Optional leave day (per Joseph REV#2)",
      source: "joseph:REV2",
    });
  });

  it("falls back to Renzo's setup when Joseph gives none on a work day", () => {
    const j: JosephDay = {
      plan_date: "2026-07-06",
      shifts: 1,
      setup: null, // holiday label yielded no setup
      shiftHours: 12,
      reason: null,
      note: "Holiday: Ninoy",
      rawB: "12HRS OPS",
      rawD: "NINOY HOLIDAY SPCL",
    };
    const { rows } = mergeSchedules([renzoBase("2026-07-06")], [j], rev);
    expect(rows[0].setup).toBe("3X50 / 6X50"); // Renzo's setup retained
    expect(rows[0].remarks).toBe("12-hr · Holiday: Ninoy (per Joseph REV#2)");
  });

  it("leaves dates Joseph does not cover 100% Renzo's", () => {
    const base = renzoBase("2026-07-09");
    const { rows, overriddenDates } = mergeSchedules([base], [], rev);
    expect(rows[0]).toEqual(base);
    expect(overriddenDates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Live-fixture Joseph parse — the real REV#2 workbook (machine-local; skips on CI).
// ---------------------------------------------------------------------------
const hasFixture = existsSync(JOSEPH_FIXTURE);
describe.skipIf(!hasFixture)("parseJosephSchedule (live REV#2 2026 3Q)", () => {
  const buf = hasFixture ? readFileSync(JOSEPH_FIXTURE) : Buffer.alloc(0);
  const parsed = parseJosephSchedule(buf, { targetYear: 2026, fromQuarter: 3 });
  const byDate = new Map(parsed.days.map((d) => [d.plan_date, d]));

  it("selects the 3Q tab(s) and parses July days", () => {
    expect(parsed.selectedTabs.some((t) => t.trim() === "2026 3Q")).toBe(true);
    expect(byDate.has("2026-07-13")).toBe(true);
  });

  it("Jul 13 = SOLID 3X50, 8-hr work day", () => {
    const j = byDate.get("2026-07-13")!;
    expect(j.shifts).toBe(1);
    expect(j.setup).toBe("SOLID 3X50");
    expect(j.shiftHours).toBe(8);
  });

  it("Jul 18 = rest, Optional leave day", () => {
    const j = byDate.get("2026-07-18")!;
    expect(j.shifts).toBe(0);
    expect(j.reason).toBe("Optional leave day");
  });

  it("Jul 31 = work day flagged PAHUBAS wind-down", () => {
    const j = byDate.get("2026-07-31")!;
    expect(j.shifts).toBe(1);
    expect(j.note).toContain("PAHUBAS wind-down");
  });

  it("Sundays are rest with reason Sunday", () => {
    for (const sun of ["2026-07-05", "2026-07-12", "2026-07-19", "2026-07-26"]) {
      const j = byDate.get(sun)!;
      expect(j.shifts).toBe(0);
      expect(j.reason).toBe("Sunday");
    }
  });
});
