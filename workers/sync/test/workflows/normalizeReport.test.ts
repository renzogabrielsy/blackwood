/**
 * normalizeReport.test.ts — proves the ASSEMBLY-BOUNDARY normalizer emits EXACTLY the
 * frontend contract (app/(app)/sync/types.ts::SyncRunReportResult / ApplyResult /
 * ClassifyResult). This is the worker half of the round-trip: feed realistic per-report
 * runReport() returns through the SAME functions reportWorkflow uses, and assert the
 * emitted `sync_runs.result.reports[<type>]` shape.
 *
 * The app half (drive lib/sync/reducer.ts with these shapes) lives in
 * scripts/verify-sync-reducer.ts.
 */
import { describe, it, expect } from "vitest";
import {
  toReportResult,
  failedReportResult,
  normalizeApply,
  normalizeClassify,
  type SyncRunReportResult,
} from "../../src/workflows/normalizeReport.js";

/**
 * Structural gate: assert a value satisfies the frontend `ApplyResult` contract —
 * NESTED `applied` present with three numbers, `held` an array of {reason,natural_key,
 * detail} ROWS, and the bookkeeping flags. This is the exact shape SyncEmployeeCard +
 * HeldRows read.
 */
function assertApplyContract(apply: unknown) {
  expect(apply).not.toBeNull();
  const a = apply as Record<string, unknown>;
  expect(typeof a.report_type).toBe("string");
  expect(typeof a.ok).toBe("boolean");
  // applied is ALWAYS present (nested) — never a missing field the card must guard.
  const applied = a.applied as Record<string, unknown>;
  expect(applied).toBeTypeOf("object");
  expect(typeof applied.inserts).toBe("number");
  expect(typeof applied.updates).toBe("number");
  expect(typeof applied.replaced_dates).toBe("number"); // a NUMBER, not an array
  // held is the ROWS, not a count.
  expect(Array.isArray(a.held)).toBe(true);
  for (const h of a.held as unknown[]) {
    const row = h as Record<string, unknown>;
    expect(typeof row.reason).toBe("string");
    expect(typeof row.natural_key).toBe("string");
    expect(typeof row.detail).toBe("string");
  }
  expect(typeof a.labeled).toBe("boolean");
  expect(typeof a.watermark_updated).toBe("boolean");
  expect(Array.isArray(a.errors)).toBe(true);
}

/** Structural gate: assert a value satisfies the frontend `ClassifyResult` contract. */
function assertClassifyContract(classify: unknown) {
  expect(classify).not.toBeNull();
  const c = classify as Record<string, unknown>;
  expect(typeof c.report_type).toBe("string");
  expect(typeof c.ok).toBe("boolean");
  expect(Array.isArray(c.gate_failures)).toBe(true);
  const counts = c.counts as Record<string, unknown>;
  expect(typeof counts.noop).toBe("number");
  expect(typeof counts.insert).toBe("number");
  expect(typeof counts.update).toBe("number");
  expect(typeof counts.flagged).toBe("number");
  expect(Array.isArray(c.rows_preview)).toBe(true);
  expect(typeof c.classified_path).toBe("string");
  expect(typeof c.source).toBe("object");
  // watermark is string | null.
  expect(c.watermark === null || typeof c.watermark === "string").toBe(true);
}

function assertReportResultContract(rep: SyncRunReportResult) {
  // classify may be null only for M0/M1 manifests; our reports always produce one.
  assertClassifyContract(rep.classify);
  if (rep.apply !== null) assertApplyContract(rep.apply);
}

