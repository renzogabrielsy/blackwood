/**
 * gsheetCloseScan.test.ts — unit tests for the PURE gsheet batch close-scan planner
 * (src/lib/gsheetCloseScan.ts). Locks:
 *   - only closing-remark rows are considered,
 *   - primary → fallback batch_code resolution,
 *   - already-CLOSED batches are silent no-ops (not re-planned),
 *   - a closing remark on an unknown batch_code becomes an `unmatched` warning (never a throw),
 *   - de-dup: multiple closing rows for the same batch produce ONE close,
 *   - the channel projection (`toChannelBatchCloses`) shape.
 */
import { describe, it, expect } from "vitest";
import {
  planGsheetCloses,
  toChannelBatchCloses,
  type GsheetRcOutRowLike,
  type BatchDirEntry,
} from "../../src/lib/gsheetCloseScan.js";

const dir: Record<string, BatchDirEntry> = {
  "AUG-25-BLK2": { id: "id-blk2", status: "IN-USE", location_ref: "C-12A" },
  "JULY-26-BLK1": { id: "id-blk1", status: "IN-USE", location_ref: "A-1A" },
  "MAR-26-BLK5": { id: "id-blk5", status: "IN-USE", location_ref: "B-5A" },
  "JUNE-26-FEED1": { id: "id-feed1", status: "CLOSED", location_ref: "FEED" },
};

function row(p: Partial<GsheetRcOutRowLike>): GsheetRcOutRowLike {
  return { transaction_date: "2026-07-08", destination: "MAIN", ...p } as GsheetRcOutRowLike;
}

describe("planGsheetCloses", () => {
  it("plans a close for a closing remark on an IN-USE batch (the C-12A / AUG-25-BLK2 case)", () => {
    const plan = planGsheetCloses(
      [row({ batch_code_primary: "AUG-25-BLK2", block_loc: "C-12A", remarks: "CLOSED", _source_row: 42 })],
      dir,
    );
    expect(plan.closes).toHaveLength(1);
    expect(plan.closes[0]).toMatchObject({
      batch_id: "id-blk2",
      batch_code: "AUG-25-BLK2",
      block_loc: "C-12A",
      transaction_date: "2026-07-08",
      source_row: 42,
    });
    expect(plan.unmatched).toHaveLength(0);
  });

  it("ignores rows without a closing remark", () => {
    const plan = planGsheetCloses(
      [
        row({ batch_code_primary: "JULY-26-BLK1", remarks: "FOR FEEDING" }),
        row({ batch_code_primary: "JULY-26-BLK1", remarks: null }),
        row({ batch_code_primary: "JULY-26-BLK1", remarks: "NOT CLOSED YET" }),
      ],
      dir,
    );
    expect(plan.closes).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(0);
  });

  it("resolves via a fallback code when the primary is not in the directory", () => {
    // primary "MARCH-26-BLK5" is absent; fallback "MAR-26-BLK5" matches.
    const plan = planGsheetCloses(
      [
        row({
          batch_code_primary: "MARCH-26-BLK5",
          batch_code_fallbacks: ["MAR-26-BLK5"],
          remarks: "DONE FEEDING",
        }),
      ],
      dir,
    );
    expect(plan.closes).toHaveLength(1);
    expect(plan.closes[0].batch_id).toBe("id-blk5");
    expect(plan.closes[0].batch_code).toBe("MAR-26-BLK5");
    expect(plan.closes[0].requested_code).toBe("MARCH-26-BLK5");
  });

  it("counts an already-CLOSED batch as a silent no-op, not a close", () => {
    const plan = planGsheetCloses(
      [row({ batch_code_primary: "JUNE-26-FEED1", remarks: "CLOSED" })],
      dir,
    );
    expect(plan.closes).toHaveLength(0);
    expect(plan.alreadyClosed).toBe(1);
    expect(plan.unmatched).toHaveLength(0);
  });

  it("flags a closing remark on an unknown batch_code as unmatched (never throws)", () => {
    const plan = planGsheetCloses(
      [row({ batch_code_primary: "DEC-26-BLK9", block_loc: "D-9A", remarks: "DONE", _source_row: 7 })],
      dir,
    );
    expect(plan.closes).toHaveLength(0);
    expect(plan.unmatched).toEqual([
      { requested_code: "DEC-26-BLK9", transaction_date: "2026-07-08", block_loc: "D-9A", source_row: 7 },
    ]);
  });

  it("de-dups multiple closing rows for the same batch into ONE close", () => {
    const plan = planGsheetCloses(
      [
        row({ batch_code_primary: "AUG-25-BLK2", remarks: "CLOSED", _source_row: 1 }),
        row({ batch_code_primary: "AUG-25-BLK2", remarks: "DONE", _source_row: 2, transaction_date: "2026-07-09" }),
      ],
      dir,
    );
    expect(plan.closes).toHaveLength(1);
    expect(plan.closes[0].source_row).toBe(1); // first close wins
  });
});

describe("toChannelBatchCloses", () => {
  it("projects closes (matched) then unmatched (unmatched) with no ₱ fields", () => {
    const plan = planGsheetCloses(
      [
        row({ batch_code_primary: "AUG-25-BLK2", block_loc: "C-12A", remarks: "CLOSED", _source_row: 42 }),
        row({ batch_code_primary: "DEC-26-BLK9", block_loc: "D-9A", remarks: "DONE", _source_row: 7 }),
      ],
      dir,
    );
    const channel = toChannelBatchCloses(plan);
    expect(channel).toEqual([
      {
        batch_code: "AUG-25-BLK2",
        location_ref: "C-12A",
        transaction_date: "2026-07-08",
        block_loc: "C-12A",
        source_row: 42,
        matched: true,
      },
      {
        batch_code: "DEC-26-BLK9",
        location_ref: null,
        transaction_date: "2026-07-08",
        block_loc: "D-9A",
        source_row: 7,
        matched: false,
      },
    ]);
  });
});
