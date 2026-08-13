/**
 * deliveries-feeding-label.test.ts — L-042 (2026-08-13). Two changes, one lesson:
 * AN OPERATOR'S SHORTHAND IS A NAMING CONVENTION TO BE LEARNED, NOT MALFORMED INPUT.
 *
 * Every row here is REAL, read out of `public.deliveries` / `public.batches` on 2026-08-13:
 *
 *   - 2026-08-05 / AAV 6111 / Tag-at / 517 sacks / 19,185 kg — MC's email says
 *     `FEEDING # 1`; the DB holds it as `AUG-26-FEED1` (id 1a6dec84-…) because the Google
 *     Sheet path wrote it. THE headline case: it had been held for a week.
 *   - 2026-08-12 / KCA 378 / Tag-at / 516 sacks / 18,650 kg — MC's email says
 *     `FEEDING # 2`, and the DB holds `batch_code = 'FEEDING # 2'` verbatim, with a matching
 *     junk row in `batches` (created 2026-07-21, carrying 18,650 kg of phantom weight).
 *     That one is a REAL disagreement and must stay held.
 *   - the feed batches actually in `batches`: `AUG-26-FEED1`, `AUG-26-FEED2`,
 *     `JULY-26-FEED1/2`, `JUNE-26-FEED1..7`, `FEB-26-FEED1..11` — i.e. the live convention
 *     for August feed is `AUG-`, while August BLOCKS are `AUGUST-26-BLK1/2/5`. Both
 *     conventions are live, which is precisely why the alias table exists.
 */
import { describe, it, expect } from "vitest";

import {
  batchCodeAliasEqual,
  batchCodeSpellings,
  resolveKnownBatchCodeAlias,
} from "../../src/lib/batchCodeAlias.js";
import { translateBatchCode, type DeliveryRow, type ExtractResult } from "../../src/reports/deliveries/extract.js";
import {
  applyDeliveriesGuard,
  classifyDeliveries,
  isAwaitingBatchAssignment,
  type DeliveriesDbRow,
} from "../../src/reports/deliveries/classify.js";
import { applyDeliveries, type DeliveriesCompact } from "../../src/reports/deliveries/apply.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function mkRow(over: Partial<DeliveryRow>): DeliveryRow {
  return {
    transaction_date: "2026-08-05",
    supplier: "Tag-at",
    batch_code: null,
    operator_batch_label: null,
    block_loc: null,
    truck_plate: "AAV 6111",
    sacks: 517,
    weight_kg: 19185,
    cost_basis: null,
    remarks: null,
    lab_results: null,
    true_weight_kg: null,
    deduction_note: null,
    warnings: [],
    confidence: 1,
    _source_row: 12,
    ...over,
  };
}

function mkExtract(rows: DeliveryRow[]): ExtractResult {
  return {
    filename: "RC DELIVERIES 2026.xlsx",
    sheets_processed: ["AUGUST 2026"],
    rows,
    summary: {
      total_rows: rows.length,
      extraction_warnings: [],
      overall_confidence: 1,
      unmapped_batches: [],
    },
  };
}

/** The real 2026-08-05 DB row (`deliveries.id = 1a6dec84-5c76-49ad-807b-9d40bf5fc9c7`). */
const DB_AUG05_FEED1: DeliveriesDbRow = {
  id: "1a6dec84-5c76-49ad-807b-9d40bf5fc9c7",
  transaction_date: "2026-08-05",
  supplier: "Tag-at",
  batch_code: "AUG-26-FEED1",
  block_loc: null,
  truck_plate: "AAV 6111",
  sacks: 517,
  weight_kg: 19185,
  cost_basis: 0,
  remarks: null,
  lab_results: { fc: 83.46, mc: 11.2, vm: 13.35, ash: 3.19, grit: 3.1, bd_jis: 0.595, bd_astm: 0.575 },
};

/** The real 2026-08-12 DB row, which carries the RAW LABEL as its batch_code. */
const DB_AUG12_RAWLABEL: DeliveriesDbRow = {
  id: "046e38e3-bc43-48b9-9ff8-3761e1017c41",
  transaction_date: "2026-08-12",
  supplier: "Tag-at",
  batch_code: "FEEDING # 2",
  block_loc: null,
  truck_plate: "KCA 378",
  sacks: 516,
  weight_kg: 18650,
  cost_basis: 0,
  remarks: "FEED",
  lab_results: { fc: 83.83, mc: 11.27, vm: 13.67, ash: 2.5, grit: 2.43, bd_jis: 0.598, bd_astm: 0.578 },
};

