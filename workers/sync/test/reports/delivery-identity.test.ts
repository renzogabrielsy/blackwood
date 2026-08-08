/**
 * delivery-identity.test.ts — L-040b, the two-tier delivery identity.
 *
 * Every case here is a REAL row from the live database or from
 * `public.deliveries_archive` (the 2026-08-07 duplicate cleanup), not an invention:
 *
 *   - 2025-04-03 / KCA 378 / MARCH-25-BLK9 / D-8D — the wet-sack deduction split, 471
 *     and 36 sacks, BOTH 18,827 kg. The ONLY pair in the whole table that collides on
 *     the LEGACY key, and it must survive as two rows.
 *   - 2026-02-04 / FEB-26-BLK4 ⇄ FEB-26-BLK5 — the Sheet had the two trucks' block
 *     assignment swapped; Renzo corrected it in-app and the sync inserted second copies
 *     of both (archive_batch a9bae68e… and 5105b855…).
 *   - 2026-07-08 / KCA 378 / 512 sacks / 19,605 kg — the Sheet says `JULY-26-FEED1`,
 *     MC's email says `FEEDING # 1`.
 *   - `MAV 9202` (57 rows) vs `MAV9202` (35 rows) — one truck, two spellings, both live.
 */
import { describe, it, expect } from "vitest";

import {
  buildDeliveryIdentityIndex,
  deliveriesInsertGuardColumns,
  deliveryIdentity,
  isTier1Eligible,
  legacyKey,
  matchDelivery,
  normPlate,
  tier1Key,
} from "../../src/lib/deliveryIdentity.js";
import {
  applyDeliveriesGuard,
  classifyDeliveries,
  type DeliveriesDbRow,
} from "../../src/reports/deliveries/classify.js";
import type { DeliveryRow, ExtractResult } from "../../src/reports/deliveries/extract.js";
import { classifyGsheet } from "../../src/reports/gsheet/classify.js";
import type { RowDict } from "../../src/reports/gsheet/deductions.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function mkRow(over: Partial<DeliveryRow>): DeliveryRow {
  return {
    transaction_date: "2026-07-08",
    supplier: "Tag-at",
    batch_code: "JULY-26-FEED1",
    operator_batch_label: "FEEDING # 1",
    block_loc: null,
    truck_plate: "KCA 378",
    sacks: 512,
    weight_kg: 19605,
    cost_basis: null,
    remarks: null,
    lab_results: null,
    true_weight_kg: null,
    deduction_note: null,
    warnings: [],
    confidence: 0.9,
    _source_row: 7,
    ...over,
  };
}

function mkExtract(rows: DeliveryRow[]): ExtractResult {
  return {
    filename: "t.xlsx",
    sheets_processed: ["JULY 26"],
    rows,
    summary: { total_rows: rows.length, extraction_warnings: [], overall_confidence: 0.9, unmapped_batches: [] },
  };
}

function run(rows: DeliveryRow[], db: DeliveriesDbRow[], batchCodes: string[] = []) {
  return applyDeliveriesGuard(classifyDeliveries(mkExtract(rows), db), db, new Set(batchCodes));
}

