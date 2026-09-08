/**
 * rc_out-year-alias.test.ts — L-049 part 4 (2026-09-07), end-to-end through `applyRcOut`.
 *
 * THE INCIDENT. Block D-8A holds `NOV-25-BLK13`. MC's BLOCK DATE cell on the 260903/260904
 * PROPOSED reports read `2026-11-01`, so the extractor derived `NOV-26-BLK13`, the
 * auto-create policy tried to open a SECOND active batch in an occupied block, and the
 * database refused it (23505 on `idx_unique_active_batch_per_location`). The row was held
 * for four days behind a raw Postgres error.
 *
 * The rule: when the derived code differs from the block's own ACTIVE occupant ONLY in the
 * two-digit year, AND the derived code's month is in the FUTURE relative to the row's own
 * date (a pile cannot be fed before it exists) while the occupant's is not, the row is
 * filed against the occupant. Nothing is created, and the identity call is REPORTED.
 *
 * The future-month condition is what keeps a GENUINE year rollover — a new `JAN-26-BLK5`
 * arriving in January 2026 at a block still holding `JAN-25-BLK5` — on the old path: a
 * `batch_location_conflict` hold naming both sides, which is the right answer for "close
 * the old block first".
 */
import { describe, it, expect } from "vitest";

import { applyRcOut, type RcOutCompact } from "../../src/reports/rc_out/apply.js";
import type { ProposedRow } from "../../src/reports/rc_out/extract.js";
import type { DbClient, Row } from "../../src/lib/db.js";