/** The feed batch codes actually present in `batches` (2026-08-13). */
const LIVE_FEED_BATCH_CODES = new Set([
  "AUG-26-FEED1",
  "AUG-26-FEED2",
  "JULY-26-FEED1",
  "JULY-26-FEED2",
  "JUNE-26-FEED1",
  "FEB-26-FEED1",
  "AUGUST-26-BLK1",
  "AUGUST-26-BLK2",
  "FEEDING # 1",
  "FEEDING # 2",
]);

// ===========================================================================
// CHANGE 1a — the label translates, and to EXACTLY the existing output shape
// ===========================================================================
describe("L-042 — the operator's FEEDING shorthand translates like FEEDING AREA", () => {
  it("`FEEDING # N` produces the SAME code as `FEEDING AREA N` (no new output format)", () => {
    for (const n of [1, 2, 3]) {
      const area = translateBatchCode(`FEEDING AREA ${n}`, null, "2026-08-05");
      const hash = translateBatchCode(`FEEDING # ${n}`, null, "2026-08-05");
      expect(hash).toEqual(area);
      expect(hash[0]).toBe(`AUGUST-26-FEED${n}`);
      expect(hash[1]).toEqual([]);
    }
  });

  it("accepts the neighbouring spellings that plausibly appear", () => {
    const expected = ["AUGUST-26-FEED2", []];
    for (const label of [
      "FEEDING AREA 2",
      "FEEDING # 2",
      "FEEDING #2",
      "FEEDING NO. 2",
      "FEEDING NO 2",
      "FEEDING 2",
      "FEEDING AREA #2",
      "FEEDING AREA 2.",
      "feeding # 2",
      "  FEEDING # 2  ",
    ]) {
      expect(translateBatchCode(label, null, "2026-08-05"), label).toEqual(expected);
    }
  });

  it("a NUMBERLESS feeding label keeps the pre-existing needs-mapping behaviour", () => {
    for (const label of ["FEEDING", "FEEDING AREA"]) {
      const [code, warnings] = translateBatchCode(label, null, "2026-08-05");
      expect(code).toBe(label); // raw label, exactly as before
      expect(warnings.join(" ")).toContain("could not be auto-numbered");
    }
  });

  it("STILL REJECTS things that are not a feeding label", () => {
    for (const label of [
      "FEEDING AREA A", // a letter is not an area number
      "FEEDING AREA 1 AND 2", // two areas is not one batch
      "RE-FEEDING 1", // REFEED is its own batch family (MARCH-26-REFEED1)
      "FEEDINGS 2",
      "FEED", // there is a batch literally named FEED; do not reinterpret it
      "SUNDRY FEEDING 1",
    ]) {
      const [code, warnings] = translateBatchCode(label, null, "2026-08-05");
      expect(code, label).toBe(label.trim());
      expect(warnings.join(" "), label).toContain("Could not map operator batch label");
    }
  });

  it("the label does not hijack a `B<N>` row or a PILED-IN remark row", () => {
    expect(translateBatchCode("B09", null, "2026-08-05")[0]).toBe("AUGUST-26-BLK9");
    expect(translateBatchCode("B09", "PILED IN JULY # 11", "2026-08-05")[0]).toBe("JULY-26-BLK11");
  });
});

