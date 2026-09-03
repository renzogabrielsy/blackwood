/**
 * rc_out-sheet-names.test.ts — L-048 (2026-09-03).
 *
 * THE INCIDENT: MC's `260902 PROPOSED DAILY REPORT SEPTEMBER 2026.xlsx` names its day tabs
 * `Aug. 29`, `Sep. 1`, `SEP. 2` — a PERIOD after the month abbreviation. `SHEET_NAME_RE`
 * wanted a bare space, so all three were skipped, `extractProposed` returned ZERO rows from
 * a workbook full of feedings, classify saw 0/0/0, apply wrote nothing — and the run then
 * LABELED the email processed, ADVANCED the watermark and reported `succeeded` with NO
 * finding at all. rc_out stopped at 2026-08-28 while every other stream was at Sept 1-2.
 *
 * Three things are pinned here:
 *   1. The tab-name reader accepts the human conventions and still refuses non-day tabs.
 *   2. `extractProposed` reports WHICH tabs it read and which it could not, structurally.
 *   3. `runReport` raises the note AND — when NOT ONE tab parsed — leaves the email
 *      unlabeled and the watermark unmoved, so a fix can read the same email again.
 *
 * Ground truth: specs/rc_out.md §2 + "§ Unreadable tabs", src/reports/sourceTabs.ts,
 * LEARNING_LEDGER.md L-048.
 */
