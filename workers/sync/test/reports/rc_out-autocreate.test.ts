/**
 * rc_out-autocreate.test.ts — integration tests for the 2026-07-11 batch
 * auto-create policy wired into rc_out/apply.ts's UNMAPPED bucket (the PROPOSED
 * DAILY REPORT lane). Locks the three required scenarios end-to-end through
 * `applyRcOut`:
 *   (a) pattern-valid + genuinely new  → batch created (template) + row written.
 *   (b) pattern-invalid (typo)         → still held/unmapped, nothing written.
 *   (c) alias-of-existing              → resolves, no duplicate batch, row written.
 * Plus: quarantine still wins over auto-create (a gated date is never written).
 *
 * Ground truth: apply.ts's UNMAPPED loop + lib/batchAutoCreate.ts.
 */
import { describe, it, expect } from "vitest";

import { applyRcOut, type RcOutCompact, type QuarantinedDate } from "../../src/reports/rc_out/apply.js";
import type { ProposedRow } from "../../src/reports/rc_out/extract.js";
import type { DbClient, Row } from "../../src/lib/db.js";

function mkRow(over: Partial<ProposedRow>): ProposedRow {
  return {
    transaction_date: "2026-07-10",
    whse_label: "FEEDING AREA",
    block_loc: null,
    block_date: "2026-07-10",
    block_no: 2,
    is_feed: true,
    batch_code_primary: "JULY-26-FEED2",
    batch_code_fallbacks: [],
    supplier: null,
    strt_bal_kg: null,
    day_total_kg: 5000,
    end_bal_kg: null,
    weight_kg: 5000,
    destination: "MAIN",
    production_batch: "JUL",
    remarks: null,
    operator_status: null,
    operator_remarks_raw: null,
    pallets_gross: [],
    pallets_count: [],
    pallets_net: [],
    pallet_count: 0,
    is_closing: false,
    warnings: [],
    confidence: 1,
    _source_row: 12,
    ...over,
  };
}

function mkDb(opts: { existingBatches?: Record<string, string> } = {}) {
  const batches = { ...(opts.existingBatches ?? {}) };
  let nextId = 1;
  const calls = {
    upsertBatchIfAbsent: [] as Array<Record<string, unknown>>,
    insertedRcOut: [] as Row[],
    writeIngestionAudit: [] as Array<{ tableName: string; recordId: string; operation: string }>,
  };
  const db: Partial<DbClient> = {
    upsertBatchIfAbsent: async (row: Row) => {
      calls.upsertBatchIfAbsent.push(row);
      const code = String(row.batch_code);
      if (code in batches) return { id: batches[code], batch_code: code, created: false };
      const id = `batch-${nextId++}`;
      batches[code] = id;
      return { id, batch_code: code, created: true };
    },
    insertIfAbsent: async (table, rows) => {
      if (table === "rc_out") calls.insertedRcOut.push(rows[0]);
      return {
        inserted: [{ ...rows[0], id: `rcout-${calls.insertedRcOut.length}` }],
        skipped: [],
        insertedCount: 1,
        skippedCount: 0,
      };
    },
    update: async () => [],
    writeIngestionAudit: async (args) => {
      calls.writeIngestionAudit.push(args);
      return { id: "audit-1" };
    },
    upsertIngestionWatermark: async () => true,
  };
  return { db: db as DbClient, calls };
}

function baseCompact(over: Partial<RcOutCompact> = {}): RcOutCompact {
  return {
    report_type: "rc_out",
    since: "2026-07-01",
    watermark: null,
    gate_failures: [],
    quarantined_dates: [],
    source: { email_subject: null, email_uid: 1, email_thread_id: null },
    actionable: { new: [], changed: [], flagged: [], unmapped: [], malformed: [] },
    batch_lookup: {},
    ...over,
  };
}

function unmappedItem(row: ProposedRow, index: unknown = "idx-1"): { index: unknown; row: ProposedRow } {
  return { index, row };
}

