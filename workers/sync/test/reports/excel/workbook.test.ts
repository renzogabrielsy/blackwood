/**
 * workbook.test.ts — the Excel sync report's contract.
 *
 * Four things are worth locking down here, because each of them is a promise made to
 * somebody outside this file:
 *
 *   1. A CLEAN run still produces a complete, valid workbook. "Nothing was flagged" is a
 *      real answer, and a missing file is indistinguishable from a generator that broke.
 *   2. NO PESO VALUE reaches a cell — including from a raw held-case row, which genuinely
 *      carries `cost_basis`. This is what `sync_run_reports.contains_prices = false` means,
 *      and what the download gate trusts.
 *   3. Every finding lands on exactly one section sheet, and nothing is silently dropped.
 *   4. A fuzzy price match shows BOTH spellings side by side — the specific thing Renzo
 *      asked for, and the one case no historical run can demonstrate yet because the price
 *      channel shipped the same day as this report.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import {
  auditPriceFree,
  buildSyncReportWorkbook,
  sidesForFinding,
  SYNC_REPORT_SHEETS,
  type SyncReportInput,
} from "../../../src/reports/excel/workbook.js";
import type { AppSyncRunResult } from "../../../src/reports/excel/findingsBridge.js";
import { flattenRunFindings } from "../../../src/reports/excel/findingsBridge.js";

function baseInput(over: Partial<SyncReportInput> = {}): SyncReportInput {
  return {
    runId: "11111111-2222-3333-4444-555555555555",
    runStatus: "succeeded",
    startedAt: "2026-08-07T02:47:40.884Z",
    finishedAt: "2026-08-07T02:53:26.569Z",
    dryRun: false,
    result: null,
    events: [],
    cases: [],
    generatorVersion: "excel-test",
    ...over,
  };
}

/** Read a written workbook back out, so assertions run against the real file bytes. */
async function reopen(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

/** Every string in every cell of a workbook. */
function allText(wb: ExcelJS.Workbook): string[] {
  const out: string[] = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (typeof v === "string") out.push(v);
        else if (v && typeof v === "object" && "richText" in v) {
          for (const rt of (v as ExcelJS.CellRichTextValue).richText) out.push(rt.text);
        }
      });
    });
  }
  return out;
}

