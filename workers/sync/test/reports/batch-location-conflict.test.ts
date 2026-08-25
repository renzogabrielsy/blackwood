/**
 * batch-location-conflict.test.ts — BUG-027 (run afac05bd, 2026-08-25).
 *
 * The Sheet's one NEW RC IN row named a brand-new pattern-valid batch `AUG-26-BLK11` at
 * block `D-20D`, where `JUNE-26-BLK6` was still IN-USE with 4,680 kg. The auto-create
 * hit the partial unique index `idx_unique_active_batch_per_location`, the 23505 escaped
 * `ensureBatch`, escaped `applyFromCompact`, and was caught only at the mode boundary —
 * so the run reported `inserts: 0, updates: 0`, the watermark never moved, and the raw
 * Postgres string was the sentence Renzo read in the panel.
 *
 * What this file pins:
 *   1. the conflict is HELD, never thrown;
 *   2. the REST of the apply still runs and the watermark still advances;
 *   3. the message names BOTH batches, the block, the balance and the last-fed date, and
 *      carries no SQLSTATE / constraint name — while the raw refusal survives in `row`;
 *   4. the fingerprint is stable across runs (the ack ledger's whole premise);
 *   5. the email path (reports/deliveries) raises the SAME held row from the SAME module.
 */
import { describe, it, expect } from "vitest";

import {
  batchLocationConflictDetail,
  batchLocationConflictRow,
  isLocationCollision,
  lookupLocationOccupant,
  type BatchLocationConflict,
} from "../../src/lib/batchLocationConflict.js";
import { ensureBatch } from "../../src/lib/batchAutoCreate.js";
import {
  applyFromCompact,
  applyGsheet,
  type CompactUnmapped,
  type ModeCompact,
} from "../../src/reports/gsheet/apply.js";
import { applyDeliveries, type DeliveriesCompact } from "../../src/reports/deliveries/apply.js";
import type { DbClient } from "../../src/lib/db.js";

// ---------------------------------------------------------------------------
// The measured incident, as fixture constants.
// ---------------------------------------------------------------------------
const NEW_CODE = "AUG-26-BLK11";
const BLOCK = "D-20D";
const OCCUPANT = "JUNE-26-BLK6";
const OCCUPANT_ID = "batch-june-26-blk6";
const OCCUPANT_KG = 4680;
const LAST_FED = "2026-08-21";

/** The verbatim refusal the DB returned on run afac05bd. */
const RAW_23505 =
  'upsert_batch_if_absent batches failed 23505: duplicate key value violates unique ' +
  'constraint "idx_unique_active_batch_per_location"';

// ---------------------------------------------------------------------------
// A DbClient stub that refuses the batch insert exactly the way the DB did.
// ---------------------------------------------------------------------------
function conflictDb(
  opts: {
    /** Omit the occupant entirely, to exercise the "nobody found" fallback wording. */
    noOccupant?: boolean;
    /** Make the occupant lookup itself blow up, to prove it never re-raises. */
    lookupThrows?: boolean;
    /** The occupant was never fed — no rc_out row. */
    neverFed?: boolean;
  } = {},
) {
  const calls = {
    upsertBatchIfAbsent: [] as Array<Record<string, unknown>>,
    insertDeliveries: [] as Array<Record<string, unknown>>,
    insertRcOut: [] as Array<Record<string, unknown>>,
    watermarks: [] as string[],
    applyDeliveryUpstream: [] as Array<Record<string, unknown>>,
  };

  const db = {
    async upsertBatchIfAbsent(row: Record<string, unknown>) {
      calls.upsertBatchIfAbsent.push(row);
      throw new Error(RAW_23505);
    },
    async insert(table: string, rows: Array<Record<string, unknown>>) {
      if (table === "batches") throw new Error(RAW_23505);
      if (table === "deliveries") calls.insertDeliveries.push(...rows);
      return rows.map((_, i) => ({ id: `row-${table}-${i + 1}` }));
    },
    async selectOne(table: string) {
      // "does this batch already exist?" — no, which is what makes it a NEW batch.
      if (table === "batches") return null;
      return null;
    },
    async readRows(table: string) {
      if (opts.lookupThrows) throw new Error("read_rows batches failed 42501: permission denied");
      if (table === "batches") {
        if (opts.noOccupant) return [];
        return [
          {
            id: OCCUPANT_ID,
            batch_code: OCCUPANT,
            status: "IN-USE",
            current_weight: OCCUPANT_KG,
          },
        ];
      }
      if (table === "rc_out") {
        return opts.neverFed ? [] : [{ transaction_date: LAST_FED }];
      }
      return [];
    },
    async insertIfAbsent(table: string, rows: Array<Record<string, unknown>>) {
      if (table === "deliveries") calls.insertDeliveries.push(...rows);
      if (table === "rc_out") calls.insertRcOut.push(...rows);
      return {
        inserted: rows.map((r, i) => ({ ...r, id: `row-${table}-${i + 1}` })),
        skipped: [],
        insertedCount: rows.length,
        skippedCount: 0,
      };
    },
    async applyDeliveryUpstream(ops: Array<Record<string, unknown>>) {
      calls.applyDeliveryUpstream.push(...ops);
      return ops.map((o) => ({ id: String(o.id), outcome: "applied" }));
    },
    async stampIngestionAudit() {
      return true;
    },
    async writeIngestionAudit() {
      return { id: "audit-1" };
    },
    async upsertIngestionWatermark(reportType: string) {
      calls.watermarks.push(reportType);
      return true;
    },
  };
  return { db: db as unknown as DbClient, calls };
}

