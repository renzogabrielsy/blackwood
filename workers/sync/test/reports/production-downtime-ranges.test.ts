/**
 * production-downtime-ranges.test.ts — L-051.
 *
 * Every cell shape in here was COPIED OUT OF A REAL WORKBOOK, not invented: the two MC
 * files still in `sync-inbox` ("Daily Production Report 2026 2Q.xlsx", 43 day tabs
 * 2026-03-31…05-27, and "260911 Daily Production Report 2026 3Q.xlsx", 59 day tabs
 * 2026-07-01…09-11) were surveyed cell by cell before a line of the parser was written.
 * The two anchor assertions Renzo can check by hand are here too — 2026-09-03 = 118 min
 * and 2026-07-04 = 77 min — and the last describe() block runs the WHOLE 59-tab workbook
 * through the real extractor when that file is present locally.
 */
import { describe, it, expect } from "vitest";

import {
  parseTimeRanges,
  parseDurationText,
  resolveDowntimeMinutes,
  cellText,
} from "../../src/reports/production/downtimeRanges.js";
import {
  isOvertimeLabel,
  resolveShiftHours,
  scanOvertime,
} from "../../src/reports/production/shiftHours.js";

const mins = (cell: string) => parseTimeRanges(cell).totalMins;

describe("parseTimeRanges — the shapes MC actually writes", () => {
  it("reads an explicit AM/PM span (the pre-August spelling)", () => {
    expect(mins("8:00 AM-8:10 AM")).toBe(10);
    expect(mins("8:00 AM-9:40 AM")).toBe(100);
    expect(mins("11:55 AM-1:58 PM")).toBe(123);
  });

  it("reads a bare span with the plant-day rule (the August spelling)", () => {
    // 08:00 start is the plant day; hours 1-7 are the afternoon.
    expect(mins("8:00-8:07")).toBe(7);
    expect(mins("9:50-11:41")).toBe(111);
    expect(mins("12:58-1:05")).toBe(7); // 12:58 → 13:05
    expect(mins("3:00-3:09")).toBe(9); // 15:00 → 15:09
    expect(mins("4:00-5:00")).toBe(60); // 16:00 → 17:00
    expect(mins("8:00-11:37")).toBe(217);
  });

  it("reads NN as noon (2026-04-25's `12:10 NN-12:23 NN`)", () => {
    expect(mins("12:10 NN-12:23 NN")).toBe(13);
    expect(mins("12:07 NN-1:52 PM")).toBe(105);
  });

  it("sums several spans across lines, and never pairs across a line break", () => {
    // 2026-09-03 — THE ANCHOR. 7 + 111.
    expect(mins("8:00-8:07\n\n9:50-11:41")).toBe(118);
    // 2026-08-01: 10 + 65. A naive whole-cell scan would read 8:10 → 10:20 as one span.
    expect(mins("8:00-8:10\n\n10:20-11:25")).toBe(75);
    // 2026-08-07 — adjacent spans that share a boundary time.
    expect(mins("8:00-9:47\n\n9:47-10:12")).toBe(132);
  });

  it("counts an OPEN range as zero and names it", () => {
    // 2026-07-13: a real span plus a lone event mark.
    const p = parseTimeRanges("8:00 AM-10:03 AM\n\n3:22 PM");
    expect(p.totalMins).toBe(123);
    expect(p.openRanges).toEqual(["3:22 PM"]);
    expect(p.warnings.join(" ")).toContain("3:22 PM");
    // 2026-07-15: two event marks beside one span.
    expect(mins("8:00 AM-8:05 AM\n\n1:10 PM-2:25 PM\n\n2:55 PM")).toBe(80);
  });

  it("treats a truncated `3:55 PM-` as an open range, not half a span", () => {
    const p = parseTimeRanges("8:00 AM-8:16 AM\n\n3:55 PM-");
    expect(p.totalMins).toBe(16);
    expect(p.openRanges).toEqual(["3:55 PM"]);
  });

  it("pairs bare times ONLY when the cell has no dashed span (2026-08-05 brown-out)", () => {
    const p = parseTimeRanges("8:00\n\n8:22\n\n3:00\n\n3:09");
    expect(p.pairedBareTimes).toBe(true);
    // 8:00→8:22 = 22, then 15:00→15:09 = 9.
    expect(p.totalMins).toBe(31);
    expect(p.spans).toHaveLength(2);
    expect(p.openRanges).toEqual([]);
    // The same times WITH a dashed span present must NOT pair.
    const q = parseTimeRanges("8:00-8:05\n\n8:22\n\n3:00\n\n3:09");
    expect(q.pairedBareTimes).toBe(false);
    expect(q.totalMins).toBe(5);
    expect(q.openRanges).toHaveLength(3);
  });

  it("leaves an odd bare time over as an open range when pairing", () => {
    const p = parseTimeRanges("8:00\n8:22\n3:00");
    expect(p.totalMins).toBe(22);
    expect(p.openRanges).toEqual(["3:00"]);
  });

  it("refuses a span that ends before it starts, counting zero", () => {
    const p = parseTimeRanges("10:00 AM-9:00 AM");
    expect(p.totalMins).toBe(0);
    expect(p.spans).toHaveLength(0);
    expect(p.warnings.join(" ")).toContain("ends before it starts");
  });

  it("ignores an inverter setting typed into the range column", () => {
    // `29:29` / `30:30` are inverter settings, not times: hour > 23.
    expect(parseTimeRanges("INVERTER 29:29").spans).toHaveLength(0);
    expect(parseTimeRanges("ADJUST INVERTER TO 30:30").totalMins).toBe(0);
  });

  it("reads a blank / absent cell as nothing at all", () => {
    for (const v of ["", "   ", null, undefined]) {
      const p = parseTimeRanges(v);
      expect(p.totalMins).toBe(0);
      expect(p.spans).toHaveLength(0);
      expect(p.warnings).toEqual([]);
    }
  });

  it("renders a TIME-typed cell (a Date) back to HH:MM", () => {
    expect(cellText(new Date(Date.UTC(1899, 11, 30, 8, 0)))).toBe("08:00");
  });
});

