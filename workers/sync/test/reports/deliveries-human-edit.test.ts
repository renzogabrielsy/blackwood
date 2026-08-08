/**
 * deliveries-human-edit.test.ts — the DELIVERIES HUMAN-EDIT LATCH (2026-08-08).
 *
 * THE DEFECT. On 2026-02-04 Renzo corrected a delivery in Blackwood and never corrected
 * the Google Sheet. On 2026-06-25 that fact was written into an `audit_logs` COMMENT
 * reading, verbatim, "DO NOT auto-revert to the Sheet value". A comment is prose in a
 * table nothing reads at write time, so the sync overrode the row anyway — on 07-03 and
 * again on 08-07. `deliveries` had TWO unguarded sync UPDATE paths, and unlike
 * production's (which was dormant) both are LIVE: 40 `audit_logs` UPDATE rows on
 * `deliveries` carry `provenance=gsheet`, four of them on rows Renzo had already edited.
 *
 * A WARNING WRITTEN AS A COMMENT IS NOT A CONTROL. What is locked here:
 *   1. an UNLATCHED row still updates — through the conditional RPC, never a bare UPDATE;
 *   2. a LATCHED row is refused, and the refusal is SURFACED naming the row and BOTH
 *      values (a silent refusal is just a quieter version of the same bug);
 *   3. BOTH writers behave identically — the emailed report and the Sheet;
 *   4. a refused ₱ appears by NAME ONLY, because the findings channel is not price-gated;
 *   5. inserts are unconstrained — the latch governs UPDATES only;
 *   6. an outcome that is neither `applied` nor `human_edited` is an ERROR, not a shrug.
 *
 * The single-statement guard itself, the release path and the allowlist live in
 * `fn_apply_delivery_upstream` / `fn_release_delivery_rows` and are proven against the
 * live DB in a rolled-back transaction (see the migration's header and the commit note).
 * These tests cover the worker's half: what it sends, what it reports, and what it never
 * prints.
 */
import { describe, it, expect } from "vitest";

import { applyDeliveries, type DeliveriesCompact } from "../../src/reports/deliveries/apply.js";
import { applyFromCompact, type ModeCompact } from "../../src/reports/gsheet/apply.js";
import { deliveryHumanEditNote, REDACTED_FIELDS } from "../../src/reports/deliveryHumanEdit.js";
import { normalizeApply } from "../../src/workflows/normalizeReport.js";
import { flattenRunFindings } from "../../src/reports/excel/findingsBridge.js";
import { sidesForFinding } from "../../src/reports/excel/workbook.js";
import type { AppSyncRunResult } from "../../src/reports/excel/findingsBridge.js";
import type { DbClient, Row } from "../../src/lib/db.js";
import type { DeliveryRow } from "../../src/reports/deliveries/extract.js";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const ID_LATCHED = "11111111-1111-4111-8111-111111111111";
const ID_FREE = "22222222-2222-4222-8222-222222222222";

interface Recorder {
  db: DbClient;
  /** Ops handed to the CONDITIONAL writer (the RPC). */
  ops: Row[];
  /** Anything that went through the raw, UNGUARDED `db.update` (must stay empty). */
  rawUpdates: Array<{ table: string; patch: Row }>;
  inserts: Array<{ table: string; rows: Row[] }>;
}

/**
 * A DbClient stub that records BOTH write paths, so a regression back to the bare
 * `db.update("deliveries", …)` is visible rather than merely untested.
 *
 * `outcomeFor` stands in for the DB's own verdict: the guard is a predicate in the RPC's
 * UPDATE, so from the worker's side "a human owns this row" IS the string `human_edited`
 * coming back for that id.
 */
function recorder(outcomeFor: (id: string) => string = () => "applied"): Recorder {
  const ops: Row[] = [];
  const rawUpdates: Array<{ table: string; patch: Row }> = [];
  const inserts: Array<{ table: string; rows: Row[] }> = [];

  const stub: Partial<DbClient> = {
    applyDeliveryUpstream: async (batch: Row[]) => {
      ops.push(...batch);
      return batch.map((o) => ({ id: String(o.id), outcome: outcomeFor(String(o.id)) }));
    },
    update: async (table: string, _filters: Record<string, string>, patch: Row) => {
      rawUpdates.push({ table, patch });
      return [];
    },
    insertIfAbsent: async (table: string, rows: Row[]) => {
      inserts.push({ table, rows });
      return {
        inserted: rows.map((r, i) => ({ ...r, id: `NEW-${i}` })),
        skipped: [],
        insertedCount: rows.length,
        skippedCount: 0,
      };
    },
    insert: async (table: string, rows: Row[]) => {
      inserts.push({ table, rows });
      return rows.map((_, i) => ({ id: `NEW-${i}` }));
    },
    selectOne: async () => ({ batch_code: "FEB-26-BLK4" }),
    stampIngestionAudit: async () => true,
    writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
    upsertIngestionWatermark: async () => true,
  };
  return { db: stub as DbClient, ops, rawUpdates, inserts };
}