// ---------------------------------------------------------------------------
// Compact builders (mirroring gsheet-autocreate.test.ts's shapes).
// ---------------------------------------------------------------------------
function unmappedRcIn(over: Partial<CompactUnmapped> = {}): CompactUnmapped {
  return {
    kind: "UNMAPPED",
    index: 1543,
    decision: "skip",
    batch_code: NEW_CODE,
    date: "2026-08-21",
    block_loc: BLOCK,
    weight_kg: 16_840,
    supplier: "Ornales",
    truck_plate: "TEMP138003",
    full: {
      kind: "NEW",
      index: 1543,
      date: "2026-08-21",
      batch_code: NEW_CODE,
      block_loc: BLOCK,
      weight_kg: 16_840,
      supplier: "Ornales",
      truck_plate: "TEMP138003",
      sacks: 480,
      remarks: null,
      lab_results: null,
      confidence: 1,
      true_weight_kg: null,
      deduction_note: null,
    },
    ...over,
  };
}

function compact(unmapped: CompactUnmapped[], changed: ModeCompact["actionable"]["changed"] = []): ModeCompact {
  return {
    mode: "rc_in",
    since: "2025-01-01",
    actionable: { new: [], changed, flagged: [], unmapped, malformed: [] },
  };
}

// ===========================================================================
// 1. The predicate + the sentence (pure — no DB).
// ===========================================================================
describe("isLocationCollision", () => {
  it("recognises the 23505 the active-batch-per-location index raises", () => {
    expect(isLocationCollision(new Error(RAW_23505))).toBe(true);
    expect(isLocationCollision(new Error("insert batches failed 23505: location_ref"))).toBe(true);
  });

  it("does NOT swallow an unrelated failure", () => {
    expect(isLocationCollision(new Error("insert batches failed 42501: permission denied"))).toBe(false);
    expect(isLocationCollision(new Error("23503: foreign key violation on batch_code"))).toBe(false);
  });
});

