/**
 * reportDeps.test.ts — the write-blocking dry-run db proxy is the load-bearing
 * guarantee of the whole dry-run mode: it MUST pass reads through and no-op EVERY
 * mutation. If any mutation leaks to the real client, a "dry" run would write data.
 */
import { describe, it, expect, vi } from "vitest";
import { makeDryRunDb } from "../../src/workflows/reportDeps.js";
import { DbClient } from "../../src/lib/db.js";

/** A DbClient whose every method is a spy, so we can assert what the proxy calls. */
function fakeReal(): DbClient {
  const real = Object.create(DbClient.prototype) as DbClient;
  Object.assign(real, {
    sb: { marker: "real-sb" },
    readRows: vi.fn(async () => [{ id: "r1" }]),
    selectOne: vi.fn(async () => ({ id: "s1" })),
    dataWatermark: vi.fn(async () => "2026-07-01"),
    insertProgressEvent: vi.fn(async () => {}),
    setSyncRunStatus: vi.fn(async () => {}),
    finishSyncRun: vi.fn(async () => {}),
    createSyncRun: vi.fn(async () => ({ id: "run" })),
    insert: vi.fn(async () => [{ id: "SHOULD-NOT-HAPPEN" }]),
    update: vi.fn(async () => [{ id: "SHOULD-NOT-HAPPEN" }]),
    deleteByDate: vi.fn(async () => {}),
    insertIfAbsent: vi.fn(async () => ({ inserted: [{ id: "X" }], skipped: [], insertedCount: 1, skippedCount: 0 })),
    insertFleconSettlements: vi.fn(async () => ({ insertedCount: 1, insertedDates: ["2026-01-31"], skippedCount: 0 })),
    writeIngestionAudit: vi.fn(async () => ({ id: "REAL" })),
    stampIngestionAudit: vi.fn(async () => true),
    upsertIngestionWatermark: vi.fn(async () => true),
  });
  return real;
}

describe("makeDryRunDb — write-blocking proxy", () => {
  it("passes reads through to the real client", async () => {
    const real = fakeReal();
    const dry = makeDryRunDb(real);

    expect(await dry.readRows("deliveries", { sinceDate: "2026-01-01" })).toEqual([{ id: "r1" }]);
    expect(real.readRows).toHaveBeenCalledWith("deliveries", { sinceDate: "2026-01-01" });

    expect(await dry.selectOne("batches", { batch_code: "eq.X" }, "id")).toEqual({ id: "s1" });
    expect(real.selectOne).toHaveBeenCalled();

    expect(await dry.dataWatermark("rc_out")).toBe("2026-07-01");
    expect(real.dataWatermark).toHaveBeenCalledWith("rc_out");
  });

  it("lets progress events flow (observational, not a data mutation)", async () => {
    const real = fakeReal();
    const dry = makeDryRunDb(real);
    await dry.insertProgressEvent({
      run_id: "r", report_type: "deliveries", stage: "classify", pct: 50, label: "x", detail: null, level: "info",
    });
    expect(real.insertProgressEvent).toHaveBeenCalledOnce();
  });

  it("NO-OPs insert / update / deleteByDate (never touches the real client)", async () => {
    const real = fakeReal();
    const dry = makeDryRunDb(real);

    expect(await dry.insert("deliveries", [{ a: 1 }])).toEqual([]);
    expect(await dry.update("deliveries", { id: "eq.1" }, { a: 2 })).toEqual([]);
    await expect(dry.deleteByDate("flecon_bag_movements", "2026-07-01")).resolves.toBeUndefined();

    expect(real.insert).not.toHaveBeenCalled();
    expect(real.update).not.toHaveBeenCalled();
    expect(real.deleteByDate).not.toHaveBeenCalled();
  });

  it("NO-OPs insertFleconSettlements — a dry run must not permanently settle a date", async () => {
    const real = fakeReal();
    const dry = makeDryRunDb(real);
    const res = await dry.insertFleconSettlements([
      { transaction_date: "2026-01-31", db_movement_count: 5, db_net_qty: 231 },
    ]);
    expect(res.insertedCount).toBe(0);
    expect(res.insertedDates).toEqual([]);
    expect(res.skippedCount).toBe(1);
    expect(real.insertFleconSettlements).not.toHaveBeenCalled();
  });

  it("NO-OPs insertIfAbsent — reports all rows skipped, none inserted", async () => {
    const real = fakeReal();
    const dry = makeDryRunDb(real);
    const rows = [{ a: 1 }, { a: 2 }];
    const res = await dry.insertIfAbsent("rc_out", rows, ["a"]);
    expect(res.insertedCount).toBe(0);
    expect(res.skippedCount).toBe(2);
    expect(res.inserted).toEqual([]);
    expect(res.skipped).toEqual(rows);
    expect(real.insertIfAbsent).not.toHaveBeenCalled();
  });

  it("NO-OPs the audit RPCs but returns benign success shapes", async () => {
    const real = fakeReal();
    const dry = makeDryRunDb(real);

    expect(await dry.writeIngestionAudit({ tableName: "rc_out", recordId: "1", operation: "INSERT", comment: "c" }))
      .toEqual({ id: "dry-run" });
    expect(await dry.stampIngestionAudit({ tableName: "deliveries", recordId: "1", comment: "c" })).toBe(true);
    expect(await dry.upsertIngestionWatermark("rc_out")).toBe(true);

    expect(real.writeIngestionAudit).not.toHaveBeenCalled();
    expect(real.stampIngestionAudit).not.toHaveBeenCalled();
    expect(real.upsertIngestionWatermark).not.toHaveBeenCalled();
  });
});