/** A minimal DeliveryRow — only the fields the note and the patch actually read. */
function deliveryRow(over: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    transaction_date: "2026-02-04",
    supplier: "Ornales",
    batch_code: "FEB-26-BLK4",
    operator_batch_label: null,
    block_loc: "A-7C",
    truck_plate: "CBQ 5957",
    sacks: 540,
    weight_kg: 19605,
    cost_basis: 48.16,
    remarks: null,
    lab_results: null,
    true_weight_kg: null,
    deduction_note: null,
    warnings: [],
    confidence: 1,
    _source_row: 12,
    ...over,
  } as DeliveryRow;
}

/**
 * The emailed-report compact with one VALUE_CHANGED row.
 *
 * `db_row` is what the APP holds (the human's version) and the diff's `dbValue` mirrors
 * it; `emailValue` is what the report says. That orientation is the whole point of the
 * finding: `yours` must be the app's value.
 */
function emailCompact(
  id: string,
  diff: Array<{ field: string; dbValue: unknown; emailValue: unknown }>,
  dbRow: Record<string, unknown> = {},
): DeliveriesCompact {
  return {
    report_type: "deliveries",
    since: "2026-01-01",
    watermark: null,
    source: {},
    actionable: {
      new: [],
      changed: [
        {
          index: 12,
          row: deliveryRow(),
          db_row: {
            id,
            transaction_date: "2026-02-04",
            supplier: "Ornales",
            batch_code: "FEB-26-BLK4",
            block_loc: "A-7C",
            truck_plate: "CBQ 5957",
            ...dbRow,
          },
          diff,
        },
      ],
      flagged: [],
      dup_noops: [],
      malformed: [],
    },
  };
}

/** The Google Sheet's rc_in compact with one CHANGED row. */
function sheetCompact(
  id: string,
  diff: Array<{ field: string; db: unknown; sheet: unknown }>,
): ModeCompact {
  return {
    mode: "rc_in",
    since: "2026-01-01",
    actionable: {
      new: [],
      changed: [
        {
          kind: "VALUE_CHANGED",
          index: 1294,
          db_id: id,
          date: "2026-02-04",
          batch_code: "FEB-26-BLK4",
          block_loc: "A-7C",
          diff,
        },
      ],
      flagged: [],
      unmapped: [],
      malformed: [],
    },
  } as unknown as ModeCompact;
}

// ---------------------------------------------------------------------------
// 1. An UNLATCHED row still updates — and only through the guarded path.
// ---------------------------------------------------------------------------