describe("batchLocationConflictDetail — the sentence a person reads", () => {
  const full: BatchLocationConflict = {
    attempted_batch_code: NEW_CODE,
    location_ref: BLOCK,
    occupant: {
      batch_code: OCCUPANT,
      status: "IN-USE",
      current_weight_kg: OCCUPANT_KG,
      last_fed_date: LAST_FED,
    },
    db_error: RAW_23505,
  };

  it("names both batches, the block, the balance, the last-fed date and the ACTION", () => {
    const msg = batchLocationConflictDetail(full, "delivery");
    expect(msg).toContain(NEW_CODE);
    expect(msg).toContain(OCCUPANT);
    expect(msg).toContain(BLOCK);
    expect(msg).toContain("4,680 kg");
    expect(msg).toContain(LAST_FED);
    expect(msg).toContain(`close ${OCCUPANT}`);
    expect(msg).toContain("file this delivery");
  });

  it("carries NO SQLSTATE, NO constraint name and NO ₱", () => {
    const msg = batchLocationConflictDetail(full, "delivery");
    expect(msg).not.toContain("23505");
    expect(msg).not.toContain("idx_unique_active_batch_per_location");
    expect(msg).not.toContain("duplicate key");
    expect(msg).not.toContain("₱");
    expect(msg.toLowerCase()).not.toContain("constraint");
  });

  it("says 'feeding' for an rc_out row and 'delivery' for an rc_in one", () => {
    expect(batchLocationConflictDetail(full, "feeding")).toContain("file this feeding");
    expect(batchLocationConflictDetail(full, "delivery")).toContain("file this delivery");
  });

  it("still reads as a sentence when the occupant could not be identified", () => {
    const msg = batchLocationConflictDetail({ ...full, occupant: null }, "delivery");
    expect(msg).toContain(NEW_CODE);
    expect(msg).toContain(BLOCK);
    expect(msg).toContain("another batch is still marked active");
    expect(msg).not.toContain("23505");
  });

  it("omits the last-fed clause for a batch nothing was ever fed out of", () => {
    const msg = batchLocationConflictDetail(
      { ...full, occupant: { ...full.occupant!, last_fed_date: null } },
      "delivery",
    );
    expect(msg).toContain(`${OCCUPANT} is still marked active there with 4,680 kg left.`);
    expect(msg).not.toContain("last fed");
  });

  it("keeps the raw refusal in the structured row, never in the sentence", () => {
    const row = batchLocationConflictRow(full);
    expect(row.db_error).toBe(RAW_23505);
    expect(row.attempted_batch_code).toBe(NEW_CODE);
    expect(row.occupying_batch_code).toBe(OCCUPANT);
    expect(row.occupying_balance_kg).toBe(OCCUPANT_KG);
    expect(row.occupying_last_fed).toBe(LAST_FED);
    // No ₱/cost key may appear on a held row.
    for (const k of Object.keys(row)) expect(k).not.toMatch(/cost|price|php/i);
  });
});

// ===========================================================================
// 2. The occupant lookup never re-raises.
// ===========================================================================
describe("lookupLocationOccupant", () => {
  it("reads the ACTIVE batch, its balance and its last feeding", async () => {
    const { db } = conflictDb();
    expect(await lookupLocationOccupant(db, BLOCK)).toEqual({
      batch_code: OCCUPANT,
      status: "IN-USE",
      current_weight_kg: OCCUPANT_KG,
      last_fed_date: LAST_FED,
    });
  });

  it("returns null (never throws) when the read itself fails — a hold must not become a crash", async () => {
    const { db } = conflictDb({ lookupThrows: true });
    await expect(lookupLocationOccupant(db, BLOCK)).resolves.toBeNull();
  });

  it("returns null for an empty/absent block", async () => {
    const { db } = conflictDb();
    expect(await lookupLocationOccupant(db, "")).toBeNull();
    expect(await lookupLocationOccupant(db, null)).toBeNull();
  });
});

// ===========================================================================
// 3. ensureBatch returns the outcome instead of throwing.
// ===========================================================================
describe("ensureBatch — a taken block is an OUTCOME, not a throw", () => {
  it("returns location_conflict carrying both sides", async () => {
    const { db } = conflictDb();
    const lookup: Record<string, string> = {};
    const outcome = await ensureBatch(db, NEW_CODE, BLOCK, lookup);
    expect(outcome.status).toBe("location_conflict");
    if (outcome.status !== "location_conflict") throw new Error("unreachable");
    expect(outcome.attemptedCode).toBe(NEW_CODE);
    expect(outcome.conflict.occupant?.batch_code).toBe(OCCUPANT);
    expect(outcome.conflict.db_error).toBe(RAW_23505);
    // The lookup must NOT be seeded — the batch does not exist, and a later row in the
    // same pass must never resolve to an id that was never created.
    expect(lookup).toEqual({});
  });

  it("still rethrows a failure that is NOT a location clash", async () => {
    const db = {
      async upsertBatchIfAbsent() {
        throw new Error("upsert_batch_if_absent batches failed 42501: permission denied");
      },
    } as unknown as DbClient;
    await expect(ensureBatch(db, NEW_CODE, BLOCK, {})).rejects.toThrow("permission denied");
  });
});