describe("normalizeReport — assembly boundary emits the frontend contract", () => {
  it("deliveries: clean report → nested applied, held ROWS empty", () => {
    // Shape mirrors deliveries/index.ts runReport() return.
    const rep = toReportResult({
      reportType: "deliveries",
      classify: {
        report_type: "deliveries",
        ok: true,
        gate_failures: [],
        counts: { noop: 40, insert: 3, update: 1, flagged: 0 },
        watermark: "2026-07-03",
      },
      apply: {
        report_type: "deliveries",
        ok: true,
        inserts: 3,
        updates: 1,
        held: [],
        labeled: true,
        watermark_updated: true,
        errors: [],
      },
    });
    assertReportResultContract(rep);
    expect(rep.apply!.applied).toEqual({ inserts: 3, updates: 1, replaced_dates: 0 });
    expect(rep.apply!.held).toEqual([]);
    expect(rep.classify!.counts.insert).toBe(3);
  });

  it("rc_out: GATE-FAILED report still carries nested applied (zeros) + gate_failures", () => {
    // rc_out gate trip: classify.ok=false, gate_failures populated, apply wrote nothing.
    const rep = toReportResult({
      reportType: "rc_out",
      classify: {
        report_type: "rc_out",
        ok: false,
        gate_failures: [
          { gate: "PROPOSED-vs-RC-MOVEMENT drift", detail: "drift 6,300 kg exceeds 500 kg" },
        ],
        counts: { noop: 18, insert: 6, update: 0, flagged: 0 },
        watermark: "2026-07-02",
      },
      apply: {
        report_type: "rc_out",
        ok: false,
        inserts: 0,
        updates: 0,
        held: [],
        labeled: false,
        watermark_updated: false,
        errors: ["gate tripped: writes halted"],
      },
    });
    assertReportResultContract(rep);
    // applied ALWAYS present even though nothing was written.
    expect(rep.apply!.applied).toEqual({ inserts: 0, updates: 0, replaced_dates: 0 });
    expect(rep.apply!.ok).toBe(false);
    expect(rep.classify!.ok).toBe(false);
    expect(rep.classify!.gate_failures).toHaveLength(1);
    expect(rep.classify!.gate_failures[0].gate).toBe("PROPOSED-vs-RC-MOVEMENT drift");
  });

  it("flecon: replaced_dates>0 survives (REPLACE-BY-DATE), not dropped", () => {
    const rep = toReportResult({
      reportType: "flecon",
      classify: {
        report_type: "flecon",
        ok: true,
        gate_failures: [],
        counts: { noop: 2, insert: 4, update: 1, flagged: 0 },
        watermark: null,
      },
      apply: {
        report_type: "flecon",
        ok: true,
        inserts: 37,
        replaced_dates: 5, // flecon-specific — must NOT be dropped
        held: [
          { reason: "below_since_floor", natural_key: "2025-12-30", detail: "settled history not replaced" },
        ],
        labeled: true,
        watermark_updated: true,
        errors: [],
      },
    });
    assertReportResultContract(rep);
    expect(rep.apply!.applied.replaced_dates).toBe(5);
    expect(rep.apply!.applied.inserts).toBe(37);
    expect(rep.apply!.held).toHaveLength(1);
    expect(rep.apply!.held[0].reason).toBe("below_since_floor");
  });

  it("production: HELD ROWS survive with full reason/natural_key/detail", () => {
    const rep = toReportResult({
      reportType: "production",
      classify: {
        report_type: "production",
        ok: true,
        gate_failures: [],
        counts: { noop: 22, insert: 9, update: 0, flagged: 2 },
        watermark: "2026-07-03",
      },
      apply: {
        report_type: "production",
        ok: true,
        inserts: 9,
        updates: 0,
        held: [
          { reason: "unresolved_shift", natural_key: '2026-07-03|WASTE|AYAG', detail: "run NEW without resolvable shift_id" },
          { reason: "malformed", natural_key: "waste", detail: "bad row" },
        ],
        labeled: false,
        watermark_updated: true,
        errors: [],
      },
      classifyExtra: { per_section: { runs: 9, downtime: 0, waste: 2, electricity: 1, trucks: 1 } },
    });
    assertReportResultContract(rep);
    expect(rep.apply!.held).toHaveLength(2);
    // The extra per_section breakdown rides along on classify without breaking contract.
    expect((rep.classify as Record<string, unknown>).per_section).toBeTruthy();
  });

  it("gsheet: gate-failure APPLY path (no applied fields in raw) → nested zeros present", () => {
    // gsheet's gate-failure apply returns ok:false with held/errors and NO inserts/updates.
    const rep = toReportResult({
      reportType: "gsheet",
      classify: {
        report_type: "gsheet",
        ok: false,
        gate_failures: [],
        counts: { noop: 0, insert: 0, update: 0, flagged: 1 },
        watermark: "2025-01-01",
      },
      apply: {
        report_type: "gsheet",
        ok: false,
        // NB: no inserts/updates keys at all — the gate-failure path omits them.
        held: [{ reason: "gate", natural_key: "rc_in:0", detail: "material diff gate" }],
        labeled: false,
        watermark_updated: false,
        errors: ["rc_in apply gate: PD-2 — material diff"],
      },
      classifyExtra: { per_mode: { rc_in: { new: 0, changed: 0, flagged: 1 }, rc_out: { new: 0, changed: 0, flagged: 0 } } },
    });
    assertReportResultContract(rep);
    // Even with NO inserts/updates keys in the raw apply, applied defaults to zeros.
    expect(rep.apply!.applied).toEqual({ inserts: 0, updates: 0, replaced_dates: 0 });
    expect(rep.apply!.errors).toHaveLength(1);
  });

  it("dryRun: apply passed as null → apply is null, classify still present", () => {
    const rep = toReportResult({
      reportType: "deliveries",
      classify: {
        report_type: "deliveries",
        ok: true,
        gate_failures: [],
        counts: { noop: 40, insert: 3, update: 1, flagged: 0 },
        watermark: "2026-07-03",
      },
      apply: null, // dryRun path
    });
    assertClassifyContract(rep.classify);
    expect(rep.apply).toBeNull();
  });

  it("read-only auditor: apply undefined → apply null; classify carries counts + severity", () => {
    // reportWorkflow passes `apply: null` for the auditor; via toReportResult that yields null.
    const rep = toReportResult({
      reportType: "rc_movement",
      classify: {
        report_type: "rc_movement_audit",
        ok: true,
        gate_failures: [],
        counts: { noop: 12, insert: 0, update: 0, flagged: 0 },
        watermark: "2026-07-03",
      },
      apply: null,
      classifyExtra: { severity: "none", audit_since: "2026-06-01", note: null },
    });
    assertClassifyContract(rep.classify);
    expect(rep.apply).toBeNull();
    expect((rep.classify as Record<string, unknown>).severity).toBe("none");
  });

  it("failedReportResult: a THROWN report → contract-shaped error result", () => {
    const rep = failedReportResult("production", "boom: something exploded");
    assertReportResultContract(rep);
    expect(rep.status).toBe("error");
    expect(rep.error).toBe("boom: something exploded");
    expect(rep.classify!.ok).toBe(false);
    expect(rep.apply!.ok).toBe(false);
    expect(rep.apply!.applied).toEqual({ inserts: 0, updates: 0, replaced_dates: 0 });
    expect(rep.apply!.errors).toEqual(["boom: something exploded"]);
  });

  it("defensive: garbage raw values degrade to safe defaults, never throw", () => {
    // A malformed apply (undefined counts, non-array held) must not crash the assembly.
    const apply = normalizeApply("rc_out", {
      report_type: "rc_out",
      ok: true,
      // @ts-expect-error deliberately malformed input (inserts is typed number?)
      inserts: "3",
      held: "not-an-array", // held is `unknown` in RawApply — accepts garbage
      errors: null, // errors is `unknown` in RawApply — accepts garbage
    });
    expect(apply!.applied.inserts).toBe(0); // "3" is not a number → 0
    expect(apply!.held).toEqual([]);
    expect(apply!.errors).toEqual([]);

    const classify = normalizeClassify("rc_out", {
      // @ts-expect-error
      counts: null,
      // @ts-expect-error
      gate_failures: "nope",
    });
    expect(classify.counts).toEqual({ noop: 0, insert: 0, update: 0, flagged: 0 });
    expect(classify.gate_failures).toEqual([]);
    expect(classify.report_type).toBe("rc_out");
  });
});