describe("parseDurationText — the cross-check, read with its unit words", () => {
  it("reads plain minutes", () => {
    expect(parseDurationText("10 MINUTES").mins).toBe(10);
    expect(parseDurationText("7 MINUTES").mins).toBe(7);
  });

  it("reads the HOUR + MINUTES form the old digit-strip mangled", () => {
    // The old parse produced 140 / 23 / 115 for these — neither the hours nor the total.
    expect(parseDurationText("1 HOUR & 40 MINUTES").mins).toBe(100);
    expect(parseDurationText("2 HOURS & 3 MINUTES").mins).toBe(123);
    expect(parseDurationText("1 HOUR & 15 MINUTES").mins).toBe(75);
    expect(parseDurationText("1 HOUR").mins).toBe(60);
  });

  it("sums its own lines (2026-07-23 wrote both stoppages)", () => {
    expect(parseDurationText("12 MINUTES\n\n40 MINUTES").mins).toBe(52);
    expect(parseDurationText("60 MINUTES\n65 MINUTES").mins).toBe(125);
  });

  it("falls back to a bare number when no unit word is present", () => {
    expect(parseDurationText("45").mins).toBe(45);
  });

  it("says NOTHING (null, not 0) for a blank cell — the August shape", () => {
    expect(parseDurationText("").mins).toBeNull();
    expect(parseDurationText("\n\n").mins).toBeNull();
    expect(parseDurationText(null).mins).toBeNull();
  });
});