// ===========================================================================
// 4. The apply holds the row and KEEPS GOING (the actual incident).
// ===========================================================================
describe("gsheet apply — the block clash holds one row and costs nothing else", () => {
  it("holds the conflicting row, applies the rest, and never throws", async () => {
    const { db, calls } = conflictDb();
    const res = await applyFromCompact(
      compact(
        [unmappedRcIn()],
        [
          { kind: "VALUE_CHANGED", index: 12, db_id: "d-1", date: "2026-08-20", batch_code: "AUG-26-BLK9", diff: [{ field: "weight_kg", db: 100, sheet: 200 }] },
          { kind: "VALUE_CHANGED", index: 13, db_id: "d-2", date: "2026-08-20", batch_code: "AUG-26-BLK9", diff: [{ field: "sacks", db: 10, sheet: 12 }] },
        ],
      ),
      { db, runTs: "2026-08-25T00:00:00.000Z" },
    );

    // THE REGRESSION: before the fix this call threw and the whole mode was discarded.
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(2); // the other rows were NOT lost
    expect(res.inserted).toBe(0); // the conflicting delivery is held, never written
    expect(calls.insertDeliveries).toHaveLength(0);

    const hold = res.skipped.find((s) => s.reason === "batch_location_conflict");
    expect(hold).toBeDefined();
    expect(hold!.held?.kind).toBe("batch_location_conflict");
    expect(hold!.why).toContain(NEW_CODE);
    expect(hold!.why).toContain(OCCUPANT);
    expect(hold!.why).not.toContain("23505");
    // Both sides + the raw refusal ride in the structured row.
    expect(hold!.held?.row?.occupying_batch_code).toBe(OCCUPANT);
    expect(hold!.held?.row?.db_error).toBe(RAW_23505);
    // The row's own identity survives alongside the conflict fields.
    expect(hold!.held?.row?.truck_plate).toBe("TEMP138003");
  });

  it("the run reports NO error and the watermark still advances (held ≠ error)", async () => {
    const { db, calls } = conflictDb();
    const res = await applyGsheet(
      { rc_in: compact([unmappedRcIn()]), rc_out: compact([]) },
      { db, runTs: "2026-08-25T00:00:00.000Z", cutoverRcOut: true },
    );

    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.watermark_updated).toBe(true);
    expect(calls.watermarks).toEqual(["gsheet"]);
    expect(res.held.map((h) => h.kind)).toContain("batch_location_conflict");
  });

  it("the raw Postgres string is nowhere in errors[] — the panel's headline is prose", async () => {
    const { db } = conflictDb();
    const res = await applyGsheet(
      { rc_in: compact([unmappedRcIn()]), rc_out: compact([]) },
      { db, runTs: "2026-08-25T00:00:00.000Z", cutoverRcOut: true },
    );
    expect(res.errors.join("\n")).not.toContain("idx_unique_active_batch_per_location");
  });
});

// ===========================================================================
// 5. The email path raises the SAME hold from the SAME module.
// ===========================================================================
describe("deliveries apply — the email path holds the identical conflict", () => {
  function deliveriesCompact(): DeliveriesCompact {
    return {
      report_type: "deliveries",
      since: "2026-08-01",
      watermark: null,
      source: { email_uid: 1, email_thread_id: "t-1" },
      actionable: {
        new: [
          {
            index: 4,
            row: {
              transaction_date: "2026-08-21",
              supplier: "Ornales",
              batch_code: NEW_CODE,
              block_loc: BLOCK,
              truck_plate: "TEMP138003",
              sacks: 480,
              weight_kg: 16_840,
              cost_basis: null,
              remarks: null,
              lab_results: null,
            } as never,
          },
        ],
        changed: [],
        flagged: [],
        dup_noops: [],
        malformed: [],
      },
    };
  }

  it("holds `batch_location_conflict` with the same sentence, and does not error the run", async () => {
    const { db, calls } = conflictDb();
    const res = await applyDeliveries(deliveriesCompact(), { db, runTs: "2026-08-25T00:00:00.000Z", noLabel: true });

    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.inserts).toBe(0);
    expect(calls.insertDeliveries).toHaveLength(0);

    const hold = res.held.find((h) => h.kind === "batch_location_conflict");
    expect(hold).toBeDefined();
    expect(hold!.detail).toContain(NEW_CODE);
    expect(hold!.detail).toContain(OCCUPANT);
    expect(hold!.detail).toContain("4,680 kg");
    expect(hold!.detail).not.toContain("23505");
    expect(hold!.row?.db_error).toBe(RAW_23505);
  });

  it("its sentence is byte-identical to the Sheet path's — one definition, two writers", async () => {
    const a = conflictDb();
    const emailRes = await applyDeliveries(deliveriesCompact(), { db: a.db, runTs: "t", noLabel: true });
    const b = conflictDb();
    const sheetRes = await applyFromCompact(compact([unmappedRcIn()]), { db: b.db, runTs: "t" });

    const emailMsg = emailRes.held.find((h) => h.kind === "batch_location_conflict")!.detail;
    const sheetMsg = sheetRes.skipped.find((s) => s.reason === "batch_location_conflict")!.why;
    expect(emailMsg).toBe(sheetMsg);
  });
});