function mkRow(over: Partial<ProposedRow>): ProposedRow {
  return {
    transaction_date: "2026-09-03",
    whse_label: "D-8A",
    block_loc: "D-8A",
    block_date: "2026-11-01", // the mistyped cell
    block_no: 13,
    is_feed: false,
    batch_code_primary: "NOV-26-BLK13",
    batch_code_fallbacks: [],
    supplier: null,
    strt_bal_kg: null,
    day_total_kg: 8158,
    end_bal_kg: null,
    weight_kg: 8158,
    destination: "MAIN",
    production_batch: "SEP",
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

/**
 * A stub whose `batches` table has ONE active occupant at D-8A. `upsertBatchIfAbsent`
 * throws the real 23505 the live index raises, so a test that reaches it is a test that
 * would have reproduced the incident.
 */
function mkDb(occupant: { batch_code: string; status?: string; current_weight?: number } | null) {
  const calls = {
    upsertBatchIfAbsent: [] as Array<Record<string, unknown>>,
    insertedRcOut: [] as Row[],
  };
  const db: Partial<DbClient> = {
    readRows: async (table: string, opts) => {
      if (table === "batches") {
        if (!occupant) return [];
        return [
          {
            id: "bid-occupant",
            batch_code: occupant.batch_code,
            status: occupant.status ?? "IN-USE",
            current_weight: occupant.current_weight ?? 61234,
          },
        ];
      }
      if (table === "rc_out") return [{ transaction_date: "2026-09-01" }];
      void opts;
      return [];
    },
    upsertBatchIfAbsent: async (row: Row) => {
      calls.upsertBatchIfAbsent.push(row);
      throw new Error(
        'upsert_batch_if_absent batches failed 23505: duplicate key value violates unique ' +
          'constraint "idx_unique_active_batch_per_location"',
      );
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
    writeIngestionAudit: async () => ({ id: "audit-1" }),
    upsertIngestionWatermark: async () => true,
  };
  return { db: db as DbClient, calls };
}

function compactWith(
  row: ProposedRow,
  batchLookup: Record<string, string>,
  over: Partial<RcOutCompact> = {},
): RcOutCompact {
  return {
    report_type: "rc_out",
    since: "2026-09-01",
    watermark: null,
    gate_failures: [],
    quarantined_dates: [],
    source: { email_subject: null, email_uid: 1, email_thread_id: null },
    actionable: {
      new: [],
      changed: [],
      flagged: [],
      unmapped: [{ index: 12, reason: "No batch_id found", row }],
      malformed: [],
    },
    batch_lookup: batchLookup,
    ...over,
  };
}

describe("L-049 — a wrong-YEAR derived code resolves to the block's occupant", () => {
  it("files the feeding against NOV-25-BLK13, creates NOTHING, and reports the call", async () => {
    const { db, calls } = mkDb({ batch_code: "NOV-25-BLK13", current_weight: 61234 });
    const res = await applyRcOut(
      compactWith(mkRow({}), { "NOV-25-BLK13": "bid-occupant" }),
      { db },
    );

    // Nothing was created — the create the database would have refused never happened.
    expect(calls.upsertBatchIfAbsent).toEqual([]);
    expect(res.auto_created_batches).toEqual([]);

    // The feeding was written, against the pile that is actually in the block.
    expect(res.inserts).toBe(1);
    expect(calls.insertedRcOut[0].batch_id).toBe("bid-occupant");
    expect(calls.insertedRcOut[0].weight_kg).toBe(8158);
    expect(res.held).toEqual([]);
    expect(res.errors).toEqual([]);

    // …and the identity call is on the record, naming BOTH codes.
    expect(res.batch_alias_notes).toHaveLength(1);
    expect(res.batch_alias_notes[0]).toMatchObject({
      kind: "year_alias_of_block_occupant",
      derived_batch_code: "NOV-26-BLK13",
      resolved_batch_code: "NOV-25-BLK13",
      block_loc: "D-8A",
      occupying_status: "IN-USE",
      occupying_balance_kg: 61234,
      transaction_date: "2026-09-03",
    });
  });

  it("a GENUINE year rollover (derived month == the row's own month) keeps today's behaviour: a conflict hold", async () => {
    const { db, calls } = mkDb({ batch_code: "JAN-25-BLK5" });
    const row = mkRow({
      transaction_date: "2026-01-15",
      block_date: "2026-01-01",
      block_no: 5,
      batch_code_primary: "JAN-26-BLK5",
      whse_label: "A-1A",
      block_loc: "A-1A",
    });
    const res = await applyRcOut(compactWith(row, { "JAN-25-BLK5": "bid-occupant" }), { db });

    // It DID attempt the create — and the refusal became a held row, both sides named.
    expect(calls.upsertBatchIfAbsent).toHaveLength(1);
    expect(res.batch_alias_notes).toEqual([]);
    expect(res.inserts).toBe(0);
    expect(res.held).toHaveLength(1);
    expect(res.held[0].kind).toBe("batch_location_conflict");
    expect(res.held[0].row?.occupying_batch_code).toBe("JAN-25-BLK5");
  });

  it("a DIFFERENT month in the block is never re-pointed — it attempts the create as before", async () => {
    const { db, calls } = mkDb({ batch_code: "AUG-25-BLK13" });
    const res = await applyRcOut(
      compactWith(mkRow({}), { "AUG-25-BLK13": "bid-occupant" }),
      { db },
    );
    expect(calls.upsertBatchIfAbsent).toHaveLength(1);
    expect(res.batch_alias_notes).toEqual([]);
    expect(res.held[0].kind).toBe("batch_location_conflict");
  });

  it("an EMPTY block is never re-pointed — the create proceeds exactly as before", async () => {
    const { db, calls } = mkDb(null);
    const res = await applyRcOut(compactWith(mkRow({}), {}), { db });
    expect(calls.upsertBatchIfAbsent).toHaveLength(1);
    expect(res.batch_alias_notes).toEqual([]);
  });

  it("a CLOSED occupant is never re-pointed — the index only covers active batches", async () => {
    const { db, calls } = mkDb({ batch_code: "NOV-25-BLK13", status: "CLOSED" });
    const res = await applyRcOut(
      compactWith(mkRow({}), { "NOV-25-BLK13": "bid-occupant" }),
      { db },
    );
    expect(calls.upsertBatchIfAbsent).toHaveLength(1);
    expect(res.batch_alias_notes).toEqual([]);
  });

  it("a QUARANTINED date is never written, alias or not — the gate still wins", async () => {
    const { db, calls } = mkDb({ batch_code: "NOV-25-BLK13" });
    const res = await applyRcOut(
      compactWith(mkRow({}), { "NOV-25-BLK13": "bid-occupant" }, {
        quarantined_dates: [
          {
            date: "2026-09-03",
            gate: "db_vs_movement_duplication",
            detail: { date: "2026-09-03", db_sum_kg: 2000, movement_kg: 1000, excess_kg: 1000 },
          },
        ],
      }),
      { db },
    );
    expect(calls.upsertBatchIfAbsent).toEqual([]);
    expect(calls.insertedRcOut).toEqual([]);
    expect(res.batch_alias_notes).toEqual([]);
    expect(res.held[0].kind).toBe("unmapped_batch_code");
  });
});
