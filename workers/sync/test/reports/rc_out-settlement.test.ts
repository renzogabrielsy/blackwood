/**
 * rc_out-settlement.test.ts — chokepoint A: the DATE-SETTLEMENT LEDGER filter inside
 * `reports/rc_out/index.ts::runReport` (2026-07-12). A settled `transaction_date`'s
 * PROPOSED rows are dropped BEFORE the gate reconcile() calls and BEFORE classify — no
 * held/flagged/new rows for it, no gate eval. classifyCase (the parity-frozen entrypoint)
 * is untouched; this filter lives only in the live orchestrator (`runReport`), which has
 * DB access classifyCase does not.
 *
 * Ground truth: specs/rc_out.md "§ Settlement", src/reports/rc_out/index.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { runReport, type RcOutManifest, type RunReportDeps } from "../../src/reports/rc_out/index.js";
import type { DbClient, Row, ReadRowsOptions } from "../../src/lib/db.js";

// ---------------------------------------------------------------------------
// Minimal two-date PROPOSED workbook: one section on "JUNE 10" (will be settled),
// one on "JUNE 11" (not settled). Both resolve to the same batch (MARCH-26-BLK5,
// block_no "# 5", blockDate March 2026) so classify only needs one batch_lookup entry.
// No STRT/END balances are written, so the L-037 guard never engages.
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
  ws.getRow(R + 1).getCell(12).value = s.dayTotal; // DAY TOTAL
  ws.getRow(R + 2).getCell(1).value = "BLOCK NO.";
  ws.getRow(R + 2).getCell(2).value = s.blockNo;
  ws.getRow(R + 3).getCell(1).value = "Gross weight";
}

async function buildTwoDateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const blockDate = new Date(Date.UTC(2026, 2, 1)); // March 2026 → MARCH-26-BLK5

  const wsSettled = wb.addWorksheet("JUNE 10");
  writeMinimalSection(wsSettled, 4, { whse: "D-11B", blockDate, blockNo: "# 5", dayTotal: 5000 });

  const wsFresh = wb.addWorksheet("JUNE 11");
  writeMinimalSection(wsFresh, 4, { whse: "D-11B", blockDate, blockNo: "# 5", dayTotal: 6000 });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function mkDb(opts: { settledDates?: string[] } = {}) {
  const calls = {
    insertedRcOut: [] as Row[],
    readRowsTables: [] as string[],
  };
  const db: Partial<DbClient> = {
    dataWatermark: async () => null,
    readSettledDates: async () => new Set(opts.settledDates ?? []),
    readRows: async (table: string, rowOpts: ReadRowsOptions = {}) => {
      calls.readRowsTables.push(table);
      if (table === "batches") {
        return [{ batch_code: "MARCH-26-BLK5", id: "batch-marchblk5" }];
      }
      if (table === "rc_out") {
        // Classify compare-set — empty so every surviving row is NEW. (No movement
        // attachment this run, so the GATE-phase rc_out sum read never happens.)
        return [];
      }
      void rowOpts;
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
    upsertIngestionWatermark: async () => true,
  };
  return { db: db as DbClient, calls };
}

describe("runReport — date-settlement ledger filter (chokepoint A)", () => {
  let tmpPath: string | null = null;

  afterEach(async () => {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
      tmpPath = null;
    }
  });

  async function writeTmpWorkbook(): Promise<string> {
    const buf = await buildTwoDateWorkbook();
    tmpPath = join(tmpdir(), `rc-out-settlement-test-${randomUUID()}.xlsx`);
    await writeFile(tmpPath, buf);
    return tmpPath;
  }

  const manifest: RcOutManifest = {
    reports: {
      rc_out: [{ storagePath: "fake/proposed.xlsx", filename: "PROPOSED.xlsx", emailUid: 1 }],
      // No rc_out_movement attachment — GATES are skipped entirely this run, isolating
      // the settlement filter from gate behavior.
    },
  };

  it("a settled date's rows are dropped before gates/classify — only the unsettled date is written", async () => {
    const path = await writeTmpWorkbook();
    const { db, calls } = mkDb({ settledDates: ["2026-06-10"] });
    const deps: RunReportDeps = {
      db,
      fetchToLocalPath: async () => path,
      noLabel: true,
    };

    const result = await runReport(deps, "run-1", manifest, { since: "2026-06-01" });

    // Only the JUNE 11 (unsettled) row was classified + written.
    expect(result.classify.counts.insert).toBe(1);
    expect(result.classify.counts.noop).toBe(0);
    expect(result.classify.counts.flagged).toBe(0);
    expect(result.apply.inserts).toBe(1);
    expect(calls.insertedRcOut).toHaveLength(1);
    expect(calls.insertedRcOut[0]).toMatchObject({ transaction_date: "2026-06-11", weight_kg: 6000 });

    // No held row of ANY kind mentions the settled date — it never reached classify/apply.
    const heldDates = result.apply.held.map((h) => JSON.stringify(h));
    expect(heldDates.some((s) => s.includes("2026-06-10"))).toBe(false);
  });

  it("without any settled dates, BOTH rows classify/write normally (control)", async () => {
    const path = await writeTmpWorkbook();
    const { db, calls } = mkDb({ settledDates: [] });
    const deps: RunReportDeps = {
      db,
      fetchToLocalPath: async () => path,
      noLabel: true,
    };

    const result = await runReport(deps, "run-2", manifest, { since: "2026-06-01" });

    expect(result.classify.counts.insert).toBe(2);
    expect(result.apply.inserts).toBe(2);
    expect(calls.insertedRcOut.map((r) => r.transaction_date).sort()).toEqual([
      "2026-06-10",
      "2026-06-11",
    ]);
  });
});