describe("buildSyncReportWorkbook — the clean run", () => {
  it("produces a complete, non-empty workbook with every sheet present", async () => {
    const built = await buildSyncReportWorkbook(baseInput({ result: {} as AppSyncRunResult }));

    expect(built.buffer.byteLength).toBeGreaterThan(5_000);
    expect(built.findingCount).toBe(0);
    expect(built.containsPrices).toBe(false);

    const wb = await reopen(built.buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([...SYNC_REPORT_SHEETS]);
  });

  it("says CLEAN out loud rather than leaving the reader to infer it", async () => {
    const built = await buildSyncReportWorkbook(baseInput({ result: {} as AppSyncRunResult }));
    const text = allText(await reopen(built.buffer)).join("\n");
    expect(text).toContain("clean run");
    expect(text).toContain("Nothing flagged");
  });

  it("freezes the header row and sets an autofilter on every table sheet", async () => {
    const built = await buildSyncReportWorkbook(baseInput({ result: {} as AppSyncRunResult }));
    const wb = await reopen(built.buffer);
    for (const ws of wb.worksheets) {
      const view = ws.views?.[0] as { state?: string; ySplit?: number } | undefined;
      expect(view?.state, `${ws.name} should freeze its header`).toBe("frozen");
      expect(view?.ySplit ?? 0).toBeGreaterThan(0);
      if (ws.name !== "Summary") {
        expect(ws.autoFilter, `${ws.name} should have an autofilter`).toBeTruthy();
      }
    }
  });

  it("survives a NULL result (a crashed run) and still carries the log", async () => {
    const built = await buildSyncReportWorkbook(
      baseInput({
        result: null,
        runStatus: "failed",
        runError: "Mail Clerk crashed: ECONNRESET",
        events: [
          {
            report_type: "_run",
            stage: "fetch",
            pct: 3,
            label: "Checking Gmail for new reports...",
            detail: null,
            level: "info",
            at: "2026-08-07T02:47:41.000Z",
          },
        ],
      }),
    );
    expect(built.buffer.byteLength).toBeGreaterThan(5_000);
    const text = allText(await reopen(built.buffer)).join("\n");
    expect(text).toContain("Mail Clerk crashed: ECONNRESET");
    expect(text).toContain("Checking Gmail for new reports...");
  });
});

describe("buildSyncReportWorkbook — no peso value ever reaches a cell", () => {
  it("strips cost_basis out of a raw held-case row", async () => {
    const built = await buildSyncReportWorkbook(
      baseInput({
        result: {} as AppSyncRunResult,
        cases: [
          {
            report_type: "deliveries",
            kind: "already_exists",
            natural_key: "2026-08-05 | AUGUST-26-BLK1 | T138003 | 19605 | 300",
            status: "open",
            reason: "Already in the database",
            detail: null,
            // A real deliveries held row. `cost_basis` is the thing that must not survive.
            row: {
              transaction_date: "2026-08-05",
              batch_code: "AUGUST-26-BLK1",
              truck_plate: "T138003",
              weight_kg: 19605,
              sacks: 300,
              cost_basis: 39.99,
              php_total: 784_004,
            },
            occurrence_count: 2,
            created_at: "2026-08-05T01:00:00.000Z",
            last_seen_at: "2026-08-07T02:50:00.000Z",
            known_ruling_id: null,
          },
        ],
      }),
    );

    expect(built.containsPrices).toBe(false);

    const text = allText(await reopen(built.buffer)).join("\n");
    // The row is present...
    expect(text).toContain("AUGUST-26-BLK1");
    expect(text).toContain("T138003");
    // ...but the money is not, under any of its spellings.
    expect(text).not.toContain("cost_basis");
    expect(text).not.toContain("39.99");
    expect(text).not.toContain("php_total");
    expect(text).not.toContain("784004");
  });

  it("auditPriceFree catches a peso glyph and a cost-ish key=value token", () => {
    expect(auditPriceFree(["batch_code=AUGUST-26-BLK1", "weight_kg=19605"])).toBe(true);
    expect(auditPriceFree(["cost_basis=39.99"])).toBe(false);
    expect(auditPriceFree(["price_php_kg=12"])).toBe(false);
    // The glyph on its own is enough — it need not be in key=value form.
    expect(auditPriceFree(["total 39.99 pesos".replace("pesos", "₱")])).toBe(false);
  });
});

describe("buildSyncReportWorkbook — findings are filed, never dropped", () => {
  /** A result exercising four different channels across four different sections. */
  const busy = {
    reports: {
      gsheet: {
        classify: {
          report_type: "gsheet",
          ok: true,
          gate_failures: [],
          counts: { noop: 10, insert: 2, update: 0, flagged: 1 },
          rows_preview: [],
          classified_path: "",
          source: {},
          watermark: null,
        },
        apply: {
          report_type: "gsheet",
          ok: true,
          applied: { inserts: 2, updates: 0, replaced_dates: 0 },
          held: [
            {
              natural_key: "RC IN row 1225 - JULY-26-FEED1",
              reason: "skipped",
              kind: "unmapped_batch_code",
              row: { transaction_date: "2026-07-08", batch_code: "JULY-26-FEED1", weight_kg: 19605 },
            },
          ],
          labeled: true,
          watermark_updated: true,
          errors: [],
        },
      },
    },
    reconciliation: {
      blocking: {
        blockDiffs: [
          {
            kind: "grand_total",
            block_loc: null,
            sheet_kg: 10_372_909,
            computed_kg: 10_305_642,
            delta: 67_267,
            detail: "Total inventory disagrees: Sheet 10,372,909 kg vs app 10,305,642 kg.",
          },
        ],
        totals: { sheet_kg: 10_372_909, computed_kg: 10_305_642, delta: 67_267 },
      },
      stale_streams: [
        {
          stream: "electricity",
          label: "Electricity readings",
          through_date: "2026-08-04",
          operational_date: "2026-08-06",
          missed_working_days: 2,
          reports_next_day: true,
        },
      ],
      report_artifact: { ok: false, error: "Storage upload failed: bucket not found" },
    },
  } as unknown as AppSyncRunResult;

  it("puts each finding on the sheet its section owns", async () => {
    const findings = flattenRunFindings(busy);
    const sections = findings.map((f) => f.section).sort();
    // gsheet held row, blocking grand total, production (electricity stream), run (artifact).
    expect(sections).toEqual(["blocking", "gsheet", "production", "run"]);

    const built = await buildSyncReportWorkbook(baseInput({ result: busy }));
    expect(built.findingCount).toBe(4);
    expect(built.sheetCounts["Google Sheet"]).toBe(1);
    expect(built.sheetCounts.Blocking).toBe(1);
    expect(built.sheetCounts.Production).toBe(1);
    expect(built.sheetCounts.Run).toBe(1);
    expect(built.sheetCounts.Deliveries).toBe(0);

    // Sum over the section sheets accounts for every finding — nothing vanished.
    const sectionTotal = ["Deliveries", "RC OUT", "Google Sheet", "Blocking", "RC Movement", "Production", "FLECON", "Run"]
      .map((s) => built.sheetCounts[s] ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(sectionTotal).toBe(built.findingCount);
  });

  it("shows a failed report generation as a finding without pretending the run failed", async () => {
    const built = await buildSyncReportWorkbook(baseInput({ result: busy, runStatus: "succeeded" }));
    const text = allText(await reopen(built.buffer)).join("\n");
    expect(text).toContain("Excel report could not be generated");
    expect(text).toContain("Storage upload failed: bucket not found");
    // The run's own outcome is untouched.
    expect(text).toContain("succeeded");
  });

  it("counts warn and error beats separately, per section", async () => {
    const built = await buildSyncReportWorkbook(
      baseInput({
        result: busy,
        events: [
          { report_type: "deliveries", stage: "apply", pct: 60, label: "No price tab for August 2026", detail: "found: Aug. 2026", level: "error", at: "2026-08-07T02:50:00.000Z" },
          { report_type: "rc_out", stage: "classify", pct: 40, label: "Drift over tolerance", detail: null, level: "warn", at: "2026-08-07T02:49:00.000Z" },
          { report_type: "_run", stage: "finalize", pct: 100, label: "Done", detail: null, level: "info", at: "2026-08-07T02:53:00.000Z" },
        ],
      }),
    );
    expect(built.warnCount).toBe(1);
    expect(built.errorCount).toBe(1);
    expect(built.sheetCounts["Run Log"]).toBe(3);

    const wb = await reopen(built.buffer);
    const log = wb.getWorksheet("Run Log")!;
    const levels: string[] = [];
    log.eachRow((row, n) => {
      if (n <= 3) return;
      levels.push(String(row.getCell(1).value ?? ""));
    });
    // Severity readable as TEXT, never colour alone.
    expect(levels).toContain("ERROR");
    expect(levels).toContain("WARN");
  });
});

describe("sidesForFinding — both values, side by side", () => {
  it("shows our spelling against Czarina's for a fuzzy price match", () => {
    const result = {
      reports: {
        deliveries: {
          classify: null,
          apply: {
            report_type: "deliveries",
            ok: true,
            applied: { inserts: 1, updates: 0, replaced_dates: 0 },
            held: [],
            labeled: true,
            watermark_updated: true,
            errors: [],
            price_notes: [
              {
                kind: "price_fuzzy_match",
                detail:
                  "Priced from a row whose plate is spelled differently: ours T138003, hers 138003.",
                transaction_date: "2026-08-05",
                supplier: "Paquibot/Compra",
                batch_code: "AUGUST-26-BLK1",
                truck_plate: "T138003",
                weight_kg: 19605,
                sacks: 300,
                source_row: "row 1240",
                via: "fallback",
                matched_sheet: "Aug. 2026",
                matched_row: 41,
                date_tolerance_days: 1,
                looked_for: null,
                tabs_found: [],
                candidates: [],
                collided_on: null,
                differences: [
                  { field: "truck_plate", ours: "T138003", theirs: "138003" },
                  { field: "supplier", ours: "PAQUIBOT/COMPRA", theirs: "PAQUIBOT" },
                ],
                collisions: [],
              },
            ],
          },
        },
      },
    } as unknown as AppSyncRunResult;

    const findings = flattenRunFindings(result);
    expect(findings).toHaveLength(1);
    expect(findings[0].section).toBe("deliveries");

    const sides = sidesForFinding(findings[0]);
    expect(sides.a).toBe("ours: truck_plate T138003; supplier PAQUIBOT/COMPRA");
    expect(sides.b).toBe("Czarina: truck_plate 138003; supplier PAQUIBOT");
  });

  it("names the tab it wanted AND the tabs the file has, for an unresolved price tab", () => {
    const result = {
      reports: {
        deliveries: {
          classify: null,
          apply: {
            report_type: "deliveries",
            ok: false,
            held: [],
            labeled: false,
            watermark_updated: false,
            errors: [],
            price_notes: [
              {
                kind: "price_tab_unresolved",
                detail: 'Wanted "August 2026"; the file has "Aug. 2026", "Jul. 2026".',
                transaction_date: null,
                supplier: null,
                batch_code: null,
                truck_plate: null,
                weight_kg: null,
                sacks: null,
                source_row: null,
                via: null,
                matched_sheet: null,
                matched_row: null,
                date_tolerance_days: null,
                looked_for: "August 2026",
                tabs_found: ["Aug. 2026", "Jul. 2026", "March25"],
                candidates: [],
                collided_on: null,
                differences: [],
                collisions: [],
              },
            ],
          },
        },
      },
    } as unknown as AppSyncRunResult;

    const f = flattenRunFindings(result)[0];
    expect(f.severity).toBe("high");
    const sides = sidesForFinding(f);
    expect(sides.a).toBe("looked for: August 2026");
    expect(sides.b).toBe("file has: Aug. 2026, Jul. 2026, March25");
  });

  it("puts the days-overdue number in its own column for an unpriced delivery", async () => {
    const result = {
      reports: {
        deliveries: {
          classify: null,
          apply: {
            report_type: "deliveries",
            ok: true,
            applied: { inserts: 0, updates: 0, replaced_dates: 0 },
            held: [],
            labeled: true,
            watermark_updated: true,
            errors: [],
            unpriced_overdue: [
              {
                id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                transaction_date: "2026-08-01",
                supplier: "PAQUIBOT",
                batch_code: "AUGUST-26-BLK1",
                truck_plate: "T138003",
                weight_kg: 19605,
                sacks: 300,
                days_pending: 6,
              },
            ],
          },
        },
      },
    } as unknown as AppSyncRunResult;

    const built = await buildSyncReportWorkbook(baseInput({ result }));
    expect(built.sheetCounts.Deliveries).toBe(1);

    const wb = await reopen(built.buffer);
    const ws = wb.getWorksheet("Deliveries")!;
    const dataRow = ws.getRow(4);
    expect(String(dataRow.getCell(1).value)).toBe("HIGH"); // 6 days >= the 4-day escalation
    expect(dataRow.getCell(7).value).toBe(19605); // Weight (kg), a real number
    expect(dataRow.getCell(8).value).toBe(6); // Days, a real number
    // The date is a real date cell, formatted yyyy-mm-dd.
    const dateCell = dataRow.getCell(4);
    expect(dateCell.value).toBeInstanceOf(Date);
    expect((dateCell.value as Date).toISOString().slice(0, 10)).toBe("2026-08-01");
    expect(dateCell.numFmt).toBe("yyyy-mm-dd");
  });
});