// ===========================================================================
// CHANGE 1b — the month-prefix alias, and the trap it defuses
// ===========================================================================
describe("L-042 — a month-prefix alias is not a disagreement", () => {
  it("collapses AUGUST <-> AUG (both directions) and every other table pair", () => {
    expect(batchCodeAliasEqual("AUGUST-26-FEED1", "AUG-26-FEED1")).toBe(true);
    expect(batchCodeAliasEqual("AUG-26-FEED1", "AUGUST-26-FEED1")).toBe(true);
    expect(batchCodeAliasEqual("FEBRUARY-26-FEED1", "FEB-26-FEED1")).toBe(true);
    expect(batchCodeAliasEqual("MARCH-26-BLK6", "MAR-26-BLK6")).toBe(true);
    expect(batchCodeSpellings("AUGUST-26-FEED1")).toEqual(["AUGUST-26-FEED1", "AUG-26-FEED1"]);
  });

  it("does NOT collapse a different MONTH, a different year or a different suffix", () => {
    // The L-033 month-boundary phantom — both deliveries parity fixtures turn on this pair.
    expect(batchCodeAliasEqual("JULY-26-BLK9", "JUNE-26-BLK9")).toBe(false);
    expect(batchCodeAliasEqual("AUG-26-FEED1", "AUG-25-FEED1")).toBe(false);
    expect(batchCodeAliasEqual("AUG-26-FEED1", "AUG-26-FEED2")).toBe(false);
    expect(batchCodeAliasEqual("AUG-26-FEED1", "AUGUST-26-BLK1")).toBe(false);
    // Nothing invented: the table says SEPT->SEPTEMBER and SEP->SEPTEMBER, not SEP<->SEPT.
    expect(batchCodeAliasEqual("SEP-26-BLK1", "SEPT-26-BLK1")).toBe(false);
    expect(batchCodeAliasEqual("FEEDING # 2", "AUGUST-26-FEED2")).toBe(false);
  });

  it("resolveKnownBatchCodeAlias only ever points at a batch that ALREADY exists", () => {
    // The DB spells August feed `AUG-`, so prefer that.
    expect(resolveKnownBatchCodeAlias("AUGUST-26-FEED1", LIVE_FEED_BATCH_CODES)).toBe("AUG-26-FEED1");
    // Nothing to prefer when the code already resolves.
    expect(resolveKnownBatchCodeAlias("AUGUST-26-BLK1", LIVE_FEED_BATCH_CODES)).toBeNull();
    // Never invents: no alias in the DB means no remap.
    expect(resolveKnownBatchCodeAlias("AUGUST-26-FEED9", LIVE_FEED_BATCH_CODES)).toBeNull();
    expect(resolveKnownBatchCodeAlias("SEPTEMBER-26-FEED1", LIVE_FEED_BATCH_CODES)).toBeNull();
  });

  it("THE HEADLINE CASE: the real 2026-08-05 AAV 6111 / 19,185 kg row resolves CLEAN", () => {
    // Extracted exactly as the widened extractor now produces it.
    const [code, warnings] = translateBatchCode("FEEDING # 1", null, "2026-08-05");
    expect(code).toBe("AUGUST-26-FEED1");
    expect(warnings).toEqual([]);

    const row = mkRow({
      batch_code: code,
      operator_batch_label: "FEEDING # 1",
      lab_results: DB_AUG05_FEED1.lab_results as Record<string, number | null>,
    });
    const classified = classifyDeliveries(mkExtract([row]), [DB_AUG05_FEED1]);

    // A clean NOOP: matched, nothing to write, nothing to arbitrate.
    expect(classified.summary).toMatchObject({
      new_count: 0,
      changed_count: 0,
      identity_diff_count: 0,
      noop_count: 1,
      malformed_count: 0,
      awaiting_assignment_count: 0,
    });
    expect(classified.noop[0].matched_tier).toBe(1); // same date + plate + sacks
    expect(classified.identity_diff).toEqual([]);

    // And therefore NOTHING is held.
    const guarded = applyDeliveriesGuard(classified, [DB_AUG05_FEED1], LIVE_FEED_BATCH_CODES);
    expect(guarded.flagged).toEqual([]);
    expect(guarded.new).toEqual([]);
  });

  it("BEFORE the alias fix that same row raised a held cross_batch_reassignment", () => {
    // Proof the trap was real: keep the row identical but spell the code the way a
    // raw-string comparison would see it as different.
    const row = mkRow({
      batch_code: "FEEDING # 1",
      operator_batch_label: "FEEDING # 1",
      lab_results: DB_AUG05_FEED1.lab_results as Record<string, number | null>,
    });
    const classified = classifyDeliveries(mkExtract([row]), [DB_AUG05_FEED1]);
    expect(classified.summary.identity_diff_count).toBe(1);
    expect(classified.identity_diff[0].identity_fields).toEqual(["batch_code"]);
  });

  it("a REAL disagreement still holds: the 2026-08-12 row the DB stored as `FEEDING # 2`", () => {
    const row = mkRow({
      transaction_date: "2026-08-12",
      truck_plate: "KCA 378",
      sacks: 516,
      weight_kg: 18650,
      remarks: "FEED",
      lab_results: DB_AUG12_RAWLABEL.lab_results as Record<string, number | null>,
      batch_code: translateBatchCode("FEEDING # 2", null, "2026-08-12")[0],
      operator_batch_label: "FEEDING # 2",
      _source_row: 19,
    });
    expect(row.batch_code).toBe("AUGUST-26-FEED2");

    const classified = classifyDeliveries(mkExtract([row]), [DB_AUG12_RAWLABEL]);
    expect(classified.summary.identity_diff_count).toBe(1);
    expect(classified.identity_diff[0].identity_fields).toEqual(["batch_code"]);

    const guarded = applyDeliveriesGuard(classified, [DB_AUG12_RAWLABEL], LIVE_FEED_BATCH_CODES);
    expect(guarded.flagged).toHaveLength(1);
    expect(guarded.flagged[0].kind).toBe("L040_identity_diff");
    expect(guarded.flagged[0].reason).toContain("FEEDING # 2");
    expect(guarded.flagged[0].reason).toContain("AUGUST-26-FEED2");
    // NOT re-inserted as a second copy of the same truckload.
    expect(guarded.new).toEqual([]);
  });

  it("a genuinely NEW feeding row is written under the DB's own spelling, not beside it", () => {
    const row = mkRow({
      transaction_date: "2026-08-14",
      batch_code: translateBatchCode("FEEDING # 2", null, "2026-08-14")[0],
      operator_batch_label: "FEEDING # 2",
      truck_plate: "AAV 6111",
      sacks: 500,
      weight_kg: 18000,
    });
    expect(row.batch_code).toBe("AUGUST-26-FEED2");

    const guarded = applyDeliveriesGuard(
      classifyDeliveries(mkExtract([row]), []),
      [],
      LIVE_FEED_BATCH_CODES,
    );
    expect(guarded.new).toHaveLength(1);
    // The apply step will now find `AUG-26-FEED2` and NOT create a duplicate batch.
    expect(guarded.new[0].row.batch_code).toBe("AUG-26-FEED2");
    expect(guarded.new[0].notes?.join(" ")).toContain("L-042: batch re-spelled");
  });
});