describe("rc_out apply — UNMAPPED auto-create (PROPOSED DAILY REPORT)", () => {
  it("(a) pattern-valid + genuinely new FEED batch → auto-created from the template, row written", async () => {
    const { db, calls } = mkDb();
    const compact = baseCompact({
      actionable: { new: [], changed: [], flagged: [], unmapped: [unmappedItem(mkRow({}), 1228)], malformed: [] },
    });

    const res = await applyRcOut(compact, { db, runTs: "2026-07-11T00:00:00.000Z" });

    expect(res.ok).toBe(true);
    expect(res.inserts).toBe(1);
    expect(res.held.filter((h) => h.kind === "unmapped_batch_code")).toHaveLength(0);
    expect(calls.upsertBatchIfAbsent).toHaveLength(1);
    expect(calls.upsertBatchIfAbsent[0]).toMatchObject({
      batch_code: "JULY-26-FEED2",
      location_ref: "FEED", // no block_loc (a FEED row) → the template's FEED marker
      status: "STORED",
      current_weight: 0,
      avg_cost: null,
    });
    expect(calls.insertedRcOut).toHaveLength(1);
    expect(calls.insertedRcOut[0]).toMatchObject({ weight_kg: 5000, destination: "MAIN" });
    // Batch-creation audit log (requirement 3).
    expect(calls.writeIngestionAudit.some((a) => a.tableName === "batches" && a.operation === "INSERT")).toBe(true);
    expect(calls.writeIngestionAudit.some((a) => a.tableName === "rc_out" && a.operation === "INSERT")).toBe(true);
    // Info finding / run-visibility (requirement 4).
    expect(res.auto_created_batches).toEqual([
      {
        batch_code: "JULY-26-FEED2",
        location_ref: "FEED",
        transaction_date: "2026-07-10",
        block_loc: null,
        source_row: 1228,
      },
    ]);
  });

  it("(b) pattern-invalid (typo) → still held/unmapped, nothing written, no batch created", async () => {
    const { db, calls } = mkDb();
    const row = mkRow({ batch_code_primary: "BLKZ", batch_code_fallbacks: [] });
    const compact = baseCompact({
      actionable: { new: [], changed: [], flagged: [], unmapped: [unmappedItem(row)], malformed: [] },
    });

    const res = await applyRcOut(compact, { db });

    expect(res.inserts).toBe(0);
    expect(calls.upsertBatchIfAbsent).toHaveLength(0);
    expect(calls.insertedRcOut).toHaveLength(0);
    expect(res.auto_created_batches).toHaveLength(0);
    expect(res.held).toHaveLength(1);
    expect(res.held[0].kind).toBe("unmapped_batch_code");
    expect(res.held[0].reason).toBe("unmapped_batch_code");
  });

  it("(c) alias-of-existing (JUL vs JULY) → resolves via batch_lookup, no duplicate batch, row still written", async () => {
    const { db, calls } = mkDb();
    // The physical batch already exists under a different month-prefix convention.
    const row = mkRow({ batch_code_primary: "JUL-26-BLK9", batch_code_fallbacks: ["JULY-26-BLK9"], is_feed: false, block_loc: "C-9A" });
    const compact = baseCompact({
      batch_lookup: { "JULY-26-BLK9": "existing-batch-id" },
      actionable: { new: [], changed: [], flagged: [], unmapped: [unmappedItem(row)], malformed: [] },
    });

    const res = await applyRcOut(compact, { db });

    expect(res.inserts).toBe(1);
    expect(calls.upsertBatchIfAbsent).toHaveLength(0); // resolved from batch_lookup — no DB write
    expect(calls.insertedRcOut).toHaveLength(1);
    expect(calls.insertedRcOut[0]).toMatchObject({ batch_id: "existing-batch-id" });
    expect(res.auto_created_batches).toHaveLength(0); // not a create — nothing to announce
  });

  it("a quarantined date is NEVER auto-created-and-written — the gate still wins", async () => {
    const { db, calls } = mkDb();
    const q: QuarantinedDate = {
      date: "2026-07-10",
      gate: "proposed_vs_movement_drift_500kg",
      detail: { date: "2026-07-10", proposed_kg: 9000, movement_kg: 1000, diff_kg: 8000 },
    };
    const compact = baseCompact({
      quarantined_dates: [q],
      actionable: { new: [], changed: [], flagged: [], unmapped: [unmappedItem(mkRow({}))], malformed: [] },
    });

    const res = await applyRcOut(compact, { db });

    expect(res.inserts).toBe(0);
    expect(calls.upsertBatchIfAbsent).toHaveLength(0);
    expect(calls.insertedRcOut).toHaveLength(0);
    expect(res.auto_created_batches).toHaveLength(0);
    const gateHolds = res.held.filter((h) => h.kind === "gate_failure");
    expect(gateHolds).toHaveLength(1);
  });
});