describe("deliveries latch — an unlatched row still updates", () => {
  it("EMAIL: sends the op to the conditional writer, counts the update, reports nothing", async () => {
    const rec = recorder(() => "applied");
    const res = await applyDeliveries(
      emailCompact(ID_FREE, [{ field: "block_loc", dbValue: "A-7C", emailValue: "C-10B" }]),
      { db: rec.db, noLabel: true },
    );

    expect(rec.ops).toEqual([{ id: ID_FREE, patch: { block_loc: "C-10B" } }]);
    expect(res.updates).toBe(1);
    expect(res.delivery_human_edits).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  it("EMAIL: NEVER uses the raw unguarded db.update path", async () => {
    const rec = recorder(() => "applied");
    await applyDeliveries(
      emailCompact(ID_FREE, [{ field: "sacks", dbValue: 540, emailValue: 334 }]),
      { db: rec.db, noLabel: true },
    );
    // If this regresses, the guard is bypassed entirely and the latch protects nothing.
    expect(rec.rawUpdates).toEqual([]);
  });

  it("SHEET: the Sheet-wins UPDATE also goes through the conditional writer", async () => {
    const rec = recorder(() => "applied");
    const res = await applyFromCompact(
      sheetCompact(ID_FREE, [{ field: "remarks", db: null, sheet: "CORRECTED" }]),
      { db: rec.db },
    );

    expect(rec.ops).toEqual([{ id: ID_FREE, patch: { remarks: "CORRECTED" } }]);
    expect(rec.rawUpdates).toEqual([]);
    expect(res.updated).toBe(1);
    expect(res.delivery_human_edits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. A LATCHED row is refused — and the refusal is told, naming BOTH values.
// ---------------------------------------------------------------------------

describe("deliveries latch — a row the human edited is never overwritten", () => {
  it("EMAIL: outcome human_edited → no update counted, one note with BOTH values", async () => {
    const rec = recorder(() => "human_edited");
    const res = await applyDeliveries(
      emailCompact(ID_LATCHED, [
        { field: "block_loc", dbValue: "A-7C", emailValue: "C-10B" },
        { field: "sacks", dbValue: 540, emailValue: 334 },
      ]),
      { db: rec.db, noLabel: true },
    );

    // The op IS sent — the guard is in the DB, not a worker pre-check — and refused there.
    expect(rec.ops).toHaveLength(1);
    expect(res.updates).toBe(0);
    expect(rec.rawUpdates).toEqual([]);
    // A refusal is NOT an error: nothing is broken, a human just owns the row.
    expect(res.errors).toEqual([]);

    expect(res.delivery_human_edits).toHaveLength(1);
    const note = res.delivery_human_edits[0];
    expect(note).toMatchObject({
      section: "deliveries",
      table: "deliveries",
      record_id: ID_LATCHED,
      transaction_date: "2026-02-04",
      supplier: "Ornales",
      batch_code: "FEB-26-BLK4",
      block_loc: "A-7C",
      truck_plate: "CBQ 5957",
      outcome: "refused_by_db",
    });
    // BOTH values, oriented: `yours` is what the app holds.
    expect(note.changed_fields).toEqual([
      { field: "block_loc", yours: "A-7C", sheet: "C-10B" },
      { field: "sacks", yours: 540, sheet: 334 },
    ]);
  });

  it("SHEET: the same refusal, reported under section 'gsheet'", async () => {
    const rec = recorder(() => "human_edited");
    const res = await applyFromCompact(
      sheetCompact(ID_LATCHED, [{ field: "block_loc", db: "A-7C", sheet: "C-10B" }]),
      { db: rec.db },
    );

    expect(res.updated).toBe(0);
    expect(rec.rawUpdates).toEqual([]);
    expect(res.delivery_human_edits).toHaveLength(1);
    expect(res.delivery_human_edits[0]).toMatchObject({
      section: "gsheet",
      record_id: ID_LATCHED,
      transaction_date: "2026-02-04",
      batch_code: "FEB-26-BLK4",
      outcome: "refused_by_db",
    });
    expect(res.delivery_human_edits[0].changed_fields).toEqual([
      { field: "block_loc", yours: "A-7C", sheet: "C-10B" },
    ]);
    // A human-arbitration case is NOT dressed up as a generic "skipped" row.
    expect(res.skipped.some((s) => /not applied/.test(s.why ?? ""))).toBe(false);
  });

  it("a mixed batch refuses only the latched row and applies the other", async () => {
    const rec = recorder((id) => (id === ID_LATCHED ? "human_edited" : "applied"));
    const compact = emailCompact(ID_LATCHED, [
      { field: "sacks", dbValue: 540, emailValue: 334 },
    ]);
    compact.actionable.changed.push({
      index: 13,
      row: deliveryRow({ truck_plate: "AAV 6111" }),
      db_row: { id: ID_FREE, transaction_date: "2026-02-04", truck_plate: "AAV 6111" },
      diff: [{ field: "sacks", dbValue: 100, emailValue: 200 }],
    });

    const res = await applyDeliveries(compact, { db: rec.db, noLabel: true });

    expect(rec.ops.map((o) => o.id).sort()).toEqual([ID_LATCHED, ID_FREE].sort());
    expect(res.updates).toBe(1);
    expect(res.delivery_human_edits.map((n) => n.record_id)).toEqual([ID_LATCHED]);
  });
});

// ---------------------------------------------------------------------------
// 3. Any other outcome is a REAL problem — not a shrug.
// ---------------------------------------------------------------------------

describe("deliveries latch — a non-applied, non-human outcome is loud", () => {
  it("EMAIL: `missing` becomes an error, which blocks the watermark and the label", async () => {
    const rec = recorder(() => "missing");
    const res = await applyDeliveries(
      emailCompact(ID_FREE, [{ field: "sacks", dbValue: 1, emailValue: 2 }]),
      { db: rec.db, noLabel: true },
    );

    expect(res.updates).toBe(0);
    expect(res.delivery_human_edits).toEqual([]);
    expect(res.errors.some((e) => e.includes("missing"))).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.watermark_updated).toBe(false);
  });

  it("EMAIL: an `unsupported_field` refusal is reported, never silently dropped", async () => {
    const rec = recorder(() => "unsupported_field");
    const res = await applyDeliveries(
      emailCompact(ID_FREE, [{ field: "sacks", dbValue: 1, emailValue: 2 }]),
      { db: rec.db, noLabel: true },
    );
    expect(res.errors.some((e) => e.includes("unsupported_field"))).toBe(true);
  });

  it("EMAIL: a thrown RPC is an error, and nothing is counted as written", async () => {
    const rec = recorder();
    const stub = rec.db as unknown as Record<string, unknown>;
    stub.applyDeliveryUpstream = async () => {
      throw new Error("fn_apply_delivery_upstream RPC failed 42501: permission denied");
    };
    const res = await applyDeliveries(
      emailCompact(ID_FREE, [{ field: "sacks", dbValue: 1, emailValue: 2 }]),
      { db: rec.db, noLabel: true },
    );
    expect(res.updates).toBe(0);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("conditional update failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Rule 5 — inserts are UNCONSTRAINED. The latch governs updates only.
// ---------------------------------------------------------------------------

describe("deliveries latch — inserts are unconstrained", () => {
  it("a NEW row still inserts and never touches the conditional update path", async () => {
    const rec = recorder();
    const res = await applyDeliveries(
      {
        report_type: "deliveries",
        since: "2026-01-01",
        watermark: null,
        source: {},
        actionable: {
          new: [{ index: 1, row: deliveryRow() }],
          changed: [],
          flagged: [],
          dup_noops: [],
          malformed: [],
        },
      },
      { db: rec.db, noLabel: true },
    );

    expect(res.inserts).toBe(1);
    expect(rec.ops).toEqual([]);
    expect(res.delivery_human_edits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. ₱ SAFETY — a refused price appears by NAME ONLY.
//
// `cost_basis` is one of the nine fields the latch can refuse, and the findings channel
// is NOT price-gated: it feeds the Sync panel, the Excel workbook and the digest with no
// `canViewPrices()` check anywhere. The workbook is worse still — it is a FILE, and
// `sync_run_reports.contains_prices` gates its download on a MEASURED fact, so one ₱
// printed here would lock the report away from the people who need it.
// ---------------------------------------------------------------------------

describe("deliveries latch — a refused price never leaves the worker", () => {
  it("`cost_basis` is the redacted set, and it is redacted at the constructor", () => {
    expect([...REDACTED_FIELDS]).toEqual(["cost_basis"]);

    const note = deliveryHumanEditNote(
      "deliveries",
      ID_LATCHED,
      { transaction_date: "2026-02-04", truck_plate: "CBQ 5957" },
      [
        { field: "cost_basis", yours: 48.16, sheet: 42.0 },
        { field: "sacks", yours: 540, sheet: 334 },
      ],
    );

    expect(note.changed_fields[0]).toEqual({
      field: "cost_basis",
      yours: null,
      sheet: null,
      redacted: true,
    });
    // A non-price field is untouched — redaction is targeted, not blanket.
    expect(note.changed_fields[1]).toEqual({ field: "sacks", yours: 540, sheet: 334 });
    expect(JSON.stringify(note)).not.toContain("48.16");
  });

  it("EMAIL: a refused cost_basis reaches the apply result with no number in it", async () => {
    const rec = recorder(() => "human_edited");
    const res = await applyDeliveries(
      emailCompact(ID_LATCHED, [{ field: "cost_basis", dbValue: 48.16, emailValue: 42 }]),
      { db: rec.db, noLabel: true },
    );

    expect(res.delivery_human_edits[0].changed_fields).toEqual([
      { field: "cost_basis", yours: null, sheet: null, redacted: true },
    ]);
    expect(JSON.stringify(res.delivery_human_edits)).not.toContain("48.16");
  });

  it("normalizeApply RE-STRIPS a price a replayed envelope tried to smuggle through", () => {
    // Belt and braces: this is the door every replayed / hand-built envelope comes
    // through, so the only way a ₱ reaches the channel is if BOTH defences were removed.
    // (`normalizeApply` returns null only for a null envelope; ours is an object.)
    const norm = normalizeApply("deliveries", {
      delivery_human_edits: [
        {
          section: "gsheet",
          table: "deliveries",
          record_id: ID_LATCHED,
          transaction_date: "2026-02-04",
          changed_fields: [
            { field: "cost_basis", yours: 48.16, sheet: 42.0 },
            { field: "sacks", yours: 540, sheet: 334 },
          ],
          outcome: "refused_by_db",
        },
      ],
    });

    expect(norm).not.toBeNull();
    expect(norm!.delivery_human_edits[0].changed_fields[0]).toEqual({
      field: "cost_basis",
      yours: null,
      sheet: null,
      redacted: true,
    });
    expect(JSON.stringify(norm!.delivery_human_edits)).not.toContain("48.16");
  });

  it("normalizeApply defaults the channel to [] for a pre-feature envelope", () => {
    expect(normalizeApply("deliveries", {})!.delivery_human_edits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. THE TELLING — the refusal becomes a run finding, through the ONE flattener.
//
// This is the bar the 2026-06-25 comment failed: the instruction existed but nothing
// read it. The finding is what the operator actually sees, and it must name the row and
// BOTH values.
// ---------------------------------------------------------------------------

function resultWith(edits: unknown[], report = "gsheet"): AppSyncRunResult {
  return {
    reports: {
      [report]: {
        classify: null,
        apply: {
          report_type: report,
          ok: true,
          held: [],
          labeled: false,
          watermark_updated: false,
          errors: [],
          delivery_human_edits: edits,
        },
      },
    },
  } as unknown as AppSyncRunResult;
}

describe("deliveries latch — the refusal becomes a run finding", () => {
  const edit = {
    section: "gsheet",
    table: "deliveries",
    record_id: ID_LATCHED,
    transaction_date: "2026-02-04",
    supplier: "Ornales",
    batch_code: "FEB-26-BLK4",
    block_loc: "A-7C",
    truck_plate: "CBQ 5957",
    changed_fields: [
      { field: "block_loc", yours: "A-7C", sheet: "C-10B" },
      { field: "sacks", yours: 540, sheet: 334 },
    ],
    outcome: "refused_by_db",
  };

  it("names the row and BOTH values, at `attention`, filed to the right section", () => {
    const findings = flattenRunFindings(resultWith([edit]));
    expect(findings).toHaveLength(1);
    const f = findings[0];

    expect(f.kind).toBe("delivery_human_edited");
    expect(f.severity).toBe("attention");
    expect(f.section).toBe("gsheet");
    expect(f.key).toBe(`delivery_human_edited:gsheet:${ID_LATCHED}`);
    // The row, by the identity an operator recognises.
    expect(f.location).toBe("2026-02-04 · Ornales · FEB-26-BLK4 · A-7C · CBQ 5957");
    // BOTH values, in plain words, both sides present.
    expect(f.reason).toContain("block A-7C");
    expect(f.reason).toContain("C-10B");
    expect(f.reason).toContain("sacks 540");
    expect(f.reason).toContain("334");
    expect(f.reason).toContain("Google Sheet");
    // The id the release RPC needs survives into the finding data.
    expect((f.data as Record<string, unknown>).record_id).toBe(ID_LATCHED);
  });

  it("BOTH writers can raise it, and the fold picks up both", () => {
    const emailEdit = { ...edit, section: "deliveries", record_id: ID_FREE };
    const result = {
      reports: {
        gsheet: resultWith([edit]).reports!.gsheet,
        deliveries: resultWith([emailEdit], "deliveries").reports!.deliveries,
      },
    } as unknown as AppSyncRunResult;

    const findings = flattenRunFindings(result).filter(
      (f) => f.kind === "delivery_human_edited",
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.section).sort()).toEqual(["deliveries", "gsheet"]);
    expect(findings.find((f) => f.section === "deliveries")!.source).toBe(
      "RC DELIVERIES report",
    );
  });

  it("the Excel workbook puts the two sides side by side", () => {
    const f = flattenRunFindings(resultWith([edit]))[0];
    const sides = sidesForFinding(f);
    expect(sides.a).toBe("yours: block_loc A-7C; sacks 540");
    expect(sides.b).toBe("source: block_loc C-10B; sacks 334");
  });

  it("a redacted price prints its NAME in the finding and in the workbook, never a number", () => {
    const priced = {
      ...edit,
      changed_fields: [{ field: "cost_basis", yours: null, sheet: null, redacted: true }],
    };
    const f = flattenRunFindings(resultWith([priced]))[0];

    expect(f.reason).toContain("price");
    expect(f.reason).toContain("value not shown");
    const sides = sidesForFinding(f);
    expect(sides.a).toBe("yours: cost_basis (not shown)");
    expect(sides.b).toBe("source: cost_basis (not shown)");
  });

  it("a run that refused nothing says nothing", () => {
    expect(flattenRunFindings(resultWith([]))).toEqual([]);
  });
});
