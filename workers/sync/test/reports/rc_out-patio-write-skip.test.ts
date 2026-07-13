/**
 * rc_out-patio-write-skip.test.ts — the PATIO WRITE-SKIP filter inside
 * `reports/rc_out/index.ts::runReport` (2026-07-13, data-integrity fix).
 *
 * rc_out's natural key is (transaction_date, batch_id, destination) — NO block_loc (see
 * apply.ts:13). A PROPOSED row at a known patio alias (src/reconcile/blockAliases.ts —
 * `isKnownPatioAlias`) is really the Sheet's SUNDRY batch at a coded PCA/PCB block, but
 * PROPOSED mis-derives a BLK batch code for it from (block_date, block_no) — that phantom
 * row then COLLIDES on the natural key with a genuine, unrelated block feeding attributed
 * to the same derived batch, clobbering the real row every run (live proof: rc_out row
 * 0238c58d flip-flopped 6x between "JAN-26-BLK17 @ A-11B" (real) and
 * "JAN-26-BLK17 @ 15A MIDDLE SIDE" (patio duplicate of MARCH-26-SUNDRY7 @ PCA-15C)).
 *
 * This filter drops a patio-aliased row BEFORE the gate reconcile() calls and BEFORE
 * classify, same chokepoint/pattern as the settled-date skip (rc_out-settlement.test.ts).
 * classifyCase (the parity-frozen entrypoint) is untouched.
 *
 * Ground truth: specs/rc_out.md "§ Settlement" (chokepoint pattern), specs/PORTING_DECISIONS.md,
 * src/reconcile/blockAliases.ts, src/reports/rc_out/index.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { runReport, type RcOutManifest, type RunReportDeps } from "../../src/reports/rc_out/index.js";
import type { DbClient, Row, ReadRowsOptions } from "../../src/lib/db.js";
import type { ProgressEvent } from "../../src/lib/progress.js";

// ---------------------------------------------------------------------------
// A single PROPOSED block section (WHSE / BLOCK DATE / BLOCK NO. / DAY TOTAL) written
// at row R on a given sheet. Same shape as rc_out-settlement.test.ts's writer.
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

function mkDb(opts: { batches?: Array<{ batch_code: string; id: string }> } = {}) {
  const calls = {
    insertedRcOut: [] as Row[],
    readRowsTables: [] as string[],
  };
  const db: Partial<DbClient> = {
    dataWatermark: async () => null,
    readSettledDates: async () => new Set<string>(),
    readRows: async (table: string, rowOpts: ReadRowsOptions = {}) => {
      calls.readRowsTables.push(table);
      if (table === "batches") {
        return opts.batches ?? [{ batch_code: "JAN-26-BLK17", id: "batch-jan26blk17" }];
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

describe("runReport — patio write-skip filter", () => {
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
    tmpPath = join(tmpdir(), `rc-out-patio-skip-test-${randomUUID()}.xlsx`);
    await writeFile(tmpPath, buf);
    return tmpPath;
  }

  const manifest: RcOutManifest = {
    reports: {
      rc_out: [{ storagePath: "fake/proposed.xlsx", filename: "PROPOSED.xlsx", emailUid: 1 }],
      // No rc_out_movement attachment — GATES are skipped entirely this run, isolating
      // the patio filter from gate behavior.
    },
  };

  it("a patio-aliased row is filtered out — not classified, not gated, not written", async () => {
    const blockDate = new Date(Date.UTC(2026, 0, 1)); // Jan 2026
    const path = await writeTmpWorkbook((wb) => {
      const ws = wb.addWorksheet("JAN 15");
      writeMinimalSection(ws, 4, { whse: "15A MIDDLE SIDE", blockDate, blockNo: "# 17", dayTotal: 7494 });
    });

    const events: ProgressEvent[] = [];
    const { db, calls } = mkDb();
    const deps: RunReportDeps = {
      db,
      fetchToLocalPath: async () => path,
      noLabel: true,
      progress: async (stage, label, pct, detail, level) => {
        events.push({ stage, label, pct, detail, level });
      },
    };

    const result = await runReport(deps, "run-1", manifest, { since: "2026-01-01" });

    // Nothing classified, nothing written, nothing held.
    expect(result.classify.counts.insert).toBe(0);
    expect(result.classify.counts.noop).toBe(0);
    expect(result.classify.counts.flagged).toBe(0);
    expect(result.apply.inserts).toBe(0);
    expect(result.apply.held).toHaveLength(0);
    expect(calls.insertedRcOut).toHaveLength(0);

    // Visibility line was emitted with the honest count.
    const patioLine = events.find((e) => e.label.includes("patio feeding"));
    expect(patioLine).toBeDefined();
    expect(patioLine?.label).toBe(
      "Skipped 1 patio feeding(s) on the write path — Sheet-owned SUNDRY blocks, " +
        "proposed can't attribute them (they remain the Sheet's records).",
    );
  });

  it("a normal coded block and a FEED row are unaffected — both classify and write", async () => {
    const blockDate = new Date(Date.UTC(2026, 0, 1)); // Jan 2026
    const path = await writeTmpWorkbook((wb) => {
      const ws = wb.addWorksheet("JAN 15");
      // Normal coded block -> JAN-26-BLK17.
      writeMinimalSection(ws, 4, { whse: "A-11B", blockDate, blockNo: "# 17", dayTotal: 7045 });
      // FEED section -> JAN-26-FEED3, block_loc becomes null (never dropped, never a
      // patio alias — isKnownPatioAlias(null) must be false).
      writeMinimalSection(ws, 12, { whse: "FOR FEEDING", blockDate, blockNo: "# 3", dayTotal: 3000 });
    });

    const events: ProgressEvent[] = [];
    const { db, calls } = mkDb({
      batches: [
        { batch_code: "JAN-26-BLK17", id: "batch-jan26blk17" },
        { batch_code: "JAN-26-FEED3", id: "batch-jan26feed3" },
      ],
    });
    const deps: RunReportDeps = {
      db,
      fetchToLocalPath: async () => path,
      noLabel: true,
      progress: async (stage, label, pct, detail, level) => {
        events.push({ stage, label, pct, detail, level });
      },
    };

    const result = await runReport(deps, "run-2", manifest, { since: "2026-01-01" });

    expect(result.classify.counts.insert).toBe(2);
    expect(result.apply.inserts).toBe(2);
    expect(calls.insertedRcOut).toHaveLength(2);
    expect(calls.insertedRcOut.some((r) => r.block_loc === "A-11B" && r.weight_kg === 7045)).toBe(true);
    expect(calls.insertedRcOut.some((r) => r.block_loc === null && r.weight_kg === 3000)).toBe(true);

    // No patio-skip line — nothing was dropped.
    expect(events.some((e) => e.label.includes("patio feeding"))).toBe(false);
  });

  it("collision scenario: a real block and a patio-aliased row derive the SAME batch on the SAME date — only the non-patio row survives to the write path", async () => {
    const blockDate = new Date(Date.UTC(2026, 0, 1)); // Jan 2026, both "# 17" -> JAN-26-BLK17
    const path = await writeTmpWorkbook((wb) => {
      const ws = wb.addWorksheet("JAN 15");
      // Real feeding — the one that must survive.
      writeMinimalSection(ws, 4, { whse: "A-11B", blockDate, blockNo: "# 17", dayTotal: 7045 });
      // Patio duplicate deriving the SAME batch_code (JAN-26-BLK17) — the exact live-bug
      // shape (rc_out row 0238c58d). Must be dropped before it can collide on the
      // (date, batch_id, destination) natural key and clobber the real row.
      writeMinimalSection(ws, 12, { whse: "15A MIDDLE SIDE", blockDate, blockNo: "# 17", dayTotal: 7494 });
    });

    const events: ProgressEvent[] = [];
    const { db, calls } = mkDb({ batches: [{ batch_code: "JAN-26-BLK17", id: "batch-jan26blk17" }] });
    const deps: RunReportDeps = {
      db,
      fetchToLocalPath: async () => path,
      noLabel: true,
      progress: async (stage, label, pct, detail, level) => {
        events.push({ stage, label, pct, detail, level });
      },
    };

    const result = await runReport(deps, "run-3", manifest, { since: "2026-01-01" });

    // Only ONE row reaches classify/apply — the real A-11B feeding. No collision, no
    // overwrite risk, no held row.
    expect(result.classify.counts.insert).toBe(1);
    expect(result.apply.inserts).toBe(1);
    expect(result.apply.held).toHaveLength(0);
    expect(calls.insertedRcOut).toHaveLength(1);
    expect(calls.insertedRcOut[0]).toMatchObject({ block_loc: "A-11B", weight_kg: 7045 });

    const patioLine = events.find((e) => e.label.includes("patio feeding"));
    expect(patioLine?.label).toContain("Skipped 1 patio feeding(s)");
  });
});
