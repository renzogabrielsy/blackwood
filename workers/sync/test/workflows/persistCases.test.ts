/**
 * persistCases.test.ts — L-049 part 2 (2026-09-07).
 *
 * THE REGRESSION IT PINS. Held rows lived only inside `sync_runs.result` until a human
 * opened `/sync/cases?run=<id>`, so a scheduled run that nobody watched wrote ZERO durable
 * cases — and the Excel workbook's "Awaiting Review" sheet, which reads
 * `sync_held_cases`, listed nothing while two real feedings had been held for four days.
 *
 * These assert the projection now happens in the run, for EVERY kind of hold, exactly once
 * per distinct fingerprint, and that a write failure is reported rather than thrown.
 */
import { describe, it, expect } from "vitest";

import { persistHeldCases } from "../../src/workflows/persistCases.js";
import { caseFingerprint } from "../../src/reports/excel/findingsBridge.js";
import type { DbClient } from "../../src/lib/db.js";

type UpsertArgs = Parameters<DbClient["upsertHeldCase"]>[0];

function mkDb(opts: { existing?: Set<string>; failOn?: (a: UpsertArgs) => boolean } = {}) {
  const seen: UpsertArgs[] = [];
  const existing = opts.existing ?? new Set<string>();
  const db: Partial<DbClient> = {
    upsertHeldCase: async (args) => {
      if (opts.failOn?.(args)) throw new Error("permission denied for table sync_held_cases");
      seen.push(args);
      if (existing.has(args.fingerprint)) return "refreshed";
      existing.add(args.fingerprint);
      return "created";
    },
  };
  return { db: db as DbClient, seen };
}

/** The two holds the incident actually produced, on the two reports that produced them. */
const heldConflict = {
  reason: "batch_location_conflict",
  natural_key: "2026-09-03 · NOV-26-BLK13 · MAIN · 8,158 kg",
  detail: "New batch NOV-26-BLK13 wants block D-8A, but NOV-25-BLK13 is still marked active there.",
  kind: "batch_location_conflict",
  row: {
    transaction_date: "2026-09-03",
    weight_kg: 8158,
    attempted_batch_code: "NOV-26-BLK13",
    occupying_batch_code: "NOV-25-BLK13",
    db_error:
      'upsert_batch_if_absent batches failed 23505: duplicate key value violates unique constraint "idx_unique_active_batch_per_location"',
  },
};

const heldSubWatermark = {
  reason: "flagged",
  natural_key: "2026-09-04 · NOV-25-BLK13 · MAIN · 9,637 kg",
  detail: "sub-watermark NEW: transaction_date 2026-09-04 <= watermark 2026-09-05",
  kind: "sub_watermark_suspected_dup",
  row: { transaction_date: "2026-09-04", weight_kg: 9637 },
};

function runResult(held: unknown[]) {
  return { reports: { rc_out: { classify: null, apply: { held } } } };
}

describe("L-049 — persistHeldCases", () => {
  it("projects EVERY held kind, including the two the incident produced", async () => {
    const { db, seen } = mkDb();
    const out = await persistHeldCases(db, "run-1", runResult([heldConflict, heldSubWatermark]));

    expect(out).toMatchObject({ ok: true, held: 2, created: 2, refreshed: 0, failed: 0 });
    expect(seen.map((s) => s.kind).sort()).toEqual([
      "batch_location_conflict",
      "sub_watermark_suspected_dup",
    ]);
    // The raw refusal travels WITH the case, so Sync Review can show what the DB said —
    // that string was the entire operator-visible signal during the incident, and it was
    // reaching nothing durable at all.
    const conflict = seen.find((s) => s.kind === "batch_location_conflict");
    expect(conflict?.reportType).toBe("rc_out");
    expect(String(conflict?.row?.db_error)).toContain("idx_unique_active_batch_per_location");
  });

  it("uses THE `caseFingerprint`, not a second hash — the app's fan-out lands on the same row", async () => {
    const { db, seen } = mkDb();
    await persistHeldCases(db, "run-1", runResult([heldSubWatermark]));
    expect(seen[0].fingerprint).toBe(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      caseFingerprint("rc_out" as any, heldSubWatermark as any),
    );
  });

  it("is idempotent by fingerprint — a second pass over the same run refreshes, never duplicates", async () => {
    const existing = new Set<string>();
    const a = mkDb({ existing });
    await persistHeldCases(a.db, "run-1", runResult([heldConflict]));
    const b = mkDb({ existing });
    const out = await persistHeldCases(b.db, "run-1", runResult([heldConflict]));
    expect(out).toMatchObject({ created: 0, refreshed: 1 });
  });

  it("carries the report type and the row payload verbatim", async () => {
    const { db, seen } = mkDb();
    await persistHeldCases(db, "run-9", runResult([heldConflict]));
    expect(seen[0].runId).toBe("run-9");
    expect(seen[0].reportType).toBe("rc_out");
    expect(seen[0].naturalKey).toBe(heldConflict.natural_key);
    expect(seen[0].reason).toBe("batch_location_conflict");
    expect(seen[0].row).toEqual(heldConflict.row);
  });

  it("a failed write is COUNTED AND NAMED, never thrown — one bad row must not cost the others their visibility", async () => {
    const { db, seen } = mkDb({
      failOn: (a) => a.kind === "batch_location_conflict",
    });
    const out = await persistHeldCases(db, "run-1", runResult([heldConflict, heldSubWatermark]));

    expect(out.ok).toBe(false);
    expect(out.failed).toBe(1);
    expect(out.created).toBe(1); // the other one still landed
    expect(out.errors[0]).toContain("NOV-26-BLK13");
    expect(seen).toHaveLength(1);
  });

  it("a run with nothing held does nothing at all", async () => {
    const { db, seen } = mkDb();
    expect(await persistHeldCases(db, "run-1", runResult([]))).toMatchObject({
      ok: true,
      held: 0,
      created: 0,
    });
    expect(seen).toEqual([]);
  });

  it("a malformed / pre-feature run result degrades to a no-op, never a crash", async () => {
    const { db } = mkDb();
    expect(await persistHeldCases(db, "run-1", {})).toMatchObject({ ok: true, held: 0 });
    expect(await persistHeldCases(db, "run-1", null)).toMatchObject({ ok: true, held: 0 });
  });
});