// ===========================================================================
// CHANGE 2 — "not filled in yet" is not MALFORMED
// ===========================================================================
describe("L-042 — awaiting a pile assignment vs genuinely malformed", () => {
  /** MC's early-morning shape: plate, weight and moisture, Block cell still empty. */
  const overnight = mkRow({
    transaction_date: "2026-08-13",
    supplier: null,
    batch_code: null,
    operator_batch_label: null,
    block_loc: null,
    truck_plate: "AAV 6111",
    sacks: 480,
    weight_kg: 17900,
    lab_results: { mc: 11.4, grit: null, bd_astm: null, bd_jis: null, vm: null, ash: null, fc: null },
    warnings: ["Row 21: missing supplier", "No operator batch label in row"],
    confidence: 0.8,
    _source_row: 21,
  });

  /** An ORPHAN wet-recovery sub-row: no plate, no batch, no block, no date of its own. */
  const orphanRecovery = mkRow({
    transaction_date: "2026-08-13",
    supplier: null,
    batch_code: null,
    operator_batch_label: null,
    block_loc: null,
    truck_plate: null,
    sacks: 14,
    weight_kg: 520,
    remarks: "WET SACKS",
    warnings: ["Row 22: missing supplier", "No operator batch label in row"],
    confidence: 0.8,
    _source_row: 22,
  });

  it("an empty Block cell lands in the new soft class, NOT malformed", () => {
    expect(isAwaitingBatchAssignment(overnight)).toBe(true);
    const classified = classifyDeliveries(mkExtract([overnight]), []);
    expect(classified.summary.malformed_count).toBe(0);
    expect(classified.summary.awaiting_assignment_count).toBe(1);
    expect(classified.malformed).toEqual([]);
    expect(classified.awaiting_assignment[0].index).toBe(21);
    expect(classified.awaiting_assignment[0].reason).toContain("No pile assigned yet");
  });

  it("an ORPHAN wet-recovery sub-row STAYS malformed and stays loud", () => {
    expect(isAwaitingBatchAssignment(orphanRecovery)).toBe(false);
    const classified = classifyDeliveries(mkExtract([orphanRecovery]), []);
    expect(classified.summary.malformed_count).toBe(1);
    expect(classified.summary.awaiting_assignment_count).toBe(0);
    expect(classified.malformed[0].reason).toContain("Missing required field");
  });

  it("MALFORMED is not softened for anything else", () => {
    // A label that EXISTS but did not translate is never silenced (it comes through as the
    // raw label, so it is a real row with a real, if odd, code).
    expect(
      isAwaitingBatchAssignment(mkRow({ batch_code: "FEEDING AREA A", operator_batch_label: "FEEDING AREA A" })),
    ).toBe(false);
    // A zero weight is a data problem, not a pending assignment.
    expect(isAwaitingBatchAssignment(mkRow({ weight_kg: 0 }))).toBe(false);
    // No plate AND no label -> indistinguishable from an orphan; the LOUD answer wins.
    expect(isAwaitingBatchAssignment(mkRow({ truck_plate: null }))).toBe(false);
    expect(isAwaitingBatchAssignment(mkRow({ truck_plate: "   " }))).toBe(false);
  });

  it("apply REPORTS it and never HOLDS it — no durable case, no blocked watermark", async () => {
    const classified = classifyDeliveries(mkExtract([overnight]), []);
    const guarded = applyDeliveriesGuard(classified, [], new Set());
    const compact: DeliveriesCompact = {
      report_type: "deliveries",
      since: "2026-08-10",
      watermark: "2026-08-12",
      source: {},
      actionable: {
        new: guarded.new,
        changed: guarded.changed,
        flagged: guarded.flagged,
        dup_noops: guarded.dup_noops,
        malformed: guarded.malformed.map((m) => ({ reason: m.reason, row: m.row })),
        awaiting_assignment: guarded.awaiting_assignment.map((a) => ({
          index: a.index,
          reason: a.reason,
          row: a.row,
        })),
      },
    };

    const res = await applyDeliveries(compact, {
      db: stubDb(),
      noLabel: true,
      runTs: "2026-08-15T01:50:00Z", // Manila 2026-08-15, so the 08-13 row is 2 days pending
    });

    expect(res.held).toEqual([]); // <- the whole point
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.watermark_updated).toBe(true);
    expect(res.awaiting_batch_assignment).toHaveLength(1);
    expect(res.awaiting_batch_assignment[0]).toMatchObject({
      transaction_date: "2026-08-13",
      truck_plate: "AAV 6111",
      weight_kg: 17900,
      sacks: 480,
      source_row: "21",
      days_pending: 2,
    });
  });

  it("days_pending is measured in Asia/Manila, not UTC", async () => {
    const build = async (runTs: string) => {
      const classified = classifyDeliveries(mkExtract([overnight]), []);
      const guarded = applyDeliveriesGuard(classified, [], new Set());
      const res = await applyDeliveries(
        {
          report_type: "deliveries",
          since: "2026-08-10",
          watermark: null,
          source: {},
          actionable: {
            new: [],
            changed: [],
            flagged: [],
            dup_noops: [],
            malformed: [],
            awaiting_assignment: guarded.awaiting_assignment.map((a) => ({ index: a.index, row: a.row })),
          },
        },
        { db: stubDb(), noLabel: true, runTs },
      );
      return res.awaiting_batch_assignment[0].days_pending;
    };
    // 2026-08-13 17:00 UTC is already 2026-08-14 01:00 in Manila -> one day on.
    expect(await build("2026-08-13T17:00:00Z")).toBe(1);
    // The same instant read as UTC would still say 0.
    expect(await build("2026-08-13T02:00:00Z")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A db stub that fails loudly if apply tries to write anything for these rows.
// ---------------------------------------------------------------------------
function stubDb() {
  return {
    selectOne: async () => null,
    insert: async () => {
      throw new Error("apply must not INSERT for an awaiting-assignment row");
    },
    insertIfAbsent: async () => {
      throw new Error("apply must not INSERT for an awaiting-assignment row");
    },
    applyDeliveryUpstream: async () => [],
    stampIngestionAudit: async () => true,
    writeIngestionAudit: async () => "audit-id",
    upsertIngestionWatermark: async () => true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