function dbRow(over: Partial<DeliveriesDbRow>): DeliveriesDbRow {
  return {
    id: "db-1",
    transaction_date: "2026-07-08",
    supplier: "Tag-at",
    batch_code: "JULY-26-FEED1",
    block_loc: null,
    truck_plate: "KCA 378",
    sacks: 512,
    weight_kg: 19605,
    cost_basis: 36,
    remarks: null,
    lab_results: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The primitives
// ---------------------------------------------------------------------------
describe("L-040b — plate normalization", () => {
  it("'MAV 9202' and 'MAV9202' are ONE truck (both spellings are live: 57 + 35 rows)", () => {
    expect(normPlate("MAV 9202")).toBe("MAV9202");
    expect(normPlate("MAV9202")).toBe("MAV9202");
    expect(normPlate("mav-9202")).toBe("MAV9202");
    expect(normPlate("  MAV 9202  ")).toBe("MAV9202");
  });

  it("resolves identically THROUGH the identity key, not just through the normalizer", () => {
    const spaced = tier1Key({ transaction_date: "2026-07-04", truck_plate: "MAV 9202", sacks: 580 });
    const tight = tier1Key({ transaction_date: "2026-07-04", truck_plate: "MAV9202", sacks: 580 });
    expect(spaced).toBe("T1|2026-07-04|MAV9202|580");
    expect(tight).toBe(spaced);
  });

  it("a blank / missing plate yields no tier-1 key at all (never an empty-plate bucket)", () => {
    expect(normPlate(null)).toBe("");
    expect(normPlate("   ")).toBe("");
    expect(tier1Key({ transaction_date: "2026-07-04", truck_plate: "", sacks: 580 })).toBeNull();
    expect(tier1Key({ transaction_date: "2026-07-04", truck_plate: null, sacks: 580 })).toBeNull();
    // A plate with no sack count is NOT an identity either (one truck, several trips).
    expect(tier1Key({ transaction_date: "2026-07-04", truck_plate: "KCA 378", sacks: null })).toBeNull();
  });

  it("tier tags make a tier-1 key structurally unable to equal a tier-2 key", () => {
    const t1 = tier1Key({ transaction_date: "2026-07-04", truck_plate: "KCA 378", sacks: 512 });
    const t2 = legacyKey({ transaction_date: "2026-07-04", batch_code: "KCA378", block_loc: "512", weight_kg: null });
    expect(t1?.startsWith("T1|")).toBe(true);
    expect(t2.startsWith("T2|")).toBe(true);
    expect(t1).not.toBe(t2);
  });
});

// ---------------------------------------------------------------------------
// The wet-sack deduction split — the case a naive key destroys
// ---------------------------------------------------------------------------
describe("L-040b — the 2025-04-03 wet-sack split survives", () => {
  const heavy = {
    id: "wet-471",
    transaction_date: "2025-04-03",
    supplier: "Tag-at",
    batch_code: "MARCH-25-BLK9",
    block_loc: "D-8D",
    truck_plate: "KCA 378",
    sacks: 471,
    weight_kg: 18827,
    cost_basis: 30,
    remarks: "KCA 378 net kilos of 18,855 -2.07% (MC of mixed 36 bags) = 18,827  / PILED IN MARCH 2025 BLOCK 9",
    lab_results: { mc: 11.14, ash: 3.33 },
  };
  const light = { ...heavy, id: "wet-36", sacks: 36, remarks: "", lab_results: { mc: 14.07, ash: 3.33 } };

  it("the LEGACY key CANNOT tell them apart — that is the bug being fixed", () => {
    expect(legacyKey(heavy)).toBe(legacyKey(light));
    expect(legacyKey(heavy)).toBe("T2|2025-04-03|MARCH-25-BLK9|D-8D|18827");
  });

  it("the TIER-1 identity gives them two distinct keys", () => {
    expect(tier1Key(heavy)).toBe("T1|2025-04-03|KCA378|471");
    expect(tier1Key(light)).toBe("T1|2025-04-03|KCA378|36");
    expect(tier1Key(heavy)).not.toBe(tier1Key(light));
  });

  it("BOTH rows classify as NOOP — neither is a duplicate and neither overwrites the other", () => {
    const res = run(
      [
        mkRow({ ...heavy, _source_row: 10 } as Partial<DeliveryRow>),
        mkRow({ ...light, _source_row: 11 } as Partial<DeliveryRow>),
      ],
      [heavy, light],
    );
    expect(res.noop).toHaveLength(2);
    expect(res.new).toHaveLength(0);
    expect(res.changed).toHaveLength(0);
    expect(res.identity_diff).toHaveLength(0);
    expect(res.flagged).toHaveLength(0);
    // Each row matched ITS OWN db row, on tier 1.
    expect(res.noop.map((n) => n.db_id).sort()).toEqual(["wet-36", "wet-471"]);
    expect(res.noop.every((n) => n.matched_tier === 1)).toBe(true);
  });

  it("the legacy key would have made the 36-sack row an UPDATE of the 471-sack row", () => {
    // Proof the old behaviour really was destructive: matched on the legacy key alone,
    // the light row lands on the heavy row and differs on sacks + mc.
    const legacyOnly = buildDeliveryIdentityIndex([heavy]);
    const hit = legacyOnly.tier2.get(legacyKey(light));
    expect(hit?.[0].id).toBe("wet-471");
  });
});

// ---------------------------------------------------------------------------
// Incident 1 — the 2026-02-04 block/truck swap
// ---------------------------------------------------------------------------
describe("L-040b — the 2026-02-04 swap becomes a diff, not an insert", () => {
  // The app's corrected rows.
  const appBlk4 = dbRow({
    id: "a5169fad",
    transaction_date: "2026-02-04",
    supplier: "Ornales",
    batch_code: "FEB-26-BLK4",
    block_loc: "A-7C",
    truck_plate: "CBQ 5957",
    sacks: 540,
    weight_kg: 21333,
    cost_basis: 49,
  });
  const appBlk5 = dbRow({
    id: "bf37a924",
    transaction_date: "2026-02-04",
    supplier: "Ornales",
    batch_code: "FEB-26-BLK5",
    block_loc: "C-10B",
    truck_plate: "LFF 835",
    sacks: 334,
    weight_kg: 11495,
    cost_basis: 49,
  });

  // What the stale source said: the two trucks' blocks swapped.
  const staleLff = mkRow({
    transaction_date: "2026-02-04",
    supplier: "Ornales",
    batch_code: "FEB-26-BLK4",
    block_loc: "A-7C",
    truck_plate: "LFF 835",
    sacks: 334,
    weight_kg: 11495,
    _source_row: 679,
  });
  const staleCbq = mkRow({
    transaction_date: "2026-02-04",
    supplier: "Ornales",
    batch_code: "FEB-26-BLK5",
    block_loc: "C-10B",
    truck_plate: "CBQ 5957",
    sacks: 540,
    weight_kg: 21333,
    _source_row: 680,
  });

  it("the app row and the stale source row produce the SAME key", () => {
    expect(tier1Key(staleLff)).toBe(tier1Key(appBlk5));
    expect(tier1Key(staleCbq)).toBe(tier1Key(appBlk4));
  });

  it("the LEGACY key MISSES — which is exactly why it inserted a second copy", () => {
    const idx = buildDeliveryIdentityIndex([appBlk4, appBlk5]);
    expect(idx.tier2.get(legacyKey(staleLff))).toBeUndefined();
    expect(idx.tier2.get(legacyKey(staleCbq))).toBeUndefined();
  });

  it("both stale rows become identity diffs — held, never inserted, never auto-applied", () => {
    const res = run([staleLff, staleCbq], [appBlk4, appBlk5]);
    expect(res.new).toHaveLength(0);
    expect(res.changed).toHaveLength(0);
    expect(res.identity_diff).toHaveLength(2);
    expect(res.flagged).toHaveLength(2);
    expect(res.flagged.every((f) => f.kind === "L040_identity_diff")).toBe(true);
    expect(res.flagged.every((f) => f.decision === "skip")).toBe(true);
    // The disagreement names BOTH sides of BOTH fields.
    const first = res.identity_diff.find((i) => i.index === 679)!;
    expect(first.identity_fields.sort()).toEqual(["batch_code", "block_loc"]);
    expect(first.db_row.id).toBe("bf37a924");
    const reason = res.flagged.find((f) => f.index === 679)!.reason;
    expect(reason).toContain("FEB-26-BLK4");
    expect(reason).toContain("FEB-26-BLK5");
    expect(reason).toContain("A-7C");
    expect(reason).toContain("C-10B");
  });

  it("a corrected WEIGHT is caught the same way (weight left the key, so it is compared)", () => {
    const staleWeight = mkRow({
      transaction_date: "2026-02-04",
      batch_code: "FEB-26-BLK4",
      block_loc: "A-7C",
      truck_plate: "CBQ 5957",
      sacks: 540,
      weight_kg: 11495, // the pre-correction figure
      _source_row: 681,
    });
    const res = run([staleWeight], [appBlk4]);
    expect(res.new).toHaveLength(0);
    expect(res.identity_diff).toHaveLength(1);
    expect(res.identity_diff[0].identity_fields).toContain("weight_kg");
    expect(res.flagged[0].kind).toBe("L040_identity_diff");
  });
});

// ---------------------------------------------------------------------------
// Incident 2 — FEEDING # 1 vs JULY-26-FEED1
// ---------------------------------------------------------------------------
describe("L-040b — the FEEDING # N shorthand becomes a diff, not a second row", () => {
  const appFeed = dbRow({ id: "de5adc87", batch_code: "JULY-26-FEED1" });
  const mcShorthand = mkRow({ batch_code: "FEEDING # 1", _source_row: 14 });

  it("same key despite the different batch_code spelling", () => {
    expect(tier1Key(mcShorthand)).toBe("T1|2026-07-08|KCA378|512");
    expect(tier1Key(appFeed)).toBe(tier1Key(mcShorthand));
  });

  it("classifies as an identity diff naming BOTH spellings — no insert", () => {
    const res = run([mcShorthand], [appFeed]);
    expect(res.new).toHaveLength(0);
    expect(res.identity_diff).toHaveLength(1);
    expect(res.identity_diff[0].identity_fields).toEqual(["batch_code"]);
    expect(res.flagged[0].reason).toContain("FEEDING # 1");
    expect(res.flagged[0].reason).toContain("JULY-26-FEED1");
    // NOT the old L-033a dup_noop, which was a SILENT skip nobody was told about.
    expect(res.dup_noops).toHaveLength(0);
  });

  it("the block_loc is null on both sides and that is not treated as a disagreement", () => {
    const res = run([mcShorthand], [appFeed]);
    expect(res.identity_diff[0].identity_fields).not.toContain("block_loc");
  });
});

// ---------------------------------------------------------------------------
// TIER 2 — the 143 plateless rows
// ---------------------------------------------------------------------------
describe("L-040b — tier-2 rows still classify correctly and never collapse together", () => {
  const a = dbRow({ id: "t2-a", truck_plate: null, sacks: null, batch_code: "JAN-25-FEED1", weight_kg: 17573 });
  const b = dbRow({ id: "t2-b", truck_plate: null, sacks: null, batch_code: "JAN-25-FEED2", weight_kg: 17995 });
  const c = dbRow({ id: "t2-c", truck_plate: "", sacks: null, batch_code: "JAN-25-FEED1", weight_kg: 18440 });

  it("each gets its own legacy key — three rows, three keys", () => {
    for (const r of [a, b, c]) expect(isTier1Eligible(r)).toBe(false);
    const keys = new Set([legacyKey(a), legacyKey(b), legacyKey(c)]);
    expect(keys.size).toBe(3);
    expect(deliveryIdentity(a).tier).toBe(2);
  });

  it("all three match their own DB row on tier 2 and NOOP — none is reported new", () => {
    const rows = [a, b, c].map((r, i) =>
      mkRow({
        transaction_date: r.transaction_date as string,
        batch_code: r.batch_code as string,
        block_loc: r.block_loc as string | null,
        truck_plate: r.truck_plate as string | null,
        sacks: r.sacks as number | null,
        weight_kg: r.weight_kg as number,
        supplier: r.supplier as string,
        _source_row: 100 + i,
      }),
    );
    const res = run(rows, [a, b, c]);
    expect(res.noop).toHaveLength(3);
    expect(res.new).toHaveLength(0);
    expect(res.identity_diff).toHaveLength(0);
    expect(res.noop.every((n) => n.matched_tier === 2)).toBe(true);
    expect(res.noop.map((n) => n.db_id).sort()).toEqual(["t2-a", "t2-b", "t2-c"]);
  });

  it("a plateless row that genuinely is new is STILL new (tier 2 is not a catch-all)", () => {
    const fresh = mkRow({
      transaction_date: "2026-08-08",
      batch_code: "AUG-26-FEED9",
      block_loc: null,
      truck_plate: null,
      sacks: null,
      weight_kg: 12345,
      _source_row: 200,
    });
    const res = run([fresh], [a, b, c]);
    expect(res.new).toHaveLength(1);
    expect(res.identity_diff).toHaveLength(0);
  });

  it("a TIER-1 extract row can still find a plateless DB row via the legacy fallback", () => {
    // The no-regression property: the tier-2 lookup is the OLD key, tried second.
    const plated = mkRow({
      transaction_date: a.transaction_date as string,
      batch_code: a.batch_code as string,
      block_loc: null,
      truck_plate: "KCA 378",
      sacks: 443,
      weight_kg: a.weight_kg as number,
      _source_row: 300,
    });
    const res = run([plated], [a]);
    expect(res.new).toHaveLength(0);
    // Matched on the LEGACY key (tier 2), because the DB row carries no plate.
    const matched = [...res.noop, ...res.changed, ...res.identity_diff][0] as { matched_tier: number };
    expect(matched.matched_tier).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The no-regression property
// ---------------------------------------------------------------------------
describe("L-040b — no new duplicates are possible", () => {
  it("every row the LEGACY key matched still matches (tier-2 is the second lookup)", () => {
    const db = [
      dbRow({ id: "x1", batch_code: "JULY-26-BLK5", block_loc: "A-17C", truck_plate: "AAV 6111", sacks: 484, weight_kg: 18512 }),
      dbRow({ id: "x2", batch_code: "JULY-26-FEED1", truck_plate: "KCA 378", sacks: 512, weight_kg: 19605 }),
      dbRow({ id: "x3", batch_code: "AUG-26-FEED1", truck_plate: null, sacks: null, weight_kg: 19185 }),
    ];
    const idx = buildDeliveryIdentityIndex(db);
    for (const r of db) {
      // Whatever the legacy key found, the two-tier resolver still finds something.
      expect(idx.tier2.get(legacyKey(r))).toBeDefined();
      expect(matchDelivery(idx, r)).not.toBeNull();
    }
  });

  it("a multi-row tier-1 bucket is REPORTED as a pre-existing duplicate, not hidden", () => {
    // Two DB rows for one truckload — the state the 2026-08-07 cleanup removed.
    const survivor = dbRow({ id: "keep", batch_code: "JULY-26-FEED1" });
    const dup = dbRow({ id: "dup", batch_code: "FEEDING # 1" });
    const idx = buildDeliveryIdentityIndex([survivor, dup]);
    const m = matchDelivery(idx, mkRow({ batch_code: "FEEDING # 1" }));
    expect(m?.matchedTier).toBe(1);
    expect(m?.peerCount).toBe(2);

    const res = run([mkRow({ batch_code: "FEEDING # 1" })], [survivor, dup]);
    expect(res.flagged[0].reason).toContain("already holds 2 rows for this one truckload");
  });
});

// ---------------------------------------------------------------------------
// Both writers agree
// ---------------------------------------------------------------------------
describe("L-040b — the two writers of `deliveries` share ONE identity", () => {
  it("the insert-guard columns mirror the tier decision", () => {
    expect(deliveriesInsertGuardColumns(dbRow({}))).toEqual(["transaction_date", "truck_plate", "sacks"]);
    expect(deliveriesInsertGuardColumns(dbRow({ truck_plate: null }))).toEqual([
      "transaction_date",
      "batch_code",
      "block_loc",
      "weight_kg",
    ]);
    expect(deliveriesInsertGuardColumns(dbRow({ sacks: null }))).toEqual([
      "transaction_date",
      "batch_code",
      "block_loc",
      "weight_kg",
    ]);
  });

  it("gsheet RC IN flags the SAME 2026-02-04 swap the email path flags", () => {
    const appBlk5 = {
      id: "bf37a924",
      transaction_date: "2026-02-04",
      supplier: "Ornales",
      batch_code: "FEB-26-BLK5",
      block_loc: "C-10B",
      truck_plate: "LFF 835",
      sacks: 334,
      weight_kg: 11495,
      cost_basis: 49,
      remarks: null,
      lab_results: null,
    };
    const sheetRow: RowDict = {
      transaction_date: "2026-02-04",
      supplier: "Ornales",
      batch_code_primary: "FEB-26-BLK4",
      batch_code_fallbacks: [],
      block_loc: "A-7C",
      truck_plate: "LFF 835",
      sacks: 334,
      weight_kg: 11495,
      remarks: null,
      lab_results: null,
      _source_row: 679,
    };
    const out = classifyGsheet(
      { rc_in: { rows: [sheetRow] }, rc_out: { rows: [] } },
      { deliveries: [appBlk5], rc_out: [], batchLookup: {} },
      "2025-01-01",
    );
    expect(out.rc_in.new).toHaveLength(0);
    expect(out.rc_in.changed).toHaveLength(0);
    expect(out.rc_in.flagged).toHaveLength(1);
    expect(out.rc_in.flagged[0].kind).toBe("identity_diff");
    expect(String(out.rc_in.flagged[0].reason)).toContain("FEB-26-BLK5");
  });

  it("gsheet: a KNOWN truckload under an UNRECOGNIZED code is a naming diff, not UNMAPPED", () => {
    // `FEEDING AREA # 1` is not in the DB code set at all. Deciding UNMAPPED first would
    // hold it vaguely forever — and if the code had been pattern-valid, would have
    // auto-created a batch and inserted a SECOND copy of a delivery we already have.
    const appFeed = {
      id: "jan-feed1",
      transaction_date: "2025-01-07",
      supplier: "Paquibot",
      batch_code: "JAN-25-FEED1",
      block_loc: null,
      truck_plate: "KCA 378",
      sacks: 443,
      weight_kg: 17573,
      cost_basis: 25,
      remarks: null,
      lab_results: null,
    };
    const sheetRow: RowDict = {
      transaction_date: "2025-01-07",
      supplier: "Paquibot",
      batch_code_primary: "FEEDING AREA # 1",
      batch_code_fallbacks: [],
      block_loc: null,
      truck_plate: "KCA 378",
      sacks: 443,
      weight_kg: 17573,
      remarks: null,
      lab_results: null,
      _source_row: 12,
    };
    const out = classifyGsheet(
      { rc_in: { rows: [sheetRow] }, rc_out: { rows: [] } },
      { deliveries: [appFeed], rc_out: [], batchLookup: {} },
      "2025-01-01",
    );
    expect(out.rc_in.unmapped).toHaveLength(0);
    expect(out.rc_in.new).toHaveLength(0);
    expect(out.rc_in.flagged).toHaveLength(1);
    expect(String(out.rc_in.flagged[0].reason)).toContain("FEEDING AREA # 1");
    expect(String(out.rc_in.flagged[0].reason)).toContain("JAN-25-FEED1");
  });

  it("gsheet: an UNRECOGNIZED code on an UNKNOWN truckload is still UNMAPPED", () => {
    const sheetRow: RowDict = {
      transaction_date: "2026-08-08",
      supplier: "Paquibot",
      batch_code_primary: "TYPOO-26-BLK1",
      batch_code_fallbacks: [],
      block_loc: "A-1A",
      truck_plate: "ZZZ 0000",
      sacks: 1,
      weight_kg: 1000,
      remarks: null,
      lab_results: null,
      _source_row: 13,
    };
    const out = classifyGsheet(
      { rc_in: { rows: [sheetRow] }, rc_out: { rows: [] } },
      { deliveries: [], rc_out: [], batchLookup: {} },
      "2025-01-01",
    );
    expect(out.rc_in.unmapped).toHaveLength(1);
    expect(out.rc_in.flagged).toHaveLength(0);
  });
});