import { describe, it, expect, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { sheetNameToDate, extractProposed } from "../../src/reports/rc_out/extract.js";
import { loadWorkbook } from "../../src/lib/xlsx.js";
import { runReport, type RcOutManifest, type RunReportDeps } from "../../src/reports/rc_out/index.js";
import { sourceTabsNote, isTotalTabFailure } from "../../src/reports/sourceTabs.js";
import { flattenRunFindings } from "../../src/reports/excel/findingsBridge.js";
import type { AppSyncRunResult } from "../../src/reports/excel/findingsBridge.js";
import { normalizeApply } from "../../src/workflows/normalizeReport.js";
import type { DbClient, Row } from "../../src/lib/db.js";
import type { ProgressEvent } from "../../src/lib/progress.js";

// ---------------------------------------------------------------------------
// 1. The tab-name reader.
// ---------------------------------------------------------------------------

describe("sheetNameToDate — a worksheet name a HUMAN typed (L-048)", () => {
  const YEAR = 2026;

  /** THE THREE TABS THAT BROKE IT, verbatim from MC's September workbook. */
  const THE_INCIDENT: Array<[string, string]> = [
    ["Aug. 29", "2026-08-29"],
    ["Sep. 1", "2026-09-01"],
    ["SEP. 2", "2026-09-02"],
  ];

  const ALSO_ACCEPTED: Array<[string, string]> = [
    ["Sept 1", "2026-09-01"],
    ["September 1", "2026-09-01"],
    ["AUG.29", "2026-08-29"], // no space at all
    ["Sep. 2.", "2026-09-02"], // trailing period too
    ["  MAY 26  ", "2026-05-26"], // stray whitespace
    ["july 4", "2026-07-04"], // lower case
    ["JUNE 30", "2026-06-30"], // the fixture spelling — MUST be unchanged
    ["JULY 1", "2026-07-01"],
    ["MARCH 3", "2026-03-03"],
  ];

  const REFUSED = [
    "SUMMARY",
    "TOTAL",
    "Sheet1", // "SHEET" is not a month
    "Aug 32", // no such day — Python's date() ValueError, mirrored
    "FEB 30",
    "JANUARY 2026", // the RC MOVEMENT month-tab shape: 4 digits can never be a day
    "Aug", // no day at all
    "29", // no month at all
    "Aug 2 3",
    "",
  ];

  for (const [name, iso] of THE_INCIDENT) {
    it(`reads the tab that broke the sync: "${name}" → ${iso}`, () => {
      const d = sheetNameToDate(name, YEAR);
      expect(d).not.toBeNull();
      expect(`${d!.year}-${String(d!.month).padStart(2, "0")}-${String(d!.day).padStart(2, "0")}`).toBe(iso);
    });
  }

  for (const [name, iso] of ALSO_ACCEPTED) {
    it(`accepts "${name}" → ${iso}`, () => {
      const d = sheetNameToDate(name, YEAR);
      expect(d).not.toBeNull();
      expect(`${d!.year}-${String(d!.month).padStart(2, "0")}-${String(d!.day).padStart(2, "0")}`).toBe(iso);
    });
  }

  for (const name of REFUSED) {
    it(`still refuses ${JSON.stringify(name)}`, () => {
      expect(sheetNameToDate(name, YEAR)).toBeNull();
    });
  }

  it("the month token goes through lib/months.ts — SEPT and SEP both mean September", () => {
    expect(sheetNameToDate("SEPT 5", YEAR)?.month).toBe(9);
    expect(sheetNameToDate("SEP 5", YEAR)?.month).toBe(9);
    expect(sheetNameToDate("SEPTEMBER 5", YEAR)?.month).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 2. The note constructor.
// ---------------------------------------------------------------------------

describe("sourceTabsNote", () => {
  const base = {
    reportType: "rc_out",
    sourceLabel: "PROPOSED DAILY REPORT",
    filename: "PROPOSED SEPTEMBER 2026.xlsx",
    rowsExtracted: 0,
  };

  it("is null when every tab parsed — nothing to report", () => {
    expect(sourceTabsNote({ ...base, parsed: ["JULY 1", "JULY 2"], unparsed: [] })).toBeNull();
  });

  it("is null for a workbook with no sheets — there is no evidence a tab was missed", () => {
    expect(sourceTabsNote({ ...base, parsed: [], unparsed: [] })).toBeNull();
  });

  it("a TOTAL failure names both sides and marks the source unconsumed", () => {
    const n = sourceTabsNote({ ...base, parsed: [], unparsed: ["Aug. 29", "Sep. 1", "SEP. 2"] })!;
    expect(n.tabs_total).toBe(3);
    expect(n.tabs_read).toBe(0);
    expect(n.unreadable_tabs).toEqual(["Aug. 29", "Sep. 1", "SEP. 2"]);
    expect(n.readable_tabs).toEqual([]);
    expect(n.source_left_unconsumed).toBe(true);
    expect(isTotalTabFailure(n)).toBe(true);
  });

  it("a PARTIAL failure does NOT leave the source unconsumed — real rows were written", () => {
    const n = sourceTabsNote({ ...base, parsed: ["JULY 1"], unparsed: ["notes"], rowsExtracted: 4 })!;
    expect(n.tabs_read).toBe(1);
    expect(n.source_left_unconsumed).toBe(false);
    expect(isTotalTabFailure(n)).toBe(false);
  });

  it("carries no ₱ — every value is a name, a count or a flag", () => {
    const n = sourceTabsNote({ ...base, parsed: [], unparsed: ["Aug. 29"] })!;
    const blob = JSON.stringify(n).toLowerCase();
    for (const banned of ["₱", "php", "cost", "price", "peso"]) {
      expect(blob).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. extract + the orchestrator.
// ---------------------------------------------------------------------------

function writeMinimalSection(
  ws: ExcelJS.Worksheet,
  R: number,
  s: { whse: string; blockDate: Date; blockNo: string; dayTotal: number },
): void {
  ws.getRow(R + 0).getCell(1).value = "WHSE #";
  ws.getRow(R + 0).getCell(2).value = s.whse;
  ws.getRow(R + 1).getCell(1).value = "BLOCK DATE";
  ws.getRow(R + 1).getCell(2).value = s.blockDate;
  ws.getRow(R + 1).getCell(12).value = s.dayTotal;
  ws.getRow(R + 2).getCell(1).value = "BLOCK NO.";
  ws.getRow(R + 2).getCell(2).value = s.blockNo;
  ws.getRow(R + 3).getCell(1).value = "Gross weight";
}

function mkDb() {
  const calls = { insertedRcOut: [] as Row[], watermarkUpserts: 0 };
  const db: Partial<DbClient> = {
    dataWatermark: async () => null,
    readSettledDates: async () => new Set<string>(),
    readRows: async (table: string) => {
      if (table === "batches") {
        return [
          { batch_code: "AUG-26-BLK4", id: "batch-aug26blk4" },
          { batch_code: "AUGUST-26-BLK4", id: "batch-aug26blk4" },
          { batch_code: "SEPT-26-BLK4", id: "batch-sept26blk4" },
          { batch_code: "SEPTEMBER-26-BLK4", id: "batch-sept26blk4" },
        ];
      }
      return [];
    },
    insertIfAbsent: async (table: string, rows: Row[]) => {
      if (table === "rc_out") calls.insertedRcOut.push(rows[0]);
      return {
        inserted: [{ ...rows[0], id: `rcout-${calls.insertedRcOut.length}` }],
        skipped: [],
        insertedCount: 1,
        skippedCount: 0,
      };
    },
    update: async () => [],
    writeIngestionAudit: async () => ({ id: "audit-1" }),
    upsertIngestionWatermark: async () => {
      calls.watermarkUpserts++;
      return true;
    },
  };
  return { db: db as DbClient, calls };
}

/** Wrap one rc_out apply result the way `runSync` does, then fold it to findings. */
function findingsFor(apply: unknown) {
  const result = {
    reports: { rc_out: { classify: null, apply: normalizeApply("rc_out", apply as never) } },
  } as unknown as AppSyncRunResult;
  return flattenRunFindings(result);
}

const manifest: RcOutManifest = {
  reports: {
    rc_out: [
      {
        storagePath: "fake/proposed.xlsx",
        filename: "260902 PROPOSED DAILY REPORT SEPTEMBER 2026.xlsx",
        emailUid: 42,
      },
    ],
  },
};

describe("runReport — an empty read of a NON-EMPTY workbook (L-048)", () => {
  let tmpPath: string | null = null;

  afterEach(async () => {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
      tmpPath = null;
    }
  });

  async function writeTmpWorkbook(build: (wb: ExcelJS.Workbook) => void): Promise<string> {
    const wb = new ExcelJS.Workbook();
    build(wb);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    tmpPath = join(tmpdir(), `rc-out-sheet-names-${randomUUID()}.xlsx`);
    await writeFile(tmpPath, buf);
    return tmpPath;
  }

  /** MC's September workbook shape — three period-suffixed day tabs, one section each. */
  function septemberWorkbook(wb: ExcelJS.Workbook): void {
    const aug = wb.addWorksheet("Aug. 29");
    writeMinimalSection(aug, 4, {
      whse: "A-11B",
      blockDate: new Date(Date.UTC(2026, 7, 1)),
      blockNo: "# 4",
      dayTotal: 21_500,
    });
    const sep1 = wb.addWorksheet("Sep. 1");
    writeMinimalSection(sep1, 4, {
      whse: "A-11B",
      blockDate: new Date(Date.UTC(2026, 8, 1)),
      blockNo: "# 4",
      dayTotal: 18_000,
    });
    const sep2 = wb.addWorksheet("SEP. 2");
    writeMinimalSection(sep2, 4, {
      whse: "A-11B",
      blockDate: new Date(Date.UTC(2026, 8, 1)),
      blockNo: "# 4",
      dayTotal: 17_250,
    });
  }

  it("extract now reads all three period tabs, and says which it read", async () => {
    const path = await writeTmpWorkbook(septemberWorkbook);
    const wb = await loadWorkbook(await (await import("node:fs/promises")).readFile(path));
    const ex = extractProposed(wb, 2026);

    expect(ex.sheetsUnparsed).toEqual([]);
    expect(ex.sheetsParsed).toEqual(["Aug. 29", "Sep. 1", "SEP. 2"]);
    expect(ex.rows.map((r) => r.transaction_date)).toEqual(["2026-08-29", "2026-09-01", "2026-09-02"]);
  });

  it("a workbook of unreadable tabs raises the note, and the email is NOT consumed", async () => {
    const path = await writeTmpWorkbook((wb) => {
      // Names no reader could ever resolve — the shape the OLD regex produced for MC's file.
      for (const name of ["29 Aug (day)", "1-9", "2 sept"]) {
        const ws = wb.addWorksheet(name);
        writeMinimalSection(ws, 4, {
          whse: "A-11B",
          blockDate: new Date(Date.UTC(2026, 8, 1)),
          blockNo: "# 4",
          dayTotal: 18_000,
        });
      }
    });

    const events: ProgressEvent[] = [];
    const { db, calls } = mkDb();
    const labeledUids: Array<number | string> = [];
    const deps: RunReportDeps = {
      db,
      fetchToLocalPath: async () => path,
      labeler: async (uids) => {
        labeledUids.push(...uids);
        return true;
      },
      progress: async (stage, label, pct, detail, level) => {
        events.push({ stage, label, pct, detail, level });
      },
    };

    const result = await runReport(deps, "run-l048", manifest, { since: "2026-08-01" });

    // Nothing extracted, nothing written — as before the fix.
    expect(result.apply.inserts).toBe(0);
    expect(calls.insertedRcOut).toHaveLength(0);

    // …but it is no longer SILENT.
    expect(result.apply.source_tab_notes).toHaveLength(1);
    const note = result.apply.source_tab_notes[0];
    expect(note.tabs_total).toBe(3);
    expect(note.tabs_read).toBe(0);
    expect(note.unreadable_tabs).toEqual(["29 Aug (day)", "1-9", "2 sept"]);
    expect(note.filename).toBe("260902 PROPOSED DAILY REPORT SEPTEMBER 2026.xlsx");
    expect(note.source_left_unconsumed).toBe(true);

    // …and it did not eat the email. THIS is the half that has to survive a fix.
    expect(labeledUids).toEqual([]);
    expect(result.apply.labeled).toBe(false);
    expect(result.apply.watermark_updated).toBe(false);
    expect(calls.watermarkUpserts).toBe(0);

    // Said out loud at error level, naming the tabs.
    const loud = events.filter((e) => e.level === "error");
    expect(loud.length).toBeGreaterThan(0);
    expect(loud.some((e) => e.label.includes("29 Aug (day)"))).toBe(true);

    // …and it reaches the operator's findings list as a HIGH finding naming both sides.
    const f = findingsFor(result.apply).find((x) => x.kind === "source_tabs_unreadable")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("high");
    expect(f.section).toBe("rc_out");
    expect(f.title).toMatch(/Not one of the 3 tabs/i);
    expect(f.reason).toContain("29 Aug (day)");
    expect(f.reason).toMatch(/left unmarked/i);
    expect(f.data.tabs_read).toBe(0);
    // No cost-ish key can ride this channel.
    for (const k of Object.keys(f.data)) {
      expect(/cost|price|php|peso/i.test(k), `cost-ish key: ${k}`).toBe(false);
    }
  });

  it("a PARTIAL tab failure still writes, still labels — and still reports", async () => {
    const path = await writeTmpWorkbook((wb) => {
      const good = wb.addWorksheet("Sep. 2");
      writeMinimalSection(good, 4, {
        whse: "A-11B",
        blockDate: new Date(Date.UTC(2026, 8, 1)),
        blockNo: "# 4",
        dayTotal: 17_250,
      });
      // A cover/summary tab the operator added. Never a day, and that is fine — but the
      // run must still say which tabs it skipped, because that list is the evidence.
      wb.addWorksheet("2 sept");
    });

    const { db, calls } = mkDb();
    const labeledUids: Array<number | string> = [];
    const deps: RunReportDeps = {
      db,
      fetchToLocalPath: async () => path,
      labeler: async (uids) => {
        labeledUids.push(...uids);
        return true;
      },
    };

    const result = await runReport(deps, "run-partial", manifest, { since: "2026-08-01" });

    expect(result.apply.inserts).toBe(1);
    expect(calls.insertedRcOut[0].weight_kg).toBe(17_250);
    expect(result.apply.source_tab_notes).toHaveLength(1);
    expect(result.apply.source_tab_notes[0].tabs_read).toBe(1);
    expect(result.apply.source_tab_notes[0].source_left_unconsumed).toBe(false);
    expect(labeledUids).toEqual([42]);
    expect(result.apply.watermark_updated).toBe(true);

    // Reported, but at `attention` — the run did real work; part of the source went unseen.
    const f = findingsFor(result.apply).find((x) => x.kind === "source_tabs_unreadable")!;
    expect(f.severity).toBe("attention");
    expect(f.title).toBe("1 of 2 tabs in PROPOSED DAILY REPORT could not be read");
    expect(f.reason).toContain('"2 sept"');
    expect(f.reason).toContain('"Sep. 2"');
  });

  it("MC's real September tab names now write all three feedings, and raise NO note", async () => {
    const path = await writeTmpWorkbook(septemberWorkbook);
    const { db, calls } = mkDb();
    const labeledUids: Array<number | string> = [];
    const deps: RunReportDeps = {
      db,
      fetchToLocalPath: async () => path,
      labeler: async (uids) => {
        labeledUids.push(...uids);
        return true;
      },
    };

    const result = await runReport(deps, "run-fixed", manifest, { since: "2026-08-01" });

    expect(result.apply.source_tab_notes).toEqual([]);
    expect(findingsFor(result.apply).some((x) => x.kind === "source_tabs_unreadable")).toBe(false);
    expect(result.apply.inserts).toBe(3);
    expect(calls.insertedRcOut.map((r) => r.transaction_date)).toEqual([
      "2026-08-29",
      "2026-09-01",
      "2026-09-02",
    ]);
    expect(labeledUids).toEqual([42]);
  });
});
