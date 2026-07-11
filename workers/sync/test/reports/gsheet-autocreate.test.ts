/**
 * gsheet-autocreate.test.ts — integration tests for the 2026-07-11 batch
 * auto-create policy wired into gsheet/apply.ts's UNMAPPED loop (both rc_in and
 * rc_out modes). Locks the three required scenarios end-to-end through
 * `applyFromCompact`:
 *   (a) pattern-valid + genuinely new  → batch created (template) + row written.
 *   (b) pattern-invalid (typo)         → still held/unmapped, nothing written.
 *   (c) alias-of-existing              → resolves, no duplicate batch, row written.
 *
 * Ground truth: apply.ts's UNMAPPED loop + lib/batchAutoCreate.ts.
 */
import { describe, it, expect } from "vitest";

import { applyFromCompact, type ModeCompact, type CompactUnmapped } from "../../src/reports/gsheet/apply.js";
import type { DbClient } from "../../src/lib/db.js";

// ---------------------------------------------------------------------------
// A DbClient stub recording every call this path can make.
// ---------------------------------------------------------------------------
function stubDb(opts: { existingBatches?: Record<string, string> } = {}) {
  const batches = { ...(opts.existingBatches ?? {}) }; // batch_code -> id
  let nextId = 1;
  const calls = {
    upsertBatchIfAbsent: [] as Array<Record<string, unknown>>,
    insertDeliveries: [] as Array<Record<string, unknown>>,
    insertRcOut: [] as Array<Record<string, unknown>>,
    writeIngestionAudit: [] as Array<{ tableName: string; recordId: string; operation: string }>,
    stampIngestionAudit: [] as Array<{ tableName: string; recordId: string }>,
  };

  const db = {
    async upsertBatchIfAbsent(row: Record<string, unknown>) {
      calls.upsertBatchIfAbsent.push(row);
      const code = String(row.batch_code);
      if (code in batches) return { id: batches[code], batch_code: code, created: false };
      const id = `batch-${nextId++}`;
      batches[code] = id;
      return { id, batch_code: code, created: true };
    },
    async insert(table: string, rows: Array<Record<string, unknown>>) {
      if (table === "deliveries") calls.insertDeliveries.push(...rows);
      if (table === "rc_out") calls.insertRcOut.push(...rows);
      return rows.map((_, i) => ({ id: `row-${table}-${i + 1}` }));
    },
    async stampIngestionAudit(args: { tableName: string; recordId: string }) {
      calls.stampIngestionAudit.push(args);
      return true;
    },
    async writeIngestionAudit(args: { tableName: string; recordId: string; operation: string }) {
      calls.writeIngestionAudit.push(args);
      return { id: "audit-1" };
    },
  };
  return { db: db as unknown as DbClient, calls };
}

function compact(mode: "rc_in" | "rc_out", unmapped: CompactUnmapped[]): ModeCompact {
  return { mode, since: "2025-01-01", actionable: { new: [], changed: [], flagged: [], unmapped, malformed: [] } };
}

function unmappedRcIn(over: Partial<CompactUnmapped> = {}): CompactUnmapped {
  return {
    kind: "UNMAPPED",
    index: 1228,
    decision: "skip",
    batch_code: "JULY-26-BLK6",
    date: "2026-07-10",
    block_loc: "C-11A",
    weight_kg: 20000,
    supplier: "ACME",
    truck_plate: "ABC 111",
    full: {
      kind: "NEW",
      index: 1228,
      date: "2026-07-10",
      batch_code: "JULY-26-BLK6",
      block_loc: "C-11A",
      weight_kg: 20000,
      supplier: "ACME",
      truck_plate: "ABC 111",
      sacks: 200,
      remarks: null,
      lab_results: null,
      confidence: 1,
      true_weight_kg: null,
      deduction_note: null,
    },
    ...over,
  };
}

function unmappedRcOut(over: Partial<CompactUnmapped> = {}): CompactUnmapped {
  return {
    kind: "UNMAPPED",
    index: 501,
    decision: "skip",
    batch_code: "JULY-26-FEED2",
    date: "2026-07-10",
    block_loc: null,
    weight_kg: 5000,
    destination: "MAIN",
    production_batch: "JUL",
    full: {
      kind: "NEW",
      index: 501,
      date: "2026-07-10",
      batch_code: "JULY-26-FEED2",
      batch_id: null,
      destination: "MAIN",
      weight_kg: 5000,
      production_batch: "JUL",
      block_loc: null,
      remarks: null,
      confidence: 1,
    },
    ...over,
  };
}