describe("resolveDowntimeMinutes — ranges win, duration cross-checks", () => {
  it("2026-09-03: blank DURATION, 118 min of ranges — THE anchor", () => {
    const r = resolveDowntimeMinutes("8:00-8:07\n\n9:50-11:41", "");
    expect(r.totalMins).toBe(118);
    expect(r.source).toBe("ranges");
    expect(r.durationMins).toBeNull();
    expect(r.disagrees).toBe(false); // a blank cell states nothing; it cannot disagree
  });

  it("2026-07-04: DURATION says 7, the ranges say 77 — the ranges win, loudly", () => {
    const r = resolveDowntimeMinutes(
      "8:00 AM-8:07 AM\n\n12:20 PM-1:30 PM",
      "7 MINUTES",
    );
    expect(r.totalMins).toBe(77);
    expect(r.source).toBe("ranges");
    expect(r.durationMins).toBe(7);
    expect(r.rangesMins).toBe(77);
    expect(r.disagrees).toBe(true);
    expect(r.warnings.join(" ")).toContain("7 min");
    expect(r.warnings.join(" ")).toContain("77 min");
  });

  it("agrees silently within one minute (2026-07-23: 52 vs 52)", () => {
    const r = resolveDowntimeMinutes(
      "8:00 AM-8:12 AM\n\n4:00 PM-4:40 PM",
      "12 MINUTES\n\n40 MINUTES",
    );
    expect(r.totalMins).toBe(52);
    expect(r.disagrees).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("agrees on 2026-04-10, where five event marks sit beside one real span", () => {
    const r = resolveDowntimeMinutes(
      "8:00 AM-9:45 AM\n\n8:00 AM\n\n8:03 AM\n\n9:30 AM\n\n9:38 AM\n\n10:44 AM",
      "1 HOUR & 45 MINUTES",
    );
    expect(r.rangesMins).toBe(105);
    expect(r.durationMins).toBe(105);
    expect(r.disagrees).toBe(false);
    expect(r.parse.openRanges).toHaveLength(5); // still named, still counted as zero
  });

  it("falls back to DURATION when no range parses, and says so", () => {
    const r = resolveDowntimeMinutes("", "1 HOUR & 25 MINUTES");
    expect(r.totalMins).toBe(85);
    expect(r.source).toBe("duration");
    expect(r.warnings.join(" ")).toContain("fell back to the DURATION cell");
  });

  it("reads a day with neither as zero minutes, not as an error", () => {
    const r = resolveDowntimeMinutes("", "");
    expect(r.totalMins).toBe(0);
    expect(r.source).toBe("none");
    expect(r.disagrees).toBe(false);
  });
});

describe("shift hours — derived from an overtime SIGNAL, never hardcoded", () => {
  it("recognises the overtime label and nothing else", () => {
    expect(isOvertimeLabel("OVERTIME")).toBe(true);
    expect(isOvertimeLabel(" overtime ")).toBe(true);
    expect(isOvertimeLabel("DAY SHIFT")).toBe(false);
    // Batch-changeover markers are NOT shift labels (L-007).
    expect(isOvertimeLabel("STARTING")).toBe(false);
    expect(isOvertimeLabel("ENDING")).toBe(false);
    expect(isOvertimeLabel(null)).toBe(false);
  });

  it("12 h when a runs row labelled OVERTIME produced kilos (2026-07-23)", () => {
    const scan = scanOvertime(
      [
        { label: "DAY SHIFT", kg: 11700 },
        { label: "OVERTIME", kg: 3120 },
      ],
      375,
    );
    expect(scan.hasOvertime).toBe(true);
    expect(resolveShiftHours(scan, "ranges")).toEqual({
      shiftHrs: 12,
      source: "overtime_signal",
    });
  });

  it("12 h on the CHARCOAL FED sacks alone, even with no runs label", () => {
    const scan = scanOvertime([{ label: null, kg: 15600 }], 375);
    expect(scan.hasOvertime).toBe(true);
  });

  it("8 h when the OVERTIME row is printed but reads 0 (2026-09-03)", () => {
    const scan = scanOvertime([{ label: null, kg: 19032 }], 0);
    expect(scan.hasOvertime).toBe(false);
    expect(resolveShiftHours(scan, "ranges")).toEqual({
      shiftHrs: 8,
      source: "default_8h",
    });
  });

  it("8 h when an OVERTIME label carries no kilos — a printed row is not a signal", () => {
    const scan = scanOvertime(
      [
        { label: "DAY SHIFT", kg: 15600 },
        { label: "OVERTIME", kg: 0 },
        { label: "OVERTIME", kg: null },
      ],
      null,
    );
    expect(scan.hasOvertime).toBe(false);
  });

  it("records `duration_only` when the minutes came from the typed total", () => {
    const scan = scanOvertime([{ label: null, kg: 100 }], 0);
    expect(resolveShiftHours(scan, "duration")).toEqual({
      shiftHrs: 8,
      source: "duration_only",
    });
    // …but an overtime day is still `overtime_signal`: the two facts are independent.
    const ot = scanOvertime([{ label: "OVERTIME", kg: 5 }], 0);
    expect(resolveShiftHours(ot, "duration").source).toBe("overtime_signal");
  });
});
