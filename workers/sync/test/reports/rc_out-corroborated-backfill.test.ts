/**
 * rc_out-corroborated-backfill.test.ts — L-049 (2026-09-07).
 *
 * THE INCIDENT THESE PIN. Block D-8A holds `NOV-25-BLK13`. MC's PROPOSED reports of
 * 260903 and 260904 carried a BLOCK DATE cell that derived `NOV-26-BLK13` — a batch that
 * does not exist — so the auto-create policy tried to open a second active batch in an
 * occupied block, the database refused it (23505 on
 * `idx_unique_active_batch_per_location`), and both feedings (8,158 kg and 9,637 kg) were
 * held. MC then corrected the cell; by the time the corrected copy arrived the rc_out
 * watermark had passed those days, so the L-019 sub-watermark guard held the CORRECTED
 * rows too. Meanwhile the RC MOVEMENT audit reported the database short on exactly those
 * two dates by exactly those two amounts.
 *
 * Two rules come out of it, and both are tested here:
 *   1. A below-watermark NEW row a SECOND witness says is missing is APPLIED, not held.
 *   2. A derived code that differs from the block's own occupant only in the YEAR resolves
 *      to the occupant — it never attempts a create the database will refuse.
 */
import { describe, it, expect } from "vitest";

import {
  applyRcOut,
  planSubWatermarkBackfill,
  type BackfillCandidate,
  type RcOutCompact,
  type SubWatermarkWitnesses,
} from "../../src/reports/rc_out/apply.js";
import {
  batchCodeDiffersOnlyByYear,
  splitBatchCode,
} from "../../src/lib/batchCodeAlias.js";
import type { ProposedRow } from "../../src/reports/rc_out/extract.js";
import type { DbClient, Row } from "../../src/lib/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkRow(over: Partial<ProposedRow>): ProposedRow {
  return {
    transaction_date: "2026-09-03",
    whse_label: "D-8A",
    block_loc: "D-8A",
    block_date: "2025-11-01",
    block_no: 13,
    is_feed: false,
    batch_code_primary: "NOV-25-BLK13",
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

const SUB_WATERMARK_REASON =
  "sub-watermark NEW: transaction_date 2026-09-03 <= watermark 2026-09-05 but no DB " +
  "natural-key match. A settled date must not be inserted (suspected duplicate / " +
  "incomplete compare-set). Resolve manually: confirm it is truly missing before any write.";

function candidate(date: string, kg: number, over: Partial<ProposedRow> = {}): BackfillCandidate {
  return {
    index: `${date}-${kg}`,
    row: mkRow({
      transaction_date: date,
      weight_kg: kg,
      day_total_kg: kg,
      batch_id: "bid-nov25-blk13",
      batch_code_resolved: "NOV-25-BLK13",
      ...over,
    }),
  };
}

function witnesses(over: Partial<SubWatermarkWitnesses> = {}): SubWatermarkWitnesses {
  return {
    tolerance_kg: 50,
    // The measured incident: the sheet says 35,299 kg fed, the database holds 27,141 kg.
    movement_kg: { "2026-09-03": 35299, "2026-09-04": 31255 },
    db_kg: { "2026-09-03": 27141, "2026-09-04": 21618 },
    ...over,
  };
}

const never = () => false;

// ---------------------------------------------------------------------------
// 1. The pure decision
// ---------------------------------------------------------------------------

describe("L-049 — planSubWatermarkBackfill (the pure corroboration decision)", () => {
  it("approves the real incident: the sheet is short by exactly what the held row weighs", () => {
    const plan = planSubWatermarkBackfill(
      [candidate("2026-09-03", 8158), candidate("2026-09-04", 9637)],
      witnesses(),
      never,
    );
    expect([...plan.keys()].sort()).toEqual(["2026-09-03", "2026-09-04"]);
    const d = plan.get("2026-09-03")!;
    expect(d.movement_kg).toBe(35299);
    expect(d.db_kg_before).toBe(27141);
    expect(d.gap_kg).toBe(8158);
    expect(d.applied_kg).toBe(8158);
    expect(d.rows).toHaveLength(1);
  });

  it("tests a date's rows AS A GROUP — two rows that together fill the gap are both approved", () => {
    const plan = planSubWatermarkBackfill(
      [candidate("2026-09-03", 3158), candidate("2026-09-03", 5000)],
      witnesses(),
      never,
    );
    expect(plan.get("2026-09-03")?.rows).toHaveLength(2);
    expect(plan.get("2026-09-03")?.applied_kg).toBe(8158);
  });

  it("refuses the whole date when the group does not add up — never a subset (that would be a guess)", () => {
    // 8,158 is the gap; adding a second row makes the group 13,158 and explains nothing.
    const plan = planSubWatermarkBackfill(
      [candidate("2026-09-03", 8158), candidate("2026-09-03", 5000)],
      witnesses(),
      never,
    );
    expect(plan.has("2026-09-03")).toBe(false);
  });

  it("accepts a gap inside the 50 kg tolerance and refuses one just outside it", () => {
    expect(
      planSubWatermarkBackfill([candidate("2026-09-03", 8158 - 50)], witnesses(), never).has(
        "2026-09-03",
      ),
    ).toBe(true);
    expect(
      planSubWatermarkBackfill([candidate("2026-09-03", 8158 - 51)], witnesses(), never).has(
        "2026-09-03",
      ),
    ).toBe(false);
  });

  it("writes NOTHING when there is no second witness at all (no movement report this run)", () => {
    expect(planSubWatermarkBackfill([candidate("2026-09-03", 8158)], null, never).size).toBe(0);
  });

  it("writes NOTHING when the movement sheet has no line for that day — an absent witness is not corroboration", () => {
    const plan = planSubWatermarkBackfill(
      [candidate("2026-09-03", 8158)],
      witnesses({ movement_kg: {} }),
      never,
    );
    expect(plan.size).toBe(0);
  });

  it("writes NOTHING when the database is AHEAD of the sheet — that is the duplication signal, not a hole", () => {
    const plan = planSubWatermarkBackfill(
      [candidate("2026-09-03", 8158)],
      witnesses({ db_kg: { "2026-09-03": 40000 } }),
      never,
    );
    expect(plan.size).toBe(0);
  });

  it("treats a date the database has NO rows for as zero, and still requires the gap to match", () => {
    const plan = planSubWatermarkBackfill(
      [candidate("2026-09-03", 35299)],
      witnesses({ db_kg: {} }),
      never,
    );
    expect(plan.get("2026-09-03")?.gap_kg).toBe(35299);
  });

  it("the GATE still wins — a quarantined date is never backfilled", () => {
    const plan = planSubWatermarkBackfill(
      [candidate("2026-09-03", 8158)],
      witnesses(),
      (d) => d === "2026-09-03",
    );
    expect(plan.has("2026-09-03")).toBe(false);
  });

  it("refuses a date whose group contains a row with no resolved batch_id", () => {
    const rows = [candidate("2026-09-03", 8158)];
    rows[0].row.batch_id = undefined;
    expect(planSubWatermarkBackfill(rows, witnesses(), never).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. applyRcOut end-to-end
// ---------------------------------------------------------------------------

describe("L-049 — applyRcOut writes a corroborated sub-watermark row", () => {
  function mkDb(opts: { alreadyPresent?: boolean; onInsert?: (rows: Row[]) => void } = {}): DbClient {
    const stub: Partial<DbClient> = {
      insertIfAbsent: async (_table, rows) => {
        opts.onInsert?.(rows);
        if (opts.alreadyPresent) {
          return { inserted: [], skipped: rows, insertedCount: 0, skippedCount: rows.length };
        }
        return {
          inserted: [{ ...rows[0], id: "NEW-1" }],
          skipped: [],
          insertedCount: 1,
          skippedCount: 0,
        };
      },
      update: async () => [],
      writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
      upsertIngestionWatermark: async () => true,
    };
    return stub as DbClient;
  }

  function compactWith(
    flagged: Array<{ index: unknown; reason?: string; row: ProposedRow }>,
    over: Partial<RcOutCompact> = {},
  ): RcOutCompact {
    return {
      report_type: "rc_out",
      since: "2026-09-02",
      watermark: "2026-09-05",
      gate_failures: [],
      quarantined_dates: [],
      sub_watermark_witnesses: witnesses(),
      source: { email_subject: null, email_uid: 1, email_thread_id: null },
      actionable: { new: [], changed: [], flagged, unmapped: [], malformed: [] },
      batch_lookup: {},
      ...over,
    };
  }

  const flaggedRow = (kg: number, date = "2026-09-03") => ({
    index: 12,
    reason: SUB_WATERMARK_REASON,
    row: candidate(date, kg).row,
  });

  it("applies it, reports it as a note, and does NOT hold it", async () => {
    const inserted: Row[] = [];
    const res = await applyRcOut(compactWith([flaggedRow(8158)]), {
      db: mkDb({ onInsert: (rows) => inserted.push(rows[0]) }),
    });

    expect(res.inserts).toBe(1);
    expect(inserted[0].transaction_date).toBe("2026-09-03");
    expect(inserted[0].weight_kg).toBe(8158);
    expect(res.held).toHaveLength(0);
    expect(res.rc_out_backfills).toHaveLength(1);
    expect(res.rc_out_backfills[0]).toMatchObject({
      transaction_date: "2026-09-03",
      batch_code: "NOV-25-BLK13",
      block_loc: "D-8A",
      weight_kg: 8158,
      movement_kg: 35299,
      db_kg_before: 27141,
      gap_kg: 8158,
      applied_row_count: 1,
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("keeps HOLDING a sub-watermark row the witnesses do not corroborate", async () => {
    const res = await applyRcOut(
      compactWith([flaggedRow(8158)], { sub_watermark_witnesses: witnesses({ movement_kg: {} }) }),
      { db: mkDb() },
    );
    expect(res.inserts).toBe(0);
    expect(res.rc_out_backfills).toEqual([]);
    expect(res.held).toHaveLength(1);
    expect(res.held[0].kind).toBe("sub_watermark_suspected_dup");
  });

  it("is idempotent — the natural key already in the DB is an `already_exists` hold, never a second row", async () => {
    const res = await applyRcOut(compactWith([flaggedRow(8158)]), {
      db: mkDb({ alreadyPresent: true }),
    });
    expect(res.inserts).toBe(0);
    expect(res.rc_out_backfills).toEqual([]);
    expect(res.held).toHaveLength(1);
    expect(res.held[0].kind).toBe("already_exists");
  });

  it("a NON-sub-watermark flagged row (L-037 balance integrity) is untouched by any of this", async () => {
    const res = await applyRcOut(
      compactWith([
        {
          index: 4,
          reason: "block balance integrity: STRT 1 - END 2 = -1 kg but DAY TOTAL = 8158 kg",
          row: candidate("2026-09-03", 8158).row,
        },
      ]),
      { db: mkDb() },
    );
    expect(res.inserts).toBe(0);
    expect(res.held).toHaveLength(1);
    expect(res.held[0].kind).toBe("flagged");
  });
});

// ---------------------------------------------------------------------------
// 3. The year-alias predicate
// ---------------------------------------------------------------------------

describe("L-049 — batchCodeDiffersOnlyByYear", () => {
  it("splits a batch code into month / year / suffix", () => {
    expect(splitBatchCode("nov-26-blk13")).toEqual({ month: "NOV", year: "26", suffix: "BLK13" });
    expect(splitBatchCode("FEEDING # 1")).toBeNull();
    expect(splitBatchCode(null)).toBeNull();
  });

  it("says YES to the incident's pair", () => {
    expect(batchCodeDiffersOnlyByYear("NOV-26-BLK13", "NOV-25-BLK13")).toBe(true);
    expect(batchCodeDiffersOnlyByYear("NOV-25-BLK13", "NOV-26-BLK13")).toBe(true);
  });

  it("allows a month-prefix ALIAS on top of the year (the ONE alias table, not a new one)", () => {
    expect(batchCodeDiffersOnlyByYear("NOV-26-BLK13", "NOVEMBER-25-BLK13")).toBe(true);
  });

  it("says NO to a different MONTH — the L-033 phantom stays a real disagreement", () => {
    expect(batchCodeDiffersOnlyByYear("JULY-26-BLK9", "JUNE-25-BLK9")).toBe(false);
  });

  it("says NO to a different block number, and NO to the SAME year", () => {
    expect(batchCodeDiffersOnlyByYear("NOV-26-BLK13", "NOV-25-BLK14")).toBe(false);
    expect(batchCodeDiffersOnlyByYear("NOV-25-BLK13", "NOV-25-BLK13")).toBe(false);
  });

  it("says NO to a different KIND (a FEED batch is not a BLK batch)", () => {
    expect(batchCodeDiffersOnlyByYear("NOV-26-FEED1", "NOV-25-BLK1")).toBe(false);
  });

  it("says NO when either side is not a batch code at all", () => {
    expect(batchCodeDiffersOnlyByYear("FEEDING # 1", "NOV-25-BLK13")).toBe(false);
  });
});