describe("gsheet apply — UNMAPPED auto-create (RC IN)", () => {
  it("(a) pattern-valid + genuinely new → batch auto-created from the template, row written", async () => {
    const { db, calls } = stubDb();
    const res = await applyFromCompact(compact("rc_in", [unmappedRcIn()]), { db, runTs: "2026-07-11T00:00:00.000Z" });

    expect(res.ok).toBe(true);
    expect(res.inserted).toBe(1);
    expect(res.skipped).toHaveLength(0);
    expect(calls.upsertBatchIfAbsent).toHaveLength(1);
    expect(calls.upsertBatchIfAbsent[0]).toMatchObject({
      batch_code: "JULY-26-BLK6",
      location_ref: "C-11A",
      status: "STORED",
      current_weight: 0,
      avg_cost: null,
    });
    expect(calls.insertDeliveries).toHaveLength(1);
    expect(calls.insertDeliveries[0]).toMatchObject({ batch_code: "JULY-26-BLK6", weight_kg: 20000 });
    // Batch-creation audit log (requirement 3).
    expect(calls.writeIngestionAudit.some((a) => a.tableName === "batches" && a.operation === "INSERT")).toBe(true);
    // The delivery row itself audits via the trigger-stamp path (deliveries has its own trigger).
    expect(calls.stampIngestionAudit).toHaveLength(1);
    // Info finding / run-visibility (requirement 4).
    expect(res.auto_created_batches).toEqual([
      {
        batch_code: "JULY-26-BLK6",
        location_ref: "C-11A",
        mode: "rc_in",
        transaction_date: "2026-07-10",
        block_loc: "C-11A",
        source_row: 1228,
      },
    ]);
  });

  it("(b) pattern-invalid (typo) → still held/unmapped, nothing written, no batch created", async () => {
    const { db, calls } = stubDb();
    const res = await applyFromCompact(
      compact("rc_in", [unmappedRcIn({ batch_code: "BLKZ", full: { ...unmappedRcIn().full!, batch_code: "BLKZ" } as CompactUnmapped["full"] })]),
      { db },
    );

    expect(res.inserted).toBe(0);
    expect(calls.upsertBatchIfAbsent).toHaveLength(0);
    expect(calls.insertDeliveries).toHaveLength(0);
    expect(res.auto_created_batches).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].why).toBe("unmapped left as skip — never auto-create a batch");
    expect(res.skipped[0].held?.kind).toBe("unmapped_batch_code");
  });

  it("(c) alias-of-existing (JUL vs JULY) → resolves via the lookup, no duplicate batch, row still written", async () => {
    // The batch already exists under the FALLBACK alias the classify layer would
    // have resolved to on a later run — but THIS unmapped row named the primary.
    const { db, calls } = stubDb();
    const batchLookup: Record<string, string> = { "JULY-26-BLK6": "existing-batch-id" };
    const res = await applyFromCompact(
      compact("rc_in", [
        unmappedRcIn({
          batch_code: "JUL-26-BLK6",
          full: { ...unmappedRcIn().full!, batch_code: "JUL-26-BLK6" } as CompactUnmapped["full"],
        }),
      ]),
      { db, batchLookup },
    );

    expect(res.inserted).toBe(1);
    expect(calls.upsertBatchIfAbsent).toHaveLength(0); // NO write — resolved from the lookup
    expect(calls.insertDeliveries).toHaveLength(1);
    expect(res.auto_created_batches).toHaveLength(0); // not a CREATE — nothing to announce
    expect(calls.writeIngestionAudit.some((a) => a.tableName === "batches")).toBe(false);
  });
});

describe("gsheet apply — UNMAPPED auto-create (RC OUT)", () => {
  it("(a) pattern-valid + genuinely new FEED batch → auto-created + rc_out row written", async () => {
    const { db, calls } = stubDb();
    const res = await applyFromCompact(compact("rc_out", [unmappedRcOut()]), { db, runTs: "2026-07-11T00:00:00.000Z" });

    expect(res.inserted).toBe(1);
    expect(calls.upsertBatchIfAbsent).toHaveLength(1);
    expect(calls.upsertBatchIfAbsent[0]).toMatchObject({
      batch_code: "JULY-26-FEED2",
      location_ref: "FEED", // no block_loc → the FEED marker (template default)
      avg_cost: null,
    });
    expect(calls.insertRcOut).toHaveLength(1);
    expect(res.auto_created_batches).toHaveLength(1);
    expect(res.auto_created_batches[0].mode).toBe("rc_out");
  });
});

describe("gsheet apply — shared lookup across modes (no cross-mode duplicate)", () => {
  it("a batch auto-created while applying rc_in is visible to rc_out via the shared lookup", async () => {
    const { db, calls } = stubDb();
    const sharedLookup: Record<string, string> = {};

    const rcInRes = await applyFromCompact(compact("rc_in", [unmappedRcIn()]), { db, batchLookup: sharedLookup });
    expect(rcInRes.auto_created_batches).toHaveLength(1);
    expect(calls.upsertBatchIfAbsent).toHaveLength(1);

    // Same batch_code referenced by an rc_out row in the SAME shared lookup.
    const rcOutRes = await applyFromCompact(
      compact("rc_out", [unmappedRcOut({ batch_code: "JULY-26-BLK6", full: { ...unmappedRcOut().full!, batch_code: "JULY-26-BLK6" } as CompactUnmapped["full"] })]),
      { db, batchLookup: sharedLookup },
    );
    expect(rcOutRes.inserted).toBe(1);
    expect(rcOutRes.auto_created_batches).toHaveLength(0); // already existed via the shared lookup
    expect(calls.upsertBatchIfAbsent).toHaveLength(1); // still just the ONE insert
  });
});
